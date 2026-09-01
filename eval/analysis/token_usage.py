"""Token consumption of a 40-task run.

pi records real usage per assistant message (input/output/cacheRead/reasoning).
The harness has no usage field, so its input side is reconstructed from the
context size logged at each iteration — an estimate, and labelled as such.
"""
import glob
import json
import os
import sys
from collections import Counter

PI_JOBS = {
    "pi-v2 (2026-08-16 11:51)": "jobs/2026-08-16__11-51-28",
    "pi-v2 (2026-08-16 14:35)": "jobs/2026-08-16__14-35-38",
    "pi-v1 (2026-08-15)": "jobs/2026-08-15__14-40-03",
}
HARNESS_JOB = "jobs/2026-08-08__14-41-46"


def pi_usage(job):
    total = Counter()
    per_task = []
    for d in sorted(glob.glob(f"{job}/*__*")):
        task = os.path.basename(d).rsplit("__", 1)[0]
        sess = glob.glob(f"{d}/agent/*.jsonl")
        if not sess:
            continue
        t = Counter()
        for line in open(sess[0]):
            if not line.strip():
                continue
            e = json.loads(line)
            if e.get("type") != "message":
                continue
            u = e["message"].get("usage")
            if not u:
                continue
            t["calls"] += 1
            for k in ("input", "output", "cacheRead", "cacheWrite", "reasoning"):
                t[k] += u.get(k, 0) or 0
        if t:
            per_task.append((t["input"] + t["output"], task, t))
            total.update(t)
    return total, per_task


def harness_estimate(job):
    """Sum of context size at each iteration ~= prompt tokens billed."""
    total_in = 0
    calls = 0
    per_task = []
    for d in sorted(glob.glob(f"{job}/*__*")):
        task = os.path.basename(d).rsplit("__", 1)[0]
        p = f"{d}/agent/_trace_builder.jsonl"
        if not os.path.exists(p):
            continue
        s = 0
        c = 0
        for line in open(p):
            e = json.loads(line)
            if e["event"] == "iteration":
                s += e["tokens"]
                c += 1
        total_in += s
        calls += c
        per_task.append((s, task, c))
    return total_in, calls, per_task


print("=" * 72)
for label, job in PI_JOBS.items():
    if not os.path.isdir(job):
        continue
    tot, per = pi_usage(job)
    billed_in = tot["input"]          # cacheRead is reported separately by pi
    print(f"\n### {label}   ({len(per)} tasks with a session)")
    print(f"  LLM calls          {tot['calls']:>10,}")
    print(f"  input tokens       {billed_in:>10,}")
    print(f"    of which cached  {tot['cacheRead']:>10,}  (discounted by the provider)")
    print(f"  output tokens      {tot['output']:>10,}")
    print(f"    of which thinking{tot['reasoning']:>10,}")
    print(f"  TOTAL in+out       {billed_in + tot['output']:>10,}")
    print(f"  per task (mean)    {(billed_in + tot['output']) // max(1, len(per)):>10,}")
    per.sort(reverse=True)
    print("  heaviest tasks:")
    for s, task, t in per[:5]:
        print(f"    {s:>9,}  {task:30} ({t['calls']} calls)")

tot_in, calls, per = harness_estimate(HARNESS_JOB)
print(f"\n### harness (2026-08-08)   [ESTIMATE — no usage field in trace]")
print(f"  LLM calls          {calls:>10,}")
print(f"  input tokens (est) {tot_in:>10,}   = sum of context size per iteration")
print(f"  output tokens         unknown   (not recorded)")
print(f"  per task (mean, in){tot_in // max(1, len(per)):>10,}")
per.sort(reverse=True)
print("  heaviest tasks:")
for s, task, c in per[:5]:
    print(f"    {s:>9,}  {task:30} ({c} iterations)")
