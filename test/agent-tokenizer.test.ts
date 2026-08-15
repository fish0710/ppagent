import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentTokenizerLoader } from '../src/agent/tokenizer/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('agent tokenizer loader', () => {
  it('loads tokenizer files from an explicit local directory without fetch', async () => {
    const directory = await tokenizerDirectory();
    const fetchMock = vi.fn<typeof fetch>();
    const load = createAgentTokenizerLoader({ fetch: fetchMock });

    const tokenizer = await load(directory, { local_files_only: true });

    expect(tokenizer.encode('hello').ids).toEqual([1]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not turn a repo id into a network request in local-only mode', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const load = createAgentTokenizerLoader({ fetch: fetchMock });

    await expect(
      load('Qwen/Qwen3.6-27B', { local_files_only: true }),
    ).rejects.toThrow('network loading is disabled');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads both files only after explicit opt-in', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      new Response(
        String(input).endsWith('tokenizer.json')
          ? JSON.stringify(TOKENIZER_JSON)
          : '{}',
        { status: 200 },
      ),
    );
    const load = createAgentTokenizerLoader({
      fetch: fetchMock as typeof fetch,
      timeoutMs: 1_000,
    });

    const tokenizer = await load('Qwen/Qwen3.6-27B', {
      local_files_only: false,
    });

    expect(tokenizer.encode('hello').ids).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts a stalled download at the configured deadline', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const load = createAgentTokenizerLoader({
      fetch: fetchMock as typeof fetch,
      timeoutMs: 5,
    });

    await expect(
      load('Qwen/Qwen3.6-27B', { local_files_only: false }),
    ).rejects.toThrow('timed out after 5 ms');
  });
});

async function tokenizerDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ppagent-tokenizer-'));
  temporaryDirectories.push(directory);
  await Promise.all([
    writeFile(join(directory, 'tokenizer.json'), JSON.stringify(TOKENIZER_JSON)),
    writeFile(join(directory, 'tokenizer_config.json'), '{}'),
  ]);
  return directory;
}

const TOKENIZER_JSON = {
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [],
  normalizer: null,
  pre_tokenizer: { type: 'Whitespace' },
  post_processor: null,
  decoder: null,
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: { '[UNK]': 0, hello: 1 },
  },
};
