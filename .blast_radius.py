"""Estimate the blast radius of unifying the compaction trigger.

The guard's rule fires when free space drops below maxTokens * 1.2, i.e. once usage passes
131072 - 39321 = 91751 (~70% of the window). Threshold compaction previously only fired at 85% (111411).
So aligning the two moves the trigger point earlier for every run that peaks between those two marks.
Compaction costs a model call on a 300s budget, so a large population here is a timeout risk worth
knowing about before reading the next run's results.
"""

import glob
import json
import os

JOB = "/Users/lyx/Downloads/Harness_Engineering-master/jobs/2026-08-18__00-33-41"
WINDOW = 131072
MAXTOK = 32768
HEADROOM = 1.2
GUARD_AT = WINDOW - int(MAXTOK * HEADROOM)  # ~91751
PCT_AT = int(WINDOW * 0.85)  # 111411

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
    passed = 1 if ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward") == 1.0 else 0
    traces = [p for p in glob.glob(os.path.join(d, "agent", "*.jsonl")) if "_trace_builder" not in p]
    peak = 0
    # How many separate turns sat above the guard line: a proxy for how often the new rule could fire.
    turns_above = 0
    for line in (open(traces[0], errors="replace") if traces else []):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        m = rec.get("message") or {}
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        total = (m.get("usage") or {}).get("totalTokens", 0) or 0
        peak = max(peak, total)
        if total >= GUARD_AT:
            turns_above += 1
    rows.append((task, peak, turns_above, passed))

print("window=%d  maxTokens=%d  guard line=%d (%.0f%% of window)  old 85%% line=%d\n"
      % (WINDOW, MAXTOK, GUARD_AT, GUARD_AT / WINDOW * 100, PCT_AT))

newly = [r for r in rows if GUARD_AT <= r[1] < PCT_AT]
already = [r for r in rows if r[1] >= PCT_AT]
below = [r for r in rows if r[1] < GUARD_AT]

print("=== how the %d runs distribute against the two trigger lines ===" % len(rows))
print("  peak below the guard line (unaffected):        %d" % len(below))
print("  peak between guard line and 85%% (NEWLY fires): %d" % len(newly))
print("  peak at or above 85%% (fired before too):       %d" % len(already))

print("\n=== the newly-affected runs ===")
print("  %-34s %8s %7s  %s" % ("task", "peak", "turns>=", "outcome"))
for task, peak, above, passed in sorted(newly, key=lambda x: -x[1]):
    print("  %-34s %8d %7d  %s" % (task, peak, above, "PASS" if passed else "fail"))

print("\n  pass rate of newly-affected: %d/%d" % (sum(r[3] for r in newly), len(newly)))
print("  total turns that would trigger a reduction across all runs: %d" % sum(r[2] for r in rows))
print("  runs where more than 3 turns sat above the line (would exhaust the budget and fall to shake): %d"
      % sum(1 for r in rows if r[2] > 3))
