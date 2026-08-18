import type {
  CompactPolicy,
  CompactResult,
  CompactTrigger,
  Context,
  LoopConfig,
  LoopEndReason,
  Message,
  ModelRef,
  Provider,
  ReadonlyContext,
  ResourceSnapshot,
  ResourceProbe,
  SpanExporter,
  StopReason,
  StreamOptions,
  Summarizer,
  TokenCounter,
  ToolContext,
  UIEvent,
} from '../types.js';
import { ContextManager } from '../context/manager.js';
import { SpanRecorder } from '../telemetry/span.js';
import type {
  ToolExecutorDeps,
  ToolExecutorOptions,
} from '../tools/execute.js';
import { ToolRegistry } from '../tools/registry.js';
import { executeReactTools, runReactTurn } from './react.js';

const CONTINUE_AFTER_LENGTH_PROMPT =
  'Your previous response was cut off because it reached the output token limit. Continue exactly where you left off. Do not repeat, summarize, or restate anything you already produced.';

export interface AgentLoopOptions {
  provider: Provider;
  model: ModelRef;
  /** 调用方提供的初始上下文；loop 会复制 messages，不改原数组。 */
  context: Context;
  /** 既用于生成发给模型的 ToolDef，也用于执行模型返回的调用。 */
  registry: ToolRegistry;
  /** 其中的 signal 是整次 loop 的根取消信号。 */
  toolContext: ToolContext;
  toolDeps: ToolExecutorDeps;
  toolOptions: ToolExecutorOptions;
  loopConfig: LoopConfig;
  maxToolConcurrency?: number;
  /** maxTokens/effort 等每次请求可覆盖的参数，透传给每一次 runReactTurn。 */
  streamOptions?: Omit<StreamOptions, 'signal'>;
  /** M5 可选装配；不提供时保持 M4 的纯内存追加行为。 */
  compaction?: AgentLoopCompactionOptions;
  /** loop 只搬运变更，不认识具体 Store 实现。 */
  persistence?: AgentLoopPersistence;
  telemetry?: AgentLoopTelemetryOptions;
  /** UIEvent 是严格有序的同步出口；不提供时仍可把 loop 当普通函数使用。 */
  emit?: (event: UIEvent) => void;
}

export interface AgentLoopTelemetryOptions {
  exporter: SpanExporter;
  now?: () => number;
}

export interface AgentLoopCompactionOptions {
  tokenCounter: TokenCounter;
  policy: CompactPolicy;
  summarizer: Summarizer;
  /** 测试/CLI 可收窄窗口；默认使用模型声明的 contextWindow。 */
  contextWindow?: number;
  previousSummary?: Message;
  /** 紧跟在 previousSummary 之后、原样保留的 user 消息块；见 CompactExecutionContext.previousCarried。 */
  previousCarried?: readonly Message[];
  targetTokens?: number;
  resource?: ResourceSnapshot;
  /** 每轮压缩决策前按需采样；实现负责缓存昂贵的平台调用。 */
  resourceProbe?: ResourceProbe;
}

export interface AgentLoopPersistence {
  appendMessages(messages: readonly Message[]): Promise<void>;
  appendCompaction(result: CompactResult): Promise<void>;
}

export interface AgentLoopResult {
  /** 包含本次新增 assistant/toolResult 消息的最终内存视图。 */
  context: Context;
  reason: LoopEndReason;
  turns: number;
}

