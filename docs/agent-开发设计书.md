# Agent 开发设计书

> 本地模型 harness（harness = 承载模型运行的外壳程序，负责循环、工具、上下文、资源调度）
>
> 版本 v1 · 建设顺序：自底向上 · 云端模型先行，本地能力留桩

---

## 0. 怎么用这份文档

每个里程碑（M0–M11）包含四块：

| 块 | 含义 |
|---|---|
| **目标** | 这一步结束后系统多了什么能力 |
| **交付** | 具体产出哪些文件 |
| **桩** | 这一步定义了接口但先返回常量的东西 |
| **验收** | 一条能跑的命令 + 肉眼可见的结果，达不到就不进下一步 |

**硬规则：每个里程碑结束时代码必须能跑。** 不允许出现"这一层写完了但还跑不起来，等下一层"。这是自底向上唯一的成立条件——每一层交付时都要有一个哪怕很傻的入口能验证它。

---

## 1. 项目定位

**一句话**：专门为本地部署模型（Qwen3.6 / Gemma4 这类跑在 Mac 上的模型）设计的 coding agent harness。

与 Claude Code / pi 的差异点，也是本项目全部的存在理由：

1. **内存压力参与 compact 决策** —— 不只看上下文窗口占用。模型推理本身吃内存，agent 执行的动作（启动服务、跑构建）也吃内存，两者抢同一块统一内存。上下文没满但机器要 swap 了，同样得压缩。
2. **subagent 准入检查** —— 起子 agent 前先看 GPU 状态。主 agent 正在 decode（逐 token 生成）时插入子 agent 的 prefill（预填充，一次性处理整段提示词），两者抢 GPU 会让主 agent 速度断崖式下跌。资源不达标就直接拒绝，而不是让用户等。
3. **工具调用走 macOS 原语沙箱** —— 本地模型智力有限，误操作概率显著高于云端大模型，隔离必须是系统级强制的，不能靠提示词约束。超出沙箱边界的操作需人工确认。
4. **系统提示词尽可能小** —— 本地模型的有效上下文远小于标称值，提示词每多一千 token，可用工作区就少一千。

> **贯穿全程的判断标准**：任何一个设计决策，如果对云端大模型和本地小模型的意义是一样的，那它就不是本项目的重点，抄现成方案即可。

---

## 2. 架构总览

```
Phase 3  app/      tui/   cli/   rpc/
                   ↓ 调用 AgentSession      ↑ UIEvent 流      ↓ 注入 Interaction
Phase 2  agent/    session/  provider/  permissions/  admission/  config/
                   ↓ 装配与策略注入
Phase 1  core/     loop/  llm/  context/  tools/  sandbox/  store/  resource/  telemetry/
                                          ↓
                                     macOS 原语（进程 · 文件 · 权限 · 资源限制）
```

三层之间只有三条通道：

- **向下调用** —— 上层调下层，下层不认识上层
- **向上事件** —— `UIEvent` 单向流，有序不丢
- **向下注入** —— `Interaction`（人工确认通道）、`summarize` 回调、配置值

---

## 3. 依赖规则（硬约束）

这是三层目录唯一的价值所在，必须用工具卡住，不能靠自觉。

| 规则 | 说明 |
|---|---|
| `core/` 不得 import `agent/` 或 `app/` | 底层零件不知道上层存在 |
| `agent/` 不得 import `app/` | 策略层不知道 UI 存在 |
| `core/types.ts` 不得 import 任何模块 | 纯类型定义，谁都能引它，它谁都不引 |
| `core/` 任何文件不得 import `@earendil-works/pi-ai`，**除了** `core/llm/pi-ai.ts` | 第三方类型只在适配器里出现 |
| `core/` 任何文件不得读配置文件或环境变量 | 配置由构造参数传入 |

落地方式：

```bash
npm i -D dependency-cruiser
```

`.dependency-cruiser.cjs`：

