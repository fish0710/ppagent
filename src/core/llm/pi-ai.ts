import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent as PiStreamEvent,
  type Context as PiContext,
  type Model as PiModel,
  type TSchema,
  type ToolCall as PiToolCall,
  type Usage as PiUsage,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type {
  AdapterState,
  AssistantMessage,
  ContentBlock,
  ReadonlyContext,
  JSONValue,
  ModelRef,
  Provider,
  StreamEvent,
  StreamOptions,
  ToolCallBlock,
  Usage,
} from '../types.js';
import { createErrorMessage, modelOrigin } from './provider.js';

const ADAPTER_ID = 'pi-ai';

export type PiAiBuiltinProvider = 'anthropic' | 'google' | 'openai';

export interface PiAiCustomModelOptions {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
}

export interface PiAiCustomProviderOptions {
  id: string;
  baseUrl: string;
  models: PiAiCustomModelOptions[];
}

export interface PiAiProviderOptions {
  providers: PiAiBuiltinProvider[];
  customProviders?: PiAiCustomProviderOptions[];
  apiKeys?: Readonly<Record<string, string>>;
  idFactory?: () => string;
}

class PiAiProvider implements Provider {
  readonly id = ADAPTER_ID;
  readonly #models;
  readonly #apiKeys: Readonly<Record<string, string>>;
  readonly #idFactory: () => string;
  readonly #customBaseUrls = new Map<string, string>();

  constructor(options: PiAiProviderOptions) {
    this.#models = createModels({
      // core 不读取环境变量或文件；凭证必须由上层通过普通对象注入。
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    });
    for (const provider of options.providers) {
      this.#models.setProvider(createBuiltinProvider(provider));
    }
    for (const provider of options.customProviders ?? []) {
      this.#models.setProvider(createCustomProvider(provider));
      this.#customBaseUrls.set(provider.id, normalizeBaseUrl(provider.baseUrl));
    }
    this.#apiKeys = options.apiKeys ?? {};
    this.#idFactory = options.idFactory ?? defaultToolCallId;
  }

  listModels(): ModelRef[] {
    return this.#models.getModels().map(toModelRef);
  }

  async *stream(
    requested: ModelRef,
    context: ReadonlyContext,
    options: StreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    yield { type: 'start' };

    const model = this.#models.getModel(requested.provider, requested.id);
    if (model === undefined) {
      yield adapterError(`Unknown model: ${requested.provider}/${requested.id}`, requested);
      return;
    }

    const generatedIds = new Map<number, string>();
    const customBaseUrl = this.#customBaseUrls.get(requested.provider);
    let terminal = false;
    try {
      const piContext = toPiContext(context, model, this.#models);
      const apiKey = this.#apiKeys[requested.provider];
      const stream = this.#models.stream(model, piContext, {
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.temperature === undefined
          ? {}
          : { temperature: options.temperature }),
      });

      for await (const event of stream) {
        const rawMapped = mapStreamEvent(event, generatedIds, this.#idFactory);
        const mapped =
          rawMapped === null || customBaseUrl === undefined
            ? rawMapped
            : withCustomConnectionHintOnEvent(rawMapped, customBaseUrl);
        if (mapped !== null) yield mapped;
        if (mapped?.type === 'done' || mapped?.type === 'error') {
          terminal = true;
          return;
        }
      }
      if (!terminal) {
        yield adapterError(
          'pi-ai stream ended without a done or error event',
          requested,
        );
      }
    } catch (error) {
      const reason = options.signal?.aborted === true ? 'aborted' : 'error';
      const message = errorMessage(error);
      yield adapterError(
        customBaseUrl === undefined
          ? message
          : withCustomConnectionHint(message, customBaseUrl),
        requested,
        reason,
      );
    }
  }
}

export function createPiAiProvider(options: PiAiProviderOptions): Provider {
  if (options.providers.length === 0 && (options.customProviders?.length ?? 0) === 0) {
    throw new Error('At least one pi-ai provider must be configured');
  }
  return new PiAiProvider(options);
}

function createCustomProvider(options: PiAiCustomProviderOptions) {
  if (options.id.trim().length === 0) {
    throw new Error('Custom provider id must not be empty');
  }
  if (options.models.length === 0) {
    throw new Error(`Custom provider ${options.id} must define at least one model`);
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const models: PiModel<'openai-completions'>[] = options.models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    api: 'openai-completions',
    provider: options.id,
    baseUrl,
    reasoning: model.supportsThinking ?? false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 131_072,
    maxTokens: model.maxOutputTokens ?? 8_192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
  }));
  return createProvider({
    id: options.id,
    name: options.id,
    baseUrl,
    auth: {
      apiKey: {
        name: `${options.id} API key`,
        resolve: async ({ credential }) => {
          const apiKey = credential?.key?.trim();
          return apiKey === undefined || apiKey.length === 0
            ? {
                // pi-ai 需要一个非空 apiKey 才会把 provider 视为已配置；
                // Authorization: null 会让 OpenAI SDK 在发请求前移除占位头。
                auth: {
                  apiKey: 'ppagent-no-auth',
                  headers: { authorization: null },
                },
              }
            : { auth: { apiKey } };
        },
      },
    },
    models,
    api: openAICompletionsApi(),
  });
}

