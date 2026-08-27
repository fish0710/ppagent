import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';

export interface TuiTheme {
  readonly enabled: boolean;
  dim(s: string): string;
  bold(s: string): string;
  italic(s: string): string;
  user(s: string): string;
  assistantMark(s: string): string;
  toolMark(s: string): string;
  toolErrorMark(s: string): string;
  thinking(s: string): string;
  ok(s: string): string;
  warn(s: string): string;
  error(s: string): string;
  muted(s: string): string;
  accent(s: string): string;
  border(s: string): string;
  diffAdd(s: string): string;
  diffRemove(s: string): string;
  diffMeta(s: string): string;
  readonly markdown: MarkdownTheme;
  readonly selectList: SelectListTheme;
  readonly editor: EditorTheme;
}

export interface TuiThemeOptions {
  color?: boolean;
}

/**
 * 纯函数：终端能力判定不读 process.env 之外的任何东西，方便测三种环境组合。
 * 优先级：NO_COLOR > FORCE_COLOR=0 > FORCE_COLOR(其他) > TERM=dumb > isTty。
 */
export function detectColorSupport(
  env: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] === '0') return false;
  if (env['FORCE_COLOR'] !== undefined) return true;
  if (env['TERM'] === 'dumb') return false;
  return isTty;
}

const identity = (s: string): string => s;

/**
 * 只用 8/16 色（30–37、90–97）+ bold/dim/italic，不用 256 色或 truecolor——
 * 让用户终端自己的调色板决定色相，明暗主题天然都对，也就不需要异步的
 * queryTerminalColorScheme（那个查询在 start() 之后才有结果，中途切主题
 * 会重写已提交的行，直接违反“transcript 只追加不修改”的约束）。
 *
 * 每个 helper 用具体的关闭码（22/23/24/39），不用 0 —— 全量 reset 会把
 * Markdown/Editor 自己正在用的样式一起清掉。
 */
function sgr(open: number, close: number): (s: string) => string {
  return (s: string): string => `[${open}m${s}[${close}m`;
}

export function createTuiTheme(options: TuiThemeOptions = {}): TuiTheme {
  const enabled =
    options.color ??
    detectColorSupport(process.env, process.stdout.isTTY === true);

  if (!enabled) {
    return {
      enabled: false,
      dim: identity,
      bold: identity,
      italic: identity,
      user: identity,
      assistantMark: identity,
      toolMark: identity,
      toolErrorMark: identity,
      thinking: identity,
      ok: identity,
      warn: identity,
      error: identity,
      muted: identity,
      accent: identity,
      border: identity,
      diffAdd: identity,
      diffRemove: identity,
      diffMeta: identity,
      markdown: identityMarkdownTheme(),
      selectList: identitySelectListTheme(),
      editor: { borderColor: identity, selectList: identitySelectListTheme() },
    };
  }

  const dim = sgr(2, 22);
  const bold = sgr(1, 22);
  const italic = sgr(3, 23);
  const underline = sgr(4, 24);
  const red = sgr(31, 39);
  const green = sgr(32, 39);
  const yellow = sgr(33, 39);
  const cyan = sgr(36, 39);
  const gray = sgr(90, 39);

  const muted = gray;
  const accent = cyan;
  const diffMeta = dim;

  const markdown: MarkdownTheme = {
    heading: bold,
    link: (s) => underline(cyan(s)),
    linkUrl: dim,
    code: cyan,
    codeBlock: identity,
    codeBlockBorder: dim,
    quote: (s) => italic(dim(s)),
    quoteBorder: dim,
    hr: dim,
    listBullet: dim,
    bold,
    italic,
    strikethrough: sgr(9, 29),
    underline,
  };

  const selectList: SelectListTheme = {
    selectedPrefix: (s) => bold(accent(s)),
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  };

  return {
    enabled: true,
    dim,
    bold,
    italic,
    user: dim,
    assistantMark: bold,
    toolMark: bold,
    toolErrorMark: (s) => bold(red(s)),
    thinking: (s) => italic(dim(s)),
    ok: green,
    warn: yellow,
    error: red,
    muted,
    accent,
    border: dim,
    diffAdd: green,
    diffRemove: red,
    diffMeta,
    markdown,
    selectList,
    editor: { borderColor: dim, selectList },
  };
}

function identityMarkdownTheme(): MarkdownTheme {
  return {
    heading: identity,
    link: identity,
    linkUrl: identity,
    code: identity,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  };
}

function identitySelectListTheme(): SelectListTheme {
  return {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  };
}
