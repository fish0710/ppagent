import { describe, expect, it } from 'vitest';
import { createTuiTheme, detectColorSupport } from '../src/app/tui/theme.js';

describe('detectColorSupport', () => {
  it('NO_COLOR wins over everything else', () => {
    expect(detectColorSupport({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('empty NO_COLOR does not count (matches the NO_COLOR spec)', () => {
    expect(detectColorSupport({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('FORCE_COLOR=0 disables color even on a TTY', () => {
    expect(detectColorSupport({ FORCE_COLOR: '0' }, true)).toBe(false);
  });

  it('FORCE_COLOR (non-zero) enables color even without a TTY', () => {
    expect(detectColorSupport({ FORCE_COLOR: '1' }, false)).toBe(true);
  });

  it('TERM=dumb disables color', () => {
    expect(detectColorSupport({ TERM: 'dumb' }, true)).toBe(false);
  });

  it('falls back to isTty when nothing else is set', () => {
    expect(detectColorSupport({}, true)).toBe(true);
    expect(detectColorSupport({}, false)).toBe(false);
  });
});

describe('createTuiTheme', () => {
  it('color:false makes every function (including sub-themes) the identity function', () => {
    const theme = createTuiTheme({ color: false });
    expect(theme.enabled).toBe(false);
    expect(theme.diffAdd('x')).toBe('x');
    expect(theme.diffRemove('x')).toBe('x');
    expect(theme.bold('x')).toBe('x');
    expect(theme.markdown.heading('x')).toBe('x');
    expect(theme.markdown.code('x')).toBe('x');
    expect(theme.selectList.selectedText('x')).toBe('x');
    expect(theme.editor.borderColor('x')).toBe('x');
    expect(theme.editor.selectList.description('x')).toBe('x');
  });

  it('color:true emits SGR codes with specific reset codes, never a blanket 0', () => {
    const theme = createTuiTheme({ color: true });
    expect(theme.enabled).toBe(true);
    expect(theme.diffAdd('x')).toBe('[32mx[39m');
    expect(theme.diffRemove('x')).toBe('[31mx[39m');
    expect(theme.bold('x')).toBe('[1mx[22m');
    expect(theme.dim('x')).toBe('[2mx[22m');
    for (const fn of [
      theme.dim, theme.bold, theme.italic, theme.user, theme.assistantMark,
      theme.toolMark, theme.toolErrorMark, theme.thinking, theme.ok, theme.warn,
      theme.error, theme.muted, theme.accent, theme.border, theme.diffAdd,
      theme.diffRemove, theme.diffMeta,
    ]) {
      expect(fn('x')).not.toContain('[0m');
    }
  });
});
