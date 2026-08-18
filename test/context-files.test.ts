import { describe, expect, it } from 'vitest';
import {
  extractFileOperations,
  formatFileOperations,
} from '../src/core/context/files.js';
import type { Message } from '../src/core/types.js';

describe('file operation extraction', () => {
  it('sorts read/write/edit calls into readFiles vs modifiedFiles', () => {
    const messages: Message[] = [
      assistantToolCall('read', { path: 'src/a.ts' }),
      assistantToolCall('read', { path: 'src/b.ts' }),
      assistantToolCall('write', { path: 'src/c.ts', content: 'x' }),
      assistantToolCall('edit', { path: 'src/d.ts', oldText: 'x', newText: 'y' }),
    ];
    const result = extractFileOperations(messages, { maxFiles: 100 });
    expect(result.readFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.modifiedFiles).toEqual(['src/c.ts', 'src/d.ts']);
  });

  it('classifies a file that was read then modified as modified only', () => {
    const messages: Message[] = [
      assistantToolCall('read', { path: 'src/a.ts' }),
      assistantToolCall('edit', { path: 'src/a.ts', oldText: 'x', newText: 'y' }),
    ];
    const result = extractFileOperations(messages, { maxFiles: 100 });
    expect(result.readFiles).toEqual([]);
    expect(result.modifiedFiles).toEqual(['src/a.ts']);
  });

  it('merges with the previous list and de-duplicates across compactions', () => {
    const first = extractFileOperations(
      [assistantToolCall('read', { path: 'src/a.ts' })],
      { maxFiles: 100 },
    );
    const second = extractFileOperations(
      [
        assistantToolCall('read', { path: 'src/a.ts' }),
        assistantToolCall('read', { path: 'src/b.ts' }),
      ],
      { previous: first, maxFiles: 100 },
    );
    // 早期文件不因为跨了一次压缩就消失，且不重复。
    expect(second.readFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('promotes an already-read file to modified when a later compaction edits it', () => {
    const first = extractFileOperations(
      [assistantToolCall('read', { path: 'src/a.ts' })],
      { maxFiles: 100 },
    );
    const second = extractFileOperations(
      [assistantToolCall('edit', { path: 'src/a.ts', oldText: 'x', newText: 'y' })],
      { previous: first, maxFiles: 100 },
    );
    expect(second.readFiles).toEqual([]);
    expect(second.modifiedFiles).toEqual(['src/a.ts']);
  });

  it('drops the oldest read entries first when over budget, keeping modified intact', () => {
    const messages: Message[] = [
      assistantToolCall('read', { path: 'src/old.ts' }),
      assistantToolCall('read', { path: 'src/mid.ts' }),
      assistantToolCall('read', { path: 'src/new.ts' }),
      assistantToolCall('write', { path: 'src/keep-1.ts', content: 'x' }),
      assistantToolCall('write', { path: 'src/keep-2.ts', content: 'x' }),
    ];
    const result = extractFileOperations(messages, { maxFiles: 3 });
    expect(result.modifiedFiles).toEqual(['src/keep-1.ts', 'src/keep-2.ts']);
    expect(result.readFiles).toEqual(['src/new.ts']);
    expect(result.omittedCount).toBe(2);
  });

  it('accumulates omittedCount across compactions instead of resetting it', () => {
    const first = extractFileOperations(
      [
        assistantToolCall('read', { path: 'a' }),
        assistantToolCall('read', { path: 'b' }),
      ],
      { maxFiles: 1 },
    );
    expect(first.omittedCount).toBe(1);
    const second = extractFileOperations(
      [
        assistantToolCall('read', { path: 'c' }),
        assistantToolCall('read', { path: 'd' }),
      ],
      { previous: first, maxFiles: 1 },
    );
    expect(second.omittedCount).toBeGreaterThan(1);
  });

  it('ignores tool calls without a path argument and non-file tools', () => {
    const messages: Message[] = [
      assistantToolCall('bash', { command: 'ls' }),
      assistantToolCall('read', {}),
      assistantToolCall('spawn_subagent', { task: 'x' }),
    ];
    const result = extractFileOperations(messages, { maxFiles: 100 });
    expect(result.readFiles).toEqual([]);
    expect(result.modifiedFiles).toEqual([]);
  });

  it('never lets the crafted block claim files were untouched', () => {
    const messages: Message[] = [assistantToolCall('read', { path: 'src/a.ts' })];
    const result = extractFileOperations(messages, { maxFiles: 100 });
    expect(formatFileOperations(result)).toContain('src/a.ts');
  });
});

describe('formatFileOperations', () => {
  it('renders empty operations as an empty string, not empty tags', () => {
    expect(formatFileOperations({ readFiles: [], modifiedFiles: [] })).toBe('');
  });

  it('flags omitted entries so the list does not read as exhaustive', () => {
    const text = formatFileOperations({
      readFiles: ['a'],
      modifiedFiles: [],
      omittedCount: 5,
    });
    expect(text).toContain('5');
    expect(text).toContain('files-omitted');
  });
});

let nextTimestamp = 1;

function assistantToolCall(name: string, args: unknown): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: `call-${nextTimestamp}`, name, arguments: args }],
    stopReason: 'toolUse',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    timestamp: nextTimestamp++,
  };
}
