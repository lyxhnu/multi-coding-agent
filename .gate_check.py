"""Check a benchmark job against the hard gates in section 7 of the long-task resilience spec.

Written as a file rather than an inline snippet because the counting rules are easy to get subtly wrong:
compaction/shake live as session *entry* types, the truncation nudge is a *user* message (not assistant),
and both have bitten earlier ad-hoc versions of this analysis.

Usage: python .gate_check.py <job-dir> [baseline-job-dir]
"""

import glob
import json
import os
import statistics as st
import sys
from datetime import datetime

CONTEXT_WINDOW = 131072
NUDGE_MARK = "cut off by the output token limit"


def scan(job):
    out = {}
    for d in sorted(glob.glob(os.path.join(job, "*__*"))):
        rp = os.path.join(d, "result.json")
        if not os.path.exists(rp):
            continue
        try:
            r = json.load(open(rp))
        except Exception:
            continue
        task = os.path.basename(d).rsplit("__", 1)[0]
        reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        exc = str(r.get("exception_info") or "")
        mins = 0.0
        if r.get("started_at") and r.get("finished_at"):
            a = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
            b = datetime.fromisoformat(r["finished_at"].replace("Z", "+00:00"))
            mins = (b - a).total_seconds() / 60

        verifier_crashed = False
        vp = os.path.join(d, "verifier", "test-stdout.txt")
        if os.path.exists(vp):
            verifier_crashed = "-m: command not found" in open(vp, errors="replace").read()
        conn_error = False
        ep = os.path.join(d, "exception.txt")
        if os.path.exists(ep):
            conn_error = "Connection error" in open(ep, errors="replace").read()

        # Session entries and messages share one jsonl; entry types and message roles are distinct keys.
        traces = [p for p in glob.glob(os.path.join(d, "agent", "*.jsonl")) if "_trace_builder" not in p]
        compactions = shakes = nudges = turns = blocked = 0
        shake_reasons = []
        shake_saved = 0
        peak = 0
        max_length_run = run = 0
        last_msg = None
        for line in (open(traces[0], errors="replace") if traces else []):
            try:
                rec = json.loads(line)
            except Exception:
                continue
            etype = rec.get("type")
            if etype == "compaction":
                compactions += 1
            elif etype == "shake":
                shakes += 1
                shake_reasons.append(rec.get("reason") or "?")
                shake_saved += rec.get("tokensSaved") or 0
            msg = rec.get("message") or {}
            if not isinstance(msg, dict):
                continue
            if msg.get("role") == "user":
                for c in msg.get("content") or []:
                    if isinstance(c, dict) and NUDGE_MARK in str(c.get("text") or ""):
                        nudges += 1
                continue
            if msg.get("role") != "assistant":
                continue
            turns += 1
            blocked += str(msg).count("no approval channel configured")
            peak = max(peak, (msg.get("usage") or {}).get("totalTokens", 0) or 0)
            if msg.get("stopReason") == "length":
                run += 1
                max_length_run = max(max_length_run, run)
            else:
                run = 0
            last_msg = msg

        tail_silent_length = False
        if last_msg and last_msg.get("stopReason") == "length":
            tail_silent_length = not any(
                isinstance(c, dict) and c.get("type") == "toolCall" for c in (last_msg.get("content") or [])
            )

        out[task] = dict(
            passed=1 if reward == 1.0 else 0,
            mins=mins,
            turns=turns,
            peak=peak,
            compactions=compactions,
            shakes=shakes,
            shake_reasons=shake_reasons,
            shake_saved=shake_saved,
            nudges=nudges,
            blocked=blocked,
            verifier_crashed=verifier_crashed,
            conn_error=conn_error,
            max_length_run=max_length_run,
            tail_silent_length=tail_silent_length,
            timed_out="AgentTimeout" in exc,
            # A healthy run ends on "stop". Ending on "toolUse" means the loop quit while the model was
            # still issuing tool calls -- the signature of the context guard stopping the loop for a
            # reduction that never happened. See gate 1.
            tail_stop_reason=last_msg.get("stopReason") if last_msg else None,
        )
    return out


