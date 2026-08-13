import type {
  CompactExecutionContext,
  CompactPolicy,
  CompactResult,
  CompactSignals,
  CompactTrigger,
  ContextConfig,
  ContentBlock,
  Message,
  SummarizeRequest,
  SummarizeResult,
  Summarizer,
  TokenCounter,
  ToolCallId,
} from '../types.js';

export interface ThresholdCompactPolicyOptions {
  config: ContextConfig;
  tokenCounter: TokenCounter;
}

export class NoCompactableContextError extends Error {
  constructor() {
    super('No safe compact boundary exists before the recent-message window.');
    this.name = 'NoCompactableContextError';
  }
}

export class IneffectiveCompactionError extends Error {
  constructor() {
    super('Compaction did not reduce the message token count.');
    this.name = 'IneffectiveCompactionError';
  }
}

/** token/内存双阈值策略；M5 只传 token，M10 再接 resource。 */
export class ThresholdCompactPolicy implements CompactPolicy {
  readonly #config: ContextConfig;
  readonly #tokenCounter: TokenCounter;

  constructor(options: ThresholdCompactPolicyOptions) {
    validateConfig(options.config);
    this.#config = { ...options.config };
    this.#tokenCounter = options.tokenCounter;
  }

  shouldCompact(signals: CompactSignals): CompactTrigger | null {
    if (
      signals.resource !== undefined &&
      signals.resource.memPressure >= this.#config.memPressureThreshold
    ) {
      return 'memory';
    }
    return signals.tokenUsage >= signals.contextWindow * this.#config.compactThreshold
      ? 'token'
      : null;
  }

  async compact(
    messages: Message[],
    trigger: CompactTrigger,
    summarizer: Summarizer,
    execution: CompactExecutionContext,
  ): Promise<CompactResult> {
    const cut = findSafeCompactBoundary(
      messages,
      this.#config.keepRecentMessages,
    );
    const previousOffset = execution.previousSummary === undefined ? 0 : 1;
    if (cut <= previousOffset) throw new NoCompactableContextError();
    if (
      execution.previousSummary !== undefined &&
      !sameMessage(messages[0], execution.previousSummary)
    ) {
      throw new Error('previousSummary must be the first message in the current view');
    }

    // 旧摘要单独传入，不能再次混进 messages；否则 summarizer 很容易重复或遗漏。
    const toSummarize = messages.slice(previousOffset, cut);
    const summarized = await summarizer.summarize({
      ...(execution.previousSummary === undefined
        ? {}
        : { previousSummary: execution.previousSummary }),
      messages: toSummarize,
      ...(execution.systemPrompt === undefined
        ? {}
        : { systemPrompt: execution.systemPrompt }),
      ...(execution.targetTokens === undefined
        ? {}
        : { targetTokens: execution.targetTokens }),
      signal: execution.signal,
      trace: execution.trace,
    });
    const compactedMessages = [summarized.summary, ...messages.slice(cut)];
    const tokensBefore = this.#tokenCounter.countMessages(messages);
    const tokensAfter = this.#tokenCounter.countMessages(compactedMessages);
    // 工具定义也参与触发阈值，但消息历史过短时，摘要头可能比原文更长。
    // 这种压缩只会恶化下一轮输入，保持原视图并等待更多历史积累。
    if (tokensAfter >= tokensBefore) throw new IneffectiveCompactionError();
    return {
      messages: compactedMessages,
      summary: summarized.summary,
      trigger,
      replacedCount: cut,
      tokensBefore,
      tokensAfter,
      meta: summarized.meta,
    };
  }
}

/**
 * keepRecentMessages 给出期望切点；若它落在 toolCall/toolResult 中间，向历史
 * 方向移动，直到没有任何调用配对跨越边界。返回值是保留区间的起始 index。
 */
export function findSafeCompactBoundary(
  messages: readonly Message[],
  keepRecentMessages: number,
): number {
  if (!Number.isInteger(keepRecentMessages) || keepRecentMessages < 1) {
    throw new Error('keepRecentMessages must be a positive integer');
  }
  const startingPoint = Math.max(0, messages.length - keepRecentMessages);
  for (let cut = startingPoint; cut > 0; cut -= 1) {
    if (isSafeBoundary(messages, cut)) return cut;
  }
  return 0;
}

function isSafeBoundary(messages: readonly Message[], cut: number): boolean {
  const calls = new Map<ToolCallId, number>();
  const duplicateCalls = new Set<ToolCallId>();
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      if (calls.has(block.id)) duplicateCalls.add(block.id);
      else calls.set(block.id, index);
    }
  });

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult') continue;
    const callIndex = calls.get(message.toolCallId);
    // retained 视图里不能出现找不到调用方的孤儿 toolResult。
    if (callIndex === undefined || duplicateCalls.has(message.toolCallId)) {
      if (index >= cut) return false;
      continue;
    }
    if ((callIndex < cut) !== (index < cut)) return false;
  }
  return true;
}

