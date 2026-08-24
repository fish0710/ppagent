import { randomUUID } from 'node:crypto';
import { extractFileOperations, formatFileOperations } from '../../core/context/files.js';
import type {
  LoopEndReason,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  Message,
  ModelRef,
  Provider,
  SessionId,
} from '../../core/types.js';
import { getSection, parseSummarySections } from '../summarize/sections.js';

/**
 * 任务级抽取：会话结束后调一次模型，把这次会话里"跨会话还有用"的东西
 * 写成记忆。逐字照抄 agent/summarize/llm.ts 的形状（temperature 0、独立
 * timeout、`## ` 分段、解析不出标题就整体放弃），但不需要它的"请求前缀
 * 逐字节相同"约束 —— 那是为了保护压缩这条高频热路径的 KV 前缀缓存；抽取
 * 每个会话只跑一次，不是热路径，不必背这个包袱，输入也因此可以是精简过的
 * 结构化摘要，而不是完整对话原文（错题本没有为此专门开条目，但道理相通：
 * 别把没必要的成本转嫁给本地推理服务）。
 *
 * 抽取是纯粹的锦上添花：调用方已经在 loopEndReason === 'aborted' 时跳过
 * 整个流程，这里再加一层——任何失败（超时、格式不对、模型只发工具调用、
 * 甚至调用方信号被取消）都返回空数组，绝不抛出。没有下游依赖抽取成功，
 * 没有必要为它设计"取消要不要重新抛出"这类语义，因为无论哪种失败，代价
 * 都只是"这次没攒到新记忆"，跟摘要失败会打断整轮任务完全不是一个量级。
 */

export interface MemoryExtractionInput {
  sourceSessionId: SessionId;
  projectKey: string;
  messages: readonly Message[];
  loopEndReason: LoopEndReason;
  /** 本次会话触发过压缩时的最新摘要；用来白拿已冻结的 Constraints/Key decisions，0 次经过模型。 */
  previousSummary?: Message;
  maxTrackedFiles: number;
}

export interface MemoryExtractor {
  extract(input: MemoryExtractionInput, signal: AbortSignal): Promise<MemoryRecord[]>;
}

export interface LlmMemoryExtractorOptions {
  provider: Provider;
  model: ModelRef;
  maxTokens: number;
  timeoutMs: number;
  notify?: (message: string) => void;
  now?: () => number;
  /** 测试注入；默认 crypto.randomUUID。 */
  idGenerator?: () => string;
}

const MAX_RECORDS = 3;

/** 处理顺序即优先级：facts/conventions 排在 pitfalls 之前先占满 3 条配额。 */
const SECTION_KIND: ReadonlyArray<readonly [string, MemoryKind]> = [
  ['Durable facts', 'fact'],
  ['Durable conventions', 'convention'],
  ['Decisions', 'decision'],
  ['Pitfalls', 'pitfall'],
];

/**
 * 写入封顶：不让模型自己判定 scope。只有用户第一人称明确表达的偏好才升到
 * user scope，其余一律 project——单次抽取永远产不出 user 以上（也没有更高
 * 的 scope 可产）。有意用简单的英文短语匹配，不追求覆盖所有措辞；提取器
 * 本来就要求模型用英文输出（COMPACT_INSTRUCTION 同样的理由：本地模型的
 * 指令跟随在英文上更稳）。
 */
