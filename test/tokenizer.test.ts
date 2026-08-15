import { describe, expect, it, vi } from 'vitest';
import {
  ApproximateUtf8TokenCounter,
  O200kTokenCounter,
  createTokenCounter,
} from '../src/core/context/tokenizer.js';
import type { ModelRef } from '../src/core/types.js';

describe('token counter selection', () => {
  it('keeps o200k for non-local providers', async () => {
    const selection = await createTokenCounter({ model: model('openai', 'gpt-4.1') });
    expect(selection.counter).toBeInstanceOf(O200kTokenCounter);
    expect(selection).toMatchObject({ source: 'builtin' });
    expect(selection.counter.precision).toBe('exact');
  });

  it('maps the local Qwen3.6 short name to its official tokenizer', async () => {
    const encode = vi.fn((text: string) => ({
      ids: [...text].map((_, index) => index),
    }));
    const load = vi.fn(async () => ({ encode }));
    const selection = await createTokenCounter({
      model: model('lmstudio', 'qwen3.6-27b'),
      load,
    });

    expect(load).toHaveBeenCalledWith('Qwen/Qwen3.6-27B', {
      local_files_only: false,
    });
    expect(selection).toMatchObject({ source: 'inferred' });
    expect(selection.counter.id).toBe('huggingface:Qwen/Qwen3.6-27B');
    expect(selection.counter.precision).toBe('exact');
    expect(selection.counter.countText('你好')).toBe(2);
  });

  it('does not perform IO when no assembly-layer loader is injected', async () => {
    const selection = await createTokenCounter({
      model: model('lmstudio', 'qwen3.6-27b'),
    });

    expect(selection.counter).toBeInstanceOf(ApproximateUtf8TokenCounter);
    expect(selection.warning).toContain('No tokenizer loader was injected');
  });

  it('uses an honestly labeled approximation for an unknown local tokenizer', async () => {
    const selection = await createTokenCounter({
      model: model('custom', 'unknown-gguf'),
    });

    expect(selection.counter).toBeInstanceOf(ApproximateUtf8TokenCounter);
    expect(selection.counter.precision).toBe('approximate');
    expect(selection.warning).toContain('No matching tokenizer');
  });

  it('does not hide an explicitly configured tokenizer failure', async () => {
    await expect(
      createTokenCounter({
        model: model('llamacpp', 'qwen-local'),
        source: '/missing/tokenizer',
        load: async () => {
          throw new Error('not found');
        },
      }),
    ).rejects.toThrow('Failed to load configured tokenizer /missing/tokenizer: not found');
  });
});

function model(provider: string, id: string): ModelRef {
  return {
    provider,
    id,
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    supportsNativeToolCalling: true,
    supportsThinking: false,
  };
}
