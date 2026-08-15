import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import type { TokenizerLike } from '../../core/context/tokenizer.js';

export interface AgentTokenizerLoaderOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type AgentTokenizerLoader = (
  source: string,
  options: { local_files_only: boolean },
) => Promise<TokenizerLike>;

/**
 * tokenizer 的文件/网络 IO 属于装配层。默认配置只读本地目录；只有调用方显式
 * 关闭 local_files_only 时才访问 Hugging Face，并受固定 deadline 约束。
 */
export function createAgentTokenizerLoader(
  options: AgentTokenizerLoaderOptions = {},
): AgentTokenizerLoader {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('tokenizer timeoutMs must be a positive integer');
  }
  const fetchImpl = options.fetch ?? fetch;
  return async (source, loadOptions) => {
    if (await isDirectory(source)) {
      const [tokenizer, config] = await Promise.all([
        readJson(join(source, 'tokenizer.json')),
        readJson(join(source, 'tokenizer_config.json')),
      ]);
      return new Tokenizer(tokenizer, config);
    }
    if (loadOptions.local_files_only) {
      throw new Error(
        `Tokenizer directory does not exist and network loading is disabled: ${source}`,
      );
    }
    return downloadTokenizer(source, fetchImpl, timeoutMs);
  };
}

async function downloadTokenizer(
  source: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<TokenizerLike> {
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu.test(source)) {
    throw new Error(`Invalid Hugging Face tokenizer repo id: ${source}`);
  }
  const controller = new AbortController();
  const timeoutError = new Error(
    `Tokenizer download timed out after ${timeoutMs} ms: ${source}`,
  );
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const root = `https://huggingface.co/${source}/resolve/main`;
  try {
    const [tokenizer, config] = await Promise.all([
      fetchJson(`${root}/tokenizer.json`, fetchImpl, controller.signal),
      fetchJson(`${root}/tokenizer_config.json`, fetchImpl, controller.signal),
    ]);
    return new Tokenizer(tokenizer, config);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    // 若一个并行请求先失败，立即取消另一个，不留下后台下载。
    if (!controller.signal.aborted) controller.abort();
  }
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

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { signal });
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
