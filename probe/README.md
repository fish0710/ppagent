# probe — ppagent × Terminal-Bench 三题标定

用 3 道题量出真实的 `O`（输出 token）、`P_incr`（真正被计算的 prefill token）、
`T_tool`（工具执行耗时），代进公式外推全量 89 题要跑多久。

```
T_题 ≈ O / decode_tps  +  P_incr / prefill_tps  +  T_tool
T_总 ≈ 89 × 重复次数 × T_题 × kappa / 有效并发
```

`kappa` 是实测墙钟 ÷ 三项之和，把 HTTP 往返、容器启动、harbor 调度这些
公式里没有的开销吃进去。它偏离 1 太多，说明你的时间花在了意料之外的地方。

## 放哪里

丢进 ppagent 仓库根目录的 `probe/`，在**仓库根目录**执行。

```
ppagent/
├── bin/agent.js
├── benchmark/harbor/ppagent.py
└── probe/
    ├── probe.py
    ├── run_probe.sh
    └── README.md
```

## 一条命令

```bash
chmod +x probe/run_probe.sh probe/probe.py
./probe/run_probe.sh <task-1> <task-2> <task-3>
```

挑题：**一道轻的（写脚本/配置）、一道中等的、一道重的（编译/训练）**。
三道都挑简单的，外推会低估两三倍——这是这套脚本唯一会骗你的地方。

模型 id / provider 没有通用兜底默认值——从 `$PPAGENT_CONFIG`（默认
`~/.ppagent/agent.json`）读，或用下面的环境变量传，两者都没有就直接报错退出。这是
有意的：静默套用某台开发机的默认值去探测别人的端点，量出来的数字看着正常、实际跑错
了模型。tokenizer 目录是可选的——ppagent 自己在没有本地 tokenizer 时会优雅降级为
近似字节计数器，只影响 compact 触发时机，不影响 `parse` 读的 usage 上报（来自
provider API 自己的用量字段）；配了就挂载精确计数，没配就跳过挂载。

## 五步：核心权重

只有第 4/5 步在跑 ppagent；其余四步是让第 4/5 步的产物可信、可解释的支撑步骤，
本身不产出关于 ppagent 能力的信号。**报表里唯一直接回答"ppagent 行不行"的数字是第 4/5
步 `parse` 表格里的 `reward` 列**；O / P_incr / T_tool / 外推时长回答的是"跑得动全量吗、
要多久"，是规划问题，不是能力问题——两者都有用，但别混为一谈。

| 步 | 内容 | 权重 | 耗时 | 为什么必须有 |
|---|---|---|---|---|
| 0 | 预检 + 探测 harbor 的任务筛选参数名 | 门槛 | 秒 | 不同版本 flag 叫法不一样，脚本自己探 |
| 1 | `--check-compat` | 门槛 | 1 分钟 | 换模型 chat template 就变，工具调用不通会全零，别误判成模型不行 |
| 2 | 微基准（decode/prefill 速率） | 支撑测量 | 幂等，命中缓存几秒；未命中数分钟到二十分钟 | 把"ppagent 慢"和"模型服务端慢"分开算账，否则外推和 kappa 都失真 |
| 3 | oracle 跑同样 3 题 | 环境体检 | 幂等，命中缓存跳过；未命中十几分钟 | 不用模型，只跑官方解法。**暴露 arm64 模拟问题**，给出单题耗时的地板 |
| 4 | ppagent 跑 3 题 | **核心** | 几小时 | 唯一实际评估 ppagent 的一步 |
| 5 | 解析 + 外推 | **核心** | 秒 | 把第 4 步的事件流变成 reward / O / P_incr / T_tool / 外推时长 |

第 2、3 步都只依赖"模型服务端 / dataset+题目"，跟这次跑的是不是 ppagent 无关，
天然幂等——默认自动缓存，命中就跳过，不用手动记着复用哪个文件。

## 常用改法

默认值来自 `~/.ppagent/agent.json`（ppagent 的 global 配置）：`provider` 段的
`id`/`model`/`baseUrl`/`apiKey`/`effort`/`maxOutputTokens`/`requestTimeoutMs`/`maxRetries`、
`loop` 段的 `maxTurns`/`turnTimeoutMs`、`context` 段的 `tokenizer`——即容器里跑的配置对齐
宿主机意图；环境变量永远覆盖。全部可调项：

```bash
EFFORT=medium CTX_WINDOW=65536 ./probe/run_probe.sh a b c   # 换配置
MAX_TURNS=120 ./probe/run_probe.sh a b c                    # 换 agent 总轮数上限
TURN_TIMEOUT_MS=3600000 ./probe/run_probe.sh a b c          # 换每轮超时（默认 60min，标定专用，不对齐 agent.json）
RUN_ORACLE=0 ./probe/run_probe.sh a b c                     # 跳过体检
FORCE_CALIBRATE=1 ./probe/run_probe.sh a b c                # 无视缓存，强制重跑微基准
FORCE_ORACLE=1 ./probe/run_probe.sh a b c                   # 无视缓存，强制重跑 oracle
PROVIDER=custom ./probe/run_probe.sh a b c                  # 换 provider（custom/lmstudio/llamacpp）
PPAGENT_CONFIG=/other/agent.json ./probe/run_probe.sh a b c # 换配置文件
TOKENIZER_DIR=/abs/path/tok ./probe/run_probe.sh a b c
TASK_FLAG=--task-id ./probe/run_probe.sh a b c              # 自动探测失败时手填
```

跑完后只想换参数重算，不用再跑 harbor：

```bash
python3 probe/probe.py estimate --calib probe-out/calib.json \
  --probe probe-out/probe.json --tasks 89 --attempts 3 --speedup 1.3
```

缓存文件都在 `$OUT_DIR`（默认 `./probe-out`）：`calib.json` 记了标定时的
`base_url`/`model`，`oracle-cache.json` 记了 `dataset`/题目列表；换端点、换模型、
换题目会自动判定缓存失效并重跑，不用手动清。

## events.jsonl 字段名对不上怎么办

`parse` 那步如果报 `[warn] N 个 trial 没解析出 token`：

```bash
cat probe-out/schema.txt                  # 看真实事件类型和字段名
# 把字段名补进 probe.py 顶部的 KEYS_PROMPT / KEYS_COMPLETION / KEYS_TS ...
python3 probe/probe.py parse ./jobs/<最新那个>/ --out probe-out/probe.json
python3 probe/probe.py estimate
```

解析器用的是递归找键，不假设嵌套结构，所以基本只需要补名字。

## 先验一下解析链路

不碰任何外部依赖，用合成数据跑通全流程：

```bash
python3 probe/probe.py selftest
```

## 两个读数陷阱

**P_incr 是下界。** 事件里如果没有 `cached_tokens`，脚本用「prompt_tokens 逐轮
增量」估算，等价于假设服务端 prefix cache 命中率 100%。LM Studio / llama.cpp
真实命中率没这么高，每次 compact 还会把前缀缓存整段作废。`parse` 输出里的
`P_full` 是完全不缓存的上界——真值在这两个数之间，差距可能有一个数量级。

**3 道题的样本量极小。** Terminal-Bench 的单题耗时是长尾分布，前沿模型也有
跑到两小时、上百次模型调用的题。外推表里的「悲观」一栏更接近真实全量耗时。
