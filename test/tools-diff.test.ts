import { describe, expect, it } from 'vitest';
import { computeEditDiff } from '../src/core/tools/builtin/diff.js';

describe('computeEditDiff', () => {
  it('produces one hunk with a single add/remove pair for a simple replacement', () => {
    const original = 'line1\nline2\nline3\n';
    const diff = computeEditDiff(original, 'line2', 'line2-changed', false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(diff.hunks[0]!.lines).toEqual([
      { op: 'context', text: 'line1' },
      { op: 'remove', text: 'line2' },
      { op: 'add', text: 'line2-changed' },
      { op: 'context', text: 'line3' },
    ]);
  });

  it('handles a match at the very start of the file (no leading context)', () => {
    const diff = computeEditDiff('first\nsecond\n', 'first', 'FIRST', false);
    expect(diff.hunks[0]!.oldStart).toBe(1);
    expect(diff.hunks[0]!.lines[0]).toEqual({ op: 'remove', text: 'first' });
  });

  it('handles a match at EOF with no trailing newline', () => {
    const original = 'a\nb\nlast';
    const diff = computeEditDiff(original, 'last', 'LAST', false);
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    const lines = diff.hunks[0]!.lines;
    expect(lines.at(-2)).toEqual({ op: 'remove', text: 'last' });
    expect(lines.at(-1)).toEqual({ op: 'add', text: 'LAST' });
  });

  it('expands a multi-line oldText to cover every affected line', () => {
    const original = 'a\nb\nc\nd\n';
    const diff = computeEditDiff(original, 'b\nc', 'B\nC\nEXTRA', false);
    expect(diff.removed).toBe(2);
    expect(diff.added).toBe(3);
  });

  it('handles newText with fewer lines than oldText (net deletion)', () => {
    const original = 'a\nb\nc\nd\n';
    const diff = computeEditDiff(original, 'b\nc', 'B', false);
    expect(diff.removed).toBe(2);
    expect(diff.added).toBe(1);
  });

  it('handles an empty newText as a pure delete', () => {
    const original = 'keep\nremove-me\nkeep2\n';
    const diff = computeEditDiff(original, 'remove-me', '', false);
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1); // 该行变成空字符串，仍是一行
    expect(diff.hunks[0]!.lines).toContainEqual({ op: 'add', text: '' });
  });

  it('strips trailing \\r for CRLF files', () => {
    const original = 'a\r\nb\r\nc\r\n';
    const diff = computeEditDiff(original, 'b', 'B', false);
    expect(diff.hunks[0]!.lines).toContainEqual({ op: 'remove', text: 'b' });
    expect(diff.hunks[0]!.lines).toContainEqual({ op: 'add', text: 'B' });
  });

  it('merges two replaceAll matches on the same line into one hunk', () => {
    const original = 'foo foo\nother\n';
    const diff = computeEditDiff(original, 'foo', 'bar', true);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.hunks[0]!.lines).toContainEqual({ op: 'remove', text: 'foo foo' });
    expect(diff.hunks[0]!.lines).toContainEqual({ op: 'add', text: 'bar bar' });
  });

  it('merges replaceAll matches on nearby lines into one hunk when within context range', () => {
    const original = 'x\nfoo\ny\nfoo\nz\n';
    const diff = computeEditDiff(original, 'foo', 'bar', true, { contextLines: 3 });
    expect(diff.hunks).toHaveLength(1);
    expect(diff.removed).toBe(2);
    expect(diff.added).toBe(2);
  });

  it('keeps replaceAll matches far apart as separate hunks', () => {
    const lines = ['foo', ...Array.from({ length: 20 }, (_, i) => `filler${i}`), 'foo', ''];
    const original = lines.join('\n');
    const diff = computeEditDiff(original, 'foo', 'bar', true, { contextLines: 3 });
    expect(diff.hunks.length).toBeGreaterThan(1);
  });

  it('caps total DiffLine count at maxLines and reports truncatedLines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i}`);
    lines[25] = 'target';
    const original = `${lines.join('\n')}\n`;
    const diff = computeEditDiff(original, 'target', 'TARGET', false, {
      contextLines: 20,
      maxLines: 5,
    });
    const total = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    expect(total).toBe(5);
    expect(diff.truncatedLines).toBeGreaterThan(0);
  });

  it('does not report truncatedLines when under the cap', () => {
    const diff = computeEditDiff('a\nb\n', 'a', 'A', false);
    expect(diff.truncatedLines).toBeUndefined();
  });
});
