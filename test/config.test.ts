import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configFromEnvironment,
  loadAgentConfig,
  mergeAgentConfig,
} from '../src/agent/config/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('agent config', () => {
  it('merges defaults < file < environment < CLI into a plain object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppagent-config-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'agent.json');
    await writeFile(
      path,
      JSON.stringify({
        provider: { id: 'custom', model: 'file-model', baseUrl: 'http://file/v1' },
        loop: { maxTurns: 2 },
        tools: { maxConcurrency: 1 },
      }),
    );

    const config = await loadAgentConfig({
      filePath: path,
      env: {
        PPAGENT_MODEL: 'env-model',
        PPAGENT_CUSTOM_API_KEY: 'env-secret',
        PPAGENT_MAX_TURNS: '3',
        PPAGENT_SANDBOX_NETWORK_ALLOWLIST: 'localhost:1234,*:443',
      },
      cli: {
        provider: { model: 'cli-model' },
        loop: { maxTurns: 4 },
      },
    });

    expect(config).toMatchObject({
      provider: {
        id: 'custom',
        model: 'cli-model',
        baseUrl: 'http://file/v1',
        apiKey: 'env-secret',
      },
      loop: { maxTurns: 4, turnTimeoutMs: 120_000 },
      tools: { maxConcurrency: 1 },
      sandbox: { networkAllowlist: ['localhost:1234', '*:443'] },
      context: {
        tokenizerLocalOnly: true,
        tokenizerTimeoutMs: 30_000,
      },
    });
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
  });

  it('does not send an OpenAI key to a custom provider', () => {
    const source = configFromEnvironment(
      {
        OPENAI_API_KEY: 'real-openai-key',
        PPAGENT_CUSTOM_BASE_URL: 'http://localhost:11434/v1',
      },
      'custom',
    );

    expect(source.provider).toEqual({
      id: 'custom',
      baseUrl: 'http://localhost:11434/v1',
    });

    const switched = mergeAgentConfig(
      {
        provider: {
          id: 'openai',
          model: 'gpt-4.1-mini',
          apiKey: 'real-openai-key',
        },
      },
      {
        provider: {
          id: 'custom',
          model: 'qwen-local',
          baseUrl: 'http://localhost:11434/v1',
        },
      },
    );
    expect(switched.provider).toEqual({
      id: 'custom',
      model: 'qwen-local',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('uses the custom credential domain for local provider aliases', () => {
    expect(
      configFromEnvironment(
        {
          OPENAI_API_KEY: 'must-not-leak',
          PPAGENT_CUSTOM_API_KEY: 'local-key',
          PPAGENT_CUSTOM_BASE_URL: 'http://host.docker.internal:1234/v1',
        },
        'lmstudio',
      ).provider,
    ).toEqual({
      id: 'lmstudio',
      apiKey: 'local-key',
      baseUrl: 'http://host.docker.internal:1234/v1',
    });
  });

  it('requires an explicit opt-in before tokenizer network loading', () => {
    expect(mergeAgentConfig().context.tokenizerLocalOnly).toBe(true);
    expect(
      mergeAgentConfig(
        configFromEnvironment({
          PPAGENT_TOKENIZER_LOCAL_ONLY: 'false',
          PPAGENT_TOKENIZER_TIMEOUT_MS: '45000',
        }),
      ).context,
    ).toMatchObject({
      tokenizerLocalOnly: false,
      tokenizerTimeoutMs: 45_000,
    });
  });

  it('validates merged numeric constraints at the agent boundary', () => {
    expect(() =>
      mergeAgentConfig({ loop: { maxTurns: 0 } }),
    ).toThrow('loop.maxTurns must be a positive integer');
    expect(() =>
      configFromEnvironment({ PPAGENT_MAX_TURNS: 'many' }),
    ).toThrow('PPAGENT_MAX_TURNS must be a number');
  });

  it('merges maxOutputTokens/effort/maxLengthContinuations across file < env < CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppagent-config-effort-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'agent.json');
    await writeFile(
      path,
      JSON.stringify({
        provider: { id: 'anthropic', maxOutputTokens: 1_000, effort: 'high' },
        loop: { maxLengthContinuations: 1 },
      }),
    );

    const config = await loadAgentConfig({
      filePath: path,
      env: {
        ANTHROPIC_API_KEY: 'env-secret',
        PPAGENT_MAX_OUTPUT_TOKENS: '2000',
        PPAGENT_EFFORT: 'low',
      },
      cli: {
        provider: { effort: 'medium' },
        loop: { maxLengthContinuations: 3 },
      },
    });

    expect(config).toMatchObject({
      provider: { maxOutputTokens: 2_000, effort: 'medium' },
      loop: { maxLengthContinuations: 3 },
    });
  });

  it('keeps PPAGENT_MAX_TOKENS (contextWindow) and PPAGENT_MAX_OUTPUT_TOKENS independent', () => {
    const source = configFromEnvironment({
      PPAGENT_MAX_TOKENS: '50000',
      PPAGENT_MAX_OUTPUT_TOKENS: '4096',
    });
    expect(source.context).toMatchObject({ contextWindow: 50_000 });
    expect(source.provider).toMatchObject({ maxOutputTokens: 4_096 });
  });

  it('validates provider.maxOutputTokens, provider.effort, and loop.maxLengthContinuations', () => {
    expect(() =>
      mergeAgentConfig({ provider: { id: 'faux', maxOutputTokens: 0 } }),
    ).toThrow('provider.maxOutputTokens must be a positive integer');
    expect(() =>
      mergeAgentConfig({ provider: { id: 'faux', effort: 'extreme' as never } }),
    ).toThrow('provider.effort must be one of low, medium, high, xhigh, max');
    expect(() =>
      mergeAgentConfig({ loop: { maxLengthContinuations: -1 } }),
    ).toThrow('loop.maxLengthContinuations must be a non-negative integer');
    expect(() =>
      configFromEnvironment({ PPAGENT_EFFORT: 'extreme' }),
    ).toThrow('PPAGENT_EFFORT must be one of low, medium, high, xhigh, max');
    expect(() =>
      configFromEnvironment({ PPAGENT_MAX_OUTPUT_TOKENS: 'many' }),
    ).toThrow('PPAGENT_MAX_OUTPUT_TOKENS must be a number');
  });

  it('defaults maxLengthContinuations to 2 and allows disabling it with 0', () => {
    expect(mergeAgentConfig().loop.maxLengthContinuations).toBe(2);
    expect(
      mergeAgentConfig({ loop: { maxLengthContinuations: 0 } }).loop
        .maxLengthContinuations,
    ).toBe(0);
  });

  it('reports invalid JSON field types without leaking a TypeError', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppagent-config-invalid-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'agent.json');
    await writeFile(path, JSON.stringify({ provider: { id: 42 } }));

    await expect(loadAgentConfig({ filePath: path, env: {} })).rejects.toThrow(
      'provider.id must not be empty',
    );
  });
});
