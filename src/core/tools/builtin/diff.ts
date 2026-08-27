import type { DiffHunk, DiffLine } from '../../types.js';

export interface EditDiffOptions {
  /** 命中行前后各贴多少行原文上下文。 */
  contextLines?: number;
  /** DiffLine 总数上限；超出的部分被丢弃，只报告数量。 */
  maxLines?: number;
}

export interface EditDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  truncatedLines?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_LINES = 400;

interface MatchRange {
  start: number;
  end: number;
}

/**
 * 行边界不变量：本模块里所有 lineStart/lineEnd 都是"某一行的起始偏移"
 * （0、或紧跟在某个 '\n' 之后），lineEnd 允许等于 text.length（EOF）。
 * 这样 text.slice(a, b)（a、b 都是行边界）天然是"若干整行 + 各自的换行符"，
 * 只有文件末尾且无尾随换行时最后一行没有 '\n'。splitLines() 就是按这个不变量写的。
 */
interface LineRange {
  lineStart: number;
  lineEnd: number;
}

/**
 * edit 工具的替换位置是确定的（indexOf 扫描得到），不需要通用 LCS diff 算法——
 * 通用算法在大文件上是不必要的 O(n·m) 内存代价，而且不保证描述的是同一处改动。
 * 把每处命中扩展到整行边界，被覆盖的整行是 remove，替换后的整行是 add；
 * 相近但不相邻的改动之间的未变行作为 context 保留，不会被误判成"删了又加回来"。
 */
export function computeEditDiff(
  original: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  options?: EditDiffOptions,
): EditDiff {
  const contextLines = options?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const matches = findMatches(original, oldText, replaceAll);

  // 第一步：把命中扩展到整行边界，真正重叠/同一行的命中合并成一个"改动区"。
  const regions = mergeOverlappingRegions(matches, original);

  // 第二步：改动区之间的未变行如果足够短（<= 2×contextLines），合并进同一个
  // hunk 并原样显示；否则各自成 hunk（与 git diff 的 hunk 合并规则一致）。
  const hunkGroups = clusterRegions(regions, original, contextLines);

  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let totalLines = 0;
  let truncatedLines = 0;
  let cumulativeLineDelta = 0;

  for (const group of hunkGroups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const contextStart = backNLines(original, first.lineStart, contextLines);
    const contextEnd = forwardNLines(original, last.lineEnd, contextLines);

    const lines: DiffLine[] = [];
    for (const text of splitLines(original.slice(contextStart, first.lineStart))) {
      lines.push({ op: 'context', text });
    }

    let hunkAdded = 0;
    let hunkRemoved = 0;
    for (let i = 0; i < group.length; i += 1) {
      const region = group[i]!;
      if (i > 0) {
        const previous = group[i - 1]!;
        for (const text of splitLines(original.slice(previous.lineEnd, region.lineStart))) {
          lines.push({ op: 'context', text });
        }
      }
      const removedLines = splitLines(original.slice(region.lineStart, region.lineEnd));
      const addedText = applyReplacementWithinRange(
        original,
        region,
        matches,
        newText,
        replaceAll,
      );
      const addedLines = splitLines(addedText);
      for (const text of removedLines) lines.push({ op: 'remove', text });
      for (const text of addedLines) lines.push({ op: 'add', text });
      hunkRemoved += removedLines.length;
      hunkAdded += addedLines.length;
    }

    for (const text of splitLines(original.slice(last.lineEnd, contextEnd))) {
      lines.push({ op: 'context', text });
    }

    removed += hunkRemoved;
    added += hunkAdded;

    const oldStart = lineNumberAtBoundary(original, contextStart) + 1;
    const newStart = oldStart + cumulativeLineDelta;
    cumulativeLineDelta += hunkAdded - hunkRemoved;

    const keep: DiffLine[] = [];
    for (const line of lines) {
      if (totalLines < maxLines) {
        keep.push(line);
      } else {
        truncatedLines += 1;
      }
      totalLines += 1;
    }
    if (keep.length > 0) hunks.push({ oldStart, newStart, lines: keep });
  }

  return {
    hunks,
    added,
    removed,
    ...(truncatedLines > 0 ? { truncatedLines } : {}),
  };
}

function findMatches(text: string, needle: string, replaceAll: boolean): MatchRange[] {
  const matches: MatchRange[] = [];
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found === -1) break;
    matches.push({ start: found, end: found + needle.length });
    offset = found + needle.length;
    if (!replaceAll) break;
  }
  return matches;
}

