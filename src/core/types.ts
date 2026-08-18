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
  /**
   * 严格模式必需。OpenAI structured outputs 要求顶层 schema 显式
   * 声明 additionalProperties: false，部分本地服务也依赖它拒绝多余参数。
   */
  additionalProperties?: boolean;
}

export type SessionId = string;
export type ToolCallId = string;

/** 毫秒时间戳。统一用 number，便于 JSON 序列化与跨进程传递。 */
export type Millis = number;

/** 模型响应的明确来源。供应商判断必须读这里，不依赖适配器私有数据。 */
export interface ModelOrigin {
  provider: string;
  model: string;
}

/**
 * 适配器为多轮回放保存的不透明状态。
 *
 * core 只负责随消息持久化和回传，不解释 data。只有 adapter 字段指向的
 * 适配器可以读取其中内容，例如 pi-ai 的 reasoning/tool-call 签名。
 */
export interface AdapterState {
  adapter: string;
  data: Record<string, JSONValue>;
}

// ============================================================================
// 1. 消息与内容块
//
// 设计决策：用判别联合（discriminated union）而非类继承。
//   - 穷尽性检查：新增消息类型时所有 switch 立刻编译报错
//   - 可序列化：M5 要落 JSONL 并恢复，class 实例反序列化后方法会丢失
//   - 消息本身无行为，处理逻辑都在外部函数里
// ============================================================================

export type Role = Message['role'];

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
  timestamp: Millis;
  /**
   * harness 自己塞进上下文的 UserMessage（压缩摘要、续写提示词），不是用户
   * 真正说的话。压缩的"user 消息不折叠"策略只保留用户真实输入，不区分这个
   * 会让历次摘要和续写提示词被当成"用户的话"无限累积进保留区。
   */
  synthetic?: true;
}

export interface AssistantMessage {
  role: 'assistant';
  /** 一次生成里可以同时包含文本、思考和多个工具调用 */
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** 产生这条消息的供应商和模型，用于路由、回放、trace 与成本归因 */
  origin?: ModelOrigin;
  /** 消息级适配器私有状态，core 不解释 */
  adapterState?: AdapterState;
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
  /**
   * 正文被 compact 的剪枝层换成存根时置 true。
   *
   * 与 truncated 分开：truncated 表示工具执行时输出就超了 maxResultChars，
   * pruned 表示这条结果当时是完整的、后来为了腾上下文才被剪掉。剪枝是幂等的，
   * 这个标记就是幂等的依据。
   */
  pruned?: boolean;
  /** 工具执行耗时，用于 trace */
  durationMs?: number;
  timestamp: Millis;
}

/**
 * 注：compact 产生的摘要不是独立的消息种类，就是一条普通消息
 * （建议用 UserMessage，见 §9 的说明）。压缩的元信息属于持久层，
 * 记在 StoreRecord 的 compaction 记录上，不混进消息本身。
 */

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ImageBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  adapterState?: AdapterState;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  adapterState?: AdapterState;
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
  adapterState?: AdapterState;
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

/** Provider 与其他消费者拿到的只读上下文视图。 */
export interface ReadonlyContext {
  /**
   * system prompt 是独立字段，不是 Message 的一种。
   *
   * 它的生命周期和消息完全不同：永不参与 compact、不进 append-only
   * 的消息流、主流 API 里也是独立字段。当成消息处理会导致 compact、
   * store、token 计账三处都要特判。
   */
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDef[];
}

/** 仅上下文所有者使用的可写形状；对外调用边界统一使用 ReadonlyContext。 */
export interface Context extends ReadonlyContext {
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
   * 原生 tool calling 支持断言。
   *
   * 字面量 true 让 Provider 无法登记一个已知不支持原生工具调用的模型。
   * custom endpoint 的真实能力仍取决于服务端 chat template；M4 在可识别的
   * 文本化工具调用出现时给出诊断，M11 做 endpoint/model/template 兼容性验证。
   */
  supportsNativeToolCalling: true;
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

/** Anthropic 用 effort，OpenAI 兼容端用 reasoningEffort；adapter 层负责映射到各自字段名。 */
export type ModelEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StreamOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  effort?: ModelEffort;
  /** 单次模型请求的 HTTP 超时；转发给 pi-ai/底层 SDK，跟 LoopConfig.turnTimeoutMs（整轮编排超时）是两回事。 */
  timeoutMs?: number;
  maxRetries?: number;
}