function createBuiltinProvider(provider: PiAiBuiltinProvider) {
  switch (provider) {
    case 'anthropic':
      return anthropicProvider();
    case 'google':
      return googleProvider();
    case 'openai':
      return openaiProvider();
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid custom provider base URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Custom provider base URL must use http or https: ${value}`);
  }
  return trimmed;
}

function toModelRef(model: PiModel<Api>): ModelRef {
  const compat = model.compat as Record<string, unknown> | undefined;
  const supportsDeveloperRole = booleanProperty(compat, 'supportsDeveloperRole');
  const supportsReasoningEffort = booleanProperty(
    compat,
    'supportsReasoningEffort',
  );
  const mappedCompat = {
    ...(supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole }),
    ...(supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort }),
  };
  return {
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsNativeToolCalling: true,
    supportsThinking: model.reasoning,
    ...(Object.keys(mappedCompat).length === 0 ? {} : { compat: mappedCompat }),
  };
}

function toPiContext(
  context: ReadonlyContext,
  target: PiModel<Api>,
  models: ReturnType<typeof createModels>,
): PiContext {
  return {
    ...(context.systemPrompt === undefined
      ? {}
      : { systemPrompt: context.systemPrompt }),
    messages: context.messages.map((message) => {
      switch (message.role) {
        case 'user':
          return {
            role: 'user' as const,
            content:
              typeof message.content === 'string'
                ? message.content
                : message.content.map(toPiInputBlock),
            timestamp: message.timestamp,
          };
        case 'assistant':
          return toPiAssistantMessage(message, target, models);
        case 'toolResult':
          return {
            role: 'toolResult' as const,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            content: message.content.map(toPiInputBlock),
            isError: message.isError,
            timestamp: message.timestamp,
          };
      }
    }),
    ...(context.tools === undefined
      ? {}
      : {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as TSchema,
          })),
        }),
  };
}

function toPiInputBlock(block: ContentBlock) {
  switch (block.type) {
    case 'text':
      return { type: 'text' as const, text: block.text };
    case 'image':
      return { type: 'image' as const, data: block.data, mimeType: block.mimeType };
    case 'thinking':
    case 'toolCall':
      throw new Error(`${block.type} block is invalid in user/tool-result content`);
  }
}

function toPiAssistantMessage(
  message: AssistantMessage,
  target: PiModel<Api>,
  models: ReturnType<typeof createModels>,
): PiAssistantMessage {
  const provider = message.origin?.provider ?? target.provider;
  const modelId = message.origin?.model ?? target.id;
  const sourceModel = models.getModel(provider, modelId);
  const messageData = readPiState(message.adapterState);
  const api = stringValue(messageData, 'api') ?? sourceModel?.api ?? target.api;
  const responseModel = stringValue(messageData, 'responseModel');
  const responseId = stringValue(messageData, 'responseId');
  const rawStopReason = stringValue(messageData, 'rawStopReason');
  return {
    role: 'assistant',
    content: message.content.map(toPiAssistantBlock),
    api,
    provider,
    model: modelId,
    ...(responseModel === undefined ? {} : { responseModel }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(rawStopReason === undefined ? {} : { rawStopReason }),
    usage: toPiUsage(message.usage),
    stopReason: message.stopReason,
    ...(message.errorMessage === undefined
      ? {}
      : { errorMessage: message.errorMessage }),
    timestamp: message.timestamp,
  };
}

function toPiAssistantBlock(
  block: ContentBlock,
): PiAssistantMessage['content'][number] {
  const data = readPiState('adapterState' in block ? block.adapterState : undefined);
  switch (block.type) {
    case 'text': {
      const textSignature = stringValue(data, 'textSignature');
      return {
        type: 'text' as const,
        text: block.text,
        ...(textSignature === undefined ? {} : { textSignature }),
      };
    }
    case 'thinking': {
      const thinkingSignature = stringValue(data, 'thinkingSignature');
      const redacted = booleanProperty(data, 'redacted');
      return {
        type: 'thinking' as const,
        thinking: block.thinking,
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(redacted === undefined ? {} : { redacted }),
      };
    }
    case 'toolCall': {
      if (!isRecord(block.arguments)) {
        throw new Error(`Tool call ${block.name} has non-object arguments`);
      }
      const thoughtSignature = stringValue(data, 'thoughtSignature');
      return {
        type: 'toolCall' as const,
        id: block.id,
        name: block.name,
        arguments: block.arguments,
        ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
      };
    }
    case 'image':
      throw new Error('Image block is invalid in an assistant message');
  }
}

function mapStreamEvent(
  event: PiStreamEvent,
  generatedIds: Map<number, string>,
  idFactory: () => string,
): StreamEvent | null {
  switch (event.type) {
    case 'start':
    case 'text_start':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_end':
      return null;
    case 'text_delta':
      return { type: 'text_delta', delta: event.delta };
    case 'thinking_delta':
      return { type: 'thinking_delta', delta: event.delta };
    case 'toolcall_start':
      return { type: 'toolcall_start', index: event.contentIndex };
    case 'toolcall_delta':
      return {
        type: 'toolcall_delta',
        index: event.contentIndex,
        delta: event.delta,
      };
    case 'toolcall_end':
      return {
        type: 'toolcall_end',
        index: event.contentIndex,
        call: fromPiToolCall(
          event.toolCall,
          event.contentIndex,
          generatedIds,
          idFactory,
        ),
      };
    case 'done':
      return {
        type: 'done',
        message: fromPiAssistantMessage(event.message, generatedIds, idFactory),
      };
    case 'error':
      return {
        type: 'error',
        reason: event.reason,
        message: fromPiAssistantMessage(event.error, generatedIds, idFactory),
      };
  }
}

function fromPiAssistantMessage(
  message: PiAssistantMessage,
  generatedIds: Map<number, string>,
  idFactory: () => string,
): AssistantMessage {
  const content = message.content.map((block, index): ContentBlock => {
    switch (block.type) {
      case 'text':
        return {
          type: 'text',
          text: block.text,
          ...withPiState({ textSignature: block.textSignature }),
        };
      case 'thinking':
        return {
          type: 'thinking',
          thinking: block.thinking,
          ...withPiState({
            thinkingSignature: block.thinkingSignature,
            redacted: block.redacted,
          }),
        };
      case 'toolCall':
        return fromPiToolCall(block, index, generatedIds, idFactory);
    }
  });
  const messageState = withPiState({
    api: message.api,
    responseModel: message.responseModel,
    responseId: message.responseId,
    rawStopReason: message.rawStopReason,
  });
  return {
    role: 'assistant',
    content,
    stopReason: normalizeStopReason(message.stopReason),
    usage: fromPiUsage(message.usage),
    origin: { provider: message.provider, model: message.model },
    ...messageState,
    ...(message.errorMessage === undefined
      ? {}
      : { errorMessage: message.errorMessage }),
    timestamp: message.timestamp,
  };
}

function fromPiToolCall(
  call: PiToolCall,
  index: number,
  generatedIds: Map<number, string>,
  idFactory: () => string,
): ToolCallBlock {
  if (call.name.trim().length === 0) {
    throw new Error(`Tool call at index ${index} ended without a name`);
  }
  let id = call.id;
  if (id.length === 0) {
    id = generatedIds.get(index) ?? idFactory();
    generatedIds.set(index, id);
  }
  return {
    type: 'toolCall',
    id,
    name: call.name,
    arguments: call.arguments,
    ...withPiState({ thoughtSignature: call.thoughtSignature }),
  };
}

function toPiUsage(usage: Usage): PiUsage {
  return {
    ...usage,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function fromPiUsage(usage: PiUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

function withPiState(
  source: Record<string, JSONValue | undefined>,
): { adapterState?: AdapterState } {
  const data: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) data[key] = value;
  }
  return Object.keys(data).length === 0
    ? {}
    : { adapterState: { adapter: ADAPTER_ID, data } };
}

function readPiState(
  state: AdapterState | undefined,
): Record<string, JSONValue> | undefined {
  return state?.adapter === ADAPTER_ID ? state.data : undefined;
}

function stringValue(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanProperty(
  data: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = data?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStopReason(
  reason: PiAssistantMessage['stopReason'],
): AssistantMessage['stopReason'] {
  return reason === 'pending' ? 'error' : reason;
}

function adapterError(
  message: string,
  model: ModelRef,
  reason: 'error' | 'aborted' = 'error',
): Extract<StreamEvent, { type: 'error' }> {
  return {
    type: 'error',
    reason,
    message: createErrorMessage(message, {
      reason,
      origin: modelOrigin(model),
    }),
  };
}

function defaultToolCallId(): string {
  return `call_${crypto.randomUUID().replaceAll('-', '')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withCustomConnectionHint(message: string, baseUrl: string): string {
  if (!isConnectionFailure(message)) return message;
  return `${message} Custom provider base URL: ${redactBaseUrl(baseUrl)}. LM Studio and llama.cpp API roots usually end in /v1.`;
}

function withCustomConnectionHintOnEvent(
  event: StreamEvent,
  baseUrl: string,
): StreamEvent {
  if (event.type !== 'error' || event.message.errorMessage === undefined) {
    return event;
  }
  return {
    ...event,
    message: {
      ...event.message,
      errorMessage: withCustomConnectionHint(
        event.message.errorMessage,
        baseUrl,
      ),
    },
  };
}

function isConnectionFailure(message: string): boolean {
  return /connection error|fetch failed|econnrefused|enotfound|network error/iu.test(
    message,
  );
}

function redactBaseUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/u, '');
}
