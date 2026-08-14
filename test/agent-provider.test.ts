import { describe, expect, it } from 'vitest';
import { createConfiguredProvider } from '../src/agent/provider/index.js';

describe('configured provider selection', () => {
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

  it('rejects incomplete or unknown provider configuration early', () => {
    expect(() => createConfiguredProvider({ id: 'openai' })).toThrow(
      'An API key is required for provider openai',
    );
    expect(() => createConfiguredProvider({ id: 'other' })).toThrow(
      'Unsupported provider: other',
    );
  });
});
