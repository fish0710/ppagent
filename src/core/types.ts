// 类型契约叶子节点（M1 落地）
// ============================================================================
// core/types.ts —— 全局类型契约
//
// 硬约束：本文件不得 import 任何模块（含 import type）。
// 它是依赖图的叶子节点，谁都可以引它，它谁都不引。
// 由 .dependency-cruiser.cjs 的 types-is-leaf 规则强制。
//
// 本文件只放两类东西：
//   1. 数据契约 —— 可 JSON 序列化的纯数据形状
//   2. 行为契约 —— 只有方法签名的 interface
// 实现（class）一律放各自模块。
// ============================================================================

// ============================================================================
// 0. 基础
// ============================================================================

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/** 工具参数的 schema。结构化定义，避免依赖具体 schema 库。 */
export interface JSONSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  enum?: JSONValue[];
  default?: JSONValue;
}

export type SessionId = string;
export type ToolCallId = string;

/** 毫秒时间戳。统一用 number，便于 JSON 序列化与跨进程传递。 */
export type Millis = number;

// ============================================================================
// 1. 消息与内容块
//
// 设计决策：用判别联合（discriminated union）而非类继承。
//   - 穷尽性检查：新增消息类型时所有 switch 立刻编译报错
//   - 可序列化：M5 要落 JSONL 并恢复，class 实例反序列化后方法会丢失
//   - 消息本身无行为，处理逻辑都在外部函数里
// ============================================================================

export type Role = Message['role'];

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SummaryMessage;

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
  timestamp: Millis;
}

export interface AssistantMessage {
  role: 'assistant';
  /** 一次生成里可以同时包含文本、思考和多个工具调用 */
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** 产生这条消息的模型，用于 trace 归因与成本核算 */
  model?: string;
  /** stopReason 为 'error' 时的原因描述 */
  errorMessage?: string;
  timestamp: Millis;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: ToolCallId;
  toolName: string;
  content: ContentBlock[];
  isError: boolean;
  /** 结果被截断时置 true，模型需要知道自己看到的不是全部 */
  truncated?: boolean;
  /** 工具执行耗时，用于 trace */
  durationMs?: number;
  timestamp: Millis;
}

/**
 * compact 后替换掉一段历史消息的摘要。
 *
 * 单列一个成员而非复用 UserMessage，是为了让穷尽性检查逼着每个
 * switch 显式处理它 —— 压缩过的上下文在 token 计账、trace 归因、
 * 二次压缩时的行为都和普通消息不同。
 */
