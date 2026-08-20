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

## 五步都干了什么

| 步 | 内容 | 耗时 | 为什么必须有 |
|---|---|---|---|
| 0 | 预检 + 探测 harbor 的任务筛选参数名 | 秒 | 不同版本 flag 叫法不一样，脚本自己探 |
| 1 | `--check-compat` | 1 分钟 | 换模型 chat template 就变，工具调用不通会全零，别误判成模型不行 |
| 2 | 微基准 | 10–25 分钟 | 量 decode tps、prefill tps 随上下文的衰减曲线、effort 对输出量的放大倍数 |
| 3 | oracle 跑同样 3 题 | 十几分钟 | 不用模型，只跑官方解法。**暴露 arm64 模拟问题**，同时给出单题耗时的地板 |
| 4 | ppagent 跑 3 题 | 几小时 | 正题 |
| 5 | 解析 + 外推 | 秒 | 出表 |

## 常用改法

默认值来自 `~/.ppagent/agent.json`（ppagent 的 global 配置）：`provider` 段的
`id`/`model`/`baseUrl`/`apiKey`/`effort`/`maxOutputTokens`/`requestTimeoutMs`/`maxRetries`，
以及 `loop` 段的 `maxTurns`/`turnTimeoutMs`——即容器里跑的配置对齐宿主机意图；
环境变量永远覆盖。全部可调项：

```bash
EFFORT=medium CTX_WINDOW=65536 ./probe/run_probe.sh a b c   # 换配置
MAX_TURNS=120 ./probe/run_probe.sh a b c                    # 换 agent 总轮数上限
TURN_TIMEOUT_MS=3600000 ./probe/run_probe.sh a b c          # 换每轮超时（默认 60min，标定专用，不对齐 agent.json）
RUN_ORACLE=0 ./probe/run_probe.sh a b c                     # 跳过体检
SKIP_CALIBRATE=1 ./probe/run_probe.sh a b c                 # 复用 probe-out/calib.json，跳过微基准
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
