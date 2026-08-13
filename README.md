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
- 其余里程碑见[在线介绍页](https://fish0710.github.io/ppagent/#roadmap)

目前已有可运行的 M4 开发验收入口，但还没有可安装的发行版本；持久化、真实权限策略与
macOS 沙箱仍属于后续里程碑。

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
这个入口用于验证 M4 执行链，不代表最终 CLI；当前权限策略和沙箱仍是可测试的桩实现。

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

第二条是 M4 开发验收路径，目前使用自动放行的权限桩和 `PassthroughSandbox`；只应在可信
提示词与可控工作目录中运行。真实人工确认和系统沙箱分别在 M7、M9 落地。

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
