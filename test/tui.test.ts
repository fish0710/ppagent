import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Terminal,
} from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import type { UIEvent } from '../src/core/types.js';
import {
  TuiTerminalRenderer,
  TuiInteraction,
  clipTailToWidth,
  createInitialTuiState,
  decideTuiInterrupt,
  reduceTuiState,
  renderTuiFrame,
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
      '⟳ 压缩 6.2k→1.1k（内存压力 · llm · memory_pressure）',
    );
    expect(state.transcript).toContain(
      '⊘ 子 agent 被拒：GPU busy，建议 10s 后重试',
    );
    expect(frames.some((frame) => frame.live.some((line) => line.includes('decode ~'))))
      .toBe(true);
    expect(frames.some((frame) => frame.live.includes('? 允许执行？按 y 允许，n 拒绝')))
      .toBe(true);
  });

  it('keeps a live indicator while compaction runs', () => {
    // LLM 摘要在本地机器上可能跑几十秒；没有独立相位界面看起来就是卡死的。
    let state = reduceTuiState(
      createInitialTuiState(),
      { type: 'turn_start', turn: 1, contextTokens: 6200, contextWindow: 8000 },
      0,
    );
    state = reduceTuiState(state, { type: 'compact_start', trigger: 'token' }, 1_000);

    expect(state.phase).toBe('compacting');
    expect(renderTuiFrame(state, 80, 9_000).live[0]).toContain('压缩上下文');
    expect(renderTuiFrame(state, 80, 9_000).live[0]).toContain('已 8s');

    state = reduceTuiState(
      state,
      {
        type: 'compacted',
        trigger: 'token',
        kind: 'summarize',
        tokensBefore: 6200,
        tokensAfter: 1100,
        prunedCount: 0,
        strategy: 'llm',
      },
      10_000,
    );
    // 压缩发生在模型调用之前，结束后下一步就是真正的请求。
    expect(state.phase).toBe('prefill');
    expect(state.contextTokens).toBe(1100);
  });

  it('labels pruning differently from summarization', () => {
    // 两者的信息损失不是一个量级：剪枝只降了老工具输出的保真度。
    const state = reduceTuiState(
      createInitialTuiState(),
      {
        type: 'compacted',
        trigger: 'token',
        kind: 'prune',
        tokensBefore: 6200,
        tokensAfter: 4100,
        prunedCount: 7,
      },
      0,
    );
    expect(state.transcript).toContain('⟳ 剪枝 6.2k→4.1k（上下文阈值 · 7 条工具输出）');
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

  it('makes an in-flight text delta visible before it is committed', () => {
    const state = reduceTuiState(
      createInitialTuiState(),
      { type: 'text_delta', delta: '正在流式输出' },
      0,
    );
    expect(state.pendingText).toBe('正在流式输出');
    expect(state.transcript).toEqual([]);
    const frame = renderTuiFrame(state, 80, 0);
    expect(frame.live).toContain('正在流式输出');
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
    expect(visibleWidth('中a🙂')).toBe(5);
    expect(stripTerminalSequences(truncateToWidth('中文abc', 5, '…'))).toBe('中文…');
    expect(visibleWidth(truncateToWidth('中文abc', 5, '…'))).toBeLessThanOrEqual(5);
    expect(clipTailToWidth('abc中文', 5)).toBe('…中文');
    expect(visibleWidth(clipTailToWidth('abc中文', 5))).toBeLessThanOrEqual(5);
    expect(
      stripTerminalSequences(truncateToWidth('👨‍👩‍👧‍👦abc', 4, '…')),
    ).toBe('👨‍👩‍👧‍👦a…');
  });

  it('uses pi-tui main-screen differential rendering without alternate screen', () => {
    const terminal = new MemoryTerminal(40, 24);
    let now = 1_000;
    const renderer = new TuiTerminalRenderer({
      terminal,
      now: () => now,
    });
    renderer.start();
    renderer.render({
      type: 'turn_start',
      turn: 1,
      contextTokens: 100,
      contextWindow: 1000,
    });
    now += 500;
    renderer.render({ type: 'text_delta', delta: 'hello' });
    renderer.refresh();
    // 用未剥离转义序列的原始文本判断：'hello' 应作为连续字面文本出现，
    // 且第二个 delta 尚未发送，'world' 不应存在。
    expect(terminal.text()).toContain('hello');
    expect(terminal.text()).not.toContain('world');
    now += 500;
    renderer.render({ type: 'text_delta', delta: ' world\n' });
    renderer.refresh();
    renderer.finish();

    expect(renderer.mode).toBe('regular');
    expect(terminal.text()).toContain('hello world');
    expect(terminal.text()).toContain('\u001b[');
    expect(terminal.text()).not.toContain('?1049');
    expect(terminal.started).toBe(1);
    expect(terminal.stopped).toBe(1);
  });

  it('uses pi-tui Input for CJK prompt editing and submission', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal });
    renderer.start();
    const prompt = renderer.readPrompt();
    terminal.send('中');
    terminal.send('\r');
    await expect(prompt).resolves.toBe('中');
    expect(renderer.state.transcript.at(-1)).toBe('> 中');
    renderer.finish();
  });

  it('routes confirmation keys through pi-tui input listeners', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal });
    const interaction = new TuiInteraction(renderer);
    renderer.start();
    renderer.render({
      type: 'permission_request',
      req: { toolName: 'bash', summary: 'rm -f /tmp/x' },
    });
    const decision = interaction.confirm({ message: 'rm -f /tmp/x' });
    terminal.send('y');
    await expect(decision).resolves.toBe(true);
    interaction.close();
    renderer.finish();
  });

  it('routes pi-tui Ctrl+C through the interrupt handler and denies', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal });
    let interrupts = 0;
    const interaction = new TuiInteraction(renderer, {
      onInterrupt: () => { interrupts += 1; },
    });
    renderer.start();
    renderer.render({
      type: 'permission_request',
      req: { toolName: 'bash', summary: 'rm -f /tmp/x' },
    });
    const decision = interaction.confirm({ message: 'rm -f /tmp/x' });
    terminal.send('\u0003');
    await expect(decision).resolves.toBe(false);
    expect(interrupts).toBe(1);
    interaction.close();
    renderer.finish();
  });

  it('releases confirmation when an external SIGINT path cancels it', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal });
    const interaction = new TuiInteraction(renderer);
    renderer.start();
    renderer.render({
      type: 'permission_request',
      req: { toolName: 'bash', summary: 'rm -f /tmp/x' },
    });
    const decision = interaction.confirm({ message: 'rm -f /tmp/x' });
    interaction.cancelConfirmation();
    await expect(decision).resolves.toBe(false);
    renderer.finish();
  });
});

class MemoryTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  readonly columns: number;
  readonly rows: number;
  started = 0;
  stopped = 0;
  #value = '';
  #onInput: ((data: string) => void) | undefined;

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.started += 1;
    this.#onInput = onInput;
  }

  stop(): void {
    this.stopped += 1;
    this.#onInput = undefined;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void { this.#value += data; }
  moveBy(lines: number): void { this.write(`\u001b[${Math.abs(lines)}${lines < 0 ? 'A' : 'B'}`); }
  hideCursor(): void { this.write('\u001b[?25l'); }
  showCursor(): void { this.write('\u001b[?25h'); }
  clearLine(): void { this.write('\u001b[2K'); }
  clearFromCursor(): void { this.write('\u001b[0J'); }
  clearScreen(): void { this.write('\u001b[2J'); }
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}

  send(data: string): void {
    this.#onInput?.(data);
  }

  text(): string {
    return this.#value;
  }
}

// 编译期也守住 reducer 返回完整 TuiState，而不是依赖测试里的类型断言。
const _stateContract: TuiState = createInitialTuiState();
void _stateContract;
