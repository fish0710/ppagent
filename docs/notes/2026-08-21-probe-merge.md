# Agent Note: 合并 probe/ 三题标定脚本

Status: implemented

## Problem

`dev` 分支上写了一套 `probe/` 脚本（`probe.py` + `run_probe.sh` + `llm-proxy.js`），
用 3 道 Terminal-Bench 题目量出真实的 decode/prefill 速率和 ppagent 自身开销，外推
跑完全量 89 题要多久。但那个分支是从 main 的 `241287a` 分出去的，此后 main 又落了
`4764d4b`（compact 机制）和 `ce259ee`（AGENTS.md + verify + guards 项目 harness）两个
提交；直接合并 `dev` 会把 harness 提交带来的 `guards.test.ts`、`tsconfig.test.json`、
`.husky/pre-push`、`npm run verify`、以及 7 处已修复的 TS 类型错误全部撤销——这些不是
`dev` 分支有意做的改动，只是它落后于 main。

审查 probe 脚本本身时还发现一个真实的正确性 bug：`benchmark/harbor/ppagent.py` 的
`run()` 只把固定 6 个环境变量透传进容器（`PPAGENT_CUSTOM_BASE_URL` /
`PPAGENT_CUSTOM_API_KEY` / `PPAGENT_TOKENIZER` / `PPAGENT_TOKENIZER_LOCAL_ONLY` /
`LMNR_PROJECT_API_KEY` / `PPAGENT_LAMINAR_ENDPOINT`）。`run_probe.sh` 第 4 步用
`--ae PPAGENT_EFFORT=... PPAGENT_MAX_TOKENS=... PPAGENT_TURN_TIMEOUT_MS=...
PPAGENT_SANDBOX_NETWORK_ALLOWLIST=... PPAGENT_MAX_OUTPUT_TOKENS=...
PPAGENT_REQUEST_TIMEOUT_MS=... PPAGENT_MAX_RETRIES=...` 传参，这些全部不在白名单里，
容器里的 ppagent 实际用的是内置默认值——调用方以为自己在测某个 effort/超时/网络配置，
量出来的其实是另一份配置的数字。

脚本里还有真实的硬编码：`MODEL_ID`/`PROVIDER`/`TOKENIZER_DIR` 默认值是 dev 分支作者
自己那台机器的私有配置（`qwen3.8-27b` / `lmstudio` / `$HOME/models/qwen3.8-27b-tokenizer`），
换一台机器（比如这次审查时看到的 `~/.ppagent/agent.json` 实际是 `custom` provider 打
`deepseek-v4-flash`）会静默套用错误默认值去探测别人的端点。`calibrate` 子命令还多测了
一项 `reasoning_effort` 对输出量的放大倍数，但 `estimate` 从未读取这个字段——纯粹的
死代码。`estimate` 的敏感性分析里还有一条"假如租一张卡"的场景，硬编码了
`decode=80 tok/s, prefill=2000 tok/s, concurrency=8` 三个凭空假设的数字，且这是在
评估硬件采购方案而不是评估 ppagent。

## Decision

- 只把 `probe/`（`probe.py`、`run_probe.sh`、`llm-proxy.js`、`README.md`）和
  `.gitignore` 的 4 行新增（`terminal-bench-*` / `jobs/` / `probe-out/`）从 `dev`
  移植到 main，不做真正的分支合并；main 在 harness 提交上的进展原样保留。
- 修 `benchmark/harbor/ppagent.py` 的环境变量透传：固定 6 项白名单改成前缀匹配
  （`PPAGENT_*` 或精确匹配 `LMNR_PROJECT_API_KEY`），任何新增的 `PPAGENT_*` 配置项
  自动可以透传，不用每次都回来加白名单条目。
- `run_probe.sh` 里 `MODEL_ID`/`PROVIDER`/`TOKENIZER_DIR` 不再兜底到某台机器的私有
  默认值，三者任一缺失时直接 `die`，提示从 `$PPAGENT_CONFIG` 配置或用环境变量传入。
