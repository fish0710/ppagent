# Agent Note: TUI 复刻 Claude Code 展示与样式

Status: implemented

## Problem

现有 TUI（M11 后落地）四个用户痛点：输入框不能换行（用的是 pi-tui 单行 `Input`）、没有斜杠命令（只有 `/exit`/`/quit`/`/compact` 三个字符串硬匹配）、消息没有层次感（`TuiState.transcript` 是拍平的 `string[]`，全仓库零 ANSI 配色，唯一区分手段是行首一个 Unicode 字形）、工具展示很差（`UIEvent.tool_end` 只带 200 字符的 `preview`，`edit` 工具根本不产出 diff 数据）。

目标：已落地的功能，展示和样式复刻 Claude Code；继续用 `@earendil-works/pi-tui`（差分渲染、`TuiMainScreen`、scrollback），不引入新的 UI 框架；文案保持中文，只复刻视觉语言。

## Decision

按四个阶段落地，每阶段结束 `npm run verify` 全绿：

**Phase 0（数据管线，无视觉变化）**：`core/types.ts` 新增 `ToolDisplay`（`diff | write | read | bash` 判别联合）+ `DiffHunk`/`DiffLine`；`ToolOutput.display?` 和 `UIEvent.tool_end.display?` 均可选，旧事件生产者不受影响。`core/tools/builtin/diff.ts` 的 `computeEditDiff()` 用确定性行边界扩展算出 diff（不是通用 LCS——`edit` 工具的替换位置本来就是精确已知的，`indexOf` 扫出来的）。`core/tools/execute.ts` 的 `executeToolCall` 改返回 `ToolCallOutcome { message; display? }`，`display` 绕过 `ToolResultMessage` 直接进 `UIEvent`。`agent/permissions/index.ts` 的 `InteractivePermissionPolicy` 从 `confirm()` 切到三选项 `select()`，加会话级 `#always` 记忆实现真正的 `allowAlways`。`app/cli/index.ts` 三个 `Interaction` 实现同步补上 `select()`（`AutoApproveInteraction` 必须返回 `'allow'`，否则 `--permission-mode allow` 静默变成全拒绝）。

**Phase 1（结构化 transcript + 主题 + 按块渲染）**：新增 `blocks.ts`（`TranscriptBlock` 判别联合 + 纯函数 `renderBlock`）取代 `transcript: string[]`；`theme.ts`（8/16 色 SGR helper，`enabled:false` 时全恒等函数）；`format.ts`（`segmentMarkdown` 做围栏感知的段落切分，流式文本不再按单个 `\n` 提交，而是按完整 markdown 段落提交）。`render.ts` 的 `Transcript` 类维护一个展开后的行前缀缓存，只对新提交的 block 增量渲染。

**Phase 2（多行输入）**：`prompt-box.ts` 的 `PromptBox` 把 pi-tui `Editor`（本身只画上下两条横线）包成完整圆角框，靠三条已核实的 pi-tui 行为识别边框/内容/补全菜单边界，换来多行编辑、`Tab`/`@` 文件补全、`↑↓` 历史、粘贴标记全部免费。

**Phase 3（命令 + 权限弹窗 + 状态栏）**：`commands.ts` 的斜杠命令注册表（`/help /compact /exit /quit /cost /status /tools /init`），任何未注册的 `/foo` 一律拒绝并提示，不再发给模型（对齐 Claude Code 行为，是一次刻意的行为变更）。`permission-dialog.ts` + `interaction.ts` 的 `TuiInteraction.select()` 用 pi-tui `SelectList` + `showOverlay()` 做三选项弹窗，y/a/n 仍是可用快捷键（通过模态 input listener，在 SelectList 拿到焦点后依然优先生效）。`app.ts` 加 esc 单级中断（区别于 Ctrl+C 的两级退出阶梯）和常驻底栏（cwd/provider/model/上下文占比）。

## Alternatives considered

