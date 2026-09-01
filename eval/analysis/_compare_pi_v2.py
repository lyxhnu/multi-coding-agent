"""Did the pi-agent optimisation move the needle? Compare the 24 previously
failed tasks before (jobs/2026-08-15__14-40-03) and after (this run)."""
import glob
import json
import os
import re
import sys
from datetime import datetime

BEFORE = "jobs/2026-08-15__14-40-03"
AFTER = sys.argv[1] if len(sys.argv) > 1 else "jobs/2026-08-16__00-22-26"


def load(job):
    out = {}
    for d in glob.glob(f"{job}/*__*"):
        task = os.path.basename(d).rsplit("__", 1)[0]
        r = json.load(open(f"{d}/result.json"))
        rw = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
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
            sub = m[-1].strip()[:28] if m else ""
        out[task] = dict(pass_=1 if rw == 1.0 else 0, kind=kind, mins=mins, sub=sub)
    return out


b, a = load(BEFORE), load(AFTER)
tasks = sorted(a)

print(f"=== the 24 tasks pi failed before, re-run after your optimisation ===")
print(f"{'task':30}{'before':>8}{'after':>7}   after detail")
gained, lost = [], []
for t in tasks:
    x = b.get(t, {}).get("pass_", 0)
    y = a[t]["pass_"]
    mark = ""
    if y and not x:
        mark = "  <== GAINED"
        gained.append(t)
    elif x and not y:
        mark = "  <== lost"
        lost.append(t)
    detail = f"{a[t]['kind']} {a[t]['sub']}".strip()
    print(f"{t:30}{x:>8}{y:>7}   {detail}{mark}")

print(f"\nbefore: 0/{len(tasks)}   after: {sum(a[t]['pass_'] for t in tasks)}/{len(tasks)}")
print(f"gained: {len(gained)} {gained}")
if lost:
    print(f"lost:   {len(lost)} {lost}")

bm = [b[t]["mins"] for t in tasks if t in b and b[t]["mins"]]
am = [a[t]["mins"] for t in tasks if a[t]["mins"]]
print(f"\nmedian runtime: before {sorted(bm)[len(bm)//2]:.1f}m -> after {sorted(am)[len(am)//2]:.1f}m")
print(f"timeouts: before {sum(1 for t in tasks if t in b and b[t]['kind'])} "
      f"-> after {sum(1 for t in tasks if a[t]['kind'])}")

# Full-40 projection: the 16 that already passed are assumed unchanged.
print(f"\nprojected full-40 (16 prior passes + {len(gained)} new): "
      f"{16 + len(gained)}/40 = {(16 + len(gained))/40*100:.0f}%  (was 16/40 = 40%)")
