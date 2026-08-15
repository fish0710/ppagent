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
import { clipTailToWidth, clipToWidth } from './width.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const MAX_VISIBLE_TOOLS = 3;

export interface TuiFrame {
  /** append-only；终端驱动只写尚未提交的后缀。 */
  transcript: readonly string[];
  /** 固定在底部的小区域；每帧可清除后整体重画。 */
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
    live.push(clipToWidth('? 允许执行？按 y 允许，n 拒绝', safeWidth));
    return { transcript: state.transcript, live };
  }

  if (state.pendingText.length > 0) {
    live.push(clipTailToWidth(state.pendingText, safeWidth));
  }

  if (state.phase === 'tool_running') {
    const active = Object.values(state.activeTools);
    for (const tool of active.slice(0, MAX_VISIBLE_TOOLS)) {
      live.push(
        clipToWidth(
          `${spinner(nowMs)} ${tool.summary} · ${formatDuration(
            Math.max(0, nowMs - tool.startedAtMs),
          )}`,
          safeWidth,
        ),
      );
    }
    if (active.length > MAX_VISIBLE_TOOLS) {
      live.push(
        clipToWidth(`  另有 ${active.length - MAX_VISIBLE_TOOLS} 个工具运行中`, safeWidth),
      );
    }
    return { transcript: state.transcript, live };
  }

  if (state.phase === 'prefill') {
    const elapsed = Math.max(0, nowMs - (state.turnStartedAtMs ?? nowMs));
    const context = formatContext(state.contextTokens, state.contextWindow);
    live.push(
      clipToWidth(
        `${spinner(nowMs)} prefill${
          context === '' ? '' : ` ${formatTokenCount(state.contextTokens ?? 0)} tokens`
        } · 已 ${formatDuration(elapsed)}`,
        safeWidth,
      ),
    );
  } else if (state.phase === 'decode') {
    const elapsedSeconds = Math.max(
      ((nowMs - (state.decodeStartedAtMs ?? nowMs)) / 1_000),
      0.001,
    );
    // 流中没有 token 边界，只能用字符数做保守近似；turn_end 后 reducer
    // 会用 provider 的 usage 输出精确速率并提交到 transcript。
    const approximateTokens = Math.max(1, state.decodedCharacters / 4);
    const context = formatContext(state.contextTokens, state.contextWindow);
    live.push(
      clipToWidth(
        `${spinner(nowMs)} decode ~${formatRate(
          approximateTokens / elapsedSeconds,
        )} tok/s${context === '' ? '' : ` · ${context}`}`,
        safeWidth,
      ),
    );
  }

  return { transcript: state.transcript, live };
}

export interface TuiTerminalRendererOptions {
  output?: NodeJS.WritableStream;
  now?: () => number;
  width?: () => number;
  refreshMs?: number;
}

/**
 * 唯一接触 ANSI 的位置。transcript 直接追加；live 只用“上移 + 清到末尾”
 * 两个控制操作整体重画，不维护虚拟屏幕或差分树。
 */
export class TuiTerminalRenderer {
  readonly #output: NodeJS.WritableStream;
  readonly #now: () => number;
  readonly #width: () => number;
  readonly #refreshMs: number;
  #state = createInitialTuiState();
  #committedLines = 0;
  #liveLines = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: TuiTerminalRendererOptions = {}) {
    this.#output = options.output ?? process.stdout;
    this.#now = options.now ?? Date.now;
    this.#width =
      options.width ??
      (() => {
        const columns = (this.#output as NodeJS.WriteStream).columns;
        return typeof columns === 'number' && columns > 0 ? columns : 80;
      });
    this.#refreshMs = options.refreshMs ?? 200;
  }

  get state(): TuiState {
    return this.#state;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.refresh(), this.#refreshMs);
    this.#timer.unref();
  }

  render(event: UIEvent): void {
    this.dispatch(event);
  }

  dispatch(action: TuiAction): void {
    this.#state = reduceTuiState(this.#state, action, this.#now());
    this.refresh();
  }

  submitPrompt(prompt: string): void {
    this.dispatch({ type: 'prompt_submitted', prompt });
  }

  /** readline 已经把“> 输入”写到了终端；这里只同步纯状态与提交游标。 */
  acceptReadlinePrompt(prompt: string): void {
    this.#eraseLive();
    this.#state = reduceTuiState(
      this.#state,
      { type: 'prompt_submitted', prompt },
      this.#now(),
    );
    this.#committedLines = this.#state.transcript.length;
  }

  prepareForInput(): void {
    this.#eraseLive();
    this.#writeTranscript(this.#state.transcript);
  }

  refresh(): void {
    const frame = renderTuiFrame(
      this.#state,
      Math.max(1, this.#width()),
      this.#now(),
    );
    this.#eraseLive();
    this.#writeTranscript(frame.transcript);
    if (frame.live.length === 0) return;
    this.#safeWrite(`${frame.live.join('\n')}\n`);
    this.#liveLines = frame.live.length;
  }

  finish(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#eraseLive();
    this.#writeTranscript(this.#state.transcript);
  }

  #writeTranscript(transcript: readonly string[]): void {
    const pending = transcript.slice(this.#committedLines);
    if (pending.length === 0) return;
    this.#safeWrite(`${pending.join('\n')}\n`);
    this.#committedLines = transcript.length;
  }

  #eraseLive(): void {
    if (this.#liveLines === 0) return;
    this.#safeWrite(`\u001b[${this.#liveLines}A\u001b[0J`);
    this.#liveLines = 0;
  }

  #safeWrite(value: string): void {
    try {
      this.#output.write(value);
    } catch {
      // UI 和 telemetry 一样是旁路；终端关闭不能改变 agent 任务语义。
    }
  }
}

function spinner(nowMs: number): string {
  return SPINNER[Math.floor(nowMs / 100) % SPINNER.length] ?? '⠋';
}