- `probe.py calibrate` 删掉未被消费的 `reasoning_effort` 微基准子步骤（原第 4/4 步），
  子步骤编号相应改为 1/3、2/3、3/3；`estimate` 的敏感性分析删掉硬编码"租卡"场景。
- 微基准（第 2 步）和 oracle 体检（第 3 步）都只依赖"模型服务端/dataset+题目"，跟
  这次跑的是不是 ppagent 无关，天然幂等：改成默认自动缓存（比较 `calib.json` 记录的
  `base_url`/`model`、`oracle-cache.json` 记录的 `dataset`/题目列表是否与本次一致），
  命中就跳过；原来手动的 `SKIP_CALIBRATE=1` 换成语义相反的 `FORCE_CALIBRATE=1` /
  `FORCE_ORACLE=1`（无视缓存强制重跑）。
- README 加一张"五步核心权重"表：明确标出只有第 4/5 步（跑 ppagent、解析出
  reward/O/P_incr/T_tool）在回答"ppagent 行不行"，第 0/1 步是门槛、第 2/3 步是让
  第 4/5 步产物可信的支撑测量，本身不产出关于 ppagent 能力的信号——避免脚本的时长
  外推（规划问题）被误读成能力评估（评估问题）。

## Alternatives considered

**直接 `git merge origin/dev`。** 会撤销 main 后续两个提交（compact 机制、AGENTS.md
harness）带来的全部内容，包括 7 处已修复的 TS 类型错误、`guards.test.ts`、
`tsconfig.test.json`、`.husky/pre-push`、`npm run verify`。这些丢失只是因为 `dev`
分支落后于 main，不是 `dev` 有意撤销它们；用一次合并把无关的倒退和有意义的 probe/
新增捆在一起，风险和收益不对称。

**保留 `benchmark/harbor/ppagent.py` 的固定环境变量白名单，只在 README 里提醒
"这些 `--ae` 目前不生效"。** 白名单式的心智负担会一直存在——下次 `src/agent/config`
新增一个 `PPAGENT_*` 配置项，probe 脚本又会静默失效，且没有测试能捕捉这种"参数传了
但没生效"的回归。前缀匹配把这类新增配置项默认打通，属于同一类问题的根治而不是逐次
打补丁。

**保留 `reasoning_effort` 微基准，只是不在 `estimate` 里用。** 如果以后真的要把
effort 对输出量的放大倍数纳入外推公式，加回来的成本很低（一个函数），但现状是死代码
且拉长 calibrate 耗时（多一轮网络往返），不如先删，需要时再加，避免帮一个从未被读取
的字段维护测量逻辑。

**保留"租卡"敏感性场景，把三个硬编码数字改成命令行参数。** 评估的是"换一张更快的卡
大概要多久"这个硬件采购问题，不是"ppagent 现在这套配置下行不行"；就算参数化了，它
仍然是与本次合并门禁（评估 ppagent 能力）无关的内容，直接删更符合"提炼核心权重"的
要求。

## Consequences

**买到的**：`run_probe.sh` 第 4 步的 `--ae` 参数现在真的会生效，不会再有"调了 effort
但容器里其实没变"的静默失真；`MODEL_ID`/`PROVIDER`/`TOKENIZER_DIR` 换机器跑会在第 0
步之前就报错，而不是套用别人的默认值跑出一份看似正常、实则测错模型的报告；重复标定
（换题目不换模型时）从"十几到二十分钟"降到几秒；README 的权重表让"这份报告哪部分在
说 ppagent 行不行、哪部分在说要跑多久"不再需要靠读脚本源码才能分清。

**付出的**：`benchmark/harbor/ppagent.py` 的前缀匹配意味着任何 `PPAGENT_` 开头、恰好
在 harbor 宿主进程环境里存在的变量都会被转发进容器——如果宿主机的 shell 里有一个同前缀
但语义不相关的变量（目前代码里不存在这种命名冲突），会被误传入容器；可接受，因为透传
目标仍然被限定在项目自己的配置命名空间内，不是任意宿主环境变量。`MODEL_ID` 等强制
报错取代了"总能跑起来，哪怕跑错"的宽松默认值，第一次在新机器上跑会多一步配置
`agent.json` 或传环境变量，这是有意的取舍。

