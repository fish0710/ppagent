# ppagent 开发错题本 · M0–M8

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

### 5.3 compact 的八个不变量

1. token 预算给出候选切点，不是最终切点；必须向前找到不切断 toolCall/toolResult 配对的边界。切点用 token 预算而非消息条数 —— 6 条消息可能是 300 token 的闲聊，也可能是 40k token 的文件读取，条数控不住压缩后的实际体积。
2. 覆盖式 compaction 下，旧摘要会退出内存视图；新摘要必须显式接收并累积 `previousSummary`，否则会静默忘记最早任务目标。
3. replay 不能正向边读边替换。`compacted` 投影应从后向前找最后一条 compaction，`full` 投影只取全部 message；两者都是纯函数。
4. 摘要放在压缩后上下文首位，使用 UserMessage，避免伪装成模型输出，也兼容要求首条为 user 的 provider。
5. 达到阈值不等于压缩一定有收益。安全边界前历史太短时，摘要头可能比原文更大；`tokensAfter >= tokensBefore` 时必须保留原视图，等待历史继续积累。
6. **累积必须靠重写，不能靠拼接**。把旧摘要原样嵌进新摘要，摘要会逐次递归增长，最终吃光整个预算、把新历史挤成一堆省略标记 —— 压缩退化成纯粹的信息销毁。LLM 策略让模型看到旧摘要并明确要求"改写它、不要嵌套引用"，长度由生成上限硬约束；规则兜底策略给旧摘要限额一半预算。
7. **摘要请求的前缀必须与实活上下文逐字节相同**。本地推理服务的前缀缓存是在渲染并 tokenize 之后的 prompt 上做最长公共前缀匹配，chat template 把 tools 渲染进 system 段 —— 少传一份 tools、改一条消息、换个顺序，prompt 从很靠前的位置起就不同，整段 KV 缓存作废，摘要调用退化成一次全量 prefill。因此 `[previousSummary?, ...messages, ...retained]` 必须能拼回原数组，剪枝结果不能喂给摘要请求，摘要也不能走 `runReactTurn`（其文本工具调用诊断会把摘要正文里的 JSON 误判成配置错误）。
8. **内存视图与 `compacted` 投影之间只允许一种方向的偏差：投影只能比内存视图更完整，绝不能更少，且任何差异都必须是确定性纯函数、能从磁盘原文重建的。** 起初的表述是"两者必须逐字节一致"——但这从一开始就不对：`kind: 'prune'` 的压缩结果不落盘（它是磁盘原文上的确定性纯函数变换，`--resume` 后重跑一遍结果完全一致），所以 replay 投影天然可能比压缩后的内存视图更"胖"（看到未剪枝的原文），这是良性的、方向正确的差异。真正的 bug 是相反方向：compaction 记录写在保留消息都写盘之后，那批保留消息的 seq 比它小；按记录位置切会把它们全丢掉，症状是保持会话一切正常、一 `--resume` 就少了最近几轮，且不报错。必须记 `firstKeptSeq` 并按 seq 过滤，把"更少"这个方向堵死；"更多"这个方向不需要堵，因为它只是把剪枝还没来得及做的事重新做一遍。

推论：压缩后第一次真实请求的前缀首条就换成了摘要，**必然全量重新 prefill**。任何头部替换式压缩都有这个成本（Claude Code / Codex / OpenCode 同样），所以压缩要少而深 —— 默认 0.8 触发、降到 0.3，留出半个窗口的余量再触发下一次。

