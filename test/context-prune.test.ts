import { describe, expect, it } from 'vitest';
import { pruneToolResults } from '../src/core/context/prune.js';
import { O200kTokenCounter } from '../src/core/context/tokenizer.js';
import type { Message } from '../src/core/types.js';

const counter = new O200kTokenCounter();
const NOISE = Array.from({ length: 200 }, (_, line) => `line ${line} padding`).join('\n');

describe('tool result pruning', () => {
  it('leaves everything at or after the boundary untouched', () => {
    const messages = conversation();
    const result = pruneToolResults(messages, {
      protectTokens: counter.countMessages(conversation().slice(3)),
      minGainTokens: 1,
      tokenCounter: counter,
    });

    expect(result).not.toBeNull();
    expect(result?.messages.slice(3)).toEqual(messages.slice(3));
    expect(result?.prunedCount).toBe(1);
  });

  it('keeps head and tail of the pruned body, not just the head', () => {
    const messages = conversation();
    const result = pruneToolResults(messages, {
      protectTokens: 1,
      minGainTokens: 1,
      tokenCounter: counter,
    });

    const pruned = result?.messages[2];
    const text = pruned?.role === 'toolResult' ? blockText(pruned) : '';
    expect(text).toContain('line 0 padding');
    // 尾部才是工具输出里最该保留的部分 —— 报错栈末尾、退出状态、最后几行日志。
    expect(text).toContain('line 199 padding');
    expect(text).toContain('已剪枝');
    expect(text.length).toBeLessThan(NOISE.length);
  });

  it('preserves message count, role order and tool-call pairing', () => {
    const messages = conversation();
    const result = pruneToolResults(messages, {
      protectTokens: 1,
      minGainTokens: 1,
      tokenCounter: counter,
    });

    expect(result?.messages).toHaveLength(messages.length);
    expect(result?.messages.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    expect(toolCallIds(result?.messages ?? [])).toEqual(toolCallIds(messages));
    expect(toolResultIds(result?.messages ?? [])).toEqual(toolResultIds(messages));
  });

  it('keeps the tool call trail intact while dropping stale thinking', () => {
    const messages = conversation();
    const result = pruneToolResults(messages, {
      protectTokens: 1,
      minGainTokens: 1,
      tokenCounter: counter,
    });

    const assistant = result?.messages[1];
    expect(assistant?.role).toBe('assistant');
    const blocks = assistant?.role === 'assistant' ? assistant.content : [];
    // toolCall 是 agent 的行动轨迹，最不该丢；thinking 对后续推理没有价值。
    expect(blocks.map((block) => block.type)).toEqual(['toolCall']);
  });

  it('declines to prune when the gain is not worth invalidating the prefix cache', () => {
    const messages = conversation();
    expect(
      pruneToolResults(messages, {
        protectTokens: 1,
        minGainTokens: 1_000_000,
        tokenCounter: counter,
      }),
    ).toBeNull();
  });

  it('declines when there is nothing before the boundary', () => {
    expect(
      pruneToolResults(conversation(), {
        protectTokens: 10_000_000,
        minGainTokens: 1,
        tokenCounter: counter,
      }),
    ).toBeNull();
  });

  it('is idempotent — a second pass finds nothing left to prune', () => {
    const first = pruneToolResults(conversation(), {
      protectTokens: 1,
      minGainTokens: 1,
      tokenCounter: counter,
    });
    expect(first).not.toBeNull();

    const second = pruneToolResults(first?.messages ?? [], {
      protectTokens: 1,
      minGainTokens: 1,
      tokenCounter: counter,
    });
    expect(second).toBeNull();
  });

  it('does not touch short tool results', () => {
    const messages: Message[] = [
      user('go', 1),
      assistantToolCall('call-1', 2),
      toolResult('call-1', 3, 'exit 0'),
      user('thanks', 4),
    ];
    expect(
      pruneToolResults(messages, {
        protectTokens: 1,
        minGainTokens: 1,
        tokenCounter: counter,
      }),
    ).toBeNull();
  });
});

function conversation(): Message[] {
  return [
    user('read the logs', 1),
    assistantToolCall('call-1', 2, true),
    toolResult('call-1', 3, NOISE),
    assistantToolCall('call-2', 4),
    toolResult('call-2', 5, NOISE),
    user('what went wrong?', 6),
  ];
}

function blockText(message: Extract<Message, { role: 'toolResult' }>): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
}

function toolCallIds(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.flatMap((block) =>
          block.type === 'toolCall' ? [block.id] : [],
        )
      : [],
  );
}

function toolResultIds(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'toolResult' ? [message.toolCallId] : [],
  );
}

function user(content: string, timestamp: number): Message {
  return { role: 'user', content, timestamp };
}

function assistantToolCall(
  id: string,
  timestamp: number,
  withThinking = false,
): Message {
  return {
    role: 'assistant',
    content: [
      ...(withThinking
        ? [{ type: 'thinking' as const, thinking: 'let me check the logs' }]
        : []),
      { type: 'toolCall' as const, id, name: 'bash', arguments: { command: 'cat log' } },
    ],
    stopReason: 'toolUse',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    timestamp,
  };
}

function toolResult(id: string, timestamp: number, text: string): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  };
}
