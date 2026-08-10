import { describe, expect, it } from 'vitest';
import { readCustomSmokeEnvironment } from '../bin/smoke-env.js';

describe('custom smoke environment', () => {
  it('allows a custom provider without an API key', () => {
    expect(
      readCustomSmokeEnvironment({
        PPAGENT_CUSTOM_BASE_URL: ' http://localhost:11434/v1/ ',
      }),
    ).toEqual({ baseUrl: 'http://localhost:11434/v1/' });
  });

  it('treats an empty custom API key as absent', () => {
    expect(
      readCustomSmokeEnvironment({
        PPAGENT_CUSTOM_BASE_URL: 'http://localhost:11434/v1',
        PPAGENT_CUSTOM_API_KEY: '   ',
      }),
    ).toEqual({ baseUrl: 'http://localhost:11434/v1' });
  });

  it('reads only PPAgent-scoped custom credentials', () => {
    expect(
      readCustomSmokeEnvironment({
        PPAGENT_CUSTOM_BASE_URL: 'http://localhost:11434/v1',
        PPAGENT_CUSTOM_API_KEY: ' local-key ',
        OPENAI_API_KEY: 'real-openai-key',
      }),
    ).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'local-key',
    });
  });

  it('requires the PPAgent-scoped custom base URL', () => {
    expect(() =>
      readCustomSmokeEnvironment({
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
      }),
    ).toThrow(
      'PPAGENT_CUSTOM_BASE_URL is required for the custom smoke test',
    );
  });
});
