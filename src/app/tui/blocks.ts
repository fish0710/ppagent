import { Markdown, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type {
  CompactTrigger,
  LoopEndReason,
  PermissionDecision,
  ResourceSnapshot,
  ToolCallId,
  ToolDisplay,
  Usage,
} from '../../core/types.js';
import {
  formatContext,
  formatDuration,
  formatRate,
  formatTokenCount,
} from './format.js';
import type { TuiTheme } from './theme.js';

/** 单调递增，由 reducer 派生（不用 Date/random，保持纯）；渲染缓存的 key。 */
export type BlockId = number;

export type TranscriptBlock = { readonly id: BlockId } & TranscriptBlockBody;

export type TranscriptBlockBody =
  | { kind: 'user'; text: string }
  /** 一段完整的 markdown（段落/列表/围栏），来自 segmentMarkdown 的切分。 */
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      toolId: ToolCallId;
      name: string;
      /** describeTool(name, args) 的结果，来自 tool_start。 */
      summary: string;
      isError: boolean;
      durationMs: number;
      preview: string;
      display?: ToolDisplay;
    }
  | {
      kind: 'permission';
      summary: string;
      detail?: string;
      sandboxReason?: string;
      decision: PermissionDecision;
    }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | {
      kind: 'compaction';
      variant: 'prune' | 'summarize' | 'skipped';
      trigger: CompactTrigger;
      tokensBefore?: number;
      tokensAfter?: number;
      prunedCount?: number;
      strategy?: string;
      resourceSource?: ResourceSnapshot['source'];
      reason?: string;
    }
  | { kind: 'admissionDenied'; reason: string; retryAfterMs: number | null }
  | {
      kind: 'metrics';
      usage: Usage;
      decodeMs?: number;
      contextTokens?: number;
      contextWindow?: number;
    }
  | { kind: 'loopEnd'; reason: LoopEndReason }
  | { kind: 'error'; text: string };

export interface TuiRenderOptions {
  showThinking: boolean;
  thinkingMaxLines: number;
}

export const DEFAULT_RENDER_OPTIONS: TuiRenderOptions = {
  showThinking: false,
  thinkingMaxLines: 12,
};

const RESULT_PREFIX = '  ⎿  ';
const RESULT_CONTINUATION = '     ';
const MAX_BASH_PREVIEW_LINES = 6;

/** 纯函数：一个 block -> 若干行；无 IO、无缓存（缓存在 IO 边的 Transcript 组件里）。 */
export function renderBlock(
  block: TranscriptBlock,
  width: number,
  theme: TuiTheme,
  options: TuiRenderOptions = DEFAULT_RENDER_OPTIONS,
): readonly string[] {
  const safeWidth = Math.max(1, width);
  switch (block.kind) {
    case 'user':
      return renderPrefixedLines(block.text.split('\n'), '> ', '  ', theme.user, safeWidth);
    case 'assistant':
      return renderMarkdownBlock(block.text, '⏺ ', theme.assistantMark, theme, safeWidth);
    case 'thinking':
      return options.showThinking
        ? renderThinkingBlock(block.text, theme, safeWidth, options.thinkingMaxLines)
        : [];
    case 'tool':
      return renderToolBlock(block, theme, safeWidth);
    case 'permission':
      return renderPermissionBlock(block, theme, safeWidth);
    case 'notice':
      return renderNoticeBlock(block, theme, safeWidth);
    case 'compaction':
      return renderCompactionBlock(block, theme, safeWidth);
    case 'admissionDenied':
      return renderWrapped(
        `${theme.error('⊘')} ${formatAdmissionDenied(block.reason, block.retryAfterMs)}`,
        safeWidth,
      );
    case 'metrics':
      return renderMetricsBlock(block, theme, safeWidth);
    case 'loopEnd':
      return renderLoopEndBlock(block.reason, theme, safeWidth);
    case 'error':
      return renderWrapped(`${theme.error('⊘')} ${theme.error(block.text)}`, safeWidth);
  }
}

function renderPrefixedLines(
  lines: readonly string[],
  firstPrefix: string,
  restPrefix: string,
  style: (s: string) => string,
  width: number,
): string[] {
  const out: string[] = [];
  lines.forEach((line, index) => {
    const prefix = index === 0 ? firstPrefix : restPrefix;
    const available = Math.max(1, width - visibleLength(prefix));
    const wrapped = wrapTextWithAnsi(style(line), available);
    if (wrapped.length === 0) {
      out.push(style(prefix));
      return;
    }
    wrapped.forEach((wrappedLine, wrapIndex) => {
      out.push(`${style(wrapIndex === 0 ? prefix : restPrefix)}${wrappedLine}`);
    });
  });
  return out;
}

function renderMarkdownBlock(
  text: string,
  marker: string,
  markerStyle: (s: string) => string,
  theme: TuiTheme,
  width: number,
): string[] {
  const indent = visibleLength(marker);
  const contentWidth = Math.max(1, width - indent);
  const markdown = new Markdown(text, 0, 0, theme.markdown);
  const lines = markdown.render(contentWidth);
  if (lines.length === 0) return [];
  return lines.map((line, index) =>
    index === 0 ? `${markerStyle(marker)}${line}` : `${' '.repeat(indent)}${line}`,
  );
}

