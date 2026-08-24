# Agent Note: 长期记忆子系统（M12 骨架）

Status: implemented

## Problem

M0–M11 已全部落地，Terminal-Bench 三题标定跑通 3/3；长期记忆是骨架完成后第一个真正新增的能力，此前没有任何形态（错题本 1.3 明确否决过"Memory 继承 Message"这个天真版本，并留下一条元规则：不在路线图上的东西不要提前定类型）。

用户提供了一份基于通用 agent 记忆研究（含 ReasoningBank 式设计）整理的详细方案：四级 scope（session/project/user/global）、loop 级 + 任务级两阶段抽取、embedding 检索、逐轮 `<memory_use>` 表态块采集反馈、晋升与合并流水线。这份方案没有针对本地部署场景做任何取舍，而设计书 §1 明确写死了判据：*"任何一个设计决策，如果对云端大模型和本地小模型的意义是一样的，那它就不是本项目的重点，抄现成方案即可"*。通用长期记忆对云端和本地意义相同，按项目自己的判据它不该直接照搬——需要先回答"哪几处必须和别人不一样"，再决定做多少。

三处本地特有的约束改变了设计形状：本地只有一块 GPU，抽取跑模型时用户任务在等（云端抽取异步、不占算力）；本地推理服务的 KV 前缀缓存靠最长公共前缀匹配，请求头部一变就整段作废（云端 API 用 `cache_control` 显式断点，不敏感）；本地模型的有效上下文远小于标称值，系统提示词是最稀缺的预算（云端窗口大，无所谓）。这三条分别否决了原方案里最贵的三个部件：loop 级抽取、逐轮检索注入、`<memory_use>` 表态块。

## Decision

- `core/types.ts` 新增 §14：`MemoryScope`（`project | user`，无 `global`）、`MemoryKind`（`fact | convention | decision | pitfall`）、`MemoryStatus`（`active | deprecated`，无 `cold`/`probation`）、`MemoryRecord`、`MemoryStore` 接口、`MemoryConfig`。刻意不定 `confidence`/`parentId`/`mergedFrom`/`embedding` 等字段——错题本 1.3 的教训是这些字段真做时多半长得不一样。
- `Store` 接口新增 `get(id): Promise<SessionMeta | undefined>`；`SessionMeta` 新增可选字段 `memoryBlock?: string`。`--resume` 靠它原样复现本次会话最初注入的记忆块，不重新检索——检索输入会随时间变化，重新检索会让 resume 出的 systemPrompt 与原会话不同，前缀缓存从第 0 个 token 起作废。
- `agent/memory/store.ts`：`JsonlMemoryStore`，单文件 `records.json` 整份原子替换（tmp + rename），不用 `core/store/jsonl.ts` 的按行追加形状——记忆可更新可删除，append-only 流不适用。project scope 落 `<cwd>/.ppagent/memory/`，user scope 落 `~/.ppagent/memory/`，各自独立目录、独立 `JsonlMemoryStore` 实例。
- `core/memory/rank.ts`：BM25（idf 在候选集内部算）+ scope 精确过滤 + 槽位配额（project/user/explore）+ MMR 去重，纯函数无 IO。零 ML 依赖，接口与实现分离，换向量检索不动调用方。
- `core/memory/render.ts`：选中记忆 → systemPrompt 文本块，预算不够时从队尾丢弃整条记忆，不做截断；返回值同时报告哪些记忆真的排进了预算（`included`），供曝光计数使用。
- 检索在会话构造前跑一次（`bin/agent.ts` 的 `prepareSession`），结果写进 `Context.systemPrompt`——该字段全项目此前没有任何写入者，且天然"永不参与 compact"，正好满足错题本 1.3 要求的"必须存活"，不用为 compact 写任何特判。
- `agent/memory/extract.ts`：`LlmMemoryExtractor`，会话结束后调一次模型，`temperature: 0`、独立 timeout、`## ` 分段协议（复用 `agent/summarize/sections.ts` 的解析器）、解析不出标题就整体放弃。输入是结构化摘要（原始请求/收尾结论/文件清单/已冻结的约束决策/结果标签），不是原始轨迹。抽取本身永不抛出，任何失败都返回空数组。
- `agent/session.ts` 的 `#extractMemory`：三道门禁，任一不满足直接跳过——没配 `memoryStores`；`loopEndReason === 'aborted'`；`ResourceProbe.snapshot()` 显示 GPU 忙或内存压力已到压缩阈值。
- `core/memory/adopt.ts`：`detectAdoption`，检查记忆文本里的独特标识符（含路径分隔符/点号/下划线/数字）是否出现在会话产出的 assistant 文本或工具调用参数里，纯函数、0 次模型调用。`agent/session.ts` 的 `#trackMemoryUsage` 用它更新 `exposure`/`adopted`/`adoptedOk`/`adoptedBad`，并在 `adopted >= 3 且 adoptedBad/adopted > 0.5` 时立即 `deprecate`（不物理删除，留作抽取质量的负样本）。`'aborted'` 结局只计曝光和采纳，不进 `adoptedOk`/`adoptedBad` 任一边。
- `agent/memory/usage-log.ts`：`MemoryUsageLog` 接口 + `JsonlMemoryUsageLog` 实现，append-only 落 `.ppagent/memory/usage.jsonl`，每次 `prompt()` 一行（`injectedIds`/`adoptedIds`/`loopEndReason`/`turns`）。不走 `core/telemetry/`——span 是旁路语义、可采样可丢弃，这份数据要用来算指标，丢一条就有偏。
- `agent/tools/memory-search.ts`：`memory_search` 工具，惰性检索，阈值比急切检索更低、槽位更多（"急切宁缺毋滥，惰性尽量给"）。默认不注册（`config.memory.searchTool = false`）——工具定义会被 chat template 渲染进 system 段，每次请求都计费，先证明急切检索不够用再开。v1 明确不接曝光/采纳反馈，只覆盖急切检索这一条路径。
- `agent/config/index.ts` 新增 `memory` 段，六处编辑（接口×2、`DEFAULT_CONFIG`、`readAgentConfigFile` 白名单、`mergeAgentConfig`、`validateConfig`）+ 对应环境变量映射。**`config.memory.enabled` 默认 `false`**——基线臂就是今天的行为，逐字节相同，可做干净的 ON/OFF 对照。
- 命名冲突记录：`CompactTrigger = 'token' | 'memory'` 的 `'memory'` 指内存压力（`core/resource`），与本子系统同名。这是既有的局部歧义，本次不改名（改名影响面覆盖 M5 已落地的 compact 触发器，不在本次范围内），新代码统一用 `MemoryRecord`/`MemoryStore`/`MemoryConfig` 等更长的复合名避免歧义。

