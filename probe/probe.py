#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe.py — ppagent x Terminal-Bench 三题标定与外推

只依赖标准库。四个子命令：

  calibrate  对本地 OpenAI-compatible 端点做微基准，量出真实的
             decode tps / prefill tps(随上下文变化) / thinking token 放大倍数
  inspect    扫描 harbor job 目录，打印 events.jsonl 的事件类型与字段结构
             （换 schema 时先跑这个，不用改代码就能确认字段名）
  parse      从 events.jsonl 提取每题的 O / P_incr / T_tool / turns / compact ...
  estimate   calib + probe -> 全量跑完的时间外推，带敏感性分析
  selftest   用合成数据自检 parse+estimate 链路，不需要任何外部依赖

用法见文件末尾 __main__ 或 `python3 probe.py -h`
"""

import argparse
import json
import math
import os
import random
import statistics
import string
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

# --------------------------------------------------------------------------
# 通用工具
# --------------------------------------------------------------------------

# 字段名候选表。ppagent 的 UIEvent schema 如果和这里对不上，
# 只要往对应列表里加一个名字就行，不用改逻辑。
KEYS_PROMPT = ["prompt_tokens", "input_tokens", "promptTokens", "inputTokens",
               "prompt", "in_tokens", "input"]
KEYS_COMPLETION = ["completion_tokens", "output_tokens", "completionTokens",
                   "outputTokens", "completion", "out_tokens", "output"]
KEYS_CACHED = ["cached_tokens", "cache_read_input_tokens", "cachedTokens",
               "cache_read_tokens", "cacheReadTokens", "prompt_cache_hit_tokens",
               "cacheRead"]
KEYS_REASONING = ["reasoning_tokens", "reasoningTokens", "thinking_tokens"]
KEYS_TS = ["ts", "timestamp", "time", "at", "epochMs", "startedAt", "endedAt"]
KEYS_DURATION = ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms",
                 "tookMs", "took_ms", "durationSec", "duration"]
KEYS_CALLID = ["callId", "call_id", "toolCallId", "tool_call_id", "id"]


def deep_find(obj, names, _depth=0):
    """在嵌套 dict/list 里广度优先找第一个命中的键。schema 无关。"""
    if _depth > 8:
        return None
    if isinstance(obj, dict):
        for n in names:
            if n in obj and obj[n] is not None:
                return obj[n]
        for v in obj.values():
            r = deep_find(v, names, _depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = deep_find(v, names, _depth + 1)
            if r is not None:
                return r
    return None


def as_seconds(v):
    """把各种时间戳表示统一成 float 秒。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        if f > 1e17:      # 纳秒
            return f / 1e9
        if f > 1e14:      # 微秒
            return f / 1e6
        if f > 1e11:      # 毫秒
            return f / 1e3
        return f          # 秒
    if isinstance(v, str):
        s = v.strip().replace("Z", "+00:00")
        try:
            import datetime
            return datetime.datetime.fromisoformat(s).timestamp()
        except Exception:
            try:
                return float(s)
            except Exception:
                return None
    return None


def ev_type(ev):
    for k in ("type", "event", "kind", "name"):
        v = ev.get(k)
        if isinstance(v, str):
            return v
    return ""