function renderThinkingBlock(
  text: string,
  theme: TuiTheme,
  width: number,
  maxLines: number,
): string[] {
  const lines = wrapTextWithAnsi(text, Math.max(1, width - 2));
  const shown = lines.slice(0, maxLines);
  const omitted = lines.length - shown.length;
  const out = shown.map((line) => `  ${theme.thinking(line)}`);
  if (omitted > 0) out.push(`  ${theme.thinking(`… (${omitted} 行已折叠)`)}`);
  return out;
}

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

function toolArgsText(name: string, summary: string): string {
  const prefix = name === 'spawn_subagent' ? '子 agent ' : `${name} `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

function renderToolBlock(
  block: Extract<TranscriptBlockBody, { kind: 'tool' }>,
  theme: TuiTheme,
  width: number,
): string[] {
  const mark = block.isError ? theme.toolErrorMark('⊘') : theme.toolMark('⏺');
  const label = theme.bold(toolLabel(block.name));
  const args = toolArgsText(block.name, block.summary);
  const header = truncateToWidth(`${mark} ${label}(${args})`, width, '…');
  const body = renderToolResultLines(block, theme, width);
  return [header, ...body];
}

function renderToolResultLines(
  block: Extract<TranscriptBlockBody, { kind: 'tool' }>,
  theme: TuiTheme,
  width: number,
): string[] {
  const lines = toolResultContentLines(block, theme);
  return renderResultLines(lines, width);
}

function renderResultLines(lines: readonly string[], width: number): string[] {
  const out: string[] = [];
  lines.forEach((line, index) => {
    const prefix = index === 0 ? RESULT_PREFIX : RESULT_CONTINUATION;
    const available = Math.max(1, width - visibleLength(prefix));
    out.push(`${prefix}${truncateToWidth(line, available, '…')}`);
  });
  return out;
}

function toolResultContentLines(
  block: Extract<TranscriptBlockBody, { kind: 'tool' }>,
  theme: TuiTheme,
): string[] {
  const display = block.display;
  if (display === undefined) return [theme.muted(oneLinePreview(block.preview))];
  switch (display.kind) {
    case 'diff':
      return renderDiffLines(display, theme);
    case 'write':
      return [
        theme.muted(`Wrote ${display.lines} line(s) to ${display.path}`),
      ];
    case 'read':
      return [theme.muted(renderReadSummary(display))];
    case 'bash':
      return renderBashLines(block.preview, display, theme);
  }
}

function oneLinePreview(preview: string): string {
  return preview.replace(/\s*\n\s*/gu, ' ↵ ').trim();
}

function renderReadSummary(display: Extract<ToolDisplay, { kind: 'read' }>): string {
  if (display.offset === undefined) return `Read ${display.lines} line(s)`;
  return `Read ${display.lines} line(s) (offset ${display.offset} of ${display.totalLines})`;
}

function renderBashLines(
  preview: string,
  display: Extract<ToolDisplay, { kind: 'bash' }>,
  theme: TuiTheme,
): string[] {
  const previewLines = preview.split('\n');
  const shown = previewLines.slice(0, MAX_BASH_PREVIEW_LINES);
  const totalOutputLines = display.stdoutLines + display.stderrLines;
  const omitted = Math.max(0, totalOutputLines - (shown.length - 1));
  const styled = shown.map((line) => (display.exitCode === 0 ? theme.muted(line) : theme.error(line)));
  if (omitted > 0) styled.push(theme.muted(`… +${omitted} lines`));
  return styled;
}

function renderDiffLines(
  display: Extract<ToolDisplay, { kind: 'diff' }>,
  theme: TuiTheme,
): string[] {
  const header = theme.muted(
    `Updated ${display.path} with ${display.added} addition(s) and ${display.removed} removal(s)`,
  );
  const gutterWidth = diffGutterWidth(display);
  const lines: string[] = [header];
  for (const hunk of display.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      switch (line.op) {
        case 'context':
          lines.push(
            `${theme.diffMeta(String(oldLine).padStart(gutterWidth))}    ${line.text}`,
          );
          oldLine += 1;
          newLine += 1;
          break;
        case 'remove':
          lines.push(
            `${theme.diffMeta(String(oldLine).padStart(gutterWidth))} ${theme.diffRemove(`-  ${line.text}`)}`,
          );
          oldLine += 1;
          break;
        case 'add':
          lines.push(
            `${theme.diffMeta(String(newLine).padStart(gutterWidth))} ${theme.diffAdd(`+  ${line.text}`)}`,
          );
          newLine += 1;
          break;
      }
    }
  }
  if (display.truncatedLines !== undefined) {
    lines.push(theme.muted(`… +${display.truncatedLines} lines (已截断)`));
  }
  return lines;
}

