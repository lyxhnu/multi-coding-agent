"""Why did run 2026-08-21__14-10-28 collapse? Classify every task by how it actually died and check
whether the failures cluster in time (an outage) or spread evenly (a real regression)."""

import glob
import json
import os
import re
from collections import Counter
from datetime import datetime

JOB = "/Users/lyx/Downloads/pi-main/eval/jobs/2026-08-21__14-10-28"

rows = []
for d in sorted(glob.glob(JOB + "/*__*")):
    rp = os.path.join(d, "result.json")
    if not os.path.exists(rp):
        continue
    task = os.path.basename(d).rsplit("__", 1)[0]
    r = json.load(open(rp))
    reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    exc = r.get("exception_info") or {}
    etype = exc.get("exception_type") if isinstance(exc, dict) else None

    start = end = None
    if r.get("started_at") and r.get("finished_at"):
        start = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))

    # Raw agent-side signal: how many assistant turns happened at all, and what killed them.
    turns = 0
    err_msgs = []
    traces = [p for p in glob.glob(d + "/agent/*.jsonl") if "_trace_builder" not in p]
    for line in open(traces[0], errors="replace") if traces else []:
        try:
            m = json.loads(line).get("message") or {}
        except Exception:
            continue
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        turns += 1
        if m.get("stopReason") == "error" and m.get("errorMessage"):
            err_msgs.append(m["errorMessage"][:90])

    stderr = ""
    ep = os.path.join(d, "exception.txt")
    if os.path.exists(ep):
        stderr = open(ep, errors="replace").read()

    rows.append(dict(task=task, reward=reward, etype=etype, start=start, end=end,
                     turns=turns, errs=err_msgs, stderr=stderr, has_trace=bool(traces)))

print("total tasks: %d\n" % len(rows))

def classify(x):
    if x["reward"] == 1.0:
        return "passed"
    if not x["has_trace"]:
        return "no agent trace at all"
    if x["turns"] == 0:
        return "agent produced zero turns"
    if any("onnection" in e or "APIConnection" in e or "network" in e.lower() for e in x["errs"]):
        return "provider connection error"
    if "Connection error" in x["stderr"]:
        return "provider connection error"
    if x["etype"] and "Timeout" in str(x["etype"]):
        return "timeout (%s)" % x["etype"]
    if x["etype"]:
        return "exception: %s" % x["etype"]
    return "ran, verifier said fail"

buckets = Counter(classify(x) for x in rows)
print("=== how each task ended ===")
for k, v in buckets.most_common():
    print("  %-34s %d" % (k, v))

print("\n=== zero-turn / no-trace tasks: what does the runner say ===")
shown = 0
for x in rows:
    if x["has_trace"] and x["turns"] > 0:
        continue
    if shown >= 6:
        break
    tail = [ln for ln in x["stderr"].splitlines() if ln.strip()][-3:]
    print("  %-32s turns=%d exc=%s" % (x["task"], x["turns"], x["etype"]))
    for ln in tail:
        print("      | %s" % ln[:130])
    shown += 1

print("\n=== timing: are failures clustered? (per 30-min bucket) ===")
by_bucket = {}
for x in rows:
    if not x["start"]:
        continue
    key = x["start"].strftime("%H:%M")[:-1] + "0"
    b = by_bucket.setdefault(key, [0, 0])
    b[0] += 1
    if x["reward"] == 1.0:
        b[1] += 1
for key in sorted(by_bucket):
    n, ok = by_bucket[key]
    print("  %s  started=%2d  passed=%2d  %s" % (key, n, ok, "#" * ok + "." * (n - ok)))

print("\n=== distinct assistant-side error messages ===")
allerr = Counter()
for x in rows:
    for e in x["errs"]:
        allerr[re.sub(r"\d+", "N", e)] += 1
for e, c in allerr.most_common(8):
    print("  %3d  %s" % (c, e))
