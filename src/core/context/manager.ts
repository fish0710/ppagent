import type {
  CompactPolicy,
  CompactResult,
  CompactTrigger,
  Context,
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
}

export interface CompactContextOptions {
  policy: CompactPolicy;
  summarizer: Summarizer;
  contextWindow: number;
  signal: AbortSignal;
  trace: TraceContext;
  resource?: ResourceSnapshot;
  targetTokens?: number;
}

/** M5 的内存视图；持久化仍由 loop 通过回调搬运，manager 不认识 Store。 */
export class ContextManager {
  readonly #tokenCounter: TokenCounter;
  readonly #context: Context;
  #previousSummary?: Message;

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

  async compactIfNeeded(
    options: CompactContextOptions,
  ): Promise<CompactResult | null> {
    const trigger = options.policy.shouldCompact({
      tokenUsage: this.tokenUsage(),
      contextWindow: options.contextWindow,
      ...(options.resource === undefined ? {} : { resource: options.resource }),
    });
    if (trigger === null) return null;
    return this.compact(trigger, options);
  }

  async compact(
    trigger: CompactTrigger,
    options: Omit<CompactContextOptions, 'contextWindow' | 'resource'>,
  ): Promise<CompactResult | null> {
    try {
      const result = await options.policy.compact(
        this.#context.messages,
        trigger,
        options.summarizer,
        {
          ...(this.#previousSummary === undefined
            ? {}
            : { previousSummary: this.#previousSummary }),
          ...(this.#context.systemPrompt === undefined
            ? {}
            : { systemPrompt: this.#context.systemPrompt }),
          ...(options.targetTokens === undefined
            ? {}
            : { targetTokens: options.targetTokens }),
          signal: options.signal,
          trace: options.trace,
        },
      );
      this.#context.messages = result.messages;
      this.#previousSummary = result.summary;
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
