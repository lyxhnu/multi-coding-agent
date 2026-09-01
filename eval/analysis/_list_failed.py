"""List the tasks pi failed in the 40-task comparison run."""
import glob
import json
import os

P = "jobs/2026-08-15__14-40-03"
failed = []
for d in sorted(glob.glob(f"{P}/*__*")):
    task = os.path.basename(d).rsplit("__", 1)[0]
    r = json.load(open(f"{d}/result.json"))
    rw = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    if rw != 1.0:
        failed.append(task)

print(f"pi failed {len(failed)}/40:")
print(" ".join(failed))
with open("/tmp/pi_failed.txt", "w") as f:
    f.write(" ".join(failed))
