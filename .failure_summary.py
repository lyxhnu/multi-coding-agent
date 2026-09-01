import glob
import json
import os
import re
from collections import Counter, defaultdict

JOB = "/Users/lyx/Downloads/Harness_Engineering-master/jobs/2026-08-18__09-53-51"
NUDGE = "cut off by the output token limit"
HEAVY = re.compile(r"pip(?:3)? install|apt(?:-get)? install|npm install|cargo build|make -j|conda install", re.I)

rows = []
for d in sorted(glob.glob(JOB + "/*__*")):
    rp = d + "/result.json"
    if not os.path.exists(rp):
        continue
    try:
        r = json.load(open(rp))
    except Exception:
        continue
    task = os.path.basename(d).rsplit("__", 1)[0]
    reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    exc = r.get("exception_info") or {}
    etype = exc.get("exception_type") if isinstance(exc, dict) else None

    vp = d + "/verifier/test-stdout.txt"
    vtext = open(vp, errors="replace").read() if os.path.exists(vp) else ""
    summaries = re.findall(r"=+\s*([^=\n]*(?:failed|passed|error|skipped)[^=\n]*)\s*=+", vtext, re.I)
    summary = summaries[-1].strip() if summaries else ""

    traces = [p for p in glob.glob(d + "/agent/*.jsonl") if "_trace_builder" not in p]
    last_stop = None
    turns = nudges = shakes = compactions = heavy = 0
    shake_saved = 0
    tool_counts = Counter()
    last_text = ""
    if traces:
        for line in open(traces[0], errors="replace"):
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("type") == "shake":
                shakes += 1
                shake_saved += rec.get("tokensSaved") or 0
            elif rec.get("type") == "compaction":
                compactions += 1
            msg = rec.get("message") or {}
            if not isinstance(msg, dict):
                continue
            if msg.get("role") == "user":
                for c in msg.get("content") or []:
                    if isinstance(c, dict) and NUDGE in str(c.get("text") or ""):
                        nudges += 1
            elif msg.get("role") == "assistant":
                turns += 1
                last_stop = msg.get("stopReason")
                texts = []
                for c in msg.get("content") or []:
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") == "toolCall":
                        name = c.get("name") or "?"
                        tool_counts[name] += 1
                        cmd = str((c.get("arguments") or {}).get("command") or "")
                        if HEAVY.search(cmd):
                            heavy += 1
                    elif c.get("type") == "text":
                        texts.append(str(c.get("text") or ""))
                last_text = " ".join(texts)[:120]

    if reward == 1.0:
        kind = "PASS"
    elif etype == "AgentTimeoutError":
        kind = "agent-timeout"
    elif etype == "VerifierTimeoutError":
        kind = "verifier-timeout"
    elif etype == "NonZeroAgentExitCodeError" and last_stop == "length":
        kind = "length-exhausted"
    elif etype:
        kind = "other-exception"
    elif last_stop == "stop":
        kind = "wrong-or-incomplete-solution"
    elif last_stop == "toolUse":
        kind = "ended-mid-action"
    elif last_stop == "length":
        kind = "length-without-exception"
    else:
        kind = "unclassified"

    rows.append(dict(task=task, reward=reward, kind=kind, etype=etype, summary=summary,
                     last_stop=last_stop, turns=turns, nudges=nudges, shakes=shakes,
                     compactions=compactions, shake_saved=shake_saved, heavy=heavy,
                     tools=dict(tool_counts), last_text=last_text))

completed = len(rows)
passed = sum(1 for r in rows if r["reward"] == 1.0)
failed = [r for r in rows if r["reward"] != 1.0]
print(f"completed={completed} passed={passed} failed={len(failed)} rate={passed/completed*100:.1f}%")
print("\n=== categories ===")
for kind, n in Counter(r["kind"] for r in failed).most_common():
    print(f"{kind:30} {n:2d}  {n/len(failed)*100:5.1f}%")

print("\n=== failed tasks ===")
for kind in [k for k, _ in Counter(r["kind"] for r in failed).most_common()]:
    group = [r for r in failed if r["kind"] == kind]
    print(f"\n[{kind}] {len(group)}")
    for r in group:
        extra = []
        if r["summary"]:
            extra.append(r["summary"][:60])
        extra.append(f"turns={r['turns']} stop={r['last_stop']}")
        if r["heavy"]:
            extra.append(f"heavy={r['heavy']}")
        if r["nudges"]:
            extra.append(f"nudge={r['nudges']}")
        if r["shakes"] or r["compactions"]:
            extra.append(f"shake={r['shakes']} compact={r['compactions']}")
        print(f"  {r['task']:36} " + " | ".join(extra))

print("\n=== mechanisms among failures vs passes ===")
for label, group in [("fail", failed), ("pass", [r for r in rows if r["reward"] == 1.0])]:
    print(f"{label:4}: tasks={len(group)} shake_tasks={sum(bool(r['shakes']) for r in group)} "
          f"compaction_tasks={sum(bool(r['compactions']) for r in group)} "
          f"nudge_tasks={sum(bool(r['nudges']) for r in group)} heavy_cmds={sum(r['heavy'] for r in group)}")