def fmt_hms(seconds):
    if seconds is None or seconds != seconds:
        return "n/a"
    seconds = int(round(seconds))
    d, r = divmod(seconds, 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    if d:
        return f"{d}天{h}小时{m}分"
    if h:
        return f"{h}小时{m}分"
    return f"{m}分{s}秒"


# --------------------------------------------------------------------------
# calibrate：微基准
# --------------------------------------------------------------------------

def post_stream(url, payload, api_key=None, timeout=1800):
    """流式 POST，返回 TTFT / 末 token 时间 / usage。TTFT 近似等于 prefill 耗时。"""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    t0 = time.perf_counter()
    ttft = None
    t_last = None
    usage = None
    n_chunks = 0
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            body = line[5:].strip()
            if body == "[DONE]":
                break
            try:
                obj = json.loads(body)
            except Exception:
                continue
            if obj.get("usage"):
                usage = obj["usage"]
            for ch in (obj.get("choices") or []):
                d = ch.get("delta") or {}
                piece = (d.get("content") or d.get("reasoning_content")
                         or d.get("reasoning") or "")
                if piece:
                    now = time.perf_counter()
                    if ttft is None:
                        ttft = now - t0
                    t_last = now - t0
                    n_chunks += 1
    return {"t_total": time.perf_counter() - t0, "ttft": ttft,
            "t_last": t_last, "usage": usage, "chunks": n_chunks}


def filler(approx_tokens):
    """生成大致 approx_tokens 个 token 的填充文本。开头塞一个随机 UUID，
    保证不同次调用没有公共前缀，避免 prefix cache 把 prefill 测量打穿。"""
    rnd = random.Random()
    words = []
    # 常见英文词大致 1 token/词，保守按 1.05 估
    n = int(approx_tokens / 1.05)
    vocab = ["system", "config", "buffer", "handler", "resolve", "packet",
             "module", "thread", "socket", "kernel", "matrix", "vector",
             "cache", "record", "stream", "branch", "commit", "target"]
    for _ in range(max(1, n)):
        words.append(rnd.choice(vocab))
    return f"session-{uuid.uuid4()} " + " ".join(words)


def cmd_calibrate(args):
    url = args.base_url.rstrip("/") + "/chat/completions"
    out = {"base_url": args.base_url, "model": args.model,
           "measured_at": time.strftime("%Y-%m-%d %H:%M:%S"), "runs": []}

    def call(tag, prompt, max_tokens, extra=None):
        payload = {"model": args.model, "temperature": 0,
                   "messages": [{"role": "user", "content": prompt}],
                   "max_tokens": max_tokens, "stream": True,
                   "stream_options": {"include_usage": True}}
        if extra:
            payload.update(extra)
        try:
            r = post_stream(url, payload, args.api_key, args.timeout)
        except urllib.error.HTTPError as e:
            # 有的服务端不认 stream_options，退化重试
            payload.pop("stream_options", None)
            sys.stderr.write(f"[warn] {tag}: {e}; 去掉 stream_options 重试\n")
            r = post_stream(url, payload, args.api_key, args.timeout)
        r["tag"] = tag
        out["runs"].append(r)
        return r

    print("== 1/4 decode 速率（短上下文）==")
    r = call("decode_short",
             "Print the integers from 1 to 400, one per line, nothing else.",
             args.gen)
    ct = (r["usage"] or {}).get("completion_tokens") or r["chunks"]
    if r["ttft"] is not None and r["t_last"] and r["t_last"] > r["ttft"] and ct > 1:
        out["decode_tps_short"] = (ct - 1) / (r["t_last"] - r["ttft"])
    print(f"   completion_tokens={ct} ttft={r['ttft']:.2f}s "
          f"decode={out.get('decode_tps_short', float('nan')):.1f} tok/s")

    print("== 2/4 prefill 速率（随上下文长度变化）==")
    out["prefill_curve"] = []
    for n in args.ctx:
        p = filler(n) + "\n\nReply with the single word: ok"
        r = call(f"prefill_{n}", p, 1)
        pt = (r["usage"] or {}).get("prompt_tokens")
        if pt and r["ttft"]:
            tps = pt / r["ttft"]
            out["prefill_curve"].append({"prompt_tokens": pt,
                                         "ttft_s": r["ttft"], "tps": tps})
            print(f"   prompt_tokens={pt:>7} ttft={r['ttft']:>7.2f}s "
                  f"prefill={tps:>7.1f} tok/s")
        else:
            print(f"   [warn] ctx={n} 没拿到 usage/ttft，跳过")

    print("== 3/4 decode 速率（长上下文，KV 压力下）==")
    long_ctx = max(args.ctx) if args.ctx else 32000
    p = filler(long_ctx) + "\n\nNow print the integers from 1 to 200, one per line."
    r = call("decode_long", p, 300)
    ct = (r["usage"] or {}).get("completion_tokens") or r["chunks"]
    if r["ttft"] is not None and r["t_last"] and r["t_last"] > r["ttft"] and ct > 1:
        out["decode_tps_long"] = (ct - 1) / (r["t_last"] - r["ttft"])
        print(f"   ctx≈{long_ctx} decode={out['decode_tps_long']:.1f} tok/s "
              f"(短上下文的 {out['decode_tps_long'] / max(out.get('decode_tps_short', 1), 1e-9):.0%})")

    print("== 4/4 reasoning_effort 对输出量的放大倍数 ==")
    task = ("You are a terminal agent. A python script fails with "
            "'ModuleNotFoundError: No module named requests' inside a container. "
            "Plan the shell commands you would run to diagnose and fix it, "
            "then state the final command list.")
    out["effort"] = {}
    for lvl in args.effort_levels:
        extra = None if lvl == "default" else {"reasoning_effort": lvl}
        try:
            r = call(f"effort_{lvl}", task, 3000, extra)
        except Exception as e:
            print(f"   [warn] effort={lvl} 失败：{e}")
            continue
        u = r["usage"] or {}
        ct = u.get("completion_tokens") or r["chunks"]
        rt = deep_find(u, KEYS_REASONING)
        out["effort"][lvl] = {"completion_tokens": ct, "reasoning_tokens": rt,
                              "wall_s": r["t_total"]}
        print(f"   effort={lvl:<8} completion={ct:>6} "
              f"reasoning={rt if rt is not None else '-':>6} "
              f"wall={r['t_total']:.1f}s")

    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n已写出 {args.out}")
    return 0


# --------------------------------------------------------------------------
# inspect / parse：解析 harbor 产物
# --------------------------------------------------------------------------

def find_event_files(root):
    root = Path(root)
    files = sorted(root.rglob("events.jsonl"))
    if not files:  # 兜底：任何 jsonl
        files = [p for p in sorted(root.rglob("*.jsonl"))
                 if p.stat().st_size > 0]
    return files


def load_events(path):
    evs = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                evs.append(json.loads(line))
            except Exception:
                continue
    return evs


def cmd_inspect(args):
    files = find_event_files(args.jobs_dir)
    if not files:
        print(f"在 {args.jobs_dir} 下没找到 events.jsonl")
        return 1
    print(f"找到 {len(files)} 个事件文件\n")
    for p in files[:args.max_files]:
        evs = load_events(p)
        print(f"--- {p}  ({len(evs)} 行) ---")
        seen = {}
        for e in evs:
            t = ev_type(e) or "<no-type>"
            seen.setdefault(t, [0, e])
            seen[t][0] += 1
        for t, (cnt, sample) in sorted(seen.items(), key=lambda kv: -kv[1][0]):
            keys = ",".join(sorted(sample.keys()))
            print(f"  {t:<24} x{cnt:<5} keys: {keys}")
            if args.samples:
                s = json.dumps(sample, ensure_ascii=False)
                print(f"      {s[:400]}")
        print()
    print("提示：如果 token / 时间戳字段名不在 probe.py 顶部的 KEYS_* 里，"
          "把名字补进去即可，逻辑不用改。")
    return 0


def parse_trial(path):
    """从一个 trial 的 events.jsonl 提取指标。"""
    evs = load_events(path)
    m = {
        "file": str(path),
        "task": path.parent.name,
        "turns": 0, "O": 0, "P_full": 0, "P_incr": 0,
        "reasoning_tokens": 0,
        "cached_reported": False,
        "tool_calls": 0, "T_tool": 0.0,
        "compacts": 0, "admission_denied": 0,
        "t_first": None, "t_last": None, "wall_s": None,
        "loop_end_reason": None,
    }
    prev_prompt = None
    open_tools = {}
    order_stack = []

    for e in evs:
        t = ev_type(e).lower()
        ts = as_seconds(deep_find(e, KEYS_TS))
        if ts:
            if m["t_first"] is None:
                m["t_first"] = ts
            m["t_last"] = ts

        if "turn_end" in t or "turn_complete" in t or t == "usage":
            pt = deep_find(e, KEYS_PROMPT)
            ct = deep_find(e, KEYS_COMPLETION)
            cached = deep_find(e, KEYS_CACHED)
            rt = deep_find(e, KEYS_REASONING)
            if not isinstance(pt, (int, float)) or not isinstance(ct, (int, float)):
                continue
            m["turns"] += 1
            m["O"] += int(ct)
            if isinstance(cached, (int, float)):
                m["cached_reported"] = True
                # ppagent 的 usage 口径（见 src/core/llm/pi-ai.ts 与 benchmark/harbor/ppagent.py）：
                #   input = 本轮新增 prefill（不是累计 prompt_tokens）
                #   cacheRead = 本轮命中缓存的量
                # 所以真实被计算的 prefill = sum(input)；完全不缓存的全量 = sum(input + cacheRead)。
                m["P_incr"] += max(0, int(pt))
                m["P_full"] += max(0, int(pt) + int(cached))
            else:
                if prev_prompt is None:
                    m["P_incr"] += int(pt)
                elif pt >= prev_prompt:
                    m["P_incr"] += int(pt) - prev_prompt
                else:
                    # 上下文变短 = 发生过 compact，前缀缓存作废，整段重算
                    m["P_incr"] += int(pt)
                m["P_full"] += int(pt)
            prev_prompt = int(pt)

        elif "compact" in t:
            m["compacts"] += 1
            prev_prompt = None

        elif "admission" in t and ("deny" in t or "denied" in t or "reject" in t):
            m["admission_denied"] += 1

        elif "tool_start" in t or "tool_begin" in t or t == "tool_call":
            cid = deep_find(e, KEYS_CALLID)
            if ts:
                if cid:
                    open_tools[str(cid)] = ts
                else:
                    order_stack.append(ts)

        elif "tool_end" in t or "tool_result" in t:
            m["tool_calls"] += 1
            dur = deep_find(e, KEYS_DURATION)
            if isinstance(dur, (int, float)):
                d = float(dur)
                m["T_tool"] += d / 1000.0 if d > 1000 else d
                continue
            cid = deep_find(e, KEYS_CALLID)
            start = None
            if cid and str(cid) in open_tools:
                start = open_tools.pop(str(cid))
            elif order_stack:
                start = order_stack.pop(0)
            if start and ts:
                m["T_tool"] += max(0.0, ts - start)

        elif "loop_end" in t:
            r = deep_find(e, ["reason", "stopReason", "stop_reason", "cause"])
            if isinstance(r, str):
                m["loop_end_reason"] = r

    if m["t_first"] and m["t_last"]:
        m["wall_s"] = m["t_last"] - m["t_first"]
    return m


def find_reward(events_path):
    """从 events.jsonl 向上找最近的 result.json，捞出 reward。

    harbor 的 result.json 会把敏感项写成字面 [REDACTED]，不是合法 JSON，
    整体解析失败时退化为正则抠 reward/score 数字。
    """
    import re
    cur = events_path.parent
    for _ in range(6):
        p = cur / "result.json"
        if p.exists():
            text = p.read_text(encoding="utf-8", errors="ignore")
            try:
                obj = json.loads(text)
                r = deep_find(obj, ["reward", "score", "resolved", "passed", "is_resolved"])
                if r is not None:
                    return r
            except Exception:
                for key in ("reward", "score", "resolved", "passed"):
                    m = re.search(rf'"{key}"\s*:\s*(true|false|\d+\.?\d*)', text)
                    if m:
                        v = m.group(1).lower()
                        return True if v == "true" else (False if v == "false" else float(v))
        cur = cur.parent
    return None


def cmd_parse(args):
    files = find_event_files(args.jobs_dir)
    if not files:
        print(f"在 {args.jobs_dir} 下没找到 events.jsonl")
        return 1
    rows = []
    for p in files:
        m = parse_trial(p)
        m["reward"] = find_reward(p)
        rows.append(m)

    print(f"{'task':<34}{'turns':>6}{'O':>9}{'P_incr':>10}{'P_full':>10}"
          f"{'tools':>6}{'T_tool':>9}{'wall':>9}{'cmpt':>5}{'reward':>8}")
    for m in rows:
        print(f"{m['task'][:33]:<34}{m['turns']:>6}{m['O']:>9}{m['P_incr']:>10}"
              f"{m['P_full']:>10}{m['tool_calls']:>6}"
              f"{m['T_tool']:>8.0f}s{(m['wall_s'] or 0):>8.0f}s"
              f"{m['compacts']:>5}{str(m['reward'])[:7]:>8}")

    bad = [m for m in rows if m["turns"] == 0]
    if bad:
        print(f"\n[warn] {len(bad)} 个 trial 没解析出 token。"
              f"先跑 `python3 probe.py inspect {args.jobs_dir} --samples` 看字段名，"
              f"再把字段名补进 probe.py 顶部的 KEYS_*。")
    if rows and not rows[0]["cached_reported"]:
        print("[note] 事件里没有 cached_tokens 字段，P_incr 用的是"
              "「prompt_tokens 逐轮增量」估算法，属于下界；"
              "服务端如果没开 prefix cache，真实 prefill 量接近 P_full。")

    Path(args.out).write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(f"\n已写出 {args.out}")
    return 0


# --------------------------------------------------------------------------
# estimate：外推
# --------------------------------------------------------------------------

def prefill_rate_at(curve, ctx_tokens, fallback):
    if not curve:
        return fallback
    pts = sorted(curve, key=lambda d: d["prompt_tokens"])
    if ctx_tokens <= pts[0]["prompt_tokens"]:
        return pts[0]["tps"]
    if ctx_tokens >= pts[-1]["prompt_tokens"]:
        return pts[-1]["tps"]
    for a, b in zip(pts, pts[1:]):
        if a["prompt_tokens"] <= ctx_tokens <= b["prompt_tokens"]:
            f = (ctx_tokens - a["prompt_tokens"]) / max(
                1, b["prompt_tokens"] - a["prompt_tokens"])
            return a["tps"] + f * (b["tps"] - a["tps"])
    return pts[-1]["tps"]


def cmd_estimate(args):
    calib = json.loads(Path(args.calib).read_text()) if Path(args.calib).exists() else {}
    rows = json.loads(Path(args.probe).read_text())
    rows = [r for r in rows if r.get("turns")]
    if not rows:
        print("probe 里没有有效 trial，先修 parse")
        return 1

    decode = args.decode_tps or calib.get("decode_tps_long") \
        or calib.get("decode_tps_short") or 15.0
    curve = calib.get("prefill_curve") or []
    cap_s = args.task_timeout_min * 60

    print("=== 输入参数 ===")
    print(f"decode        {decode:.1f} tok/s"
          f"{'（--decode-tps 覆盖）' if args.decode_tps else '（来自 calibrate）'}")
    if curve:
        print("prefill 曲线  " + ", ".join(
            f"{c['prompt_tokens']//1000}K:{c['tps']:.0f}" for c in curve))
    else:
        print(f"prefill       {args.prefill_tps:.0f} tok/s（无标定曲线，用默认值）")
    print(f"样本题数      {len(rows)}   外推目标 {args.tasks} 题 x {args.attempts} 次")
    print(f"单题上限      {args.task_timeout_min} 分钟   有效并发加速 {args.speedup}x\n")

    print("=== 逐题：预测 vs 实测 ===")
    print(f"{'task':<30}{'T_decode':>10}{'T_prefill':>11}{'T_tool':>9}"
          f"{'T_pred':>9}{'T_wall':>9}{'kappa':>8}")
    kappas, preds = [], []
    for m in rows:
        avg_ctx = m["P_full"] / max(1, m["turns"])
        pf = prefill_rate_at(curve, avg_ctx, args.prefill_tps)
        t_dec = m["O"] / decode
        t_pre = m["P_incr"] / pf
        t_tool = m["T_tool"]
        t_pred = t_dec + t_pre + t_tool
        preds.append(t_pred)
        k = (m["wall_s"] / t_pred) if (m.get("wall_s") and t_pred > 0) else None
        if k:
            kappas.append(k)
        print(f"{m['task'][:29]:<30}{t_dec/60:>9.1f}m{t_pre/60:>10.1f}m"
              f"{t_tool/60:>8.1f}m{t_pred/60:>8.1f}m"
              f"{(m['wall_s']/60 if m.get('wall_s') else float('nan')):>8.1f}m"
              f"{(k if k else float('nan')):>8.2f}")

    if kappas:
        kappa = statistics.median(kappas)
    elif args.total_wall_s and sum(preds) > 0:
        kappa = args.total_wall_s / sum(preds)
        print(f"\n[note] 事件里没有可用时间戳，kappa 用 --total-wall-s "
              f"({args.total_wall_s:.0f}s) 除以预测总和得到")
    else:
        kappa = 1.0
        print("\n[note] 既没有事件时间戳也没给 --total-wall-s，kappa 取 1.0，"
              "外推会低估 harbor/容器那部分开销")
    print(f"\nkappa（实测/预测，吃掉 HTTP、容器启动、harbor 开销）= {kappa:.2f}")
    if kappas and (kappa < 0.8 or kappa > 1.6):
        print("  ⚠ kappa 偏离 1 较多：要么事件时间戳口径不对，"
              "要么有一大块时间没被三项覆盖（比如镜像拉取、模型排队）。")

    eff = [min(p * kappa, cap_s) for p in preds]
    capped = sum(1 for p in preds if p * kappa > cap_s)
    if capped:
        print(f"  {capped}/{len(preds)} 题预测超过单题上限，已截到 {args.task_timeout_min} 分钟")

    lo, mid, hi = min(eff), statistics.median(eff), max(eff)
    total = args.tasks * args.attempts / args.speedup

    print("\n=== 外推：跑完全量 ===")
    print(f"{'口径':<18}{'单题':>10}{'总时长':>16}")
    for name, v in (("乐观(样本最快)", lo), ("中位", mid), ("悲观(样本最慢)", hi)):
        print(f"{name:<18}{v/60:>9.0f}m{fmt_hms(v*total):>18}")

    def median_task_time(o_scale=1.0, dec=None, pre=None):
        dec = dec or decode
        vals = []
        for m in rows:
            avg_ctx = m["P_full"] / max(1, m["turns"])
            pf = pre or prefill_rate_at(curve, avg_ctx, args.prefill_tps)
            t = (m["O"] * o_scale) / dec + m["P_incr"] / pf + m["T_tool"]
            vals.append(min(t * kappa, cap_s))
        return statistics.median(vals)

    n_runs = args.tasks * args.attempts
    print("\n=== 敏感性（中位口径，均为跑完全量）===")
    scen = [
        (f"当前设置，串行", mid * n_runs),
        (f"当前设置，并发 2（Mac 实测约 1.3x）", mid * n_runs / 1.3),
        (f"effort 降一档，输出 token 减半", median_task_time(o_scale=0.5) * n_runs / args.speedup),
        (f"换成 3 次重复出置信区间", mid * args.tasks * 3 / args.speedup),
        (f"租卡：decode 80 / prefill 2000",
         median_task_time(dec=80.0, pre=2000.0) * args.tasks * 3 / 8.0),
    ]
    for name, v in scen:
        print(f"{name:<34}{fmt_hms(v):>18}")
    print("  （租卡那行按 3 次重复 + 并发 8 算）")

    print("\n=== 提醒 ===")
    print(f"- {len(rows)} 道题的样本量极小，Terminal-Bench 的任务耗时是长尾分布，"
          f"真实值大概率落在「悲观」一侧。")
    print("- 上面没有算首次镜像拉取/构建的时间，89 道题预留几小时和 150GB+ 磁盘。")
    to = [m for m in rows if (m.get('loop_end_reason') or '').lower().find('timeout') >= 0]
    if to:
        print(f"- {len(to)} 道样本题是超时结束的：这时候分数反映的是速度不是能力，"
              f"先调 turnTimeoutMs 或降 effort 再谈分数。")
    return 0


# --------------------------------------------------------------------------
# selftest
# --------------------------------------------------------------------------

def cmd_selftest(args):
    base = Path(args.dir)
    rnd = random.Random(7)
    for ti, task in enumerate(["easy-task", "medium-task", "hard-task"]):
        d = base / "trials" / task
        d.mkdir(parents=True, exist_ok=True)
        t = 1_760_000_000.0
        lines = []
        prompt = 3000 + ti * 2000
        turns = 6 + ti * 8
        for i in range(turns):
            t += 1
            lines.append({"type": "tool_start", "ts": t, "callId": f"c{i}"})
            t += 5 + ti * 20 * rnd.random()
            lines.append({"type": "tool_end", "ts": t, "callId": f"c{i}"})
            prompt += 1500 + int(1200 * rnd.random())
            comp = 900 + int(1500 * rnd.random()) + ti * 400
            t += comp / 15.0
            lines.append({"type": "turn_end", "ts": t,
                          "usage": {"prompt_tokens": prompt,
                                    "completion_tokens": comp}})
            if prompt > 60000:
                t += 20
                lines.append({"type": "context:compacted", "ts": t})
                prompt = 20000
        lines.append({"type": "loop_end", "ts": t + 1, "reason": "done"})
        with open(d / "events.jsonl", "w") as f:
            for o in lines:
                f.write(json.dumps(o) + "\n")
        (d / "result.json").write_text(json.dumps({"reward": ti == 0}))

    calib = {"decode_tps_short": 15.4, "decode_tps_long": 12.9,
             "prefill_curve": [{"prompt_tokens": 4000, "ttft_s": 16.0, "tps": 250.0},
                               {"prompt_tokens": 16000, "ttft_s": 80.0, "tps": 200.0},
                               {"prompt_tokens": 64000, "ttft_s": 460.0, "tps": 139.0}]}
    (base / "calib.json").write_text(json.dumps(calib, indent=2))
    print(f"已生成合成数据于 {base}\n")

    ns = argparse.Namespace(jobs_dir=str(base), out=str(base / "probe.json"))
    cmd_parse(ns)
    print()
    ns2 = argparse.Namespace(calib=str(base / "calib.json"),
                             probe=str(base / "probe.json"),
                             decode_tps=None, prefill_tps=200.0, tasks=89,
                             attempts=1, speedup=1.3, task_timeout_min=120,
                             total_wall_s=None)
    return cmd_estimate(ns2)


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="ppagent x Terminal-Bench 三题标定")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("calibrate", help="微基准：decode/prefill/effort")
    c.add_argument("--base-url", default=os.environ.get(
        "PPAGENT_CUSTOM_BASE_URL", "http://localhost:1234/v1"))
    c.add_argument("--model", default=os.environ.get("PPAGENT_MODEL", "qwen3.8-27b"))
    c.add_argument("--api-key", default=os.environ.get("PPAGENT_CUSTOM_API_KEY"))
    c.add_argument("--ctx", type=int, nargs="+", default=[4000, 16000, 64000])
    c.add_argument("--gen", type=int, default=600)
    c.add_argument("--effort-levels", nargs="+", default=["low", "medium"])
    c.add_argument("--timeout", type=int, default=1800)
    c.add_argument("--out", default="calib.json")
    c.set_defaults(func=cmd_calibrate)

    c = sub.add_parser("inspect", help="打印 events.jsonl 的事件类型与字段")
    c.add_argument("jobs_dir")
    c.add_argument("--samples", action="store_true")
    c.add_argument("--max-files", type=int, default=3)
    c.set_defaults(func=cmd_inspect)

    c = sub.add_parser("parse", help="提取每题的 O / P_incr / T_tool")
    c.add_argument("jobs_dir")
    c.add_argument("--out", default="probe.json")
    c.set_defaults(func=cmd_parse)

    c = sub.add_parser("estimate", help="外推全量耗时")
    c.add_argument("--calib", default="calib.json")
    c.add_argument("--probe", default="probe.json")
    c.add_argument("--decode-tps", type=float, default=None)
    c.add_argument("--prefill-tps", type=float, default=200.0)
    c.add_argument("--tasks", type=int, default=89)
    c.add_argument("--attempts", type=int, default=1)
    c.add_argument("--speedup", type=float, default=1.3,
                   help="有效并发加速比。Mac 上 -n 2 实测通常 1.2~1.5")
    c.add_argument("--task-timeout-min", type=float, default=120)
    c.add_argument("--total-wall-s", type=float, default=None,
                   help="3 题那次 harbor run 的总墙钟秒数；事件里没有时间戳时用它算 kappa")
    c.set_defaults(func=cmd_estimate)

    c = sub.add_parser("selftest", help="合成数据自检，不碰外部依赖")
    c.add_argument("--dir", default="./_selftest")
    c.set_defaults(func=cmd_selftest)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
