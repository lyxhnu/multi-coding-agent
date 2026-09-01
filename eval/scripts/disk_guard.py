#!/usr/bin/env python3
"""Watch free disk during a run and stop the job before the disk fills.

A full disk does not fail one task, it corrupts every task in flight and any
still queued. Stopping deliberately keeps the results already earned.
"""
import shutil
import subprocess
import sys
import time

FLOOR_GB = float(sys.argv[1]) if len(sys.argv) > 1 else 1.5
INTERVAL = 60


def free_gb() -> float:
    return shutil.disk_usage("/").free / 1e9


print(f"guard armed: stop job if free disk < {FLOOR_GB}GB (checked every {INTERVAL}s)",
      flush=True)
while True:
    running = subprocess.run(["pgrep", "-f", "harbor.* run"],
                             capture_output=True, text=True).stdout.strip()
    if not running:
        print(f"no job running, guard exiting (free {free_gb():.1f}GB)", flush=True)
        break
    have = free_gb()
    if have < FLOOR_GB:
        print(f"!! free disk {have:.1f}GB below floor {FLOOR_GB}GB — stopping the job",
              flush=True)
        subprocess.run(["pkill", "-f", "harbor.* run"])
        time.sleep(5)
        subprocess.run("docker ps -q | xargs -r docker stop", shell=True)
        print("job stopped; completed results are preserved in jobs/", flush=True)
        break
    time.sleep(INTERVAL)
