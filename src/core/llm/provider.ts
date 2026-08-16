import type {
  AssistantMessage,
  ModelOrigin,
  ModelRef,
  Provider,
  StreamEvent,
  Usage,
} from '../types.js';

export type {
  AssistantMessage,
  Context,
  ReadonlyContext,
  ModelEffort,
  ModelRef,
  Provider,
  StreamEvent,
  StreamOptions,
} from '../types.js';

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function createErrorMessage(
  message: string,
  options: {
    reason?: 'error' | 'aborted';
    origin?: ModelOrigin;
    content?: AssistantMessage['content'];
    now?: () => number;
  } = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: options.content ?? [],
    stopReason: options.reason ?? 'error',
    usage: emptyUsage(),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    errorMessage: message,
    timestamp: (options.now ?? Date.now)(),
  };
}

export function findModel(
  models: readonly ModelRef[],
  provider: string,
  id: string,
): ModelRef | undefined {
  return models.find((model) => model.provider === provider && model.id === id);
}

export function isTerminalEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: 'done' | 'error' }> {
  return event.type === 'done' || event.type === 'error';
}

export function modelOrigin(model: ModelRef): ModelOrigin {
  return { provider: model.provider, model: model.id };
}

export function assertKnownModel(
  provider: Pick<Provider, 'listModels'>,
  model: ModelRef,
): ModelRef {
  const known = findModel(provider.listModels(), model.provider, model.id);
  if (known === undefined) {
    throw new Error(`Unknown model: ${model.provider}/${model.id}`);
  }
  return known;
}
