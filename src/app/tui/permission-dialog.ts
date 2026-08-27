import { truncateToWidth, wrapTextWithAnsi, type Component, type SelectList } from '@earendil-works/pi-tui';
import type { PendingPermission } from './state.js';
import type { TuiTheme } from './theme.js';

function toolLabel(name: string): string {
  switch (name) {
    case 'bash':
      return 'Bash';
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Update';
    case 'spawn_subagent':
      return 'Task';
    case 'memory_search':
      return 'Search';
    default:
      return name;
  }
}

/**
 * 权限确认弹窗：标题 + summary/sandboxReason/detail + 三选项 SelectList，
 * 通过 renderer.showOverlay() 显示在底部。渲染纯粹是静态文本框，没有
 * PromptBox 那种 CURSOR_MARKER 顾虑，可以放心用 truncateToWidth 做定宽 padding。
 */
export class PermissionDialog implements Component {
  readonly #theme: TuiTheme;
  readonly #content: PendingPermission;
  readonly #list: SelectList;

  constructor(theme: TuiTheme, content: PendingPermission, list: SelectList) {
    this.#theme = theme;
    this.#content = content;
    this.#list = list;
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  invalidate(): void {
    this.#list.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(8, width);
    const innerWidth = Math.max(1, safeWidth - 4);
    const lines: string[] = [];
    const push = (text: string): void => {
      lines.push(this.#boxLine(text, safeWidth, innerWidth));
    };

    lines.push(this.#theme.border(`╭${'─'.repeat(safeWidth - 2)}╮`));
    push(this.#theme.bold(`${toolLabel(this.#content.toolName)} 命令`));
    push('');
    for (const line of wrapTextWithAnsi(this.#content.summary, innerWidth)) push(`  ${line}`);
    if (this.#content.sandboxReason !== undefined) {
      push('');
      for (const line of wrapTextWithAnsi(`沙箱：${this.#content.sandboxReason}`, innerWidth)) {
        push(this.#theme.muted(line));
      }
    }
    if (this.#content.detail !== undefined) {
      for (const line of wrapTextWithAnsi(this.#content.detail, innerWidth)) {
        push(this.#theme.muted(line));
      }
    }
    push('');
    push('是否执行？');
    for (const line of this.#list.render(innerWidth)) push(line);
    lines.push(this.#theme.border(`╰${'─'.repeat(safeWidth - 2)}╯`));
    return lines;
  }

  #boxLine(text: string, width: number, innerWidth: number): string {
    const padded = truncateToWidth(text, innerWidth, '…', true);
    return `${this.#theme.border('│')} ${padded} ${this.#theme.border('│')}`;
  }
}