剪枝层（`core/context/prune.ts`）与摘要层在切点**之前**的那段历史上是**备选关系而不是流水线**：摘要反正要丢弃那段，先剪一遍纯属白做，还会因为改动历史中段让摘要请求错过前缀缓存。剪枝够了就不调模型 —— 全部消息的结构、顺序和 toolCall 轨迹都还在，只是老工具输出降了保真度，比丢给模型重述一遍损失更小。但切点**之后**保留的尾巴不受这条限制：摘要调用结束后，前缀缓存的窗口已经关闭（下一次真实请求反正要因为摘要换头而全量重新 prefill），这时候再剪一遍保留尾巴不会多付任何缓存代价，纯粹是白捡的收益——摘要调用本身必须用 pristine 的 `retained`（模型看到的和上一次真实请求逐字节相同），但拼进最终 `CompactResult.messages` 的可以是剪过的版本。

剪枝的保护窗口独立于压缩切点且通常更小。若剪枝也止步于切点，一条单条就撑爆保留预算的巨型工具输出会把切点顶到它前面，于是谁都碰不到它，压缩白做。同理，保护窗口的判定要放在累加**之后** —— 放在之前的话，一条 40k token 的读取会因为它后面那条 10 token 的消息还没填满窗口而整条受保护，而它恰恰是最该剪的那条。

失败必须降级而不是上抛：本地服务掉线、模型不守 TEXT ONLY、生成超时都是常态，代价应该是摘要质量下降，而不是任务中断。只有用户主动取消才原样抛出 —— 降级会让 Ctrl+C 之后还继续跑一段活。

`compact_start` 之后必须有收尾事件（`compacted` 或 `compact_skipped`），否则界面永远停在压缩相位。

---

### 5.5 二期：把"信任模型"的面积压到最小时踩的坑

**风险**：一期的摘要让所有跨压缩存活的信息都经过模型转述——文件路径、用户约束、早期决策，
压一次转述一次，转述失真了没人发现。原则改成"凡是结构里已经有的就不问模型"之后，具体实现
里有几个不直观的地方。

**`keptUserIndices` 传的是"这一轮结束后应该存活的全集"，不是"新增的那部分"**。第一次写
`CompactionSequenceTracker` 的回归测试时，想当然地只传了这一轮新折叠进来、被选中保留的
user 消息下标，结果 `keptUserSeqs` 算出来的值只有新增那条、丢了上一轮就保留下来的。正确
语义：`keptUserIndices` 是"当前视图"里、最终要出现在 `newCarried` 里的**全部**下标，
包括上一轮 budget 允许继续保留的那些，也包括这一轮新提拔进来的。`selectCarriedUsers` 的
产出天然满足这个语义（它对 `[previousCarried, ...newlyFoldedUsers]` 一起做预算裁剪），
调用方只要如实传递整个结果的下标就行，不需要也不能自己去区分"哪些是新的"。

**切点搜索的 `minCut` 必须从"事后校验"升级成"搜索硬地板"**。一期里 `minCut` 只在算出
候选切点之后拿来判断"是不是有实质进展"（`cut > minCut` 才采纳）；`alignToTurnStart` /
`searchSafeBoundary` 本身可以自由走到数组开头。二期头部保护区（摘要 + 保留的 user 块）
可能有好几条消息，如果搜索函数仍然能自由穿过它，很容易在保护区内部找到一个"看起来安全"
的边界并采纳——保护区全是 user 消息，天然满足"cut 落在 user 消息上"和"没有 toolResult
跨界"这两条安全性检查，不会报错，只会**静默**把保护区里的某条消息当成新一轮 retained
的起点，导致它被"保留"两次、后面的历史几乎折叠不动。修法是把 `minCut` 变成搜索函数的
硬性下界参数，两个函数都不允许返回小于它的值。

**StructuralSummarizer 只在 `targetTokens` 真正逼出截断时才会变小**——它不做语义压缩，
只是把消息拍平重排。如果 `toSummarize`（这一轮要折叠的历史）在提取出 user 消息之后剩下的
非 user 内容很少，且 `targetTokens` 给得宽松，`StructuralSummarizer` 产出的"摘要"体积会
接近甚至超过原文（多了 "Compacted conversation history:\n" 之类的固定开销），加上被
`carried` 原样保留的那部分，`tokensAfter >= tokensBefore` 触发 `IneffectiveCompactionError`
是正确行为，不是 bug——真正该做的是让 `toSummarize` 里有实质性的非 user 内容需要折叠
（真实会话里几乎总是如此，工具输出和模型回复才是历史体积的大头），测试 fixture 手写纯
user 消息序列时容易踩到这个边界情况。

