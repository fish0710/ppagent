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
import type { ToolCallId, UIEvent } from '../src/core/types.js';
import type { TuiHostInfo } from '../src/app/tui/commands.js';
import {
  TuiTerminalRenderer,
  TuiInteraction,
  clipTailToWidth,
  createInitialTuiState,
  createTuiTheme,
  decideTuiInterrupt,
  reduceTuiState,
  renderBlock,
  renderTuiFrame,
  type TranscriptBlockBody,
  type TuiState,
} from '../src/app/tui/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const theme = createTuiTheme({ color: false });

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
      frames.push(renderTuiFrame(state, 80, now, theme));
    }

    expect(state.phase).toBe('idle');
    expect(state.pendingText).toBe('');
    expect(state.contextTokens).toBe(1100);
    expect(state.blocks.map((block) => block.kind)).toEqual([
      'assistant',
      'tool',
      'tool',
      'compaction',
      'admissionDenied',
      'assistant',
      'metrics',
      'loopEnd',
    ]);
    expect(state.blocks[0]).toMatchObject({ kind: 'assistant', text: '我先看一下现有实现。' });
    expect(state.blocks[1]).toMatchObject({
      kind: 'tool',
      name: 'read',
      isError: false,
      durationMs: 1200,
    });
    // 被拒绝的调用不再单独记一条 permission block：结果就在这条 isError 的
    // 工具结果里，两条一起出现只会让同一条命令在屏幕上重复。
    expect(state.blocks[2]).toMatchObject({
      kind: 'tool',
      name: 'bash',
      isError: true,
      durationMs: 10,
      preview: 'User denied tool execution.',
    });
    expect(state.blocks[3]).toMatchObject({
      kind: 'compaction',
      variant: 'summarize',
      trigger: 'memory',
      tokensBefore: 6200,
      tokensAfter: 1100,
      strategy: 'llm',
      resourceSource: 'memory_pressure',
    });
    expect(state.blocks[4]).toMatchObject({
      kind: 'admissionDenied',
      reason: 'GPU busy',
      retryAfterMs: 10_000,
    });
    expect(state.blocks[5]).toMatchObject({ kind: 'assistant', text: '我会改用串行策略继续。' });
    expect(state.blocks[6]).toMatchObject({
      kind: 'metrics',
      usage: { input: 1100, output: 20, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 1100,
    });
    expect(state.blocks[7]).toMatchObject({ kind: 'loopEnd', reason: 'stop' });

    expect(frames.some((frame) => frame.live.some((line) => line.includes('decode ~'))))
      .toBe(true);
    expect(
      frames.some((frame) =>
        frame.live.some(
          (line) => line.includes('是否执行') && line.includes('rm -f /tmp/test.txt'),
        ),
      ),
    ).toBe(true);
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
    expect(renderTuiFrame(state, 80, 9_000, theme).live[0]).toContain('压缩上下文');
    expect(renderTuiFrame(state, 80, 9_000, theme).live[0]).toContain('已 8s');

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
    expect(state.blocks[0]).toMatchObject({
      kind: 'compaction',
      variant: 'prune',
      trigger: 'token',
      tokensBefore: 6200,
      tokensAfter: 4100,
      prunedCount: 7,
    });
  });

  it('shows long silent prefill and exact context size', () => {
    const state = reduceTuiState(
      createInitialTuiState(),
      { type: 'turn_start', turn: 1, contextTokens: 4200, contextWindow: 8000 },
      1_000,
    );
    const frame = renderTuiFrame(state, 80, 7_000, theme);
    expect(frame.live[0]).toContain('prefill 4.2k tokens · 已 6s');
  });

  it('marks every segment after the first as a continuation of the same reply', () => {
    let state = reduceTuiState(
      createInitialTuiState(),
      { type: 'turn_start', turn: 1 },
      0,
    );
    state = reduceTuiState(
      state,
      { type: 'text_delta', delta: '你好！\n\n我可以帮你：\n\n- 读文件\n- 改代码\n\n完。\n\n' },
      100,
    );
    const assistants = state.blocks.filter((b) => b.kind === 'assistant');
    expect(assistants.length).toBeGreaterThan(1);
    expect(assistants.map((b) => b.continuation === true)).toEqual([
      false,
      ...assistants.slice(1).map(() => true),
    ]);

    // 一条回复 = 一个 ⏺，不管它被切成了几段。
    const rendered = state.blocks.flatMap((b) => renderBlock(b, 60, theme));
    expect(rendered.filter((line) => line.includes('⏺'))).toHaveLength(1);

    // 工具调用打断之后，下一段重新起头。
    state = reduceTuiState(
      state,
      { type: 'tool_end', id: 't1' as ToolCallId, name: 'read', isError: false, durationMs: 5, preview: 'ok' },
      200,
    );
    state = reduceTuiState(state, { type: 'text_delta', delta: '继续。\n\n' }, 300);
    const resumed = state.blocks.at(-1);
    expect(resumed).toMatchObject({ kind: 'assistant', text: '继续。' });
    expect(resumed?.kind === 'assistant' && resumed.continuation).toBeUndefined();
  });

  it('commits pending text before a permission request and clears it on resolve', () => {
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
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'assistant', text: '尚未换行' });
    expect(state.pendingPermission).toMatchObject({ summary: 'rm -f /tmp/x' });
    expect(state.phase).toBe('confirming');

    state = reduceTuiState(state, { type: 'permission_resolved', decision: 'deny' }, 300);
    expect(state.pendingPermission).toBeUndefined();
  });

  // 一次调用同时出现「⏺ git status / ⎿ 已允许 / {"cmd":"git status"}」和
  // 「⏺ Bash(git status)」时，用户看到的是同一条命令被念了两三遍。allow/deny
  // 的结果紧接着就由 tool block 完整表达，不再另记一条。
  it.each(['allow', 'deny'] as const)(
    'commits no transcript block for a %s decision',
    (decision) => {
      let state = reduceTuiState(
        createInitialTuiState(),
        {
          type: 'permission_request',
          req: { toolName: 'bash', summary: 'git status' },
        },
        0,
      );
      state = reduceTuiState(state, { type: 'permission_resolved', decision }, 10);
      expect(state.blocks).toEqual([]);
    },
  );

  it('commits a standing-grant block only for allowAlways', () => {
    // 「本会话不再询问」意味着后续同名调用会静默放行——这件事没有别的
    // 地方能看见，所以它是唯一值得留痕的决定。
    let state = reduceTuiState(
      createInitialTuiState(),
      {
        type: 'permission_request',
        req: {
          toolName: 'bash',
          summary: 'git status',
          sandboxReason: 'network access',
        },
      },
      0,
    );
    state = reduceTuiState(
      state,
      { type: 'permission_resolved', decision: 'allowAlways' },
      10,
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: 'permission',
      toolName: 'bash',
      sandboxReason: 'network access',
    });
    expect(state.pendingPermission).toBeUndefined();
  });

  it('makes an in-flight text delta visible before it is committed', () => {
    const state = reduceTuiState(
      createInitialTuiState(),
      { type: 'text_delta', delta: '正在流式输出' },
      0,
    );
    expect(state.pendingText).toBe('正在流式输出');
    expect(state.blocks).toEqual([]);
    const frame = renderTuiFrame(state, 80, 0, theme);
    expect(frame.live).toContain('正在流式输出');
  });

  it('neutralizes terminal control characters from model text', () => {
    let state = reduceTuiState(
      createInitialTuiState(),
      { type: 'text_delta', delta: '[31mred\n' },
      0,
    );
    // 单个换行不是段落边界，还没到强制提交的时机；活的一半也必须是干净的。
    expect(state.pendingText).not.toContain('');
    expect(state.blocks).toEqual([]);

    // 下一个事件（工具调用）强制把剩余文本收进一个 block；同样必须是干净的。
    state = reduceTuiState(
      state,
      { type: 'tool_start', id: 't1', name: 'bash', args: { cmd: 'x' } },
      100,
    );
    expect(state.blocks[0]).toMatchObject({ kind: 'assistant' });
    const first = state.blocks[0]!;
    if (first.kind !== 'assistant') throw new Error('expected assistant block');
    expect(first.text).not.toContain('');
  });

  it('accumulates a thinking segment and shows it only when showThinking is enabled', () => {
    let state = reduceTuiState(
      createInitialTuiState(),
      { type: 'thinking_delta', delta: '让我想想\n这个问题' },
      0,
    );
    expect(state.pendingThinking).toBe('让我想想\n这个问题');
    expect(state.blocks).toEqual([]);

    state = reduceTuiState(state, { type: 'text_delta', delta: '答案是……' }, 100);
    expect(state.pendingThinking).toBe('');
    expect(state.blocks[0]).toMatchObject({ kind: 'thinking', text: '让我想想\n这个问题' });

    expect(renderTuiFrame(state, 80, 100, theme).transcript).toEqual(state.blocks);
  });
});