## Follow-up: 真实冒烟测试（同日）

用当前实际配置（`custom` provider、`deepseek-v4-flash`、远程 HTTPS 网关）跑了一次真
冒烟：`fix-git`（easy）/`kv-store-grpc`（medium）/`configure-git-webserver`（hard）。
结果：3/3 reward=1.0，0 exceptions，harbor job 总墙钟 18m34s——ppagent 三道题全过。
过程中发现并修了四个只有真实运行才会暴露的 bug：

- **bash 3.2 空数组 + `nounset` 崩溃。** macOS 系统自带 `/bin/bash` 是 3.2（GPLv2 分支
  冻结版），`"${ARR[@]}"` 在 `ARR=()` 时会被 `set -u` 判成 unbound variable。第一次真跑
  在 `TOKENIZER_AE`/`MOUNTS_AK`（本次 tokenizer 未配置，两个数组恰好为空）上炸掉，
  `API_KEY_AE`/`EXTRA_AE`/`MAX_TURNS_AK` 这次因为 agent.json 里对应字段非空而没触发，
  但同样的模式、换一份更简的配置一样会炸。改成 `"${ARR[@]+"${ARR[@]}"}"`（bash 3.2 兼容
  写法：数组为空时整体展开成空，非空时正常展开）修了 harbor run 那条命令里全部五个
  条件数组。
- **calib.json 的 base_url 缓存键记错了值。** `calibrate` 子命令收到的 `--base-url` 是
  本机 TLS 代理地址（`http://127.0.0.1:<随机端口>`），不是真正的上游；缓存命中逻辑拿它
  跟 `$BASE_URL_HOST`（真实的远程 HTTPS 网关）比较，永远对不上——对任何需要走代理的
  远程 provider，"自动缓存"实际上从未生效过。修法：calibrate 成功后把 `calib.json` 的
  `base_url` 字段重写成真实的 `$BASE_URL_HOST`。
- **`probe.py` 的 task 标签全部塌缩成字面量 "ppagent"。** `parse_trial` 原来用
  `path.parent.name` 当 task 名，但真实路径是
  `jobs/<job>/<task>__<hash>/agent/ppagent/events.jsonl`——`ppagent` 是
  `benchmark/harbor/ppagent.py` 里 `_EVENTS_FILENAME` 定死的固定子目录名，
  `path.parent.name` 对每个 trial 都是这同一个字符串。新增 `trial_name()`，从
  `events.jsonl` 往上跳过已知的 `ppagent`/`agent` 两层固定目录名，落到真正的
  `<task>__<hash>` 目录。
- **T_tool 被系统性放大两个数量级。** ppagent 实际发出的字段是 `durationMs`（`schema.txt`
  证实），原来的换算是"数值 >1000 才当毫秒除以 1000，否则当成已经是秒"——但真实工具调用
  大多数不到一秒，`durationMs` 常年 <1000，于是被当成"850 秒"而不是"850 毫秒"。某道题
  53 次工具调用里只要有十来次落在这个区间，T_tool 就从真实的个位数/几十秒被吹到几千秒
  （实测：一道题从 9272s 修正到 45s）。修法：`deep_find` 拆出 `deep_find_key` 带回匹配到
  的键名，键名里带 "ms"/"sec" 就按键名判定单位，不再按数值量级瞎猜；只有两者都没写单位
  的兜底 `duration` 键才继续用量级启发式。

四个 bug 都不是理论推演出来的——是这次真机对真实 endpoint 跑出来才现形的，也印证了
Problem 段落里"合并前必须过一遍真实运行"不是多余的谨慎。修完后重新 `parse` + `estimate`
（没有重新跑 harbor，直接用已有的 `jobs/2026-08-21__15-35-10/` 复算）：kappa 从荒谬的
0.10 变成合理的 5.65，89 题全量外推中位数从"1 天 16 小时"变成"4 小时 16 分"。
