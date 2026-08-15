import { countTokens } from 'gpt-tokenizer';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import type {
  ContentBlock,
  ReadonlyContext,
  Message,
  TokenCounter,
  ModelRef,
} from '../types.js';

/**
 * M5 的默认真实 BPE 计数器。
 *
 * o200k_base 不是所有本地模型的词表，所以计数器保持可注入；M11 接具体
 * endpoint/model 时可换成服务端 tokenizer。这里的重要边界是“不用字符数估算”。
 */
export class O200kTokenCounter implements TokenCounter {
  readonly id = 'o200k_base';
  readonly precision = 'exact';

  countText(text: string): number {
    return countTokens(text);
  }

  countMessages(messages: readonly Message[]): number {
    return this.countText(JSON.stringify(messages.map(messageTokenShape)));
  }

  countContext(context: ReadonlyContext): number {
    return this.countText(
      JSON.stringify({
        ...(context.systemPrompt === undefined
          ? {}
          : { systemPrompt: context.systemPrompt }),
        messages: context.messages.map(messageTokenShape),
        ...(context.tools === undefined ? {} : { tools: context.tools }),
      }),
    );
  }
}

export class HuggingFaceTokenCounter implements TokenCounter {
  readonly id: string;
  readonly precision = 'exact';
  readonly #tokenizer: TokenizerLike;

  constructor(source: string, tokenizer: TokenizerLike) {
    this.id = `huggingface:${source}`;
    this.#tokenizer = tokenizer;
  }

  countText(text: string): number {
    return this.#tokenizer.encode(text, { add_special_tokens: false }).ids.length;
  }

  countMessages(messages: readonly Message[]): number {
    return this.countText(JSON.stringify(messages.map(messageTokenShape)));
  }

  countContext(context: ReadonlyContext): number {
    return this.countText(serializedContext(context));
  }
}

/**
 * 最后防线：按 UTF-8 字节保守估计并明确标成 approximate。它可避免无 tokenizer
 * 时完全失去 compact，但绝不会被日志或文档描述成模型的精确 token 数。
 */
export class ApproximateUtf8TokenCounter implements TokenCounter {
  readonly id = 'approximate:utf8-bytes-per-3';
  readonly precision = 'approximate';

  countText(text: string): number {
    return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 3));
  }

  countMessages(messages: readonly Message[]): number {
    return this.countText(JSON.stringify(messages.map(messageTokenShape)));
  }

  countContext(context: ReadonlyContext): number {
    return this.countText(serializedContext(context));
  }
}

export interface CreateTokenCounterOptions {
  model: ModelRef;
  /** 本地 tokenizer 目录或 Hugging Face repo id；显式值加载失败时直接报错。 */
  source?: string;
  localFilesOnly?: boolean;
  load?: (
    source: string,
    options: { local_files_only: boolean },
  ) => Promise<TokenizerLike>;
}

export interface TokenizerLike {
  encode(
    text: string,
    options?: { add_special_tokens?: boolean },
  ): { ids: readonly number[] };
}

export interface TokenCounterSelection {
  counter: TokenCounter;
  source: 'builtin' | 'configured' | 'inferred' | 'fallback';
  warning?: string;
}