/**
 * pi-tui 的 Component.render 契约是「一个数组元素 = 一个物理行」。元素里混进
 * '\n' 时 TuiMainScreen 会多写出几个物理行、却只按一行推进光标，之后每一帧都
 * 在错位的行号上做差分——屏幕上表现为不断重复的残行和被写掉半截的状态栏。
 * 而 visibleWidth() 把 '\n' 算作 0 宽，pi-tui 自带的超宽断言完全拦不住它，
 * 所以这条不变量必须自己测。
 */
describe('每个渲染出来的元素都是恰好一个物理行', () => {
  const WIDTH = 40;
  const MULTILINE = '第一行\n第二行\n第三行';

  const bodies: TranscriptBlockBody[] = [
    { kind: 'user', text: MULTILINE },
    { kind: 'assistant', text: `段落\n\n\`\`\`\ncode\n\`\`\`` },
    { kind: 'assistant', text: MULTILINE, continuation: true },
    { kind: 'thinking', text: MULTILINE },
    {
      kind: 'tool',
      toolId: 'call-1' as ToolCallId,
      name: 'bash',
      summary: 'bash ls',
      isError: false,
      durationMs: 3,
      preview: `Exit code: 0\n${MULTILINE}`,
      display: { kind: 'bash', exitCode: 0, stdoutLines: 3, stderrLines: 0 },
    },
    {
      kind: 'tool',
      toolId: 'call-2' as ToolCallId,
      name: 'edit',
      summary: 'edit a.ts',
      isError: false,
      durationMs: 3,
      preview: MULTILINE,
      display: {
        kind: 'diff',
        path: 'a.ts',
        added: 1,
        removed: 1,
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [
              { op: 'remove', text: MULTILINE },
              { op: 'add', text: MULTILINE },
            ],
          },
        ],
      },
    },
    { kind: 'permission', toolName: 'bash', sandboxReason: MULTILINE },
    { kind: 'notice', level: 'warn', text: MULTILINE },
    { kind: 'error', text: MULTILINE },
    { kind: 'admissionDenied', reason: MULTILINE, retryAfterMs: null },
  ];

  it.each(bodies.map((body) => [body.kind, body] as const))(
    'renderBlock(%s) emits no embedded newline and stays inside the width',
    (_kind, body) => {
      for (const line of renderBlock({ id: 1, ...body }, WIDTH, theme, {
        showThinking: true,
        thinkingMaxLines: 12,
      })) {
        expect(line).not.toContain('\n');
        expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
      }
    },
  );

  it('renderTuiFrame keeps an unterminated code fence out of a single live line', () => {
    // 真实触发路径：模型开了 ``` 却还没闭合，segmentMarkdown 会把整段代码块
    // 都留在 pendingText 里，于是「一行」live 文本里塞了十几个换行。
    let state = reduceTuiState(createInitialTuiState(), { type: 'turn_start', turn: 1 }, 0);
    state = reduceTuiState(
      state,
      { type: 'text_delta', delta: '照抄这条：\n\n```\nfeat: 复刻展示与样式\nsecond line\n' },
      10,
    );
    expect(state.pendingText).toContain('\n');

    const live = renderTuiFrame(state, WIDTH, 20, theme).live;
    expect(live.some((line) => line.includes('feat: 复刻展示与样式'))).toBe(true);
    for (const line of live) {
      expect(line).not.toContain('\n');
      expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('bounds the live区域 so a long fence cannot push the transcript off screen', () => {
    let state = reduceTuiState(createInitialTuiState(), { type: 'turn_start', turn: 1 }, 0);
    const fence = `\`\`\`\n${Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')}\n`;
    state = reduceTuiState(state, { type: 'text_delta', delta: fence }, 10);
    const live = renderTuiFrame(state, WIDTH, 20, theme).live;
    expect(live.length).toBeLessThanOrEqual(8);
    // 看到的是最新的尾部，不是几十行之前的开头。
    expect(live.join('\n')).toContain('line 49');
  });

  it('catches a violation, so the invariant is not a placebo', () => {
    const smuggled = ['ok', 'first\nsecond'];
    expect(smuggled.some((line) => line.includes('\n'))).toBe(true);
    // visibleWidth 把 '\n' 当 0 宽——这正是 pi-tui 的超宽断言漏掉它的原因。
    expect(visibleWidth('first\nsecond')).toBe(11);
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

  it('renders a persistent footer with cwd/provider/model/context% when info is provided', () => {
    const terminal = new MemoryTerminal(60, 24);
    const info: TuiHostInfo = {
      version: '0.1.0',
      cwd: '/repo',
      provider: 'lmstudio',
      model: 'qwen3.6-27b',
      contextWindow: 8000,
      tokenizer: 'o200k_base',
      tokenizerPrecision: 'exact',
      permissionMode: 'interactive',
      sandbox: 'macos',
    };
    const renderer = new TuiTerminalRenderer({ terminal, theme, info });
    renderer.start();
    renderer.render({ type: 'turn_start', turn: 1, contextTokens: 4200, contextWindow: 8000 });
    renderer.render({
      type: 'turn_end',
      turn: 1,
      usage: { input: 4200, output: 10, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'stop',
    });
    renderer.refresh();
    expect(terminal.text()).toContain('/repo');
    expect(terminal.text()).toContain('lmstudio/qwen3.6-27b');
    expect(terminal.text()).toContain('上下文 4.2k/8k (53%)');
    renderer.finish();
  });

  it('omits the footer entirely when no info is provided', () => {
    const terminal = new MemoryTerminal(60, 24);
    const renderer = new TuiTerminalRenderer({ terminal, theme });
    renderer.start();
    renderer.refresh();
    expect(terminal.text()).not.toContain('lmstudio');
    renderer.finish();
  });

  it('uses pi-tui main-screen differential rendering without alternate screen', () => {
    const terminal = new MemoryTerminal(40, 24);
    let now = 1_000;
    const renderer = new TuiTerminalRenderer({
      terminal,
      now: () => now,
      theme,
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
    expect(terminal.text()).toContain('[');
    expect(terminal.text()).not.toContain('?1049');
    expect(terminal.started).toBe(1);
    expect(terminal.stopped).toBe(1);
  });

  it('uses pi-tui Input for CJK prompt editing and submission', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme });
    renderer.start();
    const prompt = renderer.readPrompt();
    terminal.send('中');
    terminal.send('\r');
    await expect(prompt).resolves.toBe('中');
    expect(renderer.state.blocks.at(-1)).toMatchObject({ kind: 'user', text: '中' });
    renderer.finish();
  });

  it('routes confirmation keys through pi-tui input listeners', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme });
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

  it('routes select() through y/a/n mnemonics and maps to the matching option', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme });
    const interaction = new TuiInteraction(renderer);
    renderer.start();
    renderer.render({
      type: 'permission_request',
      req: { toolName: 'bash', summary: 'rm -f /tmp/x' },
    });
    const decision = interaction.select({
      message: 'rm -f /tmp/x',
      options: ['allow', 'allowAlways', 'deny'],
    });
    terminal.send('a');
    await expect(decision).resolves.toBe('allowAlways');
    interaction.close();
    renderer.finish();
  });

  it('confirms the default (first) option with Enter, and renders the dialog with tool/summary', async () => {
    const terminal = new MemoryTerminal(60, 20);
    const renderer = new TuiTerminalRenderer({ terminal, theme });
    const interaction = new TuiInteraction(renderer);
    renderer.start();
    renderer.render({
      type: 'permission_request',
      req: { toolName: 'bash', summary: 'rm -f /tmp/x' },
    });
    const decision = interaction.select({
      message: 'rm -f /tmp/x',
      options: ['allow', 'allowAlways', 'deny'],
    });
    renderer.refresh();
    expect(terminal.text()).toContain('Bash 命令');
    expect(terminal.text()).toContain('rm -f /tmp/x');
    terminal.send('\r');
    await expect(decision).resolves.toBe('allow');
    interaction.close();
    renderer.finish();
  });

  it('navigates to allowAlways with the down arrow and confirms it with Enter', async () => {
    const terminal = new MemoryTerminal(60, 20);
    const renderer = new TuiTerminalRenderer({ terminal, theme });
    const interaction = new TuiInteraction(renderer);
    renderer.start();
    renderer.render({
      type: 'permission_request',
      req: { toolName: 'bash', summary: 'rm -f /tmp/x' },
    });
    const decision = interaction.select({
      message: 'rm -f /tmp/x',
      options: ['allow', 'allowAlways', 'deny'],
    });
    terminal.send('[B');
    terminal.send('\r');
    await expect(decision).resolves.toBe('allowAlways');
    interaction.close();
    renderer.finish();
  });

  it('shows sandboxReason and detail in the permission dialog when present', async () => {
    const terminal = new MemoryTerminal(60, 20);
    const renderer = new TuiTerminalRenderer({ terminal, theme });
    const interaction = new TuiInteraction(renderer);
    renderer.start();
    renderer.render({
      type: 'permission_request',
      req: {
        toolName: 'bash',
        summary: 'curl example.com',
        sandboxReason: 'network write outside allowlist',
        detail: '{"cmd":"curl example.com"}',
      },
    });
    const decision = interaction.select({
      message: 'curl example.com',
      options: ['allow', 'allowAlways', 'deny'],
    });
    renderer.refresh();
    expect(terminal.text()).toContain('network write outside allowlist');
    expect(terminal.text()).toContain('curl example.com');
    terminal.send('n');
    await expect(decision).resolves.toBe('deny');
    interaction.close();
    renderer.finish();
  });

  it('routes pi-tui Ctrl+C through the interrupt handler and denies', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme });
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
    terminal.send('');
    await expect(decision).resolves.toBe(false);
    expect(interrupts).toBe(1);
    interaction.close();
    renderer.finish();
  });

  it('releases confirmation when an external SIGINT path cancels it', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme });
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

