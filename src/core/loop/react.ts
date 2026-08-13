import type {
  AssistantMessage,
  Context,
  ModelRef,
  Provider,
  ToolCallBlock,
  ToolContext,
  ToolResultMessage,
  UIEvent,
} from '../types.js';
import { createErrorMessage, modelOrigin } from '../llm/provider.js';
import type {
  ToolExecutorDeps,
  ToolExecutorOptions,
} from '../tools/execute.js';
import { executeToolCall } from '../tools/execute.js';
import { ToolRegistry } from '../tools/registry.js';

export interface ReactTurnOptions {
  provider: Provider;
  model: ModelRef;
  context: Context;
  signal: AbortSignal;
  emit: (event: UIEvent) => void;
}

export interface ReactTurnResult {
  /** 已用增量参数覆盖终态参数的规范化 assistant 消息。 */
  message: AssistantMessage;
  /** 按流事件 index 排序，供动作阶段保持模型声明顺序。 */
  toolCalls: ToolCallBlock[];
  terminal: 'done' | 'error';
  diagnostic?: string;
}

export interface ReactToolOptions {
  registry: ToolRegistry;
  context: ToolContext;
  deps: ToolExecutorDeps;
  options: ToolExecutorOptions;
  maxConcurrency: number;
  emit: (event: UIEvent) => void;
}

interface ToolCallAccumulator {
  /** 原样拼接 delta；JSON 未闭合前绝不尝试解析。 */
  rawArguments: string;
  /** false 表示 provider 没发 delta，此时允许使用 toolcall_end 的完整参数。 */
  sawDelta: boolean;
  /** 防止 end 后继续追加或同一槽位重复结束。 */
  ended: boolean;
  /** id/name/adapterState 取自 toolcall_end，arguments 由 rawArguments 重建。 */
  call?: ToolCallBlock;
}

const TEXT_TOOL_CALL_DIAGNOSTIC =
  'Model output looks like a text-encoded tool call. The endpoint/model/chat-template combination may not support native tool calling; PPAgent does not support prompted or text tool calls.';

/** 收敛一轮模型流；partial JSON 只在 toolcall_end 时解析一次。 */
export async function runReactTurn(
  options: ReactTurnOptions,
): Promise<ReactTurnResult> {
  // index 允许多个工具调用的参数分片交错到达，不能只维护一个全局字符串。
  const slots = new Map<number, ToolCallAccumulator>();
  try {
    for await (const event of options.provider.stream(
      options.model,
      options.context,
      { signal: options.signal },
    )) {
      switch (event.type) {
        case 'start':
          // start 只有生命周期意义，没有需要写入 Context 的内容。
          break;
        case 'text_delta':
          options.emit({ type: 'text_delta', delta: event.delta });
          break;
        case 'thinking_delta':
          options.emit({ type: 'thinking_delta', delta: event.delta });
          break;
        case 'toolcall_start': {
          const existing = slots.get(event.index);
          if (existing !== undefined) {
            return protocolError(
              options,
              `Tool-call slot ${event.index} started more than once.`,
            );
          }
          slots.set(event.index, emptyAccumulator());
          break;
        }
        case 'toolcall_delta': {
          // 容忍少数兼容服务漏发 start；delta 本身足以建立槽位。
          const slot = slots.get(event.index) ?? emptyAccumulator();
          if (slot.ended) {
            return protocolError(
              options,
              `Tool-call slot ${event.index} received arguments after it ended.`,
            );
          }
          slot.rawArguments += event.delta;
          slot.sawDelta = true;
          slots.set(event.index, slot);
          break;
        }
        case 'toolcall_end': {
          // end 提供可靠的 id/name/adapterState；只替换可能被终态“修好”的参数。
          const slot = slots.get(event.index) ?? emptyAccumulator();
          if (slot.ended) {
            return protocolError(
              options,
              `Tool-call slot ${event.index} ended more than once.`,
            );
          }
          slot.ended = true;
          slot.call = {
            ...event.call,
            arguments: slot.sawDelta
              ? parseOrKeepRaw(slot.rawArguments)
              : event.call.arguments,
          };
          slots.set(event.index, slot);
          break;
        }
        case 'done':
          return completedTurn(event.message, slots, options.context);
        case 'error':
          // error 前即使出现过部分调用也不能执行；它们没有完整 assistant 终态。
          return {
            message: event.message,
            toolCalls: [],
            terminal: 'error',
          };
      }
    }
  } catch (error) {
    return protocolError(options, errorMessage(error));
  }
  return protocolError(options, 'Model stream ended without a terminal event.');
}

/** 并发执行只读等安全动作；写入/bash 等非安全动作在批次之间形成串行屏障。 */
export async function executeReactTools(
  calls: ToolCallBlock[],
  react: ReactToolOptions,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  let safeBatch: ToolCallBlock[] = [];
  const flushSafeBatch = async (): Promise<void> => {
    if (safeBatch.length === 0) return;
    results.push(
      ...(await mapLimit(safeBatch, react.maxConcurrency, (call) =>
        executeOne(call, react),
      )),
    );
    safeBatch = [];
  };

  for (const call of calls) {
    const tool = react.registry.get(call.name);
    // 未知工具只会快速生成错误结果，没有副作用，可以和只读工具一起并发。
    if (tool === undefined || tool.concurrencySafe === true) {
      safeBatch.push(call);
      continue;
    }
    // 非安全动作前先等前面的只读批次结束；动作自身也逐个串行执行。
    await flushSafeBatch();
    results.push(await executeOne(call, react));
  }
  await flushSafeBatch();
  return results;
}

