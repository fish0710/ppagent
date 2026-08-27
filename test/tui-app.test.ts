import type { Terminal } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { TuiApp } from '../src/app/tui/app.js';
import { createTuiCommands, type TuiSessionPort } from '../src/app/tui/commands.js';
import { TuiTerminalRenderer } from '../src/app/tui/render.js';
import { createTuiTheme } from '../src/app/tui/theme.js';
import type { AgentLoopResult } from '../src/core/loop/index.js';

class MemoryTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  readonly columns = 80;
  readonly rows = 24;
  #onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void): void {
    this.#onInput = onInput;
  }

  stop(): void {
    this.#onInput = undefined;
  }

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

  send(data: string): void {
    this.#onInput?.(data);
  }
}

function typeAndSubmit(terminal: MemoryTerminal, text: string): void {
  for (const char of text) terminal.send(char);
  terminal.send('\r');
}

/** 真实定时器让出一次宏任务边界，保证之前排队的微任务链（含 finally 块和
 *  循环回到 readPrompt()）已经跑完，而不是靠猜微任务跳数。 */
function flushAsync(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STOP_RESULT: AgentLoopResult = {
  context: { messages: [] },
  reason: 'stop',
  turns: 1,
};

function fakeSession(overrides: Partial<TuiSessionPort> = {}): TuiSessionPort {
  return {
    prompt: vi.fn(async () => STOP_RESULT),
    compact: vi.fn(async () => null),
    abort: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    setInteraction: vi.fn(),
    listTools: vi.fn(() => []),
    ...overrides,
  };
}

describe('TuiApp slash command dispatch', () => {
  it('rejects an unrecognized slash command instead of sending it to the model', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme: createTuiTheme({ color: false }) });
    const session = fakeSession();
    const app = new TuiApp({ renderer, commands: createTuiCommands() });

    const runPromise = app.run(session);
    typeAndSubmit(terminal, '/nope');
    await vi.waitFor(() =>
      expect(
        renderer.state.blocks.some(
          (block) => block.kind === 'notice' && block.text.includes('未知命令 /nope'),
        ),
      ).toBe(true),
    );
    typeAndSubmit(terminal, '/exit');
    const result = await runPromise;

    expect(session.prompt).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it('sends a plain (non-slash) message to the model as-is', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme: createTuiTheme({ color: false }) });
    const session = fakeSession();
    const app = new TuiApp({ renderer, commands: createTuiCommands() });

    const runPromise = app.run(session);
    typeAndSubmit(terminal, '帮我看一下 auth 的实现');
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    typeAndSubmit(terminal, '/exit');
    await runPromise;

    expect(session.prompt).toHaveBeenCalledWith('帮我看一下 auth 的实现');
  });

  it('runs /compact through session.compact without calling session.prompt', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme: createTuiTheme({ color: false }) });
    const session = fakeSession();
    const app = new TuiApp({ renderer, commands: createTuiCommands() });

    const runPromise = app.run(session);
    typeAndSubmit(terminal, '/compact focus on auth');
    await vi.waitFor(() => expect(session.compact).toHaveBeenCalledTimes(1));
    typeAndSubmit(terminal, '/exit');
    await runPromise;

    expect(session.compact).toHaveBeenCalledWith('focus on auth');
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('sends the synthesized /init prompt to the model rather than the literal "/init" text', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme: createTuiTheme({ color: false }) });
    const session = fakeSession();
    const app = new TuiApp({ renderer, commands: createTuiCommands() });

    const runPromise = app.run(session);
    typeAndSubmit(terminal, '/init');
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    typeAndSubmit(terminal, '/exit');
    await runPromise;

    const [sentPrompt] = (session.prompt as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(sentPrompt).not.toBe('/init');
    expect(sentPrompt).toContain('AGENTS.md');
  });

  it('/exit ends the run loop with exit code 0 when idle', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme: createTuiTheme({ color: false }) });
    const session = fakeSession();
    const app = new TuiApp({ renderer, commands: createTuiCommands() });

    const runPromise = app.run(session);
    typeAndSubmit(terminal, '/exit');
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(session.prompt).not.toHaveBeenCalled();
  });
});

describe('TuiApp esc-to-abort', () => {
  it('esc aborts the in-flight turn (single-stage) without exiting the app', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme: createTuiTheme({ color: false }) });
    let resolvePrompt: ((value: AgentLoopResult) => void) | undefined;
    const pending = new Promise<AgentLoopResult>((resolve) => { resolvePrompt = resolve; });
    const session = fakeSession({ prompt: vi.fn(() => pending) });
    const app = new TuiApp({ renderer, commands: createTuiCommands() });

    const runPromise = app.run(session);
    typeAndSubmit(terminal, '帮我看看代码');
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));

    terminal.send('\x1b');
    await vi.waitFor(() => expect(session.abort).toHaveBeenCalledTimes(1));

    resolvePrompt?.(STOP_RESULT);
    await flushAsync();
    typeAndSubmit(terminal, '/exit');
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it('esc does nothing while idle (no in-flight turn to abort)', async () => {
    const terminal = new MemoryTerminal();
    const renderer = new TuiTerminalRenderer({ terminal, theme: createTuiTheme({ color: false }) });
    const session = fakeSession();
    const app = new TuiApp({ renderer, commands: createTuiCommands() });

    const runPromise = app.run(session);
    terminal.send('\x1b');
    await flushAsync();
    typeAndSubmit(terminal, '/exit');
    await runPromise;

    expect(session.abort).not.toHaveBeenCalled();
  });
});
