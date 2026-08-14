import { describe, expect, it } from 'vitest';
import {
  ConsoleSpanExporter,
  InMemorySpanExporter,
  SpanRecorder,
  createTraceContext,
  flushSpanExporter,
} from '../src/core/telemetry/index.js';
import type { SpanExporter } from '../src/core/types.js';

describe('telemetry', () => {
  it('creates parented trace contexts and exports an ended span exactly once', () => {
    const exporter = new InMemorySpanExporter();
    const times = [10, 17];
    const recorder = new SpanRecorder(exporter, {
      now: () => times.shift() ?? 17,
    });
    const root = createTraceContext({
      traceId: 'trace-1',
      spanId: 'root-1',
      idFactory: () => 'child-1',
    });
    const child = root.child('model');
    const span = recorder.start('model.stream', child, { provider: 'faux' });
    span.setAttribute('stop_reason', 'stop');
    span.end({ output_tokens: 3 });
    span.end({}, new Error('must be ignored'));

    expect(child.parentSpanId).toBe(root.spanId);
    expect(exporter.spans).toEqual([
      {
        name: 'model.stream',
        traceId: 'trace-1',
        spanId: 'model-child-1',
        parentSpanId: 'root-1',
        startMs: 10,
        endMs: 17,
        attrs: {
          provider: 'faux',
          stop_reason: 'stop',
          output_tokens: 3,
        },
      },
    ]);
  });

  it('renders a tree on flush even when a child finishes before its parent', async () => {
    let output = '';
    const exporter = new ConsoleSpanExporter({ write: (text) => (output += text) });
    exporter.export({
      name: 'model.stream',
      traceId: 'trace',
      spanId: 'model',
      parentSpanId: 'turn',
      startMs: 2,
      endMs: 5,
      attrs: {},
    });
    exporter.export({
      name: 'agent.turn',
      traceId: 'trace',
      spanId: 'turn',
      startMs: 1,
      endMs: 6,
      attrs: { turn: 1 },
    });

    await exporter.flush();

    expect(output).toBe(
      '[span] agent.turn 5ms {"turn":1}\n  [span] model.stream 3ms\n',
    );
  });

  it('keeps export and flush failures out of the agent control flow', async () => {
    const broken: SpanExporter = {
      export() {
        throw new Error('collector unavailable');
      },
      async flush() {
        throw new Error('flush unavailable');
      },
    };
    const recorder = new SpanRecorder(broken);
    const trace = createTraceContext();

    expect(() => recorder.start('safe', trace).end()).not.toThrow();
    await expect(flushSpanExporter(broken)).resolves.toBeUndefined();
  });
});
