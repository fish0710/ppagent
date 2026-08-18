import { Key, matchesKey } from '@earendil-works/pi-tui';
import type { AgentSession } from '../../agent/session.js';
import { TuiInteraction } from './interaction.js';
import { TuiTerminalRenderer } from './render.js';

export type TuiSessionPort = Pick<
  AgentSession,
  'prompt' | 'compact' | 'abort' | 'subscribe' | 'setInteraction'
>;

export interface TuiAppOptions {
  renderer?: TuiTerminalRenderer;
  now?: () => number;
  /** 第二次 Ctrl+C 不直接 process.exit；由宿主决定退出码，等待取消清理完成。 */
  requestProcessExit?: (code: number) => void;
}

export interface TuiRunResult {
  exitCode: number;
}

export type TuiInterruptDecision = 'exit' | 'abort' | 'abortAndExit';

export function decideTuiInterrupt(
  running: boolean,
  lastRunningInterruptMs: number,
  nowMs: number,
): TuiInterruptDecision {
  if (!running) return 'exit';
  return nowMs - lastRunningInterruptMs <= 1_500 ? 'abortAndExit' : 'abort';
}

/**
 * 薄装配层：只把 UIEvent、prompt/abort 和 Interaction 接到 AgentSession。
 * 键盘/raw mode/IME 由 pi-tui ProcessTerminal 和 Input 负责。
 */
export class TuiApp {
  readonly renderer: TuiTerminalRenderer;
  readonly interaction: TuiInteraction;
  readonly #now: () => number;
  readonly #requestProcessExit: (code: number) => void;
  #session: TuiSessionPort | undefined;
  #running = false;
  #exitRequested = false;
  #lastRunningInterruptMs = Number.NEGATIVE_INFINITY;

  constructor(options: TuiAppOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#requestProcessExit =
      options.requestProcessExit ?? ((code) => { process.exitCode = code; });
    this.renderer = options.renderer ?? new TuiTerminalRenderer({
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.interaction = new TuiInteraction(this.renderer, {
      onInterrupt: () => this.#handleInterrupt(),
    });
  }

  async run(
    session: TuiSessionPort,
    initialPrompt?: string,
  ): Promise<TuiRunResult> {
    if (this.#session !== undefined) throw new Error('TUI is already running');
    this.#session = session;
    session.setInteraction(this.interaction);
    this.#exitRequested = false;
    let exitCode = 0;
    const unsubscribe = session.subscribe((event) => this.renderer.render(event));
    const removeInputListener = this.renderer.addInputListener((data) => {
      // confirmation 自己消费 Ctrl+C，以便同时 resolve(false)；其余阶段走两级取消。
      if (
        this.renderer.state.phase === 'confirming' ||
        !matchesKey(data, Key.ctrl('c'))
      ) {
        return undefined;
      }
      this.#handleInterrupt();
      return { consume: true };
    });
    const onSigint = (): void => this.#handleInterrupt();
    process.on('SIGINT', onSigint);
    this.renderer.start();
    try {
      let prompt = initialPrompt?.trim() ?? '';
      let promptWasRendered = false;
      while (!this.#exitRequested) {
        if (prompt.length === 0) {
          const answer = await this.renderer.readPrompt();
          if (answer === null) break;
          prompt = answer.trim();
          promptWasRendered = true;
        }
        if (prompt === '/exit' || prompt === '/quit') break;
        if (prompt.length === 0) {
          promptWasRendered = false;
          continue;
        }
        if (!promptWasRendered) this.renderer.submitPrompt(prompt);
        this.#running = true;
        try {
          // /compact [说明]：在撞到阈值之前主动腾地方，可选的说明会附加到摘要指令后。
          const compactArgs = slashArguments(prompt, '/compact');
          if (compactArgs !== null) {
            await session.compact(compactArgs.length === 0 ? undefined : compactArgs);
          } else {
            const result = await session.prompt(prompt);
            if (result.reason === 'error' || result.reason === 'maxTurns') exitCode = 1;
          }
        } catch (error) {
          exitCode = 1;
          this.renderer.render({ type: 'error', message: errorMessage(error) });
        } finally {
          this.#running = false;
          this.#lastRunningInterruptMs = Number.NEGATIVE_INFINITY;
        }
        prompt = '';
        promptWasRendered = false;
      }
    } finally {
      this.renderer.cancelPrompt();
      this.interaction.close();
      this.renderer.finish();
      process.removeListener('SIGINT', onSigint);
      removeInputListener();
      unsubscribe();
      this.interaction.setInterruptHandler(() => undefined);
      this.#session = undefined;
    }
    return { exitCode: this.#exitRequested ? Math.max(exitCode, 130) : exitCode };
  }

  #handleInterrupt(): void {
    const now = this.#now();
    const decision = decideTuiInterrupt(
      this.#running,
      this.#lastRunningInterruptMs,
      now,
    );
    if (decision === 'exit') {
      this.#exitRequested = true;
      this.renderer.cancelPrompt();
      return;
    }
    this.#lastRunningInterruptMs = now;
    this.#session?.abort(new Error('Interrupted by user'));
    // 外部 kill -SIGINT 不经过 pi-tui input listener；确认 Promise 也必须释放，
    // 否则权限链会永远等在 confirm，无法观察已经 aborted 的 signal。
    this.interaction.cancelConfirmation();
    if (decision === 'abortAndExit') {
      this.#exitRequested = true;
      this.#requestProcessExit(130);
      return;
    }
    this.renderer.render({
      type: 'notify',
      level: 'info',
      message: '正在取消；1.5 秒内再次按 Ctrl+C 将退出。',
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 命中斜杠命令时返回其参数（可能是空串），否则返回 null。
 * 只认完整命令词，"/compacted" 这类前缀相同的普通输入不会被误判。
 */
function slashArguments(prompt: string, command: string): string | null {
  if (prompt === command) return '';
  return prompt.startsWith(`${command} `)
    ? prompt.slice(command.length + 1).trim()
    : null;
}