**约束/决策的"搬运 + 追加"依赖旧摘要能被解析**。旧摘要不一定是 `LlmSummarizer` 自己产出
的——上一轮如果降级过，`previousSummary` 可能是 `StructuralSummarizer` 的"Compacted
conversation history:\n..." 格式，没有 `## ` 标题也没有 `<compacted-session-summary>`
包装。`agent/summarize/sections.ts` 的 `parseSummarySections` 对此的处理是"整段原文当
`earlierContext`"，不猜哪部分是约束哪部分是决策——猜错了比不猜的代价更高（可能把一句
"已完成" 误判成"约束"，永久锁死一条错误信息）。

---

### 5.4 “只读使用”必须成为类型契约

**风险**：getter 返回内部 `Context` 直接引用却仍声明成可写类型时，调用方可以绕过
`ContextManager.append/compact` 直接 `push/splice`。这样 `messages[0]` 与
`previousSummary` 可能在远离错误源的下一次压缩才报不一致。

**修法**：区分内部可写 `Context` 和对外 `ReadonlyContext`。`ContextManager.context`、
`Provider.stream`、React turn 与 token counter 的读取边界全部接收只读视图；loop 结束时通过
`snapshot()` 返回独立结果。`previousSummary` 同样返回副本，避免另一条引用泄漏路径。

这是编译期安全边界，不是对不可信 JavaScript 插件的运行时隔离；后者若进入支持范围，需要再加冻结或结构化克隆。

---

### 6.1 span 的完成顺序不是树的展示顺序

**风险**：子 span 总是在父 span 之前结束。如果 console exporter 收到一个就立即按当前状态打印，
此时还不知道父节点是否稍后到达，最终只能得到扁平日志或错误缩进。

**修法**：`export()` 只缓冲完整 span，`flush()` 再按 `parentSpanId` 建树并排序输出。所有正常、
错误和取消出口由幂等 `ActiveSpan.end()` 收口；exporter 自身抛错必须被隔离，不能把成功任务改成失败。

旁路约束同时覆盖异步 `flush()`：用 `flushSpanExporter()` 吞掉网络型 exporter 的发送失败，
且 SIGINT listener 等主流程清理必须先执行。否则 finally 中的 flush 异常会覆盖原始任务异常，
还会让排在它后面的清理逻辑永久跳过。

Span 不复用 UIEvent，也不记录提示词、工具参数和输出正文。UIEvent 保证实时、完整、有序；Span
允许缓冲和采样，只保存诊断所需的受控结构化元数据。

---

### 6.2 取消必须验进程组，不能只验 Promise 返回

**风险**：工具结果显示 `Tool execution aborted.` 只证明 JavaScript Promise 已返回，不证明 shell
启动的孙进程已经退出。后台服务仍可能被 PID 1 收养并继续占用端口。

**修法**：单元测试记录后台子进程 PID；端到端再运行 `sleep 300 & sleep 300`，取消前用 `ps`
确认 shell 和两个 sleep 共享独立 PGID，Ctrl+C 后按原 PID 逐一确认不存在。

---

### 7.1 配置解析不能渗进 core

**风险**：让 provider、loop 或工具在执行时直接读取环境变量/配置文件，测试会依赖宿主机状态，
同一个 core 组件也无法被 CLI、TUI、RPC 用不同配置复用。

**修法**：`agent/config/` 负责文件、环境变量、CLI flag 的解析与优先级合并，输出普通对象；
`AgentSession` 再把各段值作为构造参数注入 core。dependency-cruiser 持续禁止 `core → agent/app`
反向依赖。custom 的 endpoint 和 key 使用 `PPAGENT_CUSTOM_*` 独立命名，切换 provider 不会误发
OpenAI 凭证。合并时 provider id 发生变化还必须清空上一配置域的 model/endpoint/credential，
不能用普通的逐字段深合并让旧 key 残留。