export type StreamEvent =
  | { type: 'start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  /** 这里只声明槽位出现；完整 id/name/arguments 由 toolcall_end 保证。 */
  | { type: 'toolcall_start'; index: number }
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
    ctx: ReadonlyContext,
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
  /** 面向人的一行权限摘要；不得返回完整文件内容等大字段。 */
  describe?(args: unknown): string;
  /**
   * 在真正执行前应用沙箱策略，并可把参数转换为沙箱准备后的内部形态。
   * read/write/edit 在这里检查绝对路径；bash 在这里取得包装后的命令。
   * 该方法刻意保持必填；纯计算工具应显式使用 tools/execute 导出的
   * passthroughPrepare，不能因遗漏安全声明而默认放行。
   */
  prepareSandbox(
    args: unknown,
    ctx: ToolContext,
    sandbox: Sandbox,
  ): ToolSandboxPreparation;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export type ToolSandboxPreparation =
  | { allowed: true; args: unknown }
  | { allowed: false; reason: string; escalatable: boolean };

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
  /** 执行器裁剪过结果时置 true，后续必须透传到 ToolResultMessage。 */
  truncated?: boolean;
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
  /** 压力量纲与采样器来源；同一阈值在不同来源下需要可观测。 */
  source: 'memory_pressure' | 'vm_stat' | 'system' | 'test';
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
  /**
   * 成功决定同时预留一个 subagent 槽位；调用方在工具结束后必须调用
   * releaseSubagent。把检查与预留放在同一临界区，避免并发调用一起穿透。
   */
  canSpawnSubagent(): Promise<AdmissionDecision>;
  releaseSubagent?(): void;
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

/**
 * 上下文计数器由调用方注入，core/context 不绑定某一家模型的 tokenizer。
 * M5 默认提供 o200k_base BPE 实现；M11 可替换成本地模型的 tokenizer。
 */
export interface TokenCounter {
  readonly id: string;
  /** approximate 必须显式标注，不能把不匹配的词表结果冒充精确 token 数。 */
  readonly precision: 'exact' | 'approximate';
  countText(text: string): number;
  countMessages(messages: readonly Message[]): number;
  countContext(context: ReadonlyContext): number;
}

export interface CompactResult {
  /**
   * 本次压缩做到了哪一层。
   *
   *   'prune'      只跑了规则剪枝：老 toolResult 的正文换成存根，消息条数、
   *                角色顺序、toolCall/toolResult 配对全部不变，没有摘要。
   *                剪枝是磁盘原文上的确定性纯函数，恢复时重跑即可，
   *                因此这种结果不写 compaction 记录。
   *   'summarize'  剪枝之后仍然超阈值，进一步折叠成
   *                [摘要, ...保留的 user 消息, ...保留的最近消息]。
   */
  kind: 'prune' | 'summarize';
  /**
   * 压缩后的完整上下文。kind 为 'summarize' 时是
   * [摘要, ...保留的 user 消息, ...保留的最近消息]。
   */
  messages: Message[];
  /** kind 为 'prune' 时没有摘要。 */
  summary?: Message;
  trigger: CompactTrigger;
  /** 被摘要取代的消息条数；kind 为 'prune' 时为 0。 */
  replacedCount: number;
  /** 正文被剪枝换成存根的 toolResult 条数。 */
  prunedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  /** 生成本次摘要的策略元信息；kind 为 'prune' 时没有。 */
  meta?: SummarizeMeta;
  /**
   * 本次累积后的文件操作清单，由代码从 toolCall 块提取，不经过模型。
   * 下一次压缩把它作为 previousDetails 传回，累积由代码保证。
   */
  details?: FileOperations;
  /**
   * `messages` 里"保留的 user 消息"块，在压缩**前**的视图（传给 compact() 的
   * messages 参数）里的下标，从旧到新排列。持久层用它换算出 keptUserSeqs 写盘；
   * ContextManager 用它的长度切出 result.messages 里对应的那一段，作为下一次
   * 压缩的 previousCarried。kind 为 'prune' 时没有 —— 剪枝不改变 carried 状态。
   */
  keptUserIndices?: readonly number[];
}

/**
 * agent 动过哪些文件。
 *
 * 刻意不问模型：路径在 ToolCallBlock.arguments.path 里是结构化的，让模型转述
 * 只会引入漏项和错字，而且错了没人发现 —— 本地小模型把 prune.ts 写成"那个剪枝
 * 模块"是常态，一旦转述失真，后续压缩再也找不回原路径。
 */
export interface FileOperations {
  /** 只读过、没改过的文件。 */
  readFiles: string[];
  /** 写过或编辑过的文件。同时读写的算这一类。 */
  modifiedFiles: string[];
  /** 因为超出上限被丢弃的条数，摘要里标注出来，避免看起来像"只碰过这些"。 */
  omittedCount?: number;
}

export interface CompactPolicy {
  shouldCompact(signals: CompactSignals): CompactTrigger | null;
  compact(
    messages: Message[],
    trigger: CompactTrigger,
    summarizer: Summarizer,
    execution: CompactExecutionContext,
  ): Promise<CompactResult>;
}

export interface CompactExecutionContext {
  /** 覆盖式压缩产生的上一版摘要；新摘要必须累积它。 */
  previousSummary?: Message;
  /** 上一版的文件清单，与本次提取结果合并后继续累积。 */
  previousDetails?: FileOperations;
  /**
   * 紧跟在 previousSummary 之后、原样保留的 user 消息块（上一次压缩折叠掉的
   * 历史里那些真实用户输入，没有被折叠进摘要散文，而是整条留在上下文里）。
   *
   * 必须显式传入而不是让策略从 messages 里自己猜：折叠区之后的 retained 尾巴
   * 同样常以 user 消息开头（turn 起点对齐的结果），单靠"扫开头连续几条 user"
   * 会把 retained 的第一条也当成搬运块，导致下次压缩把它误判成已经保留过、
   * 不再折叠。不传等价于空数组（还没发生过带 user 保留的压缩）。
   */
  previousCarried: readonly Message[];
  /** 保留窗口与剪枝收益判定都按窗口比例折算，策略执行时必须知道窗口大小。 */
  contextWindow: number;
  systemPrompt?: string;
  /** 实活上下文的工具定义，原样转交给 summarizer；见 SummarizeRequest.tools。 */
  tools?: readonly ToolDef[];
  targetTokens?: number;
  /** `/compact <instructions>` 传来的额外要求。 */
  instructions?: string;
  signal: AbortSignal;
  trace: TraceContext;
}

/**
 * 摘要生成策略。可插拔，便于用真实任务指标横向评估。
 *
 * 由 loop 在构造 context 时注入 —— context 不认识 llm 层，否则会形成
 * loop → context → llm → 结果写回 context 的双向依赖。注入保持了 core
 * 各组件互不认识、可独立单测。需要整个 loop 的策略（如 subagent 摘要）
 * 在 agent/session.ts 里构造后注入，接口在手不会形成循环依赖。
 *
 * 实现：
 *   - 'structural'  纯规则裁剪，不调模型。零延迟、零 GPU、零幻觉。
 *                   现在主要作为 'llm' 的失败兜底 —— 它只会机械截断，
 *                   保不住语义。历史体积的大头（工具输出）已经由 compact
 *                   的剪枝层单独处理，见 core/context/prune.ts。
 *   - 'llm'         调一次模型，见 agent/summarize/llm.ts。
 *   - 'subagent'    交给子 agent，受 AdmissionController 约束（未实现）
 */
export interface Summarizer {
  readonly id: string;
  summarize(req: SummarizeRequest): Promise<SummarizeResult>;
}

export interface SummarizeRequest {
  /**
   * 上一次压缩产生的摘要。
   *
   * 不变量：摘要是累积的。存在 previousSummary 时，新摘要必须涵盖它
   * 所概括的全部历史 —— 因为内存视图只保留最近一条摘要及其之后的消息，
   * 旧摘要会被丢弃。违反此约束会静默丢失早期历史，症状是 agent 突然
   * 忘记任务目标，且不报错。
   *
   * 但"累积"必须靠重写实现，不能靠拼接。把旧摘要原样嵌进新摘要会让摘要
   * 逐次递归增长，最终吃光整个预算、把新历史挤成一堆省略标记 —— 压缩
   * 退化成纯粹的信息销毁。LLM 策略的做法是让模型看到旧摘要并明确要求
   * "改写它、不要嵌套引用"，长度由生成上限硬约束。
   */
  previousSummary?: Message;
  /**
   * 紧跟在 previousSummary 之后、原样保留的 user 消息块 —— 上一次压缩折叠掉
   * 的历史里那些真实用户输入，没有被折叠进摘要散文。
   *
   * 规则策略忽略即可。LLM 策略必须把它连同 messages/retained 一起送进请求 ——
   * 因为 `[previousSummary?, ...carried, ...messages, ...retained]` 逐字节
   * 等于实活的 context.messages，只有这样拼出来的请求前缀才和上一次真实请求
   * 一致，才能命中本地推理服务的 KV 前缀缓存。
   */
  carried?: readonly Message[];
  /** 本次要折叠的消息 */
  messages: Message[];
  /**
   * 切点之后原样保留、不参与折叠的消息。
   *
   * 规则策略忽略即可。LLM 策略必须把它连同 carried/messages 一起送进请求 ——
   * 因为 `[previousSummary?, ...carried, ...messages, ...retained]` 逐字节
   * 等于实活的 context.messages，只有这样拼出来的请求前缀才和上一次真实请求
   * 一致，才能命中本地推理服务的 KV 前缀缓存。少一条、多一条、换个顺序都不行。
   */
  retained?: readonly Message[];
  /** 任务背景，部分策略需要 */
  systemPrompt?: string;
  /**
   * 实活上下文的工具定义。
   *
   * 同样是为了前缀缓存：chat template 把 tools 渲染进 system 段，少传一份
   * tools，prompt 从第 0 个 token 起就变了，整段 KV 缓存作废。代价是模型
   * 可能吐工具调用而不是摘要，LLM 策略必须在运行时丢弃 toolcall 事件。
   */
  tools?: readonly ToolDef[];
  /**
   * 已由代码算好的文件清单，策略应原样拼进摘要，**不得**转交模型改写。
   * 这是"凡是结构里有的就不问模型"这条原则的落点之一。
   */
  fileOps?: FileOperations;
  /** 摘要消息（含策略自己加的包装）的 token 上限 */
  targetTokens?: number;
  /** `/compact <instructions>` 传来的额外要求，聚焦本次摘要的重点。 */
  instructions?: string;
  signal: AbortSignal;
  trace: TraceContext;
}

export interface SummarizeResult {
  /**
   * 摘要消息。建议用 UserMessage —— 覆盖式压缩后它是上下文首条，
   * 而 Anthropic API 要求首条为 user，部分本地服务同样挑剔。
   * 语义上也更准：摘要不是模型说过的话，是 harness 塞的背景材料。
   */
  summary: Message;
  /** 策略自报的元信息，横向评估时用 */
  meta: SummarizeMeta;
}

export interface SummarizeMeta {
  strategy: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** 调用模型的次数。纯规则裁剪为 0。 */
  modelCalls: number;
}

// ============================================================================
// 10. 持久化
//
// append-only 的记录流，而非可变的消息数组。compact 本身也是一条记录 ——
// JSONL 永远只追加不重写，压缩前的原始消息一个字节都不删。
//
// 三层分工：
//   store   磁盘  全量记录，append-only，永不丢失
//   replay  纯函数  记录 → 消息数组，是投影而非解码
//   context 内存  实际发给模型的视图
//
// replay 有两种投影：
//   'compacted'  最后一条 compaction 的 summary，加上所有
//                seq ∈ keptUserSeqs 或 seq >= firstKeptSeq 的 message，按 seq
//                排序（默认，也是 --resume 该用的；用全量恢复会立刻爆上下文）。
//                keptUserSeqs 全部小于 firstKeptSeq（它们来自被摘要取代的
//                那段历史，只是没有被折叠），排序后天然排在 firstKeptSeq 之后
//                的原文之前，不需要额外的归并逻辑。
//   'full'       忽略 compaction，返回全部 message（调试回溯用）
//
// 'compacted' 投影只允许比压缩后的内存视图更完整，不允许更少：少了症状很
// 隐蔽——保持会话正常，一 --resume 就丢掉最近几轮或保留的 user 消息，且不
// 报错；"更多"（比如剪枝结果不落盘，投影里看到未剪枝的原文）是良性的，因为
// 那部分差异永远是确定性纯函数、能从磁盘原文重新推导出来的。
// ============================================================================

export type StoreRecord =
  | { kind: 'message'; seq: number; message: Message }
  | {
      kind: 'compaction';
      seq: number;
      /**
       * 摘要消息。语义是覆盖式的：它涵盖 firstKeptSeq 之前的全部历史。
       */
      summary: Message;
      trigger: CompactTrigger;
      /**
       * 切点消息的 seq —— 摘要覆盖到此为止，这条及其之后的原文都要保留。
       *
       * 不能省掉它、直接取"本记录之后的 message"：compaction 记录是在保留
       * 消息都已经写盘之后才追加的，那批保留消息的 seq 比本记录小。按记录
       * 位置切会把它们全部丢掉，导致 --resume 出来的上下文比保持会话时少了
       * 最近几轮原文，而且不报错。
       */
      firstKeptSeq: number;
      /**
       * 压缩折叠掉的历史里、原样保留的 user 消息的 seq，从旧到新排列。
       *
       * 这批 seq 都小于 firstKeptSeq（它们来自被摘要取代的那段历史，只是
       * 没有被折叠），所以 replay 时按 seq 排序天然把它们排在 firstKeptSeq
       * 之前的原文之前——不需要额外的归并逻辑。老记录没有这个字段（这个
       * 功能上线之前写的），replay 按空数组处理，行为等同于没有保留过 user
       * 消息，不会因为字段缺失而出错或丢消息。
       */
      keptUserSeqs?: number[];
      /** 观测压缩收益用 */
      replacedCount: number;
      tokensBefore: number;
      tokensAfter: number;
      /** 摘要策略的自报元信息，横向评估时用 */
      meta: SummarizeMeta;
      /** 累积到此刻的文件清单；恢复会话后仍能继续累积。老记录缺失时当空处理。 */
      details?: FileOperations;
      timestamp: Millis;
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

export type LoopEndReason = 'stop' | 'maxTurns' | 'aborted' | 'error';

export type UIEvent =
  | {
      type: 'turn_start';
      turn: number;
      /** 模型请求发出前的上下文估算；旧的事件生产者可以省略。 */
      contextTokens?: number;
      contextWindow?: number;
    }
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
  /** Interaction 的人类可读通知；JSON CLI 也必须能在单一事件流中还原。 */
  | { type: 'notify'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'admission_denied'; reason: string; retryAfterMs: number | null }
  /**
   * 压缩开始。LLM 摘要在本地机器上可能跑几十秒（全量 prefill + 摘要 decode），
   * 没有这个事件界面就会停在上一个 phase 上一动不动。
   */
  | { type: 'compact_start'; trigger: CompactTrigger }
  /**
   * 触发了但没压成：安全边界之前没有可折叠的历史，或者压缩后反而更大。
   * 必须发 —— 否则 compact_start 之后没有收尾事件，界面会一直停在压缩相位。
   */
  | { type: 'compact_skipped'; trigger: CompactTrigger; reason: string }
  | {
      type: 'compacted';
      trigger: CompactTrigger;
      /** 'prune' 表示只剪了工具输出正文，没有生成摘要。 */
      kind: 'prune' | 'summarize';
      tokensBefore: number;
      tokensAfter: number;
      /** 正文被换成存根的 toolResult 条数。 */
      prunedCount: number;
      /** 摘要策略 id；kind 为 'prune' 时没有。 */
      strategy?: string;
      /** 内存参与决策时标明采样器，避免不同量纲的探针被混为一谈。 */
      resourceSource?: ResourceSnapshot['source'];
    }
  | { type: 'turn_end'; turn: number; usage: Usage; stopReason: StopReason }
  /** 每次 loop 恰好发一次；调用方不需要从 break 或最后一个 turn_end 猜原因。 */
  | { type: 'loop_end'; reason: LoopEndReason; turns: number }
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
  /** stopReason === 'length' 时自动续写的最大次数；0 表示禁用，立即报错。 */
  maxLengthContinuations: number;
}

export interface ContextConfig {
  /** 触发 compact 的上下文占用比例，0–1 */
  compactThreshold: number;
  /** 内存压力触发 compact 的阈值，0–1。M10 前不生效。 */
  memPressureThreshold: number;
  /**
   * 压缩时保留最近多少 token 的原文，按 contextWindow 的比例给出，0–1。
   *
   * 用 token 预算而不是消息条数：6 条消息可能是 300 token 的闲聊，也可能是
   * 40k token 的文件读取，条数控不住压缩后的实际体积，压缩频率也会随任务
   * 类型剧烈波动。
   *
   * 这个预算只给出候选切点，不是最终切点：边界不得切断 toolCall 与其
   * toolResult 的配对。compact 在调模型前触发，此刻末尾常常正是 toolResult，
   * 若从中间切开，压缩后的上下文里会出现没有前置 toolCall 的孤儿 toolResult
   * —— OpenAI 兼容服务对此从 400 到静默乱答都有，本地模型尤其容易崩。
   * 实现须从候选处向前找到最近的安全切点。
   */
  keepRecentRatio: number;
  /** 摘要消息的 token 上限，同时作为摘要调用的 maxTokens。 */
  summaryMaxTokens: number;
  /**
   * 最近这个比例的 token 内，工具输出正文免于剪枝，0–1。
   *
   * 独立于 keepRecentRatio 且通常更小：剪枝要够得着摘要保留区里的老工具输出，
   * 才能作为摘要的替代方案成立。见 context/prune.ts。
   */
  pruneProtectRatio: number;
  /**
   * 剪枝回收量低于此值就不剪。
   *
   * 剪枝改的是历史中段，一样会作废本地推理服务的 KV 前缀缓存。为几百 token
   * 的收益付一次全量 prefill 是亏的，宁可等到值得剪的时候一次剪掉。
   */
  pruneMinTokens: number;
  /**
   * 文件清单的条数上限。超出时先砍 read、保留最近的 —— 改过的文件比读过的
   * 重要得多。被丢弃的条数会在摘要里标注，避免看起来像"只碰过这些"。
   */
  maxTrackedFiles: number;
  /**
   * 折叠区里保留的真实 user 消息占 contextWindow 的比例，0–1。
   *
   * 用户的原始要求/约束是"结构里已经有的"信息，让模型转述只会引入漏项和
   * 错字；这个预算给它们一条不经过模型就能跨压缩存活的路径 —— 超预算时从
   * 最老的开始淘汰（它已经在最多轮压缩里被模型看过，该经历的都经历过了）。
   * 只保留角色为 user 且非 synthetic 的消息；harness 自己塞的摘要/续写提示词
   * 不算，见 UserMessage.synthetic。
   */
  keepUserRatio: number;
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
