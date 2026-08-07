import { describe, expect, it } from 'vitest';
import {
  FauxProvider,
  errorTurn,
  textTurn,
  toolCallTurn,
  type FauxTurn,
} from '../src/core/llm/faux.js';
import type {
  Context,
  ModelRef,
  StreamEvent,
} from '../src/core/types.js';

const EMPTY_CONTEXT: Context = { messages: [] };

describe('FauxProvider', () => {
  it('streams deterministic text chunks and a final message', async () => {
    const provider = new FauxProvider({
      turns: [textTurn('abcdef', { chunkSize: 2, now: () => 10 })],
    });
    const events = await collect(provider);
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'text_delta',
      'text_delta',
      'text_delta',
      'done',
    ]);
    expect(textDeltas(events)).toEqual(['ab', 'cd', 'ef']);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      message: { content: [{ type: 'text', text: 'abcdef' }], timestamp: 10 },
    });
  });

  it('splits tool arguments and preserves malformed JSON for later validation', async () => {
    const rawArguments = '{"path":';
    const provider = new FauxProvider({
      turns: [
        toolCallTurn({
          name: 'read',
          rawArguments,
          argumentChunkSize: 1,
        }),
      ],
    });
    const events = await collect(provider);
    expect(events[1]).toEqual({ type: 'toolcall_start', index: 0 });
    expect(
      events
        .filter(
          (event): event is Extract<StreamEvent, { type: 'toolcall_delta' }> =>
            event.type === 'toolcall_delta',
        )
        .map((event) => event.delta)
        .join(''),
    ).toBe(rawArguments);
    expect(events.find((event) => event.type === 'toolcall_end')).toMatchObject({
      call: { id: 'faux-call-1', name: 'read', arguments: rawArguments },
    });
  });

  it('supports a terminal error after partial text', async () => {
    const provider = new FauxProvider({
      turns: [errorTurn('connection lost', { afterText: 'partial' })],
    });
    const events = await collect(provider);
    expect(textDeltas(events)).toEqual(['partial']);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      message: { errorMessage: 'connection lost', content: [{ text: 'partial' }] },
    });
  });

  it('turns cancellation during a slow response into an aborted event', async () => {
    const controller = new AbortController();
    const provider = new FauxProvider({
      turns: [textTurn('slow', { chunkSize: 1, delayMs: 1_000 })],
    });
    setTimeout(() => controller.abort(), 5);
    const events = await collect(provider, undefined, controller.signal);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
    expect(textDeltas(events)).toEqual([]);
  });

  it('returns errors for empty queues, unknown models and incomplete scripts', async () => {
    const empty = new FauxProvider();
    expect((await collect(empty)).at(-1)).toMatchObject({
      type: 'error',
      message: { errorMessage: 'No more faux turns queued' },
    });

    const incomplete = new FauxProvider({
      turns: [{ steps: [{ type: 'text_delta', delta: 'x' }] }],
    });
    expect((await collect(incomplete)).at(-1)).toMatchObject({
      type: 'error',
      message: { errorMessage: 'Faux turn ended without a done or error event' },
    });

    const unknown: ModelRef = {
      ...empty.listModels()[0]!,
      id: 'missing',
    };
    expect((await collect(empty, unknown)).at(-1)).toMatchObject({
      type: 'error',
      message: { errorMessage: 'Unknown model: faux/missing' },
    });
  });

  it('consumes one queued turn per call', async () => {
    const turns: FauxTurn[] = [textTurn('one'), textTurn('two')];
    const provider = new FauxProvider({ turns });
    expect(provider.pendingTurns()).toBe(2);
    expect(textDeltas(await collect(provider)).join('')).toBe('one');
    expect(provider.pendingTurns()).toBe(1);
    expect(textDeltas(await collect(provider)).join('')).toBe('two');
  });
});

async function collect(
  provider: FauxProvider,
  model = provider.listModels()[0]!,
  signal?: AbortSignal,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(model, EMPTY_CONTEXT, {
    ...(signal === undefined ? {} : { signal }),
  })) {
    events.push(event);
  }
  return events;
}

function textDeltas(events: StreamEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<StreamEvent, { type: 'text_delta' }> =>
        event.type === 'text_delta',
    )
    .map((event) => event.delta);
}
