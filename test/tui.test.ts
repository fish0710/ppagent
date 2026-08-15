import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UIEvent } from '../src/core/types.js';
import {
  TuiTerminalRenderer,
  clipTailToWidth,
  clipToWidth,
  createInitialTuiState,
  decideTuiInterrupt,
  readConfirmationKey,
  reduceTuiState,
  renderTuiFrame,
  stringWidth,
  type TuiState,
} from '../src/app/tui/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

describe('TUI pure reducer and renderer', () => {
  it('replays an NDJSON fixture without owning agent state', () => {
    const events = readFileSync(
      join(ROOT, 'fixtures', 'tui', 'tool-heavy.ndjson'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as UIEvent);
    let state = createInitialTuiState();
    let now = 0;
    const frames: ReturnType<typeof renderTuiFrame>[] = [];
    for (const event of events) {
      now += 500;
      state = reduceTuiState(state, event, now);
      frames.push(renderTuiFrame(state, 80, now));
    }

    expect(state.phase).toBe('idle');
    expect(state.pendingText).toBe('');
    expect(state.contextTokens).toBe(1100);
    expect(state.transcript).toContain('我先看一下现有实现。');
    expect(state.transcript).toContain('⏺ read src/auth.ts 1.2s');
    expect(state.transcript).toContain('? rm -f /tmp/test.txt');
    expect(state.transcript).toContain('  → 已拒绝');
    expect(state.transcript).toContain(
      '⊘ bash rm -f /tmp/test.txt 10ms — User denied tool execution.',
    );
    expect(state.transcript).toContain(
      '⟳ 压缩 6.2k→1.1k（内存压力 · memory_pressure）',
    );
    expect(state.transcript).toContain(
      '⊘ 子 agent 被拒：GPU busy，建议 10s 后重试',
    );
    expect(frames.some((frame) => frame.live.some((line) => line.includes('decode ~'))))
      .toBe(true);
    expect(frames.some((frame) => frame.live.includes('? 允许执行？按 y 允许，n 拒绝')))
      .toBe(true);
  });

  it('shows long silent prefill and exact context size', () => {
    const state = reduceTuiState(
      createInitialTuiState(),
      { type: 'turn_start', turn: 1, contextTokens: 4200, contextWindow: 8000 },
      1_000,
    );
    const frame = renderTuiFrame(state, 80, 7_000);
    expect(frame.live[0]).toContain('prefill 4.2k tokens · 已 6s');
  });

  it('commits partial text before permission confirmation', () => {
    let state = reduceTuiState(
      createInitialTuiState(),
      { type: 'turn_start', turn: 1 },
      0,
    );
    state = reduceTuiState(state, { type: 'text_delta', delta: '尚未换行' }, 100);
    state = reduceTuiState(
      state,
      {
        type: 'permission_request',
        req: { toolName: 'bash', summary: 'rm -f /tmp/x' },
      },
      200,
    );
    expect(state.pendingText).toBe('');
    expect(state.transcript.slice(-2)).toEqual(['尚未换行', '? rm -f /tmp/x']);
    expect(state.phase).toBe('confirming');
  });

  it('neutralizes terminal control characters from model text', () => {
    const state = reduceTuiState(
      createInitialTuiState(),
      { type: 'text_delta', delta: '\u001b[31mred\n' },
      0,
    );
    expect(state.transcript[0]).toBe('[31mred');
    expect(state.transcript[0]).not.toContain('\u001b');
  });
});

describe('TUI terminal edge', () => {
  it('keeps the two-level Ctrl+C contract explicit', () => {
    expect(decideTuiInterrupt(false, Number.NEGATIVE_INFINITY, 1_000)).toBe('exit');
    expect(decideTuiInterrupt(true, Number.NEGATIVE_INFINITY, 1_000)).toBe('abort');
    expect(decideTuiInterrupt(true, 1_000, 2_400)).toBe('abortAndExit');
    expect(decideTuiInterrupt(true, 1_000, 2_501)).toBe('abort');
  });

  it('handles CJK and emoji widths without splitting graphemes', () => {
    expect(stringWidth('中a🙂')).toBe(5);
    expect(clipToWidth('中文abc', 5)).toBe('中文…');
    expect(stringWidth(clipToWidth('中文abc', 5))).toBeLessThanOrEqual(5);
    expect(clipTailToWidth('abc中文', 5)).toBe('…中文');
    expect(stringWidth(clipTailToWidth('abc中文', 5))).toBeLessThanOrEqual(5);
    expect(clipToWidth('👨‍👩‍👧‍👦abc', 4)).toBe('👨‍👩‍👧‍👦a…');
  });

  it('only redraws the bounded live region and never enters alternate screen', () => {
    const output = captureWritable();
    let now = 1_000;
    const renderer = new TuiTerminalRenderer({
      output: output.stream,
      now: () => now,
      width: () => 40,
    });
    renderer.render({
      type: 'turn_start',
      turn: 1,
      contextTokens: 100,
      contextWindow: 1000,
    });
    now += 500;
    renderer.render({ type: 'text_delta', delta: 'hello' });
    now += 500;
    renderer.render({ type: 'text_delta', delta: ' world\n' });
    renderer.finish();

    expect(output.text()).toContain('hello world\n');
    expect(output.text()).toContain('\u001b[');
    expect(output.text()).toContain('\u001b[0J');
    expect(output.text()).not.toContain('?1049');
    expect(output.text().match(/hello world\n/gu)).toHaveLength(1);
  });

  it('falls back to 80 columns when a pseudo TTY reports zero columns', () => {
    const output = captureWritable();
    Object.assign(output.stream, { columns: 0 });
    const renderer = new TuiTerminalRenderer({ output: output.stream, now: () => 6_000 });
    renderer.render({
      type: 'turn_start',
      turn: 1,
      contextTokens: 4200,
      contextWindow: 8000,
    });
    expect(output.text()).toContain('prefill 4.2k tokens');
  });

  it('reads y/n as one raw key and restores terminal mode', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
    };
    const modes: boolean[] = [];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => {
      modes.push(mode);
      input.isRaw = mode;
    };
    input.pause();
    const decision = readConfirmationKey(input);
    input.write('y');
    await expect(decision).resolves.toBe(true);
    expect(modes).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
  });

  it('routes raw Ctrl+C through the TUI interrupt handler and denies', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => { input.isRaw = mode; };
    let interrupts = 0;
    const decision = readConfirmationKey(input, () => { interrupts += 1; });
    input.write('\u0003');
    await expect(decision).resolves.toBe(false);
    expect(interrupts).toBe(1);
    expect(input.isRaw).toBe(false);
  });
});

function captureWritable(): {
  stream: Writable;
  text(): string;
} {
  let value = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      value += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => value };
}

// 编译期也守住 reducer 返回完整 TuiState，而不是依赖测试里的类型断言。
const _stateContract: TuiState = createInitialTuiState();
void _stateContract;
