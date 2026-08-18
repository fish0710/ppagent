import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/** 每个测试独立的 homeDir/cwd，避免碰运行测试的机器的真实 ~ 和 cwd。 */
async function isolatedDirs(): Promise<{ homeDir: string; cwd: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'ppagent-config-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'ppagent-config-cwd-'));
  temporaryDirectories.push(homeDir, cwd);
  return { homeDir, cwd };
}

describe('agent config', () => {
  it('merges defaults < file < environment < CLI into a plain object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppagent-config-'));
    temporaryDirectories.push(directory);
    const { homeDir, cwd } = await isolatedDirs();
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
      homeDir,
      cwd,
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
      loop: { maxTurns: 4, turnTimeoutMs: 1_200_000 },
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
      mergeAgentConfig({ loop: { maxTurns: -1 } }),
    ).toThrow('loop.maxTurns must be a non-negative integer');
    expect(() =>
      mergeAgentConfig({ loop: { turnTimeoutMs: -1 } }),
    ).toThrow('loop.turnTimeoutMs must be a non-negative integer');
    expect(() =>
      configFromEnvironment({ PPAGENT_MAX_TURNS: 'many' }),
    ).toThrow('PPAGENT_MAX_TURNS must be a number');
  });

  it('accepts 0 for loop.maxTurns and loop.turnTimeoutMs (disabled)', () => {
    const config = mergeAgentConfig({
      loop: { maxTurns: 0, turnTimeoutMs: 0 },
    });
    expect(config.loop).toMatchObject({ maxTurns: 0, turnTimeoutMs: 0 });
    expect(configFromEnvironment({ PPAGENT_MAX_TURNS: '0' }).loop).toMatchObject({
      maxTurns: 0,
    });
  });

  it('merges maxOutputTokens/effort/maxLengthContinuations across file < env < CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppagent-config-effort-'));
    temporaryDirectories.push(directory);
    const { homeDir, cwd } = await isolatedDirs();
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
      homeDir,
      cwd,
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

  it('defaults maxTurns to 60 and turnTimeoutMs to 1200000ms (600s model + 600s tools)', () => {
    expect(mergeAgentConfig().loop).toMatchObject({
      maxTurns: 60,
      turnTimeoutMs: 1_200_000,
    });
  });

  it('merges requestTimeoutMs/maxRetries across file < env < CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppagent-config-timeout-'));
    temporaryDirectories.push(directory);
    const { homeDir, cwd } = await isolatedDirs();
    const path = join(directory, 'agent.json');
    await writeFile(
      path,
      JSON.stringify({
        provider: { id: 'lmstudio', requestTimeoutMs: 60_000, maxRetries: 5 },
      }),
    );

    const fileOnly = await loadAgentConfig({
      filePath: path,
      homeDir,
      cwd,
      env: {},
    });
    expect(fileOnly.provider).toMatchObject({
      requestTimeoutMs: 60_000,
      maxRetries: 5,
    });

    const withEnv = await loadAgentConfig({
      filePath: path,
      homeDir,
      cwd,
      env: { PPAGENT_REQUEST_TIMEOUT_MS: '300000', PPAGENT_MAX_RETRIES: '0' },
    });
    expect(withEnv.provider).toMatchObject({
      requestTimeoutMs: 300_000,
      maxRetries: 0,
    });

    const withCli = await loadAgentConfig({
      filePath: path,
      homeDir,
      cwd,
      env: { PPAGENT_REQUEST_TIMEOUT_MS: '300000', PPAGENT_MAX_RETRIES: '0' },
      cli: { provider: { requestTimeoutMs: 600_000, maxRetries: 3 } },
    });
    expect(withCli.provider).toMatchObject({
      requestTimeoutMs: 600_000,
      maxRetries: 3,
    });
  });

  it('validates provider.requestTimeoutMs and provider.maxRetries', () => {
    expect(() =>
      mergeAgentConfig({ provider: { id: 'faux', requestTimeoutMs: 0 } }),
    ).toThrow('provider.requestTimeoutMs must be a positive integer');
    expect(() =>
      mergeAgentConfig({ provider: { id: 'faux', maxRetries: -1 } }),
    ).toThrow('provider.maxRetries must be a non-negative integer');
    expect(() =>
      configFromEnvironment({ PPAGENT_REQUEST_TIMEOUT_MS: 'many' }),
    ).toThrow('PPAGENT_REQUEST_TIMEOUT_MS must be a number');
    expect(() =>
      configFromEnvironment({ PPAGENT_MAX_RETRIES: 'many' }),
    ).toThrow('PPAGENT_MAX_RETRIES must be a number');
    // maxRetries: 0 must be accepted (disables retries), not treated as falsy/invalid.
    expect(
      mergeAgentConfig({ provider: { id: 'faux', maxRetries: 0 } }).provider
        .maxRetries,
    ).toBe(0);
  });

  it('keeps PPAGENT_REQUEST_TIMEOUT_MS independent of the other *_TIMEOUT_MS env vars', () => {
    const source = configFromEnvironment({
      PPAGENT_REQUEST_TIMEOUT_MS: '5000',
      PPAGENT_TURN_TIMEOUT_MS: '90000',
      PPAGENT_TOOL_TIMEOUT_MS: '10000',
      PPAGENT_TOKENIZER_TIMEOUT_MS: '20000',
    });
    expect(source.provider).toMatchObject({ requestTimeoutMs: 5_000 });
    expect(source.loop).toMatchObject({ turnTimeoutMs: 90_000 });
    expect(source.tools).toMatchObject({ toolTimeoutMs: 10_000 });
    expect(source.context).toMatchObject({ tokenizerTimeoutMs: 20_000 });
  });

  it('reports invalid JSON field types without leaking a TypeError', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppagent-config-invalid-'));
    temporaryDirectories.push(directory);
    const { homeDir, cwd } = await isolatedDirs();
    const path = join(directory, 'agent.json');
    await writeFile(path, JSON.stringify({ provider: { id: 42 } }));

    await expect(
      loadAgentConfig({ filePath: path, homeDir, cwd, env: {} }),
    ).rejects.toThrow('provider.id must not be empty');
  });
});

