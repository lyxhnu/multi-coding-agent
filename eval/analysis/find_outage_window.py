"""Locate network-loss windows in a run: cluster stream stalls by absolute clock time.

A stall caused by connectivity loss hits every task in flight at the same moment,
so the stalls bunch into a window. Contention or model hangs scatter instead.
"""
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

JOB = sys.argv[1] if len(sys.argv) > 1 else "jobs/2026-08-09__17-26-07"

stalls = []          # (absolute time, task)
spans = {}           # task -> (start, end)
for d in sorted(glob.glob(f"{JOB}/*__*")):
    task = os.path.basename(d).rsplit("__", 1)[0]
    res = json.load(open(f"{d}/result.json"))
    if not res.get("started_at"):
        continue
    start = datetime.fromisoformat(res["started_at"].replace("Z", "+00:00"))
    end = (datetime.fromisoformat(res["finished_at"].replace("Z", "+00:00"))
           if res.get("finished_at") else None)
    spans[task] = (start, end)

    tp = f"{d}/agent/_trace_builder.jsonl"
    if not os.path.exists(tp):
        continue
    for line in open(tp):
        if not line.strip():
            continue
        e = json.loads(line)
        if e["event"] == "error" and e.get("type") in ("stream_stalled", "api_error"):
            stalls.append((start + timedelta(seconds=e["t"]), task, e.get("type"),
                           (e.get("message") or "")[:70]))

stalls.sort()
print(f"total stall/api errors: {len(stalls)}")
if not stalls:
    sys.exit(0)

print(f"first: {stalls[0][0]:%H:%M:%S}   last: {stalls[-1][0]:%H:%M:%S}\n")

print("--- stalls per 10-minute bucket (absolute clock) ---")
buckets = Counter(s[0].replace(minute=(s[0].minute // 10) * 10, second=0, microsecond=0)
                  for s in stalls)
peak = max(buckets.values())
for b in sorted(buckets):
    bar = "#" * int(buckets[b] / peak * 50)
    print(f"  {b:%H:%M}  {buckets[b]:3d}  {bar}")

# How many DISTINCT tasks stalled inside each bucket? Simultaneous, cross-task
# stalls are the signature of shared infrastructure failing, not of one model.
print("\n--- distinct tasks stalling per bucket (>=3 means shared cause) ---")
per_bucket = defaultdict(set)
for ts, task, _, _ in stalls:
    per_bucket[ts.replace(minute=(ts.minute // 10) * 10, second=0, microsecond=0)].add(task)
suspect = []
for b in sorted(per_bucket):
    n = len(per_bucket[b])
    flag = "  <== shared failure" if n >= 3 else ""
    print(f"  {b:%H:%M}  {n:2d} tasks{flag}")
    if n >= 3:
        suspect.append(b)

if suspect:
    lo, hi = min(suspect), max(suspect) + timedelta(minutes=10)
    print(f"\n>>> suspected outage window: {lo:%H:%M} - {hi:%H:%M}")
    hit = sorted({t for ts, t, _, _ in stalls if lo <= ts < hi})
    print(f">>> tasks with stalls inside it: {len(hit)}")

    meta = json.load(open("benchmarks/tb2_tasks.json"))
    clean_pass = clean_total = dirty_pass = dirty_total = 0
    dirty_names = []
    for d in sorted(glob.glob(f"{JOB}/*__*")):
        task = os.path.basename(d).rsplit("__", 1)[0]
        res = json.load(open(f"{d}/result.json"))
        rw = ((res.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        # A task is contaminated if it was running during the window at all.
        s, e = spans.get(task, (None, None))
        overlaps = s and e and s < hi and e > lo
        if task in hit or overlaps:
            dirty_total += 1
            dirty_pass += 1 if rw == 1.0 else 0
            dirty_names.append(task)
        else:
            clean_total += 1
            clean_pass += 1 if rw == 1.0 else 0
    print(f"\n--- splitting the run ---")
    print(f"  outside the window : {clean_pass}/{clean_total} = "
          f"{clean_pass/max(1,clean_total)*100:.1f}%")
    print(f"  inside the window  : {dirty_pass}/{dirty_total} = "
          f"{dirty_pass/max(1,dirty_total)*100:.1f}%")
    print(f"\n  contaminated tasks ({len(dirty_names)}), worth re-running:")
    for t in dirty_names:
        print(f"    {t}")
