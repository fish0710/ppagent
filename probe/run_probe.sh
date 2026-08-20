#!/usr/bin/env bash
# =============================================================================
# run_probe.sh — ppagent x Terminal-Bench 三题标定
#
# 用法（在 ppagent 仓库根目录执行）：
#   ./probe/run_probe.sh <task-id-1> <task-id-2> <task-id-3>
#
# 挑题原则：一道明显轻量的（写脚本/配置）、一道中等的、一道明显重的（编译/训练）。
# 三道都挑简单的 = 低估两三倍，这是这个脚本唯一会骗你的地方。
#
# 全部可调项都走环境变量，见下面 CONFIG 段。
# =============================================================================
set -euo pipefail

# ------------------------------- CONFIG --------------------------------------
DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
AGENT="${AGENT:-benchmark.harbor.ppagent:PPAgent}"
# 默认值从 ~/.ppagent/agent.json 读取（ppagent 的 global 配置约定），让容器行为和宿主机意图一致；
# 环境变量始终优先；文件缺失或字段缺失时回退到内置默认。
PPAGENT_CONFIG="${PPAGENT_CONFIG:-$HOME/.ppagent/agent.json}"
if [ -f "$PPAGENT_CONFIG" ]; then
  cfg() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));s=d.get(sys.argv[2],{});print(s.get(sys.argv[3],"") or "")' "$PPAGENT_CONFIG" "$1" "$2"; }
  : "${CFG_PROVIDER:=$(cfg provider id)}"
  : "${CFG_MODEL:=$(cfg provider model)}"
  : "${CFG_BASE_URL:=$(cfg provider baseUrl)}"
  : "${CFG_API_KEY:=$(cfg provider apiKey)}"
  : "${CFG_EFFORT:=$(cfg provider effort)}"
  : "${CFG_MAX_OUTPUT_TOKENS:=$(cfg provider maxOutputTokens)}"
  : "${CFG_REQUEST_TIMEOUT_MS:=$(cfg provider requestTimeoutMs)}"
  : "${CFG_MAX_RETRIES:=$(cfg provider maxRetries)}"
  : "${CFG_MAX_TURNS:=$(cfg loop maxTurns)}"
  : "${CFG_TURN_TIMEOUT_MS:=$(cfg loop turnTimeoutMs)}"
fi
MODEL_ID="${MODEL_ID:-${CFG_MODEL:-qwen3.8-27b}}"          # 服务端的 model id
PROVIDER="${PROVIDER:-${CFG_PROVIDER:-lmstudio}}"          # custom/lmstudio/llamacpp，透传给 --provider 与 harbor -m
HARBOR_MODEL="${HARBOR_MODEL:-${PROVIDER}/${MODEL_ID}}"
BASE_URL_HOST="${BASE_URL_HOST:-${CFG_BASE_URL:-http://localhost:1234/v1}}"        # 给本机脚本用
# 容器地址默认从 HOST 推导：宿主机服务把 localhost/127.0.0.1 换成 host.docker.internal；远程地址原样透传。
DERIVED_CONTAINER="$(printf '%s' "$BASE_URL_HOST" | sed -E 's#//(localhost|127\.0\.0\.1)#//host.docker.internal#')"
BASE_URL_CONTAINER="${BASE_URL_CONTAINER:-$DERIVED_CONTAINER}"
API_KEY="${PPAGENT_CUSTOM_API_KEY:-${CFG_API_KEY:-}}"
TOKENIZER_DIR="${TOKENIZER_DIR:-$HOME/models/qwen3.8-27b-tokenizer}"
EFFORT="${EFFORT:-${CFG_EFFORT:-low}}"                   # 默认对齐 agent.json 的 provider.effort
CTX_WINDOW="${CTX_WINDOW:-131072}"
# 对齐的教训：agent.json 的 turnTimeoutMs=20min 对 TB 长任务不够——query-optimize 曾因此
# 从「跑完只败性能」退化成「超时没写出 sol.sql」。标定场景固定 60min/轮，仍可 TURN_TIMEOUT_MS 覆盖。
TURN_TIMEOUT_MS="${TURN_TIMEOUT_MS:-3600000}"
MAX_TURNS="${MAX_TURNS:-${CFG_MAX_TURNS:-32}}"           # agent 总轮数上限，对齐 agent.json 的 loop.maxTurns
MAX_OUTPUT_TOKENS="${MAX_OUTPUT_TOKENS:-${CFG_MAX_OUTPUT_TOKENS:-}}"  # provider.maxOutputTokens
REQUEST_TIMEOUT_MS="${REQUEST_TIMEOUT_MS:-${CFG_REQUEST_TIMEOUT_MS:-}}"  # provider.requestTimeoutMs
MAX_RETRIES="${MAX_RETRIES:-${CFG_MAX_RETRIES:-}}"       # provider.maxRetries
NET_ALLOW="${NET_ALLOW:-*:443,*:80}"           # TB 允许联网装包，不放开会大批假失败
# 模型服务端口不在默认出站放行列表时补一条通配（远程 host 只能通配端口）。
MODEL_PORT="$(printf '%s' "$BASE_URL_HOST" | sed -nE 's#^[a-z]+://[^/:]+:([0-9]+)/.*#\1#p')"
if [ -n "$MODEL_PORT" ] && [ "$MODEL_PORT" != "443" ] && [ "$MODEL_PORT" != "80" ]; then
  NET_ALLOW="${NET_ALLOW},*:${MODEL_PORT}"