```js
module.exports = {
  forbidden: [
    { name: 'core-no-upward', severity: 'error',
      from: { path: '^src/core' }, to: { path: '^src/(agent|app)' } },
    { name: 'agent-no-app', severity: 'error',
      from: { path: '^src/agent' }, to: { path: '^src/app' } },
    { name: 'types-is-leaf', severity: 'error',
      from: { path: '^src/core/types\\.ts$' }, to: { pathNot: '^$' } },
    { name: 'pi-ai-only-in-adapter', severity: 'error',
      from: { path: '^src/core', pathNot: '^src/core/llm/pi-ai\\.ts$' },
      to: { path: 'node_modules/@earendil-works/pi-ai' } },
  ],
};
```

挂到 CI 和 pre-commit。**M0 就要挂上**，等有了违规再补规则就晚了。

---

## 4. 目录结构

```
bin/
  agent.ts                   # CLI 入口
test/
.dependency-cruiser.cjs
src/
  core/                      # Phase 1 —— 纯零件，可单独测试
    types.ts                 # 全局类型契约（叶子节点）
    loop/
      index.ts               # agent loop
      react.ts               # ReAct 策略实现
    llm/
      provider.ts            # 自己的 Provider 接口
      pi-ai.ts               # pi-ai 适配器（唯一允许碰第三方类型的文件）
      faux.ts                # 测试用假 provider
    context/
      manager.ts             # 内存消息 + token 计账
      compact.ts             # 压缩策略（多输入触发）
    tools/
      registry.ts            # 注册与查找
      execute.ts             # 执行链：准入 → 权限 → 沙箱 → 截断
      prompted.ts            # 无原生工具调用时的降级解析
      builtin/
        read.ts  write.ts  edit.ts  bash.ts  spawn-subagent.ts
    sandbox/
      index.ts               # 门禁接口
      macos.ts               # sandbox-exec 实现
      passthrough.ts         # 桩：直接放行
    store/
      jsonl.ts               # session 落盘与恢复
    resource/
      index.ts               # ResourceProbe 接口
      constant.ts            # 桩：返回固定值
      macos.ts               # 真实探测
    telemetry/
      span.ts                # span 类型与导出接口
      console.ts             # 桩：打到 stderr
  agent/                     # Phase 2 —— 策略与装配
    session.ts               # AgentSession 实现
    provider/index.ts        # 模型选择、凭证、路由
    permissions/index.ts     # 人工确认策略
    admission/index.ts       # subagent 准入决策
    config/index.ts          # 配置来源解析与合并
  app/                       # Phase 3 —— 应用入口
    cli/index.ts             # print / JSON 模式
    tui/index.ts             # 终端交互
    rpc/index.ts             # 远程调用
```

**命名注意**：Phase 2 的入口文件叫 `session.ts` 而非 `agent.ts`，避免 `src/agent/agent.ts` 这种路径。`core/llm/` 而非 `core/model/`，与 `agent/provider/` 区分开——`llm` 是"怎么发请求"，`provider` 是"发给谁、用谁的密钥"。

---

## 5. 类型契约（`core/types.ts`）

这个文件是整个项目的地基。它必须在 M1 一次定清楚，后面改动成本极高。

