#!/usr/bin/env python3
"""Report Docker Hub download size for every TB2 task image.

Queries the registry API from the host (the only network path that works here)
and prints compressed layer totals, marking which images are already loaded in
the local Docker store.

Usage: python3 scripts/probe_tb2_image_sizes.py [task ...]
"""
import subprocess
import sys
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

TASKS = Path(__file__).resolve().parent.parent / "local_tasks" / "tb2_all"

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
    except Exception:
        return None


def size_of(ref: str) -> tuple[int, str]:
    name, tag = ref.rsplit(":", 1)
    repo = name if "/" in name else f"library/{name}"
    tok = requests.get(
        f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull",
        timeout=30,
    ).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    j = requests.get(f"https://registry-1.docker.io/v2/{repo}/manifests/{tag}",
                     headers={**h, "Accept": INDEX_ACCEPT}, timeout=30).json()
    arch = "single"
    if "manifests" in j:
        pick = None
        for want in ("arm64", "amd64"):
            for m in j["manifests"]:
                p = m.get("platform", {})
                if p.get("architecture") == want and p.get("os") == "linux":
                    pick, arch = m["digest"], want
                    break
            if pick:
                break
        j = requests.get(f"https://registry-1.docker.io/v2/{repo}/manifests/{pick}",
                         headers={**h, "Accept": MANIFEST_ACCEPT}, timeout=30).json()
    return sum(layer["size"] for layer in j.get("layers", [])), arch


def have(ref: str) -> bool:
    return subprocess.run(["docker", "image", "inspect", ref],
                          capture_output=True).returncode == 0


def main():
    names = sys.argv[1:]
    dirs = ([TASKS / n for n in names] if names
            else sorted(d for d in TASKS.iterdir() if d.is_dir()))

    refs: dict[str, list[str]] = {}
    for d in dirs:
        ref = image_of(d)
        if ref:
            refs.setdefault(ref, []).append(d.name)

    def probe(ref: str):
        try:
            sz, arch = size_of(ref)
            return ref, sz, arch, None
        except Exception as e:
            return ref, 0, "?", str(e)[:70]

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(probe, refs))

    pending_bytes = present_bytes = 0
    rows = []
    for ref, sz, arch, err in results:
        present = have(ref)
        if err:
            rows.append((0, f"   ERROR  {ref}: {err}"))
            continue
        if present:
            present_bytes += sz
        else:
            pending_bytes += sz
        flag = "LOCAL" if present else "     "
        rows.append((sz, f"{sz/1e6:8.0f} MB  {arch:6} {flag}  {','.join(refs[ref])[:40]}"))

    for _, line in sorted(rows, reverse=True):
        print(line)

    n_pending = sum(1 for r in results if not have(r[0]))
    print(f"\nimages: {len(refs)} total, {len(refs)-n_pending} already local, {n_pending} to download")
    print(f"already local : {present_bytes/1e9:.1f} GB compressed")
    print(f"to download   : {pending_bytes/1e9:.1f} GB compressed "
          f"(~{pending_bytes*1.6/1e9:.1f} GB uncompressed in the docker store)")


if __name__ == "__main__":
    main()
