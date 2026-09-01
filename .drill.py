"""Drill into the two failing gates: are the long length-runs the recoverable kind (with tool calls) or
the silent kind, and why did no context reduction fire despite tight peaks?"""

import glob
import json
import os
import sys

JOB = "/Users/lyx/Downloads/Harness_Engineering-master/jobs/2026-08-18__00-33-41"
WINDOW = 131072
MAXTOK = 32768
HEADROOM = 1.2

TASKS = sys.argv[1:] or [
    "circuit-fibsqrt",
    "feal-linear-cryptanalysis",
    "regex-chess",
    "schemelike-metacircular-eval",
    "dna-assembly",
]

for task in TASKS:
    ds = glob.glob(os.path.join(JOB, task + "__*"))
    if not ds:
        print("%s: not found" % task)
        continue
    traces = [p for p in glob.glob(os.path.join(ds[0], "agent", "*.jsonl")) if "_trace_builder" not in p]
    if not traces:
        print("%s: no trace" % task)
        continue
    print("=== %s ===" % task)
    idx = 0
    for line in open(traces[0], errors="replace"):
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") in ("compaction", "shake"):
            print("    [%s] reason=%s saved=%s" % (rec["type"], rec.get("reason"), rec.get("tokensSaved")))
            continue
        m = rec.get("message") or {}
        if not isinstance(m, dict):
            continue
        if m.get("role") == "user":
            for c in m.get("content") or []:
                if isinstance(c, dict) and "cut off by the output token limit" in str(c.get("text") or ""):
                    print("    <NUDGE injected>")
            continue
        if m.get("role") != "assistant":
            continue
        idx += 1
        u = m.get("usage") or {}
        total = u.get("totalTokens", 0) or 0
        kinds = [c.get("type") for c in (m.get("content") or []) if isinstance(c, dict)]
        ntc = sum(1 for k in kinds if k == "toolCall")
        free = WINDOW - total
        flag = ""
        if m.get("stopReason") == "length":
            # A length stop WITH tool calls is the recoverable path (failToolCallsFromTruncatedMessage);
            # only a length stop with none is the silent-exit shape the spec gate targets.
            flag = " <-- LENGTH, toolCalls=%d%s" % (ntc, " (RECOVERABLE)" if ntc else " (SILENT SHAPE)")
        room = ""
        if free < MAXTOK * HEADROOM:
            room = "  [guard should fire: free=%d < %d]" % (free, int(MAXTOK * HEADROOM))
        print("  turn%-3d out=%-6s total=%-7s stop=%-8s %s%s%s"
              % (idx, u.get("output", 0), total, m.get("stopReason"), kinds, flag, room))
    print("")