```ts
// ============ 消息与上下文 ============

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError: boolean;
  truncated?: boolean;        // 结果是否被截断，模型需要知道
  timestamp: number;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: 'image'; data: string; mimeType: string };

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: ToolDef[];
}

// ============ 模型调用 ============

export interface ModelRef {
  provider: string;
  id: string;
  contextWindow: number;
  supportsNativeToolCalling: boolean;   // Gemma 系为 false，走 prompted 降级
  reasoning: boolean;
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
  | { type: 'toolcall_start'; index: number }
  | { type: 'toolcall_delta'; index: number; delta: string }
  | { type: 'toolcall_end'; index: number; call: { id: string; name: string; arguments: unknown } }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; reason: 'error' | 'aborted'; message: AssistantMessage };

// 唯一的模型调用边界。换 pi-ai、换裸 HTTP，都只改实现这个接口的文件。
export interface Provider {
  readonly id: string;
  listModels(): ModelRef[];
  stream(model: ModelRef, ctx: Context, opts?: StreamOptions): AsyncIterable<StreamEvent>;
}

// ============ 工具 ============

export interface ToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** 该工具是否可能突破沙箱边界，决定是否触发人工确认 */
  privileged?: boolean;
  /** 该工具是否需要资源准入检查（subagent 用） */
  requiresAdmission?: boolean;
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  trace: TraceContext;
  interaction: Interaction;
}

export interface Tool extends ToolDef {
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolOutput {
  content: ContentBlock[];
  isError: boolean;
  /** 工具自己上报的资源占用，用于 compact 决策 */
  resourceHint?: { spawnedProcesses?: number; memMB?: number };
}

// ============ 资源探测（本项目卖点的数据源）============

export interface ResourceSnapshot {
  /** 0–1，1 表示系统即将 swap */
  memPressure: number;
  memAvailableMB: number;
  /** GPU 是否正忙于推理 */
  gpuBusy: boolean;
  /** 当前活跃的 agent 子进程数 */
  activeSubagents: number;
}

export interface ResourceProbe {
  snapshot(): Promise<ResourceSnapshot>;
}

// ============ 准入与权限 ============

export interface AdmissionDecision {
  ok: boolean;
  reason?: string;
  /** 建议重试的等待毫秒数，null 表示不建议重试 */
  retryAfterMs?: number | null;
}

export interface AdmissionController {
  canSpawnSubagent(): Promise<AdmissionDecision>;
}

export interface PermissionRequest {
  toolName: string;
  summary: string;
  detail?: string;
}

export interface PermissionPolicy {
  check(req: PermissionRequest, i: Interaction): Promise<'allow' | 'deny'>;
}

// ============ 反向通道：底层向用户提问 ============

export interface Interaction {
  prompt(req: {
    type: 'confirm' | 'text' | 'secret' | 'select';
    message: string;
    options?: string[];
  }): Promise<string>;
  notify(e: { type: 'info' | 'warn' | 'error'; message: string }): void;
}

// ============ 上下文压缩 ============

export interface CompactSignals {
  tokenUsage: number;
  contextWindow: number;
  resource?: ResourceSnapshot;      // 云端阶段为 undefined
}

export interface CompactPolicy {
  shouldCompact(s: CompactSignals): boolean;
  compact(msgs: Message[], summarize: Summarize): Promise<Message[]>;
}

/** 由 loop 注入，context 因此不需要认识 llm 层 */
export type Summarize = (msgs: Message[]) => Promise<string>;

// ============ 可观测性 ============

export interface TraceContext {
  traceId: string;
  spanId: string;
  child(name: string): TraceContext;
}

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs: number;
  attrs: Record<string, string | number | boolean>;
}

export interface SpanExporter {
  export(span: Span): void;
}

// ============ UI 事件（给人看，与 Span 严格分开）============

export type UIEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; isError: boolean; preview: string }
  | { type: 'permission_request'; req: PermissionRequest }
  | { type: 'admission_denied'; reason: string }
  | { type: 'compacted'; before: number; after: number; trigger: 'token' | 'memory' }
  | { type: 'turn_end'; usage: Usage }
  | { type: 'error'; message: string };
```

> **为什么 `UIEvent` 和 `Span` 是两套？**
> Span 服务于可观测性平台：结构化、可采样、可丢弃、允许延迟聚合。UIEvent 服务于人：严格有序、一个都不能丢、必须携带增量文本。复用的结果是——为了 UI 流畅不敢采样 span，或者为了 span 干净把 UI 需要的增量吞掉。

---

## 6. 建设路线

### M0 · 工程骨架

**目标**：仓库能跑，依赖规则已经生效。

**交付**
- `package.json`（`type: module`）、`tsconfig.json`（`strict: true`）
- 全部空目录 + 每个目录一个 `index.ts` 占位
- `.dependency-cruiser.cjs`（见第 3 节）
- `bin/agent.ts`：打印版本号就行
- 测试框架接入（vitest）

**桩**：全部。

