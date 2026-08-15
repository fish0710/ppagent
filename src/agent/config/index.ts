import { readFile } from 'node:fs/promises';
import type {
  ContextConfig,
  LoopConfig,
  ToolsConfig,
} from '../../core/types.js';

export interface AgentProviderConfig {
  id: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface AgentContextConfig extends ContextConfig {
  /** CLI/测试可覆盖模型声明的窗口。 */
  contextWindow?: number;
  summaryTargetRatio: number;
  /** 本地 tokenizer 目录或 Hugging Face repo id。 */
  tokenizer?: string;
  tokenizerLocalOnly: boolean;
  tokenizerTimeoutMs: number;
}

export interface AgentSandboxConfig {
  /**
   * sandbox-exec 允许的出站 TCP 端点。SBPL 只稳定支持 localhost 或通配
   * host，因此值形如 `localhost:1234`、`*:443`；默认空数组即禁止网络。
   */
  networkAllowlist: string[];
}

export interface AgentResourceConfig {
  probeCacheMs: number;
  minSubagentMemMB: number;
  maxSubagents: number;
  lowMemoryRetryAfterMs: number;
  busyGpuRetryAfterMs: number;
}

export interface AgentTelemetryConfig {
  laminarApiKey?: string;
  laminarEndpoint: string;
  serviceName: string;
}

export interface AgentConfig {
  provider: AgentProviderConfig;
  loop: LoopConfig;
  context: AgentContextConfig;
  tools: ToolsConfig;
  sandbox: AgentSandboxConfig;
  resource: AgentResourceConfig;
  telemetry: AgentTelemetryConfig;
}

export interface AgentConfigSource {
  provider?: Partial<AgentProviderConfig>;
  loop?: Partial<LoopConfig>;
  context?: Partial<AgentContextConfig>;
  tools?: Partial<ToolsConfig>;
  sandbox?: Partial<AgentSandboxConfig>;
  resource?: Partial<AgentResourceConfig>;
  telemetry?: Partial<AgentTelemetryConfig>;
}

export interface LoadAgentConfigOptions {
  filePath?: string;
  env?: NodeJS.ProcessEnv;
  cli?: AgentConfigSource;
}

const DEFAULT_CONFIG: AgentConfig = {
  provider: { id: 'faux' },
  loop: { maxTurns: 8, turnTimeoutMs: 120_000 },
  context: {
    compactThreshold: 0.8,
    memPressureThreshold: 0.75,
    keepRecentMessages: 6,
    summaryTargetRatio: 0.4,
    // 本地模型默认不得产生隐式外网请求；联网下载必须由用户显式开启。
    tokenizerLocalOnly: true,
    tokenizerTimeoutMs: 30_000,
  },
  tools: {
    maxResultChars: 8_000,
    maxConcurrency: 4,
    toolTimeoutMs: 30_000,
  },
  sandbox: { networkAllowlist: [] },
  resource: {
    probeCacheMs: 2_000,
    minSubagentMemMB: 2_048,
    maxSubagents: 2,
    lowMemoryRetryAfterMs: 5_000,
    busyGpuRetryAfterMs: 10_000,
  },
  telemetry: {
    laminarEndpoint: 'https://api.lmnr.ai',
    serviceName: 'ppagent',
  },
};

/** 文件 < 环境变量 < CLI；返回深拷贝后的普通对象。 */
export async function loadAgentConfig(
  options: LoadAgentConfigOptions = {},
): Promise<AgentConfig> {
  const file =
    options.filePath === undefined
      ? {}
      : await readAgentConfigFile(options.filePath);
  const env = options.env ?? process.env;
  const providerId =
    stringValue(options.cli?.provider?.id) ??
    nonEmpty(env['PPAGENT_PROVIDER']) ??
    stringValue(file.provider?.id) ??
    DEFAULT_CONFIG.provider.id;
  const environment = configFromEnvironment(env, providerId);
  return mergeAgentConfig(file, environment, options.cli ?? {});
}

export async function readAgentConfigFile(
  path: string,
): Promise<AgentConfigSource> {
  const text = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid agent config JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error('Agent config root must be an object');
  for (const section of [
    'provider',
    'loop',
    'context',
    'tools',
    'sandbox',
    'resource',
    'telemetry',
  ] as const) {
    const candidate = value[section];
    if (candidate !== undefined && !isRecord(candidate)) {
      throw new Error(`Agent config ${section} must be an object`);
    }
  }
  const source = value as AgentConfigSource;
  // JSON 不受 TypeScript 约束；先单独校验文件，避免后级 env/CLI 覆盖并掩盖坏值。
  mergeAgentConfig(source);
  return source;
}

export function configFromEnvironment(
  env: NodeJS.ProcessEnv,
  providerHint = nonEmpty(env['PPAGENT_PROVIDER']) ?? 'faux',
): AgentConfigSource {
  const providerId = nonEmpty(env['PPAGENT_PROVIDER']) ?? providerHint;
  const provider = compactObject<Partial<AgentProviderConfig>>({
    id: providerId,
    model: nonEmpty(env['PPAGENT_MODEL']),
    // 凭证与 endpoint 按 provider 分域，切换 provider 时不会误用旧值。
    baseUrl:
      isLocalProvider(providerId)
        ? nonEmpty(env['PPAGENT_CUSTOM_BASE_URL'])
        : undefined,
    apiKey: providerApiKey(env, providerId),
  });
  const loop = compactObject<Partial<LoopConfig>>({
    maxTurns: envNumber(env, 'PPAGENT_MAX_TURNS'),
    turnTimeoutMs: envNumber(env, 'PPAGENT_TURN_TIMEOUT_MS'),
  });
  const context = compactObject<Partial<AgentContextConfig>>({
    contextWindow: envNumber(env, 'PPAGENT_MAX_TOKENS'),
    compactThreshold: envNumber(env, 'PPAGENT_COMPACT_THRESHOLD'),
    memPressureThreshold: envNumber(env, 'PPAGENT_MEM_PRESSURE_THRESHOLD'),
    keepRecentMessages: envNumber(env, 'PPAGENT_KEEP_RECENT_MESSAGES'),
    summaryTargetRatio: envNumber(env, 'PPAGENT_SUMMARY_TARGET_RATIO'),
    tokenizer: nonEmpty(env['PPAGENT_TOKENIZER']),
    tokenizerLocalOnly: envBoolean(env, 'PPAGENT_TOKENIZER_LOCAL_ONLY'),
    tokenizerTimeoutMs: envNumber(env, 'PPAGENT_TOKENIZER_TIMEOUT_MS'),
  });
  const tools = compactObject<Partial<ToolsConfig>>({
    maxResultChars: envNumber(env, 'PPAGENT_MAX_RESULT_CHARS'),
    maxConcurrency: envNumber(env, 'PPAGENT_MAX_TOOL_CONCURRENCY'),
    toolTimeoutMs: envNumber(env, 'PPAGENT_TOOL_TIMEOUT_MS'),
  });
  const sandbox = compactObject<Partial<AgentSandboxConfig>>({
    networkAllowlist: commaSeparated(env['PPAGENT_SANDBOX_NETWORK_ALLOWLIST']),
  });
  const resource = compactObject<Partial<AgentResourceConfig>>({
    probeCacheMs: envNumber(env, 'PPAGENT_RESOURCE_CACHE_MS'),
    minSubagentMemMB: envNumber(env, 'PPAGENT_MIN_SUBAGENT_MEM_MB'),
    maxSubagents: envNumber(env, 'PPAGENT_MAX_SUBAGENTS'),
    lowMemoryRetryAfterMs: envNumber(env, 'PPAGENT_LOW_MEMORY_RETRY_MS'),
    busyGpuRetryAfterMs: envNumber(env, 'PPAGENT_BUSY_GPU_RETRY_MS'),
  });
  const telemetry = compactObject<Partial<AgentTelemetryConfig>>({
    laminarApiKey: nonEmpty(env['LMNR_PROJECT_API_KEY']),
    laminarEndpoint: nonEmpty(env['PPAGENT_LAMINAR_ENDPOINT']),
    serviceName: nonEmpty(env['PPAGENT_TELEMETRY_SERVICE_NAME']),
  });
  return {
    provider,
    ...(Object.keys(loop).length === 0 ? {} : { loop }),
    ...(Object.keys(context).length === 0 ? {} : { context }),
    ...(Object.keys(tools).length === 0 ? {} : { tools }),
    ...(Object.keys(sandbox).length === 0 ? {} : { sandbox }),
    ...(Object.keys(resource).length === 0 ? {} : { resource }),
    ...(Object.keys(telemetry).length === 0 ? {} : { telemetry }),
  };
}

export function mergeAgentConfig(
  ...sources: readonly AgentConfigSource[]
): AgentConfig {
  let merged: AgentConfig = structuredClone(DEFAULT_CONFIG);
  for (const source of sources) {
    const provider = compactObject<Partial<AgentProviderConfig>>(
      source.provider ?? {},
    );
    if (provider.id !== undefined && provider.id !== merged.provider.id) {
      // provider 切换是配置域切换：不得继承上一域的 model/endpoint/credential。
      merged = { ...merged, provider: { id: provider.id } };
    }
    Object.assign(merged.provider, provider);
    Object.assign(merged.loop, compactObject(source.loop ?? {}));
    Object.assign(merged.context, compactObject(source.context ?? {}));
    Object.assign(merged.tools, compactObject(source.tools ?? {}));
    Object.assign(merged.sandbox, compactObject(source.sandbox ?? {}));
    Object.assign(merged.resource, compactObject(source.resource ?? {}));
    Object.assign(merged.telemetry, compactObject(source.telemetry ?? {}));
  }
  validateConfig(merged);
  return structuredClone(merged);
}

function validateConfig(config: AgentConfig): void {
  if (
    typeof config.provider.id !== 'string' ||
    config.provider.id.trim().length === 0
  ) {
    throw new Error('provider.id must not be empty');
  }
  optionalNonEmptyString(config.provider.model, 'provider.model');
  optionalNonEmptyString(config.provider.baseUrl, 'provider.baseUrl');
  optionalNonEmptyString(config.provider.apiKey, 'provider.apiKey');
  positiveInteger(config.loop.maxTurns, 'loop.maxTurns');
  positiveInteger(config.loop.turnTimeoutMs, 'loop.turnTimeoutMs');
  positiveInteger(config.context.keepRecentMessages, 'context.keepRecentMessages');
  positiveInteger(config.tools.maxResultChars, 'tools.maxResultChars');
  positiveInteger(config.tools.maxConcurrency, 'tools.maxConcurrency');
  positiveInteger(config.tools.toolTimeoutMs, 'tools.toolTimeoutMs');
  if (!Array.isArray(config.sandbox.networkAllowlist)) {
    throw new Error('sandbox.networkAllowlist must be an array');
  }
  for (const endpoint of config.sandbox.networkAllowlist) {
    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new Error('sandbox.networkAllowlist entries must be non-empty strings');
    }
  }
  nonNegativeInteger(config.resource.probeCacheMs, 'resource.probeCacheMs');
  positiveInteger(config.resource.minSubagentMemMB, 'resource.minSubagentMemMB');
  positiveInteger(config.resource.maxSubagents, 'resource.maxSubagents');
  nonNegativeInteger(
    config.resource.lowMemoryRetryAfterMs,
    'resource.lowMemoryRetryAfterMs',
  );
  optionalNonEmptyString(config.telemetry.laminarApiKey, 'telemetry.laminarApiKey');
  optionalNonEmptyString(config.telemetry.laminarEndpoint, 'telemetry.laminarEndpoint');
  optionalNonEmptyString(config.telemetry.serviceName, 'telemetry.serviceName');
  nonNegativeInteger(
    config.resource.busyGpuRetryAfterMs,
    'resource.busyGpuRetryAfterMs',
  );
  if (config.context.contextWindow !== undefined) {
    positiveInteger(config.context.contextWindow, 'context.contextWindow');
  }
  ratio(config.context.compactThreshold, 'context.compactThreshold');
  ratio(config.context.memPressureThreshold, 'context.memPressureThreshold');
  ratio(config.context.summaryTargetRatio, 'context.summaryTargetRatio');
  optionalNonEmptyString(config.context.tokenizer, 'context.tokenizer');
  if (typeof config.context.tokenizerLocalOnly !== 'boolean') {
    throw new Error('context.tokenizerLocalOnly must be a boolean');
  }
  positiveInteger(
    config.context.tokenizerTimeoutMs,
    'context.tokenizerTimeoutMs',
  );
}

function providerApiKey(
  env: NodeJS.ProcessEnv,
  providerId: string,
): string | undefined {
  switch (providerId) {
    case 'custom':
    case 'lmstudio':
    case 'llamacpp':
      return nonEmpty(env['PPAGENT_CUSTOM_API_KEY']);
    case 'openai':
      return nonEmpty(env['OPENAI_API_KEY']);
    case 'anthropic':
      return nonEmpty(env['ANTHROPIC_API_KEY']);
    default:
      return undefined;
  }
}

function isLocalProvider(providerId: string): boolean {
  return providerId === 'custom' || providerId === 'lmstudio' || providerId === 'llamacpp';
}

function envNumber(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function envBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return undefined;
  if (/^(?:1|true|yes|on)$/iu.test(raw)) return true;
  if (/^(?:0|false|no|off)$/iu.test(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function compactObject<T extends object>(value: object): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function ratio(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be in (0, 1]`);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function commaSeparated(value: string | undefined): string[] | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.length === 0 ? undefined : entries;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNonEmptyString(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' || value.trim().length === 0)
  ) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
