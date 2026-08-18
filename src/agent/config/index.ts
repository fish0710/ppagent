import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ContextConfig,
  LoopConfig,
  ModelEffort,
  ToolsConfig,
} from '../../core/types.js';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const GLOBAL_CONFIG_DIRNAME = '.ppagent';
const CONFIG_FILENAME = 'agent.json';
const PROJECT_LOCAL_CONFIG_FILENAME = 'agent.local.json';

export interface AgentProviderConfig {
  id: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 每次请求的输出 token 上限；内置/自定义/本地 provider 一律走 StreamOptions.maxTokens。 */
  maxOutputTokens?: number;
  /** Anthropic 用 effort，OpenAI 兼容端映射为 reasoningEffort，见 core/llm/pi-ai.ts。 */
  effort?: ModelEffort;
  /** 单次模型请求的 HTTP 超时（ms），转发给 pi-ai 的 timeoutMs；不是 loop.turnTimeoutMs。 */
  requestTimeoutMs?: number;
  /** 转发给 pi-ai 的 maxRetries；0 表示关闭客户端重试。 */
  maxRetries?: number;
}

export interface AgentContextConfig extends ContextConfig {
  /** CLI/测试可覆盖模型声明的窗口。 */
  contextWindow?: number;
  /** 关掉则只用规则剪枝 + StructuralSummarizer，压缩全程不调模型。 */
  llmSummarizer: boolean;
  /**
   * 摘要调用的超时。独立于 loop.turnTimeoutMs（默认 20 分钟）——
   * 卡住的本地服务不该把整轮预算耗光，超时就降级到规则摘要继续跑。
   */
  summarizeTimeoutMs: number;
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
  /** project 层的路径覆盖；不传则用 `<cwd>/agent.json`。 */
  filePath?: string;
  env?: NodeJS.ProcessEnv;
  cli?: AgentConfigSource;
  /** 仅供测试/嵌入方注入；默认 process.cwd()。 */
  cwd?: string;
  /** 仅供测试/嵌入方注入；默认 os.homedir()。 */
  homeDir?: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  provider: { id: 'faux' },
  loop: { maxTurns: 60, turnTimeoutMs: 1_200_000, maxLengthContinuations: 2 },
  context: {
    compactThreshold: 0.8,
    memPressureThreshold: 0.75,
    // 0.8 触发、降到 0.3，留出半个窗口的余量再触发下一次。压缩后第一次真实
    // 请求必然全量重新 prefill（前缀首条就换成了摘要），所以要少压、压得深。
    keepRecentRatio: 0.3,
    summaryMaxTokens: 2_048,
    // 比 keepRecentRatio 小：剪枝要够得着摘要保留区里的老工具输出。
    pruneProtectRatio: 0.15,
    pruneMinTokens: 2_048,
    // 改过的文件比读过的重要得多；超限时先砍 read，见 core/context/files.ts。
    maxTrackedFiles: 80,
    // 131k 窗口约 13k token；用户的原始要求不经过模型转述就能存活，见
    // ContextConfig.keepUserRatio 的文档。
    keepUserRatio: 0.1,
    llmSummarizer: true,
    summarizeTimeoutMs: 120_000,
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

/** 内置默认值 < global < project < project.local < 环境变量 < CLI；返回深拷贝后的普通对象。 */
export async function loadAgentConfig(
  options: LoadAgentConfigOptions = {},
): Promise<AgentConfig> {
  const cwd = options.cwd ?? process.cwd();
  const globalPath = join(
    options.homeDir ?? homedir(),
    GLOBAL_CONFIG_DIRNAME,
    CONFIG_FILENAME,
  );
  const projectPath = options.filePath ?? join(cwd, CONFIG_FILENAME);
  const projectLocalPath = join(cwd, PROJECT_LOCAL_CONFIG_FILENAME);

  const global = await readOrInitGlobalConfigFile(globalPath);
  const project = await readOptionalAgentConfigFile(projectPath);
  const projectLocal = await readOptionalAgentConfigFile(projectLocalPath);

  const env = options.env ?? process.env;
  const providerId =
    stringValue(options.cli?.provider?.id) ??
    nonEmpty(env['PPAGENT_PROVIDER']) ??
    stringValue(projectLocal.provider?.id) ??
    stringValue(project.provider?.id) ??
    stringValue(global.provider?.id) ??
    DEFAULT_CONFIG.provider.id;
  const environment = configFromEnvironment(env, providerId);
  return mergeAgentConfig(
    global,
    project,
    projectLocal,
    environment,
    options.cli ?? {},
  );
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

/** project/project.local 用：文件不存在就当空对象，真正的解析/校验错误照常抛出。 */
async function readOptionalAgentConfigFile(
  path: string,
): Promise<AgentConfigSource> {
  try {
    return await readAgentConfigFile(path);
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/** global 用：文件不存在就尽力初始化一份默认快照，写入失败也不影响本次启动。 */
async function readOrInitGlobalConfigFile(
  path: string,
): Promise<AgentConfigSource> {
  try {
    return await readAgentConfigFile(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    await tryInitGlobalConfig(path);
    return {};
  }
}

async function tryInitGlobalConfig(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      flag: 'wx',
    });
  } catch {
    // 只是便利性初始化；只读文件系统、权限问题或并发创建都不应该让 agent 启动失败。
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
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
    // 注意：PPAGENT_MAX_TOKENS 已经被 context.contextWindow 占用，这里必须用不同的名字。
    maxOutputTokens: envNumber(env, 'PPAGENT_MAX_OUTPUT_TOKENS'),
    effort: envEffort(env, 'PPAGENT_EFFORT'),
    // 单次模型 HTTP 请求超时，跟 loop.turnTimeoutMs（整轮编排超时）分开命名，避免混淆。
    requestTimeoutMs: envNumber(env, 'PPAGENT_REQUEST_TIMEOUT_MS'),
    maxRetries: envNumber(env, 'PPAGENT_MAX_RETRIES'),
  });
  const loop = compactObject<Partial<LoopConfig>>({
    maxTurns: envNumber(env, 'PPAGENT_MAX_TURNS'),
    turnTimeoutMs: envNumber(env, 'PPAGENT_TURN_TIMEOUT_MS'),
    maxLengthContinuations: envNumber(env, 'PPAGENT_MAX_LENGTH_CONTINUATIONS'),
  });
  const context = compactObject<Partial<AgentContextConfig>>({
    contextWindow: envNumber(env, 'PPAGENT_MAX_TOKENS'),
    compactThreshold: envNumber(env, 'PPAGENT_COMPACT_THRESHOLD'),
    memPressureThreshold: envNumber(env, 'PPAGENT_MEM_PRESSURE_THRESHOLD'),
    keepRecentRatio: envNumber(env, 'PPAGENT_KEEP_RECENT_RATIO'),
    summaryMaxTokens: envNumber(env, 'PPAGENT_SUMMARY_MAX_TOKENS'),
    pruneProtectRatio: envNumber(env, 'PPAGENT_PRUNE_PROTECT_RATIO'),
    pruneMinTokens: envNumber(env, 'PPAGENT_PRUNE_MIN_TOKENS'),
    maxTrackedFiles: envNumber(env, 'PPAGENT_MAX_TRACKED_FILES'),
    keepUserRatio: envNumber(env, 'PPAGENT_KEEP_USER_RATIO'),
    llmSummarizer: envBoolean(env, 'PPAGENT_LLM_SUMMARIZER'),
    summarizeTimeoutMs: envNumber(env, 'PPAGENT_SUMMARIZE_TIMEOUT_MS'),
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
  if (config.provider.maxOutputTokens !== undefined) {
    positiveInteger(config.provider.maxOutputTokens, 'provider.maxOutputTokens');
  }
  if (
    config.provider.effort !== undefined &&
    !EFFORT_LEVELS.includes(config.provider.effort)
  ) {
    throw new Error(`provider.effort must be one of ${EFFORT_LEVELS.join(', ')}`);
  }
  if (config.provider.requestTimeoutMs !== undefined) {
    positiveInteger(config.provider.requestTimeoutMs, 'provider.requestTimeoutMs');
  }
  if (config.provider.maxRetries !== undefined) {
    nonNegativeInteger(config.provider.maxRetries, 'provider.maxRetries');
  }
  positiveInteger(config.loop.maxTurns, 'loop.maxTurns');
  positiveInteger(config.loop.turnTimeoutMs, 'loop.turnTimeoutMs');
  nonNegativeInteger(config.loop.maxLengthContinuations, 'loop.maxLengthContinuations');
  positiveInteger(config.context.summaryMaxTokens, 'context.summaryMaxTokens');
  positiveInteger(config.context.pruneMinTokens, 'context.pruneMinTokens');
  positiveInteger(config.context.maxTrackedFiles, 'context.maxTrackedFiles');
  positiveInteger(config.context.summarizeTimeoutMs, 'context.summarizeTimeoutMs');
  if (typeof config.context.llmSummarizer !== 'boolean') {
    throw new Error('context.llmSummarizer must be a boolean');
  }
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
  ratio(config.context.keepRecentRatio, 'context.keepRecentRatio');
  ratio(config.context.pruneProtectRatio, 'context.pruneProtectRatio');
  ratio(config.context.keepUserRatio, 'context.keepUserRatio');
  if (config.context.keepRecentRatio >= config.context.compactThreshold) {
    // 保留窗口不小于触发阈值时，压缩后立刻又超阈值，每轮都压一次。
    throw new Error('context.keepRecentRatio must be below context.compactThreshold');
  }
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

function envEffort(
  env: NodeJS.ProcessEnv,
  name: string,
): ModelEffort | undefined {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return undefined;
  if ((EFFORT_LEVELS as readonly string[]).includes(raw)) {
    return raw as ModelEffort;
  }
  throw new Error(`${name} must be one of ${EFFORT_LEVELS.join(', ')}`);
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
