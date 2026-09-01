#!/usr/bin/env python3
"""Verify restored TB2 assets against the supplement manifest."""

from __future__ import annotations

import argparse
from pathlib import Path

from restore_eval_supplement import load_manifest, sha256_file, verify_restored_files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()

    root = args.root.resolve()
    manifest = load_manifest(args.manifest)
    _, snapshot_sha256 = sha256_file(args.snapshot)
    if snapshot_sha256 != manifest.snapshot_sha256:
        raise SystemExit(
            f"snapshot sha256 mismatch: expected {manifest.snapshot_sha256}, got {snapshot_sha256}"
        )
    verify_restored_files(root, manifest)

    tasks = root / "eval" / "local_tasks" / "tb2_all"
    wheels = root / "eval" / "assets" / "pytest_wheels"
    task_count = sum(path.is_dir() for path in tasks.iterdir()) if tasks.is_dir() else 0
    wheel_count = len(list(wheels.glob("*.whl"))) if wheels.is_dir() else 0
    if task_count != 89:
        raise SystemExit(f"expected 89 TB2 task directories, found {task_count}")
    if wheel_count != 9:
        raise SystemExit(f"expected 9 pytest wheels, found {wheel_count}")

    required = {
        "eval/assets/node-v22.23.2-linux-x64.tar.gz",
        "eval/assets/cpython-3.12-x86_64.tar.gz",
    }
    listed = {record.path for record in manifest.files}
    missing = sorted(required - listed)
    if missing:
        raise SystemExit(f"manifest is missing required fixed-hash assets: {missing}")
    print(
        f"asset gate passed: {len(manifest.files)} manifest files, "
        f"{task_count} tasks, {wheel_count} wheels"
    )


if __name__ == "__main__":
    main()
