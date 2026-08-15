import { Key, matchesKey } from '@earendil-works/pi-tui';
import type { Interaction } from '../../core/types.js';
import { TuiTerminalRenderer } from './render.js';

export interface TuiInteractionOptions {
  onInterrupt?: () => void;
}

/** Interaction 的 pi-tui 实现；确认键通过 TUI input listener 路由。 */
export class TuiInteraction implements Interaction {
  readonly #renderer: TuiTerminalRenderer;
  #onInterrupt: () => void;
  #cancelConfirmation: (() => void) | undefined;

  constructor(
    renderer: TuiTerminalRenderer,
    options: TuiInteractionOptions = {},
  ) {
    this.#renderer = renderer;
    this.#onInterrupt = options.onInterrupt ?? (() => undefined);
  }

  setInterruptHandler(handler: () => void): void {
    this.#onInterrupt = handler;
  }

  async confirm(_request: Parameters<Interaction['confirm']>[0]): Promise<boolean> {
    if (this.#cancelConfirmation !== undefined) {
      this.notify({
        level: 'warn',
        message: 'A permission confirmation is already in progress; denied.',
      });
      return false;
    }
    this.#renderer.refresh();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let removeListener = (): void => undefined;
      const finish = (decision: boolean): void => {
        if (settled) return;
        settled = true;
        removeListener();
        this.#cancelConfirmation = undefined;
        resolve(decision);
      };
      removeListener = this.#renderer.addInputListener((data) => {
        if (matchesKey(data, Key.ctrl('c'))) {
          this.#onInterrupt();
          finish(false);
          return { consume: true };
        }
        if (matchesKey(data, 'y') || matchesKey(data, Key.shift('y'))) {
          finish(true);
          return { consume: true };
        }
        if (
          matchesKey(data, 'n') ||
          matchesKey(data, Key.shift('n')) ||
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape)
        ) {
          finish(false);
          return { consume: true };
        }
        // confirming 是模态状态；其余按键不能泄漏到隐藏的 prompt Input。
        return { consume: true };
      });
      this.#cancelConfirmation = () => finish(false);
    });
  }

  async ask(_request: Parameters<Interaction['ask']>[0]): Promise<null> {
    return null;
  }

  async select(_request: Parameters<Interaction['select']>[0]): Promise<null> {
    return null;
  }

  notify(event: Parameters<Interaction['notify']>[0]): void {
    this.#renderer.render({ type: 'notify', ...event });
  }

  cancelConfirmation(): void {
    this.#cancelConfirmation?.();
    this.#cancelConfirmation = undefined;
  }

  close(): void {
    this.cancelConfirmation();
  }
}
