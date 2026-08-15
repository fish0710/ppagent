const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});
const markPattern = /^\p{Mark}+$/u;
const emojiPattern = /\p{Extended_Pictographic}/u;

/** 计算不含 ANSI 的终端列宽；组合字符为 0，CJK/emoji 为 2。 */
export function stringWidth(value: string): number {
  let width = 0;
  for (const grapheme of graphemes(value)) width += graphemeWidth(grapheme);
  return width;
}

/** 从左侧裁剪，绝不切开 emoji ZWJ 序列或双列字符。 */
export function clipToWidth(value: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(value) <= width) return value;
  if (width === 1) return '…';
  let used = 0;
  let result = '';
  for (const grapheme of graphemes(value)) {
    const next = graphemeWidth(grapheme);
    if (used + next > width - 1) break;
    result += grapheme;
    used += next;
  }
  return `${result}…`;
}

/** live 文本优先展示最新尾部；开头用省略号标明并非完整正文。 */
export function clipTailToWidth(value: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(value) <= width) return value;
  if (width === 1) return '…';
  const segments = graphemes(value);
  let used = 0;
  let result = '';
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const grapheme = segments[index];
    if (grapheme === undefined) continue;
    const next = graphemeWidth(grapheme);
    if (used + next > width - 1) break;
    result = `${grapheme}${result}`;
    used += next;
  }
  return `…${result}`;
}

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map((part) => part.segment);
}

function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 0 || markPattern.test(grapheme)) return 0;
  if (emojiPattern.test(grapheme)) return 2;
  const codePoint = grapheme.codePointAt(0);
  return codePoint !== undefined && isWideCodePoint(codePoint) ? 2 : 1;
}

// 与 wcwidth/string-width 使用的宽字符区间保持同一保守方向；TUI 不画边框，
// 这里只负责保证 live 行不会因 CJK/emoji 被按 UTF-16 长度错误截断而换行。
function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}
