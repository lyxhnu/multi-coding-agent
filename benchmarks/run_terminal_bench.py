from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path


DATASET_ARCHIVE_URL = (
    "https://github.com/laude-institute/terminal-bench-2/archive/refs/heads/main.zip"
)
GHCR_IMAGE_PREFIX = "ghcr.io/laude-institute/terminal-bench"


def resolve_harbor_executable(env: dict[str, str]) -> str:
    harbor_path = shutil.which("harbor") or shutil.which("harbor.exe")
    if harbor_path:
        return harbor_path

    candidates = [
        Path(env.get("APPDATA", "")) / "Python" / "Python312" / "Scripts" / "harbor.exe",
        Path(env.get("USERPROFILE", "")) / "AppData" / "Roaming" / "Python" / "Python312" / "Scripts" / "harbor.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    return "harbor"


def build_launch_environment(
    repo_root: Path,
    base_env: dict[str, str] | None = None,
    dotenv_path: Path | None = None,
) -> dict[str, str]:
    env = dict(base_env or os.environ.copy())
    temp_dir = (repo_root / ".harbor" / "tmp").resolve()
    temp_dir.mkdir(parents=True, exist_ok=True)
    env["TEMP"] = str(temp_dir)
    env["TMP"] = str(temp_dir)

    dotenv_file = dotenv_path or (repo_root / ".env")
    if dotenv_file.exists():
        for raw_line in dotenv_file.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if key and key not in env:
                env[key] = value

    return env


def default_local_dataset_path(repo_root: Path) -> Path:
    return (repo_root / ".harbor" / "datasets" / "terminal-bench-2").resolve()


def is_valid_harbor_dataset(dataset_path: Path) -> bool:
    return any(dataset_path.glob("*/task.toml"))


def _download_and_extract_dataset_archive(dataset_path: Path) -> None:
    dataset_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(dataset_path.parent)) as temp_dir_str:
        temp_dir = Path(temp_dir_str)
        archive_path = temp_dir / "terminal-bench-2.zip"
        urllib.request.urlretrieve(DATASET_ARCHIVE_URL, archive_path)
        extract_dir = temp_dir / "extract"
        extract_dir.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(extract_dir)

        extracted_roots = [path for path in extract_dir.iterdir() if path.is_dir()]
        if len(extracted_roots) != 1:
            raise RuntimeError(
                f"Expected exactly one extracted root in {extract_dir}, found {len(extracted_roots)}"
            )

        source_root = extracted_roots[0]
        dataset_path.mkdir(parents=True, exist_ok=True)
        for child in source_root.iterdir():
            shutil.move(str(child), str(dataset_path / child.name))


def ensure_local_dataset(dataset_path: Path) -> Path:
    resolved = dataset_path.resolve()
    if is_valid_harbor_dataset(resolved):
        return resolved

    if resolved.exists():
        shutil.rmtree(resolved)

    _download_and_extract_dataset_archive(resolved)

    if not is_valid_harbor_dataset(resolved):
        raise RuntimeError(
            f"Local dataset checkout at {resolved} does not contain Harbor tasks."
        )

    return resolved


def rewrite_task_images_to_ghcr(dataset_path: Path) -> int:
    rewritten = 0
    for task_file in dataset_path.glob("*/task.toml"):
        task_name = task_file.parent.name
        content = task_file.read_text(encoding="utf-8")
        updated = re.sub(
            r'^docker_image\s*=\s*".*"$',
            f'docker_image = "{GHCR_IMAGE_PREFIX}/{task_name}:2.0"',
            content,
            flags=re.MULTILINE,
        )
        if updated != content:
            task_file.write_text(updated, encoding="utf-8")
            rewritten += 1
    return rewritten


def build_harbor_run_command(
    harbor_executable: str,
    tasks: list[str],
    runner_env: str | None,
    dataset_path: Path | None,
    force_build: bool,
) -> list[str]:
    command = [harbor_executable, "run"]
    if dataset_path is None:
        command.extend(["-d", "terminal-bench@2.0"])
    else:
        command.extend(["--path", str(dataset_path)])

    command.extend(["--agent-import-path", "benchmarks.harbor_agent:HarnessAgent"])

    if runner_env:
        command.extend(["--env", runner_env])
    if force_build:
        command.append("--force-build")
    for task in tasks:
        command.extend(["--include-task-name", task])

    return command


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run Terminal-Bench 2.0 from a local dataset rewritten to GHCR images."
    )
    parser.add_argument(
        "--task",
        action="append",
        default=[],
        help="Task name to run. Repeat to include multiple tasks.",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Run the full local dataset. If omitted and no --task is given, the full dataset is still run.",
    )
    parser.add_argument(
        "--dataset-path",
        type=Path,
        default=None,
        help="Local dataset directory. Defaults to repo-local .harbor/datasets/terminal-bench-2",
    )
    parser.add_argument(
        "--env",
        dest="runner_env",
        default=None,
        help="Harbor environment backend, for example daytona.",
    )
    parser.add_argument(
        "--force-build",
        action="store_true",
        help="Force Harbor to build environments locally instead of using task docker_image.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    env = build_launch_environment(repo_root)
    harbor_executable = resolve_harbor_executable(env)

    dataset_path = ensure_local_dataset(args.dataset_path or default_local_dataset_path(repo_root))
    rewritten_count = rewrite_task_images_to_ghcr(dataset_path)

    tasks = [] if args.full else args.task
    command = build_harbor_run_command(
        harbor_executable=harbor_executable,
        tasks=tasks,
        runner_env=args.runner_env,
        dataset_path=dataset_path,
        force_build=args.force_build,
    )

    print(f"Using TEMP/TMP: {env['TEMP']}")
    print(f"Prepared local dataset: {dataset_path}")
    print(f"Rewrote {rewritten_count} task images to GHCR")
    print(f"Running: {' '.join(command)}")

    completed = subprocess.run(command, cwd=repo_root, env=env)
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
