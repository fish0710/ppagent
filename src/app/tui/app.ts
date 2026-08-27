import { CombinedAutocompleteProvider, Key, matchesKey } from '@earendil-works/pi-tui';
import {
  createTuiCommands,
  parseSlashCommand,
  toAutocompleteCommands,
  UNKNOWN_HOST_INFO,
  type TuiCommand,
  type TuiCommandContext,
  type TuiCommandResult,
  type TuiHostInfo,
  type TuiSessionPort,
} from './commands.js';
import { TuiInteraction } from './interaction.js';
import { TuiTerminalRenderer } from './render.js';

export type { TuiSessionPort } from './commands.js';

export interface TuiAppOptions {
  renderer?: TuiTerminalRenderer;
  now?: () => number;
  /** 第二次 Ctrl+C 不直接 process.exit；由宿主决定退出码，等待取消清理完成。 */
  requestProcessExit?: (code: number) => void;
  /** provider/model/cwd 等静态信息，供 /status 这类命令展示；bin/agent.ts 注入。 */
  info?: TuiHostInfo;
  /** 测试注入；默认使用 createTuiCommands() 的完整注册表。 */
  commands?: readonly TuiCommand[];
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
  readonly #info: TuiHostInfo;
  readonly #commands: readonly TuiCommand[];
  #session: TuiSessionPort | undefined;
  #running = false;
  #exitRequested = false;
  #lastRunningInterruptMs = Number.NEGATIVE_INFINITY;

  constructor(options: TuiAppOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#requestProcessExit =
      options.requestProcessExit ?? ((code) => { process.exitCode = code; });
    this.#info = options.info ?? UNKNOWN_HOST_INFO;
    this.#commands = options.commands ?? createTuiCommands();
    this.renderer = options.renderer ?? new TuiTerminalRenderer({
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.info === undefined ? {} : { info: options.info }),
    });
    this.renderer.setAutocompleteProvider(
      new CombinedAutocompleteProvider(toAutocompleteCommands(this.#commands), this.#info.cwd),
    );
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
      if (this.renderer.state.phase === 'confirming') return undefined;
      if (matchesKey(data, Key.ctrl('c'))) {
        this.#handleInterrupt();
        return { consume: true };
      }
      // esc 是单级取消：只中断当前这一轮，不进入 Ctrl+C 的两级退出阶梯；
      // 空闲时按 esc 没有意义，交还给 Editor 自己处理（比如关闭补全菜单）。
      if (this.#running && matchesKey(data, Key.escape)) {
        this.#session?.abort(new Error('Interrupted by user'));
        return { consume: true };
      }
      return undefined;
    });
    const onSigint = (): void => this.#handleInterrupt();
    process.on('SIGINT', onSigint);
    this.renderer.start();
    try {
      let prompt = initialPrompt?.trim() ?? '';
      let promptWasRendered = false;
      // 和 #exitRequested 分开：后者只在两级 Ctrl+C 阶梯里置真，退出码要
      // Math.max(..., 130)；/exit 是用户主动的干净退出，不该被算成中断退出码。
      let voluntaryExit = false;
      while (!this.#exitRequested && !voluntaryExit) {
        if (prompt.length === 0) {
          const answer = await this.renderer.readPrompt();
          if (answer === null) break;
          prompt = answer.trim();
          promptWasRendered = true;
        }
        if (prompt.length === 0) {
          promptWasRendered = false;
          continue;
        }
        if (!promptWasRendered) this.renderer.submitPrompt(prompt);
        const match = parseSlashCommand(prompt, this.#commands);
        if (match !== null) {
          if (match.kind === 'unknown') {
            this.renderer.render({
              type: 'notify',
              level: 'warn',
              message: `未知命令 /${match.name}，输入 /help 查看可用命令`,
            });
            prompt = '';
            promptWasRendered = false;
            continue;
          }
          const ctx: TuiCommandContext = {
            session,
            state: this.renderer.state,
            info: this.#info,
            emit: (text) => this.renderer.render({ type: 'notify', level: 'info', message: text }),
            requestExit: () => { voluntaryExit = true; },
          };
          let result: TuiCommandResult;
          try {
            result = await match.command.run(match.args, ctx);
          } catch (error) {
            this.renderer.render({ type: 'error', message: errorMessage(error) });
            result = { prompt: null };
          }
          if (result.prompt === null) {
            prompt = '';
            promptWasRendered = false;
            continue;
          }
          // 命令合成了一个新 prompt（如 /init）；用户看到的是自己敲的命令本身，
          // 合成出来的真正指令静默发给模型，不再重复展示一次。
          prompt = result.prompt;
        }
        this.#running = true;
        try {
          const result = await session.prompt(prompt);
          if (result.reason === 'error' || result.reason === 'maxTurns') exitCode = 1;
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