fi
N_CONCURRENT="${N_CONCURRENT:-1}"              # 标定阶段固定 1，别引入并发干扰
OUT_DIR="${OUT_DIR:-./probe-out}"
RUN_ORACLE="${RUN_ORACLE:-1}"                  # 先用官方解法跑一遍，体检 arm64/镜像
PROBE_PY="${PROBE_PY:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/probe.py}"
# -----------------------------------------------------------------------------

if [ "$#" -lt 1 ]; then
  sed -n '2,11p' "$0"
  echo
  echo "还没确定题目 id？先下数据集再列目录："
  echo "  harbor datasets download ${DATASET}"
  echo "  # 然后在 harbor 的数据集缓存目录里 ls，每个子目录名就是 task id"
  exit 1
fi
TASKS=("$@")

mkdir -p "$OUT_DIR"
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
die() { printf '\033[31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0 预检
say "0/5 预检"
command -v harbor >/dev/null || die "没有 harbor：uv tool install harbor"
command -v node   >/dev/null || die "没有 node（ppagent 需要 22.19+）"
command -v python3 >/dev/null || die "没有 python3"
docker info >/dev/null 2>&1  || die "Docker 没跑起来"
[ -f "./bin/agent.js" ]      || die "请在 ppagent 仓库根目录执行（找不到 bin/agent.js）"
[ -d "$TOKENIZER_DIR" ]      || die "tokenizer 目录不存在：$TOKENIZER_DIR
  需要包含 tokenizer.json / tokenizer_config.json。
  ppagent 默认 PPAGENT_TOKENIZER_LOCAL_ONLY=true，不会偷偷联网下载。"
# 服务端（omlx）拒绝 curl/python 的 TLS 握手，只放行 node 栈；ppagent 本体就是 node，
# 预检也必须用 node 探测，才与真实链路一致。
node -e '
  const [base, key] = process.argv.slice(1);
  fetch(base + "/models", { headers: key ? { Authorization: "Bearer " + key } : {}, signal: AbortSignal.timeout(10000) })
    .then(r => { if (!r.ok) { console.error("HTTP " + r.status); process.exit(1); } })
    .catch(e => { console.error(e.message); process.exit(1); });
' "$BASE_URL_HOST" "$API_KEY" \
  || die "连不上模型服务：${BASE_URL_HOST}/models（用 node 探测；curl 会被服务端 TLS 指纹拒绝）"
echo "  基础环境 ok"

# harbor 的任务筛选参数在不同版本里叫法不一样，自动探测
HARBOR_HELP="$(harbor run --help 2>&1 || true)"
TASK_FLAG="${TASK_FLAG:-}"
if [ -z "$TASK_FLAG" ]; then
  # --include-task-name 是 Harbor 0.20 从 dataset 里筛选 task 的参数；
  # --task 语义是「从 registry 引用 task 包 (org/name@ref)」，不是筛选，放最后避免误匹配。
  for cand in --include-task-name --task-ids --task-id --task-name --task-names --tasks --task; do
    grep -q -- "$cand" <<<"$HARBOR_HELP" && { TASK_FLAG="$cand"; break; }
  done
fi
[ -n "$TASK_FLAG" ] || {
  echo "没能自动认出任务筛选参数，harbor run --help 里跟 task 有关的行："
  grep -i task <<<"$HARBOR_HELP" || true
  die "手动设置：TASK_FLAG=--xxx ./probe/run_probe.sh ..."
}
echo "  任务筛选参数：$TASK_FLAG"
# --include-task-name 按 task 完整 name（org/name）匹配，裸 id 会报 No tasks matched。
# 前缀从本地 task.toml 的 [task] name 探测，避免硬编码；失败时兜底 terminal-bench。
TASK_PREFIX="${TASK_PREFIX:-}"
PROBE_DATASET_DIR="$(dirname "$PROBE_PY")/$(basename "$DATASET")"
if [ -z "$TASK_PREFIX" ] && [ -d "$PROBE_DATASET_DIR" ]; then
  TASK_PREFIX="$(python3 -c 'import tomllib,glob,os,sys
d = sys.argv[1]
fs = sorted(glob.glob(os.path.join(d, "*", "task.toml")))
if fs:
    t = tomllib.load(open(fs[0], "rb"))
    n = t.get("task", {}).get("name", "")
    if n:
        print(n.rsplit("/", 1)[0])
' "$PROBE_DATASET_DIR" 2>/dev/null || true)"
fi
TASK_PREFIX="${TASK_PREFIX:-terminal-bench}"
TASK_ARGS=()
for t in "${TASKS[@]}"; do
  case "$t" in */*) TASK_ARGS+=("$TASK_FLAG" "$t");; *) TASK_ARGS+=("$TASK_FLAG" "${TASK_PREFIX}/${t}");; esac
done
echo "  task 前缀：$TASK_PREFIX"

# ---------------------------------------------------------------- 1 协议自检
say "1/5 验证 Qwen3.8 的原生 tool calling"
PPAGENT_CUSTOM_BASE_URL="$BASE_URL_HOST" \
PPAGENT_CUSTOM_API_KEY="$API_KEY" \
  node bin/agent.js --check-compat --provider "$PROVIDER" --model "$MODEL_ID" \
  || die "工具调用协议不通。换模型 chat template 变了就会这样，先修这个，
  不然后面 3 道题会全零，你会误判成模型不行。"

# ---------------------------------------------------------------- 2 微基准
if [ "${SKIP_CALIBRATE:-0}" = "1" ]; then
  say "2/5 微基准：SKIP_CALIBRATE=1，复用 $OUT_DIR/calib.json"
  [ -f "$OUT_DIR/calib.json" ] || {
    echo "[fail] 复用需要 $OUT_DIR/calib.json，但文件不存在。去掉 SKIP_CALIBRATE 重跑微基准。"
    exit 1
  }
  echo "  复用上次标定：$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("decode %.1f tok/s, prefill %s"%(d.get("decode_tps_short",0), (d.get("prefill_curve") or [{}])[0].get("tps",0)))' "$OUT_DIR/calib.json" 2>/dev/null || echo '(读取失败)')"
else
  say "2/5 微基准：decode / prefill / effort（约 10-25 分钟）"
  # probe.py 走 python urllib，服务端同样拒它的 TLS 栈；起一个 node 本地代理转发，
  # python 打代理（无 TLS），代理用 node fetch 打上游（能过指纹）。SSE 流式原样透传。
  node "$(dirname "$PROBE_PY")/llm-proxy.js" "$BASE_URL_HOST" \
    >"$OUT_DIR/proxy.port" 2>"$OUT_DIR/proxy.log" &
  PROXY_PID=$!
  for _ in $(seq 1 50); do [ -s "$OUT_DIR/proxy.port" ] && break; sleep 0.2; done
  PROXY_PORT="$(head -1 "$OUT_DIR/proxy.port" 2>/dev/null || true)"
  if [ -z "$PROXY_PORT" ]; then
    echo "[warn] node 代理没起来，看 $OUT_DIR/proxy.log"
    kill "$PROXY_PID" 2>/dev/null || true
    exit 1
  fi
  echo "  node 代理 http://127.0.0.1:${PROXY_PORT} → ${BASE_URL_HOST}"
  set +e
  python3 "$PROBE_PY" calibrate \
    --base-url "http://127.0.0.1:${PROXY_PORT}" --model "$MODEL_ID" \
    --api-key "$API_KEY" \
    --out "$OUT_DIR/calib.json" | tee "$OUT_DIR/calibrate.log"
  PROXY_RC=${PIPESTATUS[0]}
  set -e
  kill "$PROXY_PID" 2>/dev/null || true
  [ "$PROXY_RC" -eq 0 ] || exit "$PROXY_RC"
fi

# ---------------------------------------------------------------- 3 oracle
if [ "$RUN_ORACLE" = "1" ]; then
  say "3/5 oracle 体检（不用模型，只跑官方解法；暴露 arm64/镜像问题）"
  ORACLE_T0=$(date +%s)
  harbor run -d "$DATASET" -a oracle "${TASK_ARGS[@]}" -n 1 \
    2>&1 | tee "$OUT_DIR/oracle.log" || echo "[warn] oracle 有失败，看上面"
  echo "  oracle 耗时 $(( $(date +%s) - ORACLE_T0 ))s"
  echo "  ↑ 这个数是你单题耗时的地板：模型再快也快不过环境本身"
else
  say "3/5 oracle 体检（RUN_ORACLE=0，跳过）"
fi

# ---------------------------------------------------------------- 4 正式三题
say "4/5 跑 3 道题（这一步最久，几小时）"
T0=$(date +%s)
API_KEY_AE=()
[ -n "$API_KEY" ] && API_KEY_AE=(--ae "PPAGENT_CUSTOM_API_KEY=$API_KEY")
# 对齐 agent.json 的可选 provider/loop 项：空值不传，避免给容器设空环境变量。
EXTRA_AE=()
[ -n "$MAX_OUTPUT_TOKENS" ] && EXTRA_AE+=(--ae "PPAGENT_MAX_OUTPUT_TOKENS=$MAX_OUTPUT_TOKENS")
[ -n "$REQUEST_TIMEOUT_MS" ] && EXTRA_AE+=(--ae "PPAGENT_REQUEST_TIMEOUT_MS=$REQUEST_TIMEOUT_MS")
[ -n "$MAX_RETRIES" ] && EXTRA_AE+=(--ae "PPAGENT_MAX_RETRIES=$MAX_RETRIES")
MAX_TURNS_AK=()
[ -n "$MAX_TURNS" ] && MAX_TURNS_AK=(--ak "max_turns=$MAX_TURNS")
PYTHONPATH="$(pwd)" harbor run -d "$DATASET" \
  -a "$AGENT" \
  -m "$HARBOR_MODEL" \
  "${TASK_ARGS[@]}" \
  --ae PPAGENT_CUSTOM_BASE_URL="$BASE_URL_CONTAINER" \
  --ae PPAGENT_TOKENIZER=/tokenizer \
  --ae PPAGENT_TOKENIZER_LOCAL_ONLY=true \
  --ae PPAGENT_EFFORT="$EFFORT" \
  --ae PPAGENT_MAX_TOKENS="$CTX_WINDOW" \
  --ae PPAGENT_TURN_TIMEOUT_MS="$TURN_TIMEOUT_MS" \
  --ae PPAGENT_SANDBOX_NETWORK_ALLOWLIST="$NET_ALLOW" \
  "${EXTRA_AE[@]}" \
  "${MAX_TURNS_AK[@]}" \
  "${API_KEY_AE[@]}" \
  --allow-agent-host host.docker.internal \
  --mounts "[{\"type\":\"bind\",\"source\":\"$(cd "$TOKENIZER_DIR" && pwd)\",\"target\":\"/tokenizer\",\"read_only\":true}]" \
  -n "$N_CONCURRENT" \
  2>&1 | tee "$OUT_DIR/harbor.log"
WALL=$(( $(date +%s) - T0 ))
echo "  3 题总墙钟：${WALL}s ($((WALL/60)) 分钟)"

JOB_DIR="$(ls -td ./jobs/*/ 2>/dev/null | head -1 || true)"
[ -n "$JOB_DIR" ] || die "找不到 ./jobs 下的输出目录，手动指定后跑 parse"
echo "  job: $JOB_DIR"

# ---------------------------------------------------------------- 5 解析外推
say "5/5 解析 + 外推"
python3 "$PROBE_PY" inspect "$JOB_DIR" > "$OUT_DIR/schema.txt" 2>&1 || true
echo "  事件 schema 已存到 $OUT_DIR/schema.txt"

python3 "$PROBE_PY" parse "$JOB_DIR" --out "$OUT_DIR/probe.json" \
  | tee "$OUT_DIR/parse.log"

python3 "$PROBE_PY" estimate \
  --calib "$OUT_DIR/calib.json" \
  --probe "$OUT_DIR/probe.json" \
  --total-wall-s "$WALL" \
  --tasks 89 --attempts 1 --speedup 1.3 \
  | tee "$OUT_DIR/estimate.log"

say "完成"
echo "产物都在 $OUT_DIR/：calib.json / probe.json / estimate.log / schema.txt"
echo
echo "如果 parse 那步有 [warn] 说没解析出 token："
echo "  1. cat $OUT_DIR/schema.txt 看真实字段名"
echo "  2. 把字段名补进 probe.py 顶部的 KEYS_* 列表"
echo "  3. 重跑 parse + estimate 即可，不用再跑一遍 harbor"
