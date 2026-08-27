import { describe, expect, it } from 'vitest';
import {
  describeTool,
  formatContext,
  formatDuration,
  formatRate,
  formatTokenCount,
  oneLine,
  sanitizeStreamingText,
  sanitizeToolDisplay,
  segmentMarkdown,
  visibleCharacterCount,
} from '../src/app/tui/format.js';
import type { ToolDisplay } from '../src/core/types.js';

describe('sanitizeStreamingText', () => {
  it('strips ESC and other control characters but keeps newlines', () => {
    const withEscape = `${String.fromCharCode(0x1b)}[31mred${String.fromCharCode(0x1b)}[0m\ntext`;
    expect(sanitizeStreamingText(withEscape)).toBe('[31mred[0m\ntext');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    expect(sanitizeStreamingText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('oneLine', () => {
  it('folds newlines into an arrow marker', () => {
    expect(oneLine('a\nb\nc')).toBe('a ↵ b ↵ c');
  });
});

describe('describeTool', () => {
  it('special-cases bash, path tools and spawn_subagent', () => {
    expect(describeTool('bash', { cmd: 'echo hi' })).toBe('bash echo hi');
    expect(describeTool('read', { path: 'src/a.ts' })).toBe('read src/a.ts');
    expect(describeTool('edit', { path: 'src/a.ts' })).toBe('edit src/a.ts');
    expect(describeTool('spawn_subagent', { task: 'investigate bug' })).toBe(
      '子 agent investigate bug',
    );
  });

  it('falls back to a one-line JSON dump for unknown shapes', () => {
    expect(describeTool('memory_search', { query: 'auth' })).toBe(
      'memory_search {"query":"auth"}',
    );
  });
});

describe('numeric formatters', () => {
  it('formatTokenCount abbreviates thousands and millions', () => {
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(4200)).toBe('4.2k');
    expect(formatTokenCount(1_500_000)).toBe('1.5m');
  });

  it('formatDuration switches from ms to s at one second', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_200)).toBe('1.2s');
  });

  it('formatRate rounds large rates and keeps a decimal for small ones', () => {
    expect(formatRate(1200)).toBe('1.2k');
    expect(formatRate(150)).toBe('150');
    expect(formatRate(12.34)).toBe('12.3');
  });

  it('formatContext renders tokens over window or just tokens', () => {
    expect(formatContext(undefined, 8000)).toBe('');
    expect(formatContext(4200, 8000)).toBe('上下文 4.2k/8k');
    expect(formatContext(4200, undefined)).toBe('上下文 4.2k');
  });
});

describe('visibleCharacterCount', () => {
  it('counts sanitized characters excluding newlines', () => {
    expect(visibleCharacterCount('ab\ncd')).toBe(4);
  });
});

describe('segmentMarkdown', () => {
  it('splits on a blank line into a completed segment and a rest', () => {
    const { segments, rest } = segmentMarkdown('para one\n\npara two still streaming');
    expect(segments).toEqual(['para one']);
    expect(rest).toBe('para two still streaming');
  });

  it('does not split inside an open fenced code block, even across a blank line', () => {
    const buffer =
      'before\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nafter still streaming';
    const { segments, rest } = segmentMarkdown(buffer);
    expect(segments).toEqual(['before', '```js\nconst x = 1;\n\nconst y = 2;\n```']);
    expect(rest).toBe('after still streaming');
  });

  it('does not force a split right after a closing fence with no blank line following', () => {
    // 围栏关闭本身不构成块边界；下一段是否独立取决于它后面是否真的有空行。
    const buffer = 'before\n\n```js\nconst x = 1;\n```\nstill attached, streaming';
    const { segments, rest } = segmentMarkdown(buffer);
    expect(segments).toEqual(['before']);
    expect(rest).toBe('```js\nconst x = 1;\n```\nstill attached, streaming');
  });

  it('keeps an unterminated fence entirely in rest', () => {
    const buffer = 'before\n\n```js\nconst x = 1;\n\nstill open';
    const { segments, rest } = segmentMarkdown(buffer);
    expect(segments).toEqual(['before']);
    expect(rest).toBe('```js\nconst x = 1;\n\nstill open');
  });

  it('returns no segments and the whole buffer as rest when there is no blank line yet', () => {
    const { segments, rest } = segmentMarkdown('still one paragraph, streaming');
    expect(segments).toEqual([]);
    expect(rest).toBe('still one paragraph, streaming');
  });
});

describe('sanitizeToolDisplay', () => {
  it('strips control characters and clips overlong diff lines', () => {
    const longLine = 'x'.repeat(600);
    const display: ToolDisplay = {
      kind: 'diff',
      path: `src/${String.fromCharCode(0x1b)}a.ts`,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [{ op: 'add', text: longLine }],
        },
      ],
      added: 1,
      removed: 0,
    };
    const sanitized = sanitizeToolDisplay(display);
    expect(sanitized.kind).toBe('diff');
    if (sanitized.kind !== 'diff') throw new Error('expected diff');
    expect(sanitized.path).toBe('src/a.ts');
    expect(sanitized.hunks[0]!.lines[0]!.text.length).toBeLessThan(longLine.length);
    expect(sanitized.hunks[0]!.lines[0]!.text.endsWith('…')).toBe(true);
  });

  it('passes bash display through unchanged (no path field to sanitize)', () => {
    const display: ToolDisplay = { kind: 'bash', exitCode: 0, stdoutLines: 1, stderrLines: 0 };
    expect(sanitizeToolDisplay(display)).toEqual(display);
  });
});
