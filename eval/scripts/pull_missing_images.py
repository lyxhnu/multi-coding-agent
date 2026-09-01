#!/usr/bin/env python3
"""Pull the missing TB2 images smallest-first, stopping before the disk runs dry.

Ordering by size means an early stop still maximises how many tasks become
runnable. The floor is checked between pulls because a run that fills the disk
mid-flight corrupts every task still in flight, not just the one downloading.
"""
import shutil
import subprocess
import sys

# (compressed MB from the registry probe, task, image)
PENDING = [
    (614, "gpt2-codegolf", "alexgshaw/gpt2-codegolf:20251031"),
    (765, "fix-ocaml-gc", "alexgshaw/fix-ocaml-gc:20251031"),
    (1268, "custom-memory-heap-crash", "alexgshaw/custom-memory-heap-crash:20251031"),
    (1309, "qemu-alpine-ssh", "alexgshaw/qemu-alpine-ssh:20251031"),
    (1309, "qemu-startup", "alexgshaw/qemu-startup:20251031"),
    (1432, "reshard-c4-data", "alexgshaw/reshard-c4-data:20251031"),
    (6103, "pytorch-model-recovery", "alexgshaw/pytorch-model-recovery:20251031"),
    (6186, "hf-model-inference", "alexgshaw/hf-model-inference:20251031"),
    (8811, "mteb-retrieve", "alexgshaw/mteb-retrieve:20251031"),
    (8820, "mteb-leaderboard", "alexgshaw/mteb-leaderboard:20251031"),
]

# Leave room for container layers and logs of the run that follows.
FLOOR_GB = 6.0
# Registry-compressed size understates what lands in the image store.
EXPANSION = 1.6


def free_gb() -> float:
    return shutil.disk_usage("/").free / 1e9


done, skipped = [], []
for mb, task, image in PENDING:
    need = mb * EXPANSION / 1000
    have = free_gb()
    if have - need < FLOOR_GB:
        print(f"SKIP  {task:28} needs ~{need:.1f}GB, only {have:.1f}GB free "
              f"(floor {FLOOR_GB}GB)", flush=True)
        skipped.append(task)
        continue
    print(f"PULL  {task:28} ~{need:.1f}GB  (free {have:.1f}GB)", flush=True)
    r = subprocess.run(["docker", "pull", "--platform", "linux/amd64", image],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"FAIL  {task}: {r.stderr.strip().splitlines()[-1][:120]}", flush=True)
        skipped.append(task)
        continue
    done.append(task)
    print(f"  ok, {free_gb():.1f}GB free", flush=True)

print(f"\npulled {len(done)}, skipped {len(skipped)}")
print(f"final free: {free_gb():.1f}GB")
if skipped:
    print("skipped:", " ".join(skipped))
