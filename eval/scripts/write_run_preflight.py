#!/usr/bin/env python3
"""Write an auditable TB2 run preflight record before Harbor starts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import socket
import subprocess
import tempfile
import tomllib
from datetime import datetime, timezone
from pathlib import Path

EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".harbor",
    ".artifacts",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
}
EXCLUDED_RELATIVE_DIRECTORIES = {
    "eval/assets",
    "eval/jobs",
    "eval/local_tasks",
    "eval/run-records",
}
EXCLUDED_FILE_NAMES = {
    ".env",
    "PROJECT_SNAPSHOT.md",
    "pi-eval-supplement.manifest.json",
    "pi-eval-supplement.tar.gz",
}


def sha256_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def source_fingerprint(root: Path) -> tuple[int, str]:
    records: list[tuple[str, Path]] = []
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        current_relative = current_path.relative_to(root)
        directories[:] = sorted(
            name
            for name in directories
            if name not in EXCLUDED_DIRECTORY_NAMES
            and (current_relative / name).as_posix() not in EXCLUDED_RELATIVE_DIRECTORIES
            and not (current_path / name).is_symlink()
        )
        for name in sorted(files):
            path = current_path / name
            if name in EXCLUDED_FILE_NAMES or path.is_symlink():
                continue
            records.append((path.relative_to(root).as_posix(), path))

    digest = hashlib.sha256()
    for relative, path in records:
        size, file_sha256 = sha256_file(path)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(file_sha256.encode("ascii"))
        digest.update(b"\n")
    return len(records), digest.hexdigest()


def command_output(command: list[str]) -> str:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def task_images(task_root: Path, tasks: list[str]) -> list[dict[str, object]]:
    references: dict[str, list[str]] = {}
    for task in tasks:
        config_path = task_root / task / "task.toml"
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        reference = (config.get("environment") or {}).get("docker_image")
        if not isinstance(reference, str) or not reference:
            raise ValueError(f"task has no environment.docker_image: {task}")
        references.setdefault(reference, []).append(task)

    images = []
    for reference, image_tasks in sorted(references.items()):
        raw = command_output(["docker", "image", "inspect", reference, "--format", "{{json .}}"])
        data = json.loads(raw)
        images.append(
            {
                "reference": reference,
                "id": data.get("Id"),
                "repoDigests": data.get("RepoDigests") or [],
                "architecture": data.get("Architecture"),
                "os": data.get("Os"),
                "tasks": sorted(image_tasks),
            }
        )
    return images


def atomic_write_json(path: Path, data: dict[str, object]) -> None:
    if path.exists():
        raise FileExistsError(f"preflight record already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as handle:
            temp_name = handle.name
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp_name, path)
        temp_name = None
    finally:
        if temp_name is not None:
            Path(temp_name).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--task-root", type=Path, required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--concurrency", type=int, required=True)
    parser.add_argument("--multiplier", type=float, required=True)
    parser.add_argument("tasks", nargs="+")
    args = parser.parse_args()

    root = args.root.resolve()
    snapshot_size, snapshot_sha256 = sha256_file(args.snapshot)
    runtime_size, runtime_sha256 = sha256_file(args.runtime)
    source_files, source_sha256 = source_fingerprint(root)
    docker_version = command_output(["docker", "version", "--format", "{{.Server.Version}}"])

    record: dict[str, object] = {
        "formatVersion": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "jobId": args.job_id,
        "source": {"files": source_files, "sha256": source_sha256},
        "snapshot": {
            "path": str(args.snapshot.resolve()),
            "size": snapshot_size,
            "sha256": snapshot_sha256,
        },
        "runtime": {
            "path": str(args.runtime.resolve()),
            "size": runtime_size,
            "sha256": runtime_sha256,
        },
        "model": args.model,
        "baseUrl": args.base_url,
        "concurrency": args.concurrency,
        "timeoutMultiplier": args.multiplier,
        "tasks": args.tasks,
        "taskCount": len(args.tasks),
        "images": task_images(args.task_root, args.tasks),
        "host": {
            "hostname": socket.gethostname(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "dockerServer": docker_version,
        },
    }
    atomic_write_json(args.output, record)
    print(f"wrote preflight record: {args.output}")


if __name__ == "__main__":
    main()
