"""Three-way comparison on the same 40 tasks and model (qwen3.7-plus):
pi before your optimisation, pi after, and the harness baseline."""
import glob
import json
import os
import sys
from datetime import datetime

RUNS = [
    ("harness", "jobs/2026-08-08__14-41-46"),
    ("pi-v1", "jobs/2026-08-15__14-40-03"),
    ("pi-v2", sys.argv[1] if len(sys.argv) > 1 else "jobs/2026-08-16__11-51-28"),
]


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
        out[task] = dict(p=1 if rw == 1.0 else 0, kind=kind, mins=mins)
    return out


data = {name: load(job) for name, job in RUNS}
tasks = sorted(data["pi-v2"])

hdr = "".join(f"{n:>9}" for n, _ in RUNS)
print(f"{'task':30}{hdr}")
for t in tasks:
    row = "".join(f"{data[n].get(t, {}).get('p', 0):>9}" for n, _ in RUNS)
    v1 = data["pi-v1"].get(t, {}).get("p", 0)
    v2 = data["pi-v2"].get(t, {}).get("p", 0)
    mark = "  <== gained" if v2 > v1 else ("  <== LOST" if v1 > v2 else "")
    print(f"{t:30}{row}{mark}")

print()
for n, _ in RUNS:
    d = data[n]
    n_pass = sum(d.get(t, {}).get("p", 0) for t in tasks)
    ms = sorted(d[t]["mins"] for t in tasks if t in d and d[t]["mins"])
    tos = sum(1 for t in tasks if t in d and d[t]["kind"])
    print(f"{n:10} {n_pass:2d}/40 = {n_pass/len(tasks)*100:4.1f}%   "
          f"median {ms[len(ms)//2]:4.1f}m   timeouts/exc {tos}")

gained = [t for t in tasks
          if data["pi-v2"].get(t, {}).get("p", 0) > data["pi-v1"].get(t, {}).get("p", 0)]
lost = [t for t in tasks
        if data["pi-v1"].get(t, {}).get("p", 0) > data["pi-v2"].get(t, {}).get("p", 0)]
print(f"\npi-v1 -> pi-v2   gained {len(gained)}: {gained}")
print(f"pi-v1 -> pi-v2   lost   {len(lost)}: {lost}")

union = [t for t in tasks
         if data["harness"].get(t, {}).get("p", 0) or data["pi-v2"].get(t, {}).get("p", 0)]
print(f"\nharness ∪ pi-v2: {len(union)}/40 = {len(union)/len(tasks)*100:.0f}%")
