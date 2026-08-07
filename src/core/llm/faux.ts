import type {
  AssistantMessage,
  Context,
  ModelRef,
  Provider,
  StreamEvent,
  StreamOptions,
  ToolCallBlock,
} from '../types.js';
import {
  assertKnownModel,
  createErrorMessage,
  emptyUsage,
  isTerminalEvent,
  modelOrigin,
} from './provider.js';

type FauxEmission = Exclude<StreamEvent, { type: 'start' }>;

export type FauxStep =
  | FauxEmission
  | { type: 'delay'; ms: number }
  | { type: 'throw'; message: string };

export interface FauxTurn {
  steps: FauxStep[];
}

export interface FauxProviderOptions {
  id?: string;
  models?: ModelRef[];
  turns?: FauxTurn[];
  now?: () => number;
}

const DEFAULT_MODEL: ModelRef = {
  provider: 'faux',
  id: 'faux-model',
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
  supportsNativeToolCalling: true,
  supportsThinking: true,
};

export class FauxProvider implements Provider {
  readonly id: string;
  readonly #models: ModelRef[];
  readonly #turns: FauxTurn[];
  readonly #now: () => number;

  constructor(options: FauxProviderOptions = {}) {
    this.id = options.id ?? 'faux';
    this.#models = structuredClone(options.models ?? [DEFAULT_MODEL]);
    this.#turns = [...(options.turns ?? [])];
    this.#now = options.now ?? Date.now;
  }

  listModels(): ModelRef[] {
    return structuredClone(this.#models);
  }

  enqueue(...turns: FauxTurn[]): void {
    this.#turns.push(...turns);
  }

  pendingTurns(): number {
    return this.#turns.length;
  }

  async *stream(
    model: ModelRef,
    _ctx: Context,
    opts: StreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    let known: ModelRef;
    try {
      known = assertKnownModel(this, model);
    } catch (error) {
      yield { type: 'start' };
      yield this.#errorEvent(errorMessage(error), model, 'error');
      return;
    }

    yield { type: 'start' };
    if (opts.signal?.aborted === true) {
      yield this.#errorEvent('Faux stream aborted', known, 'aborted');
      return;
    }

    const turn = this.#turns.shift();
    if (turn === undefined) {
      yield this.#errorEvent('No more faux turns queued', known, 'error');
      return;
    }

    try {
      for (const step of turn.steps) {
        if (isAborted(opts.signal)) {
          yield this.#errorEvent('Faux stream aborted', known, 'aborted');
          return;
        }

        if (step.type === 'delay') {
          const completed = await abortableDelay(step.ms, opts.signal);
          if (!completed) {
            yield this.#errorEvent('Faux stream aborted', known, 'aborted');
            return;
          }
          continue;
        }
        if (step.type === 'throw') {
          throw new Error(step.message);
        }

        yield step;
        if (isTerminalEvent(step)) return;
      }
    } catch (error) {
      yield this.#errorEvent(errorMessage(error), known, 'error');
      return;
    }

    yield this.#errorEvent(
      'Faux turn ended without a done or error event',
      known,
      'error',
    );
  }

  #errorEvent(
    message: string,
    model: ModelRef,
    reason: 'error' | 'aborted',
  ): Extract<StreamEvent, { type: 'error' }> {
    return {
      type: 'error',
      reason,
      message: createErrorMessage(message, {
        reason,
        origin: modelOrigin(model),
        now: this.#now,
      }),
    };
  }
}

export function textTurn(
  text: string,
  options: {
    chunkSize?: number;
    delayMs?: number;
    now?: () => number;
    origin?: AssistantMessage['origin'];
  } = {},
): FauxTurn {
  const steps: FauxStep[] = [];
  for (const chunk of splitText(text, (options.chunkSize ?? text.length) || 1)) {
    if ((options.delayMs ?? 0) > 0) {
      steps.push({ type: 'delay', ms: options.delayMs ?? 0 });
    }
    steps.push({ type: 'text_delta', delta: chunk });
  }
  steps.push({
    type: 'done',
    message: assistantMessage(
      [{ type: 'text', text }],
      'stop',
      options.now,
      options.origin,
    ),
  });
  return { steps };
}

export function toolCallTurn(options: {
  id?: string;
  name: string;
  rawArguments: string;
  argumentChunkSize?: number;
  delayMs?: number;
  now?: () => number;
  origin?: AssistantMessage['origin'];
}): FauxTurn {
  const call: ToolCallBlock = {
    type: 'toolCall',
    id: options.id ?? 'faux-call-1',
    name: options.name,
    arguments: parseOrKeepRaw(options.rawArguments),
  };
  const steps: FauxStep[] = [{ type: 'toolcall_start', index: 0 }];
  for (const chunk of splitText(
    options.rawArguments,
    (options.argumentChunkSize ?? options.rawArguments.length) || 1,
  )) {
    if ((options.delayMs ?? 0) > 0) {
      steps.push({ type: 'delay', ms: options.delayMs ?? 0 });
    }
    steps.push({ type: 'toolcall_delta', index: 0, delta: chunk });
  }
  steps.push({ type: 'toolcall_end', index: 0, call });
  steps.push({
    type: 'done',
    message: assistantMessage(
      [call],
      'toolUse',
      options.now,
      options.origin,
    ),
  });
  return { steps };
}

export function errorTurn(
  message: string,
  options: {
    afterText?: string;
    reason?: 'error' | 'aborted';
    now?: () => number;
    origin?: AssistantMessage['origin'];
  } = {},
): FauxTurn {
  const content =
    options.afterText === undefined
      ? []
      : [{ type: 'text' as const, text: options.afterText }];
  const steps: FauxStep[] = [];
  if (options.afterText !== undefined) {
    steps.push({ type: 'text_delta', delta: options.afterText });
  }
  const reason = options.reason ?? 'error';
  steps.push({
    type: 'error',
    reason,
    message: {
      ...assistantMessage(content, reason, options.now, options.origin),
      errorMessage: message,
    },
  });
  return { steps };
}

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  now: (() => number) | undefined,
  origin: AssistantMessage['origin'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    stopReason,
    usage: emptyUsage(),
    ...(origin === undefined ? {} : { origin }),
    timestamp: (now ?? Date.now)(),
  };
}

function splitText(text: string, size: number): string[] {
  const normalizedSize = Math.max(1, Math.floor(size));
  if (text.length === 0) return [''];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += normalizedSize) {
    chunks.push(text.slice(index, index + normalizedSize));
  }
  return chunks;
}

function parseOrKeepRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