function expandToLineBoundary(text: string, match: MatchRange): LineRange {
  return {
    lineStart: lineStartBoundary(text, match.start),
    lineEnd: lineEndBoundary(text, match.end),
  };
}

/** 偏移所在行的起始边界：0，或紧跟在前一个 '\n' 之后。 */
function lineStartBoundary(text: string, offset: number): number {
  const idx = text.lastIndexOf('\n', Math.max(0, offset - 1));
  return idx === -1 ? 0 : idx + 1;
}

/** 偏移所在行结束后的边界：紧跟在该行 '\n' 之后，或 text.length（EOF 无尾换行）。 */
function lineEndBoundary(text: string, offset: number): number {
  const idx = text.indexOf('\n', offset);
  return idx === -1 ? text.length : idx + 1;
}

/** 把命中扩展到整行后，真正重叠/同一行的命中合并成一个改动区；不重叠的保持独立。 */
function mergeOverlappingRegions(matches: MatchRange[], text: string): LineRange[] {
  const expanded = matches.map((match) => expandToLineBoundary(text, match));
  const merged: LineRange[] = [];
  for (const region of expanded) {
    const last = merged[merged.length - 1];
    if (last !== undefined && region.lineStart < last.lineEnd) {
      last.lineEnd = Math.max(last.lineEnd, region.lineEnd);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/**
 * 把彼此间隔不超过 2×contextLines 行的改动区分到同一个 hunk 里——间隔行会
 * 作为真实 context 显示，而不是被拆成两个 hunk 之间的省略号。
 */
function clusterRegions(
  regions: LineRange[],
  text: string,
  contextLines: number,
): LineRange[][] {
  if (regions.length === 0) return [];
  const groups: LineRange[][] = [[regions[0]!]];
  for (let i = 1; i < regions.length; i += 1) {
    const region = regions[i]!;
    const currentGroup = groups[groups.length - 1]!;
    const previous = currentGroup[currentGroup.length - 1]!;
    const gapThreshold = forwardNLines(text, previous.lineEnd, contextLines * 2);
    if (region.lineStart <= gapThreshold) {
      currentGroup.push(region);
    } else {
      groups.push([region]);
    }
  }
  return groups;
}

/** 从行边界 boundary 起往后数 n 行，返回新的行边界（不越过 text.length）。 */
function forwardNLines(text: string, boundary: number, n: number): number {
  let pos = boundary;
  for (let i = 0; i < n && pos < text.length; i += 1) {
    const nl = text.indexOf('\n', pos);
    pos = nl === -1 ? text.length : nl + 1;
  }
  return pos;
}

/** 从行边界 boundary 起往前数 n 行，返回新的行边界（不越过 0）。 */
function backNLines(text: string, boundary: number, n: number): number {
  let pos = boundary;
  for (let i = 0; i < n && pos > 0; i += 1) {
    pos = lineStartBoundary(text, pos - 1);
  }
  return pos;
}

/** boundary 之前的完整行数（0-based 行号）；只依赖 '\n' 计数，CRLF 下同样成立。 */
function lineNumberAtBoundary(text: string, boundary: number): number {
  let count = 0;
  let idx = text.indexOf('\n');
  while (idx !== -1 && idx < boundary) {
    count += 1;
    idx = text.indexOf('\n', idx + 1);
  }
  return count;
}

/**
 * 一个改动区内可能包含多处命中（同一行两处替换）；按顺序把区内每处命中替换成
 * newText，未命中的原文原样保留，再拼回整行边界，得到该区替换后的完整内容。
 */
function applyReplacementWithinRange(
  original: string,
  range: LineRange,
  matches: MatchRange[],
  newText: string,
  replaceAll: boolean,
): string {
  const relevant = matches.filter(
    (match) => match.start >= range.lineStart && match.end <= range.lineEnd,
  );
  if (relevant.length === 0) return original.slice(range.lineStart, range.lineEnd);
  let result = '';
  let cursor = range.lineStart;
  for (const match of relevant) {
    result += original.slice(cursor, match.start);
    result += newText;
    cursor = match.end;
    if (!replaceAll) break;
  }
  result += original.slice(cursor, range.lineEnd);
  return result;
}

/**
 * text 必须是零或多个"整行边界到整行边界"的切片（每行含自己的尾随 '\n'，
 * 除非是文件末尾且无尾随换行的最后一行）。据此不变量拆行，不产生多余的空尾行。
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split('\n').map((line) => line.replace(/\r$/u, ''));
}