export interface StructuralSummarizerOptions {
  tokenCounter: TokenCounter;
  now?: () => number;
}

/** 不调用模型的确定性摘要器；旧摘要原样作为前缀，强制满足累积语义。 */
export class StructuralSummarizer implements Summarizer {
  readonly id = 'structural';
  readonly #tokenCounter: TokenCounter;
  readonly #now: () => number;

  constructor(options: StructuralSummarizerOptions) {
    this.#tokenCounter = options.tokenCounter;
    this.#now = options.now ?? Date.now;
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    throwIfAborted(request.signal);
    const startedAt = this.#now();
    const previous =
      request.previousSummary === undefined
        ? ''
        : `Previous cumulative summary:\n${messageSummary(request.previousSummary)}\n\n`;
    const heading = 'Compacted conversation history:\n';
    const fixed = `${heading}${previous}`;
    const remaining =
      request.targetTokens === undefined
        ? undefined
        : Math.max(
            0,
            request.targetTokens - this.#tokenCounter.countText(fixed),
          );
    const boundedHistory = boundedMessageHistory(
      request.messages,
      remaining,
      this.#tokenCounter,
    );
    const text = `${fixed}${boundedHistory}`.trimEnd();
    throwIfAborted(request.signal);
    const endedAt = this.#now();
    return {
      summary: { role: 'user', content: text, timestamp: endedAt },
      meta: {
        strategy: this.id,
        tokensIn: this.#tokenCounter.countMessages([
          ...(request.previousSummary === undefined
            ? []
            : [request.previousSummary]),
          ...request.messages,
        ]),
        tokensOut: this.#tokenCounter.countText(text),
        latencyMs: Math.max(0, endedAt - startedAt),
        modelCalls: 0,
      },
    };
  }
}

function messageSummary(message: Message): string {
  const entry = messageEntry(message);
  return `${entry.prefix}${entry.body}`;
}

function messageEntry(message: Message): { prefix: string; body: string } {
  switch (message.role) {
    case 'user':
      return { prefix: 'user: ', body: contentText(message.content) };
    case 'assistant':
      return { prefix: 'assistant: ', body: contentText(message.content) };
    case 'toolResult':
      return {
        prefix: `tool ${message.toolName} (${message.isError ? 'error' : 'ok'}): `,
        body: contentText(message.content),
      };
  }
}

/**
 * 紧预算时给每条消息分一份额度，而不是只截整个字符串的尾部。即使额度
 * 小到放不下正文，也保留每条消息的角色/工具标签，避免后半段历史整段消失。
 */
function boundedMessageHistory(
  messages: readonly Message[],
  maxTokens: number | undefined,
  counter: TokenCounter,
): string {
  const complete = messages.map(messageSummary).join('\n');
  if (
    maxTokens === undefined ||
    messages.length === 0 ||
    counter.countText(complete) <= maxTokens
  ) {
    return complete;
  }
  const tokensPerMessage = Math.floor(maxTokens / messages.length);
  return messages
    .map((message) => {
      const entry = messageEntry(message);
      const bounded = truncateToTokens(
        `${entry.prefix}${entry.body}`,
        tokensPerMessage,
        counter,
      );
      return bounded.length === 0 ? `${entry.prefix}[omitted]` : bounded;
    })
    .join('\n');
}

function contentText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'thinking':
          return `[thinking] ${block.thinking}`;
        case 'toolCall':
          return `[toolCall ${block.name}] ${safeStringify(block.arguments)}`;
        case 'image':
          return `[image ${block.mimeType}]`;
      }
    })
    .join('\n');
}

function truncateToTokens(
  text: string,
  maxTokens: number,
  counter: TokenCounter,
): string {
  if (maxTokens <= 0) return '';
  if (counter.countText(text) <= maxTokens) return text;
  const characters = [...text];
  const marker = '\n[... compacted ...]';
  const markerTokens = counter.countText(marker);
  if (markerTokens >= maxTokens) return '';
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join('')}${marker}`;
    if (counter.countText(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join('')}${marker}`;
}

function sameMessage(left: Message | undefined, right: Message): boolean {
  return left !== undefined && safeStringify(left) === safeStringify(right);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('Compaction aborted');
}

function validateConfig(config: ContextConfig): void {
  if (config.compactThreshold <= 0 || config.compactThreshold > 1) {
    throw new Error('compactThreshold must be in (0, 1]');
  }
  if (config.memPressureThreshold <= 0 || config.memPressureThreshold > 1) {
    throw new Error('memPressureThreshold must be in (0, 1]');
  }
  if (!Number.isInteger(config.keepRecentMessages) || config.keepRecentMessages < 1) {
    throw new Error('keepRecentMessages must be a positive integer');
  }
}