### 7.2 人工拒绝也是模型可观察的工具结果

**风险**：应用层弹框后直接抛异常或终止 loop，模型不知道动作为什么没发生，也无法改用只读、
询问用户或放弃修改等策略。

**修法**：权限策略只通过注入的 `Interaction.confirm()` 取得决定；拒绝在工具执行层转换成
`toolResult(isError: true)`，保留 `toolCallId/toolName` 后加入上下文。`AgentSession` 额外发出
`permission_request` / `permission_resolved` UIEvent，UI 展示与模型消息流各自完整。确认摘要使用
`Tool.describe(args)`，bash 首行直接显示具体命令，完整参数留在 detail。

CLI 的 readline 只在一次问答期间存活，回答后立即关闭。否则 terminal 模式会继续接管 Ctrl+C，
进程级 SIGINT handler 收不到取消信号，长工具只能等自己的 timeout；这会破坏 M6 已打通的取消链。

---

### 8.1 JSONL 的 stdout 必须是纯协议通道

**风险**：把工具进度文本、trace 或结尾换行提示混进 JSON stdout，Harbor 这类调用方会在
解析某一行时随机失败。只保证“主要结果是 JSON”不够，必须保证每个非空 stdout 行都可独立解析。

**修法**：print 与 JSON 使用两个 renderer。JSON renderer 对每个 UIEvent 只执行一次序列化并
追加换行；trace 和非事件诊断只写 stderr。权限自动拒绝说明属于 `notify` UIEvent：JSON 模式写
stdout，print 模式写 stderr。JSONL 不额外套 envelope，直接保持 UIEvent 的判别联合形状，
`type` 是消费方的稳定分流字段。

### 8.2 非交互拒绝是预期策略，不是异常兜底

**风险**：依赖 TTY/连接异常触发 PermissionPolicy 的 catch 虽然安全，但日志语义会显示成故障，
benchmark 也无法区分“策略拒绝”和“交互设施坏了”。

**修法**：管道输入和 JSON 模式显式选择 `NonInteractiveInteraction`。`confirm` 主动返回 false，
同时 notify warn，说明自动拒绝的具体命令。模型仍通过 `toolResult(isError: true)` 得知拒绝；
JSON 消费方仅靠 stdout 就能看到 permission、notify 和 tool 事件，print 模式则把 warn 留在 stderr。

### 8.3 循环检测必须只看当前祖先路径

**风险**：序列化时只增不减的 WeakSet 会把“两个兄弟字段共享同一个对象”误判为循环引用，导致
第二处被替换成 `[Circular]`，改变工具参数的含义。

**修法**：维护当前 JSON 访问路径的祖先栈。进入兄弟字段前弹出已离开的分支；只有待序列化对象
仍存在于当前祖先路径时才标记 `[Circular]`。测试同时覆盖共享引用和 `obj.self = obj`。

---

### 9.1 路径前缀不是沙箱边界

**风险**：只判断字符串是否以 workspace 开头，会把 `/work/project-evil` 当成子目录；只对目标做
`resolve()` 又会被 workspace 内指向外部的符号链接绕过。bash 若只做命令字符串检查，子进程还能在
运行时构造任意路径和网络请求。

**修法**：路径边界比较必须要求“完全相等或 root + path separator”；对尚未存在的写目标向上寻找
最近存在祖先，`realpath` 后再拼回剩余路径。文件工具做事前判定，bash 则始终进入系统级
`sandbox-exec` profile。`sandbox-exec` 已弃用这一事实必须封装在 `Sandbox` 实现里，不能扩散到工具。

### 10.1 准入检查和槽位预留必须是一个原子动作

