import {
  Input,
  ProcessTerminal,
  TuiMainScreen,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Terminal,
  type TUI,
  type TuiInputListener,
} from '@earendil-works/pi-tui';
import type { UIEvent } from '../../core/types.js';
import {
  createInitialTuiState,
  formatContext,
  formatDuration,
  formatRate,
  formatTokenCount,
  reduceTuiState,
  type TuiAction,
  type TuiState,
} from './state.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const MAX_VISIBLE_TOOLS = 3;

export interface TuiFrame {
  /** append-only；pi-tui 的 main-screen renderer 保留其终端 scrollback。 */
  transcript: readonly string[];
  /** 由 pi-tui differential renderer 更新的底部活动区域。 */
  live: readonly string[];
}

/** 纯渲染函数；不读取终端、不写 stdout，也不修改 state。 */
export function renderTuiFrame(
  state: TuiState,
  width: number,
  nowMs: number,
): TuiFrame {
  const safeWidth = Math.max(1, width);
  const live: string[] = [];

  if (state.phase === 'confirming') {
    live.push(truncateToWidth('? 允许执行？按 y 允许，n 拒绝', safeWidth, '…'));
    return { transcript: state.transcript, live };
  }

  if (state.pendingText.length > 0) {
    live.push(clipTailToWidth(state.pendingText, safeWidth));
  }

  if (state.phase === 'tool_running') {
    const active = Object.values(state.activeTools);
    for (const tool of active.slice(0, MAX_VISIBLE_TOOLS)) {
      live.push(
        truncateToWidth(
          `${spinner(nowMs)} ${tool.summary} · ${formatDuration(
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
          `  另有 ${active.length - MAX_VISIBLE_TOOLS} 个工具运行中`,
          safeWidth,
          '…',
        ),
      );
    }
    return { transcript: state.transcript, live };
  }

  if (state.phase === 'prefill') {
    const elapsed = Math.max(0, nowMs - (state.turnStartedAtMs ?? nowMs));
    const context = formatContext(state.contextTokens, state.contextWindow);
    live.push(
      truncateToWidth(
        `${spinner(nowMs)} prefill${
          context === '' ? '' : ` ${formatTokenCount(state.contextTokens ?? 0)} tokens`
        } · 已 ${formatDuration(elapsed)}`,
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
    // 会用 provider 的 usage 输出精确速率并提交到 transcript。
    const approximateTokens = Math.max(1, state.decodedCharacters / 4);
    const context = formatContext(state.contextTokens, state.contextWindow);
    live.push(
      truncateToWidth(
        `${spinner(nowMs)} decode ~${formatRate(
          approximateTokens / elapsedSeconds,
        )} tok/s${context === '' ? '' : ` · ${context}`}`,
        safeWidth,
        '…',
      ),
    );
  }

  return { transcript: state.transcript, live };
}

/** live 文本优先展示尾部，列宽与 grapheme 处理交给 pi-tui。 */
export function clipTailToWidth(value: string, width: number): string {
  if (width <= 0) return '';
  const valueWidth = visibleWidth(value);
  if (valueWidth <= width) return value;
  if (width === 1) return '…';
  return `…${sliceByColumn(value, valueWidth - width + 1, width - 1, true)}`;
}

export interface TuiTerminalRendererOptions {
  terminal?: Terminal;
  now?: () => number;
  refreshMs?: number;
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
  #state = createInitialTuiState();
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #promptResolve: ((value: string | null) => void) | undefined;

  constructor(options: TuiTerminalRendererOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#refreshMs = options.refreshMs ?? 200;
    const terminal = options.terminal ?? new ProcessTerminal();
    this.#tui = new TuiMainScreen(terminal);
    this.#document = new TuiDocument(
      () => this.#state,
      this.#now,
      (value) => this.#submitInput(value),
    );
    this.#tui.addChild(this.#document);
  }

  get state(): TuiState {
    return this.#state;
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
    // 先把输入变成 transcript，再隐藏 Input；同一帧替换避免提示行闪烁。
    this.#state = reduceTuiState(
      this.#state,
      { type: 'prompt_submitted', prompt: value },
      this.#now(),
    );
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
  readonly #input = new Input();
  #inputEnabled = false;

  constructor(
    state: () => TuiState,
    now: () => number,
    onSubmit: (value: string) => void,
  ) {
    this.#state = state;
    this.#now = now;
    this.#input.onSubmit = onSubmit;
  }

  get focused(): boolean {
    return this.#input.focused;
  }

  set focused(value: boolean) {
    this.#input.focused = value;
  }

  setInputEnabled(enabled: boolean): void {
    this.#inputEnabled = enabled;
  }

  clearInput(): void {
    this.#input.setValue('');
  }

  handleInput(data: string): void {
    if (this.#inputEnabled) this.#input.handleInput(data);
  }

  invalidate(): void {
    this.#input.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const frame = renderTuiFrame(this.#state(), safeWidth, this.#now());
    const transcript = frame.transcript.flatMap((line) => wrapLine(line, safeWidth));
    if (!this.#inputEnabled) return [...transcript, ...frame.live];
    const input = safeWidth < 2 ? ['>'] : this.#input.render(safeWidth);
    return [...transcript, ...frame.live, ...input];
  }
}

function wrapLine(line: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(line, width);
  return wrapped.length === 0 ? [''] : wrapped;
}

function spinner(nowMs: number): string {
  return SPINNER[Math.floor(nowMs / 100) % SPINNER.length] ?? '⠋';
}