**验收**
```bash
npm run build && node bin/agent.js --version   # 输出版本号
npm run depcruise                              # 0 violations
```

---

### M1 · 类型契约

**目标**：`core/types.ts` 落地，这是后面所有代码的公共语言。

**交付**：第 5 节全文，一字不落。

**验收**
```bash
npx tsc --noEmit    # 通过
npm run depcruise   # types.ts 的 import 数为 0
```

> 这一步没有可运行的功能，是唯一的例外。但它必须单独成为一个里程碑——如果和 M2 合并，你会边写 provider 边改类型，最后类型是被实现倒逼出来的，而不是设计出来的。

---

### M2 · 模型调用层

**目标**：能把一句话发给模型，流式打印回来。

**交付**
- `core/llm/provider.ts` —— 就是 re-export types.ts 里的 `Provider`，加一些工具函数
- `core/llm/faux.ts` —— 假 provider，按脚本返回预设响应，支持模拟：文本流、工具调用、畸形 JSON、中途报错、慢速输出
- `core/llm/pi-ai.ts` —— pi-ai 适配器，**边界转换全在这里**：pi-ai 的 `AssistantMessage` → 你的 `AssistantMessage`
- `bin/agent.ts` 加一个 `--smoke` 参数

**桩**：无。这一层是真实实现。

**验收**
```bash
node bin/agent.js --smoke --provider faux      # 打印预设文本
node bin/agent.js --smoke --provider anthropic # 打印真实模型输出
```

**要点**
- `faux.ts` 不是可选项。后面所有 loop 测试都靠它，它必须能构造出真实模型不容易复现的畸形情况。
- pi-ai 的类型一个字节都不许出现在 `pi-ai.ts` 之外。适配器里做完整转换，宁可多写 50 行映射代码。

---

### M3 · 工具层

**目标**：能注册工具、校验参数、执行、截断结果。执行链的所有关卡先全部放行。

**交付**
- `core/tools/registry.ts` —— 注册、查找、生成工具定义的 JSON Schema
- `core/tools/execute.ts` —— 执行链骨架：

  ```ts
  export async function executeTool(
    tool: Tool, args: unknown, ctx: ToolContext,
    deps: { admission: AdmissionController; permissions: PermissionPolicy; sandbox: Sandbox }
  ): Promise<ToolOutput> {
    if (tool.requiresAdmission) {
      const d = await deps.admission.canSpawnSubagent();
      if (!d.ok) return errorOutput(`资源不足：${d.reason}`);
    }
    if (tool.privileged) {
      const p = await deps.permissions.check({ toolName: tool.name, summary: describe(args) }, ctx.interaction);
      if (p === 'deny') return errorOutput('用户拒绝执行');
    }
    const validated = validate(tool.parameters, args);   // 失败要返回给模型让它重试，不是抛异常
    const raw = await deps.sandbox.run(() => tool.execute(validated, ctx), tool);
    return truncate(raw);
  }
  ```
- `core/tools/builtin/`：`read` `write` `edit` `bash` 四个
- `core/sandbox/passthrough.ts` —— 桩
- 截断策略：结果超过阈值时保留头尾、中间替换为 `[... N 行已省略 ...]`，并置 `truncated: true`

**桩**
| 接口 | 桩实现 |
|---|---|
| `AdmissionController` | 永远 `{ ok: true }` |
| `PermissionPolicy` | 永远 `'allow'` |
| `Sandbox` | `passthrough`，直接执行 |

**验收**
```bash
node bin/agent.js --tool read --args '{"path":"package.json"}'
node bin/agent.js --tool bash --args '{"cmd":"yes | head -100000"}'   # 结果被截断，且 truncated=true
node bin/agent.js --tool read --args '{"path":123}'                   # 返回参数校验错误，不崩溃
```

**要点**：参数校验失败必须作为工具结果返回给模型（`isError: true`），让它自己重试。抛异常中断整个 turn 是错的——本地小模型生成畸形参数的频率很高，这是常态而非异常。

---

### M4 · Agent Loop