**风险**：两个并发 `spawn_subagent` 都先读 `activeSubagents=0`，随后一起通过，实际并发数会超过上限。
仅缓存整个资源快照又会让活跃计数延迟两秒，继续放大超发。

**修法**：用一个异步 gate 串行化“读取快照 → 判断 → `beginSubagent()`”；只有内存等昂贵系统采样
缓存，`activeInference` 和 `activeSubagents` 在返回快照时实时覆盖。执行器用 `finally` 释放预留，
工具校验、沙箱或子 session 任何失败都不能泄漏槽位。

### 11.1 原生工具调用能力属于 endpoint 组合

**风险**：同一个模型权重换一个服务端 chat template，可能从原生 tool call 退化为普通文本。
模型名或 `supportsNativeToolCalling: true` 无法证明运行时协议真的成立。

**修法**：上线前主动下发确定性的兼容性工具，要求服务端返回一个原生调用；同时校验流式 call、
终态 call id、参数 token 和 `toolUse` 停止原因。模型或 chat template 变化后必须重跑探针。

### 11.2 为分词引入推理 runtime 会拖垮评测冷启动

**风险**：`@huggingface/transformers` 能加载 tokenizer，但会连带安装 onnxruntime 等数百 MB 依赖。
Harbor 每个冷容器都付这笔成本，第一次真实 Terminal-Bench smoke 因此触发 setup timeout。

**修法**：换成 Hugging Face 的零依赖 `@huggingface/tokenizers`，只读取
`tokenizer.json` / `tokenizer_config.json`，不安装推理 runtime。显式本地目录加载失败直接报错；
自动推断失败才回退到带 `precision: approximate` 标签的 UTF-8 估算。

### 11.3 Benchmark adapter 必须把安装环境当成发布包环境

**风险**：Harbor 会在另一个 cwd 导入自定义 agent，并把源码复制到没有 `.git` 的容器目录。
依赖当前 cwd 的 Python import、仓库专用 `prepare` hook、把 host `node_modules` 复制进 Linux，都会让
agent 在真正运行前失败。强行 `cd $HOME` 还会让 coding agent 离开 Harbor 的任务目录。

**修法**：启动 Harbor 时显式设置仓库 `PYTHONPATH`；本地挂载只打包源码并排除 `.git/dist/node_modules`，
容器内使用 `npm ci --ignore-scripts` 后显式 build。agent.run 保留 Harbor 设置的 cwd，stdout 只写
NDJSON，stderr 单独保存。适配器 smoke 必须以“进入 verifier、0 Harbor exception”为完成条件，不能只
看 class 能 import 或 setup 命令能启动。

### 11.4 本地模型不能默认产生隐藏网络请求

**风险**：根据模型名推断出 Hugging Face repo 后直接 `fetch(tokenizer.json)`，会让“本地、离线”的
主路径隐式依赖公网；没有 deadline 时，断网还会把 session 创建永久挂起。若下载逻辑留在
`core/context`，配置/环境与纯计数边界也重新耦合。

**修法**：`core` 只负责选择 tokenizer id 和消费注入的 `TokenizerLike`，文件与网络 IO 移到
`agent/tokenizer/`。默认 `tokenizerLocalOnly=true`，本地目录未命中就明确降级 approximate；只有用户
显式设为 false 才允许下载，且共享 AbortController deadline。dependency-cruiser 和源码守卫测试共同
防止文件依赖或裸 `fetch()` 再次进入 core tokenizer。

### 12.1 TUI 不应变成第二个 Agent 状态机

**风险**：TUI 自己保存“当前消息、工具和上下文”的副本，并根据调用顺序猜测运行阶段，会产生与
AgentSession 真实状态不一致的第二事实源。使用 alternate screen 又会吞掉终端 scrollback，让 coding
输出难以回看和复制。

