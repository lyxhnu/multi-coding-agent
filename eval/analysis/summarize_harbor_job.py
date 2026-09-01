#!/usr/bin/env python3
"""Summarize a Harbor job directory."""
import glob
import json
import os
import re
import sys
from pathlib import Path

job = Path(sys.argv[1] if len(sys.argv) > 1 else "jobs/2026-08-06__09-49-02")
result_path = job / "result.json"
if not result_path.exists():
    raise SystemExit(f"no result.json: {result_path}")

root = json.loads(result_path.read_text())
stats = root.get("stats", {})
print(
    f"job={job.name} completed={stats.get('n_completed_trials')} "
    f"errored={stats.get('n_errored_trials')} running={stats.get('n_running_trials')} "
    f"pending={stats.get('n_pending_trials')}"
)

rows = []
for d in sorted(glob.glob(str(job / "*__*"))):
    p = Path(d)
    name = p.name.rsplit("__", 1)[0]
    rpath = p / "result.json"
    status = "running/pending"
    reward = None
    diag = ""
    if rpath.exists():
        tr = json.loads(rpath.read_text())
        reward = ((tr.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        if tr.get("exception_info"):
            status = "EXC"
            exc = p / "exception.txt"
            if exc.exists():
                txt = exc.read_text(errors="replace")
                last = [ln.strip() for ln in txt.splitlines() if ln.strip()][-1:]
                diag = last[0][:100] if last else "exception"
        elif reward is not None:
            status = "DONE"
            out = p / "verifier" / "test-stdout.txt"
            if out.exists():
                txt = out.read_text(errors="replace")
                m = re.findall(r"=+\s+([0-9]+ passed.*?|[0-9]+ failed.*?)\s+=+", txt)
                diag = m[-1][:100] if m else ""
    rows.append((name, status, reward, diag))

for name, status, reward, diag in rows:
    print(f"{name:28} {status:14} reward={str(reward):4} {diag}")

finished = [r for r in rows if r[1] != "running/pending"]
passed = sum(1 for _, _, reward, _ in finished if reward == 1.0)
failed = sum(1 for _, status, reward, _ in finished if status == "DONE" and reward != 1.0)
exc = sum(1 for _, status, _, _ in finished if status == "EXC")
print(f"summary: finished={len(finished)}/{len(rows)} passed={passed} failed={failed} exceptions={exc}")
