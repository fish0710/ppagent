import type {
  CompactPolicy,
  CompactResult,
  CompactTrigger,
  Context,
  FileOperations,
  Message,
  ReadonlyContext,
  ResourceSnapshot,
  Summarizer,
  TokenCounter,
  TraceContext,
} from '../types.js';
import {
  IneffectiveCompactionError,
  NoCompactableContextError,
} from './compact.js';

export interface ContextManagerOptions {
  context: Context;
  tokenCounter: TokenCounter;
  previousSummary?: Message;
  previousDetails?: FileOperations;
  /** 紧跟在 previousSummary 之后、原样保留的 user 消息块；见 CompactExecutionContext.previousCarried。 */
  previousCarried?: readonly Message[];
}

export interface CompactContextOptions {
  policy: CompactPolicy;
  summarizer: Summarizer;
  contextWindow: number;
  signal: AbortSignal;
  trace: TraceContext;
  resource?: ResourceSnapshot;
  targetTokens?: number;
  /** `/compact <instructions>` 传来的额外要求。 */
  instructions?: string;
}

/** M5 的内存视图；持久化仍由 loop 通过回调搬运，manager 不认识 Store。 */
export class ContextManager {
  readonly #tokenCounter: TokenCounter;
  readonly #context: Context;
  #previousSummary?: Message;
  #previousDetails?: FileOperations;
  #previousCarried: readonly Message[] = [];

  constructor(options: ContextManagerOptions) {
    this.#tokenCounter = options.tokenCounter;
    this.#context = structuredClone(options.context);
    if (options.previousSummary !== undefined) {
      const first = this.#context.messages[0];
      if (JSON.stringify(first) !== JSON.stringify(options.previousSummary)) {
        throw new Error('previousSummary must be the first message in context');
      }
      this.#previousSummary = structuredClone(options.previousSummary);
    }
    if (options.previousDetails !== undefined) {
      this.#previousDetails = structuredClone(options.previousDetails);
    }
    if (options.previousCarried !== undefined && options.previousCarried.length > 0) {
      const offset = this.#previousSummary === undefined ? 0 : 1;
      const actual = this.#context.messages.slice(
        offset,
        offset + options.previousCarried.length,
      );
      if (JSON.stringify(actual) !== JSON.stringify(options.previousCarried)) {
        throw new Error('previousCarried must immediately follow previousSummary in context');
      }
      this.#previousCarried = structuredClone(options.previousCarried) as Message[];
    }
  }

  /** 直接引用但类型为只读视图；数组结构变更只能走 append/compact。 */
  get context(): ReadonlyContext {
    return this.#context;
  }

  get previousSummary(): Message | undefined {
    return this.#previousSummary === undefined
      ? undefined
      : structuredClone(this.#previousSummary);
  }

  get previousDetails(): FileOperations | undefined {
    return this.#previousDetails === undefined
      ? undefined
      : structuredClone(this.#previousDetails);
  }

  get previousCarried(): readonly Message[] {
    return structuredClone(this.#previousCarried) as Message[];
  }

  /** 在 loop 完成时导出可独立持有的结果，不泄漏 manager 的内部引用。 */
  snapshot(): Context {
    return structuredClone(this.#context);
  }

  append(...messages: Message[]): void {
    this.#context.messages.push(...messages);
  }

  tokenUsage(): number {
    return this.#tokenCounter.countContext(this.#context);
  }

  /**
   * 只做触发判断，不动上下文。
   *
   * 与 compact 分开是因为 LLM 摘要可能跑几十秒，调用方需要在动手之前就把
   * "开始压缩了"发出去，否则界面会静默卡住。
   */
  shouldCompact(
    options: Pick<CompactContextOptions, 'policy' | 'contextWindow' | 'resource'>,
  ): CompactTrigger | null {
    return options.policy.shouldCompact({
      tokenUsage: this.tokenUsage(),
      contextWindow: options.contextWindow,
      ...(options.resource === undefined ? {} : { resource: options.resource }),
    });
  }

  async compactIfNeeded(
    options: CompactContextOptions,
  ): Promise<CompactResult | null> {
    const trigger = this.shouldCompact(options);
    if (trigger === null) return null;
    return this.compact(trigger, options);
  }

  async compact(
    trigger: CompactTrigger,
    options: Omit<CompactContextOptions, 'resource'>,
  ): Promise<CompactResult | null> {
    try {
      const result = await options.policy.compact(
        this.#context.messages,
        trigger,
        options.summarizer,
        {
          contextWindow: options.contextWindow,
          ...(this.#previousSummary === undefined
            ? {}
            : { previousSummary: this.#previousSummary }),
          ...(this.#previousDetails === undefined
            ? {}
            : { previousDetails: this.#previousDetails }),
          previousCarried: this.#previousCarried,
          ...(this.#context.systemPrompt === undefined
            ? {}
            : { systemPrompt: this.#context.systemPrompt }),
          ...(this.#context.tools === undefined
            ? {}
            : { tools: this.#context.tools }),
          ...(options.targetTokens === undefined
            ? {}
            : { targetTokens: options.targetTokens }),
          ...(options.instructions === undefined
            ? {}
            : { instructions: options.instructions }),
          signal: options.signal,
          trace: options.trace,
        },
      );
      this.#context.messages = result.messages;
      // 剪枝没有产生摘要，覆盖点没有前移；此时清掉 previousSummary 会让下一次
      // 压缩以为首条摘要不存在，把它当普通历史再摘要一遍。
      if (result.kind === 'summarize' && result.summary !== undefined) {
        this.#previousSummary = result.summary;
        // details/keptUserIndices 在 summarize 分支必然产出，这里的 undefined
        // 分支只是类型层面的可选性（对应 kind:'prune'），不是真实状态。
        if (result.details !== undefined) this.#previousDetails = result.details;
        if (result.keptUserIndices !== undefined) {
          // result.messages = [summary, ...carried, ...retained]；carried 的
          // 长度就是 keptUserIndices 的长度，直接切片取出即可，不需要重新
          // 从 messages 里按角色扫描——那样会把 retained 开头凑巧是 user 的
          // 消息也当成 carried 的一部分。
          this.#previousCarried = result.messages.slice(1, 1 + result.keptUserIndices.length);
        }
      }
      return result;
    } catch (error) {
      if (
        error instanceof NoCompactableContextError ||
        error instanceof IneffectiveCompactionError
      ) {
        return null;
      }
      throw error;
    }
  }
}

type Assert<T extends true> = T;
type IsReadonlyArray<T extends readonly unknown[]> = T extends unknown[]
  ? false
  : true;
/** 编译期契约测试：getter 一旦退回 Message[]，build 会在这里失败。 */
type ContextMessagesStayReadonly = Assert<
  IsReadonlyArray<ContextManager['context']['messages']>
>;
