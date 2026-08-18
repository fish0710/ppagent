import type {
  CompactExecutionContext,
  CompactPolicy,
  CompactResult,
  CompactSignals,
  CompactTrigger,
  ContextConfig,
  ContentBlock,
  Message,
  ReadonlyContext,
  SummarizeRequest,
  SummarizeResult,
  Summarizer,
  TokenCounter,
  ToolCallId,
} from '../types.js';
import { extractFileOperations } from './files.js';
import { pruneToolResults } from './prune.js';

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

  /**
   * 两层：先试规则剪枝，剪够了就不调模型；不够才折叠成摘要。
   *
   * 两层是备选关系而不是流水线。摘要反正要丢弃切点之前那段历史，先剪一遍纯属
   * 白做；更要命的是剪枝改的是历史中段，会让紧接着那次摘要请求的前缀对不上
   * 实活上下文、错过本地服务的 KV 前缀缓存。所以剪枝不够用时，它的结果被整个
   * 丢弃，摘要从未改动的原始 messages 出发。
   */
  async compact(
    messages: Message[],
    trigger: CompactTrigger,
    summarizer: Summarizer,
    execution: CompactExecutionContext,
  ): Promise<CompactResult> {
    const summaryOffset = execution.previousSummary === undefined ? 0 : 1;
    if (
      execution.previousSummary !== undefined &&
      !sameMessage(messages[0], execution.previousSummary)
    ) {
      throw new Error('previousSummary must be the first message in the current view');
    }
    // 头部保护区 = 摘要（若有）+ 上一次压缩保留下来的 user 消息块。这段必须
    // 整体当"已经处理过"看待：不能再折叠（它已经是折叠的产物），也不能让切点
    // 搜索落在它内部（否则会把某条保留的 user 消息误判成新一轮 retained 尾巴
    // 的起点，导致这批消息被"保留"两次、历史几乎折叠不动）。
    const headSize = summaryOffset + execution.previousCarried.length;
    if (
      execution.previousCarried.length > 0 &&
      !sameMessages(
        messages.slice(summaryOffset, headSize),
        execution.previousCarried,
      )
    ) {
      throw new Error(
        'previousCarried must immediately follow previousSummary in the current view',
      );
    }
    const contextOf = (view: readonly Message[]): ReadonlyContext => ({
      ...(execution.systemPrompt === undefined
        ? {}
        : { systemPrompt: execution.systemPrompt }),
      messages: view,
      ...(execution.tools === undefined ? {} : { tools: execution.tools }),
    });
    // 与 shouldCompact 的输入口径保持一致：都算完整上下文。只算 messages 会让
    // 一大块工具定义触发压缩、再被下面的无收益判定否掉，压缩永远做不成。
    const tokensBefore = this.#tokenCounter.countContext(contextOf(messages));
    const protectTokens = Math.max(
      1,
      Math.floor(execution.contextWindow * this.#config.pruneProtectRatio),
    );

    // 第一层：剪枝。够了就到此为止 —— 全部消息的结构、顺序和 toolCall 轨迹
    // 都还在，只是老工具输出降了保真度，比丢给模型重述一遍损失更小。
    const pruned = pruneToolResults(messages, {
      protectTokens,
      minGainTokens: this.#config.pruneMinTokens,
      tokenCounter: this.#tokenCounter,
    });
    if (pruned !== null) {
      const tokensAfter = this.#tokenCounter.countContext(
        contextOf(pruned.messages),
      );
      if (tokensAfter < execution.contextWindow * this.#config.compactThreshold) {
        return {
          kind: 'prune',
          messages: pruned.messages,
          trigger,
          replacedCount: 0,
          prunedCount: pruned.prunedCount,
          tokensBefore,
          tokensAfter,
        };
      }
    }

    const cut = findCompactBoundary(messages, {
      keepRecentTokens: Math.max(
        1,
        Math.floor(execution.contextWindow * this.#config.keepRecentRatio),
      ),
      tokenCounter: this.#tokenCounter,
      minCut: headSize,
    });
    if (cut <= headSize) throw new NoCompactableContextError();

    // 第二层：摘要。用未剪枝的原始 messages 调用，前缀才和上一次真实请求
    // 逐字节一致；剪枝结果在这里被丢弃，它本来就只覆盖要被摘要取代的那段。
    // 旧摘要单独传入，不能再次混进 messages；否则 summarizer 很容易重复或遗漏。
    const retained = messages.slice(cut);
    const toSummarize = messages.slice(headSize, cut);
    // 文件清单在这里算，不交给模型转述：路径在 toolCall 里是结构化的。
    const details = extractFileOperations(toSummarize, {
      ...(execution.previousDetails === undefined
        ? {}
        : { previous: execution.previousDetails }),
      maxFiles: this.#config.maxTrackedFiles,
    });
    const summarized = await summarizer.summarize({
      ...(execution.previousSummary === undefined
        ? {}
        : { previousSummary: execution.previousSummary }),
      ...(execution.previousCarried.length === 0
        ? {}
        : { carried: execution.previousCarried }),
      messages: toSummarize,
      retained,
      fileOps: details,
      ...(execution.systemPrompt === undefined
        ? {}
        : { systemPrompt: execution.systemPrompt }),
      ...(execution.tools === undefined ? {} : { tools: execution.tools }),
      ...(execution.targetTokens === undefined
        ? {}
        : { targetTokens: execution.targetTokens }),
      ...(execution.instructions === undefined
        ? {}
        : { instructions: execution.instructions }),
      signal: execution.signal,
      trace: execution.trace,
    });

    // user 消息不折叠：从这一轮被折叠掉的历史（toSummarize）里把真实用户输入
    // 挑出来，接到上一次保留下来的那批之后，一起过预算淘汰。挑选与折叠区完全
    // 独立进行——模型仍然看得到这些消息（它们本来就在 toSummarize 里，一起
    // 送进了上面的请求），只是它们不再依赖模型转述就能存活到下一轮。
    const { carried: newCarried, keptUserIndices } = selectCarriedUsers({
      previousCarried: execution.previousCarried,
      previousCarriedOffset: summaryOffset,
      toSummarize,
      toSummarizeOffset: headSize,
      budgetTokens: Math.max(
        1,
        Math.floor(execution.contextWindow * this.#config.keepUserRatio),
      ),
      tokenCounter: this.#tokenCounter,
    });

    // 摘要调用已经用未剪枝的 pristine messages 拿到了前缀缓存收益；调用之后
    // 再剪保留的尾巴不影响那次请求，却能把 pruneProtectRatio 与
    // keepRecentRatio 之间那条本来够得着、之前却被整段丢弃的老工具输出也压下
    // 去——保留窗口通常比保护窗口宽（keepRecentRatio > pruneProtectRatio 由
    // validateConfig 保证），中间那条带子里的原文完全在剪枝的能力范围内。
    const retainedPrune = pruneToolResults(retained, {
      protectTokens,
      minGainTokens: this.#config.pruneMinTokens,
      tokenCounter: this.#tokenCounter,
    });
    const finalRetained = retainedPrune?.messages ?? retained;
    const compactedMessages = [summarized.summary, ...newCarried, ...finalRetained];
    const tokensAfter = this.#tokenCounter.countContext(
      contextOf(compactedMessages),
    );
    // 消息历史过短时，摘要头可能比原文更长。这种压缩只会恶化下一轮输入，
    // 保持原视图并等待更多历史积累。
    if (tokensAfter >= tokensBefore) throw new IneffectiveCompactionError();
    return {
      kind: 'summarize',
      messages: compactedMessages,
      summary: summarized.summary,
      trigger,
      replacedCount: cut,
      prunedCount: retainedPrune?.prunedCount ?? 0,
      tokensBefore,
      tokensAfter,
      meta: summarized.meta,
      details,
      keptUserIndices,
    };
  }
}

