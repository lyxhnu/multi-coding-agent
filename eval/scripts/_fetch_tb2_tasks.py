#!/usr/bin/env python3
"""Fetch TB2 task dirs from GitHub via the jsDelivr CDN (works behind the
corporate gateway where github.com / raw.githubusercontent.com are blocked).

Usage:
  python3 scripts/_fetch_tb2_tasks.py            # all 89 tasks
  python3 scripts/_fetch_tb2_tasks.py task1 ...  # selected tasks

Writes to local_tasks/tb2_all/<task>/. Files already present with the right
size are skipped, so reruns are incremental.
"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

COMMIT = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c"
REPO = "laude-institute/terminal-bench-2"
API = f"https://data.jsdelivr.com/v1/packages/gh/{REPO}@{COMMIT}"
CDN = f"https://cdn.jsdelivr.net/gh/{REPO}@{COMMIT}"
DEST_ROOT = Path(__file__).resolve().parent.parent / "local_tasks" / "tb2_all"

session = requests.Session()
session.headers["User-Agent"] = "Mozilla/5.0"


def get_tree() -> dict:
    for attempt in range(3):
        try:
            r = session.get(API, timeout=60)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            print(f"tree fetch attempt {attempt+1} failed: {e}")
            time.sleep(3)
    raise SystemExit("cannot fetch file tree")


def walk(node, prefix=""):
    for child in node.get("files", []):
        path = f"{prefix}/{child['name']}" if prefix else child["name"]
        if child["type"] == "directory":
            yield from walk(child, path)
        else:
            yield path, child.get("size", 0)


def fetch_file(rel_path: str, out_path: Path) -> bool:
    url = f"{CDN}/{rel_path}"
    for attempt in range(3):
        try:
            r = session.get(url, timeout=120)
            if r.status_code == 200:
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(r.content)
                return True
            if r.status_code in (403, 404):
                print(f"  MISS {rel_path}: HTTP {r.status_code}")
                return False
        except Exception as e:
            if attempt == 2:
                print(f"  FAIL {rel_path}: {str(e)[:80]}")
        time.sleep(2)
    return False


def main():
    print("Fetching repo file tree...")
    tree = get_tree()
    all_files = dict(walk(tree))
    all_tasks = sorted({p.split("/", 1)[0] for p in all_files})
    print(f"repo: {len(all_files)} files, {len(all_tasks)} top-level dirs")

    tasks = sys.argv[1:] or all_tasks

    todo: list[tuple[str, Path]] = []
    oversize: list[str] = []
    for task in tasks:
        files = {p: s for p, s in all_files.items() if p.startswith(f"{task}/")}
        if not files:
            print(f"!! {task}: NOT FOUND in repo tree")
            continue
        for rel, size in files.items():
            if size > 19_000_000:  # jsDelivr per-file cap ~20MB
                oversize.append(f"{rel} ({size/1e6:.0f}MB)")
                continue
            out = DEST_ROOT / rel
            if out.exists() and out.stat().st_size == size:
                continue
            todo.append((rel, out))

    print(f"to download: {len(todo)} files"
          + (f"; SKIPPED oversize: {oversize}" if oversize else ""))

    done = fail = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for ok in pool.map(lambda t: fetch_file(*t), todo):
            done += ok
            fail += (not ok)
            n = done + fail
            if n % 100 == 0:
                print(f"  progress: {n}/{len(todo)} ({fail} failed)")

    print(f"DONE: {done} downloaded, {fail} failed"
          + (f"; oversize skipped: {len(oversize)}" if oversize else ""))
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