def median(values):
    values = [v for v in values if v]
    return st.median(values) if values else 0


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    job = sys.argv[1].rstrip("/")
    data = scan(job)
    tasks = sorted(data)
    if not tasks:
        raise SystemExit("no results found in %s" % job)

    n_conn = sum(1 for t in tasks if data[t]["conn_error"])
    print("job: %s   tasks: %d" % (job, len(tasks)))
    print("network sanity: %d task(s) hit Connection error%s\n" % (n_conn, "" if n_conn == 0 else "  <-- RUN IS POLLUTED"))

    gates = [
        # Gate 1 is the one the first version of this spec was missing entirely. A run cut short this way
        # looks clean on every other measure, which is how it survived two full benchmark rounds
        # undetected: the guard stopped the loop, the compaction check declined to act because its
        # threshold was stricter than the guard's, and the run just ended mid-action.
        ("guard cut a run short (toolUse, no reduction)",
         [t for t in tasks
          if data[t]["tail_stop_reason"] == "toolUse"
          and data[t]["compactions"] == 0
          and data[t]["shakes"] == 0
          and not data[t]["timed_out"]]),
        ("context over 95% with no reduction",
         [t for t in tasks if data[t]["peak"] > CONTEXT_WINDOW * 0.95
          and data[t]["compactions"] == 0 and data[t]["shakes"] == 0]),
        ("more than 3 compactions in one prompt", [t for t in tasks if data[t]["compactions"] > 3]),
        ("ends on length with no tool call", [t for t in tasks if data[t]["tail_silent_length"]]),
        ("more than 3 consecutive length stops", [t for t in tasks if data[t]["max_length_run"] > 3]),
        ("permission blocks", [t for t in tasks if data[t]["blocked"]]),
        ("verifier crashed (missing python)", [t for t in tasks if data[t]["verifier_crashed"]]),
    ]
    all_pass = True
    print("=== spec section 5 hard gates ===")
    for name, offenders in gates:
        ok = not offenders
        all_pass = all_pass and ok
        print("  [%s] %-44s %d %s" % ("PASS" if ok else "FAIL", name, len(offenders), offenders[:5] if offenders else ""))
    print("\n  => %s" % ("ALL TRACE GATES PASS" if all_pass else "GATES REMAINING"))
    # Spec section 5 lists eight gates. The eighth ("no new failures in the existing test suites") is not
    # derivable from benchmark traces, so it is deliberately absent above rather than silently assumed:
    # reporting "all gates pass" off trace data alone would overstate what this script actually checked.
    print("  note: gate 8 (no new test failures) is out of trace scope — verify with the section 7 baseline:")
    print("        ./test.sh")

    # Final stop reasons, for context on gate 1.
    by_stop = {}
    for t in tasks:
        key = str(data[t]["tail_stop_reason"])
        by_stop[key] = by_stop.get(key, 0) + 1
    print("\n=== final stopReason distribution (healthy runs end on 'stop') ===")
    for stop, count in sorted(by_stop.items(), key=lambda kv: -kv[1]):
        print("  %-10s %d" % (stop, count))

    npass = sum(data[t]["passed"] for t in tasks)
    print("\n=== outcome ===")
    print("  passed:           %d/%d = %.1f%%" % (npass, len(tasks), npass / len(tasks) * 100))
    print("  agent timeouts:   %d" % sum(1 for t in tasks if data[t]["timed_out"]))
    print("  median turns:     %.0f" % median([data[t]["turns"] for t in tasks]))
    print("  median minutes:   %.1f" % median([data[t]["mins"] for t in tasks]))

    print("\n=== context-reduction mechanisms ===")
    print("  compactions:      %d across %d task(s)"
          % (sum(data[t]["compactions"] for t in tasks), sum(1 for t in tasks if data[t]["compactions"])))
    print("  shakes:           %d across %d task(s), ~%d tokens freed"
          % (sum(data[t]["shakes"] for t in tasks),
             sum(1 for t in tasks if data[t]["shakes"]),
             sum(data[t]["shake_saved"] for t in tasks)))
    reasons = {}
    for t in tasks:
        for reason in data[t]["shake_reasons"]:
            reasons[reason] = reasons.get(reason, 0) + 1
    for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print("      reason=%-30s %d" % (reason, count))
    print("  truncation nudges: %d across %d task(s)"
          % (sum(data[t]["nudges"] for t in tasks), sum(1 for t in tasks if data[t]["nudges"])))

    interesting = [t for t in tasks if data[t]["shakes"] or data[t]["compactions"] or data[t]["nudges"]]
    if interesting:
        print("\n=== tasks where the resilience paths fired ===")
        print("  %-34s %6s %6s %6s %7s  %s" % ("task", "shake", "compact", "nudge", "peak", "result"))
        for t in interesting:
            d = data[t]
            print("  %-34s %6d %6d %6d %7d  %s"
                  % (t, d["shakes"], d["compactions"], d["nudges"], d["peak"], "PASS" if d["passed"] else "fail"))

    if len(sys.argv) > 2:
        base = scan(sys.argv[2].rstrip("/"))
        common = sorted(set(base) & set(data))
        if common:
            from math import comb
            won = sum(1 for t in common if data[t]["passed"] > base[t]["passed"])
            lost = sum(1 for t in common if base[t]["passed"] > data[t]["passed"])
            n = won + lost
            p = min(sum(comb(n, k) for k in range(0, min(won, lost) + 1)) * 2 / (2 ** n), 1.0) if n else 1.0
            print("\n=== vs baseline %s (%d shared tasks) ===" % (sys.argv[2], len(common)))
            print("  baseline %d/%d -> this %d/%d"
                  % (sum(base[t]["passed"] for t in common), len(common),
                     sum(data[t]["passed"] for t in common), len(common)))
            print("  McNemar: won %d lost %d  p=%.4f  %s"
                  % (won, lost, p, "SIGNIFICANT" if p < 0.05 else "(not significant)"))

    return 0 if all_pass else 1


raise SystemExit(main())
