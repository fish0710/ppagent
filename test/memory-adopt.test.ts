import { describe, expect, it } from 'vitest';
import { detectAdoption } from '../src/core/memory/adopt.js';
import type { Message, MemoryRecord } from '../src/core/types.js';

describe('detectAdoption', () => {
  it('marks a record adopted when its path appears in a tool call argument', () => {
    const records = [record({ id: 'm1', text: 'always check src/core/context/manager.ts first' })];
    const messages: Message[] = [
      assistantToolCall('read', { path: 'src/core/context/manager.ts' }),
    ];
    expect(detectAdoption(records, messages)).toEqual([{ memoryId: 'm1', adopted: true }]);
  });

  it('marks a record adopted when its identifier appears in assistant text', () => {
    const records = [record({ id: 'm1', text: 'set PPAGENT_MEMORY_ENABLED=true before testing' })];
    const messages: Message[] = [assistantText("I'll set PPAGENT_MEMORY_ENABLED=true and rerun")];
    expect(detectAdoption(records, messages)).toEqual([{ memoryId: 'm1', adopted: true }]);
  });

  it('does not mark a record adopted when nothing distinctive from it appears anywhere', () => {
    const records = [record({ id: 'm1', text: 'always check src/core/context/manager.ts first' })];
    const messages: Message[] = [assistantText('done, everything looks good')];
    expect(detectAdoption(records, messages)).toEqual([{ memoryId: 'm1', adopted: false }]);
  });

  it('ignores plain English words as distinctive tokens (would be pure noise)', () => {
    const records = [record({ id: 'm1', text: 'always verify the changes before committing' })];
    const messages: Message[] = [assistantText('I always verify changes before committing too')];
    // 全是英文单词，没有一个 token 含路径分隔符/点号/下划线/数字——不应判定为采纳。
    expect(detectAdoption(records, messages)).toEqual([{ memoryId: 'm1', adopted: false }]);
  });

  it('only scans assistant-authored content, not user or tool-result messages', () => {
    const records = [record({ id: 'm1', text: 'check src/core/context/manager.ts' })];
    const messages: Message[] = [
      { role: 'user', content: 'please read src/core/context/manager.ts', timestamp: 1 },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'read',
        content: [{ type: 'text', text: 'src/core/context/manager.ts contents...' }],
        isError: false,
        timestamp: 2,
      },
    ];
    expect(detectAdoption(records, messages)).toEqual([{ memoryId: 'm1', adopted: false }]);
  });

  it('evaluates each record independently and preserves input order', () => {
    const records = [
      record({ id: 'adopted-one', text: 'touch src/core/types.ts' }),
      record({ id: 'not-adopted', text: 'touch src/agent/session.ts' }),
    ];
    const messages: Message[] = [assistantToolCall('edit', { path: 'src/core/types.ts' })];
    expect(detectAdoption(records, messages)).toEqual([
      { memoryId: 'adopted-one', adopted: true },
      { memoryId: 'not-adopted', adopted: false },
    ]);
  });

  it('returns an empty array for an empty record list', () => {
    expect(detectAdoption([], [assistantText('anything')])).toEqual([]);
  });
});

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm1',
    scope: 'project',
    kind: 'fact',
    text: 'placeholder',
    projectKey: 'proj',
    sourceSessionId: 'session-1',
    createdAt: 0,
    updatedAt: 0,
    status: 'active',
    exposure: 0,
    adopted: 0,
    adoptedOk: 0,
    adoptedBad: 0,
    ...overrides,
  };
}

function assistantText(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    timestamp: 1,
  };
}

function assistantToolCall(name: string, args: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 't1', name, arguments: args }],
    stopReason: 'toolUse',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    timestamp: 1,
  };
}
