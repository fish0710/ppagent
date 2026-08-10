import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessage,
  Context,
  StreamEvent,
} from '../src/core/types.js';

const mock = vi.hoisted(() => ({
  events: [] as unknown[],
  contexts: [] as unknown[],
  customInputs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@earendil-works/pi-ai', () => ({
  createProvider: (input: Record<string, unknown>) => {
    mock.customInputs.push(input);
    return {
      id: input['id'],
      getModels: () => input['models'],
    };
  },
  createModels: () => {
    let model = {
      id: 'mock-model',
      name: 'Mock model',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://example.invalid',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    return {
      setProvider: (provider: { getModels?: () => unknown[] }) => {
        const registered = provider.getModels?.()[0];
        if (registered !== undefined) model = registered as typeof model;
      },
      getModels: () => [model],
      getModel: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      stream: (_model: unknown, context: unknown) => {
        mock.contexts.push(context);
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of mock.events) yield event;
          },
        };
      },
    };
  },
}));

vi.mock('@earendil-works/pi-ai/providers/anthropic', () => ({
  anthropicProvider: () => ({ id: 'anthropic' }),
}));
vi.mock('@earendil-works/pi-ai/providers/google', () => ({
  googleProvider: () => ({ id: 'google' }),
}));
vi.mock('@earendil-works/pi-ai/providers/openai', () => ({
  openaiProvider: () => ({ id: 'openai' }),
}));
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: vi.fn(), streamSimple: vi.fn() }),
}));

import { createPiAiProvider } from '../src/core/llm/pi-ai.js';

