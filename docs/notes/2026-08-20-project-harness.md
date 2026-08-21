# Agent Note: 引入项目级 harness（AGENTS.md + verify + guards）

Status: implemented

## Problem

模型在这个仓库里干活时，约束全靠三处分散事实：设计书 §3 的硬约束表（无工具强制部分条目）、错题本里事后补记的坑、以及 depcruise 规则本身。没有一份模型必读的单一入口；本地门禁还有一个真实 bug——`.husky/pre-commit` 没有 `set -e`，`sh` 脚本退出码取自最后一条命令，depcruise 的架构违规此前本地根本拦不住，只能靠 CI 事后发现。同时没有统一的 `verify` 命令，模型和贡献者都要自己记住 build/depcruise/test 三条命令的组合与顺序。

参考了 `deepseek-ai/deepseek-harness`（DSH）项目级 harness 的做法：单一 AGENTS.md 入口、可机械校验的不变量必须变成门禁（且门禁自证能拒绝坏输入）、门禁按 pre-commit/pre-push/CI 分层、非平凡改动强制附决策记录（Agent Note，`## Alternatives considered` 必填）。

## Decision

- 新增根 `AGENTS.md`（英文，硬上限 140 行，由 `test/guards.test.ts` 校验），`CLAUDE.md` 作为指向它的符号链接。
- `package.json` 新增 `typecheck`（涵盖 `src/`、`bin/`、`test/` 三个 tsconfig）与 `verify`（typecheck + depcruise + test）两个 script；CI 与本地钩子统一走 `npm run verify`，不再各自拼接命令。
- 新增 `tsconfig.test.json`，把此前从未被 typecheck 覆盖的 `test/` 纳入；修复了纳入后暴露的 7 处真实类型错误（`RequestInfo` 在 Node 全局类型里不存在，改用 `Parameters<typeof fetch>[0]`；一处 mock 因参数类型被推断为空元组，显式标注参数类型）。
- 修复 `.husky/pre-commit` 缺 `set -e` 导致 depcruise 失败不阻断提交的 bug；新增 `.husky/pre-push` 跑完整 `npm run verify`，形成"pre-commit 快、pre-push 全、CI 管平台矩阵"的三层门禁。
- 把 `test/smoke.test.ts` 里已有的源码字符串守卫（`core/types.ts` 无 import、`tokenizer.ts` 无 IO）迁移并扩展进新的 `test/guards.test.ts`，新增：`core/` 不得读 `process.env`（此前零工具强制）、bash 工具 spawn 必须 `detached: true`（错题本 1.6 的孤儿进程回归）、AGENTS.md 行数预算、Agent Note 格式校验。每条守卫都附一个"用坏样本证明规则能拒绝违规"的用例，避免正则写错后门禁变成摆设。
- 新增 `docs/notes/`，定义 Agent Note 格式，与错题本分工：错题本记坑，Agent Note 记决策。

## Alternatives considered

**照搬 DSH 全套（lefthook + oxlint/jscpd/knip + ~150 个独立 verify 脚本 + lifecycle/class 目录树 + archived 冻结机制）。** DSH 是 9000+ 文件、多语言 SDK、多人协作的仓库；ppagent 是约 1 万行、单人维护的骨架期项目。把 husky 换成 lefthook只是多一个依赖没有新增能力；引入 linter 是一个需要单独评估格式 churn 的独立决策，不该夹带在 harness 改动里；per-file 覆盖率门禁在当前测试规模下改造成本远大于收益。选择只移植内核：单一入口文档、可自证的门禁、分层钩子、轻量决策记录。

**新建独立的 `scripts/verify-*.ts` 体系（DSH 的做法）。** 本项目已经有 `test/smoke.test.ts` 珠玉在前——用 vitest 断言校验源码不变量，效果等价，且和现有测试基础设施共用同一套 runner、同一条 `npm test` 命令，不需要新的执行入口。扩展它比平行建一套更省。

**Agent Note 沿用 DSH 的 `{lifecycle}/{class}/yyyy-mm-dd-topic.md` 路径分类 + archived 冻结。** 本仓库到目前为止决策数量个位数，目录分类和归档流程的维护成本会超过它带来的可发现性收益。改为扁平 `docs/notes/*.md`，靠 `Status:` 字段表达生命周期；量级涨上来后再引入分类不是破坏性变更。

**把这次改动本身记进错题本而非 Agent Note。** 错题本的体裁是"现象/根因/修法/自检"，适合事后复盘一个具体故障；这次是一次主动的流程决策，`Problem/Decision/Alternatives/Consequences` 的体裁更贴切，也顺便给 Agent Note 机制留一个自举样本。

## Consequences

**买到的**：本地 pre-commit 第一次真正能拦住架构违规；`test/` 里长期存在的类型错误被清出来；CI、pre-push、本地手跑三处不再各自维护一份命令组合，改 `verify` 一处即可同步全部入口；新增的不变量（`core` 不读环境变量、bash 子进程隔离）从"文档里写着"变成"提交时会红"。

**付出的**：`AGENTS.md` 140 行的硬预算意味着后续任何新约束都要先做减法才能加东西——这是有意为之，对应"提示词要小"的立项理由，但确实压缩了能塞进强制上下文的规则数量。`docs/notes/` 目前没有分类和归档，决策数量涨到几十份后大概率需要重新引入某种结构，届时是一次已知会来的返工。守卫测试用字符串/正则扫描源码，天生比真正的静态分析弱（比如 `process.env` 检测认字符串不认语义），足够用但不是完备防线。
