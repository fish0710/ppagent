# Agent Note: 抽取失败错误透传与"合法空结果"语义区分

Status: implemented

## Problem

M12 记忆骨架落地后，真实运行（本地推理网关 custom/deepseek-v4-flash）里会话结束那一刻立即出现 `记忆抽取失败，本次会话不产出新记忆`——不是 60s 超时，是立即失败。`LlmMemoryExtractor.extract` 的 catch 把失败原因全部吞成一句固定文案，用户无从判断是网关报错、超时、还是模型违约发工具调用。同时暴露一个既有语义瑕疵：`EXTRACT_INSTRUCTION` 明确允许模型在"没有可沉淀内容"时返回空文本（"If nothing above is durable, respond with nothing"），但 `#generate` 把空文本统一当异常抛出，模型合理判断"无内容"会被误报成"抽取失败"。

## Decision

- `#generate` 里只把"sawToolCall 且空文本"当异常（模型违反 TEXT ONLY 契约）；空文本且无工具调用改为返回空串，交调用方走合法路径。
- `extract()` 的 catch 透传具体错误：`记忆抽取失败：${reason}`，reason 是 `Error.message`（provider 的 error 事件里本来就有 `event.message.errorMessage`，pi-ai 层还叠加了 `withCustomConnectionHint`；此前只在 catch 层被吞掉）。
- `extract()` 对空文本直接返回 `[]`，不再 notify——模型按指令判断无内容是正常路径，不该让用户看到一条失败警告。

## Alternatives considered

**不改错误信息，只加日志。** 错误吞掉但写 telemetry/日志。否决：用户现在的诉求就是"屏幕上要能看到具体错误"，且日志查询链路在本机场景并不存在，报错内容就该在事件流里可见。

**catch 里 notify 原文 error 对象。** notify 的签名是 `(message: string) => void`，本来就只收字符串；把完整 error 序列化进 notify 没有收益，`Error.message` 已经携带 pi-ai 层拼接过的诊断信息（含网关提示）。保持字符串透传。

**仍把空文本当异常，但改 notify 文案。** 比如"模型未产出可抽取内容"。否决：这语义上不是失败，不该走 warn 路径；改成合法返回值 `[]` 后，调用方无需分辨"失败但降级"和"正常无内容"两种空数组的差别。

## Consequences

用户能直接从 UI 事件流看到具体失败原因，定位下一步（网关参数、上下文窗口、模型行为）。空文本不再刷失败警告。行为上唯一变化是 notify 文案从固定串变为带原因（或对合法空结果完全沉默），不改变 `extract()` 返回 `[]` 的契约，不改变记忆落盘逻辑。测试新增两条：provider error 透传断言、空文本无 notify 断言。