const PI_USAGE = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe('pi-ai adapter', () => {
  beforeEach(() => {
    mock.events = [];
    mock.contexts = [];
    mock.customInputs = [];
  });

  it('maps model capabilities without exposing pi-ai model objects', () => {
    const provider = createPiAiProvider({ providers: ['anthropic'] });
    expect(provider.listModels()).toEqual([
      {
        provider: 'anthropic',
        id: 'mock-model',
        contextWindow: 8_192,
        maxOutputTokens: 1_024,
        supportsNativeToolCalling: true,
        supportsThinking: true,
      },
    ]);
  });

  it('registers a custom OpenAI-compatible model without using the OpenAI catalog', () => {
    const provider = createPiAiProvider({
      providers: [],
      customProviders: [
        {
          id: 'custom',
          baseUrl: 'https://litellm.example/v1/',
          models: [{ id: 'deepseek-v4-flash' }],
        },
      ],
    });
    expect(provider.listModels()).toEqual([
      {
        provider: 'custom',
        id: 'deepseek-v4-flash',
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        supportsNativeToolCalling: true,
        supportsThinking: false,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ]);
    expect(mock.customInputs[0]).toMatchObject({
      id: 'custom',
      baseUrl: 'https://litellm.example/v1',
      models: [
        {
          id: 'deepseek-v4-flash',
          api: 'openai-completions',
          provider: 'custom',
          baseUrl: 'https://litellm.example/v1',
        },
      ],
    });
  });

  it('normalizes start, deltas, tool calls, origin and opaque adapter state', async () => {
    const finalMessage = piMessage([
      { type: 'text', text: 'hello', textSignature: 'text-sig' },
      {
        type: 'thinking',
        thinking: 'reason',
        thinkingSignature: 'thinking-sig',
        redacted: false,
      },
      {
        type: 'toolCall',
        id: '',
        name: 'read',
        arguments: { path: 'package.json' },
        thoughtSignature: 'tool-sig',
      },
    ]);
    mock.events = [
      { type: 'start', partial: piMessage([]) },
      { type: 'text_delta', contentIndex: 0, delta: 'hello', partial: finalMessage },
      { type: 'toolcall_start', contentIndex: 2, partial: finalMessage },
      {
        type: 'toolcall_delta',
        contentIndex: 2,
        delta: '{"path":"package.json"}',
        partial: finalMessage,
      },
      {
        type: 'toolcall_end',
        contentIndex: 2,
        toolCall: finalMessage.content[2],
        partial: finalMessage,
      },
      { type: 'done', reason: 'toolUse', message: finalMessage },
    ];

    const provider = createPiAiProvider({
      providers: ['anthropic'],
      idFactory: () => 'call_generated',
    });
    const events = await collect(provider);

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'text_delta',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
      'done',
    ]);
    expect(events[2]).toEqual({ type: 'toolcall_start', index: 2 });
    expect(events[4]).toMatchObject({
      call: {
        id: 'call_generated',
        name: 'read',
        adapterState: {
          adapter: 'pi-ai',
          data: { thoughtSignature: 'tool-sig' },
        },
      },
    });
    expect(events[5]).toMatchObject({
      message: {
        origin: { provider: 'anthropic', model: 'mock-model' },
        adapterState: {
          adapter: 'pi-ai',
          data: { api: 'anthropic-messages', responseId: 'response-1' },
        },
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
        content: [
          {
            adapterState: {
              adapter: 'pi-ai',
              data: { textSignature: 'text-sig' },
            },
          },
          {
            adapterState: {
              adapter: 'pi-ai',
              data: { thinkingSignature: 'thinking-sig', redacted: false },
            },
          },
          { id: 'call_generated' },
        ],
      },
    });
  });

  it('restores origin, protocol and signatures when replaying history', async () => {
    mock.events = [{ type: 'done', reason: 'stop', message: piMessage([]) }];
    const history: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'reason',
          adapterState: {
            adapter: 'pi-ai',
            data: { thinkingSignature: 'thinking-sig', redacted: true },
          },
        },
      ],
      stopReason: 'stop',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      origin: { provider: 'anthropic', model: 'mock-model' },
      adapterState: {
        adapter: 'pi-ai',
        data: { api: 'anthropic-messages', responseId: 'old-response' },
      },
      timestamp: 1,
    };
    const provider = createPiAiProvider({ providers: ['anthropic'] });
    await collect(provider, { messages: [history] });

    expect(mock.contexts[0]).toMatchObject({
      messages: [
        {
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'mock-model',
          responseId: 'old-response',
          content: [
            {
              type: 'thinking',
              thinking: 'reason',
              thinkingSignature: 'thinking-sig',
              redacted: true,
            },
          ],
        },
      ],
    });
  });

  it('turns a missing final tool name into a structured error', async () => {
    const badCall = { type: 'toolCall', id: '', name: '', arguments: {} };
    mock.events = [
      { type: 'toolcall_start', contentIndex: 0, partial: piMessage([badCall]) },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: badCall,
        partial: piMessage([badCall]),
      },
    ];
    const events = await collect(
      createPiAiProvider({ providers: ['anthropic'] }),
    );
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      message: { errorMessage: 'Tool call at index 0 ended without a name' },
    });
  });

  it('synthesizes an error when the underlying stream has no terminal event', async () => {
    mock.events = [{ type: 'start', partial: piMessage([]) }];
    const events = await collect(
      createPiAiProvider({ providers: ['anthropic'] }),
    );
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: {
        errorMessage: 'pi-ai stream ended without a done or error event',
      },
    });
  });

  it('adds an actionable and redacted hint to custom connection errors', async () => {
    mock.events = [
      {
        type: 'error',
        reason: 'error',
        error: {
          ...piMessage([]),
          stopReason: 'error',
          errorMessage: 'Connection error.',
        },
      },
    ];
    const provider = createPiAiProvider({
      providers: [],
      customProviders: [
        {
          id: 'custom',
          baseUrl: 'http://user:secret@localhost:11434',
          models: [{ id: 'local-model' }],
        },
      ],
    });

    const events = await collect(provider);

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: {
        errorMessage:
          'Connection error. Custom provider base URL: http://localhost:11434. LM Studio and llama.cpp API roots usually end in /v1.',
      },
    });
  });
});

function piMessage(content: unknown[]) {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'mock-model',
    responseId: 'response-1',
    usage: PI_USAGE,
    stopReason: content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'toolCall',
    )
      ? 'toolUse'
      : 'stop',
    timestamp: 100,
  };
}

async function collect(
  provider = createPiAiProvider({ providers: ['anthropic'] }),
  context: Context = { messages: [] },
): Promise<StreamEvent[]> {
  const model = provider.listModels()[0]!;
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(model, context)) events.push(event);
  return events;
}
