import type { Interaction } from '../../core/types.js';
import { TuiTerminalRenderer } from './render.js';

interface RawInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): this;
  pause(): this;
}

export interface TuiInteractionOptions {
  input?: RawInput;
  onInterrupt?: () => void;
}

/** Interaction 的 TUI 实现；confirm 用 raw mode 单键，不创建 readline。 */
export class TuiInteraction implements Interaction {
  readonly #renderer: TuiTerminalRenderer;
  readonly #input: RawInput;
  #onInterrupt: () => void;

  constructor(
    renderer: TuiTerminalRenderer,
    options: TuiInteractionOptions = {},
  ) {
    this.#renderer = renderer;
    this.#input = (options.input ?? process.stdin) as RawInput;
    this.#onInterrupt = options.onInterrupt ?? (() => undefined);
  }

  setInterruptHandler(handler: () => void): void {
    this.#onInterrupt = handler;
  }

  async confirm(_request: Parameters<Interaction['confirm']>[0]): Promise<boolean> {
    this.#renderer.refresh();
    if (this.#input.isTTY !== true || this.#input.setRawMode === undefined) {
      this.notify({
        level: 'warn',
        message: 'TUI input is unavailable; permission was denied.',
      });
      return false;
    }
    return readConfirmationKey(this.#input, this.#onInterrupt);
  }

  async ask(_request: Parameters<Interaction['ask']>[0]): Promise<null> {
    // 当前内置工具只需要 confirm；保持 null 比在 agent 运行期间偷偷创建
    // readline 更安全，也让 SIGINT 始终归进程级取消处理器。
    return null;
  }

  async select(_request: Parameters<Interaction['select']>[0]): Promise<null> {
    return null;
  }

  notify(event: Parameters<Interaction['notify']>[0]): void {
    this.#renderer.render({ type: 'notify', ...event });
  }
}

export async function readConfirmationKey(
  input: RawInput,
  onInterrupt: () => void = () => undefined,
): Promise<boolean> {
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused();
  input.setRawMode?.(true);
  try {
    return await new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
        input.removeListener('error', onEnd);
      };
      const finish = (decision: boolean): void => {
        cleanup();
        resolve(decision);
      };
      const onEnd = (): void => finish(false);
      const onData = (chunk: string | Buffer): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const key of text) {
          if (key === '\u0003') {
            onInterrupt();
            finish(false);
            return;
          }
          if (key === 'y' || key === 'Y') {
            finish(true);
            return;
          }
          if (key === 'n' || key === 'N' || key === '\r' || key === '\n') {
            finish(false);
            return;
          }
        }
      };
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onEnd);
      // 先装监听器再 resume，避免测试流或已缓冲 stdin 同步吐出按键。
      input.resume();
    });
  } finally {
    input.setRawMode?.(wasRaw);
    if (wasPaused) input.pause();
  }
}