**目标**：第一次真正跑起来。给一个任务，模型调工具、看结果、继续，直到完成。

**交付**
- `core/loop/index.ts` —— 主循环，约 200 行
- `core/loop/react.ts` —— ReAct 策略（模型交替产出推理与动作）
- 每轮：调模型 → 收流式事件 → 提取工具调用 → 并发执行 → 结果写回 → 判断是否继续

**桩**
| 项 | 桩实现 |
|---|---|
| 上下文管理 | 消息数组无脑追加，不压缩 |
| 持久化 | 不落盘 |
| tracing | `console.error` 打日志 |
| cancellation | 只在轮次之间检查 signal |

**验收**
```bash
node bin/agent.js "读取 package.json 并告诉我依赖了哪些包"
# 观察：模型调用 read → 拿到内容 → 输出答案 → 循环结束
```

**要点**
- 流式工具参数的增量拼接（partial JSON，参数 JSON 被切碎跨 chunk 到达）是这一步最容易出 bug 的地方。用 `faux.ts` 构造出"参数被切成 20 段"的情况专门测。
- 循环终止条件要显式：`stopReason === 'stop'`、超过最大轮数、用户取消。三者都要有对应的 UIEvent。

---

### M5 · 上下文管理与持久化

**目标**：长对话不爆上下文，退出后能恢复。

**交付**
- `core/context/manager.ts` —— 消息存储、token 计账（用 tokenizer 库，别估算）
- `core/context/compact.ts` —— 实现 `CompactPolicy`
- `core/store/jsonl.ts` —— 每条消息一行 JSON 追加写，恢复时逐行读

**桩**
```ts
// 云端阶段：只有 token 一个输入源
shouldCompact(s: CompactSignals) {
  return s.tokenUsage > s.contextWindow * 0.8;
  // 本地阶段追加：|| (s.resource && s.resource.memPressure > 0.75)
}
```
`CompactSignals.resource` 此时为 `undefined`。

**关键设计**：`context/` 不认识 `llm/`。压缩需要调模型生成摘要，这个能力由 loop 在构造时注入：

```ts
// core/loop/index.ts
const ctx = new ContextManager({
  maxTokens: cfg.context.maxTokens,
  summarize: (msgs) => this.provider.complete(summaryPrompt(msgs)),   // ← 注入
  probe: this.probe,                                                   // ← 注入
});
```

搬运责任也在 loop：从 store 读出消息塞进 context，context 变更后写回 store。两个组件互不认识。

**验收**
```bash
node bin/agent.js --session s1 "任务A"
node bin/agent.js --session s1 --resume "继续上一步"   # 模型记得任务A
node bin/agent.js --session s2 --max-tokens 2000 "一个需要读十个文件的任务"
# 观察 compacted 事件触发，且压缩后模型仍能继续工作
```

---

### M6 · 可观测性与取消

**目标**：能看见每一步耗时，Ctrl+C 能干净停下。

**交付**
- `core/telemetry/span.ts` —— Span 类型 + `SpanExporter` 接口
- `core/telemetry/console.ts` —— 桩 exporter，打到 stderr
- loop 中统一注入 `TraceContext`：每轮一个 span，模型调用、每个工具调用各一个子 span
- `AbortSignal` 从 loop 一路传到 provider 的 HTTP 请求和 bash 工具的子进程

**桩**：`SpanExporter` 只有 console 实现。M11 接 Laminar 时新增一个实现即可。

**必测的取消场景**
1. 模型正在流式输出时 Ctrl+C
2. bash 工具正在跑一个长命令时 Ctrl+C —— 子进程必须被杀掉，不能变成孤儿进程
3. 多个工具并发执行时 Ctrl+C

**验收**
```bash
node bin/agent.js --trace "读三个文件"       # stderr 打印 span 树与各段耗时
node bin/agent.js "跑 sleep 300"             # Ctrl+C 后 ps 里没有残留的 sleep 进程
```

**要点**：孤儿进程是这一步最容易漏的。bash 工具要用进程组（`detached: true` + `process.kill(-pid)`），单独 kill 子进程杀不掉它自己起的孙子进程。

