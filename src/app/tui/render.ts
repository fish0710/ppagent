import {
  ProcessTerminal,
  TuiMainScreen,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type AutocompleteProvider,
  type Component,
  type Focusable,
  type Terminal,
  type TUI,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import { homedir } from 'node:os';
import type { UIEvent } from '../../core/types.js';
import { renderBlock, DEFAULT_RENDER_OPTIONS, type TranscriptBlock, type TuiRenderOptions } from './blocks.js';
import type { TuiHostInfo } from './commands.js';
import { formatContext, formatDuration, formatRate, formatTokenCount } from './format.js';
import { PromptBox } from './prompt-box.js';
import {
  createInitialTuiState,
  reduceTuiState,
  type TuiAction,
  type TuiState,
} from './state.js';
import { createTuiTheme, type TuiTheme } from './theme.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const MAX_VISIBLE_TOOLS = 3;

export interface TuiFrame {
  /** append-only；由 Transcript 组件按 block 增量渲染并缓存。 */
  transcript: readonly TranscriptBlock[];
  /** 每帧重新计算的底部活动区域。 */
  live: readonly string[];
}

/** 纯渲染函数；不读取终端、不写 stdout，也不修改 state。 */
export function renderTuiFrame(
  state: TuiState,
  width: number,
  nowMs: number,
  theme: TuiTheme,
  options: TuiRenderOptions = DEFAULT_RENDER_OPTIONS,
): TuiFrame {
  const safeWidth = Math.max(1, width);
  const live: string[] = [];

  if (state.phase === 'confirming') {
    const summary = state.pendingPermission?.summary ?? '';
    live.push(
      truncateToWidth(
        `${theme.accent('?')} 是否执行 ${summary}？y 允许 · a 始终允许 · n 拒绝`,
        safeWidth,
        '…',
      ),
    );
    return { transcript: state.blocks, live };
  }

  if (state.pendingText.length > 0) {
    live.push(clipTailToWidth(state.pendingText, safeWidth));
  }

  if (state.phase === 'tool_running') {
    const active = Object.values(state.activeTools);
    for (const tool of active.slice(0, MAX_VISIBLE_TOOLS)) {
      live.push(
        truncateToWidth(
          `${theme.toolMark(spinner(nowMs))} ${tool.summary} · ${formatDuration(
            Math.max(0, nowMs - tool.startedAtMs),
          )}`,
          safeWidth,
          '…',
        ),
      );
    }
    if (active.length > MAX_VISIBLE_TOOLS) {
      live.push(
        truncateToWidth(
          theme.muted(`  另有 ${active.length - MAX_VISIBLE_TOOLS} 个工具运行中`),
          safeWidth,
          '…',
        ),
      );
    }
    return { transcript: state.blocks, live };
  }

  if (state.phase === 'compacting') {
    // 压缩可能是几十秒的模型调用，必须有自己的活动指示，否则界面看起来是卡死的。
    const elapsed = Math.max(0, nowMs - (state.compactStartedAtMs ?? nowMs));
    const context = formatContext(state.contextTokens, state.contextWindow);
    live.push(
      truncateToWidth(
        `${spinner(nowMs)} ${theme.muted(
          `压缩上下文${context === '' ? '' : ` ${context}`} · 已 ${formatDuration(elapsed)}`,
        )}`,
        safeWidth,
        '…',
      ),
    );
  } else if (state.phase === 'prefill') {
    const elapsed = Math.max(0, nowMs - (state.turnStartedAtMs ?? nowMs));
    const context = formatContext(state.contextTokens, state.contextWindow);
    live.push(
      truncateToWidth(
        `${spinner(nowMs)} ${theme.muted(
          `prefill${
            context === '' ? '' : ` ${formatTokenCount(state.contextTokens ?? 0)} tokens`
          } · 已 ${formatDuration(elapsed)}`,
        )}`,
        safeWidth,
        '…',
      ),
    );
  } else if (state.phase === 'decode') {
    const elapsedSeconds = Math.max(
      (nowMs - (state.decodeStartedAtMs ?? nowMs)) / 1_000,
      0.001,
    );
    // 流中没有 token 边界，只能用字符数做保守近似；turn_end 后 reducer
    // 会用 provider 的 usage 输出精确速率并提交到 blocks。
    const approximateTokens = Math.max(1, state.decodedCharacters / 4);
    const context = formatContext(state.contextTokens, state.contextWindow);
    live.push(
      truncateToWidth(
        `${spinner(nowMs)} ${theme.muted(
          `decode ~${formatRate(approximateTokens / elapsedSeconds)} tok/s${
            context === '' ? '' : ` · ${context}`
          }`,
        )}`,
        safeWidth,
        '…',
      ),
    );
  }

  return { transcript: state.blocks, live };
}

/** live 文本优先展示尾部，列宽与 grapheme 处理交给 pi-tui。 */
export function clipTailToWidth(value: string, width: number): string {
  if (width <= 0) return '';
  const valueWidth = visibleWidth(value);
  if (valueWidth <= width) return value;
  if (width === 1) return '…';
  return `…${sliceByColumn(value, valueWidth - width + 1, width - 1, true)}`;
}

/**
 * blocks 是 append-only 且不可变的，缓存维护一个展开后的行前缀，每帧只把
 * 新提交的 block 追加展开——摊还成本 O(新 block)，而不是 O(全部 block)。
 * 宽度变化时终端本来就要 full redraw，直接整体重排即可。
 */
export class Transcript {
  #width = 0;
  #lines: string[] = [];
  #renderedBlocks = 0;
  readonly #theme: TuiTheme;
  readonly #options: TuiRenderOptions;

  constructor(theme: TuiTheme, options: TuiRenderOptions = DEFAULT_RENDER_OPTIONS) {
    this.#theme = theme;
    this.#options = options;
  }

  render(width: number, blocks: readonly TranscriptBlock[]): readonly string[] {
    if (width !== this.#width) {
      this.#width = width;
      this.#lines = [];
      this.#renderedBlocks = 0;
    }
    for (; this.#renderedBlocks < blocks.length; this.#renderedBlocks += 1) {
      const block = blocks[this.#renderedBlocks]!;
      this.#lines.push(...renderBlock(block, width, this.#theme, this.#options));
    }
    return this.#lines;
  }

  /** 只在主题变更这类需要整体重排的场景调用；事件到达时不要调它。 */
  invalidate(): void {
    this.#width = 0;
  }
}

export interface TuiTerminalRendererOptions {
  terminal?: Terminal;
  now?: () => number;
  refreshMs?: number;
  theme?: TuiTheme;
  renderOptions?: Partial<TuiRenderOptions>;
  /** provider/model/cwd 等静态信息；有值时底部会渲染一条常驻状态栏。 */
  info?: TuiHostInfo;
}

/**
 * pi-tui 边缘适配器。TuiMainScreen 负责差分、同步输出、宽字符与 scrollback；
 * 本项目只把纯 TuiState 投影成 Component，不再手写 ANSI 光标算法。
 */
export class TuiTerminalRenderer {
  readonly #now: () => number;
  readonly #refreshMs: number;
  readonly #tui: TUI;
  readonly #document: TuiDocument;
  readonly #theme: TuiTheme;
  #state = createInitialTuiState();
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #promptResolve: ((value: string | null) => void) | undefined;

  constructor(options: TuiTerminalRendererOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#refreshMs = options.refreshMs ?? 200;
    this.#theme = options.theme ?? createTuiTheme();
    const renderOptions: TuiRenderOptions = {
      ...DEFAULT_RENDER_OPTIONS,
      ...options.renderOptions,
    };
    const terminal = options.terminal ?? new ProcessTerminal();
    this.#tui = new TuiMainScreen(terminal);
    this.#document = new TuiDocument(
      this.#tui,
      () => this.#state,
      this.#now,
      (value) => this.#submitInput(value),
      this.#theme,
      renderOptions,
      options.info,
    );
    this.#tui.addChild(this.#document);
  }

  get state(): TuiState {
    return this.#state;
  }

  get theme(): TuiTheme {
    return this.#theme;
  }

  get mode(): TUI['mode'] {
    return this.#tui.mode;
  }

  get fullRedraws(): number {
    return this.#tui.fullRedraws;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#tui.start();
    this.#timer = setInterval(() => {
      if (
        this.#state.phase === 'prefill' ||
        this.#state.phase === 'decode' ||
        this.#state.phase === 'tool_running'
      ) {
        this.#tui.requestRender();
      }
    }, this.#refreshMs);
    this.#timer.unref();
  }

  render(event: UIEvent): void {
    this.dispatch(event);
  }

  dispatch(action: TuiAction): void {
    this.#state = reduceTuiState(this.#state, action, this.#now());
    this.#document.invalidate();
    this.#tui.requestRender();
  }

  submitPrompt(prompt: string): void {
    this.#document.setInputEnabled(false);
    this.#tui.setFocus(null);
    this.dispatch({ type: 'prompt_submitted', prompt });
  }

  readPrompt(): Promise<string | null> {
    if (this.#promptResolve !== undefined) {
      throw new Error('TUI already has a prompt in progress');
    }
    this.#document.setInputEnabled(true);
    this.#tui.setFocus(this.#document);
    this.#tui.requestRender();
    return new Promise((resolve) => { this.#promptResolve = resolve; });
  }

  cancelPrompt(): void {
    const resolve = this.#promptResolve;
    this.#promptResolve = undefined;
    this.#document.clearInput();
    this.#document.setInputEnabled(false);
    this.#tui.setFocus(null);
    this.#tui.requestRender();
    resolve?.(null);
  }

  addInputListener(listener: TuiInputListener): () => void {
    return this.#tui.addInputListener(listener);
  }

  showOverlay(
    component: Parameters<TUI['showOverlay']>[0],
    options?: Parameters<TUI['showOverlay']>[1],
  ): ReturnType<TUI['showOverlay']> {
    return this.#tui.showOverlay(component, options);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.#document.setAutocompleteProvider(provider);
  }

  refresh(): void {
    if (this.#started) this.#tui.renderNow();
  }

  finish(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.cancelPrompt();
    if (this.#started) this.#tui.stop();
    this.#started = false;
  }

  #submitInput(value: string): void {
    const resolve = this.#promptResolve;
    if (resolve === undefined) return;
    this.#promptResolve = undefined;
    // 先把输入变成 block，再隐藏 Input；同一帧替换避免提示行闪烁。
    this.#state = reduceTuiState(
      this.#state,
      { type: 'prompt_submitted', prompt: value },
      this.#now(),
    );
    if (value.trim().length > 0) this.#document.addToHistory(value);
    this.#document.clearInput();
    this.#document.setInputEnabled(false);
    this.#tui.setFocus(null);
    this.#document.invalidate();
    this.#tui.requestRender();
    resolve(value);
  }
}

class TuiDocument implements Component, Focusable {
  readonly #state: () => TuiState;
  readonly #now: () => number;
  readonly #promptBox: PromptBox;
  readonly #transcript: Transcript;
  readonly #theme: TuiTheme;
  readonly #options: TuiRenderOptions;
  readonly #info: TuiHostInfo | undefined;
  #inputEnabled = false;

  constructor(
    tui: TUI,
    state: () => TuiState,
    now: () => number,
    onSubmit: (value: string) => void,
    theme: TuiTheme,
    options: TuiRenderOptions,
    info?: TuiHostInfo,
  ) {
    this.#state = state;
    this.#now = now;
    this.#theme = theme;
    this.#options = options;
    this.#info = info;
    this.#transcript = new Transcript(theme, options);
    this.#promptBox = new PromptBox(tui, theme);
    this.#promptBox.editor.onSubmit = onSubmit;
  }

  get focused(): boolean {
    return this.#promptBox.focused;
  }

  set focused(value: boolean) {
    this.#promptBox.focused = value;
  }

  setInputEnabled(enabled: boolean): void {
    this.#inputEnabled = enabled;
  }

  clearInput(): void {
    this.#promptBox.editor.setText('');
  }

  addToHistory(text: string): void {
    this.#promptBox.editor.addToHistory(text);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.#promptBox.editor.setAutocompleteProvider(provider);
  }

  handleInput(data: string): void {
    if (this.#inputEnabled) this.#promptBox.handleInput(data);
  }

  /**
   * pi-tui 語义：清掉可复用的渲染缓存。这里只让输入框重新渲染——Transcript
   * 是按 block 增量展开的缓存，事件到达（含每个 text_delta）时不应该被清空，
   * 否则每次都要重新格式化整个会话，退化成 O(全部 block) 而不是 O(新增 block)。
   */
  invalidate(): void {
    this.#promptBox.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const state = this.#state();
    const frame = renderTuiFrame(state, safeWidth, this.#now(), this.#theme, this.#options);
    const transcriptLines = this.#transcript.render(safeWidth, frame.transcript);
    const footer =
      this.#info === undefined
        ? []
        : [renderFooter(state, this.#info, safeWidth, this.#theme)];
    if (!this.#inputEnabled) return [...transcriptLines, ...frame.live, ...footer];
    const input = this.#promptBox.render(safeWidth);
    return [...transcriptLines, ...frame.live, ...input, ...footer];
  }
}

function spinner(nowMs: number): string {
  return SPINNER[Math.floor(nowMs / 100) % SPINNER.length] ?? '⠋';
}

/**
 * 常驻底栏：同时开着几个本地推理服务时，"我到底在跟哪个 endpoint 说话"
 * 是最容易犯的错——这一行对本地模型 harness 比对云端 CLI 更值。
 */
function renderFooter(state: TuiState, info: TuiHostInfo, width: number, theme: TuiTheme): string {
  const home = homedir();
  const cwd = home.length > 0 && info.cwd.startsWith(home) ? `~${info.cwd.slice(home.length)}` : info.cwd;
  const context = formatContext(state.contextTokens, info.contextWindow);
  const percent =
    state.contextTokens !== undefined && info.contextWindow > 0
      ? ` (${Math.round((state.contextTokens / info.contextWindow) * 100)}%)`
      : '';
  const parts = [cwd, `${info.provider}/${info.model}`, context === '' ? '' : `${context}${percent}`].filter(
    (part) => part.length > 0,
  );
  return truncateToWidth(theme.muted(parts.join(' · ')), width, '…');
}
