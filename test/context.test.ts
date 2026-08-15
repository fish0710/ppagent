import { describe, expect, it } from 'vitest';
import {
  StructuralSummarizer,
  ThresholdCompactPolicy,
  findSafeCompactBoundary,
} from '../src/core/context/compact.js';
import { ContextManager } from '../src/core/context/manager.js';
import { O200kTokenCounter } from '../src/core/context/tokenizer.js';
import type { Message, TraceContext } from '../src/core/types.js';

const counter = new O200kTokenCounter();

describe('context compaction', () => {
  it('uses BPE tokenization instead of a character-count estimate', () => {
    expect(counter.countText('hello world')).toBe(2);
    expect(counter.countText('你好，世界')).toBe(3);
  });

  it('moves the recent-message boundary backward to keep tool pairs together', async () => {
    const messages: Message[] = [
      user(`old task ${'large history '.repeat(40)}`, 1),
      assistantToolCall('call-1', 'read', 2),
      toolResult('call-1', 'read', 3),
      user('recent one', 4),
      user('recent two', 5),
    ];

    // 原始起点是 index 2，恰好落在 toolCall 与 toolResult 中间。
    expect(findSafeCompactBoundary(messages, 3)).toBe(1);
    const policy = compactPolicy(3);
    const result = await policy.compact(
      messages,
      'manual',
      new StructuralSummarizer({ tokenCounter: counter }),
      {
        targetTokens: 30,
        signal: new AbortController().signal,
        trace: TRACE,
      },
    );

    expect(result.messages.slice(1).map((message) => message.role)).toEqual([
      'assistant',
      'toolResult',
      'user',
      'user',
    ]);
    expect(result.messages[1]).toMatchObject({ role: 'assistant' });
    expect(result.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
    });
  });

  it('feeds the old summary into the next summary instead of silently dropping it', async () => {
    const policy = compactPolicy(2);
    const summarizer = new StructuralSummarizer({ tokenCounter: counter });
    const manager = new ContextManager({
      context: {
        messages: [
          user(`task objective ${'detail '.repeat(30)}`, 1),
          user(`history 2 ${'detail '.repeat(30)}`, 2),
          user(`history 3 ${'detail '.repeat(30)}`, 3),
          user(`history 4 ${'detail '.repeat(30)}`, 4),
          user(`recent 5 ${'detail '.repeat(30)}`, 5),
          user(`recent 6 ${'detail '.repeat(30)}`, 6),
        ],
      },
      tokenCounter: counter,
    });
    const execution = {
      policy,
      summarizer,
      signal: new AbortController().signal,
      trace: TRACE,
      targetTokens: 60,
    };

    const first = await manager.compact('manual', execution);
    expect(first).not.toBeNull();
    const firstText = first?.summary.role === 'user' ? first.summary.content : '';
    expect(firstText).toContain('task objective');

    manager.append(
      user(`history 7 ${'detail '.repeat(30)}`, 7),
      user(`history 8 ${'detail '.repeat(30)}`, 8),
      user(`recent 9 ${'detail '.repeat(30)}`, 9),
    );
    const second = await manager.compact('manual', execution);
    expect(second).not.toBeNull();
    const secondText =
      second?.summary.role === 'user' ? second.summary.content : '';
    expect(secondText).toContain('Previous cumulative summary:');
    expect(secondText).toContain('task objective');
    expect(second?.meta.modelCalls).toBe(0);
    expect(manager.previousSummary).toEqual(second?.summary);
  });

  it('triggers on token or memory pressure at the configured thresholds', () => {
    const policy = compactPolicy(2);
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
      policy: compactPolicy(1),
      summarizer: new StructuralSummarizer({ tokenCounter: counter }),
      signal: new AbortController().signal,
      trace: TRACE,
    });

    expect(result).toBeNull();
    expect(manager.context.messages).toEqual(original);
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

function compactPolicy(keepRecentMessages: number): ThresholdCompactPolicy {
  return new ThresholdCompactPolicy({
    config: {
      compactThreshold: 0.8,
      memPressureThreshold: 0.75,
      keepRecentMessages,
    },
    tokenCounter: counter,
  });
}

function user(content: string, timestamp: number): Message {
  return { role: 'user', content, timestamp };
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

function toolResult(id: string, name: string, timestamp: number): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text: 'ok' }],
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
