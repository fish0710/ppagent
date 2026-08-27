# Agent Note: TUI transcript 去重与"一个元素一个物理行"不变量

Status: implemented

## Problem

上一次 TUI 重构（[2026-08-27-tui-redesign.md](2026-08-27-tui-redesign.md)）落地后，真实会话里暴露出两类展示问题：

**一、同一条命令在屏幕上出现两三次。** 每次权限决定都会往 transcript 里提交一个 `permission` block，而它长得和工具调用一模一样：

```
⏺ git status                    ← permission block 的 header
  ⎿  已允许，本会话不再询问
     {"cmd":"git status"}       ← permission block 的 detail（原始参数 JSON）
⏺ Bash(git status)              ← 真正的 tool block
  ⎿  Exit code: 0
```

三层重复各有出处：`core/tools/execute.ts` 的 `permissionRequest()` 无条件把 `safeStringify(args)` 塞进 `detail`，即使 `describe()` 已经给出了人话摘要（`write` 更糟——整份文件内容会进确认弹窗）；`permission` block 的 header 用了和工具调用同一个 `⏺`；而 allow/deny 的结果本来就由紧随其后的 tool block 完整表达（拒绝会变成一条 `isError` 的工具结果）。会话级 `#always` 命中后不会弹窗，但 `session.ts` 的 `#observablePermissions` 照样发 `permission_request`/`permission_resolved`，于是每一次静默放行都白白多出三行。

