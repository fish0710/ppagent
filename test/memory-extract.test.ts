import { describe, expect, it } from 'vitest';
import { LlmMemoryExtractor, type MemoryExtractionInput } from '../src/agent/memory/extract.js';
import { errorTurn, FauxProvider, textTurn, toolCallTurn } from '../src/core/llm/faux.js';
import type {
  Message,
  ModelRef,
  Provider,
  ReadonlyContext,
  StreamEvent,
  StreamOptions,
} from '../src/core/types.js';

const MODEL: ModelRef = {
  provider: 'faux',
  id: 'faux-model',
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
  supportsNativeToolCalling: true,
  supportsThinking: true,
};

const FULL_MODEL_TURN = `## Durable facts
the tokenizer is @huggingface/tokenizers, not transformers.js

## Durable conventions
before touching src/core, run npm run depcruise

## Decisions
use BM25 for retrieval: no ML dependency available

## Pitfalls
bash tool must spawn detached or it leaks orphan processes`;

function extractor(
  provider: Provider,
  overrides: Partial<{ maxTokens: number; timeoutMs: number; notify: (message: string) => void }> = {},
) {
  return new LlmMemoryExtractor({
    provider,
    model: MODEL,
    maxTokens: overrides.maxTokens ?? 256,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    idGenerator: idSequence(),
    ...(overrides.notify === undefined ? {} : { notify: overrides.notify }),
  });
}

function idSequence(): () => string {
  let next = 0;
  return () => `id-${(next += 1)}`;
}

function input(overrides: Partial<MemoryExtractionInput> = {}): MemoryExtractionInput {
  return {
    sourceSessionId: 'session-1',
    projectKey: 'proj',
    messages: [
      { role: 'user', content: 'add retries to the fetch layer', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done, added exponential backoff' }],
        stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        timestamp: 2,
      },
    ],
    loopEndReason: 'stop',
    maxTrackedFiles: 80,
    ...overrides,
  };
}

describe('LlmMemoryExtractor', () => {
  it('parses each heading into records, tagging kind and capping the project scope by default', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] });
    const records = await extractor(provider).extract(input(), new AbortController().signal);

    expect(records).toHaveLength(3); // capped, see below
    expect(records[0]).toMatchObject({
      kind: 'fact',
      text: 'the tokenizer is @huggingface/tokenizers, not transformers.js',
      scope: 'project',
      projectKey: 'proj',
      sourceSessionId: 'session-1',
      status: 'active',
      exposure: 0,
    });
    expect(records[1]).toMatchObject({ kind: 'convention' });
    expect(records[2]).toMatchObject({ kind: 'decision' });
    // pitfalls section exists but the 3-record cap is hit before it's reached.
    expect(records.some((r) => r.kind === 'pitfall')).toBe(false);
  });

  it('never produces more than 3 records total across every heading combined', async () => {
    const provider = new FauxProvider({
      turns: [
        textTurn(
          '## Durable facts\nf1\nf2\n\n## Durable conventions\nc1\nc2\n\n## Pitfalls\np1',
        ),
      ],
    });
    const records = await extractor(provider).extract(input(), new AbortController().signal);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.text)).toEqual(['f1', 'f2', 'c1']);
  });

  it('strips leading bullet markers from each line', async () => {
    const provider = new FauxProvider({ turns: [textTurn('## Durable facts\n- npm run verify before commit')] });
    const records = await extractor(provider).extract(input(), new AbortController().signal);
    expect(records[0]?.text).toBe('npm run verify before commit');
  });

  it('classifies a first-person preference as user scope with no projectKey', async () => {
    const provider = new FauxProvider({
      turns: [textTurn('## Durable conventions\nI always want commit messages under 70 chars')],
    });
    const records = await extractor(provider).extract(input(), new AbortController().signal);
    expect(records[0]).toMatchObject({ scope: 'user' });
    expect(records[0]?.projectKey).toBeUndefined();
  });

  it('skips extraction entirely (and never calls the model) when the loop was aborted', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] });
    const records = await extractor(provider).extract(
      input({ loopEndReason: 'aborted' }),
      new AbortController().signal,
    );
    expect(records).toEqual([]);
    expect(provider.pendingTurns()).toBe(1); // turn never consumed
  });

  it('degrades to an empty array, not a throw, when the model output has no parseable headings', async () => {
    const provider = new FauxProvider({ turns: [textTurn('just a sentence with no headings at all')] });
    const records = await extractor(provider).extract(input(), new AbortController().signal);
    expect(records).toEqual([]);
  });

  it('degrades to an empty array when the model only calls a tool and writes no text', async () => {
    const provider = new FauxProvider({
      turns: [toolCallTurn({ name: 'read', rawArguments: '{"path":"a.ts"}' })],
    });
    const records = await extractor(provider).extract(input(), new AbortController().signal);
    expect(records).toEqual([]);
  });

  it('degrades to an empty array when the provider reports an error', async () => {
    const provider = new FauxProvider({ turns: [errorTurn('local server unreachable')] });
    const records = await extractor(provider).extract(input(), new AbortController().signal);
    expect(records).toEqual([]);
  });

  it('surfaces the concrete provider error in the notify message, not a fixed "extraction failed"', async () => {
    const notified: string[] = [];
    const provider = new FauxProvider({
      turns: [errorTurn('HTTP 400: max context length exceeded')],
    });
    const records = await extractor(provider, { notify: (message) => notified.push(message) }).extract(
      input(),
      new AbortController().signal,
    );
    expect(records).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('HTTP 400: max context length exceeded');
  });

  it('treats an empty model response (no tool call) as a legitimate "nothing durable" outcome, not a failure', async () => {
    const notified: string[] = [];
    const provider = new FauxProvider({ turns: [textTurn('')] });
    const records = await extractor(provider, { notify: (message) => notified.push(message) }).extract(
      input(),
      new AbortController().signal,
    );
    expect(records).toEqual([]);
    expect(notified).toHaveLength(0);
  });

  it('degrades to an empty array on its own timeout without throwing', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN, { delayMs: 200 })] });
    const records = await extractor(provider, { timeoutMs: 20 }).extract(
      input(),
      new AbortController().signal,
    );
    expect(records).toEqual([]);
  });

  it('sends a structured digest, not the raw transcript — original request, outcome, and file ops', async () => {
    const recorder = new RecordingProvider(new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] }));
    const messages: Message[] = [
      { role: 'user', content: 'refactor the retry helper', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'edit', arguments: { path: 'src/fetch.ts' } },
        ],
        stopReason: 'toolUse',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 3,
      },
    ];
    await extractor(recorder).extract(
      input({ messages, loopEndReason: 'maxTurns' }),
      new AbortController().signal,
    );
    const sent = recorder.calls[0]?.context.messages[0];
    const text = typeof sent?.content === 'string' ? sent.content : '';
    expect(text).toContain('refactor the retry helper');
    expect(text).toContain('src/fetch.ts');
    expect(text).toContain('maxTurns');
    expect(recorder.calls[0]?.options?.temperature).toBe(0);
  });
});

class RecordingProvider implements Provider {
  readonly calls: { context: ReadonlyContext; options?: StreamOptions }[] = [];
  readonly #inner: Provider;

  constructor(inner: Provider) {
    this.#inner = inner;
  }

  get id(): string {
    return this.#inner.id;
  }

  listModels(): ModelRef[] {
    return this.#inner.listModels();
  }

  stream(model: ModelRef, context: ReadonlyContext, options?: StreamOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ context: structuredClone(context), ...(options === undefined ? {} : { options }) });
    return this.#inner.stream(model, context, options);
  }
}