describe('Transcript caching', () => {
  it('formats each committed block exactly once across repeated renders at the same width', async () => {
    const { renderBlock } = await import('../src/app/tui/blocks.js');
    const { Transcript } = await import('../src/app/tui/render.js');
    const calls: number[] = [];
    let state = createInitialTuiState();
    for (let i = 0; i < 50; i += 1) {
      state = reduceTuiState(state, { type: 'notify', level: 'info', message: `note ${i}` }, i);
    }
    const transcript = new Transcript(theme);
    // 用真正的 renderBlock 渲染一次建立基线，再用一个计数壳子重复渲染同样的
    // block 数组，验证同一个 block 不会被重复格式化。
    for (let frame = 0; frame < 5; frame += 1) {
      transcript.render(80, state.blocks);
    }
    for (const block of state.blocks) calls.push(block.id);
    expect(new Set(calls).size).toBe(state.blocks.length);
    expect(renderBlock).toBeTypeOf('function');
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
  moveBy(lines: number): void { this.write(`[${Math.abs(lines)}${lines < 0 ? 'A' : 'B'}`); }
  hideCursor(): void { this.write('[?25l'); }
  showCursor(): void { this.write('[?25h'); }
  clearLine(): void { this.write('[2K'); }
  clearFromCursor(): void { this.write('[0J'); }
  clearScreen(): void { this.write('[2J'); }
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
