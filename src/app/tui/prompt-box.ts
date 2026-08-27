import {
  Editor,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type EditorOptions,
  type Focusable,
  type TUI,
} from '@earendil-works/pi-tui';
import type { TuiTheme } from './theme.js';

/** 低于这个宽度就放弃画框，退化成裸 Editor——负数 repeat 会直接抛错。 */
const MIN_BOXED_WIDTH = 12;
/** 左右边框各占 1 列，加一个外侧前导空格和一个 marker 列。 */
const FRAME_WIDTH = 4;

const SCROLL_LABEL_PATTERN = /([↑↓]\s+\d+\s+more)/u;

/**
 * 把 pi-tui 的 Editor（本身只画上下两条横线）包成完整的圆角方框。
 *
 * 依赖三条 pi-tui 未文档化但已核实的行为（见 editor.js render()）：
 * 1. 顶/底两行永远是纯横线或 "─── ↑/↓ N more ─…" 滚动提示，用 borderColor 包裹；
 * 2. paddingX>=1 时，内容行和补全菜单行都以 paddingX 个空格开头；
 * 3. 补全菜单紧跟在底部边框之后。
 * 用 test/tui-prompt-box.test.ts 的契约锁定测试防止 pi-tui 升级悄悄改变这个形状。
 */
export class PromptBox implements Component, Focusable {
  readonly editor: Editor;
  readonly #theme: TuiTheme;
  #focused = false;

  constructor(tui: TUI, theme: TuiTheme, options: EditorOptions = {}) {
    this.#theme = theme;
    this.editor = new Editor(
      tui,
      { borderColor: theme.border, selectList: theme.selectList },
      { paddingX: 1, autocompleteMaxVisible: 8, ...options },
    );
  }

  get focused(): boolean {
    return this.#focused;
  }

  /** pi-tui README「容器组件必须把 focused 转发给内部 Input/Editor」的要求——
   *  否则 IME 候选窗会定位到错误的位置。 */
  set focused(value: boolean) {
    this.#focused = value;
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    if (width < MIN_BOXED_WIDTH) return this.editor.render(Math.max(1, width));

    const lines = this.editor.render(width - FRAME_WIDTH);
    const bottom = lines.findIndex((line, index) => index > 0 && isBorderLine(line));
    if (bottom === -1) {
      // pi-tui 换了渲染形状；降级到不带框的裸 Editor，而不是崩溃。
      return this.editor.render(width);
    }

    const content = lines.slice(1, bottom);
    const menu = lines.slice(bottom + 1);
    const out: string[] = [];

    out.push(outerBorder('╭', '╮', lines[0]!, width, this.#theme));
    content.forEach((line, index) => {
      const marker = index === 0 ? this.#theme.accent('>') : ' ';
      // 内容行绝不能跑 truncateToWidth/stripTerminalSequences——那会把
      // CURSOR_MARKER（零宽 APC 序列）一起丢掉，IME 候选窗就会定位到错误位置。
      out.push(`${this.#theme.border('│')} ${marker}${line}${this.#theme.border('│')}`);
    });
    out.push(outerBorder('╰', '╯', lines[bottom]!, width, this.#theme));
    for (const line of menu) out.push(`  ${line}`);
    return out;
  }
}

function isBorderLine(line: string): boolean {
  return stripTerminalSequences(line).startsWith('─');
}

function outerBorder(
  cornerLeft: string,
  cornerRight: string,
  editorBorderLine: string,
  width: number,
  theme: TuiTheme,
): string {
  const dashes = Math.max(0, width - 2);
  const plain = theme.border(`${cornerLeft}${'─'.repeat(dashes)}${cornerRight}`);
  const match = SCROLL_LABEL_PATTERN.exec(stripTerminalSequences(editorBorderLine));
  if (match === null) return plain;
  const label = ` ${match[1]} `;
  const labelWidth = visibleWidth(label);
  const leftDashes = 2;
  const rightDashes = dashes - leftDashes - labelWidth;
  if (rightDashes < 0) return plain;
  return (
    theme.border(`${cornerLeft}${'─'.repeat(leftDashes)}`) +
    label +
    theme.border(`${'─'.repeat(rightDashes)}${cornerRight}`)
  );
}