**二、屏幕会花掉，出现大量重复的换行内容。** `segmentMarkdown` 遇到未闭合的 ``` 围栏时会把整段代码块留在 `pendingText` 里，而 `renderTuiFrame` 把它当**一个** live 行 push 出去。pi-tui 的 `Component.render` 契约是「一个数组元素 = 一个物理行」：`TuiMainScreen` 逐元素写 `\x1b[2K` + 内容 + `\r\n`，元素里带 `\n` 就会多写出几个物理行、却只按一行推进光标，此后每一帧都在错位的行号上做差分——表现为不断堆积的孤立 ` ``` ` 残行，以及被写掉半截的状态栏（`feat: TUI 复刻…样式31.1k`，尾巴上那个 `31.1k` 是上一帧 `上下文 1.5k/131.1k` 没被清掉的部分）。pi-tui 自带的超宽断言拦不住这类字符串，因为 `visibleWidth()` 把 `\n` 算作 0 宽。同一个坑还埋在 `renderResultLines()` 里——`truncateToWidth()` 同样不认换行，权限 `detail` 或工具输出里的换行会原样穿过去。

**三、一条回复被读成好几次发言。** `segmentMarkdown` 按段落切块，`renderBlock` 给每个 `assistant` block 都打 `⏺`，于是一条五段的回复在屏幕上是五个 `⏺`，段间还没有空行。Claude Code 的语义是「一条回复一个 `⏺`」，后续段落缩进对齐。

## Decision

**权限决定不再复述工具调用。** `permissionRequest()` 只在 `describe()` 没能给出摘要时才附 `detail`（此时摘要退化成 `Execute privileged tool X`，用户确实需要原始参数才知道自己在批准什么）——CLI 与 TUI 两个弹窗实现都读同一个字段，因此一处修复两处生效。reducer 侧 `resolvePermission()` 对 `allow`/`deny` 不再提交 block；只有 `allowAlways` 留痕，因为"本会话不再询问"意味着后续同名调用会静默放行，这件事没有别的地方能看见。这条 block 渲染成单行 `ℹ 本会话不再询问 bash`，不带 `⏺`——它是旁注，不是一次调用。沙箱例外的放行范围由 reason 决定而非工具名（见 `InteractivePermissionPolicy.alwaysKey`），所以有 `sandboxReason` 时一并写出。

**「一个元素恰好一个物理行」升级为显式不变量。** `blocks.ts` 导出 `toSingleLines()`，三处设防：`renderResultLines()` 先拆行再加 `⎿`/缩进前缀（保证续行前缀跟着走，而不是事后粗暴切开）；`renderBlock()` 出口兜底；`TuiDocument.render()`——交给 pi-tui 的最后一道关口——再兜一次，因为漏一个 `\n` 出去坏的不是一行而是整块屏幕。live 区域的 `pendingText` 改走新的 `renderPendingText()`：按 `\n` 拆开、只保留末尾 6 行（live 是活动指示，不是第二份 transcript），最后一行还在被追加所以看尾部，之前的行已经写完所以看开头。`test/tui.test.ts` 用一组带换行的对抗性 block 逐 kind 断言「无 `\n` 且不超宽」，并附一条证明该断言能拒绝坏输入的用例。

**一条回复一个 `⏺`。** `assistant` block 新增 `continuation?: boolean`，在 `appendBlocks()` 里按「上一个 block 也是 assistant」派生——不引入额外状态，工具/指标/用户输入落在中间自然会打断，下一段重新起头。续段渲染成 `['', ...缩进行]`：补回的空行是 `segmentMarkdown` 当作切分边界吃掉的那个，没有它多段回复会挤成一坨。

## Alternatives considered

**把权限结果并进 tool block（Claude Code 的做法）而不是单开一条。** 语义上最干净，但 `PermissionRequest` 没有 tool call id，只能靠「`permission_resolved` 之后的下一个 `tool_end`」做时序关联——多工具并发时这个假设直接不成立。真要做需要先在 `PermissionRequest` 上加 id 并贯穿 `execute.ts` → `session.ts` → UIEvent，那是一次独立的改动。当前方案不需要任何关联：把冗余的两条删掉，剩下的一条本来就不属于任何一次具体调用。

**保留 allow/deny 的 block，只是去掉 `⏺` 和 detail。** 试过，仍然是噪音。`#always` 命中时每次静默放行都会多一行"已允许"，而用户压根没被问过；deny 的信息量也全部包含在紧接着的 `⊘ Bash(...) / ⎿ User denied tool execution.` 里。留着只是让 transcript 变长，不增加任何用户能据以行动的信息。

**`detail` 改成截断到 N 字符，而不是按条件省略。** 截断解决不了性质问题：`{"cmd":"git status"}` 截到 20 字还是同一条命令说第二遍。判据不是长度而是"这个字段是否携带摘要没有的信息"，而这一点由 `describe()` 是否成功唯一决定。

**在 `sanitizeStreamingText()` 里就把 `\n` 干掉。** 不行——换行是 transcript 的提交边界，`segmentMarkdown` 和 `renderPrefixedLines` 都靠它工作。问题从来不是文本里有换行，而是带换行的文本被当成一个渲染行交出去；修在渲染出口才对得上因果。

**给 pi-tui 提 issue，让 `TuiMainScreen` 自己拆 `\n`。** 值得做，但不能等：一是上游节奏不可控，二是本项目已经把「渲染前必须自己 `truncateToWidth`」当成既有契约（`visibleWidth > width` 直接 throw 就是这个契约的强制形式），换行只是同一个契约里没被断言到的那一半，在本仓库补上是一致的。

**live 区域完整显示 pendingText，不设行数上限。** 一个几十行的代码块会把整个 transcript 顶出屏幕，而这些内容在围栏闭合后马上会以完整 markdown 的形式提交进 blocks——等于为了几百毫秒的中间态牺牲掉稳定的历史区。设成 6 行，和 `MAX_BASH_PREVIEW_LINES` 取同一个量级。

**`continuation` 用 reducer 里的显式布尔状态字段（`assistantRunOpen`）来维护。** 更啰嗦，且要在每个 case 里记得维护，漏一个就静默出错。从「上一个 block 的 kind」派生是同一件事的无状态写法，且 `blocks` 本来就是 append-only、不可变的，读末尾元素没有任何一致性风险。代价是 `thinking` block 会打断续段：`showThinking: false`（默认）时它渲染成空，理论上会在一条回复中间多出一个 `⏺`。真实的本地推理流几乎总是"先全部 reasoning 再全部 content"，交错出现属于罕见情况，且那种情况下多一个 `⏺` 也不算错读，不值得为它把 reducer 变成有状态的。
