import { describe, expect, it } from 'vitest';
import {
  StructuralSummarizer,
  ThresholdCompactPolicy,
  findCompactBoundary,
} from '../src/core/context/compact.js';
import { ContextManager } from '../src/core/context/manager.js';
import { pruneToolResults } from '../src/core/context/prune.js';
import { O200kTokenCounter } from '../src/core/context/tokenizer.js';
import type {
  CompactResult,
  ContextConfig,
  Message,
  SummarizeRequest,
  Summarizer,
  TraceContext,
} from '../src/core/types.js';

const counter = new O200kTokenCounter();

describe('context compaction', () => {
  it('uses BPE tokenization instead of a character-count estimate', () => {
    expect(counter.countText('hello world')).toBe(2);
    expect(counter.countText('你好，世界')).toBe(3);
  });

  it('moves the token-budget boundary backward to keep tool pairs together', async () => {
    const messages: Message[] = [
      // user 消息不折叠，会整条搬进 carried；插一条 assistant 文本，让折叠区里
      // 还有真正需要摘要压缩的内容，压缩才有收益（否则摘要只是转述这条 user
      // 消息，跟它原样搬进 carried 完全重复，触发 IneffectiveCompactionError）。
      user(`old task ${'large history '.repeat(40)}`, 1),
      assistantText(`sure, looking into it ${'context '.repeat(40)}`, 2),
      assistantToolCall('call-1', 'read', 3),
      toolResult('call-1', 'read', 4),
      user('recent one', 5),
      user('recent two', 6),
    ];

    // 预算刚好覆盖到 index 3，也就是候选切点正好落在 toolResult 上。
    const keepRecentTokens = counter.countMessages(messages.slice(3));
    expect(
      findCompactBoundary(messages, { keepRecentTokens, tokenCounter: counter }),
    ).toBe(2);

    const result = await policyKeeping(keepRecentTokens).compact(
      messages,
      'manual',
      new StructuralSummarizer({ tokenCounter: counter }),
      {
        contextWindow: POLICY_WINDOW,
        previousCarried: [],
        targetTokens: 30,
        signal: new AbortController().signal,
        trace: TRACE,
      },
    );

    expect(result.kind).toBe('summarize');
    // [summary, 保留的 old-task user 消息, assistant(toolCall), toolResult, user, user]。
    expect(result.messages.slice(1).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'user',
      'user',
    ]);
    expect(result.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('old task') });
    expect(result.messages[3]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
    });
  });

  it('prefers the turn start so the retained view opens on a user message', () => {
    const messages: Message[] = [
      user('first task', 1),
      assistantText('working on it', 2),
      user('second task', 3),
      assistantToolCall('call-1', 'read', 4),
      toolResult('call-1', 'read', 5),
      assistantText('done', 6),
    ];

    // 预算只够最后一条，但切点必须退回到本轮的 user 消息。
    const keepRecentTokens = counter.countMessages(messages.slice(5));
    expect(
      findCompactBoundary(messages, { keepRecentTokens, tokenCounter: counter }),
    ).toBe(2);
  });

  it('cuts inside a split turn instead of refusing to compact', () => {
    // 单个 turn 自己就超过保留预算：一轮里读了一堆文件。对齐到 turn 起点会
    // 退到 index 0（无可折叠），此时必须允许切在 turn 内部的 assistant 上。
    const messages: Message[] = [
      user('read everything', 1),
      assistantToolCall('call-1', 'read', 2),
      toolResult('call-1', 'read', 3),
      assistantToolCall('call-2', 'read', 4),
      toolResult('call-2', 'read', 5),
      assistantToolCall('call-3', 'read', 6),
      toolResult('call-3', 'read', 7),
    ];

    const cut = findCompactBoundary(messages, {
      keepRecentTokens: counter.countMessages(messages.slice(5)),
      tokenCounter: counter,
    });

    expect(cut).toBe(5);
    expect(messages[cut]?.role).toBe('assistant');
    // 切点永远不能落在 toolResult 上，否则保留区里会出现孤儿结果。
    expect(messages[cut]?.role).not.toBe('toolResult');
  });

  it('feeds the old summary into the next summary without letting it grow unbounded', async () => {
    const summarizer = new StructuralSummarizer({ tokenCounter: counter });
    // assistant 消息，不是 user：user 消息不折叠，整段历史若全是 user 会被
    // selectCarriedUsers 原样搬进 carried，摘要就没有真正折叠掉任何东西
    // （复述 + 保留一份重复），触发 IneffectiveCompactionError。这里测的是
    // StructuralSummarizer 自身"旧摘要限额一半预算"的行为，跟 user 消息保留
    // 是两回事，用 assistant 消息让折叠路径继续被真正执行到。
    const history = (label: string, timestamp: number): Message => assistantText(
      `${label} ${'detail '.repeat(30)}`,
      timestamp,
    );
    const manager = new ContextManager({
      context: {
        messages: [
          history('task objective', 1),
          history('history 2', 2),
          history('history 3', 3),
          history('history 4', 4),
          history('recent 5', 5),
          history('recent 6', 6),
        ],
      },
      tokenCounter: counter,
    });
    const execution = {
      policy: policyKeeping(counter.countMessages([history('recent 6', 6)]) * 2),
      summarizer,
      contextWindow: POLICY_WINDOW,
      signal: new AbortController().signal,
      trace: TRACE,
      targetTokens: 60,
    };

    const first = await manager.compact('manual', execution);
    expect(first?.kind).toBe('summarize');
    const firstText = summaryText(first?.summary);
    expect(firstText).toContain('task objective');

    manager.append(history('history 7', 7), history('history 8', 8), history('recent 9', 9));
    const second = await manager.compact('manual', execution);
    expect(second?.kind).toBe('summarize');
    const secondText = summaryText(second?.summary);
    expect(secondText).toContain('Previous cumulative summary:');
    expect(secondText).toContain('task objective');
    expect(second?.meta?.modelCalls).toBe(0);
    expect(manager.previousSummary).toEqual(second?.summary);

    // 旧摘要限额一半预算，所以累积摘要不会逐次膨胀吃光整个预算。
    expect(counter.countText(secondText)).toBeLessThanOrEqual(60);
  });

  it('triggers on token or memory pressure at the configured thresholds', () => {
    const policy = policyKeeping(50);
    expect(policy.shouldCompact({ tokenUsage: 79, contextWindow: 100 })).toBeNull();
    expect(policy.shouldCompact({ tokenUsage: 80, contextWindow: 100 })).toBe('token');
    expect(
      policy.shouldCompact({
        tokenUsage: 1,
        contextWindow: 100,
        resource: resourceSnapshot(0.75),
      }),
    ).toBe('memory');
  });

  it('keeps the original view when a short-history summary would be larger', async () => {
    const original = [user('short old message', 1), user('recent', 2)];
    const manager = new ContextManager({
      context: { messages: original },
      tokenCounter: counter,
    });
    const result = await manager.compact('manual', {
      policy: policyKeeping(1),
      summarizer: new StructuralSummarizer({ tokenCounter: counter }),
      contextWindow: POLICY_WINDOW,
      signal: new AbortController().signal,
      trace: TRACE,
    });

    expect(result).toBeNull();
    expect(manager.context.messages).toEqual(original);
  });

  it('stops at pruning when that already frees enough room', async () => {
    const noise = 'x'.repeat(4_000);
    const messages: Message[] = [
      user('read the logs', 1),
      assistantToolCall('call-1', 'bash', 2),
      toolResult('call-1', 'bash', 3, noise),
      assistantToolCall('call-2', 'bash', 4),
      toolResult('call-2', 'bash', 5, noise),
      user('what went wrong?', 6),
    ];
    const manager = new ContextManager({
      context: { messages },
      tokenCounter: counter,
    });

    const result = await manager.compact('manual', {
      policy: policyKeeping(counter.countMessages(messages.slice(5)), {
        pruneMinTokens: 100,
        maxTrackedFiles: 80,
        keepUserRatio: 0.1,
      }),
      summarizer: failingSummarizer(),
      contextWindow: POLICY_WINDOW,
      signal: new AbortController().signal,
      trace: TRACE,
    });

    expect(result?.kind).toBe('prune');
    expect(result?.prunedCount).toBe(2);
    expect(result?.tokensAfter).toBeLessThan(result?.tokensBefore ?? 0);
    // 剪枝不动结构：条数、角色顺序、调用配对全部保持原样。
    expect(result?.messages.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    // 没有摘要，覆盖点没有前移。
    expect(result?.summary).toBeUndefined();
    expect(manager.previousSummary).toBeUndefined();
  });

  it('summarizes with the pristine tail, then prunes it — not the other way around', async () => {
    // "old task..." 是 assistant 消息正文（不是 user——user 消息不折叠会整条
    // 搬进 carried，这里要测的是折叠路径本身，跟 user 保留是两回事），剪枝
    // 根本碰不到它；把它撑得足够大，就能让 pass-1（剪完整个 messages）的
    // tokensAfter 依然超过阈值，逼着 pass-1 的结果被丢弃、落到摘要路径 ——
    // 这正是要覆盖的分支。
    const bigImmuneText = `old task ${'detail '.repeat(600)}`;
    const noise = 'x'.repeat(4_000);
    const messages: Message[] = [
      assistantText(bigImmuneText, 1),
      assistantToolCall('call-1', 'bash', 2),
      toolResult('call-1', 'bash', 3, noise),
      user('recent question', 4),
      assistantText('recent answer', 5),
    ];

    const contextWindow = 100_000;
    const keepRecentTokens = counter.countMessages(messages.slice(1));
    const protectTokens = counter.countMessages(messages.slice(3)) + 1;
    const pruneMinTokens = 100;

    // 不猜数字：直接量出 pass-1 剪完整个数组后还剩多少 token，
    // 再反推一个刚好逼出 fall-through 的阈值。
    const passOnePruned = pruneToolResults(messages, {
      protectTokens,
      minGainTokens: pruneMinTokens,
      tokenCounter: counter,
    });
    expect(passOnePruned).not.toBeNull();
    const tokensAfterPassOne = counter.countMessages(passOnePruned!.messages);
    const compactThreshold = (tokensAfterPassOne - 1) / contextWindow;
    const keepRecentRatio = (keepRecentTokens + 0.5) / contextWindow;
    // 前提：这个 fixture 确实能逼出 fall-through，否则下面测的就不是 E 想覆盖的分支。
    expect(keepRecentRatio).toBeLessThan(compactThreshold);

    const policy = new ThresholdCompactPolicy({
      config: {
        compactThreshold,
        memPressureThreshold: 0.75,
        keepRecentRatio,
        summaryMaxTokens: 500,
        pruneProtectRatio: protectTokens / contextWindow,
        pruneMinTokens,
        maxTrackedFiles: 80,
        keepUserRatio: 0.1,
      },
      tokenCounter: counter,
    });

    const captured: SummarizeRequest[] = [];
    const capturingSummarizer: Summarizer = {
      id: 'capture',
      async summarize(request) {
        captured.push(request);
        return new StructuralSummarizer({ tokenCounter: counter }).summarize(request);
      },
    };

    const manager = new ContextManager({ context: { messages }, tokenCounter: counter });
    const result = await manager.compact('manual', {
      policy,
      summarizer: capturingSummarizer,
      contextWindow,
      signal: new AbortController().signal,
      trace: TRACE,
      targetTokens: 500,
    });

    expect(result?.kind).toBe('summarize');
    expect(captured).toHaveLength(1);

    // 模型看到的 retained 必须是压缩前的原文 —— 前缀缓存要求逐字节相同，
    // 摘要调用绝不能用已经被剪过的版本。
    const sentToolResult = captured[0]?.retained?.find(
      (message): message is Extract<Message, { role: 'toolResult' }> =>
        message.role === 'toolResult',
    );
    expect(sentToolResult?.pruned).toBeUndefined();
    expect(sentToolResult?.content[0]).toMatchObject({ type: 'text', text: noise });

    // 但摘要拿到结果之后，最终落进 result.messages 的保留尾巴已经被剪过了。
    const finalToolResult = result?.messages.find(
      (message): message is Extract<Message, { role: 'toolResult' }> =>
        message.role === 'toolResult',
    );
    expect(finalToolResult?.pruned).toBe(true);
    expect(result?.prunedCount).toBe(1);
  });

  it('does not let synthetic user messages (summaries, continuation prompts) leak into carried', async () => {
    const messages: Message[] = [
      user('real constraint: no new deps', 1),
      { role: 'user', content: 'fake synthetic content', timestamp: 2, synthetic: true },
      assistantText(`working on it ${'padding '.repeat(200)}`, 3),
      user('recent', 4),
      assistantText('recent reply', 5),
    ];
    const manager = new ContextManager({ context: { messages }, tokenCounter: counter });
    const result = await manager.compact('manual', {
      policy: policyKeeping(counter.countMessages(messages.slice(3))),
      summarizer: new StructuralSummarizer({ tokenCounter: counter }),
      contextWindow: POLICY_WINDOW,
      signal: new AbortController().signal,
      trace: TRACE,
      targetTokens: 200,
    });

    expect(result?.kind).toBe('summarize');
    const carried = carriedFrom(result);
    expect(carried).toContain('real constraint: no new deps');
    expect(carried).not.toContain('fake synthetic content');
  });

  it('keeps carried user messages byte-identical and in original relative order', async () => {
    const messages: Message[] = [
      user('first constraint', 1),
      assistantText('ack 1', 2),
      user('second constraint', 3),
      assistantText(`ack 2 ${'padding '.repeat(100)}`, 4),
      user('recent', 5),
      assistantText('recent reply', 6),
    ];
    const manager = new ContextManager({ context: { messages }, tokenCounter: counter });
    const result = await manager.compact('manual', {
      policy: policyKeeping(counter.countMessages(messages.slice(4))),
      summarizer: new StructuralSummarizer({ tokenCounter: counter }),
      contextWindow: POLICY_WINDOW,
      signal: new AbortController().signal,
      trace: TRACE,
      targetTokens: 200,
    });

    expect(result?.kind).toBe('summarize');
    // 旧到新，逐字节等于原消息 —— 不是模型转述出来的近似内容。
    expect(carriedFrom(result)).toEqual(['first constraint', 'second constraint']);
  });

  it('evicts the oldest carried user messages first when the budget is exceeded', async () => {
    const big = 'detail '.repeat(200);
    const messages: Message[] = [
      user(`old-1 ${big}`, 1),
      user(`old-2 ${big}`, 2),
      user(`old-3 ${big}`, 3),
      assistantText(`filler ${big}`, 4),
      user('recent', 5),
      assistantText('recent reply', 6),
    ];
    // 预算只够装下最后一条 old-N；更老的两条必须被淘汰，而不是随机丢或全丢。
    const keepUserTokens = counter.countMessages([user(`old-3 ${big}`, 3)]) + 5;
    const manager = new ContextManager({ context: { messages }, tokenCounter: counter });
    const result = await manager.compact('manual', {
      policy: policyKeeping(counter.countMessages(messages.slice(4)), {
        keepUserRatio: keepUserTokens / POLICY_WINDOW,
      }),
      summarizer: new StructuralSummarizer({ tokenCounter: counter }),
      contextWindow: POLICY_WINDOW,
      signal: new AbortController().signal,
      trace: TRACE,
      targetTokens: 200,
    });

    expect(result?.kind).toBe('summarize');
    const carried = carriedFrom(result);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toContain('old-3');
  });

  it('does not re-fold the carried block on a second compaction', async () => {
    const messages: Message[] = [
      user('keep me forever', 1),
      assistantText(`ack ${'padding '.repeat(80)}`, 2),
      user('turn 2', 3),
      assistantText('reply 2', 4),
    ];
    const manager = new ContextManager({ context: { messages }, tokenCounter: counter });
    const captured: SummarizeRequest[] = [];
    const capturingSummarizer: Summarizer = {
      id: 'capture',
      async summarize(request) {
        captured.push(request);
        return new StructuralSummarizer({ tokenCounter: counter }).summarize(request);
      },
    };
    const execution = {
      policy: policyKeeping(counter.countMessages(messages.slice(2))),
      summarizer: capturingSummarizer,
      contextWindow: POLICY_WINDOW,
      signal: new AbortController().signal,
      trace: TRACE,
      // StructuralSummarizer 不做语义压缩，只在 targetTokens 逼出截断时才真的
      // 变小；这里故意收紧预算，确保折叠确实有收益（不然 IneffectiveCompactionError）。
      targetTokens: 30,
    };

    const first = await manager.compact('manual', execution);
    expect(first?.kind).toBe('summarize');
    expect(textsOf(captured[0]?.messages ?? [])).toContain('keep me forever');
    expect(carriedFrom(first)).toContain('keep me forever');
    expect(textsOf(manager.previousCarried)).toContain('keep me forever');

    manager.append(
      user('turn 3', 5),
      assistantText(`reply 3 ${'padding '.repeat(80)}`, 6),
      user('turn 4', 7),
      assistantText('reply 4', 8),
    );
    const second = await manager.compact('manual', execution);
    expect(second?.kind).toBe('summarize');

    // 已经保留过的那条不能再出现在这一轮要折叠的批次里 —— 它已经处理过了；
    // 切点搜索必须把它当头部保护区跳过，而不是把它当新历史重新折叠一遍。
    expect(textsOf(captured[1]?.messages ?? [])).not.toContain('keep me forever');
    // 但它仍然要出现在请求前缀里（通过 carried 字段），保证前缀缓存命中。
    expect(textsOf(captured[1]?.carried ?? [])).toContain('keep me forever');
    // 压缩结果里它也还在（budget 允许的情况下持续存活）。
    expect(carriedFrom(second)).toContain('keep me forever');
  });

  it('does not leak mutable summary or final-context references', async () => {
    const summary = user('cumulative facts', 1);
    const manager = new ContextManager({
      context: { messages: [summary, user('recent', 2)] },
      tokenCounter: counter,
      previousSummary: summary,
    });

    const exposedSummary = manager.previousSummary;
    if (exposedSummary?.role === 'user') exposedSummary.content = 'tampered';
    const snapshot = manager.snapshot();
    snapshot.messages.push(user('outside mutation', 3));

    expect(manager.previousSummary).toEqual(summary);
    expect(manager.context.messages).toHaveLength(2);
  });
});

