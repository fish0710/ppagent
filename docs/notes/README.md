# Agent Notes

一份 Agent Note 记录一次**决策**：为什么这么做、否决了哪些方案、代价是什么——这些是代码和其余文档天然承载不了的部分。

## 什么时候要写

任何改变行为、架构、跨文件/跨模块约定、on-disk 或 wire 格式，或其他维护者可能日后重新质疑的改动，必须在同一次改动里附一份 Agent Note。纯机械性、局部性的编辑（重命名、格式化、修 typo）不需要。

## 和错题本的分工

[docs/ppagent-错题本.md](../ppagent-错题本.md) 记**踩过的坑**——现象、根因、修法、自检，事后补记。Agent Note 记**做过的决策**——问题、选择、被否决的方案、代价，决策时就写。改一个已有的坑，去错题本；做一个新的取舍，来这里。

## 格式

文件名：`docs/notes/yyyy-mm-dd-topic-title.md`。头三行固定：

```markdown
# Agent Note: <title>

Status: proposed | implemented | rejected — <一句话原因>
```

空一行后接正文，`## Problem` 必须是第一个小节（`proposed` 状态下可选 `## Proposal` 描述计划；`implemented` 状态下必须有 `## Decision` 描述已落地的现状）。`## Alternatives considered` **强制必填**——没记录被否决的方案，决策会被反复重提。中间可以插入任意 bespoke 小节（协议格式、schema 之类）。

`test/guards.test.ts` 校验头部格式、`## Problem` 与 `## Alternatives considered` 是否存在。

## 生命周期

`proposed` → `implemented`，或 `proposed` → `rejected`。状态变化直接改 `Status:` 那一行；不单独建目录树、不做归档冻结——这套仓库量级撑不起 DSH 原版的 lifecycle 目录 + class 分类 + archived 机制。
