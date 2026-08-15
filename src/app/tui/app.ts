import { createInterface, type Interface } from 'node:readline/promises';
import type { AgentSession } from '../../agent/session.js';
import { TuiInteraction } from './interaction.js';
import { TuiTerminalRenderer } from './render.js';

export type TuiSessionPort = Pick<
  AgentSession,
  'prompt' | 'abort' | 'subscribe' | 'setInteraction'
>;

export interface TuiAppOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  now?: () => number;
  width?: () => number;
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
 * 它不读取 Context，不认识 loop、provider 或工具注册表。
 */
export class TuiApp {
  readonly renderer: TuiTerminalRenderer;
  readonly interaction: TuiInteraction;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  readonly #now: () => number;
  readonly #requestProcessExit: (code: number) => void;
  #session: TuiSessionPort | undefined;
  #readline: Interface | undefined;
  #running = false;
  #exitRequested = false;
  #lastRunningInterruptMs = Number.NEGATIVE_INFINITY;

  constructor(options: TuiAppOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#now = options.now ?? Date.now;
    this.#requestProcessExit =
      options.requestProcessExit ?? ((code) => { process.exitCode = code; });
    this.renderer = new TuiTerminalRenderer({
      output: this.#output,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.width === undefined ? {} : { width: options.width }),
    });
    this.interaction = new TuiInteraction(this.renderer, {
      input: this.#input,
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
    const onSigint = (): void => this.#handleInterrupt();
    process.on('SIGINT', onSigint);
    this.renderer.start();
    try {
      let prompt = initialPrompt?.trim() ?? '';
      let promptWasRendered = false;
      while (!this.#exitRequested) {
        if (prompt.length === 0) {
          const answer = await this.#readPrompt();
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
      this.#readline?.close();
      this.#readline = undefined;
      this.renderer.finish();
      process.removeListener('SIGINT', onSigint);
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
      this.#safeWrite('\n');
      this.#readline?.close();
      return;
    }
    this.#lastRunningInterruptMs = now;
    this.#session?.abort(new Error('Interrupted by user'));
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

  async #readPrompt(): Promise<string | null> {
    this.renderer.prepareForInput();
    const readline = createInterface({
      input: this.#input,
      output: this.#output,
      terminal: true,
    });
    this.#readline = readline;
    const onSigint = (): void => this.#handleInterrupt();
    readline.once('SIGINT', onSigint);
    try {
      const answer = await readline.question('> ');
      this.renderer.acceptReadlinePrompt(answer);
      return answer;
    } catch (error) {
      if (this.#exitRequested) return null;
      if (/ctrl\+d|end of input/iu.test(errorMessage(error))) return null;
      throw error;
    } finally {
      readline.removeListener('SIGINT', onSigint);
      readline.close();
      if (this.#readline === readline) this.#readline = undefined;
    }
  }

  #safeWrite(value: string): void {
    try {
      this.#output.write(value);
    } catch {
      // 输出关闭不应改变 agent 的取消与清理语义。
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
