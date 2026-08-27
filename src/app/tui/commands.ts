import type { SlashCommand } from '@earendil-works/pi-tui';
import type { AgentSession } from '../../agent/session.js';
import { formatContext, formatTokenCount } from './format.js';
import type { TuiState } from './state.js';

/**
 * 定义在这里而不是 app.ts，避免 app.ts <-> commands.ts 的循环 import——
 * app.ts 需要 createTuiCommands()/parseSlashCommand() 等值导出，
 * commands.ts 需要这个类型，两边互相 import 会形成环。
 */
export type TuiSessionPort = Pick<
  AgentSession,
  'prompt' | 'compact' | 'abort' | 'subscribe' | 'setInteraction' | 'listTools'
>;

/** bin/agent.ts 注入；只用标量与 core/types.ts 的类型，不破坏 TUI 的分层约束。 */
export interface TuiHostInfo {
  version: string;
  cwd: string;
  provider: string;
  model: string;
  contextWindow: number;
  tokenizer: string;
  tokenizerPrecision: 'exact' | 'approximate';
  permissionMode: string;
  sandbox: 'macos' | 'passthrough';
  sessionId?: string;
}

export const UNKNOWN_HOST_INFO: TuiHostInfo = {
  version: '0.0.0',
  cwd: '.',
  provider: 'unknown',
  model: 'unknown',
  contextWindow: 0,
  tokenizer: 'unknown',
  tokenizerPrecision: 'approximate',
  permissionMode: 'interactive',
  sandbox: 'passthrough',
};

export interface TuiCommandContext {
  readonly session: TuiSessionPort;
  readonly state: TuiState;
  readonly info: TuiHostInfo;
  /** 就地输出一行说明性文字；追加到 transcript，不发给模型。 */
  emit(text: string): void;
  requestExit(): void;
}

export interface TuiCommandResult {
  /** 非空则作为 prompt 发给模型；null 表示命令已就地完成。 */
  readonly prompt: string | null;
}

export interface TuiCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  run(args: string, ctx: TuiCommandContext): Promise<TuiCommandResult> | TuiCommandResult;
}

const DONE: TuiCommandResult = { prompt: null };

export function createTuiCommands(): readonly TuiCommand[] {
  const commands: TuiCommand[] = [];
  commands.push(
    {
      name: 'help',
      description: '显示可用的斜杠命令',
      run(_args, ctx) {
        ctx.emit('可用命令：');
        for (const command of commands) {
          const hint = command.argumentHint === undefined ? '' : ` ${command.argumentHint}`;
          ctx.emit(`  /${command.name}${hint} — ${command.description}`);
        }
        return DONE;
      },
    },
    {
      name: 'compact',
      description: '手动压缩上下文，可选补充说明本次摘要重点',
      argumentHint: '[说明]',
      async run(args, ctx) {
        await ctx.session.compact(args.length === 0 ? undefined : args);
        return DONE;
      },
    },
    {
      name: 'exit',
      description: '退出 TUI',
      run(_args, ctx) {
        ctx.requestExit();
        return DONE;
      },
    },
    {
      name: 'quit',
      description: '退出 TUI',
      run(_args, ctx) {
        ctx.requestExit();
        return DONE;
      },
    },
    {
      name: 'cost',
      description: '显示本次会话累计的 token 用量',
      run(_args, ctx) {
        const usage = ctx.state.totalUsage;
        ctx.emit(
          `累计用量：输入 ${formatTokenCount(usage.input)} · 输出 ${formatTokenCount(
            usage.output,
          )} · 缓存读 ${formatTokenCount(usage.cacheRead)} · 缓存写 ${formatTokenCount(
            usage.cacheWrite,
          )}（共 ${ctx.state.turn} 轮）`,
        );
        return DONE;
      },
    },
    {
      name: 'status',
      description: '显示当前模型、目录与上下文状态',
      run(_args, ctx) {
        const info = ctx.info;
        ctx.emit(`${info.provider}/${info.model} · ppagent ${info.version}`);
        ctx.emit(`目录 ${info.cwd}`);
        const context = formatContext(ctx.state.contextTokens, info.contextWindow);
        ctx.emit(
          `${context === '' ? '上下文未知' : context} · tokenizer ${info.tokenizer}（${
            info.tokenizerPrecision === 'exact' ? '精确' : '近似'
          }）`,
        );
        ctx.emit(`权限模式 ${info.permissionMode} · 沙箱 ${info.sandbox}`);
        if (info.sessionId !== undefined) ctx.emit(`会话 ${info.sessionId}`);
        return DONE;
      },
    },
    {
      name: 'tools',
      description: '列出已注册的工具',
      run(_args, ctx) {
        for (const tool of ctx.session.listTools()) {
          ctx.emit(`${tool.name} — ${tool.description}`);
        }
        return DONE;
      },
    },
    {
      name: 'init',
      description: '检查或生成项目的 AGENTS.md',
      run() {
        return {
          prompt:
            '请检查当前项目根目录是否存在 AGENTS.md（或等价的项目说明文件）。如果不存在，' +
            '请阅读代码库并创建一份，说明项目结构、构建/测试命令和关键约定；如果已存在，' +
            '请通读一遍，视需要补充遗漏的重要信息。',
        };
      },
    },
  );
  return commands;
}

export type SlashCommandMatch =
  | { kind: 'match'; command: TuiCommand; args: string }
  | { kind: 'unknown'; name: string };

/**
 * 任何以 '/' 开头的输入都当成命令尝试来解析；命中已注册命令返回 match，
 * 否则返回 unknown（调用方应该拒绝并提示，而不是把它当普通文本发给模型——
 * 这是刻意对齐 Claude Code 的行为）。不以 '/' 开头的输入返回 null，走正常
 * prompt 路径。
 */
export function parseSlashCommand(
  input: string,
  commands: readonly TuiCommand[],
): SlashCommandMatch | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).slice(1);
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) return { kind: 'unknown', name };
  return { kind: 'match', command, args };
}

/** 喂给 pi-tui 的 CombinedAutocompleteProvider，驱动 '/' 斜杠菜单。 */
export function toAutocompleteCommands(commands: readonly TuiCommand[]): SlashCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
  }));
}