/**
 * 运行 ReAct 循环，直到模型正常结束、轮次耗尽、用户取消或出现错误。
 *
 * context/store/compact 通过窄接口注入：context 不认识 llm，loop 也不认识
 * JSONL。这样压缩、回放和模型循环都可以分别单测。
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  validateOptions(options);
  const emit = options.emit ?? (() => undefined);
  const signal = options.toolContext.signal;
  const spans =
    options.telemetry === undefined
      ? undefined
      : new SpanRecorder(options.telemetry.exporter, {
          ...(options.telemetry.now === undefined
            ? {}
            : { now: options.telemetry.now }),
        });
  const definitions = options.registry.definitions();
  // registry 才是本轮可执行工具的事实来源，丢弃调用方可能遗留的旧 tools。
  const { tools: _previousTools, ...contextWithoutTools } = options.context;
  const initialContext: Context = {
    ...contextWithoutTools,
    // M4 不做持久化，但也不应把新增消息写回调用方持有的原数组。
    messages: [...options.context.messages],
    ...(definitions.length === 0 ? {} : { tools: definitions }),
  };
  const contextManager =
    options.compaction === undefined
      ? undefined
      : new ContextManager({
          context: initialContext,
          tokenCounter: options.compaction.tokenCounter,
          ...(options.compaction.previousSummary === undefined
            ? {}
            : { previousSummary: options.compaction.previousSummary }),
          ...(options.compaction.previousCarried === undefined
            ? {}
            : { previousCarried: options.compaction.previousCarried }),
        });
  const context: ReadonlyContext = contextManager?.context ?? initialContext;
  const appendMessages = async (...messages: Message[]): Promise<void> => {
    if (contextManager === undefined) initialContext.messages.push(...messages);
    else contextManager.append(...messages);
    await options.persistence?.appendMessages(messages);
  };
  const loopSpan = spans?.start('agent.loop', options.toolContext.trace, {
    'model.provider': options.model.provider,
    'model.id': options.model.id,
    'agent.max_turns': options.loopConfig.maxTurns,
  });
  let completedReason: LoopEndReason | undefined;
  let completedTurns = 0;
  // 跨整个 run 累计，不随 turn 重置；防止持续超长输出的模型把 maxTurns 全部耗在续写上。
  let lengthContinuations = 0;
  // 所有正常出口都走 finish，保证每次运行恰好产生一个 loop_end。
  const finish = (reason: LoopEndReason, turns: number): AgentLoopResult => {
    completedReason = reason;
    completedTurns = turns;
    emit({ type: 'loop_end', reason, turns });
    return {
      context: contextManager?.snapshot() ?? initialContext,
      reason,
      turns,
    };
  };

  try {
    if (signal.aborted) return finish('aborted', 0);

    // 0 表示不限制轮数；此时 maxTurns 仅作哨兵判断依据，循环条件恒真，只能靠 return 退出。
    const maxTurns = options.loopConfig.maxTurns;

    for (let turn = 1; maxTurns === 0 || turn <= maxTurns; turn += 1) {
    if (signal.aborted) return finish('aborted', turn - 1);
    emit({
      type: 'turn_start',
      turn,
      ...(contextManager === undefined
        ? {}
        : { contextTokens: contextManager.tokenUsage() }),
      contextWindow:
        options.compaction?.contextWindow ?? options.model.contextWindow,
    });
    // 单轮控制器同时包住模型生成和随后的工具执行；超时不是只限制 HTTP。
    const control = createTurnControl(
      signal,
      options.loopConfig.turnTimeoutMs,
      turn,
    );
    const turnTrace = options.toolContext.trace.child(`turn:${turn}`);
    const turnSpan = spans?.start('agent.turn', turnTrace, {
      'agent.turn': turn,
    });
    let turnStopReason: StopReason | undefined;
    let turnFailure: string | undefined;
    try {
      if (contextManager !== undefined && options.compaction !== undefined) {
        const compactTrace = turnTrace.child('compact');
        const compactSpan = spans?.start('context.compact', compactTrace);
        let compacted: CompactResult | null;
        let compactTrigger: CompactTrigger | null = null;
        let resourceSource: ResourceSnapshot['source'] | undefined;
        try {
          let resource = options.compaction.resource;
          if (options.compaction.resourceProbe !== undefined) {
            try {
              resource = await options.compaction.resourceProbe.snapshot();
              compactSpan?.setAttribute('resource.sample_source', resource.source);
              compactSpan?.setAttribute('resource.mem_pressure', resource.memPressure);
              compactSpan?.setAttribute(
                'resource.mem_available_mb',
                resource.memAvailableMB,
              );
              compactSpan?.setAttribute('resource.gpu_busy', resource.gpuBusy);
              compactSpan?.setAttribute(
                'resource.active_subagents',
                resource.activeSubagents,
              );
            } catch (error) {
              // 探针失败退回 token-only 决策；资源遥测不能让 agent 本身失败。
              compactSpan?.setAttribute('resource.probe_error', errorMessage(error));
            }
          }
          resourceSource = resource?.source;
          const contextWindow =
            options.compaction.contextWindow ?? options.model.contextWindow;
          const trigger = contextManager.shouldCompact({
            policy: options.compaction.policy,
            contextWindow,
            ...(resource === undefined ? {} : { resource }),
          });
          compactTrigger = trigger;
          if (trigger === null) {
            compacted = null;
          } else {
            // LLM 摘要可能跑几十秒；先把开始信号发出去，界面才不会静默卡住。
            emit({ type: 'compact_start', trigger });
            compacted = await contextManager.compact(trigger, {
              policy: options.compaction.policy,
              summarizer: options.compaction.summarizer,
              contextWindow,
              signal: control.signal,
              trace: compactTrace,
              ...(options.compaction.targetTokens === undefined
                ? {}
                : { targetTokens: options.compaction.targetTokens }),
            });
          }
          compactSpan?.end(
            compacted === null
              ? { 'context.compacted': false }
              : {
                  'context.compacted': true,
                  'context.kind': compacted.kind,
                  'context.trigger': compacted.trigger,
                  'context.tokens_before': compacted.tokensBefore,
                  'context.tokens_after': compacted.tokensAfter,
                  'context.pruned_count': compacted.prunedCount,
                  ...(compacted.meta === undefined
                    ? {}
                    : {
                        'context.strategy': compacted.meta.strategy,
                        'context.model_calls': compacted.meta.modelCalls,
                      }),
                },
          );
        } catch (error) {
          compactSpan?.end({}, error);
          throw error;
        }
        if (compacted === null) {
          if (compactTrigger !== null) {
            // compact_start 已经发过，必须有收尾事件，否则界面停在压缩相位。
            emit({
              type: 'compact_skipped',
              trigger: compactTrigger,
              reason: '没有可折叠的历史，上下文保持不变',
            });
          }
        } else {
          // 剪枝是磁盘原文上的确定性纯函数，恢复时重跑即可，不写记录；
          // 只有摘要改变了"从哪里开始重放"，必须落盘。
          if (compacted.kind === 'summarize') {
            // compaction 记录先落盘，再让模型消费新视图；恢复时不会看到半次压缩。
            await options.persistence?.appendCompaction(compacted);
          }
          emit({
            type: 'compacted',
            trigger: compacted.trigger,
            kind: compacted.kind,
            tokensBefore: compacted.tokensBefore,
            tokensAfter: compacted.tokensAfter,
            prunedCount: compacted.prunedCount,
            ...(compacted.meta === undefined
              ? {}
              : { strategy: compacted.meta.strategy }),
            ...(resourceSource === undefined ? {} : { resourceSource }),
          });
        }
      }
      const modelTrace = turnTrace.child('model');
      const modelSpan = spans?.start('model.stream', modelTrace, {
        'model.provider': options.model.provider,
        'model.id': options.model.id,
      });
      let generated: Awaited<ReturnType<typeof runReactTurn>>;
      try {
        generated = await runReactTurn({
          provider: options.provider,
          model: options.model,
          context,
          signal: control.signal,
          emit,
          ...(options.streamOptions === undefined
            ? {}
            : { streamOptions: options.streamOptions }),
        });
        modelSpan?.end(
          {
            'model.stop_reason': generated.message.stopReason,
            'model.input_tokens': generated.message.usage.input,
            'model.output_tokens': generated.message.usage.output,
            'model.tool_calls': generated.toolCalls.length,
          },
          generated.terminal === 'error'
            ? generated.message.errorMessage ?? 'Model call failed.'
            : undefined,
        );
      } catch (error) {
        modelSpan?.end({}, error);
        throw error;
      }
      turnStopReason = generated.message.stopReason;
      // 先落 assistant 消息再发 turn_end，订阅者看到事件时内存状态已经一致。
      await appendMessages(generated.message);
      emit({
        type: 'turn_end',
        turn,
        usage: generated.message.usage,
        stopReason: generated.message.stopReason,
      });

      // 根取消优先于单轮超时：用户主动取消不应被展示成 timeout。
      if (signal.aborted) return finish('aborted', turn);
      if (control.timedOut()) {
        turnFailure = `Agent turn ${turn} timed out after ${options.loopConfig.turnTimeoutMs} ms.`;
        emit({
          type: 'error',
          message: turnFailure,
        });
        return finish('error', turn);
      }
      // Provider 以 error 事件收尾，不靠异常；这里必须显式消费 terminal。
      if (generated.terminal === 'error') {
        if (generated.message.stopReason === 'aborted') {
          return finish('aborted', turn);
        }
        emit({
          type: 'error',
          message: generated.message.errorMessage ?? 'Model call failed.',
        });
        turnFailure = generated.message.errorMessage ?? 'Model call failed.';
        return finish('error', turn);
      }
      // 文本化工具调用是配置错误，不能把它当普通 stop 静默结束。
      if (generated.diagnostic !== undefined) {
        turnFailure = generated.diagnostic;
        emit({ type: 'error', message: generated.diagnostic });
        return finish('error', turn);
      }

      if (generated.toolCalls.length > 0) {
        // 所有调用都要得到一条 ToolResultMessage，保持 toolCall/toolResult 配对。
        const results = await executeReactTools(
          generated.toolCalls,
          {
            registry: options.registry,
            context: {
              ...options.toolContext,
              signal: control.signal,
              trace: turnTrace,
            },
            deps: options.toolDeps,
            options: options.toolOptions,
            maxConcurrency: options.maxToolConcurrency ?? 4,
            ...(spans === undefined ? {} : { spans }),
            emit,
          },
        );
        // executeReactTools 即使遇到校验失败也返回工具结果，不会打断整轮。
        await appendMessages(...results);
        if (signal.aborted) return finish('aborted', turn);
        if (control.timedOut()) {
          turnFailure = `Agent turn ${turn} timed out after ${options.loopConfig.turnTimeoutMs} ms.`;
          emit({
            type: 'error',
            message: turnFailure,
          });
          return finish('error', turn);
        }
        // 已执行完最后允许的一轮动作，但没有额度让模型读取结果并继续；
        // maxTurns=0 时不限轮数，turn 从 1 递增，turn === maxTurns 永不成立。
        if (turn === maxTurns) {
          return finish('maxTurns', turn);
        }
        continue;
      }

      // 没有工具调用时，stopReason 必须决定一个显式出口，不能隐式 break。
      switch (generated.message.stopReason) {
        case 'stop':
          return finish('stop', turn);
        case 'aborted':
          return finish('aborted', turn);
        case 'length': {
          if (turn === maxTurns) {
            return finish('maxTurns', turn);
          }
          if (lengthContinuations >= options.loopConfig.maxLengthContinuations) {
            turnFailure = `Model response reached its output token limit after ${lengthContinuations} automatic continuation(s).`;
            emit({
              type: 'error',
              message: turnFailure,
            });
            return finish('error', turn);
          }
          lengthContinuations += 1;
          emit({
            type: 'notify',
            level: 'info',
            message: `Model response hit the output token limit; continuing automatically (${lengthContinuations}/${options.loopConfig.maxLengthContinuations}).`,
          });
          await appendMessages({
            role: 'user',
            content: CONTINUE_AFTER_LENGTH_PROMPT,
            timestamp: Date.now(),
            // harness 注入的续写提示词，不是用户说的话；见 UserMessage.synthetic。
            synthetic: true,
          });
          continue;
        }
        case 'toolUse':
          turnFailure = 'Model reported toolUse without a complete native tool call.';
          emit({
            type: 'error',
            message: turnFailure,
          });
          return finish('error', turn);
        case 'error':
          turnFailure = generated.message.errorMessage ?? 'Model call failed.';
          emit({
            type: 'error',
            message: turnFailure,
          });
          return finish('error', turn);
      }
    } catch (error) {
      if (signal.aborted) return finish('aborted', turn);
      turnFailure = errorMessage(error);
      emit({
        type: 'error',
        message: `Agent loop failed: ${errorMessage(error)}`,
      });
      return finish('error', turn);
    } finally {
      // 清理根 signal 监听器与 timer；任何 return 都不能绕过。
      control.dispose();
      turnSpan?.end(
        {
          ...(turnStopReason === undefined
            ? {}
            : { 'agent.stop_reason': turnStopReason }),
          'agent.timed_out': control.timedOut(),
          'agent.aborted': signal.aborted || turnStopReason === 'aborted',
        },
        turnFailure,
      );
    }
    }

    // 循环体所有出口均已显式 return；此处仅为满足类型穷尽性所需的不可达防线。
    return finish('maxTurns', maxTurns);
  } finally {
    loopSpan?.end(
      {
        'agent.reason': completedReason ?? 'error',
        'agent.turns': completedTurns,
        'agent.aborted': completedReason === 'aborted' || signal.aborted,
      },
      completedReason === 'error' ? 'Agent loop ended with an error.' : undefined,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { runReactTurn } from './react.js';

/**
 * 把整次 loop 的根取消与单轮 deadline 合并成一个下游 signal。
 * timedOut 单独保留来源，避免仅看 signal.aborted 时分不清用户取消和超时。
 */
function createTurnControl(
  parent: AbortSignal,
  timeoutMs: number,
  turn: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  // 0 表示不设单轮 deadline；此时只有根取消能中断一轮，挂起风险由调用方承担。
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timeoutReached = true;
          controller.abort(new Error(`Agent turn ${turn} timed out`));
        }, timeoutMs)
      : undefined;
  // deadline 不应单独阻止一个已无其他工作的 Node 进程退出。
  timer?.unref();
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function validateOptions(options: AgentLoopOptions): void {
  if (
    !Number.isInteger(options.loopConfig.maxTurns) ||
    options.loopConfig.maxTurns < 0
  ) {
    throw new Error('maxTurns must be a non-negative integer (0 = unlimited)');
  }
  if (
    !Number.isInteger(options.loopConfig.turnTimeoutMs) ||
    options.loopConfig.turnTimeoutMs < 0
  ) {
    throw new Error('turnTimeoutMs must be a non-negative integer (0 = no deadline)');
  }
  const concurrency = options.maxToolConcurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('maxToolConcurrency must be a positive integer');
  }
}
