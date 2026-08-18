import type {
  AssistantMessage,
  Message,
  TokenCounter,
  ToolResultMessage,
} from '../types.js';

/** 存根保留的首尾行数；首行说明这是什么，末行说明它怎么结束的。 */
const STUB_HEAD_LINES = 2;
const STUB_TAIL_LINES = 2;
/**
 * 短于这个长度的正文不剪。存根本身也占字符，剪一段 200 字的输出净收益接近零，
 * 却照样把这条消息改脏、作废前缀缓存。
 */
const STUB_MIN_CHARS = 400;
/** 存根首尾两段的总字符上限，防止单行超长（压缩过的 JSON、base64）绕过行数限制。 */
const STUB_MAX_CHARS = 320;

export interface PruneOptions {
  /**
   * 从最新往前累计到这么多 token 为止的消息一律不动。
   *
   * 保护窗口独立于压缩切点，通常比它小 —— 剪枝要够得着切点之后的那段，
   * 才能作为摘要的替代方案成立。一个单条就撑爆保留预算的巨型工具输出会把
   * 切点顶到它前面，若剪枝也止步于切点，这条输出就谁都碰不到，压缩白做。
   */
  protectTokens: number;
  /** 回收量低于此值就整体放弃，返回 null。 */
  minGainTokens: number;
  tokenCounter: TokenCounter;
}

export interface PruneResult {
  messages: Message[];
  /** 正文被换成存根的 toolResult 条数。 */
  prunedCount: number;
  tokensSaved: number;
}

/**
 * compact 的第一层：把保护窗口之外的工具输出正文换成存根，并清掉老的 thinking。
 *
 * 消息条数、角色顺序、toolCall/toolResult 配对全部不变 —— 只有 toolResult 的
 * 正文变短。因此这一层不需要安全边界搜索，也不会产生孤儿 toolResult。
 *
 * 刻意不动 assistant 里的 toolCall 块：那是 agent 的行动轨迹，是"我已经试过什么"
 * 的唯一记录，比任何一段工具输出都更不该丢。
 *
 * 与摘要是备选关系而非流水线：剪枝够了就不调模型（保住全部消息结构，只降老
 * 工具输出的保真度），不够时它的结果被整个丢弃、由摘要从未改动的原始上下文
 * 接手 —— 那段历史反正要被摘要取代，先剪一遍白做，还会让摘要请求错过前缀缓存。
 *
 * 纯函数，不改输入。返回 null 表示不值得剪。
 */
export function pruneToolResults(
  messages: readonly Message[],
  options: PruneOptions,
): PruneResult | null {
  const boundary = findProtectBoundary(messages, options);
  if (boundary <= 0) return null;

  let prunedCount = 0;
  const pruned = messages.map((message, index) => {
    if (index >= boundary) return message;
    switch (message.role) {
      case 'toolResult': {
        const next = pruneToolResult(message);
        if (next !== message) prunedCount += 1;
        return next;
      }
      case 'assistant':
        return stripThinking(message);
      case 'user':
        return message;
    }
  });

  const tokensSaved =
    options.tokenCounter.countMessages(messages) -
    options.tokenCounter.countMessages(pruned);
  // 收益不够就整体放弃：剪枝改的是历史中段，一样作废整段 KV 前缀缓存，
  // 为几百 token 付一次全量 prefill 是亏的。
  if (tokensSaved < options.minGainTokens) return null;
  return { messages: pruned, prunedCount, tokensSaved };
}

/**
 * 返回第一条可剪消息之后的下标：从最新往前累计 token，第一条撑破 protectTokens
 * 的消息连同更老的都可剪。全部都装得进保护窗口时返回 0。
 *
 * 判定放在累加**之后**：只有真正装得进窗口的消息才受保护。放在累加之前的话，
 * 一条 40k token 的文件读取会因为它前面那条 10 token 的消息还没填满窗口而整条
 * 受保护 —— 而它恰恰是最该剪的那条。
 */
function findProtectBoundary(
  messages: readonly Message[],
  options: PruneOptions,
): number {
  let accumulated = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    accumulated += options.tokenCounter.countMessages([message]);
    if (accumulated > options.protectTokens) return index + 1;
  }
  return 0;
}

/** 已剪过的原样返回；没有可剪正文时也返回原对象，供调用方判断是否真的动了。 */
function pruneToolResult(message: ToolResultMessage): ToolResultMessage {
  if (message.pruned === true) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== 'text') return block;
    const stub = stubText(block.text);
    if (stub === null) return block;
    changed = true;
    return { ...block, text: stub };
  });
  if (!changed) return message;
  return { ...message, content, pruned: true };
}

/**
 * 保留首尾、丢中间。工具输出里最该保留的两段就在两头：开头说明这是什么
 * （文件路径、命令回显），结尾说明它怎么结束的（错误栈末尾、退出状态、
 * 最后几行日志）。只截头部会把后者整段丢掉，而那通常才是模型要看的。
 */
function stubText(text: string): string | null {
  if (text.length <= STUB_MIN_CHARS) return null;
  const lines = text.split('\n');
  const tailStart = Math.max(STUB_HEAD_LINES, lines.length - STUB_TAIL_LINES);
  const omittedLines = tailStart - STUB_HEAD_LINES;

  // 行数限不住单行超长的输出（压缩过的 JSON、base64），再按字符对半切一次。
  const head = lines.slice(0, STUB_HEAD_LINES).join('\n').slice(0, Math.floor(STUB_MAX_CHARS / 2));
  const tailText = lines.slice(tailStart).join('\n');
  const tailBudget = STUB_MAX_CHARS - head.length;
  const tail = tailText.slice(Math.max(0, tailText.length - tailBudget));

  const omittedChars = text.length - head.length - tail.length;
  const marker = `[... 已剪枝：省略 ${omittedLines} 行、${omittedChars} 字符 ...]`;
  const stub = [head, marker, tail].filter((part) => part.length > 0).join('\n');
  // 极端情况下存根可能不比原文短，那就不换 —— 剪枝必须只减不增。
  return stub.length < text.length ? stub : null;
}

/**
 * 清掉老消息的思考块。它对后续推理没有价值，但在开了 reasoning 的本地模型上
 * 体积可以和正文相当。对齐 Claude Code 的 clear_thinking。
 */
function stripThinking(message: AssistantMessage): AssistantMessage {
  if (!message.content.some((block) => block.type === 'thinking')) return message;
  return {
    ...message,
    content: message.content.filter((block) => block.type !== 'thinking'),
  };
}