---

### M7 · 装配层与反向通道

**目标**：`core/` 的零件被组装成一个可复用的 `AgentSession`，人工确认通道打通。

**交付**
- `agent/session.ts`：

  ```ts
  export interface AgentSession {
    prompt(text: string): Promise<void>;
    abort(): void;
    subscribe(h: (e: UIEvent) => void): () => void;
    setInteraction(i: Interaction): void;
  }
  ```
- `agent/config/index.ts` —— 解析配置文件 + 环境变量 + CLI flag，合并后产出普通对象
- `agent/provider/index.ts` —— 按配置选模型、取凭证
- `agent/permissions/index.ts` —— 真实实现：`privileged` 工具触发 `interaction.prompt()`
- `agent/admission/index.ts` —— 仍是桩，但从这里读配置

**核心约束再强调**：`core/` 的任何文件都不读配置。配置在 `agent/session.ts` 装配时以构造参数传下去。违反这条，`core/` 就不再可单测。

**验收**
```bash
node bin/agent.js "删除 /tmp/test.txt"
# 弹出确认提示 → 输入 n → 工具返回"用户拒绝执行" → 模型收到并调整策略
```

---

### M8 · 应用层：CLI 先行

**目标**：能被脚本批量调用。

**交付**
- `app/cli/index.ts` —— print 模式（纯文本）与 JSON 模式（每行一个 UIEvent）
- `Interaction` 的非交互实现：所有确认请求自动拒绝，并记录到输出

**为什么 CLI 排在 TUI 前面**：你的评估方案需要 Harbor 批量调用 agent 跑 Terminal-Bench，那时没有人坐在终端前。TUI 是给你自己用的，CLI 是给评测用的，后者是项目下一步的刚需。

**验收**
```bash
echo "统计 src 下有多少个 ts 文件" | node bin/agent.js --json | jq -r 'select(.type=="text_delta").delta'
```

---

### M9 · 沙箱真实实现

**目标**：工具执行被 macOS 强制隔离，越界操作触发人工确认。

**交付**
- `core/sandbox/macos.ts` —— 用 `sandbox-exec` 配置 profile，限制：
  - 文件写入仅限工作目录及临时目录
  - 网络访问默认禁止，按配置白名单放行
  - 禁止修改系统目录
- 越界检测 → 抛出可识别的错误 → `execute.ts` 转成人工确认请求

**验收**
```bash
node bin/agent.js "把 /etc/hosts 改一下"   # 沙箱拦截 → 人工确认 → 拒绝后模型收到明确错误
```

**要点**：`sandbox-exec` 已被 Apple 标记为 deprecated（弃用）但仍可用。把它藏在 `Sandbox` 接口后面，将来换成 Endpoint Security 框架或容器方案时只改一个文件。这也是为什么 M3 就要定义这个接口，哪怕当时只有 passthrough 实现。

---

### M10 · 资源探针与准入（卖点落地）

**目标**：项目的差异化能力正式生效。

**交付**
- `core/resource/macos.ts`：
  - 内存压力 —— 读 `vm_stat` 或 `sysctl vm.memory_pressure`
  - GPU 忙闲 —— `powermetrics --samplers gpu_power`，注意需要 sudo，考虑改用 IOKit 或退化为"是否有活跃推理请求"这个软信号
  - 活跃 subagent 数 —— 自己记账
- `agent/admission/index.ts` 真实实现：

  ```ts
  async canSpawnSubagent(): Promise<AdmissionDecision> {
    const s = await this.probe.snapshot();
    if (s.memAvailableMB < this.cfg.minMemMB)
      return { ok: false, reason: `可用内存 ${s.memAvailableMB}MB 低于阈值`, retryAfterMs: 5000 };
    if (s.gpuBusy && s.activeSubagents >= 1)
      return { ok: false, reason: 'GPU 忙且已有子 agent 运行', retryAfterMs: 10000 };
    return { ok: true };
  }
  ```