describe('three-tier config discovery (global/project/project.local)', () => {
  it('auto-creates the global config on first run and reuses it thereafter', async () => {
    const { homeDir, cwd } = await isolatedDirs();
    const globalPath = join(homeDir, '.ppagent', 'agent.json');

    const config = await loadAgentConfig({ homeDir, cwd, env: {} });
    expect(config.provider.id).toBe('faux');

    const written = JSON.parse(await readFile(globalPath, 'utf8')) as unknown;
    expect(written).toMatchObject({ provider: { id: 'faux' } });

    // 第二次加载不应该报错、也不应该改写已经存在的文件。
    const mtimeBefore = (await stat(globalPath)).mtimeMs;
    await loadAgentConfig({ homeDir, cwd, env: {} });
    const mtimeAfter = (await stat(globalPath)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('does not overwrite an existing global config', async () => {
    const { homeDir, cwd } = await isolatedDirs();
    const globalDir = join(homeDir, '.ppagent');
    const globalPath = join(globalDir, 'agent.json');
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      globalPath,
      JSON.stringify({ provider: { id: 'anthropic', model: 'custom-global-model' } }),
    );

    const config = await loadAgentConfig({
      homeDir,
      cwd,
      env: { ANTHROPIC_API_KEY: 'k' },
    });

    expect(config.provider).toMatchObject({
      id: 'anthropic',
      model: 'custom-global-model',
    });
    const stillThere = JSON.parse(await readFile(globalPath, 'utf8')) as unknown;
    expect(stillThere).toEqual({
      provider: { id: 'anthropic', model: 'custom-global-model' },
    });
  });

  it('resolves project.local over project over global', async () => {
    const { homeDir, cwd } = await isolatedDirs();
    await mkdir(join(homeDir, '.ppagent'), { recursive: true });
    await writeFile(
      join(homeDir, '.ppagent', 'agent.json'),
      JSON.stringify({ loop: { maxTurns: 1 }, provider: { id: 'faux' } }),
    );
    await writeFile(
      join(cwd, 'agent.json'),
      JSON.stringify({ loop: { maxTurns: 2 } }),
    );
    await writeFile(
      join(cwd, 'agent.local.json'),
      JSON.stringify({ loop: { maxTurns: 3 } }),
    );

    const fileOnly = await loadAgentConfig({ homeDir, cwd, env: {} });
    expect(fileOnly.loop.maxTurns).toBe(3);

    const withEnv = await loadAgentConfig({
      homeDir,
      cwd,
      env: { PPAGENT_MAX_TURNS: '4' },
    });
    expect(withEnv.loop.maxTurns).toBe(4);

    const withCli = await loadAgentConfig({
      homeDir,
      cwd,
      env: { PPAGENT_MAX_TURNS: '4' },
      cli: { loop: { maxTurns: 5 } },
    });
    expect(withCli.loop.maxTurns).toBe(5);
  });

  it('tolerates a missing project and project.local file', async () => {
    const { homeDir, cwd } = await isolatedDirs();
    const config = await loadAgentConfig({ homeDir, cwd, env: {} });
    expect(config.provider.id).toBe('faux');
    // global 仍然应该被自动创建。
    const written = JSON.parse(
      await readFile(join(homeDir, '.ppagent', 'agent.json'), 'utf8'),
    ) as unknown;
    expect(written).toMatchObject({ provider: { id: 'faux' } });
  });

  it('surfaces a genuinely malformed global config instead of silently ignoring it', async () => {
    const { homeDir, cwd } = await isolatedDirs();
    await mkdir(join(homeDir, '.ppagent'), { recursive: true });
    await writeFile(join(homeDir, '.ppagent', 'agent.json'), '{ not valid json');

    await expect(
      loadAgentConfig({ homeDir, cwd, env: {} }),
    ).rejects.toThrow('Invalid agent config JSON');
  });
});