/** 保留预算按 token 给定；用大窗口换算成比例，避免取整误差。 */
function policyKeeping(
  keepRecentTokens: number,
  overrides: Partial<ContextConfig> = {},
): ThresholdCompactPolicy {
  return new ThresholdCompactPolicy({
    config: {
      compactThreshold: 0.8,
      memPressureThreshold: 0.75,
      keepRecentRatio: (keepRecentTokens + 0.5) / POLICY_WINDOW,
      summaryMaxTokens: 2_048,
      pruneProtectRatio: (keepRecentTokens + 0.5) / POLICY_WINDOW,
      pruneMinTokens: 2_048,
      maxTrackedFiles: 80,
      keepUserRatio: 0.1,
      ...overrides,
    },
    tokenCounter: counter,
  });
}

/** 折算保留预算用的固定窗口；测试里所有 compact 调用都传它。 */
const POLICY_WINDOW = 100_000;

/** 走到摘要层就说明剪枝没有短路成功，直接让测试失败。 */
function failingSummarizer() {
  return {
    id: 'must-not-run',
    summarize(): never {
      throw new Error('summarizer must not run when pruning is enough');
    },
  };
}

function summaryText(message: Message | undefined): string {
  return message?.role === 'user' && typeof message.content === 'string'
    ? message.content
    : '';
}

/** result.messages 里 [summary, ...carried, ...retained] 的 carried 段，取文本。 */
function carriedFrom(result: CompactResult | null): string[] {
  const count = result?.keptUserIndices?.length ?? 0;
  return textsOf(result?.messages.slice(1, 1 + count) ?? []);
}

function textsOf(messages: readonly Message[]): string[] {
  return messages
    .filter((message): message is Message & { role: 'user' } => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

function user(content: string, timestamp: number): Message {
  return { role: 'user', content, timestamp };
}

function assistantText(text: string, timestamp: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    timestamp,
  };
}

function assistantToolCall(
  id: string,
  name: string,
  timestamp: number,
): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: { path: 'x' } }],
    stopReason: 'toolUse',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    timestamp,
  };
}

function toolResult(
  id: string,
  name: string,
  timestamp: number,
  text = 'ok',
): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  };
}

function resourceSnapshot(memPressure: number) {
  return {
    source: 'test' as const,
    memAvailableMB: 25,
    memPressure,
    gpuBusy: false,
    activeSubagents: 0,
    sampledAt: 1,
  };
}

const TRACE: TraceContext = {
  traceId: 'trace',
  spanId: 'span',
  child(name) {
    return { ...this, spanId: name };
  },
};