- `CompactPolicy.shouldCompact` 接入 `resource.memPressure`
- `spawn-subagent` 工具（`requiresAdmission: true`）

**验收**
```bash
# 人为占满内存后
node bin/agent.js "并行分析这十个模块"
# 观察 admission_denied 事件，且模型收到明确原因后改为串行处理
```

**注意**：探针采样有成本，`powermetrics` 尤其重。加缓存（比如 2 秒内复用上次快照），否则每次工具调用都探测一遍会明显拖慢循环。

---

### M11 · 本地模型接入与对照评测

**目标**：换成本地模型跑通，并与 pi 做对照。

**交付**
- `core/llm/pi-ai.ts` 增加本地 provider 注册（LM Studio / llama.cpp，见附录 A）
- `core/tools/prompted.ts` —— 无原生工具调用的降级路径：
  - 工具定义渲染进 system prompt（格式要极简，本地模型上下文金贵）
  - 从文本流里增量抽取工具调用
  - 解析失败时把错误返回给模型重试
  - `ModelRef.supportsNativeToolCalling` 为 false 时自动启用
- `core/telemetry/` 增加 Laminar exporter
- Harbor 适配器，跑 Terminal-Bench

**对照实验的设计**：pi 和自研 agent 使用同一个模型调用层（都是 pi-ai）、同一个本地模型、同一个测试集。这样结果差异可以归因到 harness 设计，而不是"某一边的 SSE 解析有 bug"或"重试策略不同"。

**验收**
```bash
node bin/agent.js --provider lmstudio --model qwen3.6-27b "在这个仓库里加一个 xxx 功能"
# 跑通，且 trace 里能看到内存压力触发的 compact
```

---

## 7. 插桩清单

| 接口 | 定义于 | 桩实现 | 真实实现 | 替换时机 |
|---|---|---|---|---|
| `Provider` | M1 | `faux.ts` | `pi-ai.ts` | M2 同时存在 |
| `AdmissionController` | M1 | 永远 `{ ok: true }` | 读探针判断 | M10 |
| `ResourceProbe` | M1 | 返回固定值 | `vm_stat` / `powermetrics` | M10 |
| `Sandbox` | M3 | `passthrough` 直接执行 | `sandbox-exec` | M9 |
| `PermissionPolicy` | M3 | 永远 `allow` | 触发 `Interaction` | M7 |
| `SpanExporter` | M6 | 打到 stderr | Laminar | M11 |
| `CompactPolicy` 的 resource 输入 | M5 | `undefined` | 接入探针快照 | M10 |
| 工具调用形态 | M3 | 仅原生 tool calling | 增加 prompted 降级 | M11 |
| `Interaction` | M1 | CLI 自动拒绝 | TUI 弹窗 | M7 / M8 |

**桩的两条纪律**

1. **桩必须实现完整接口，不能是 `throw new Error('not implemented')`。** 桩的作用是让上层代码现在就能跑通完整路径，而不是标记待办。
2. **桩的返回值要能被配置改变。** 比如 `constant.ts` 的探针应该能通过配置返回"内存不足"，这样你在 M10 之前就能测准入拒绝的分支，不用等真实探针。

---

## 8. 测试策略

| 层 | 测什么 | 怎么测 |
|---|---|---|
| `core/llm/` | 边界转换正确性 | 录制真实响应 → 回放断言 |
| `core/loop/` | 循环控制、partial JSON 拼接、错误恢复 | `faux.ts` 构造畸形输入 |
| `core/tools/` | 执行链各关卡、截断、参数校验失败 | 桩依赖注入 |
| `core/context/` | token 计账、compact 触发与结果 | 纯函数测试 |
| `core/resource/` | 探针解析 | 录制 `vm_stat` 输出 |
| 端到端 | 完整任务 | Terminal-Bench 子集 |

**骨架期不要用最强的云端模型开发。** Claude Opus / GPT 顶配会替你的 harness 擦屁股：工具结果格式错了它猜得出来，system prompt 写得烂它照样干活，partial JSON 拼错了它下一轮自己纠正。结果是你的 loop 明明有 bug 但测试全绿，等接上 Qwen3.6 全炸。