interface SelectCarriedUsersOptions {
  /** 上一次压缩保留下来的 user 消息，按 messages 里出现的顺序。 */
  previousCarried: readonly Message[];
  /** previousCarried 在 messages 里的起始下标（等于 summaryOffset）。 */
  previousCarriedOffset: number;
  /** 这一轮要折叠的消息（还没被过滤过，包含 user/assistant/toolResult）。 */
  toSummarize: readonly Message[];
  /** toSummarize 在 messages 里的起始下标（等于 headSize）。 */
  toSummarizeOffset: number;
  budgetTokens: number;
  tokenCounter: TokenCounter;
}

/**
 * 从"上一次保留的" + "这一轮新折叠掉的"真实 user 消息里选出这一轮该保留的
 * 那批：按 contextWindow 的 keepUserRatio 记预算，从最新往前累加，装不下的
 * 最老的先淘汰——它已经在最多轮压缩里被模型看过，该经历的都经历过了。
 *
 * 返回的 carried 保持时间顺序（旧到新），keptUserIndices 是它们在压缩前的
 * messages 视图里的下标，供持久层换算成磁盘 seq。
 */
function selectCarriedUsers(
  options: SelectCarriedUsersOptions,
): { carried: Message[]; keptUserIndices: number[] } {
  const candidates: { message: Message; sourceIndex: number }[] = [
    ...options.previousCarried.map((message, index) => ({
      message,
      sourceIndex: options.previousCarriedOffset + index,
    })),
    ...options.toSummarize
      .map((message, index) => ({
        message,
        sourceIndex: options.toSummarizeOffset + index,
      }))
      .filter(({ message }) => message.role === 'user' && message.synthetic !== true),
  ];

  let accumulated = 0;
  let start = candidates.length;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const next = accumulated + options.tokenCounter.countMessages([candidate.message]);
    if (next > options.budgetTokens) break;
    accumulated = next;
    start = index;
  }
  const surviving = candidates.slice(start);
  return {
    carried: surviving.map((entry) => entry.message),
    keptUserIndices: surviving.map((entry) => entry.sourceIndex),
  };
}