function diffGutterWidth(display: Extract<ToolDisplay, { kind: 'diff' }>): number {
  let max = 1;
  for (const hunk of display.hunks) {
    const endOld = hunk.oldStart + hunk.lines.filter((l) => l.op !== 'add').length;
    const endNew = hunk.newStart + hunk.lines.filter((l) => l.op !== 'remove').length;
    max = Math.max(max, endOld, endNew);
  }
  return Math.max(4, String(max).length);
}

const PERMISSION_LABELS: Readonly<Record<PermissionDecision, string>> = {
  allow: '已允许',
  allowAlways: '已允许，本会话不再询问',
  deny: '已拒绝',
};

function renderPermissionBlock(
  block: Extract<TranscriptBlockBody, { kind: 'permission' }>,
  theme: TuiTheme,
  width: number,
): string[] {
  const mark = block.decision === 'deny' ? theme.toolErrorMark('⊘') : theme.toolMark('⏺');
  const header = truncateToWidth(`${mark} ${block.summary}`, width, '…');
  const resultLines: string[] = [PERMISSION_LABELS[block.decision]];
  if (block.sandboxReason !== undefined) resultLines.push(`沙箱：${block.sandboxReason}`);
  if (block.detail !== undefined) resultLines.push(block.detail);
  return [header, ...renderResultLines(resultLines.map((line) => theme.muted(line)), width)];
}

function renderNoticeBlock(
  block: Extract<TranscriptBlockBody, { kind: 'notice' }>,
  theme: TuiTheme,
  width: number,
): string[] {
  const icon = block.level === 'info' ? 'ℹ' : block.level === 'warn' ? '⚠' : '⊘';
  const style = block.level === 'info' ? theme.accent : block.level === 'warn' ? theme.warn : theme.error;
  return renderWrapped(`${style(icon)} ${style(block.text)}`, width);
}

function renderCompactionBlock(
  block: Extract<TranscriptBlockBody, { kind: 'compaction' }>,
  theme: TuiTheme,
  width: number,
): string[] {
  return renderWrapped(`${theme.accent('⟳')} ${theme.muted(formatCompaction(block))}`, width);
}

function formatCompaction(block: Extract<TranscriptBlockBody, { kind: 'compaction' }>): string {
  if (block.variant === 'skipped') {
    return `未压缩：${block.reason ?? ''}`;
  }
  const trigger =
    block.trigger === 'memory' ? '内存压力' : block.trigger === 'token' ? '上下文阈值' : '手动触发';
  const label = block.variant === 'prune' ? '剪枝' : '压缩';
  const detail = [
    trigger,
    ...(block.strategy === undefined ? [] : [block.strategy]),
    ...(block.variant === 'prune' && block.prunedCount !== undefined
      ? [`${block.prunedCount} 条工具输出`]
      : []),
    ...(block.resourceSource === undefined ? [] : [resourceLabel(block.resourceSource)]),
  ].join(' · ');
  const before = block.tokensBefore === undefined ? '' : formatTokenCount(block.tokensBefore);
  const after = block.tokensAfter === undefined ? '' : formatTokenCount(block.tokensAfter);
  return `${label} ${before}→${after}（${detail}）`;
}

function resourceLabel(source: ResourceSnapshot['source']): string {
  switch (source) {
    case 'memory_pressure':
      return 'memory_pressure';
    case 'vm_stat':
      return 'vm_stat';
    case 'system':
      return 'system';
    case 'test':
      return 'test probe';
  }
}

function formatAdmissionDenied(reason: string, retryAfterMs: number | null): string {
  const retry = retryAfterMs === null ? '' : `，建议 ${formatDuration(retryAfterMs)} 后重试`;
  return `子 agent 被拒：${reason}${retry}`;
}

function renderMetricsBlock(
  block: Extract<TranscriptBlockBody, { kind: 'metrics' }>,
  theme: TuiTheme,
  width: number,
): string[] {
  const parts: string[] = [];
  if (block.decodeMs !== undefined && block.decodeMs > 0 && block.usage.output > 0) {
    const seconds = Math.max(block.decodeMs / 1_000, 0.001);
    parts.push(`${formatRate(block.usage.output / seconds)} tok/s`);
  }
  const context = formatContext(block.contextTokens, block.contextWindow);
  if (context !== '') parts.push(context);
  if (parts.length === 0) return [];
  return renderWrapped(`  ${theme.muted(`↳ ${parts.join(' · ')}`)}`, width);
}

function renderLoopEndBlock(reason: LoopEndReason, theme: TuiTheme, width: number): string[] {
  switch (reason) {
    case 'aborted':
      return renderWrapped(`${theme.warn('⏹')} ${theme.warn('已取消')}`, width);
    case 'maxTurns':
      return renderWrapped(`${theme.error('⊘')} ${theme.error('已达到最大轮数')}`, width);
    case 'error':
      return renderWrapped(`${theme.error('⊘')} ${theme.error('Agent 因错误停止')}`, width);
    case 'stop':
      return [];
  }
}

function renderWrapped(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, width);
  return wrapped.length === 0 ? [''] : wrapped;
}

function visibleLength(prefix: string): number {
  // 前缀在本文件里始终是不含 ANSI 的纯文本（marker/缩进），可以直接用字符串长度。
  return Array.from(prefix).length;
}
