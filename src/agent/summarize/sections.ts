/**
 * 解析与拼装压缩摘要里的 `## ` 分段。
 *
 * 这是"旧摘要是我们自己生成的、`##` 标题是我们定的"这条论据的落点：既然格式
 * 是我们控制的，约束与关键决策就不必每次压缩都重新经过模型转述 —— 从旧摘要里
 * 原样解析出来，模型只被要求追加"本段新出现的"，harness 负责合并。
 *
 * 与 core/context/prune.ts、core/context/files.ts 同一类模块：纯函数、不认识
 * llm/，但这个文件依赖摘要的模板格式（由 agent/summarize/llm.ts 定义），所以
 * 放在 agent/ 下而不是 core/context/ 下。
 */

export interface ParsedSummarySections {
  /** key 是小写、去首尾空白、去掉末尾冒号的标题；顺序与原文一致。 */
  readonly sections: ReadonlyMap<string, string>;
  /** 一个 `## ` 标题都没找到时为 false —— 调用方应把整段原文当不可解析处理。 */
  readonly matched: boolean;
}

const HEADING_LINE = /^##[ \t]+(.+?)[ \t]*$/;

/**
 * 按 `## Heading` 行切分文本。标题前的内容（例如模型没遵守"无前言"要求时
 * 多写的一句话）被丢弃 —— 不影响后续分段提取，也不需要特殊处理。
 */
export function parseSummarySections(text: string): ParsedSummarySections {
  const sections = new Map<string, string>();
  let currentKey: string | null = null;
  let currentLines: string[] = [];
  const flush = (): void => {
    if (currentKey !== null) {
      sections.set(currentKey, currentLines.join('\n').trim());
    }
  };
  for (const line of text.split('\n')) {
    const match = HEADING_LINE.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      currentKey = normalizeHeading(match[1]);
      currentLines = [];
    } else if (currentKey !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return { sections, matched: sections.size > 0 };
}

export function getSection(parsed: ParsedSummarySections, heading: string): string {
  return parsed.sections.get(normalizeHeading(heading)) ?? '';
}

function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase().replace(/:$/u, '');
}

/**
 * 合并搬运的旧内容与模型新写的内容：旧的在前且逐字保留，新的追加在后，
 * 精确重复（去空白、忽略大小写）的行被跳过。模型只能加，不能删改已冻结的条目
 * —— 这是"约束与关键决策永不因转述而丢失"这条不变量的实现。
 */
export function mergeCarriedSection(carried: string, incoming: string): string {
  const carriedLines = splitLines(carried);
  const seen = new Set(carriedLines.map(normalizeLine));
  const appended: string[] = [];
  for (const line of splitLines(incoming)) {
    const key = normalizeLine(line);
    if (seen.has(key)) continue;
    seen.add(key);
    appended.push(line);
  }
  return [...carriedLines, ...appended].join('\n');
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeLine(line: string): string {
  return line.trim().toLowerCase();
}

export interface AssembleSummaryOptions {
  goal: string;
  /** 已合并（搬运 + 新增）的约束正文；空串时整段不出现在输出里。 */
  constraints: string;
  nextSteps: string;
  /** 已合并的关键决策正文；空串时整段不出现在输出里。 */
  keyDecisions: string;
  facts: string;
  /** formatFileOperations() 的成品文本，可能是空串。 */
  fileOpsText: string;
  done: string;
  /**
   * 旧摘要解析失败时，把它的原文整块搬到这里，退化成完全保留而不是丢弃。
   * 只应该在"确实解析失败"时设置——正常路径下不传这个字段。
   */
  earlierContext?: string;
}

/**
 * 按"必保在前、可压在后"的顺序拼装最终摘要正文。Done 段放在最后：它是唯一
 * 授权被压缩/截断的段，任何尾部截断策略（包括极端情况下的整篇兜底截断）
 * 天然先牺牲它，而不会碰到 Constraints / Key decisions。
 */
export function assembleSummary(options: AssembleSummaryOptions): string {
  const blocks: string[] = [];
  if (nonEmpty(options.earlierContext)) {
    blocks.push(section('Earlier context (carried forward, unparsed)', options.earlierContext));
  }
  blocks.push(section('Goal', options.goal));
  if (nonEmpty(options.constraints)) {
    blocks.push(section('Constraints & preferences', options.constraints));
  }
  blocks.push(section('Next steps', options.nextSteps));
  if (nonEmpty(options.keyDecisions)) {
    blocks.push(section('Key decisions', options.keyDecisions));
  }
  if (nonEmpty(options.facts)) blocks.push(section('Facts to carry forward', options.facts));
  if (options.fileOpsText.trim().length > 0) blocks.push(options.fileOpsText.trim());
  if (nonEmpty(options.done)) blocks.push(section('Done', options.done));
  return blocks.join('\n\n');
}

function section(heading: string, body: string): string {
  return `## ${heading}\n${body.trim()}`;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
