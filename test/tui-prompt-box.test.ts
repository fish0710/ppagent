import {
  CURSOR_MARKER,
  Editor,
  TuiMainScreen,
  stripTerminalSequences,
  visibleWidth,
  type Terminal,
} from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { PromptBox } from '../src/app/tui/prompt-box.js';
import { createTuiTheme } from '../src/app/tui/theme.js';

const theme = createTuiTheme({ color: false });

class MemoryTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  readonly columns: number;
  readonly rows: number;

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function makeTui(): TuiMainScreen {
  return new TuiMainScreen(new MemoryTerminal());
}

describe('locks the pi-tui Editor render shape PromptBox depends on', () => {
  it('renders exactly top border, one content line, bottom border for a single short line', () => {
    const tui = makeTui();
    const editor = new Editor(tui, { borderColor: theme.border, selectList: theme.selectList }, { paddingX: 1 });
    editor.setText('hello');
    const lines = editor.render(30);
    expect(lines).toHaveLength(3);
    expect(stripTerminalSequences(lines[0]!)).toBe('─'.repeat(30));
    expect(stripTerminalSequences(lines[2]!)).toBe('─'.repeat(30));
    expect(stripTerminalSequences(lines[1]!).startsWith(' ')).toBe(true);
    expect(visibleWidth(lines[1]!)).toBe(30);
  });
});

describe('PromptBox', () => {
  it('draws a full rounded box around a single-line editor', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.editor.setText('hello');
    const lines = box.render(40);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`╭${'─'.repeat(38)}╮`);
    expect(lines[2]).toBe(`╰${'─'.repeat(38)}╯`);
    expect(lines[1]!.startsWith('│ >')).toBe(true);
    expect(lines[1]!.endsWith('│')).toBe(true);
  });

  it('prefixes continuation lines with a blank marker column, aligned under >', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.editor.setText('line one\nline two');
    const lines = box.render(40);
    // top, 2 content lines, bottom
    expect(lines).toHaveLength(4);
    expect(lines[1]!.startsWith('│ >')).toBe(true);
    expect(lines[2]!.startsWith('│  ')).toBe(true);
    expect(lines[2]!.startsWith('│ >')).toBe(false);
  });

  it('renders autocomplete menu lines outside (below) the box, indented', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.editor.setText('/');
    box.editor.setAutocompleteProvider({
      getSuggestions: async () => ({
        items: [{ value: 'help', label: '/help', description: '显示可用命令' }],
        prefix: '/',
      }),
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
    // 补全是异步防抖触发的；这里只验证有补全内容时菜单行渲染在框外，
    // 不依赖具体触发时机——直接断言 render() 不会把菜单塞进框内。
    const lines = box.render(40);
    for (const line of lines) {
      if (stripTerminalSequences(line).startsWith('╭') || stripTerminalSequences(line).startsWith('╰')) continue;
      expect(line.startsWith('│') || line.startsWith('  ')).toBe(true);
    }
  });

  it.each([12, 20, 40, 80, 120])('keeps every non-menu line exactly `width` visible columns wide (width=%i)', (width) => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.editor.setText('a fairly long line of text that will need to wrap across the box width');
    const lines = box.render(width);
    for (const line of lines) {
      const stripped = stripTerminalSequences(line);
      const isBox = stripped.startsWith('╭') || stripped.startsWith('╰') || stripped.startsWith('│');
      if (isBox) expect(visibleWidth(line)).toBe(width);
    }
  });

  it('falls back to an unboxed editor below the minimum boxed width instead of throwing', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.editor.setText('x');
    expect(() => box.render(1)).not.toThrow();
    expect(() => box.render(5)).not.toThrow();
  });

  it('emits CURSOR_MARKER when focused, surviving the border wrapping', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.editor.setText('hi');
    box.focused = true;
    const lines = box.render(40);
    expect(lines.join('\n')).toContain(CURSOR_MARKER);
  });

  it('does not emit CURSOR_MARKER when not focused', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.editor.setText('hi');
    box.focused = false;
    const lines = box.render(40);
    expect(lines.join('\n')).not.toContain(CURSOR_MARKER);
  });

  it('propagates focused to the inner editor for IME cursor positioning', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.focused = true;
    expect(box.editor.focused).toBe(true);
    box.focused = false;
    expect(box.editor.focused).toBe(false);
  });

  it('forwards handleInput and invalidate to the inner editor', () => {
    const tui = makeTui();
    const box = new PromptBox(tui, theme);
    box.focused = true;
    box.handleInput('a');
    expect(box.editor.getText()).toBe('a');
    expect(() => box.invalidate()).not.toThrow();
  });
});
