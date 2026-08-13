import type {
  CompactPolicy,
  CompactResult,
  CompactTrigger,
  Context,
  Message,
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

  /** Provider 只读使用；消息变更应通过 append/compact 完成。 */
  get context(): Context {
    return this.#context;
  }

  get previousSummary(): Message | undefined {
    return this.#previousSummary;
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