async function executeOne(
  call: ToolCallBlock,
  react: ReactToolOptions,
): Promise<ToolResultMessage> {
  // tool_start/tool_end 包住完整四关执行链，而不只是 Tool.execute。
  react.emit({
    type: 'tool_start',
    id: call.id,
    name: call.name,
    args: call.arguments,
  });
  const result = await executeToolCall(
    react.registry,
    call,
    react.context,
    react.deps,
    react.options,
  );
  react.emit({
    type: 'tool_end',
    id: call.id,
    name: call.name,
    isError: result.isError,
    preview: resultPreview(result),
    durationMs: result.durationMs ?? 0,
  });
  return result;
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  // worker 可按完成速度抢下一个任务，但结果仍写回原 index，保证消息配对顺序。
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await map(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

function resultPreview(result: ToolResultMessage): string {
  const text = result.content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'thinking':
          return block.thinking;
        case 'image':
          return `[image:${block.mimeType}]`;
        case 'toolCall':
          return `[tool:${block.name}]`;
      }
    })
    .join('\n');
  return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}

function completedTurn(
  message: AssistantMessage,
  slots: Map<number, ToolCallAccumulator>,
  context: Context,
): ReactTurnResult {
  // done 不能替代 toolcall_end；缺 end 意味着增量参数可能仍是不完整 JSON。
  for (const [index, slot] of slots) {
    if (!slot.ended || slot.call === undefined) {
      return completionError(
        message,
        `Tool-call slot ${index} did not emit toolcall_end.`,
      );
    }
  }

  const indexedCalls = [...slots.entries()]
    .map(([index, slot]) => ({ index, call: slot.call }))
    .filter(
      (entry): entry is { index: number; call: ToolCallBlock } =>
        entry.call !== undefined,
    )
    .sort((left, right) => left.index - right.index);
  const callsById = new Map(indexedCalls.map(({ call }) => [call.id, call]));
  // pi-ai 的 index 通常是 content index；id 回退兼容把它当工具槽位序号的适配器。
  const content = message.content.map((block, index) => {
    if (block.type !== 'toolCall') return block;
    return slots.get(index)?.call ?? callsById.get(block.id) ?? block;
  });
  const normalizedMessage = { ...message, content };
  const toolCalls = indexedCalls.map(({ call }) => call);
  // assistant 终态与流事件必须描述同一组调用，否则追加 toolResult 会破坏消息配对。
  const streamedIds = toolCalls.map((call) => call.id).sort();
  const messageIds = content
    .filter((block) => block.type === 'toolCall')
    .map((block) => block.id)
    .sort();
  if (
    streamedIds.length !== messageIds.length ||
    streamedIds.some((id, index) => id !== messageIds[index])
  ) {
    return completionError(
      message,
      'Final assistant message did not match the streamed native tool calls.',
    );
  }
  // 诊断只观察已经确认没有原生调用的完整终态，避免流式阶段过早判断。
  const diagnostic = diagnoseTextToolCall(normalizedMessage, context, toolCalls);
  return {
    message: normalizedMessage,
    toolCalls,
    terminal: 'done',
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function completionError(
  message: AssistantMessage,
  error: string,
): ReactTurnResult {
  // 协议错误也转换成 AssistantMessage，让主循环仍能走统一的 turn_end/error 出口。
  return {
    message: createErrorMessage(error, {
      ...(message.origin === undefined ? {} : { origin: message.origin }),
      content: message.content,
      now: () => message.timestamp,
    }),
    toolCalls: [],
    terminal: 'error',
  };
}

function diagnoseTextToolCall(
  message: AssistantMessage,
  context: Context,
  toolCalls: ToolCallBlock[],
): string | undefined {
  // “提供了工具 + 普通 stop + 零原生调用”只是诊断前提，本身不代表配置错误。
  if (
    message.stopReason !== 'stop' ||
    toolCalls.length > 0 ||
    context.tools === undefined ||
    context.tools.length === 0
  ) {
    return undefined;
  }
  // thinking 不属于给用户/工具协议的正文，不能参与文本化工具调用识别。
  const text = message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  if (/<\/?tool_call\b/iu.test(text)) return TEXT_TOOL_CALL_DIAGNOSTIC;

  // 只解析整个正文是 JSON 的情况；从自然语言里搜 JSON 子串会产生大量误报。
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const names = new Set(context.tools.map((tool) => tool.name));
  // 工具名必须属于本轮实际下发的定义，并且显式带 arguments 字段。
  return (
    typeof parsed['name'] === 'string' &&
    names.has(parsed['name']) &&
    Object.hasOwn(parsed, 'arguments')
  )
    ? TEXT_TOOL_CALL_DIAGNOSTIC
    : undefined;
}

function protocolError(
  options: Pick<ReactTurnOptions, 'model'>,
  message: string,
): ReactTurnResult {
  // Provider 契约要求错误走事件；这里也保持“不抛出、返回结构化终态”的形状。
  return {
    message: createErrorMessage(message, {
      origin: modelOrigin(options.model),
    }),
    toolCalls: [],
    terminal: 'error',
  };
}

function emptyAccumulator(): ToolCallAccumulator {
  return { rawArguments: '', sawDelta: false, ended: false };
}

function parseOrKeepRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // 畸形参数保留为 string，M3 schema 校验会把它变成 isError 工具结果。
    return raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
