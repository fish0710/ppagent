# ppagent 开发错题本 · M0–M5

### 1.1 Message 用类继承而非判别联合

**根因**：对消息这类东西，判别联合（discriminated union）优于继承，有三个实打实的理由：

1. **穷尽性检查**：新增消息类型时所有 `switch` 立刻编译报错。继承做不到——漏处理一个子类，运行时才炸
2. **可序列化**：要落 JSONL 并恢复，`JSON.parse` 回来的是普通对象不是实例，方法全丢、`instanceof` 全假
3. **消息本身无行为**，处理逻辑都在外部函数里

**写法**：

```ts
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// 穷尽性检查的落点
default: { const _x: never = m; return _x; }
```

---

### 1.2 SystemPrompt 不是 Message

**根因**：生命周期完全不同——**永不参与 compact**、**不进 append-only 消息流**、主流 API 里是独立字段。

**代价**：当成 Message 子类要在 compact、store、token 计账三处特判。三处特判换省一个字段。

**修法**：`Context.systemPrompt?: string`

---

### 1.3Memory 继承 Message

| | Message | Memory |
|---|---|---|
| 范围 | 单 session 内 | 跨 session |
| 写入 | append-only | 可更新可删除 |
| 命运 | 会被 compact 掉 | 必须存活 |
| 用法 | 全量发给模型 | 按需检索注入 |

继承意味着 memory 会被当对话历史发出去、会被 compact 干掉——正好抵消它存在的意义。

**附带教训**：Memory 不在 M0–M11 路线图里，M1 定它就是定一个没人实现、还占位置的类型。**不在路线图上的东西不要提前定类型**——等真做时它长得跟现在猜的多半不一样。

---

### 1.4 ToolCall 与 ToolResult 的不对称是真实的

**错误直觉**：把两者对称地设计成两个 Message 子类。

**真实边界**：

- **工具调用是 assistant 消息里的 ContentBlock**——模型一次生成可以同时输出文本和多个工具调用，共享同一个 usage 和 stopReason。拆成独立消息会丢掉归属关系，回传 API 时还要重新合并
- **工具结果是独立 Message**——由 harness 产生，作为下一轮输入

这个不对称是协议本身的形状，不是设计缺陷。


### 1.5 compact 语义演化中的坑

| 坑 | 说明 |
|---|---|
| `replacedFrom/To` 在二次压缩时语义未定 | 覆盖式还是链式？两种都自洽，混用就出错。最终选**覆盖式**（内存视图 = 最近一条摘要及之后的消息），一举消掉区间不变量 |
| 一趟线性扫描 replay 会出错 | compaction 记录的 `seq` **大于**它替换区间的末尾，正向扫描会先把被替换的消息推进结果。改用覆盖式后此问题消失（从后往前找最后一条 compaction 即可）|
| 摘要必须累积 | 覆盖式下旧摘要会被丢弃，新摘要必须涵盖它概括的全部历史。违反则**静默丢失早期历史**，症状是 agent 突然忘记任务目标 |
| 压缩边界不得切断 toolCall/toolResult 配对 | compact 在调模型前触发，此刻末尾常是 toolResult。切错会产生**没有前置 toolCall 的孤儿 toolResult**，OpenAI 兼容服务反应从 400 到静默乱答都有 |
| 摘要用哪个 role | 建议 **UserMessage**。覆盖式压缩后摘要是首条，Anthropic API 要求首条为 user；语义上也更准——摘要不是模型说过的话，是 harness 塞的背景材料 |

---

### 1.6 bash 孤儿进程（模式 5）✅ M3 已修

**现象**：实测复现——

```
sh pid = 963
已按 bash.ts 的方式发送 SIGTERM
---PS---
  967     1 sleep 120      ← PPID=1，被 init 收养，继续跑
  968     1 sleep 120
```

**根因**：`spawn()` 没有 `detached: true`，`child.kill('SIGTERM')` 只杀直接子进程（`/bin/sh`），孙子进程不受影响。

**为什么对 coding agent 是必然场景**：模型会跑 `npm run dev &`、`docker compose up -d`。用户 Ctrl+C 后进程全留着，跑十次攒十个僵尸服务，端口被占，下次任务失败原因完全查不到。

**修法**：

```ts
const child = spawn(command, args, {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,                        // ← 成为新进程组组长
});

const onAbort = () => {
  if (settled) return;
  settled = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  const t = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }, 250);
  t.unref();
};
```

两个注意点：

- `-child.pid`（负数）表示「杀整个进程组」
- `detached: true` 后**不要** `unref()`——需要保持引用来收集 stdout，靠 `close` 事件正常回收
- `process.kill` 在进程已退出时抛 ESRCH，必须包 try

**自检**：

```bash
node bin/agent.js "跑 sleep 300"   # Ctrl+C 后
ps -eo pid,ppid,args | grep sleep  # 应无残留
```

---

### 5.1 partial JSON 不能偷读终态参数

**风险**：provider 的 `toolcall_delta` 可能把参数 JSON 切成几十片。loop 如果只读取
`toolcall_end.call.arguments`，测试看似通过，实际上没有验证流式参数拼接；换一个终态对象不完整的
兼容服务就会执行错误参数。

**修法**：按 `index` 建工具调用槽位，逐片追加原始字符串，仅在 `toolcall_end` 时执行一次
`JSON.parse`；解析失败保留 raw string，继续交给 M3 schema 校验作为 `isError: true` 的工具结果。
测试故意把终态 arguments 改错，并用 `argumentChunkSize: 1` 切出 20 片以上，确保真正使用增量结果。

---

### 5.2 原生工具调用契约需要运行时第二道防线

**风险**：custom endpoint 的 tool calling 能力取决于 model 与服务端 chat template 的组合，
类型层的 `supportsNativeToolCalling: true` 只是调用方断言。失败时模型可能把工具调用作为普通文本输出，
loop 随后把它误判为任务完成，形成静默降级。

**修法**：仅当本轮确实提供了 tools、模型以 `stop` 结束且没有原生 toolCall 时做保守诊断：

- 正文出现 `<tool_call>` 包装时明确报配置错误；
- 正文整体是顶层 JSON，且 `name` 命中本轮注册工具并带 `arguments` 时明确报错；
- 普通正文里只是举例包含 JSON 不报错，避免把“不需要工具”误判为“不支持工具”。

这不是能力探测；endpoint/model/chat-template 的真实兼容性验证仍归 M11。

---

### 5.3 compact 的五个不变量

1. `keepRecentMessages` 是候选起点，不是最终切点；必须向前找到不切断 toolCall/toolResult 配对的边界。
2. 覆盖式 compaction 下，旧摘要会退出内存视图；新摘要必须显式接收并累积 `previousSummary`，否则会静默忘记最早任务目标。
3. replay 不能正向边读边替换。`compacted` 投影应从后向前找最后一条 compaction，`full` 投影只取全部 message；两者都是纯函数。
4. 摘要放在压缩后上下文首位，使用 UserMessage，避免伪装成模型输出，也兼容要求首条为 user 的 provider。
5. 达到阈值不等于压缩一定有收益。安全边界前历史太短时，摘要头可能比原文更大；`tokensAfter >= tokensBefore` 时必须保留原视图，等待历史继续积累。

M5 用安全边界、连续两次压缩、两种 replay 投影和无收益压缩场景分别守住这些约束。

---