**把 `display` 挂在 `ToolResultMessage` 上，而不是新开 `ToolCallOutcome` 旁路。** 试过，放弃了。`ToolResultMessage` 会进每条 JSONL 持久化记录（一个大 diff 几十 KB）；`core/context/prune.ts` 剪枝时是 `{ ...message, content, pruned: true }`，剪枝后的存根会继续拖着完整 diff，剪了等于没剪；`--resume` 会把上个进程的陈旧 diff 重放进没人渲染的 context。`core/types.ts` §11 已经确立"Span 与 UIEvent 是两个独立出口，不复用"——`ToolDisplay` 只走 UIEvent 是同一个原则在下一层的应用。

**继续用 `string[]` 存 transcript，只在渲染时套色。** 试过这个思路但放不下 diff——一行纯文本装不下"这行是 add 还是 remove、原文件第几行、要不要折叠"这些结构信息，套色本质上是在正则匹配已经丢失结构的字符串。换成判别联合后，`renderBlock` 是纯函数、`renderer.render(80, theme)` 换主题不用碰 reducer，测试断言从"精确匹配中文字符串"变成"匹配 `{kind:'tool', isError:false}` 这样的结构"，改文案不再牵连测试。

**渲染缓存用 `Map<BlockId, string[]>`。** blocks 是 append-only 且不可变的，Map 的失效场景只有宽度变化——而宽度变化时全部缓存都要重算，一个按 id 索引的 Map 不比一个展开后的行数组前缀（每帧只 `push` 新增部分）更有优势，反而多一次 Map 查找和一次 flatten。改成扁平前缀缓存，摊还成本 O(新增 block)。

**探测终端明暗主题（`queryTerminalColorScheme`）做真正的自适应配色。** 这个查询是异步的且只能在 `start()` 之后才有结果，中途根据探测结果切换主题意味着要重新渲染已经提交的 block——直接违反"transcript 只追加、已提交内容永不修改"的约束（错题本 12.1）。改成只用 8/16 色（`30–37`/`90–97`），让用户终端自己的调色板决定实际色相，明暗主题天然都对，`enabled` 只由 `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`/是否是 TTY 决定，不依赖任何运行时探测。

**`allowAlways` 不加记忆，直接让三个选项里两个行为等价。** 检查后发现 `core/tools/execute.ts` 里 `allowAlways` 从未被真正处理过（只在类型声明和一处 UI label 里出现），如果只加个选项不加记忆，"允许，且本会话不再询问"就是个骗用户的按钮。给 `InteractivePermissionPolicy` 加 `#always: Set<string>` 是最小的真实修复；沙箱升级来的请求单独用 `${toolName} ${sandboxReason}` 做 key，不与普通请求共享记忆，因为它的放行范围由 sandboxReason 决定而不是工具名。

**实现 `/clear`。** Claude Code 有这个命令，但真正的清屏需要 `\x1b[3J` 之类的转义序列，会破坏 `TuiMainScreen` 保留的 terminal scrollback（错题本 12.1 的核心约束）；而且 `AgentSession` 目前没有重置 `Context` 的 API，`/clear` 只清 UI 不清 context 会让用户以为历史真的没了但模型其实还记得。今天诚实的答案是 `/compact`；真要做 `/clear`，需要先在 `AgentSession` 上加一个显式的 `reset()`，且明确它只清 UI 展示、不清 terminal，这是另一个决策，不在本次范围内。

**换成 Ink（React 渲染到终端）。** 没有认真评估——设计书把"使用 `@earendil-works/pi-tui` 的 `TuiMainScreen`，明确不使用 `TuiAltScreen`"写成了架构决策，Ink 会整体替换掉这一层；错题本 12.1/12.2 对 scrollback 保留和 raw-mode Ctrl+C 路由的约束都是针对 pi-tui 现有实现验证过的，换框架要重新验证全部这些行为。按 `AGENTS.md` 的判据——"如果一个决策对云端大模型和本地小模型意义一样，就不是本项目的重点，抄现成方案即可"——TUI 渲染框架选型对本地/云端没有区别，继续用已经验证过的 pi-tui，把预算花在真正本地相关的问题上。
