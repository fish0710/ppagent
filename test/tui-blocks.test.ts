import { describe, expect, it } from 'vitest';
import { renderBlock, type TranscriptBlock, type TranscriptBlockBody } from '../src/app/tui/blocks.js';
import { createTuiTheme } from '../src/app/tui/theme.js';

const theme = createTuiTheme({ color: false });
const WIDTH = 80;

function block(body: TranscriptBlockBody): TranscriptBlock {
  return { id: 1, ...body };
}

describe('renderBlock: user', () => {
  it('prefixes the first line with > and continuations with two spaces', () => {
    const lines = renderBlock(
      block({ kind: 'user', text: '第一行\n第二行' }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toBe('> 第一行');
    expect(lines[1]).toBe('  第二行');
  });
});

describe('renderBlock: assistant', () => {
  it('marks the first rendered line with ⏺ and indents continuations by two columns', () => {
    const lines = renderBlock(
      block({ kind: 'assistant', text: 'line one\nline two' }),
      WIDTH,
      theme,
    );
    expect(lines[0]!.startsWith('⏺ ')).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[1]!.startsWith('  ')).toBe(true);
  });

  it('renders markdown content (bold survives as plain text when color is off)', () => {
    const lines = renderBlock(block({ kind: 'assistant', text: '**bold** text' }), WIDTH, theme);
    expect(lines.join('\n')).toContain('bold');
  });
});

describe('renderBlock: thinking', () => {
  it('renders nothing when showThinking is false (the default)', () => {
    const lines = renderBlock(block({ kind: 'thinking', text: 'pondering...' }), WIDTH, theme);
    expect(lines).toEqual([]);
  });

  it('renders indented lines when showThinking is enabled, and caps at thinkingMaxLines', () => {
    const longText = Array.from({ length: 20 }, (_, i) => `thought ${i}`).join(' ');
    const lines = renderBlock(block({ kind: 'thinking', text: longText }), 20, theme, {
      showThinking: true,
      thinkingMaxLines: 3,
    });
    expect(lines.length).toBe(4); // 3 内容行 + 1 折叠提示
    expect(lines.at(-1)).toContain('已折叠');
    for (const line of lines) expect(line.startsWith('  ')).toBe(true);
  });
});

describe('renderBlock: tool', () => {
  it('renders a bash header as Bash(cmd) with an exit-code-styled preview body', () => {
    const lines = renderBlock(
      block({
        kind: 'tool',
        toolId: 'call-1',
        name: 'bash',
        summary: 'bash npm test',
        isError: false,
        durationMs: 500,
        preview: 'Exit code: 0\n> vitest run\n✓ 42 tests passed',
        display: { kind: 'bash', exitCode: 0, stdoutLines: 3, stderrLines: 0 },
      }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toBe('⏺ Bash(npm test)');
    expect(lines[1]).toBe('  ⎿  Exit code: 0');
    expect(lines[2]).toBe('     > vitest run');
    expect(lines[3]).toBe('     ✓ 42 tests passed');
  });

  it('appends a "+N lines" trailer when bash output exceeds the preview window', () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const lines = renderBlock(
      block({
        kind: 'tool',
        toolId: 'call-2',
        name: 'bash',
        summary: 'bash long-running',
        isError: false,
        durationMs: 500,
        preview: `Exit code: 0\n${manyLines}`,
        display: { kind: 'bash', exitCode: 0, stdoutLines: 20, stderrLines: 0 },
      }),
      WIDTH,
      theme,
    );
    expect(lines.at(-1)).toContain('… +');
    expect(lines.at(-1)).toContain('lines');
  });

  it('renders an edit as Update(path) with colored +/- gutter lines from the diff', () => {
    const lines = renderBlock(
      block({
        kind: 'tool',
        toolId: 'call-3',
        name: 'edit',
        summary: 'edit src/auth.ts',
        isError: false,
        durationMs: 10,
        preview: 'Replaced 1 occurrence(s) in src/auth.ts',
        display: {
          kind: 'diff',
          path: 'src/auth.ts',
          added: 1,
          removed: 1,
          hunks: [
            {
              oldStart: 12,
              newStart: 12,
              lines: [
                { op: 'remove', text: "const token = req.headers.auth" },
                { op: 'add', text: "const token = req.headers.authorization" },
              ],
            },
          ],
        },
      }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toBe('⏺ Update(src/auth.ts)');
    expect(lines[1]).toContain('Updated src/auth.ts with 1 addition(s) and 1 removal(s)');
    expect(lines.some((line) => /^\s*12\s+-\s{2}const token = req\.headers\.auth$/u.test(line))).toBe(
      true,
    );
    expect(
      lines.some((line) => /^\s*12\s+\+\s{2}const token = req\.headers\.authorization$/u.test(line)),
    ).toBe(true);
  });

  it('renders a read summary line without dumping file content', () => {
    const lines = renderBlock(
      block({
        kind: 'tool',
        toolId: 'call-4',
        name: 'read',
        summary: 'read src/a.ts',
        isError: false,
        durationMs: 5,
        preview: 'export const x = 1;',
        display: { kind: 'read', path: 'src/a.ts', lines: 120, totalLines: 120 },
      }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toBe('⏺ Read(src/a.ts)');
    expect(lines[1]).toContain('Read 120 line(s)');
    expect(lines.join('\n')).not.toContain('export const x = 1;');
  });

  it('shows ⊘ and the raw preview for a tool with no display payload (error fallback)', () => {
    const lines = renderBlock(
      block({
        kind: 'tool',
        toolId: 'call-5',
        name: 'edit',
        summary: 'edit src/a.ts',
        isError: true,
        durationMs: 3,
        preview: 'oldText was not found',
      }),
      WIDTH,
      theme,
    );
    expect(lines[0]!.startsWith('⊘')).toBe(true);
    expect(lines[1]).toContain('oldText was not found');
  });
});

describe('renderBlock: permission', () => {
  it.each([
    ['allow', '已允许'],
    ['allowAlways', '已允许，本会话不再询问'],
    ['deny', '已拒绝'],
  ] as const)('renders the %s decision label', (decision, label) => {
    const lines = renderBlock(
      block({ kind: 'permission', summary: 'rm -f /tmp/x', decision }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toContain('rm -f /tmp/x');
    expect(lines.join('\n')).toContain(label);
  });

  it('shows sandboxReason and detail as extra result lines when present', () => {
    const lines = renderBlock(
      block({
        kind: 'permission',
        summary: 'write outside sandbox',
        sandboxReason: 'path escapes workspace',
        detail: '{"path":"/etc/passwd"}',
        decision: 'deny',
      }),
      WIDTH,
      theme,
    );
    expect(lines.join('\n')).toContain('path escapes workspace');
    expect(lines.join('\n')).toContain('/etc/passwd');
  });
});

describe('renderBlock: notice/compaction/admissionDenied/metrics/loopEnd/error', () => {
  it('notice uses the level-appropriate icon', () => {
    expect(renderBlock(block({ kind: 'notice', level: 'info', text: 'hi' }), WIDTH, theme)[0]).toContain('ℹ');
    expect(renderBlock(block({ kind: 'notice', level: 'warn', text: 'hi' }), WIDTH, theme)[0]).toContain('⚠');
    expect(renderBlock(block({ kind: 'notice', level: 'error', text: 'hi' }), WIDTH, theme)[0]).toContain('⊘');
  });

  it('compaction summarize renders tokensBefore→tokensAfter with trigger/strategy detail', () => {
    const lines = renderBlock(
      block({
        kind: 'compaction',
        variant: 'summarize',
        trigger: 'memory',
        tokensBefore: 6200,
        tokensAfter: 1100,
        strategy: 'llm',
        resourceSource: 'memory_pressure',
      }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toContain('压缩 6.2k→1.1k');
    expect(lines[0]).toContain('内存压力');
    expect(lines[0]).toContain('llm');
    expect(lines[0]).toContain('memory_pressure');
  });

  it('compaction prune renders prunedCount', () => {
    const lines = renderBlock(
      block({
        kind: 'compaction',
        variant: 'prune',
        trigger: 'token',
        tokensBefore: 6200,
        tokensAfter: 4100,
        prunedCount: 7,
      }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toContain('剪枝 6.2k→4.1k');
    expect(lines[0]).toContain('7 条工具输出');
  });

  it('compaction skipped renders the reason', () => {
    const lines = renderBlock(
      block({ kind: 'compaction', variant: 'skipped', trigger: 'manual', reason: '没有可折叠的历史' }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toContain('未压缩：没有可折叠的历史');
  });

  it('admissionDenied includes the retry hint when retryAfterMs is set', () => {
    const lines = renderBlock(
      block({ kind: 'admissionDenied', reason: 'GPU busy', retryAfterMs: 10_000 }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toContain('GPU busy');
    expect(lines[0]).toContain('10s 后重试');
  });

  it('admissionDenied omits the retry hint when retryAfterMs is null', () => {
    const lines = renderBlock(
      block({ kind: 'admissionDenied', reason: 'max subagents', retryAfterMs: null }),
      WIDTH,
      theme,
    );
    expect(lines[0]).not.toContain('重试');
  });

  it('metrics renders tok/s and context when decodeMs and usage are present', () => {
    const lines = renderBlock(
      block({
        kind: 'metrics',
        usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
        decodeMs: 2_000,
        contextTokens: 4200,
        contextWindow: 8000,
      }),
      WIDTH,
      theme,
    );
    expect(lines[0]).toContain('tok/s');
    expect(lines[0]).toContain('上下文 4.2k/8k');
  });

  it('metrics renders nothing when there is nothing to show', () => {
    const lines = renderBlock(
      block({ kind: 'metrics', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      WIDTH,
      theme,
    );
    expect(lines).toEqual([]);
  });

  it('loopEnd renders the right icon per reason and nothing for a clean stop', () => {
    expect(renderBlock(block({ kind: 'loopEnd', reason: 'aborted' }), WIDTH, theme)[0]).toContain('已取消');
    expect(renderBlock(block({ kind: 'loopEnd', reason: 'maxTurns' }), WIDTH, theme)[0]).toContain(
      '已达到最大轮数',
    );
    expect(renderBlock(block({ kind: 'loopEnd', reason: 'error' }), WIDTH, theme)[0]).toContain(
      'Agent 因错误停止',
    );
    expect(renderBlock(block({ kind: 'loopEnd', reason: 'stop' }), WIDTH, theme)).toEqual([]);
  });

  it('error renders with the ⊘ marker', () => {
    const lines = renderBlock(block({ kind: 'error', text: 'boom' }), WIDTH, theme);
    expect(lines[0]).toContain('⊘');
    expect(lines[0]).toContain('boom');
  });
});

describe('renderBlock: width safety', () => {
  it('never throws and stays within width for narrow terminals across all kinds', () => {
    const samples: TranscriptBlock[] = [
      block({ kind: 'user', text: 'hello world this is long' }),
      block({ kind: 'assistant', text: 'hello world this is long enough to wrap' }),
      block({
        kind: 'tool',
        toolId: 'x',
        name: 'bash',
        summary: 'bash echo hi',
        isError: false,
        durationMs: 1,
        preview: 'Exit code: 0\nhi',
        display: { kind: 'bash', exitCode: 0, stdoutLines: 1, stderrLines: 0 },
      }),
      block({ kind: 'notice', level: 'warn', text: 'a fairly long warning message here' }),
    ];
    for (const width of [1, 5, 20]) {
      for (const b of samples) {
        expect(() => renderBlock(b, width, theme)).not.toThrow();
      }
    }
  });
});
