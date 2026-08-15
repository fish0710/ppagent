import { describe, expect, it, vi } from 'vitest';
import {
  LaminarSpanExporter,
  otlpTraceRequest,
} from '../src/core/telemetry/laminar.js';
import type { Span } from '../src/core/types.js';

const SPAN: Span = {
  name: 'model.stream',
  traceId: 'trace-human-readable',
  spanId: 'model-child-readable',
  parentSpanId: 'parent-readable',
  startMs: 10,
  endMs: 17,
  attrs: {
    'model.provider': 'custom',
    'model.id': 'qwen3.6-27b',
    'model.input_tokens': 12,
    'model.output_tokens': 3,
  },
};

describe('LaminarSpanExporter', () => {
  it('serializes valid OTLP/HTTP JSON ids, timestamps and semantic attributes', () => {
    const request = otlpTraceRequest([SPAN], 'ppagent-test', '0.1.0') as any;
    const encoded = request.resourceSpans[0].scopeSpans[0].spans[0];

    expect(encoded.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(encoded.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(encoded.parentSpanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(encoded.startTimeUnixNano).toBe('10000000');
    expect(encoded.endTimeUnixNano).toBe('17000000');
    expect(encoded.attributes).toContainEqual({
      key: 'lmnr.span.type',
      value: { stringValue: 'LLM' },
    });
    expect(encoded.attributes).toContainEqual({
      key: 'gen_ai.usage.input_tokens',
      value: { intValue: '12' },
    });
  });

  it('posts a batch to /v1/traces with bearer auth and retries 503', async () => {
    const responses = [
      new Response('busy', { status: 503 }),
      new Response('{}', { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? new Response('{}'));
    const sleep = vi.fn(async () => undefined);
    const exporter = new LaminarSpanExporter({
      apiKey: 'secret-project-key',
      endpoint: 'http://collector.local:8000',
      fetch: fetchMock as typeof fetch,
      sleep,
    });
    exporter.export(SPAN);

    await exporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://collector.local:8000/v1/traces');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer secret-project-key',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      resourceSpans: expect.any(Array),
    });
  });

  it('does not retry permanent HTTP failures', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }));
    const sleep = vi.fn(async () => undefined);
    const exporter = new LaminarSpanExporter({
      apiKey: 'secret-project-key',
      fetch: fetchMock as typeof fetch,
      sleep,
    });
    exporter.export(SPAN);

    await expect(exporter.flush()).rejects.toThrow('HTTP 400');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('drains spans exported while a flush is in flight', async () => {
    let releaseFirst = (): void => undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        await firstPending;
        return new Response('{}', { status: 200 });
      })
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const exporter = new LaminarSpanExporter({
      apiKey: 'secret-project-key',
      fetch: fetchMock,
    });
    exporter.export(SPAN);

    const flushing = exporter.flush();
    exporter.export({ ...SPAN, spanId: 'late-span' });
    releaseFirst();
    await flushing;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