export interface SummaryMessage {
  role: 'summary';
  summary: string;
  /** 被它替换掉的原始消息条数与 token 数，用于观测压缩收益 */
  replacedCount: number;
  replacedTokens: number;
  /** 触发这次压缩的原因 */
  trigger: CompactTrigger;
  timestamp: Millis;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ImageBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

/**
 * 工具调用是 assistant 消息里的内容块，不是独立消息。
 *
 * 因为模型在一次生成里可以同时输出文本和多个工具调用，它们共享
 * 同一个 usage 和 stopReason。拆成独立消息会丢掉这层归属关系，
 * 回传给 API 时还得重新合并。
 *
 * 而工具"结果"是独立消息（ToolResultMessage），因为它由 harness
 * 产生、作为下一轮的输入。这个不对称是协议本身的形状。
 */
export interface ToolCallBlock {
  type: 'toolCall';
  id: ToolCallId;
  name: string;
  /** 未经校验的原始参数。执行前必须过 JSONSchema 校验。 */
  arguments: unknown;
}

export interface ImageBlock {
  type: 'image';
  /** base64 编码 */
  data: string;
  mimeType: string;
}

export type StopReason =
  /** 模型正常结束 */
  | 'stop'
  /** 触达 maxTokens */
  | 'length'
  /** 模型请求调用工具，循环需要继续 */
  | 'toolUse'
  /** 请求失败，详见 errorMessage */
  | 'error'
  /** 被 AbortSignal 取消 */
  | 'aborted';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ============================================================================
// 2. 上下文
// ============================================================================

export interface Context {
  /**
   * system prompt 是独立字段，不是 Message 的一种。
   *
   * 它的生命周期和消息完全不同：永不参与 compact、不进 append-only
   * 的消息流、主流 API 里也是独立字段。当成消息处理会导致 compact、
   * store、token 计账三处都要特判。
   */
  systemPrompt?: string;
  messages: Message[];
  tools?: ToolDef[];
}

// ============================================================================
// 3. 模型与调用
// ============================================================================

export interface ModelRef {
  provider: string;
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * 是否支持原生 tool calling。
   *
   * 为 false 时走 prompted 降级路径：工具定义渲染进 system prompt，
   * 从文本流里增量抽取调用。Gemma 系属于这种。
   */
  supportsNativeToolCalling: boolean;
  supportsThinking: boolean;
  /** 兼容性开关。本地 OpenAI 兼容服务常有各自的缺失。 */
  compat?: ModelCompat;
}

export interface ModelCompat {
  /** 不支持 developer 角色时，system prompt 降级为普通 system 消息 */
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  /** 不支持并行工具调用时，一轮只取第一个 toolCall */
  supportsParallelToolCalls?: boolean;
}

export interface StreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export type StreamEvent =
  | { type: 'start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'toolcall_start'; index: number; id: ToolCallId; name: string }
  /** 参数 JSON 会被切碎跨 chunk 到达，需要增量拼接 */
  | { type: 'toolcall_delta'; index: number; delta: string }
  | { type: 'toolcall_end'; index: number; call: ToolCallBlock }
  | { type: 'done'; message: AssistantMessage }
  /**
   * 失败不抛异常，而是发一个 error 事件并附带最终 message。
   * 调用方必须监听此事件 —— try/catch 抓不到。
   */
  | { type: 'error'; reason: 'error' | 'aborted'; message: AssistantMessage };

/**
 * 唯一的模型调用边界。
 *
 * 换 pi-ai、换裸 HTTP 客户端，都只改实现这个接口的文件。
 * 第三方类型不得越过这条线。
 *
 * 不按云端/本地分子类 —— 两边都是 OpenAI 兼容协议，差异全在
 * ModelRef 的能力标志和配置里，分子类只会产生重复代码。
 * 实现按用途分：pi-ai.ts（真实）与 faux.ts（测试）。
 */
export interface Provider {
  readonly id: string;
  listModels(): ModelRef[];
  stream(
    model: ModelRef,
    ctx: Context,
    opts?: StreamOptions,
  ): AsyncIterable<StreamEvent>;
}

// ============================================================================
// 4. 工具
// ============================================================================

export interface ToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;
  /**
   * 该工具可能突破沙箱边界，执行前需要人工确认。
   * 例如写工作目录之外的文件、访问网络。
   */
  privileged?: boolean;
  /**
   * 该工具需要资源准入检查。目前只有 spawn_subagent 用。
   */
  requiresAdmission?: boolean;
  /**
   * 是否可与其他工具并发执行。
   * bash 与写类工具通常为 false —— 并发跑构建和改文件会互相干扰。
   */
  concurrencySafe?: boolean;
}

export interface Tool extends ToolDef {
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  trace: TraceContext;
  /** 工具需要向用户提问时走这条反向通道 */
  interaction: Interaction;
}

export interface ToolOutput {
  content: ContentBlock[];
  isError: boolean;
  /**
   * 工具自报的资源占用，喂给 compact 决策。
   * 例如 bash 起了一个常驻服务，内存压力会上升。
   */
  resourceHint?: ResourceHint;
}

export interface ResourceHint {
  spawnedProcesses?: number;
  memMB?: number;
}

// ============================================================================
// 5. 沙箱
//
// 两种约束方式，因为两类工具的执行形态不同：
//   - read/write/edit 在进程内做文件操作 → checkPath 事前检查
//   - bash 起子进程 → wrapCommand 交给 macOS 原语强制隔离
// 把两者塞进一个 run(fn) 会导致进程内操作实际上没有任何强制力。
// ============================================================================

export interface Sandbox {
  checkPath(path: string, op: 'read' | 'write'): SandboxDecision;
  wrapCommand(command: string, cwd: string): WrappedCommand;
}

export type SandboxDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      /**
       * 能否通过人工确认放行。
       * false 表示硬禁止（如修改系统目录），连问都不该问。
       */
      escalatable: boolean;
    };

export interface WrappedCommand {
  command: string;
  args: string[];
}

