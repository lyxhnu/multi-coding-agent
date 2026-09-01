#!/usr/bin/env python3
"""Report which TB2 tasks are fully runnable offline from local assets.

A task is READY when its definition is present (task.toml / instruction.md /
tests), its verifier has the offline pytest wheels, and its Docker image is
already loaded in the local image store.

Usage: python3 scripts/tb2_status.py [--ready-list]
"""
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASKS = ROOT / "local_tasks" / "tb2_all"


def local_images() -> set[str]:
    out = subprocess.run(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
                         capture_output=True, text=True).stdout
    return set(out.split())


def main():
    have = local_images()
    ready, no_image, broken = [], [], []

    for d in sorted(p for p in TASKS.iterdir() if p.is_dir()):
        toml = d / "task.toml"
        if not toml.exists():
            broken.append((d.name, "no task.toml"))
            continue
        cfg = tomllib.loads(toml.read_text())
        ref = (cfg.get("environment") or {}).get("docker_image")
        timeout = (cfg.get("agent") or {}).get("timeout_sec")
        diff = (cfg.get("metadata") or {}).get("difficulty", "?")

        missing = [n for n in ("instruction.md",) if not (d / n).exists()]
        if not (d / "tests" / "test.sh").exists():
            missing.append("tests/test.sh")
        if not list((d / "tests" / "_wheels").glob("*.whl")):
            missing.append("tests/_wheels")
        if missing:
            broken.append((d.name, ", ".join(missing)))
            continue
        if ref not in have:
            no_image.append((d.name, ref))
            continue
        ready.append((d.name, diff, timeout))

    if "--ready-list" in sys.argv:
        print(" ".join(n for n, _, _ in ready))
        return

    print(f"READY (definition + offline verifier + local image): {len(ready)}")
    for name, diff, timeout in ready:
        print(f"   {str(int(timeout or 0)):>5}s  {diff:8} {name}")
    if no_image:
        print(f"\nMISSING IMAGE (definition ready, image not mirrored): {len(no_image)}")
        for name, ref in no_image:
            print(f"   {name:32} {ref}")
    if broken:
        print(f"\nINCOMPLETE DEFINITION: {len(broken)}")
        for name, why in broken:
            print(f"   {name:32} {why}")
    print(f"\ntotal tasks: {len(ready)+len(no_image)+len(broken)}")


if __name__ == "__main__":
    main()