建议配置：
- **单元测试** → `faux.ts`，零成本、确定性、可构造畸形
- **开发主力** → 中档模型（Haiku / DeepSeek），能力区间接近本地模型
- **顶配模型** → 只做上限对照，不做开发验证

---

## 9. 已知风险与取舍

| 风险 | 说明 | 应对 |
|---|---|---|
| GPU 忙闲探测不可靠 | `powermetrics` 需要 sudo，IOKit 接口不稳定 | 退化方案：用"是否有活跃推理请求"这个软信号，自己记账 |
| `sandbox-exec` 已弃用 | Apple 未给出明确移除时间 | 藏在 `Sandbox` 接口后，换实现只改一个文件 |
| 探针采样有性能成本 | 每次工具调用都探测会拖慢循环 | 加 2 秒缓存 |
| loop 会变胖 | 组件互不认识意味着搬运责任全在 loop | 接受。搬运逻辑单独抽函数，但不引入新的中间层 |
| pi-ai 是外部依赖 | 上游 API 变更风险（近期刚换过 npm scope） | 适配器隔离；真出问题时自己写 OpenAI 兼容客户端约 300–500 行 |
| 本地模型工具调用形态碎片化 | Qwen3 走 Hermes 风格原生字段，Gemma 系无原生能力 | `supportsNativeToolCalling` 标志 + prompted 降级路径 |

**明确不做的事**

- 不做多 provider 抽象层。目标是本地模型，出口都是 OpenAI 兼容的 `/chat/completions`，只有一个协议要对接，付不起框架的抽象税。
- 骨架期不碰 `cache_prompt` / `n_keep` 这类 llama.cpp、MLX server 的非标准参数。云端 API 根本不透出这些，现在调是白调，留到 M11。
- 不做 plan mode、不做复杂的 subagent 编排。系统提示词要小，功能越多提示词越长。

---

## 附录 A · 本地 provider 注册（M11 用）

```ts
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const BASE = 'http://localhost:1234/v1';

const local = createProvider({
  id: 'local',
  name: 'Local',
  baseUrl: BASE,
  auth: { apiKey: { name: 'Local', resolve: async () => ({ auth: {} }) } },
  models: [{
    id: 'qwen3.6-27b',
    name: 'Qwen3.6 27B',
    api: 'openai-completions',
    provider: 'local',
    baseUrl: BASE,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32000,
    // 本地 OpenAI 兼容服务通常不认 developer 角色和 reasoning_effort 参数
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  }],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(local);
```

模型 ID 必须与服务端返回一致：

```bash
curl http://localhost:1234/v1/models | jq '.data[].id'
```

---

## 附录 B · 里程碑速查

| # | 名称 | 核心产出 | 完成标志 |
|---|---|---|---|
| M0 | 工程骨架 | 目录 + 依赖规则 | `--version` 能跑，depcruise 0 违规 |
| M1 | 类型契约 | `core/types.ts` | `tsc --noEmit` 通过 |
| M2 | 模型调用 | faux + pi-ai 适配器 | 流式打印模型输出 |
| M3 | 工具层 | 注册 + 执行链 + 4 工具 | 单个工具可独立调用 |
| M4 | Agent Loop | 主循环 + ReAct | 完成一个需要调工具的任务 |
| M5 | 上下文与存储 | 计账 + compact + JSONL | 长对话不爆，可恢复 |
| M6 | 可观测与取消 | span + AbortSignal | Ctrl+C 无残留进程 |
| M7 | 装配层 | AgentSession + 人工确认 | 确认弹窗生效 |
| M8 | CLI | print / JSON 模式 | 可被脚本批量调用 |
| M9 | 沙箱 | sandbox-exec | 越界被拦截 |
| M10 | 探针与准入 | 卖点落地 | 资源不足时拒绝 subagent |
| M11 | 本地模型 | prompted 降级 + 评测 | Terminal-Bench 对照跑通 |

TUI 不在关键路径上，M8 之后任意时间插入。
