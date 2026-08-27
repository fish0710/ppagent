import { describe, expect, it, vi } from 'vitest';
import {
  createTuiCommands,
  parseSlashCommand,
  toAutocompleteCommands,
  UNKNOWN_HOST_INFO,
  type TuiCommandContext,
  type TuiHostInfo,
  type TuiSessionPort,
} from '../src/app/tui/commands.js';
import { createInitialTuiState, type TuiState } from '../src/app/tui/state.js';
import type { ToolDef } from '../src/core/types.js';

const commands = createTuiCommands();

function fakeSession(overrides: Partial<TuiSessionPort> = {}): TuiSessionPort {
  return {
    prompt: vi.fn(async () => ({ context: { messages: [] }, reason: 'stop' as const, turns: 1 })),
    compact: vi.fn(async () => null),
    abort: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    setInteraction: vi.fn(),
    listTools: vi.fn(() => []),
    ...overrides,
  };
}

function fakeContext(overrides: Partial<TuiCommandContext> = {}): {
  ctx: TuiCommandContext;
  emitted: string[];
  exited: { value: boolean };
} {
  const emitted: string[] = [];
  const exited = { value: false };
  const ctx: TuiCommandContext = {
    session: fakeSession(),
    state: createInitialTuiState(),
    info: UNKNOWN_HOST_INFO,
    emit: (text) => emitted.push(text),
    requestExit: () => { exited.value = true; },
    ...overrides,
  };
  return { ctx, emitted, exited };
}

describe('parseSlashCommand', () => {
  it('returns null for plain text that does not start with /', () => {
    expect(parseSlashCommand('hello world', commands)).toBeNull();
  });

  it('matches a registered command with no arguments', () => {
    const result = parseSlashCommand('/help', commands);
    expect(result).toMatchObject({ kind: 'match', args: '' });
    if (result?.kind !== 'match') throw new Error('expected match');
    expect(result.command.name).toBe('help');
  });

  it('splits arguments after the first space and trims them', () => {
    const result = parseSlashCommand('/compact   focus on the auth module  ', commands);
    expect(result).toMatchObject({ kind: 'match', args: 'focus on the auth module' });
  });

  it('does not confuse /compacted with /compact (exact word match only)', () => {
    const result = parseSlashCommand('/compacted', commands);
    expect(result).toEqual({ kind: 'unknown', name: 'compacted' });
  });

  it('reports an unrecognized command as unknown rather than falling through silently', () => {
    expect(parseSlashCommand('/nope', commands)).toEqual({ kind: 'unknown', name: 'nope' });
  });
});

describe('toAutocompleteCommands', () => {
  it('maps every registered command to a pi-tui SlashCommand entry', () => {
    const items = toAutocompleteCommands(commands);
    expect(items.map((item) => item.name)).toEqual(commands.map((c) => c.name));
    const compact = items.find((item) => item.name === 'compact');
    expect(compact).toMatchObject({ description: expect.any(String), argumentHint: '[说明]' });
  });
});

describe('/help', () => {
  it('lists every registered command with its description', async () => {
    const { ctx, emitted } = fakeContext();
    const help = commands.find((c) => c.name === 'help')!;
    const result = await help.run('', ctx);
    expect(result).toEqual({ prompt: null });
    expect(emitted.some((line) => line.includes('/compact'))).toBe(true);
    expect(emitted.some((line) => line.includes('/exit'))).toBe(true);
    expect(emitted.length).toBe(commands.length + 1); // +1 for the leading "可用命令：" line
  });
});

describe('/compact', () => {
  it('forwards non-empty args to session.compact', async () => {
    const session = fakeSession();
    const { ctx } = fakeContext({ session });
    const compact = commands.find((c) => c.name === 'compact')!;
    await compact.run('聚焦 auth 模块', ctx);
    expect(session.compact).toHaveBeenCalledWith('聚焦 auth 模块');
  });

  it('passes undefined when no args are given', async () => {
    const session = fakeSession();
    const { ctx } = fakeContext({ session });
    const compact = commands.find((c) => c.name === 'compact')!;
    await compact.run('', ctx);
    expect(session.compact).toHaveBeenCalledWith(undefined);
  });
});

describe('/exit and /quit', () => {
  it.each(['exit', 'quit'])('%s calls requestExit and completes without a prompt', (name) => {
    const { ctx, exited } = fakeContext();
    const command = commands.find((c) => c.name === name)!;
    const result = command.run('', ctx);
    expect(result).toEqual({ prompt: null });
    expect(exited.value).toBe(true);
  });
});

describe('/cost', () => {
  it('renders accumulated usage and turn count', () => {
    const state: TuiState = {
      ...createInitialTuiState(),
      turn: 3,
      totalUsage: { input: 4200, output: 800, cacheRead: 100, cacheWrite: 0 },
    };
    const { ctx, emitted } = fakeContext({ state });
    const cost = commands.find((c) => c.name === 'cost')!;
    cost.run('', ctx);
    expect(emitted[0]).toContain('4.2k');
    expect(emitted[0]).toContain('800');
    expect(emitted[0]).toContain('3 轮');
  });
});

describe('/status', () => {
  it('renders provider/model, cwd, context and permission/sandbox info', () => {
    const info: TuiHostInfo = {
      version: '0.1.0',
      cwd: '/repo',
      provider: 'lmstudio',
      model: 'qwen3.6-27b',
      contextWindow: 8000,
      tokenizer: 'o200k_base',
      tokenizerPrecision: 'exact',
      permissionMode: 'interactive',
      sandbox: 'macos',
      sessionId: 'sess-1',
    };
    const state: TuiState = { ...createInitialTuiState(), contextTokens: 4200 };
    const { ctx, emitted } = fakeContext({ info, state });
    const status = commands.find((c) => c.name === 'status')!;
    status.run('', ctx);
    expect(emitted.join('\n')).toContain('lmstudio/qwen3.6-27b');
    expect(emitted.join('\n')).toContain('/repo');
    expect(emitted.join('\n')).toContain('上下文 4.2k/8k');
    expect(emitted.join('\n')).toContain('interactive');
    expect(emitted.join('\n')).toContain('macos');
    expect(emitted.join('\n')).toContain('sess-1');
  });

  it('omits the session line when sessionId is absent', () => {
    const { ctx, emitted } = fakeContext();
    const status = commands.find((c) => c.name === 'status')!;
    status.run('', ctx);
    expect(emitted.some((line) => line.startsWith('会话 '))).toBe(false);
  });
});

describe('/tools', () => {
  it('lists tools from session.listTools()', () => {
    const tools: ToolDef[] = [
      { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
      { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object' } },
    ];
    const session = fakeSession({ listTools: () => tools });
    const { ctx, emitted } = fakeContext({ session });
    const toolsCommand = commands.find((c) => c.name === 'tools')!;
    toolsCommand.run('', ctx);
    expect(emitted).toEqual([
      'read — Read a file.',
      'bash — Run a shell command.',
    ]);
  });
});

describe('/init', () => {
  it('returns a synthesized prompt instead of emitting inline text', () => {
    const { ctx, emitted } = fakeContext();
    const init = commands.find((c) => c.name === 'init')!;
    const result = init.run('', ctx);
    expect(emitted).toEqual([]);
    expect(result).not.toEqual({ prompt: null });
    if ('then' in result) throw new Error('expected a synchronous result');
    expect(result.prompt).toContain('AGENTS.md');
  });
});
