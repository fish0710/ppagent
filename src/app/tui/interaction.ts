import { Key, matchesKey, SelectList, type OverlayHandle, type SelectItem } from '@earendil-works/pi-tui';
import type { Interaction } from '../../core/types.js';
import { PermissionDialog } from './permission-dialog.js';
import { TuiTerminalRenderer } from './render.js';
import type { PendingPermission } from './state.js';

export interface TuiInteractionOptions {
  onInterrupt?: () => void;
}

const PERMISSION_LABELS: Readonly<Record<string, { label: string; description?: string }>> = {
  allow: { label: '允许' },
  allowAlways: { label: '允许，且本会话不再询问' },
  deny: { label: '拒绝' },
};

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

  /**
   * 三选项 overlay：permission_request UIEvent 是内容源（携带 toolName/detail/
   * sandboxReason，已经落在 renderer.state.pendingPermission 里），这个 Promise
   * 才是真正的门——InteractivePermissionPolicy 等它 resolve 才放行工具执行。
   * y/a/n 仍然是可用的肌肉记忆快捷键，通过更外层的模态 input listener 路由
   * （在 SelectList 拿到焦点之后依然优先生效，因为 pi-tui 的 input listener
   * 先于焦点组件分发，并且能 consume）；方向键和 Enter 才落到 SelectList 本身。
   */
  async select(
    request: Parameters<Interaction['select']>[0],
  ): Promise<string | null> {
    if (request.options.length === 0) return null;
    if (this.#cancelConfirmation !== undefined) {
      this.notify({
        level: 'warn',
        message: 'A permission confirmation is already in progress; denied.',
      });
      return null;
    }
    const pick = (value: string): string | undefined =>
      request.options.includes(value) ? value : undefined;
    const theme = this.#renderer.theme;
    const pending = this.#renderer.state.pendingPermission;
    const content: PendingPermission =
      pending ?? {
        toolName: '?',
        summary: request.message,
        startedAtMs: Date.now(),
        ...(request.detail === undefined ? {} : { detail: request.detail }),
      };
    const items: SelectItem[] = request.options.map((value) => {
      const preset = PERMISSION_LABELS[value];
      return {
        value,
        label: preset?.label ?? value,
        ...(preset?.description === undefined ? {} : { description: preset.description }),
      };
    });
    const list = new SelectList(items, items.length, theme.selectList);
    const dialog = new PermissionDialog(theme, content, list);

    return new Promise<string | null>((resolve) => {
      let settled = false;
      let handle: OverlayHandle | undefined;
      let removeListener = (): void => undefined;
      const finish = (decision: string | null): void => {
        if (settled) return;
        settled = true;
        removeListener();
        handle?.hide();
        this.#cancelConfirmation = undefined;
        resolve(decision);
      };
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(pick('deny') ?? null);
      removeListener = this.#renderer.addInputListener((data) => {
        if (matchesKey(data, Key.ctrl('c'))) {
          this.#onInterrupt();
          finish(pick('deny') ?? null);
          return { consume: true };
        }
        if (matchesKey(data, 'y') || matchesKey(data, Key.shift('y'))) {
          const value = pick('allow');
          if (value !== undefined) finish(value);
          return { consume: true };
        }
        if (matchesKey(data, 'a') || matchesKey(data, Key.shift('a'))) {
          const value = pick('allowAlways');
          if (value !== undefined) finish(value);
          return { consume: true };
        }
        if (matchesKey(data, 'n') || matchesKey(data, Key.shift('n'))) {
          const value = pick('deny');
          if (value !== undefined) finish(value);
          return { consume: true };
        }
        if (matchesKey(data, Key.escape)) {
          finish(pick('deny') ?? null);
          return { consume: true };
        }
        // 其余按键（方向键、Enter、Tab）放行给 SelectList 自己处理。
        return { consume: false };
      });
      this.#cancelConfirmation = () => finish(pick('deny') ?? null);
      handle = this.#renderer.showOverlay(dialog, {
        width: '80%',
        minWidth: 40,
        maxHeight: '50%',
        anchor: 'bottom-center',
        margin: { bottom: 1 },
      });
      handle.focus();
    });
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
