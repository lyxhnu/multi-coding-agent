#!/usr/bin/env python3
"""Stop the running Harbor job and any leftover trial containers."""
import os
import signal
import subprocess
import time


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True)


ps = sh("ps", "-Ao", "pid,command").stdout
pids = []
for line in ps.splitlines():
    parts = line.split(None, 1)
    if len(parts) != 2 or not parts[0].isdigit():
        continue
    pid, cmd = int(parts[0]), parts[1]
    if pid == os.getpid():
        continue
    if ("harbor" in cmd and " run" in cmd) or "run_tb2_batch20.sh" in cmd:
        pids.append((pid, cmd[:90]))

for pid, cmd in pids:
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"SIGTERM -> {pid}  {cmd}")
    except Exception as e:
        print(f"kill {pid} failed: {e}")

time.sleep(8)

# Escalate for anything that ignored SIGTERM
for pid, cmd in pids:
    try:
        os.kill(pid, 0)
    except Exception:
        continue
    try:
        os.kill(pid, signal.SIGKILL)
        print(f"SIGKILL -> {pid}  {cmd}")
    except Exception as e:
        print(f"SIGKILL {pid} failed: {e}")

time.sleep(3)

names = sh("docker", "ps", "--format", "{{.Names}}").stdout.split()
for n in names:
    r = sh("docker", "stop", "-t", "5", n)
    print(("stopped " if r.returncode == 0 else "stop-failed ") + n)

time.sleep(2)
ps2 = sh("ps", "-Ao", "command").stdout
left = sum(1 for l in ps2.splitlines() if "harbor" in l and " run" in l)
print("harbor processes left:", left)
print("containers left:", len(sh("docker", "ps", "-q").stdout.split()))
