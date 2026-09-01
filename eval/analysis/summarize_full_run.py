"""Summarise a full 69-task run: pass rate, difficulty split, failure shapes."""
import glob
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime

JOB = sys.argv[1] if len(sys.argv) > 1 else "jobs/2026-08-09__17-26-07"
meta = json.load(open("benchmarks/tb2_tasks.json"))

rows = []
for d in sorted(glob.glob(f"{JOB}/*__*")):
    task = os.path.basename(d).rsplit("__", 1)[0]
    r = json.load(open(f"{d}/result.json"))
    reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    exc = str(r.get("exception_info") or "")
    kind = ("AgentTO" if "AgentTimeout" in exc else
            "VerifTO" if "VerifierTimeout" in exc else
            "EXC" if exc else "")
    mins = None
    if r.get("started_at") and r.get("finished_at"):
        a = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
        b = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))
        mins = (b - a).total_seconds() / 60

    sub = ""
    p = f"{d}/verifier/test-stdout.txt"
    if os.path.exists(p):
        m = re.findall(r"=+\s+([0-9]+ (?:failed|passed)[^=]*?)\s+=+",
                       open(p, errors="replace").read())
        sub = m[-1].strip()[:30] if m else ""

    iters = stalls = long_gens = autobg = bg = 0
    maxgen = 0.0
    tp = f"{d}/agent/_trace_builder.jsonl"
    if os.path.exists(tp):
        for line in open(tp):
            if not line.strip():
                continue
            e = json.loads(line)
            ev = e["event"]
            if ev == "iteration":
                iters += 1
            elif ev == "llm_response":
                g = e.get("gen_s") or 0
                maxgen = max(maxgen, g)
                if g > 300:
                    long_gens += 1
            elif ev == "error" and e.get("type") == "stream_stalled":
                stalls += 1
            elif ev == "tool_call":
                if "moved to background" in e.get("result", ""):
                    autobg += 1
                if e["tool"] == "run_bash" and '"background": true' in e.get("args", ""):
                    bg += 1
    rows.append(dict(task=task, reward=reward, kind=kind, mins=mins, sub=sub,
                     diff=meta.get(task, {}).get("difficulty", "?"), iters=iters,
                     stalls=stalls, long_gens=long_gens, maxgen=maxgen,
                     autobg=autobg, bg=bg))

passed = [r for r in rows if r["reward"] == 1.0]
print(f"===== {JOB} | model=qwen3.7-plus | streaming ON =====")
print(f"PASS {len(passed)}/{len(rows)} = {len(passed)/len(rows)*100:.1f}%\n")

print("--- pass rate by difficulty ---")
for d in ("easy", "medium", "hard"):
    sub = [r for r in rows if r["diff"] == d]
    if sub:
        n = sum(1 for r in sub if r["reward"] == 1.0)
        print(f"  {d:8} {n:2d}/{len(sub):2d}  {n/len(sub)*100:5.1f}%")

print("\n--- PASSED ---")
for r in sorted(passed, key=lambda x: x["task"]):
    print(f"  {r['diff']:8} {r['mins']:5.1f}m  {r['task']}")

print("\n--- FAILED ---")
for r in sorted([r for r in rows if r["reward"] != 1.0], key=lambda x: x["task"]):
    print(f"  {r['diff']:8} {r['mins']:5.1f}m  {r['task']:32} {r['kind']:8} {r['sub']}")

print("\n--- streaming mechanism ---")
print(f"  generations >300s (would have died on the old 300s timeout): "
      f"{sum(r['long_gens'] for r in rows)}")
print(f"  slowest single generation: {max(r['maxgen'] for r in rows):.0f}s "
      f"({max(rows, key=lambda r: r['maxgen'])['task']})")
print(f"  stream stalls / cap hits: {sum(r['stalls'] for r in rows)}")
print(f"  auto-backgrounded commands: {sum(r['autobg'] for r in rows)}")
print(f"  explicit background=true: {sum(r['bg'] for r in rows)}")
print(f"  timeouts: agent={sum(1 for r in rows if r['kind']=='AgentTO')} "
      f"verifier={sum(1 for r in rows if r['kind']=='VerifTO')}")
print(f"  total iterations: {sum(r['iters'] for r in rows)}")
mm = sorted(r["mins"] for r in rows if r["mins"])
print(f"  median task runtime: {mm[len(mm)//2]:.1f}m")
