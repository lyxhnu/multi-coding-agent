#!/usr/bin/env python3
"""Clone terminal-bench-2 at a pinned commit, trying GitHub then proxy mirrors."""
import shutil
import subprocess
import sys
from pathlib import Path

COMMIT = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c"
DEST = Path("/tmp/tb2_repo")
MIRRORS = [
    "https://github.com/laude-institute/terminal-bench-2.git",
    "https://ghfast.top/https://github.com/laude-institute/terminal-bench-2.git",
    "https://gh-proxy.com/https://github.com/laude-institute/terminal-bench-2.git",
    "https://ghproxy.net/https://github.com/laude-institute/terminal-bench-2.git",
    "https://gitclone.com/github.com/laude-institute/terminal-bench-2.git",
]

def run(cmd, cwd=None, timeout=180):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)

shutil.rmtree(DEST, ignore_errors=True)
DEST.mkdir(parents=True)
run(["git", "init", "-q", "."], cwd=DEST)

for url in MIRRORS:
    print(f"== trying {url}", flush=True)
    run(["git", "remote", "remove", "origin"], cwd=DEST)
    run(["git", "remote", "add", "origin", url], cwd=DEST)
    try:
        r = run(["git", "-c", "http.connectTimeout=15",
                 "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30",
                 "fetch", "--depth", "1", "origin", COMMIT], cwd=DEST, timeout=300)
        if r.returncode == 0:
            chk = run(["git", "cat-file", "-e", COMMIT], cwd=DEST)
            if chk.returncode == 0:
                run(["git", "checkout", "-q", COMMIT], cwd=DEST, timeout=120)
                print(f"SUCCESS via {url}")
                sys.exit(0)
        print(f"   fetch rc={r.returncode}: {(r.stderr or '').strip()[:150]}")
    except subprocess.TimeoutExpired:
        print("   TIMEOUT")

# Fallback: gh-proxy tarball of the pinned commit
import urllib.request
for proxy in ["https://ghfast.top/", "https://gh-proxy.com/", "https://ghproxy.net/"]:
    url = f"{proxy}https://github.com/laude-institute/terminal-bench-2/archive/{COMMIT}.tar.gz"
    print(f"== tarball via {proxy}", flush=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp, open("/tmp/tb2.tar.gz", "wb") as f:
            shutil.copyfileobj(resp, f)
        shutil.rmtree(DEST, ignore_errors=True)
        DEST.mkdir(parents=True)
        r = run(["tar", "-xzf", "/tmp/tb2.tar.gz", "--strip-components=1", "-C", str(DEST)], timeout=300)
        if r.returncode == 0:
            print(f"SUCCESS tarball via {proxy}")
            sys.exit(0)
    except Exception as e:
        print(f"   FAIL {str(e)[:120]}")

print("ALL ROUTES FAILED")
sys.exit(1)