## Alternatives considered

**四级 scope（含 global）。** 用户原方案里 `global` 代表跨用户共享的团队规范，需要"≥3 个不同 project 才算通用"的晋升证据。ppagent 是单用户单机场景，没有"跨用户"这个语义对象，几个项目也攒不出统计意义上的晋升证据。砍到 `project | user` 两级；真的多用户协作时再加，不提前定。

**向量检索。** 项目零 ML 依赖（只有 tokenizer），错题本 11.2 已经因为评测冷启动代价（`@huggingface/transformers` 拖入 onnxruntime）否决过引入推理 runtime。改用 BM25 + 精确过滤，`MemoryStore`/`rankMemories` 与调用方解耦，接口不因此让步，日后要换随时可以只改实现。

**loop 级抽取（每个 agent loop 结束都抽一次）。** 本地只有一块 GPU，loop 级抽取意味着用户的下一步操作要等抽取模型调用完成，在本地是净亏；云端因为算力独立、异步不影响用户，这条对云端有意义。改成任务级（一次 `prompt()` 结束抽一次）。

**逐轮 `<memory_use>` 表态块采集采纳信号。** 本地小模型连 TEXT ONLY 都守不住结构化契约（`agent/summarize/llm.ts` 为此写了三道防线：`sawToolCall` 检测、空文本检测、`looksLikeTextToolCall` 检测纯文本伪装的工具调用）。再让模型每轮输出一段表态 XML，会重新扩大 M5 二期已经在收窄的"信任模型"面积，还要烧提示词预算、污染可见输出。改成确定性检测：记忆文本的独特标识符是否出现在后续工具调用参数或回复里——跟 `core/context/files.ts` 从 `ToolCallBlock.arguments.path` 挖文件清单是同一个手法，0 次模型参与。代价是有假阳性（模型本来就会用到那个路径），但优先级排序是"宁可信号弱，不要再加一层不可靠的模型自评"。

**LLM-as-judge 判定任务成败（三分类：success/failure/incomplete）。** `AgentLoopResult.reason` 本来就是 `stop | maxTurns | aborted | error` 四态枚举，`aborted` 天然就是原方案要求单独处理的"incomplete"分支，免费拿到，不需要再调一次模型去分类。

**给 `StoreRecord` 加第三个 `kind: 'memory'`。** `core/store/jsonl.ts` 的 `parseRecord` 对未知 `kind` 硬抛，加一个新 arm 会让旧二进制读到新写入的 session 文件时整个 session 报废；而且记忆是可更新可删除的（错题本 1.3），跟 `StoreRecord` 的 append-only 语义本来就不匹配。改用独立的 `MemoryStore` + 独立磁盘目录。

**晋升流水线（project → global）、合并批处理（重复/泛化/冲突四类关系）。** 论文本身把 merging/forgetting 列为 future work，没有现成答案可抄；这套仓库现在的记忆量级也攒不出"≥3 个不同 project"的晋升证据。v1 只做优先级最高的一条状态迁移（反复采纳且经常导向失败 → deprecate），其余等第一批 `usage.jsonl` 数据出来再定，不提前建一套没有数据验证过的机制。

## Consequences

**买到的**：三个可测的主张已经在真实 CLI（faux provider，非模拟）上端到端验证——注入不破坏前缀缓存假设（systemPrompt 只在会话启动写一次、`--resume` 原样复现）、抽取失败会优雅降级而不影响任务结果（`记忆抽取失败，本次会话不产出新记忆` 走 `notify` 事件，不是异常）、采纳闭环真的能跑通（手写记忆 → 检索注入 → 工具调用命中 → `exposure`/`adopted`/`adoptedOk` 正确落盘 → `usage.jsonl` 记录一行）。默认关闭意味着这次改动不影响任何现有行为，基线臂是逐字节相同的旧代码路径。

**付出的**：词法检索 + 首轮 query 信息量少，召回质量注定一般，这是 v1 明确接受的代价。`--resume` 路径不参与曝光/采纳反馈——原始选中的具体记录没有持久化（只存了渲染后的文本），是已知缺口不是遗漏。`memory_search` 工具默认关闭且不接反馈闭环，价值还没有数据支撑。四个核心指标（采纳率、采纳后成功率、步数差、cold 率）里只有前两个可以从 `MemoryRecord` 聚合计数直接算，步数差需要 `usage.jsonl` 按会话切片，cold 率在 v1 完全不可测（`MemoryStatus` 没有 `cold` 状态，宽限期/探索槽配套的完整状态机留到有真实数据支撑再建）。跨会话记忆在 Terminal-Bench（单会话、任务间独立）上没有结构性理由产生 reward 提升，这份改动不宣称能力收益，只宣称机制闭环。
