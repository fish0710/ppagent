import { describe, expect, it, vi } from 'vitest';
import { StubAdmissionController } from '../src/agent/admission/index.js';
import { StubPermissionPolicy } from '../src/agent/permissions/index.js';
import {
  StructuralSummarizer,
  ThresholdCompactPolicy,
} from '../src/core/context/compact.js';
import { O200kTokenCounter } from '../src/core/context/tokenizer.js';
import {
  FauxProvider,
  lengthTurn,
  textTurn,
  toolCallTurn,
  toolCallsTurn,
} from '../src/core/llm/faux.js';
import { runAgentLoop, type AgentLoopOptions } from '../src/core/loop/index.js';
import { PassthroughSandbox } from '../src/core/sandbox/passthrough.js';
import {
  InMemorySpanExporter,
  createTraceContext,
} from '../src/core/telemetry/index.js';
import type {
  Interaction,
  Message,
  Tool,
  TraceContext,
  UIEvent,
} from '../src/core/types.js';
import { passthroughPrepare, textOutput } from '../src/core/tools/execute.js';
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
      loopConfig: { maxTurns: 1, turnTimeoutMs: 1_000, maxLengthContinuations: 2 },
    });

    expect(result.reason).toBe('maxTurns');
    expect(events.at(-1)).toEqual({
      type: 'loop_end',
      reason: 'maxTurns',
      turns: 1,
    });
  });

  it('continues automatically after a length-truncated response and finishes normally', async () => {
    const provider = new FauxProvider({
      turns: [lengthTurn('partial output'), textTurn('done')],
    });
    const events: UIEvent[] = [];
    const result = await runAgentLoop(
      loopOptions(provider, new ToolRegistry([probeTool()]), events),
    );

    expect(result.reason).toBe('stop');
    expect(result.context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notify',
        level: 'info',
        message: expect.stringContaining('continuing automatically'),
      }),
    );
    expect(events.at(-1)).toEqual({ type: 'loop_end', reason: 'stop', turns: 2 });
  });

  it('fails once maxLengthContinuations is exhausted', async () => {
    const provider = new FauxProvider({
      turns: [
        lengthTurn('first chunk'),
        lengthTurn('second chunk'),
        lengthTurn('third chunk'),
      ],
    });
    const events: UIEvent[] = [];
    const result = await runAgentLoop({
      ...loopOptions(provider, new ToolRegistry([probeTool()]), events),
      loopConfig: { maxTurns: 8, turnTimeoutMs: 1_000, maxLengthContinuations: 2 },
    });

    expect(result.reason).toBe('error');
    expect(events.at(-1)).toMatchObject({
      type: 'loop_end',
      reason: 'error',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('automatic continuation'),
      }),
    );
  });

  it('reports maxTurns instead of error when length hits the turn budget', async () => {
    const provider = new FauxProvider({
      turns: [lengthTurn('only chunk')],
    });
    const events: UIEvent[] = [];
    const result = await runAgentLoop({
      ...loopOptions(provider, new ToolRegistry([probeTool()]), events),
      loopConfig: { maxTurns: 1, turnTimeoutMs: 1_000, maxLengthContinuations: 2 },
    });

    expect(result.reason).toBe('maxTurns');
  });

  it('emits an explicit aborted termination when the user cancels', async () => {
    const controller = new AbortController();
    const exporter = new InMemorySpanExporter();
    const provider = new FauxProvider({
      turns: [textTurn('too slow', { delayMs: 100 })],
    });
    const events: UIEvent[] = [];
    const execution = runAgentLoop({
      ...loopOptions(
        provider,
        new ToolRegistry([probeTool()]),
        events,
        controller,
      ),
      telemetry: { exporter },
    });
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
    expect(exporter.spans.map((span) => span.name).sort()).toEqual([
      'agent.loop',
      'agent.turn',
      'model.stream',
    ]);
    expect(
      exporter.spans.find((span) => span.name === 'model.stream')?.error,
    ).toContain('aborted');
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
      turns: [
        toolCallsTurn({
          calls: [
            { id: 'call-1', name: 'probe', rawArguments: '{"value":"one"}' },
            { id: 'call-2', name: 'probe', rawArguments: '{"value":"two"}' },
          ],
        }),
        textTurn('done'),
      ],
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

  it('uses unsafe calls as barriers between concurrency-safe batches', async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const concurrencyAtStart = new Map<string, number>();
    const record = async (args: unknown): Promise<void> => {
      const value = (args as { value: string }).value;
      active += 1;
      peak = Math.max(peak, active);
      concurrencyAtStart.set(value, active);
      order.push(`${value}:start`);
      await delay(value.startsWith('s') && value !== 's3' ? 20 : 2);
      order.push(`${value}:end`);
      active -= 1;
    };
    const provider = new FauxProvider({
      turns: [
        toolCallsTurn({
          calls: [
            { name: 'safe', rawArguments: '{"value":"s1"}' },
            { name: 'safe', rawArguments: '{"value":"s2"}' },
            { name: 'unsafe', rawArguments: '{"value":"u1"}' },
            { name: 'safe', rawArguments: '{"value":"s3"}' },
          ],
        }),
        textTurn('done'),
      ],
    });
    const events: UIEvent[] = [];

    const result = await runAgentLoop({
      ...loopOptions(
        provider,
        new ToolRegistry([
          namedTool('safe', true, record),
          namedTool('unsafe', false, record),
        ]),
        events,
      ),
      maxToolConcurrency: 2,
    });

    expect(result.reason).toBe('stop');
    expect(new Set(order.slice(0, 2))).toEqual(
      new Set(['s1:start', 's2:start']),
    );
    expect(peak).toBe(2);
    const unsafeStart = order.indexOf('u1:start');
    expect(order.indexOf('s1:end')).toBeLessThan(unsafeStart);
    expect(order.indexOf('s2:end')).toBeLessThan(unsafeStart);
    expect(concurrencyAtStart.get('u1')).toBe(1);
    expect(order.indexOf('u1:end')).toBeLessThan(order.indexOf('s3:start'));
    expect(concurrencyAtStart.get('s3')).toBe(1);
  });

  it('compacts before a model turn and persists the replacement record', async () => {
    const provider = new FauxProvider({ turns: [textTurn('done')] });
    const events: UIEvent[] = [];
    const compacted = [] as Parameters<
      NonNullable<AgentLoopOptions['persistence']>['appendCompaction']
    >[0][];
    const persistedMessages: Message[][] = [];
    const tokenCounter = new O200kTokenCounter();
    const base = loopOptions(provider, new ToolRegistry([probeTool()]), events);

    const result = await runAgentLoop({
      ...base,
      context: {
        messages: Array.from({ length: 8 }, (_, index) => ({
          role: 'user' as const,
          content: `history ${index} ${'long context '.repeat(8)}`,
          timestamp: index,
        })),
      },
      compaction: {
        tokenCounter,
        policy: new ThresholdCompactPolicy({
          config: {
            compactThreshold: 0.2,
            memPressureThreshold: 0.75,
            keepRecentMessages: 2,
          },
          tokenCounter,
        }),
        summarizer: new StructuralSummarizer({ tokenCounter }),
        contextWindow: 100,
        targetTokens: 40,
      },
      persistence: {
        async appendMessages(messages) {
          persistedMessages.push([...messages]);
        },
        async appendCompaction(record) {
          compacted.push(record);
        },
      },
    });

    expect(result.reason).toBe('stop');
    expect(events.some((event) => event.type === 'compacted')).toBe(true);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.meta.strategy).toBe('structural');
    expect(result.context.messages[0]).toMatchObject({ role: 'user' });
    expect(result.context.messages).toHaveLength(4);
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]?.[0]).toMatchObject({ role: 'assistant' });
  });

  it('samples resource pressure per turn and records a memory-triggered compact', async () => {
    const provider = new FauxProvider({ turns: [textTurn('done')] });
    const events: UIEvent[] = [];
    const tokenCounter = new O200kTokenCounter();
    const exporter = new InMemorySpanExporter();
    const snapshot = vi.fn(async () => ({
      source: 'test' as const,
      memPressure: 0.9,
      memAvailableMB: 1_024,
      gpuBusy: false,
      activeSubagents: 0,
      sampledAt: 10,
    }));
    const base = loopOptions(provider, new ToolRegistry(), events);

    const result = await runAgentLoop({
      ...base,
      context: {
        messages: Array.from({ length: 8 }, (_, index) => ({
          role: 'user' as const,
          content: `history ${index} ${'memory context '.repeat(8)}`,
          timestamp: index,
        })),
      },
      telemetry: { exporter },
      compaction: {
        tokenCounter,
        policy: new ThresholdCompactPolicy({
          config: {
            compactThreshold: 1,
            memPressureThreshold: 0.75,
            keepRecentMessages: 2,
          },
          tokenCounter,
        }),
        summarizer: new StructuralSummarizer({ tokenCounter }),
        contextWindow: 1_000_000,
        targetTokens: 40,
        resourceProbe: { snapshot },
      },
    });

    expect(result.reason).toBe('stop');
    expect(snapshot).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'compacted',
        trigger: 'memory',
        resourceSource: 'test',
      }),
    );
    expect(exporter.spans).toContainEqual(
      expect.objectContaining({
        name: 'context.compact',
        attrs: expect.objectContaining({
          'resource.sample_source': 'test',
          'resource.mem_pressure': 0.9,
          'resource.mem_available_mb': 1_024,
          'context.trigger': 'memory',
        }),
      }),
    );
  });

  it('exports parented turn, model, and tool spans', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new FauxProvider({
      turns: [
        toolCallTurn({ name: 'probe', rawArguments: '{"value":"x"}' }),
        textTurn('done'),
      ],
    });
    const events: UIEvent[] = [];
    const options = loopOptions(
      provider,
      new ToolRegistry([probeTool()]),
      events,
    );
    options.toolContext.trace = createTraceContext({
      traceId: 'trace',
      spanId: 'root',
    });

    const result = await runAgentLoop({
      ...options,
      telemetry: { exporter },
    });

    expect(result.reason).toBe('stop');
    const spans = exporter.spans;
    expect(spans.filter((span) => span.name === 'agent.loop')).toHaveLength(1);
    expect(spans.filter((span) => span.name === 'agent.turn')).toHaveLength(2);
    expect(spans.filter((span) => span.name === 'model.stream')).toHaveLength(2);
    expect(spans.filter((span) => span.name === 'tool.execute')).toHaveLength(1);
    const toolSpan = spans.find((span) => span.name === 'tool.execute');
    const firstTurn = spans.find(
      (span) => span.name === 'agent.turn' && span.attrs['agent.turn'] === 1,
    );
    const loopSpan = spans.find((span) => span.name === 'agent.loop');
    expect(firstTurn?.parentSpanId).toBe(loopSpan?.spanId);
    expect(toolSpan?.parentSpanId).toBe(firstTurn?.spanId);
    expect(toolSpan?.attrs).toMatchObject({
      'tool.name': 'probe',
      'tool.is_error': false,
    });
    expect(
      spans.find(
        (span) =>
          span.name === 'model.stream' &&
          span.attrs['model.stop_reason'] === 'stop',
      )?.attrs,
    ).toMatchObject({ 'model.provider': 'faux' });
  });

  it('cancels multiple concurrent tools and closes their spans', async () => {
    const exporter = new InMemorySpanExporter();
    const controller = new AbortController();
    let started = 0;
    const hanging: Tool = {
      ...namedTool('hanging', true, () => undefined),
      async execute(_args, ctx) {
        started += 1;
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return textOutput('cancelled work');
      },
    };
    const provider = new FauxProvider({
      turns: [
        toolCallsTurn({
          calls: [
            { name: 'hanging', rawArguments: '{"value":"one"}' },
            { name: 'hanging', rawArguments: '{"value":"two"}' },
          ],
        }),
      ],
    });
    const events: UIEvent[] = [];
    const execution = runAgentLoop({
      ...loopOptions(
        provider,
        new ToolRegistry([hanging]),
        events,
        controller,
      ),
      telemetry: { exporter },
    });
    await waitUntil(() => started === 2);
    controller.abort(new Error('cancel all tools'));

    const result = await execution;

    expect(result.reason).toBe('aborted');
    expect(events.filter((event) => event.type === 'tool_end')).toHaveLength(2);
    const toolSpans = exporter.spans.filter((span) => span.name === 'tool.execute');
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans.every((span) => span.attrs['tool.is_error'] === true)).toBe(true);
    expect(
      exporter.spans.find((span) => span.name === 'agent.turn')?.attrs,
    ).toMatchObject({ 'agent.aborted': true });
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
    loopConfig: { maxTurns: 4, turnTimeoutMs: 1_000, maxLengthContinuations: 2 },
    maxToolConcurrency: 2,
    emit: (event) => events.push(event),
  };
}

function probeTool(
  inspect: (args: unknown) => void | Promise<void> = () => undefined,
): Tool {
  return namedTool('probe', true, inspect);
}

function namedTool(
  name: string,
  concurrencySafe: boolean,
  inspect: (args: unknown) => void | Promise<void>,
): Tool {
  return {
    name,
    description: 'Record one value.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    concurrencySafe,
    prepareSandbox: passthroughPrepare,
    async execute(args) {
      await inspect(args);
      return textOutput('recorded');
    },
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await delay(5);
  }
}
