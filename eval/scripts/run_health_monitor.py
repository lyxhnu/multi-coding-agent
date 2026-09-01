#!/usr/bin/env python3
"""Run Harbor while recording Docker and disk health.

Exit 2 means Docker became unavailable. Exit 3 means free disk crossed the
configured floor. In both cases the Harbor process group is terminated before
the monitor returns.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path


def docker_ok() -> bool:
    try:
        result = subprocess.run(
            ["docker", "info"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def free_disk_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / 1_000_000_000


def append_health(
    path: Path, *, docker_available: bool, free_gb: float, harbor_running: bool, event: str
) -> None:
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "dockerOk": docker_available,
        "freeDiskGb": round(free_gb, 3),
        "harborRunning": harbor_running,
        "event": event,
    }
    with path.open("a", encoding="utf-8") as handle:
        json.dump(record, handle, sort_keys=True)
        handle.write("\n")
        handle.flush()


def stop_process_group(process: subprocess.Popen[bytes], grace_seconds: float) -> None:
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def run_monitored(
    command: list[str],
    health_file: Path,
    disk_path: Path,
    disk_floor_gb: float,
    interval: float,
    grace_seconds: float,
) -> int:
    if health_file.exists():
        raise FileExistsError(f"health record already exists: {health_file}")
    health_file.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(command, start_new_session=True)

    while True:
        available = docker_ok()
        free_gb = free_disk_gb(disk_path)
        running = process.poll() is None
        event = "sample"
        if not available:
            event = "docker_daemon_unavailable"
        elif free_gb < disk_floor_gb:
            event = "disk_exhaustion"
        elif not running:
            event = "harbor_exit"
        append_health(
            health_file,
            docker_available=available,
            free_gb=free_gb,
            harbor_running=running,
            event=event,
        )

        if not available:
            stop_process_group(process, grace_seconds)
            return 2
        if free_gb < disk_floor_gb:
            stop_process_group(process, grace_seconds)
            return 3
        if not running:
            return process.returncode or 0

        try:
            return_code = process.wait(timeout=interval)
        except subprocess.TimeoutExpired:
            continue
        available = docker_ok()
        free_gb = free_disk_gb(disk_path)
        append_health(
            health_file,
            docker_available=available,
            free_gb=free_gb,
            harbor_running=False,
            event="harbor_exit",
        )
        if not available:
            return 2
        if free_gb < disk_floor_gb:
            return 3
        return return_code


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--health-file", type=Path, required=True)
    parser.add_argument("--disk-path", type=Path, required=True)
    parser.add_argument("--disk-floor-gb", type=float, default=6.0)
    parser.add_argument("--interval", type=float, default=60.0)
    parser.add_argument("--grace-seconds", type=float, default=10.0)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")
    if args.disk_floor_gb <= 0 or args.interval <= 0 or args.grace_seconds <= 0:
        parser.error("disk floor, interval, and grace period must be positive")
    raise SystemExit(
        run_monitored(
            command,
            args.health_file,
            args.disk_path,
            args.disk_floor_gb,
            args.interval,
            args.grace_seconds,
        )
    )


if __name__ == "__main__":
    main()
