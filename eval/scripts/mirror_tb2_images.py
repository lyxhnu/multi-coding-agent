#!/usr/bin/env python3
"""Mirror TB2 task images into the local Docker image store.

Docker Hub `docker pull` does not work from this machine's daemon, but the
registry HTTP API is reachable from host Python — so images are fetched here
and `docker load`ed. The Docker image store is the persistent cache: once an
image is loaded, Harbor/compose never needs to pull it again.

Usage:
  python3 scripts/mirror_tb2_images.py                    # every task
  python3 scripts/mirror_tb2_images.py task1 task2 ...    # selected tasks
  python3 scripts/mirror_tb2_images.py --max-mb 300       # size-capped batch
  python3 scripts/mirror_tb2_images.py --workers 2        # parallel downloads

Disk guard: refuses to start a download when free space would drop below
MIN_FREE_GB, so a big image cannot fill the volume mid-benchmark.
"""
import argparse
import shutil
import subprocess
import sys
import tempfile
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
TASKS_DIR = ROOT / "local_tasks" / "tb2_all"
PULLER = ROOT / "scripts" / "pull_dockerhub_image.py"
# Cached output of probe_tb2_image_sizes.py. Reused for --max-mb so we don't
# spend Docker Hub's anonymous request quota re-measuring every image.
SIZE_CACHE = ROOT / ".image_sizes.txt"
PYTHON = sys.executable
MIN_FREE_GB = 6.0

INDEX_ACCEPT = ", ".join([
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
])
MANIFEST_ACCEPT = ", ".join([
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
])


def image_of(task_dir: Path) -> str | None:
    toml = task_dir / "task.toml"
    if not toml.exists():
        return None
    try:
        return (tomllib.loads(toml.read_text()).get("environment") or {}).get("docker_image")
    except Exception as e:
        print(f"!! {task_dir.name}: bad task.toml ({e})")
        return None


def have_image(ref: str) -> bool:
    return subprocess.run(["docker", "image", "inspect", ref],
                          capture_output=True).returncode == 0


def compressed_mb(ref: str) -> float:
    """Total compressed layer size, used for the --max-mb filter."""
    name, tag = ref.rsplit(":", 1)
    repo = name if "/" in name else f"library/{name}"
    tok = requests.get(
        f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull",
        timeout=30,
    ).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    j = requests.get(f"https://registry-1.docker.io/v2/{repo}/manifests/{tag}",
                     headers={**h, "Accept": INDEX_ACCEPT}, timeout=30).json()
    if "manifests" in j:
        pick = None
        for want in ("arm64", "amd64"):
            for m in j["manifests"]:
                p = m.get("platform", {})
                if p.get("architecture") == want and p.get("os") == "linux":
                    pick = m["digest"]
                    break
            if pick:
                break
        j = requests.get(f"https://registry-1.docker.io/v2/{repo}/manifests/{pick}",
                         headers={**h, "Accept": MANIFEST_ACCEPT}, timeout=30).json()
    return sum(layer["size"] for layer in j.get("layers", [])) / 1e6


def cached_sizes() -> dict[str, float]:
    """Task name -> compressed MB, parsed from the probe script's output."""
    if not SIZE_CACHE.exists():
        return {}
    import re
    sizes: dict[str, float] = {}
    for line in SIZE_CACHE.read_text().splitlines():
        m = re.match(r"\s*(\d+) MB\s+\S+\s+(?:LOCAL)?\s+(\S+)", line)
        if m:
            for task in m.group(2).split(","):
                sizes[task] = float(m.group(1))
    return sizes


def free_gb() -> float:
    return shutil.disk_usage("/").free / 1e9


def mirror(ref: str) -> bool:
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as tmp:
        tar_path = Path(tmp.name)
    try:
        for arch in ("arm64", "amd64"):
            print(f"   {ref}: downloading ({arch})...", flush=True)
            r = subprocess.run(
                [PYTHON, str(PULLER), ref, "--arch", arch, "--output", str(tar_path)],
                capture_output=True, text=True, timeout=7200,
            )
            if r.returncode == 0:
                break
            err = (r.stderr or r.stdout).strip().splitlines()
            print(f"   {ref}: {arch} failed: {err[-1][:130] if err else '?'}")
        else:
            return False
        print(f"   {ref}: loading ({tar_path.stat().st_size/1e6:.0f} MB tar)...", flush=True)
        r = subprocess.run(["docker", "load", "-i", str(tar_path)],
                           capture_output=True, text=True, timeout=3600)
        if r.returncode != 0:
            print(f"   {ref}: docker load failed: {r.stderr.strip()[:200]}")
            return False
        return True
    finally:
        tar_path.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tasks", nargs="*")
    ap.add_argument("--max-mb", type=float, default=None,
                    help="skip images whose compressed size exceeds this")
    ap.add_argument("--workers", type=int, default=1)
    args = ap.parse_args()

    dirs = ([TASKS_DIR / n for n in args.tasks] if args.tasks
            else sorted(d for d in TASKS_DIR.iterdir() if d.is_dir()))

    wanted: dict[str, list[str]] = {}
    for d in dirs:
        ref = image_of(d)
        if ref:
            wanted.setdefault(ref, []).append(d.name)

    todo = {r: t for r, t in wanted.items() if not have_image(r)}
    print(f"{len(wanted)} images referenced, {len(wanted)-len(todo)} already local, "
          f"{len(todo)} candidates")

    if args.max_mb is not None and todo:
        sizes_by_task = cached_sizes()
        measured: dict[str, float] = {}
        unknown = []
        for ref, tasks in todo.items():
            known = [sizes_by_task[t] for t in tasks if t in sizes_by_task]
            if known:
                measured[ref] = max(known)
            else:
                unknown.append(ref)
        if unknown:
            print(f"measuring {len(unknown)} uncached images (cap {args.max_mb:.0f} MB)...",
                  flush=True)
            with ThreadPoolExecutor(max_workers=4) as pool:
                for ref, mb in zip(unknown, pool.map(compressed_mb, unknown)):
                    measured[ref] = mb
        else:
            print(f"using cached sizes from {SIZE_CACHE.name} (cap {args.max_mb:.0f} MB)")
        skipped = {r: s for r, s in measured.items() if s > args.max_mb}
        for r, s in sorted(skipped.items(), key=lambda kv: -kv[1]):
            print(f"   skip {s/1000:5.1f} GB  {','.join(wanted[r])}")
        todo = {r: t for r, t in todo.items() if measured.get(r, 0) <= args.max_mb}

    print(f"\ndownloading {len(todo)} images (free disk {free_gb():.1f} GB)\n")
    ok = failed = aborted = 0
    order = sorted(todo)

    def work(ref: str) -> str:
        if free_gb() < MIN_FREE_GB:
            print(f"   {ref}: SKIPPED — free disk below {MIN_FREE_GB} GB")
            return "aborted"
        return "ok" if mirror(ref) else "failed"

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for ref, outcome in zip(order, pool.map(work, order)):
            print(f"[{outcome}] {ref}  ({', '.join(todo[ref])})", flush=True)
            ok += outcome == "ok"
            failed += outcome == "failed"
            aborted += outcome == "aborted"

    print(f"\nSUMMARY: {ok} mirrored, {failed} failed, {aborted} skipped for disk; "
          f"free disk now {free_gb():.1f} GB")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
