import { describe, expect, it } from 'vitest';
import { StubAdmissionController } from '../src/agent/admission/index.js';
import { StubPermissionPolicy } from '../src/agent/permissions/index.js';
import {
  FauxProvider,
  textTurn,
  toolCallTurn,
  type FauxTurn,
} from '../src/core/llm/faux.js';
import { runAgentLoop, type AgentLoopOptions } from '../src/core/loop/index.js';
import { PassthroughSandbox } from '../src/core/sandbox/passthrough.js';
import type {
  Interaction,
  Tool,
  ToolCallBlock,
  TraceContext,
  UIEvent,
} from '../src/core/types.js';
import { textOutput } from '../src/core/tools/execute.js';
import { ToolRegistry } from '../src/core/tools/registry.js';

describe('agent loop', () => {
  it('reassembles tool arguments split across more than 20 chunks', async () => {
    const rawArguments = '{"value":"abcdefghijklmnopqrstuvwxyz"}';
    const firstTurn = toolCallTurn({
      id: 'split-call',
      name: 'probe',
      rawArguments,
      argumentChunkSize: 1,
    });
    expect(
      firstTurn.steps.filter((step) => step.type === 'toolcall_delta'),
    ).toHaveLength(rawArguments.length);
    expect(rawArguments.length).toBeGreaterThan(20);

    // 终态故意放错参数，确保 loop 使用增量片段重组，而不是偷读 toolcall_end。
    for (const step of firstTurn.steps) {
      if (step.type === 'toolcall_end') {
        step.call.arguments = { value: 'wrong-terminal-value' };
      }
    }
    let received: unknown;
    const registry = new ToolRegistry([
      probeTool((args) => {
        received = args;
      }),
    ]);
    const provider = new FauxProvider({
      turns: [firstTurn, textTurn('finished')],
    });
    const events: UIEvent[] = [];

    const result = await runAgentLoop(
      loopOptions(provider, registry, events),
    );

    expect(received).toEqual({ value: 'abcdefghijklmnopqrstuvwxyz' });
    expect(result.reason).toBe('stop');
    expect(result.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    expect(events.filter((event) => event.type === 'turn_end')).toMatchObject([
      { turn: 1, stopReason: 'toolUse' },
      { turn: 2, stopReason: 'stop' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'loop_end', reason: 'stop', turns: 2 });
  });

  it('emits an explicit maxTurns termination after the last tool round', async () => {
    const provider = new FauxProvider({
      turns: [
        toolCallTurn({ name: 'probe', rawArguments: '{"value":"again"}' }),
      ],
    });
    const events: UIEvent[] = [];
    const result = await runAgentLoop({
      ...loopOptions(provider, new ToolRegistry([probeTool()]), events),
      loopConfig: { maxTurns: 1, turnTimeoutMs: 1_000 },
    });

    expect(result.reason).toBe('maxTurns');
    expect(events.at(-1)).toEqual({
      type: 'loop_end',
      reason: 'maxTurns',
      turns: 1,
    });
  });

  it('emits an explicit aborted termination when the user cancels', async () => {
    const controller = new AbortController();
    const provider = new FauxProvider({
      turns: [textTurn('too slow', { delayMs: 100 })],
    });
    const events: UIEvent[] = [];
    const execution = runAgentLoop(
      loopOptions(provider, new ToolRegistry([probeTool()]), events, controller),
    );
    setTimeout(() => controller.abort(new Error('cancelled by test')), 5);

    const result = await execution;

    expect(result.reason).toBe('aborted');
    expect(events).toContainEqual({
      type: 'turn_end',
      turn: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'aborted',
    });
    expect(events.at(-1)).toEqual({
      type: 'loop_end',
      reason: 'aborted',
      turns: 1,
    });
  });

  it.each([
    '<tool_call>{"name":"probe","arguments":{"value":"x"}}</tool_call>',
    '{"name":"probe","arguments":{"value":"x"}}',
  ])('diagnoses a text-encoded tool call: %s', async (text) => {
    const provider = new FauxProvider({ turns: [textTurn(text)] });
    const events: UIEvent[] = [];
    const result = await runAgentLoop(
      loopOptions(provider, new ToolRegistry([probeTool()]), events),
    );

    expect(result.reason).toBe('error');
    expect(events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('may not support native tool calling'),
    });
    expect(events.at(-1)).toEqual({
      type: 'loop_end',
      reason: 'error',
      turns: 1,
    });
  });

  it('does not mistake ordinary prose containing JSON for a tool call', async () => {
    const provider = new FauxProvider({
      turns: [
        textTurn(
          'Example payload: {"name":"probe","arguments":{"value":"x"}}',
        ),
      ],
    });
    const events: UIEvent[] = [];
    const result = await runAgentLoop(
      loopOptions(provider, new ToolRegistry([probeTool()]), events),
    );

    expect(result.reason).toBe('stop');
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('runs concurrency-safe calls in parallel with a configured limit', async () => {
    let active = 0;
    let peak = 0;
    const tool = probeTool(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(20);
      active -= 1;
    });
    const provider = new FauxProvider({
      turns: [multiToolTurn(), textTurn('done')],
    });
    const events: UIEvent[] = [];

    const result = await runAgentLoop({
      ...loopOptions(provider, new ToolRegistry([tool]), events),
      maxToolConcurrency: 2,
    });

    expect(result.reason).toBe('stop');
    expect(peak).toBe(2);
    expect(events.filter((event) => event.type === 'tool_start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2);
  });
});

function loopOptions(
  provider: FauxProvider,
  registry: ToolRegistry,
  events: UIEvent[],
  controller = new AbortController(),
): AgentLoopOptions {
  return {
    provider,
    model: provider.listModels()[0]!,
    context: {
      messages: [{ role: 'user', content: 'test task', timestamp: 1 }],
    },
    registry,
    toolContext: {
      signal: controller.signal,
      cwd: process.cwd(),
      trace: TRACE,
      interaction: INTERACTION,
    },
    toolDeps: {
      admission: new StubAdmissionController(),
      permissions: new StubPermissionPolicy(),
      sandbox: new PassthroughSandbox(),
    },
    toolOptions: { maxResultChars: 2_000, toolTimeoutMs: 1_000 },
    loopConfig: { maxTurns: 4, turnTimeoutMs: 1_000 },
    maxToolConcurrency: 2,
    emit: (event) => events.push(event),
  };
}

function probeTool(
  inspect: (args: unknown) => void | Promise<void> = () => undefined,
): Tool {
  return {
    name: 'probe',
    description: 'Record one value.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    concurrencySafe: true,
    prepareSandbox: (args) => ({ allowed: true, args }),
    async execute(args) {
      await inspect(args);
      return textOutput('recorded');
    },
  };
}

function multiToolTurn(): FauxTurn {
  const first = toolCall('call-1', 'one');
  const second = toolCall('call-2', 'two');
  return {
    steps: [
      { type: 'toolcall_start', index: 0 },
      { type: 'toolcall_delta', index: 0, delta: '{"value":"one"}' },
      { type: 'toolcall_end', index: 0, call: first },
      { type: 'toolcall_start', index: 1 },
      { type: 'toolcall_delta', index: 1, delta: '{"value":"two"}' },
      { type: 'toolcall_end', index: 1, call: second },
      {
        type: 'done',
        message: {
          role: 'assistant',
          content: [first, second],
          stopReason: 'toolUse',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          timestamp: 2,
        },
      },
    ],
  };
}

function toolCall(id: string, value: string): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'probe',
    arguments: { value },
  };
}

const TRACE: TraceContext = {
  traceId: 'trace',
  spanId: 'span',
  child(name) {
    return { ...this, spanId: name };
  },
};

const INTERACTION: Interaction = {
  confirm: async () => false,
  ask: async () => null,
  select: async () => null,
  notify: () => undefined,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