// ============================================================================
// 6. 资源探测 —— 本项目差异化能力的数据源
// ============================================================================

export interface ResourceSnapshot {
  /** 0–1，1 表示系统即将 swap */
  memPressure: number;
  memAvailableMB: number;
  /** GPU 是否正忙于推理。主 agent decode 时插入子 agent 的 prefill 会互相抢占。 */
  gpuBusy: boolean;
  activeSubagents: number;
  /** 采样时刻。探针有缓存，调用方需要知道数据新鲜度。 */
  sampledAt: Millis;
}

export interface ResourceProbe {
  /**
   * 按需拉取，不是持续推送。
   * 实现应带短期缓存 —— powermetrics 这类采样很重，
   * 每次工具调用都探一遍会明显拖慢循环。
   */
  snapshot(): Promise<ResourceSnapshot>;
}

// ============================================================================
// 7. 准入控制
// ============================================================================

export interface AdmissionDecision {
  ok: boolean;
  /** 拒绝原因。会原样回给模型，所以要写成模型能据此改变策略的话。 */
  reason?: string;
  /**
   * 建议重试等待时长。null 表示不建议重试（应改为串行处理）。
   * 有这个字段，模型才能区分"等一下"和"换个做法"。
   */
  retryAfterMs?: number | null;
}

export interface AdmissionController {
  canSpawnSubagent(): Promise<AdmissionDecision>;
}

// ============================================================================
// 8. 权限与交互
// ============================================================================

export interface PermissionRequest {
  toolName: string;
  /** 一行摘要，给用户看 */
  summary: string;
  /** 完整细节，如具体命令或路径 */
  detail?: string;
  /** 沙箱拒绝后升级而来的请求，附带原因 */
  sandboxReason?: string;
}

export type PermissionDecision = 'allow' | 'allowAlways' | 'deny';

export interface PermissionPolicy {
  check(
    req: PermissionRequest,
    interaction: Interaction,
  ): Promise<PermissionDecision>;
}

/**
 * 反向通道：底层向用户提问。
 *
 * 架构上其余通道都是自上而下调用、自下而上发事件，唯独人工确认
 * 需要从 Phase 1 深处触达 Phase 3 的 UI。没有这条通道，sandbox 的
 * "超限需人工审核" 就无处安放，只能在底层硬塞 readline —— 那样
 * RPC 模式和 benchmark 模式会直接崩掉。
 *
 * 由应用层注入实现：
 *   - TUI      → 弹确认框
 *   - CLI 非交互 → 一律返回拒绝（null / false）
 *   - benchmark → 按预设策略自动应答
 */
export interface Interaction {
  confirm(req: { message: string; detail?: string }): Promise<boolean>;
  /** 返回 null 表示用户取消或当前模式不支持交互 */
  ask(req: { message: string; secret?: boolean }): Promise<string | null>;
  select(req: { message: string; options: string[] }): Promise<string | null>;
  notify(e: { level: 'info' | 'warn' | 'error'; message: string }): void;
}

// ============================================================================
// 9. 上下文压缩
// ============================================================================

export type CompactTrigger = 'token' | 'memory' | 'manual';

export interface CompactSignals {
  tokenUsage: number;
  contextWindow: number;
  /**
   * 云端阶段为 undefined，M10 接入真实探针后才有值。
   * 这是"内存压力参与 compact 决策"这一卖点的接入口。
   */
  resource?: ResourceSnapshot;
}

export interface CompactResult {
  messages: Message[];
  trigger: CompactTrigger;
  tokensBefore: number;
  tokensAfter: number;
}

export interface CompactPolicy {
  shouldCompact(signals: CompactSignals): CompactTrigger | null;
  compact(
    messages: Message[],
    trigger: CompactTrigger,
    summarize: Summarize,
  ): Promise<CompactResult>;
}

/**
 * 由 loop 在构造 context 时注入。
 *
 * 压缩需要调模型生成摘要，但 context 不认识 llm 层 —— 否则会形成
 * loop → context → llm → 结果写回 context 的双向依赖。注入回调
 * 保持了 core 各组件互不认识、可独立单测。
 */
export type Summarize = (messages: Message[]) => Promise<string>;

