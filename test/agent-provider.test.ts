import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredProvider } from '../src/agent/index.js';

describe('configured provider selection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('selects the faux default without reading ambient configuration', () => {
    const selected = createConfiguredProvider({ id: 'faux' });

    expect(selected.provider.id).toBe('faux');
    expect(selected.model).toMatchObject({
      provider: 'faux',
      id: 'faux-model',
    });
  });

  it('supports an unauthenticated custom OpenAI-compatible endpoint', () => {
    const selected = createConfiguredProvider({
      id: 'custom',
      model: 'qwen-local',
      baseUrl: 'http://localhost:11434/v1',
    });

    expect(selected.model).toMatchObject({
      provider: 'custom',
      id: 'qwen-local',
      supportsNativeToolCalling: true,
    });
  });

  it('provides explicit LM Studio and llama.cpp aliases with conventional defaults', () => {
    expect(
      createConfiguredProvider({ id: 'lmstudio', model: 'qwen3.6-27b' }).model,
    ).toMatchObject({ provider: 'lmstudio', id: 'qwen3.6-27b' });
    expect(
      createConfiguredProvider({ id: 'llamacpp', model: 'qwen.gguf' }).model,
    ).toMatchObject({ provider: 'llamacpp', id: 'qwen.gguf' });
  });

  it('scopes a local API key to the selected alias', async () => {
    let request: Request | undefined;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(
        [
          'data: {"id":"alias","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
          '',
          'data: {"id":"alias","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const { provider, model } = createConfiguredProvider({
      id: 'lmstudio',
      model: 'local',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'alias-key',
    });

    for await (const _event of provider.stream(model, {
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    })) {
      // Drain the SSE response so the request headers can be inspected.
    }

    expect(request?.headers.get('authorization')).toBe('Bearer alias-key');
  });

  it('rejects incomplete or unknown provider configuration early', () => {
    expect(() => createConfiguredProvider({ id: 'openai' })).toThrow(
      'An API key is required for provider openai',
    );
    expect(() => createConfiguredProvider({ id: 'other' })).toThrow(
      'Unsupported provider: other',
    );
  });
});