const FIRST_PERSON_PREFERENCE =
  /\b(i always|i prefer|i never|i usually|i want you to|i'd rather|remember that i)\b/iu;

const EXTRACT_INSTRUCTION = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tool — tool calls will be discarded.

The material above is a compact digest of a coding session that just ended, not a conversation for you to continue. Extract only memories that would still be useful in a FUTURE, UNRELATED session in this project — not a recap of what just happened. If nothing above is durable, respond with nothing under any heading.

Write ONLY the headings below that have content, using exactly these headings. Each line under a heading is one independent memory; quote identifiers, paths and commands verbatim, never paraphrase them. Do not write more than 3 lines total across every heading combined. Skip a heading entirely if you have nothing durable for it — do not write "none".

## Durable facts
(a stable fact about this project's structure, environment, or tooling)

## Durable conventions
(a repeatable rule this project follows — "before doing X, always do Y")

## Decisions
(a decision made this session that should not be re-litigated, with its one-line reason)

## Pitfalls
(a mistake made or a trap hit this session, and how to avoid it next time)

No preamble, no addressing the user, no tool calls.`;

export class LlmMemoryExtractor implements MemoryExtractor {
  readonly #options: LlmMemoryExtractorOptions;
  readonly #now: () => number;
  readonly #idGenerator: () => string;

  constructor(options: LlmMemoryExtractorOptions) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new Error('maxTokens must be a positive integer');
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error('timeoutMs must be a positive integer');
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async extract(input: MemoryExtractionInput, signal: AbortSignal): Promise<MemoryRecord[]> {
    // 双重保险：调用方（session.ts）已经在 aborted 时跳过整个流程，这里
    // 再挡一层，避免未来有新调用方漏掉这条规则。
    if (input.loopEndReason === 'aborted') return [];
    let text: string;
    try {
      text = await this.#generate(input, signal);
    } catch {
      // 失败原因（超时/掉线/被拒）对结果没有区别——都是"这次不产出"。
      this.#options.notify?.('记忆抽取失败，本次会话不产出新记忆');
      return [];
    }
    const parsed = parseSummarySections(text);
    if (!parsed.matched) return [];

    const records: MemoryRecord[] = [];
    for (const [heading, kind] of SECTION_KIND) {
      for (const line of splitLines(getSection(parsed, heading))) {
        if (records.length >= MAX_RECORDS) return records;
        records.push(this.#toRecord(line, kind, input));
      }
    }
    return records;
  }

  async #generate(input: MemoryExtractionInput, signal: AbortSignal): Promise<string> {
    const digest = buildDigest(input);
    const messages: Message[] = [
      { role: 'user', content: `${digest}\n\n${EXTRACT_INSTRUCTION}`, timestamp: this.#now() },
    ];
    const control = createTimeout(signal, this.#options.timeoutMs);
    let text = '';
    let sawToolCall = false;
    try {
      const stream = this.#options.provider.stream(
        this.#options.model,
        { messages },
        {
          signal: control.signal,
          maxTokens: this.#options.maxTokens,
          temperature: 0,
          timeoutMs: this.#options.timeoutMs,
        },
      );
      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            text += event.delta;
            break;
          case 'toolcall_end':
            sawToolCall = true;
            break;
          case 'error':
            throw new Error(event.message.errorMessage ?? 'Extraction request failed.');
          default:
            break;
        }
      }
    } finally {
      control.dispose();
    }
    if (text.trim().length === 0) {
      throw new Error(
        sawToolCall ? '模型只发起了工具调用，没有产出抽取结果' : '抽取调用没有产出任何文本',
      );
    }
    return text;
  }

  #toRecord(text: string, kind: MemoryKind, input: MemoryExtractionInput): MemoryRecord {
    const now = this.#now();
    const scope = classifyScope(text);
    return {
      id: this.#idGenerator(),
      scope,
      kind,
      text,
      ...(scope === 'project' ? { projectKey: input.projectKey } : {}),
      sourceSessionId: input.sourceSessionId,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      exposure: 0,
      adopted: 0,
      adoptedOk: 0,
      adoptedBad: 0,
    };
  }
}

function classifyScope(text: string): MemoryScope {
  return FIRST_PERSON_PREFERENCE.test(text) ? 'user' : 'project';
}

/**
 * 结构化摘要，不是原始轨迹：原始要求、收尾结论、文件清单（0 次经过模型）、
 * 已冻结的约束/决策（如果本次会话压缩过，0 次经过模型）、结果标签。
 * 每段独立截断，任何一段异常长都不会顶掉其余段落。
 */
function buildDigest(input: MemoryExtractionInput): string {
  const parts: string[] = [
    `## Original request\n${truncate(firstUserText(input.messages), 500)}`,
  ];
  const finalText = lastAssistantText(input.messages);
  if (finalText.length > 0) parts.push(`## Final response\n${truncate(finalText, 500)}`);

  const fileOpsText = formatFileOperations(
    extractFileOperations(input.messages, { maxFiles: input.maxTrackedFiles }),
  );
  if (fileOpsText.length > 0) parts.push(fileOpsText);

  const carried = carriedFromSummary(input.previousSummary);
  if (carried.constraints.length > 0) {
    parts.push(`## Constraints already recorded\n${carried.constraints}`);
  }
  if (carried.keyDecisions.length > 0) {
    parts.push(`## Decisions already recorded\n${carried.keyDecisions}`);
  }

  parts.push(
    `## Outcome\n${
      input.loopEndReason === 'stop'
        ? 'Task completed normally.'
        : `Task ended with ${input.loopEndReason} — look especially for pitfalls to avoid next time.`
    }`,
  );
  return parts.join('\n\n');
}

function carriedFromSummary(previousSummary: Message | undefined): {
  constraints: string;
  keyDecisions: string;
} {
  if (previousSummary === undefined) return { constraints: '', keyDecisions: '' };
  const content =
    typeof previousSummary.content === 'string' ? previousSummary.content : '';
  const parsed = parseSummarySections(content);
  if (!parsed.matched) return { constraints: '', keyDecisions: '' };
  return {
    constraints: getSection(parsed, 'Constraints & preferences'),
    keyDecisions: getSection(parsed, 'Key decisions'),
  };
}

function firstUserText(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  return '';
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/u, '').trim())
    .filter((line) => line.length > 0);
}

/** 合并外层取消与抽取自己的 deadline；同 agent/summarize/llm.ts 的先例。 */
function createTimeout(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Extraction timed out')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}