// ============================================================================
// 10. 持久化
//
// append-only 的记录流，而非可变的消息数组。
// compact 本身也是一条记录 —— 这样 JSONL 永远只追加不重写，
// 崩溃恢复时按 seq 回放即可重建，也保留了压缩前的原始历史。
// ============================================================================

export type StoreRecord =
  | { kind: 'message'; seq: number; message: Message }
  | {
      kind: 'compaction';
      seq: number;
      /** 被替换的 seq 区间，闭区间 */
      replacedFrom: number;
      replacedTo: number;
      summary: SummaryMessage;
    };

export interface SessionMeta {
  id: SessionId;
  createdAt: Millis;
  updatedAt: Millis;
  cwd: string;
  model?: string;
  /** 首条用户消息的摘要，用于 session 列表展示 */
  title?: string;
}

export interface Store {
  create(meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>): Promise<void>;
  append(id: SessionId, record: StoreRecord): Promise<void>;
  /** 按 seq 升序返回全部记录，由调用方回放重建 */
  load(id: SessionId): Promise<StoreRecord[]>;
  list(): Promise<SessionMeta[]>;
  touch(id: SessionId, patch: Partial<SessionMeta>): Promise<void>;
}

// ============================================================================
// 11. 可观测性
//
// Span 与 UIEvent 是两个独立出口，不复用。
//   Span    —— 给可观测性平台：结构化、可采样、可丢弃、允许延迟聚合
//   UIEvent —— 给人看：严格有序、一条不能丢、必须携带增量文本
// 复用的后果是为了 UI 流畅不敢采样 span，或为了 span 干净吞掉增量。
// ============================================================================

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  child(name: string): TraceContext;
}

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: Millis;
  endMs: Millis;
  attrs: Record<string, string | number | boolean>;
  error?: string;
}

export interface SpanExporter {
  export(span: Span): void;
  flush(): Promise<void>;
}

// ============================================================================
// 12. UI 事件 —— 应用层订阅的唯一数据源
//
// 定义在 core 而非 app，否则 app 层的类型会被 core 反向依赖，三层就破了。
// ============================================================================

export type UIEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; id: ToolCallId; name: string; args: unknown }
  | {
      type: 'tool_end';
      id: ToolCallId;
      name: string;
      isError: boolean;
      /** 结果的简短预览，完整内容不进 UI 流 */
      preview: string;
      durationMs: number;
    }
  | { type: 'permission_request'; req: PermissionRequest }
  | { type: 'permission_resolved'; decision: PermissionDecision }
  | { type: 'admission_denied'; reason: string; retryAfterMs: number | null }
  | {
      type: 'compacted';
      trigger: CompactTrigger;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { type: 'turn_end'; turn: number; usage: Usage; stopReason: StopReason }
  | { type: 'error'; message: string };

// ============================================================================
// 13. 配置
//
// 按模块切分，不定义一个全局 AppConfig。
// core 的每个组件只接受自己需要的那一块 —— 传一个全局对象和让 core
// 自己读配置没有本质区别，"core 不读配置"这条约束就形同虚设了。
//
// 配置的来源解析与合并在 agent/config/，core 只接受构造参数。
// ============================================================================

export interface LoopConfig {
  maxTurns: number;
  /** 单轮最长耗时，超时后中断 */
  turnTimeoutMs: number;
}

export interface ContextConfig {
  /** 触发 compact 的上下文占用比例，0–1 */
  compactThreshold: number;
  /** 内存压力触发 compact 的阈值，0–1。M10 前不生效。 */
  memPressureThreshold: number;
  /** 压缩时保留最近 N 条消息不动 */
  keepRecentMessages: number;
}

export interface ToolsConfig {
  /** 工具结果超过此长度即截断 */
  maxResultChars: number;
  /** 并发执行工具的上限 */
  maxConcurrency: number;
  toolTimeoutMs: number;
}

export interface SandboxConfig {
  /** 允许写入的目录，相对或绝对路径 */
  writablePaths: string[];
  allowNetwork: boolean;
  networkAllowlist: string[];
}

export interface AdmissionConfig {
  minMemAvailableMB: number;
  maxSubagents: number;
  /** 探针快照的缓存时长 */
  probeCacheMs: number;
}

export interface TelemetryConfig {
  enabled: boolean;
  /** 0–1，1 表示全采样 */
  sampleRate: number;
}