**修法**：phase、工具活动和指标只由 `UIEvent` 经纯 reducer 派生；TUI 不读取 session.context。
已经换行或结束的内容只追加到 transcript，永不修改。渲染使用 pi-tui `TuiMainScreen` 保留 scrollback，
由库处理 main-screen 差分和同步输出，禁止切换 `TuiAltScreen`。NDJSON 直接作为 reducer fixture。

### 12.2 raw mode 下 Ctrl+C 是输入，不是 SIGINT

**风险**：pi-tui `ProcessTerminal` 在 raw mode 下接收到的是 Ctrl+C 按键字节，进程级 SIGINT handler
不会触发；如果只保留旧 CLI 的信号监听，取消永远到不了
`session.abort → toolContext.signal → 进程组 kill`。权限确认的临时监听若不消费按键，还会把 y/n
泄漏给底层 prompt Input。

**修法**：TUI 全程只让 `ProcessTerminal` 管理 raw mode，prompt 使用 pi-tui `Input`。全局 input
listener 用 `matchesKey(ctrl+c)` 实现“首次取消、1.5 秒内再次退出、空闲直接退出”；confirm 安装更窄的
模态 listener，处理 y/n/Ctrl+C 后必须 resolve 并卸载。进程级 SIGINT 只作为外部信号兜底。宽字符、
光标、粘贴、差分和 ANSI 输出交给 pi-tui，项目只保留 UIEvent reducer 与业务文案。

### 12.3 渲染出去的每个数组元素必须是恰好一个物理行

**风险**：pi-tui 的 `Component.render` 契约是「一个数组元素 = 一个物理行」，`TuiMainScreen` 逐元素写
`\x1b[2K` + 内容 + `\r\n`。元素里混进 `\n` 会多写出几个物理行、却只按一行推进光标，此后每一帧都在
错位的行号上做差分——屏幕上表现为不断堆积的残行和被写掉半截的状态栏。它比"某一行显示得难看"严重
一个量级：坏的不是那一行，是整块屏幕。pi-tui 自带的超宽断言拦不住，因为 `visibleWidth()` 把 `\n`
算作 0 宽；`truncateToWidth()` 同样不认换行，长度没超限时原样返回。真实触发路径是未闭合的 ``` 围栏：
`segmentMarkdown` 会把整段代码块留在 `pendingText` 里，而 live 区域曾经把它当一行 push 出去。

**修法**：`toSingleLines()` 作为显式不变量，在三处设防——加 `⎿`/缩进前缀之前先拆（保证续行前缀跟着
走）、`renderBlock()` 出口兜底、交给 pi-tui 之前的 `TuiDocument.render()` 再兜一次。live 区域的
`pendingText` 按 `\n` 拆开并只保留末尾若干行。自检：对每个 block kind 喂带换行的对抗性文本，断言
"无 `\n` 且 `visibleWidth <= width`"，并附一条证明该断言能拒绝坏输入的用例。

### 12.4 权限提示与工具调用是同一件事的两次展示

**风险**：把每次权限决定都提交进 transcript，且用了和工具调用同一个 `⏺`，屏幕上同一条命令会出现
两三次——header 一次、原始参数 JSON 一次、真正的 tool block 再一次。会话级 allowAlways 记忆命中后
不会弹窗，但 `permission_request`/`permission_resolved` 照发，于是每次静默放行都白白多出三行。
`describe()` 已经给出人话摘要时还附 `safeStringify(args)`，对 `write` 意味着整份文件内容进弹窗。

**修法**：`detail` 只在 `describe()` 没能给出摘要时才附（此时摘要退化成通用模板，用户确实需要原始
参数）。allow/deny 不提交 block——结果由紧随其后的 tool block 完整表达，拒绝会变成一条 `isError`
的工具结果。只有 allowAlways 留痕，因为"本会话不再询问"没有别的地方能看见；渲染成不带 `⏺` 的单行
旁注。同理，`segmentMarkdown` 切出的多个 assistant block 属于同一条回复，只有第一段带 `⏺`。

---
