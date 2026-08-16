# ppagent

为本地部署模型设计的 coding agent harness。

> **在线介绍页：** [https://fish0710.github.io/ppagent/](https://fish0710.github.io/ppagent/)

云端 agent 往往假设算力与并发资源充足，而本地模型需要与 agent 共享同一台机器的内存、GPU 和进程资源。ppagent 从这些约束出发，探索面向本地模型的上下文压缩、子 agent 准入、系统级隔离和资源感知执行。

## 当前状态

项目正在公开开发中：

- M0：工程骨架、依赖方向规则与 CI 已完成
- M1：核心类型契约已完成
- M2：模型调用层与测试 provider 已完成
- M3：工具注册、四关执行链与 read/write/edit/bash 已完成
- M4：流式 ReAct agent loop、工具调度与显式终止事件已完成
- M5：BPE token 计账、安全上下文压缩、JSONL 会话持久化与 replay 已完成
- M6：层级 span、console exporter 与端到端干净取消已完成
- M7：AgentSession 装配、配置合并与人工确认反向通道已完成
- M8：print/JSONL CLI、stdin prompt 与非交互安全拒绝已完成
- M9：macOS `sandbox-exec` 隔离、路径越界与网络白名单已完成
- M10：macOS 资源探针、内存/GPU 准入和 `spawn_subagent` 已完成
- M11：本地 provider 别名、原生 tool calling 探针、匹配 tokenizer、Laminar 与 Harbor 适配器已完成
- 可选 TUI：scrollback transcript、固定 live 区、本地推理指标与单键权限确认已完成

M0–M11 的开发路线已经贯通；目前仍是源码构建使用，还没有可安装的发行版本。

## 本地开发

需要 Node.js 22.19 或更高版本。

```bash
npm ci
npm run build
npm run depcruise
npm test
```

### 验证工具执行链

```bash
node bin/agent.js --tool read --args '{"path":"package.json"}'
node bin/agent.js --tool bash --args '{"cmd":"yes | head -100000"}'
node bin/agent.js --tool read --args '{"path":123}'
```

最后一条会返回 `isError: true` 的工具结果，而不是抛异常；超长结果会保留头尾并置
`truncated: true`。

### 验证 Agent Loop

```bash
node bin/agent.js "读取 package.json 并告诉我依赖了哪些包"
```

默认 faux provider 会脚本化地产生一次 `read` 调用，再读取工具结果进入第二轮并完成任务。
命令行通过可复用的 `AgentSession` 装配 core 组件，默认 print 模式只把模型正文写到 stdout。

### 使用轻量 TUI

TUI 只消费 `UIEvent` 并实现 `Interaction`，不持有 context、loop 或 tool 状态。终端设施使用
`@earendil-works/pi-tui` 的 `TuiMainScreen`，不进入 alternate screen；已经提交的 transcript
会留在终端 scrollback，底部的 prefill、decode 和工具状态由 pi-tui 做同步差分渲染：

```bash
node bin/agent.js --tui

# 也可以带第一条任务启动；完成后仍可继续输入下一条
node bin/agent.js --tui \
  --provider lmstudio --model qwen3.6-27b \
  "读取 package.json 并说明项目结构"
```

空闲时输入 `/exit` 或 `/quit` 退出。任务运行时第一次 `Ctrl+C` 调用 `session.abort()` 并等待工具
进程组清理，1.5 秒内第二次按下则请求退出；空闲时 `Ctrl+C` 直接退出。`ProcessTerminal` 统一管理
raw mode 和键盘协议，prompt 使用 pi-tui `Input`（支持 CJK/IME、编辑和 bracketed paste），权限确认
通过 input listener 消费单键 `y/n`。

live 区显示静默 prefill 时间、近似流式 tok/s 和上下文占比；一轮结束后使用 provider 的 usage
提交精确 tok/s。内存压缩和子 agent 准入拒绝作为永久 transcript 行显示，并包含资源采样来源。

### 验证脚本调用与 JSONL

没有位置参数时从 stdin 读取 prompt；`--json` 的 stdout 严格为一行一个完整 `UIEvent`：

```bash
echo "统计 src 下有多少个 ts 文件" | node bin/agent.js --json
echo "统计 src 下有多少个 ts 文件" | node bin/agent.js --json \
  | jq -r 'select(.type=="text_delta").delta'
```

JSON 模式和管道输入都使用明确的非交互 `Interaction`。权限确认会自动拒绝；JSON 模式把
可读说明作为结构化 `notify:warn` 写入 stdout，print 模式则写入 stderr。JSONL 同时包含
`permission_request`、`permission_resolved` 和失败的 `tool_end`，benchmark 无需合并 stderr
即可还原拒绝原因与完整过程。

### 验证配置与人工确认

配置按“内置默认值 < global < project < project.local < 环境变量 < CLI flag”合并，
其中 global/project/project.local 是三层 JSON 文件，后面的层覆盖前面的层：

| 层级 | 路径 | 说明 |
| --- | --- | --- |
| global | `~/.ppagent/agent.json` | 用户级偏好；首次启动如果不存在会自动创建一份默认值快照 |
| project | `<cwd>/agent.json`（可用 `--config PATH` 覆盖路径） | 项目共享配置，建议提交进仓库 |
| project.local | `<cwd>/agent.local.json` | 本地个人覆盖，已加入 `.gitignore`，不应提交 |

三层文件都不存在（除 global 会被自动创建外）时直接退回内置默认值。

```json
{
  "provider": { "id": "faux" },
  "loop": { "maxTurns": 8 },
  "tools": { "maxConcurrency": 4 }
}
```

```bash
node bin/agent.js --config ./agent.json --max-turns 4 "读取 package.json"
node bin/agent.js "删除 /tmp/test.txt"
# 确认框首行显示 rm -f /tmp/test.txt；输入 n 后，拒绝结果会返回给模型继续推理
```

#### 完整配置示例（所有可配置项）

下面是一份包含全部字段的示例（可直接存成 `agent.json`）。省略任意字段都会退回内置默认值；
没有默认值的字段（`model`/`baseUrl`/`apiKey`/`maxOutputTokens`/`effort`/`requestTimeoutMs`/
`maxRetries`/`contextWindow`/`tokenizer`/`laminarApiKey`）不配就是完全不生效，不是空字符串/0。

```json
{
  "provider": {
    "id": "anthropic",
    "model": "claude-opus-5",
    "apiKey": "sk-...",
    "maxOutputTokens": 25600,
    "effort": "medium",
    "requestTimeoutMs": 300000,
    "maxRetries": 3
  },
  "loop": {
    "maxTurns": 60,
    "turnTimeoutMs": 1200000,
    "maxLengthContinuations": 2
  },
  "context": {
    "compactThreshold": 0.8,
    "memPressureThreshold": 0.75,
    "keepRecentMessages": 6,
    "contextWindow": 131072,
    "summaryTargetRatio": 0.4,
    "tokenizer": "Xenova/gpt-4o",
    "tokenizerLocalOnly": true,
    "tokenizerTimeoutMs": 30000
  },
  "tools": {
    "maxResultChars": 8000,
    "maxConcurrency": 4,
    "toolTimeoutMs": 30000
  },
  "sandbox": {
    "networkAllowlist": ["localhost:1234", "*:443"]
  },
  "resource": {
    "probeCacheMs": 2000,
    "minSubagentMemMB": 2048,
    "maxSubagents": 2,
    "lowMemoryRetryAfterMs": 5000,
    "busyGpuRetryAfterMs": 10000
  },
  "telemetry": {
    "laminarApiKey": "lmnr_...",
    "laminarEndpoint": "https://api.lmnr.ai",
    "serviceName": "ppagent"
  }
}
```

逐字段对照表（“默认值”一栏留空表示不配就是完全不传，不是某个隐含的空值；“CLI”留空表示该项
目前只能通过配置文件或环境变量设置）：

| 字段 | 默认值 | 环境变量 | CLI flag | 说明 |
| --- | --- | --- | --- | --- |
| `provider.id` | `faux` | `PPAGENT_PROVIDER` | `--provider` | `faux`\|`anthropic`\|`openai`\|`custom`\|`lmstudio`\|`llamacpp` |
| `provider.model` |  | `PPAGENT_MODEL` | `--model` | |
| `provider.baseUrl` | lmstudio/llamacpp 有内置默认值；custom 必填 | `PPAGENT_CUSTOM_BASE_URL` |  | 仅 custom/lmstudio/llamacpp 生效 |
| `provider.apiKey` |  | `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`PPAGENT_CUSTOM_API_KEY`（按 provider 分域） |  | |
| `provider.maxOutputTokens` |  | `PPAGENT_MAX_OUTPUT_TOKENS` | `--max-output-tokens` | 转发为每次请求的 `StreamOptions.maxTokens` |
| `provider.effort` |  | `PPAGENT_EFFORT` | `--effort` | `low`\|`medium`\|`high`\|`xhigh`\|`max` |
| `provider.requestTimeoutMs` |  | `PPAGENT_REQUEST_TIMEOUT_MS` | `--request-timeout-ms` | 单次模型 HTTP 请求超时，转发给 pi-ai/SDK |
| `provider.maxRetries` |  | `PPAGENT_MAX_RETRIES` | `--max-retries` | 转发给 pi-ai 的客户端重试次数，0 表示关闭 |
| `loop.maxTurns` | `60` | `PPAGENT_MAX_TURNS` | `--max-turns` | |
| `loop.turnTimeoutMs` | `1200000`（20 分钟） | `PPAGENT_TURN_TIMEOUT_MS` | `--turn-timeout-ms` | 整轮编排超时，含工具执行；见下方两种超时的区分 |
| `loop.maxLengthContinuations` | `2` | `PPAGENT_MAX_LENGTH_CONTINUATIONS` | `--max-length-continuations` | 模型输出触达 token 上限时自动续写的次数上限 |
| `context.compactThreshold` | `0.8` | `PPAGENT_COMPACT_THRESHOLD` |  | 触发上下文压缩的占用比例 (0,1] |
| `context.memPressureThreshold` | `0.75` | `PPAGENT_MEM_PRESSURE_THRESHOLD` |  | 内存压力触发压缩的阈值 (0,1] |
| `context.keepRecentMessages` | `6` | `PPAGENT_KEEP_RECENT_MESSAGES` |  | 压缩时保留的最近消息数 |
| `context.contextWindow` | 用模型声明的窗口 | `PPAGENT_MAX_TOKENS` | `--max-tokens` | 覆盖模型自带的上下文窗口大小 |
| `context.summaryTargetRatio` | `0.4` | `PPAGENT_SUMMARY_TARGET_RATIO` |  | 压缩摘要的目标 token 占比 (0,1] |
| `context.tokenizer` |  | `PPAGENT_TOKENIZER` |  | 本地 tokenizer 目录或 Hugging Face repo id |
| `context.tokenizerLocalOnly` | `true` | `PPAGENT_TOKENIZER_LOCAL_ONLY` |  | 关闭后才允许联网下载 tokenizer |
| `context.tokenizerTimeoutMs` | `30000` | `PPAGENT_TOKENIZER_TIMEOUT_MS` |  | |
| `tools.maxResultChars` | `8000` | `PPAGENT_MAX_RESULT_CHARS` |  | 工具结果超过此长度即截断 |
| `tools.maxConcurrency` | `4` | `PPAGENT_MAX_TOOL_CONCURRENCY` |  | 并发执行工具的上限 |
| `tools.toolTimeoutMs` | `30000` | `PPAGENT_TOOL_TIMEOUT_MS` |  | |
| `sandbox.networkAllowlist` | `[]` | `PPAGENT_SANDBOX_NETWORK_ALLOWLIST`（逗号分隔） |  | macOS `sandbox-exec` 的出站白名单 |
| `resource.probeCacheMs` | `2000` | `PPAGENT_RESOURCE_CACHE_MS` |  | 资源探针缓存时长 |
| `resource.minSubagentMemMB` | `2048` | `PPAGENT_MIN_SUBAGENT_MEM_MB` |  | 低于此可用内存拒绝派生子 agent |
| `resource.maxSubagents` | `2` | `PPAGENT_MAX_SUBAGENTS` |  | |
| `resource.lowMemoryRetryAfterMs` | `5000` | `PPAGENT_LOW_MEMORY_RETRY_MS` |  | |
| `resource.busyGpuRetryAfterMs` | `10000` | `PPAGENT_BUSY_GPU_RETRY_MS` |  | |
| `telemetry.laminarApiKey` |  | `LMNR_PROJECT_API_KEY` |  | 注意不带 `PPAGENT_` 前缀 |
| `telemetry.laminarEndpoint` | `https://api.lmnr.ai` | `PPAGENT_LAMINAR_ENDPOINT` |  | |
| `telemetry.serviceName` | `ppagent` | `PPAGENT_TELEMETRY_SERVICE_NAME` |  | |

`--session`/`--resume`/`--trace`/`--json`/`--tui`/`--permission-mode`/`--config` 是纯 CLI 运行参数，不属于上面这份可持久化的配置 schema，不会被写进 global/project/project.local 里。

**两种超时不要混淆**：`loop.turnTimeoutMs`（默认 1200000ms，即 20 分钟，覆盖一次模型生成 +
一次工具执行批次各自的常见耗时量级）是 ppagent 自己的整轮编排超时，
包住模型生成 + 后续工具执行；`provider.requestTimeoutMs` 是转发给 pi-ai/底层 SDK 的单次模型
HTTP 请求超时（不配置时用 SDK 自己的默认值，通常 10 分钟）。本地跑较慢的模型（比如 lmstudio/
llamacpp 的大模型）经常先撞到前者——报错是 `Agent turn N timed out after ... ms`，这种情况下
调大 `--turn-timeout-ms`/`PPAGENT_TURN_TIMEOUT_MS`（或配置文件里的 `loop.turnTimeoutMs`），
而不是 `--request-timeout-ms`/`PPAGENT_REQUEST_TIMEOUT_MS`——后者只影响单次 HTTP 请求的
客户端超时，不影响整轮编排预算，对这种"模型确实还在生成、只是比较慢"的场景没有帮助。
`provider.maxRetries` 同理转发给 pi-ai 的客户端重试次数（0 表示关闭重试），不配置时用 SDK
默认值（通常 2 次）。

配置的文件、环境变量和命令行解析只发生在 `agent/` 装配层；`core/` 不读取这些外部来源。
特权工具使用真实人工确认策略，非交互环境会明确记录后自动拒绝。macOS 默认使用
`sandbox-exec`：只允许向工作目录和临时目录写入，系统目录不可写，网络默认禁止。
需要联网的工具可通过逗号分隔的白名单显式开放，例如：

```bash
PPAGENT_SANDBOX_NETWORK_ALLOWLIST='localhost:1234,*:443' \
  node bin/agent.js "运行需要联网的构建"
```

### 验证上下文压缩与恢复

```bash
node bin/agent.js --session s1 "任务A"
node bin/agent.js --session s1 --resume "继续上一步"
node bin/agent.js --session compact-demo --max-tokens 2000 "一个长任务"
```

会话以 append-only JSONL 保存在当前工作目录的 `.ppagent/sessions/`。`--resume` 默认使用
最近一次压缩后的投影；压缩前的原始消息仍保留在 JSONL 中。`--max-tokens` 是 M5 的上下文
窗口验收覆盖值，便于在短任务里触发 `[context:compacted]` 事件。

### 验证 tracing 与取消

```bash
node bin/agent.js --trace "读取 package.json"
node bin/agent.js --trace "跑 sleep 300"   # 输入 y 允许命令，工具开始后按 Ctrl+C
ps -ax -o pid,ppid,pgid,command | grep 'sleep 300'
```

`--trace` 在 stderr 输出 `agent.loop → agent.turn → context.compact / model.stream /
tool.execute` 层级及耗时。取消验收的 faux 分支会执行一个包含后台孙进程的
`sleep 300 & sleep 300`；Ctrl+C 后整个进程组都应消失。

设置 `LMNR_PROJECT_API_KEY` 后，同一批 span 还会通过 OTLP/HTTP JSON 发送到 Laminar；
`PPAGENT_LAMINAR_ENDPOINT` 和 `PPAGENT_TELEMETRY_SERVICE_NAME` 可覆盖 endpoint 与 service。

### 验证资源准入

`spawn_subagent` 在真正启动子 session 前读取带 2 秒缓存的资源快照。下面用不可能满足的
内存阈值稳定复现拒绝；模型会收到两个带原因的工具结果并回退到串行策略：

```bash
PPAGENT_MIN_SUBAGENT_MEM_MB=999999999 \
  node bin/agent.js --json "并行分析两个独立任务"
```

### 验证本地 OpenAI-compatible 服务

`PPAGENT_CUSTOM_BASE_URL` 必须是完整的 API 根地址；LM Studio 和
llama.cpp 通常需要以 `/v1` 结尾。没有认证的本地服务不需要设置 API key：

```bash
PPAGENT_CUSTOM_BASE_URL=http://localhost:11434/v1 \
  node bin/agent.js --smoke --provider custom --model <model-id>

PPAGENT_CUSTOM_BASE_URL=http://localhost:11434/v1 \
  node bin/agent.js --provider custom --model <model-id> \
  "读取 package.json 并告诉我依赖了哪些包"

# LM Studio / llama.cpp 别名提供默认的 localhost:1234/v1 与 localhost:8080/v1
node bin/agent.js --provider lmstudio --model qwen3.6-27b "读取 package.json"

# 在投入 agent loop 前验证 endpoint/model/chat-template 的原生工具调用协议
node bin/agent.js --check-compat --provider lmstudio --model qwen3.6-27b
```

本地模型按模型 ID 选择 tokenizer。`qwen3.6-27b` 会推断出
`Qwen/Qwen3.6-27B`，但默认 `PPAGENT_TOKENIZER_LOCAL_ONLY=true`：agent 不会因为运行本地模型而
隐式访问外网。推荐把 `PPAGENT_TOKENIZER` 指向包含 `tokenizer.json`、
`tokenizer_config.json` 的本地目录。未找到本地词表时会明确降级为 approximate，而不会把 o200k
计数伪装成本地模型的精确 token 数。

确实需要从 Hugging Face repo 下载时必须显式开启，并受超时限制：

```bash
PPAGENT_TOKENIZER=Qwen/Qwen3.6-27B \
PPAGENT_TOKENIZER_LOCAL_ONLY=false \
PPAGENT_TOKENIZER_TIMEOUT_MS=30000 \
  node bin/agent.js --provider lmstudio --model qwen3.6-27b "读取 package.json"
```

只有服务端启用了认证时才设置 `PPAGENT_CUSTOM_API_KEY`。custom provider 不会读取
`OPENAI_API_KEY`，避免把真实 OpenAI key 发送给本地服务。

PPAgent 只支持具备 OpenAI-compatible 原生 tool calling 能力的模型，不提供把工具调用
编码进普通文本的 prompted 降级路径。这个能力也取决于服务端使用的 chat template；
配置 custom endpoint 即表示它满足该前提。M4 会拦截可识别的文本化工具调用；M11 的
`--check-compat` 会主动要求服务端产生一次原生工具调用，并校验流事件、终态 call id 与参数。

### Harbor / Terminal-Bench

Harbor installed-agent 适配器位于 `benchmark/harbor/ppagent.py`，固定消费 NDJSON UIEvent，
并把 token、admission、compact 与 loop 原因写回结果元数据。完整命令、本地 worktree 挂载和
与内置 `pi` agent 使用相同模型/任务的对照方式见
[benchmark/harbor/README.md](benchmark/harbor/README.md)。自动评测仅应在隔离容器中显式使用
`--permission-mode allow`；普通 CLI 的默认权限策略没有改变。

## 设计文档

- [Agent 开发设计书](docs/agent-%E5%BC%80%E5%8F%91%E8%AE%BE%E8%AE%A1%E4%B9%A6.md)

## License

ISC