export interface CompactBoundaryOptions {
  /** 保留窗口的 token 预算，从最新往前累加。 */
  keepRecentTokens: number;
  tokenCounter: TokenCounter;
  /** 切点必须大于它才有折叠价值；通常是 0 或 1（首条是上一版摘要）。 */
  minCut?: number;
}

/**
 * 定切点：token 预算给候选，turn 边界给对齐，配对规则给最终裁定。
 * 返回值是保留区间的起始 index。
 *
 * 用 token 预算而不是消息条数 —— 6 条消息可能是 300 token 的闲聊，也可能是
 * 40k token 的文件读取。
 */
export function findCompactBoundary(
  messages: readonly Message[],
  options: CompactBoundaryOptions,
): number {
  if (!Number.isInteger(options.keepRecentTokens) || options.keepRecentTokens < 1) {
    throw new Error('keepRecentTokens must be a positive integer');
  }
  // minCut 现在是搜索的硬地板，不只是事后校验：地板以内是头部保护区（摘要 +
  // 上一次保留的 user 消息块），已经处理过了，切点绝不能落进去，否则会把
  // 保留块里的某条消息误判成这一轮新的 retained 起点。
  const minCut = options.minCut ?? 0;
  const candidate = Math.max(
    minCut,
    tokenBudgetCut(messages, options.keepRecentTokens, options.tokenCounter),
  );

  // 首选切在 turn 起点：保留区间从一条完整的 user 轮次开始，模型不会看到
  // 半截对话。这也是"至少保留几条消息"那类下限的替代品 —— 一个完整 turn
  // 天然不止一条消息，无须再设条数下限。
  const preferred = searchSafeBoundary(
    messages,
    alignToTurnStart(messages, candidate, minCut),
    minCut,
  );
  if (preferred > minCut) return preferred;

  // 整段历史只有一个巨型 turn（一轮里读了十几个文件），对齐到 turn 起点就
  // 退到头了。此时允许切在 turn 内部的 assistant 消息上。缺这条退路会直接
  // 抛 NoCompactableContextError，上下文一路涨到爆窗口。
  return searchSafeBoundary(messages, candidate, minCut);
}

/** 从最新往前累加，凑满预算为止；返回保留区间的起始 index。 */
function tokenBudgetCut(
  messages: readonly Message[],
  keepRecentTokens: number,
  counter: TokenCounter,
): number {
  let accumulated = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    accumulated += counter.countMessages([message]);
    // 单条就撑爆预算时也要留下它自己，否则保留区间会是空的。
    if (accumulated >= keepRecentTokens) return index;
  }
  return 0;
}

