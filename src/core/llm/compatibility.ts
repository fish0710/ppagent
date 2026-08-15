import type {
  Context,
  ModelRef,
  Provider,
  StopReason,
  ToolCallBlock,
} from '../types.js';

export interface NativeToolCompatibilityReport {
  ok: boolean;
  provider: string;
  model: string;
  stopReason?: StopReason;
  call?: ToolCallBlock;
  errors: string[];
}

export interface NativeToolCompatibilityOptions {
  signal?: AbortSignal;
  token?: string;
}

/**
 * 主动验证 endpoint/model/chat-template 组合，而不是相信模型名。只有收到原生
 * toolcall_end、匹配的终态 toolCall 和正确参数，才把组合判为兼容。
 */
export async function validateNativeToolCalling(
  provider: Provider,
  model: ModelRef,
  options: NativeToolCompatibilityOptions = {},
): Promise<NativeToolCompatibilityReport> {
  const token = options.token ?? 'ppagent-native-tool-call';
  const context: Context = {
    messages: [
      {
        role: 'user',
        content: `Call ppagent_compat_probe exactly once with token ${JSON.stringify(token)}. Do not answer with text.`,
        timestamp: Date.now(),
      },
    ],
    tools: [
      {
        name: 'ppagent_compat_probe',
        description: 'Compatibility probe. Always call this tool as instructed.',
        parameters: {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
          additionalProperties: false,
        },
      },
    ],
  };
  const errors: string[] = [];
  const streamedCalls: ToolCallBlock[] = [];
  let finalCalls: ToolCallBlock[] = [];
  let stopReason: StopReason | undefined;
  let terminal = false;
  try {
    for await (const event of provider.stream(model, context, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      temperature: 0,
    })) {
      if (event.type === 'toolcall_end') streamedCalls.push(event.call);
      if (event.type === 'done' || event.type === 'error') {
        terminal = true;
        stopReason = event.message.stopReason;
        finalCalls = event.message.content.filter(
          (block): block is ToolCallBlock => block.type === 'toolCall',
        );
        if (event.type === 'error') {
          errors.push(event.message.errorMessage ?? 'Provider returned an error event.');
        }
        break;
      }
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }
  if (!terminal) errors.push('Provider stream ended without a terminal event.');
  if (stopReason !== 'toolUse') {
    errors.push(`Expected stopReason toolUse, received ${stopReason ?? 'none'}.`);
  }
  if (streamedCalls.length !== 1) {
    errors.push(`Expected one native streamed tool call, received ${streamedCalls.length}.`);
  }
  if (finalCalls.length !== 1) {
    errors.push(`Expected one toolCall in the final assistant message, received ${finalCalls.length}.`);
  }
  const call = streamedCalls[0];
  if (call !== undefined) {
    if (call.name !== 'ppagent_compat_probe') {
      errors.push(`Expected ppagent_compat_probe, received ${call.name}.`);
    }
    if (!isRecord(call.arguments) || call.arguments['token'] !== token) {
      errors.push('Native tool arguments did not preserve the compatibility token.');
    }
    if (!finalCalls.some((candidate) => candidate.id === call.id)) {
      errors.push('Streamed tool call id is missing from the final assistant message.');
    }
  }
  return {
    ok: errors.length === 0,
    provider: model.provider,
    model: model.id,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(call === undefined ? {} : { call }),
    errors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
