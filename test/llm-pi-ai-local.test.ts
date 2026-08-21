import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiAiProvider } from '../src/core/llm/pi-ai.js';
import type { StreamEvent } from '../src/core/types.js';

describe('pi-ai local OpenAI-compatible provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams without sending an Authorization header when no key is configured', async () => {
    let request: Request | undefined;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      request = new Request(input, init);
      return localSseResponse();
    });

    const provider = createPiAiProvider({
      providers: [],
      customProviders: [
        {
          id: 'custom',
          baseUrl: 'http://localhost:11434/v1',
          models: [{ id: 'local-model' }],
        },
      ],
    });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Expected a custom model');
    const events: StreamEvent[] = [];
    for await (const event of provider.stream(model, {
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    })) {
      events.push(event);
    }

    expect(request?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(request?.headers.get('authorization')).toBeNull();
    expect(events).toContainEqual({ type: 'text_delta', delta: 'local ok' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      message: { stopReason: 'stop' },
    });
  });

  it('sends only an explicitly configured custom API key', async () => {
    let request: Request | undefined;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      request = new Request(input, init);
      return localSseResponse();
    });
    const provider = createPiAiProvider({
      providers: [],
      customProviders: [
        {
          id: 'custom',
          baseUrl: 'http://localhost:11434/v1',
          models: [{ id: 'local-model' }],
        },
      ],
      apiKeys: { custom: 'local-key' },
    });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Expected a custom model');
    for await (const _event of provider.stream(model, {
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    })) {
      // Consume the stream so the request completes.
    }

    expect(request?.headers.get('authorization')).toBe('Bearer local-key');
  });
});

function localSseResponse(): Response {
  return new Response(
    [
      'data: {"id":"chatcmpl-local","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{"role":"assistant","content":"local ok"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-local","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