/** 向历史方向移到最近的 user 消息；找不到就退到地板。 */
function alignToTurnStart(
  messages: readonly Message[],
  cut: number,
  floor: number,
): number {
  for (let index = Math.min(cut, messages.length - 1); index > floor; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return floor;
}

/**
 * 从 start 向历史方向找第一个不切断 toolCall/toolResult 配对的位置，绝不
 * 越过地板。toolResult 永远不是合法切点 —— 它必须和发起它的 toolCall
 * 待在同一侧。地板本身（头部保护区的边界）不需要再验证：它就是上一次的
 * 切点，当时已经验证过安全，之后没有任何操作会让它变得不安全。
 */
function searchSafeBoundary(
  messages: readonly Message[],
  start: number,
  floor: number,
): number {
  for (let cut = Math.max(floor, Math.min(start, messages.length)); cut > floor; cut -= 1) {
    if (isSafeBoundary(messages, cut)) return cut;
  }
  return floor;
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

/**
 * 不调用模型的确定性摘要器。
 *
 * 现在的定位是 LlmSummarizer 的兜底：本地服务挂了、模型只吐工具调用、摘要超时
 * 的时候，压缩不能连带把这一轮 turn 一起杀掉。它只会机械截断，保不住语义，
 * 不该作为常态策略。
 *
 * 旧摘要作为前缀原样带上以满足累积语义，但**限额一半预算** —— 不限额的话
 * 摘要会逐次嵌套增长，最终吃光整个预算、把新历史挤成一堆 [omitted]。
 */
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
    // 旧摘要最多占一半预算，剩下一半永远留给新历史；否则递归嵌套会挤掉全部新内容。
    const previousBudget =
      request.targetTokens === undefined
        ? undefined
        : Math.floor(request.targetTokens / 2);
    const previous =
      request.previousSummary === undefined
        ? ''
        : `Previous cumulative summary:\n${
            previousBudget === undefined
              ? messageSummary(request.previousSummary)
              : truncateToTokens(
                  messageSummary(request.previousSummary),
                  previousBudget,
                  this.#tokenCounter,
                )
          }\n\n`;
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
      // synthetic: true —— 这是 harness 塞的摘要，不是用户说的话。user 消息
      // 不折叠的策略只保留真实用户输入，不打这个标记会让历次摘要被当成
      // "用户的话"一起原样保留，无限累积进 carried 块。
      summary: { role: 'user', content: text, timestamp: endedAt, synthetic: true },
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

/**
 * Head-preserving token-budget truncation with a binary search over character
 * count (token boundaries aren't byte-stable, so we can't compute the cut
 * directly). Exported so LlmSummarizer doesn't need its own copy — the two
 * only differ in the marker string.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  counter: TokenCounter,
  marker = '\n[... compacted ...]',
): string {
  if (maxTokens <= 0) return '';
  if (counter.countText(text) <= maxTokens) return text;
  const characters = [...text];
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

function sameMessages(left: readonly Message[], right: readonly Message[]): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => sameMessage(message, right[index] as Message))
  );
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
  if (
    !Number.isFinite(config.keepRecentRatio) ||
    config.keepRecentRatio <= 0 ||
    config.keepRecentRatio >= config.compactThreshold
  ) {
    // 保留窗口不小于触发阈值时，压缩后立刻又超阈值，每轮都压一次。
    throw new Error('keepRecentRatio must be in (0, compactThreshold)');
  }
  if (!Number.isInteger(config.summaryMaxTokens) || config.summaryMaxTokens < 1) {
    throw new Error('summaryMaxTokens must be a positive integer');
  }
  if (
    !Number.isFinite(config.pruneProtectRatio) ||
    config.pruneProtectRatio <= 0 ||
    config.pruneProtectRatio > 1
  ) {
    throw new Error('pruneProtectRatio must be in (0, 1]');
  }
  if (!Number.isInteger(config.pruneMinTokens) || config.pruneMinTokens < 1) {
    throw new Error('pruneMinTokens must be a positive integer');
  }
  if (!Number.isInteger(config.maxTrackedFiles) || config.maxTrackedFiles < 1) {
    throw new Error('maxTrackedFiles must be a positive integer');
  }
  if (
    !Number.isFinite(config.keepUserRatio) ||
    config.keepUserRatio <= 0 ||
    config.keepUserRatio > 1
  ) {
    throw new Error('keepUserRatio must be in (0, 1]');
  }
}
