"""Count runs that ended while the model still wanted to act.

A healthy run ends on stopReason "stop". Ending on "toolUse" means the loop quit while the model was
still issuing tool calls, which is the signature of the context guard stopping the loop for a compaction
that _checkCompaction then declined to perform (its threshold lacks the output-headroom rule the guard
uses). Cross-referenced against how close each run was to that headroom boundary.
"""

import glob
import json
import os

JOB = "/Users/lyx/Downloads/Harness_Engineering-master/jobs/2026-08-18__00-33-41"
WINDOW = 131072
MAXTOK = 32768
HEADROOM = 1.2
NEED_FREE = MAXTOK * HEADROOM

rows = []
for d in sorted(glob.glob(os.path.join(JOB, "*__*"))):
    rp = os.path.join(d, "result.json")
    if not os.path.exists(rp):
        continue
    try:
        r = json.load(open(rp))
    except Exception:
        continue
    task = os.path.basename(d).rsplit("__", 1)[0]
    reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    timed_out = "AgentTimeout" in str(r.get("exception_info") or "")
    traces = [p for p in glob.glob(os.path.join(d, "agent", "*.jsonl")) if "_trace_builder" not in p]
    last_stop = None
    last_total = 0
    reduced = 0
    for line in (open(traces[0], errors="replace") if traces else []):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") in ("compaction", "shake"):
            reduced += 1
        m = rec.get("message") or {}
        if isinstance(m, dict) and m.get("role") == "assistant":
            last_stop = m.get("stopReason")
            last_total = (m.get("usage") or {}).get("totalTokens", 0) or 0
    rows.append((task, last_stop, last_total, reduced, 1 if reward == 1.0 else 0, timed_out))

print("total runs analysed: %d\n" % len(rows))

by_stop = {}
for _, stop, _, _, _, _ in rows:
    by_stop[stop] = by_stop.get(stop, 0) + 1
print("=== final stopReason distribution ===")
for stop, n in sorted(by_stop.items(), key=lambda kv: -kv[1]):
    print("  %-10s %d" % (stop, n))

# The suspect population: quit mid-action, no reduction performed, not a timeout.
suspects = [r for r in rows if r[1] == "toolUse" and r[3] == 0 and not r[5]]
print("\n=== ended on toolUse with no reduction and no timeout: %d ===" % len(suspects))
print("  %-34s %8s %8s %6s  %s" % ("task", "total", "free", "pass", "guard would have fired?"))
would_fire = 0
for task, _, total, _, passed, _ in sorted(suspects, key=lambda x: -x[2]):
    free = WINDOW - total
    fires = free < NEED_FREE
    if fires:
        would_fire += 1
    print("  %-34s %8d %8d %6s  %s" % (task, total, free, "PASS" if passed else "fail",
                                       "YES  <-- cut short" if fires else "no"))
print("\n  of those, %d were inside the guard's headroom boundary (free < %d)" % (would_fire, int(NEED_FREE)))
print("  their pass rate: %d/%d" % (sum(1 for r in suspects if r[4] and WINDOW - r[2] < NEED_FREE), would_fire))
