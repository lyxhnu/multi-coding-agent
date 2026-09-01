#!/usr/bin/env python3
"""
Analyze Terminal-Bench 2.0 job results.

Usage:
  python scripts/analyze_results.py jobs/2026-04-02__13-52-59
  python scripts/analyze_results.py jobs/2026-04-02__13-52-59 --failed-only
  python scripts/analyze_results.py jobs/2026-04-02__13-52-59 --retry-cmd
"""
import json
import sys
from pathlib import Path
from datetime import datetime


def classify_failure(trial_dir: Path) -> str:
    """Classify why a trial failed."""
    exc_file = trial_dir / "exception.txt"
    result_file = trial_dir / "result.json"

    if exc_file.exists():
        text = exc_file.read_text(errors="replace")
        if "rate_limit" in text or "429" in text:
            return "rate_limit"
        if "timed out" in text.lower() or "AgentTimeoutError" in text:
            return "timeout"
        if "command not found" in text.lower():
            return "missing_tool"
        if "ModuleNotFoundError" in text:
            return "missing_module"
        if "Conflict" in text and "container name" in text:
            return "docker_conflict"
        if "Connection error" in text or "API preflight failed" in text:
            return "api_error"
        return "other_exception"

    if result_file.exists():
        r = json.loads(result_file.read_text())
        ae = r.get("agent_execution", {})
        if ae and ae.get("started_at") and ae.get("finished_at"):
            s = datetime.fromisoformat(ae["started_at"].rstrip("Z"))
            e = datetime.fromisoformat(ae["finished_at"].rstrip("Z"))
            duration = (e - s).total_seconds()
            if duration < 10:
                return "instant_exit"
    return "task_failure"


def analyze_job(job_dir: Path, failed_only: bool = False):
    """Analyze all trials in a job directory."""
    result_file = job_dir / "result.json"
    if not result_file.exists():
        print(f"No result.json in {job_dir}")
        return

    job_result = json.loads(result_file.read_text())

    # Find all trial directories
    trials = []
    for d in sorted(job_dir.iterdir()):
        if d.is_dir() and (d / "result.json").exists():
            tr = json.loads((d / "result.json").read_text())
            reward = 0.0
            vr = tr.get("verifier_result")
            if vr and vr.get("rewards"):
                reward = vr["rewards"].get("reward", 0.0)

            duration = 0
            ae = tr.get("agent_execution", {})
            if ae and ae.get("started_at") and ae.get("finished_at"):
                s = datetime.fromisoformat(ae["started_at"].rstrip("Z"))
                e = datetime.fromisoformat(ae["finished_at"].rstrip("Z"))
                duration = int((e - s).total_seconds())

            task_name = tr.get("task_name", d.name)
            failure_type = classify_failure(d) if reward == 0 else ""

            trials.append({
                "name": task_name,
                "trial": d.name,
                "reward": reward,
                "duration": duration,
                "failure": failure_type,
                "dir": d,
            })

    # Stats
    total = len(trials)
    passed = sum(1 for t in trials if t["reward"] > 0)
    failed = total - passed

    print(f"\n{'='*60}")
    print(f"JOB: {job_dir.name}")
    print(f"{'='*60}")
    print(f"Total: {total}  Passed: {passed}  Failed: {failed}  Rate: {passed/total*100:.1f}%\n")

    # Failure breakdown
    if failed > 0:
        categories = {}
        for t in trials:
            if t["reward"] == 0:
                cat = t["failure"]
                categories.setdefault(cat, []).append(t["name"])

        print("FAILURE BREAKDOWN:")
        for cat in sorted(categories, key=lambda c: -len(categories[c])):
            names = categories[cat]
            print(f"  {cat:20s}: {len(names)} tasks")
            for n in names:
                print(f"    - {n}")
        print()

    # Task details
    if failed_only:
        show = [t for t in trials if t["reward"] == 0]
        print(f"FAILED TASKS ({len(show)}):")
    else:
        show = trials
        print(f"ALL TASKS ({len(show)}):")

    for t in show:
        status = "✅" if t["reward"] > 0 else "❌"
        dur = f"{t['duration']:>4}s" if t["duration"] else "  N/A"
        fail = f" [{t['failure']}]" if t["failure"] else ""
        print(f"  {status} {t['name']:40s} {dur}{fail}")

    print()
    return trials


def generate_retry_cmd(trials: list, job_dir: Path):
    """Generate harbor command to retry failed tasks."""
    failed = [t for t in trials if t["reward"] == 0]
    # Exclude timeouts (likely won't pass on retry)
    retryable = [t for t in failed if t["failure"] not in ("timeout",)]

    if not retryable:
        print("No retryable failures found.")
        return

    task_args = " \\\n  ".join(f"--task-name {t['name']}" for t in retryable)
    print(f"RETRY COMMAND ({len(retryable)} tasks, excluding timeouts):\n")
    print(f"harbor run -d \"terminal-bench@2.0\" \\")
    print(f"  --agent-import-path benchmarks.harbor_agent:HarnessAgent \\")
    print(f"  -k 1 \\")
    print(f"  --n-concurrent 1 \\")
    print(f"  --agent-setup-timeout-multiplier 2 \\")
    print(f"  --max-retries 3 \\")
    print(f"  --retry-include DaytonaError \\")
    print(f"  --retry-include AgentSetupTimeoutError \\")
    print(f"  --retry-include AddTestsDirError \\")
    print(f"  {task_args}")
    print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/analyze_results.py <job_dir> [--failed-only] [--retry-cmd]")
        sys.exit(1)

    job_dir = Path(sys.argv[1])
    failed_only = "--failed-only" in sys.argv
    retry_cmd = "--retry-cmd" in sys.argv

    trials = analyze_job(job_dir, failed_only=failed_only)
    if retry_cmd and trials:
        generate_retry_cmd(trials, job_dir)
