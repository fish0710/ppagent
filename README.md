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
- 其余里程碑见[在线介绍页](https://fish0710.github.io/ppagent/#roadmap)

目前已有可供脚本调用的 M8 CLI，但还没有可安装的发行版本；macOS 系统沙箱和真实资源
探针仍属于后续里程碑。

## 本地开发

需要 Node.js 22。

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

配置按“内置默认值 < JSON 文件 < 环境变量 < CLI flag”合并：

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

配置的文件、环境变量和命令行解析只发生在 `agent/` 装配层；`core/` 不读取这些外部来源。
特权工具使用真实人工确认策略，非交互环境会明确记录后自动拒绝。当前
`PassthroughSandbox` 仍是 M9 之前的沙箱桩，因此确认允许的命令只应在可信工作目录中执行。

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

### 验证本地 OpenAI-compatible 服务

`PPAGENT_CUSTOM_BASE_URL` 必须是完整的 API 根地址；LM Studio 和
llama.cpp 通常需要以 `/v1` 结尾。没有认证的本地服务不需要设置 API key：

```bash
PPAGENT_CUSTOM_BASE_URL=http://localhost:11434/v1 \
  node bin/agent.js --smoke --provider custom --model <model-id>

PPAGENT_CUSTOM_BASE_URL=http://localhost:11434/v1 \
  node bin/agent.js --provider custom --model <model-id> \
  "读取 package.json 并告诉我依赖了哪些包"
```

第二条是当前开发验收路径，使用真实人工确认策略和 `PassthroughSandbox`；只应在可信
提示词与可控工作目录中运行。系统级沙箱在 M9 落地。

只有服务端启用了认证时才设置 `PPAGENT_CUSTOM_API_KEY`。custom provider 不会读取
`OPENAI_API_KEY`，避免把真实 OpenAI key 发送给本地服务。

PPAgent 只支持具备 OpenAI-compatible 原生 tool calling 能力的模型，不提供把工具调用
编码进普通文本的 prompted 降级路径。这个能力也取决于服务端使用的 chat template；
配置 custom endpoint 即表示它满足该前提。M4 已对可识别的文本化工具调用给出明确诊断，
M11 再按 endpoint、model 和 chat template 做兼容性验证。

## 设计文档

- [Agent 开发设计书](docs/agent-%E5%BC%80%E5%8F%91%E8%AE%BE%E8%AE%A1%E4%B9%A6.md)

## License

ISC