/** 按 endpoint/model 选择词表；Qwen3.6 的短模型名映射到其官方 tokenizer。 */
export async function createTokenCounter(
  options: CreateTokenCounterOptions,
): Promise<TokenCounterSelection> {
  if (!isLocalProvider(options.model.provider)) {
    return { counter: new O200kTokenCounter(), source: 'builtin' };
  }
  const explicit = nonEmpty(options.source);
  const inferred = inferredTokenizer(options.model.id);
  const source = explicit ?? inferred;
  if (source === undefined) {
    return {
      counter: new ApproximateUtf8TokenCounter(),
      source: 'fallback',
      warning: `No matching tokenizer is configured for ${options.model.provider}/${options.model.id}; using an explicitly approximate UTF-8 counter. Set PPAGENT_TOKENIZER to a local tokenizer directory or Hugging Face tokenizer id.`,
    };
  }
  const load = options.load ?? loadHuggingFaceTokenizer;
  try {
    const tokenizer = await load(source, {
      local_files_only: options.localFilesOnly === true,
    });
    return {
      counter: new HuggingFaceTokenCounter(source, tokenizer),
      source: explicit === undefined ? 'inferred' : 'configured',
    };
  } catch (error) {
    if (explicit !== undefined) {
      throw new Error(`Failed to load configured tokenizer ${source}: ${errorMessage(error)}`);
    }
    return {
      counter: new ApproximateUtf8TokenCounter(),
      source: 'fallback',
      warning: `Could not load inferred tokenizer ${source} for ${options.model.id}: ${errorMessage(error)}. Using an explicitly approximate UTF-8 counter; set PPAGENT_TOKENIZER to a local tokenizer directory for offline exact counting.`,
    };
  }
}

/**
 * 只加载 tokenizer.json/config，不引入推理 runtime。source 若是现有目录则离线
 * 读取；否则按 Hugging Face repo id 获取。localFilesOnly 会明确禁止网络回退。
 */
async function loadHuggingFaceTokenizer(
  source: string,
  options: { local_files_only: boolean },
): Promise<TokenizerLike> {
  if (await isDirectory(source)) {
    const [tokenizer, config] = await Promise.all([
      readJson(join(source, 'tokenizer.json')),
      readJson(join(source, 'tokenizer_config.json')),
    ]);
    return new Tokenizer(tokenizer, config);
  }
  if (options.local_files_only) {
    throw new Error(`Tokenizer directory does not exist: ${source}`);
  }
  const root = `https://huggingface.co/${source
    .split('/')
    .map(encodeURIComponent)
    .join('/')}/resolve/main`;
  const [tokenizer, config] = await Promise.all([
    fetchJson(`${root}/tokenizer.json`),
    fetchJson(`${root}/tokenizer_config.json`),
  ]);
  return new Tokenizer(tokenizer, config);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return parseJson(await readFile(path, 'utf8'), path);
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return parseJson(await response.text(), url);
}

function parseJson(text: string, source: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Tokenizer JSON must be an object: ${source}`);
  }
  return value as Record<string, unknown>;
}

function messageTokenShape(message: Message): unknown {
  switch (message.role) {
    case 'user':
      return {
        role: message.role,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(contentTokenShape),
      };
    case 'assistant':
      return {
        role: message.role,
        content: message.content.map(contentTokenShape),
      };
    case 'toolResult':
      return {
        role: message.role,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map(contentTokenShape),
        isError: message.isError,
        ...(message.truncated === true ? { truncated: true } : {}),
      };
  }
}

function serializedContext(context: ReadonlyContext): string {
  return JSON.stringify({
    ...(context.systemPrompt === undefined
      ? {}
      : { systemPrompt: context.systemPrompt }),
    messages: context.messages.map(messageTokenShape),
    ...(context.tools === undefined ? {} : { tools: context.tools }),
  });
}

function contentTokenShape(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: block.type, text: block.text };
    case 'thinking':
      return { type: block.type, thinking: block.thinking };
    case 'toolCall':
      return {
        type: block.type,
        id: block.id,
        name: block.name,
        arguments: safeStringify(block.arguments),
      };
    case 'image':
      // 图片 token 取决于 provider 的视觉编码，不把 base64 字符误算成文本 token。
      return { type: block.type, mimeType: block.mimeType, image: '[binary]' };
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

function inferredTokenizer(modelId: string): string | undefined {
  if (/^(?:qwen\/)?qwen3\.6-27b(?:[-_.].*)?$/iu.test(modelId)) {
    return 'Qwen/Qwen3.6-27B';
  }
  return undefined;
}

function isLocalProvider(provider: string): boolean {
  return provider === 'custom' || provider === 'lmstudio' || provider === 'llamacpp';
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
