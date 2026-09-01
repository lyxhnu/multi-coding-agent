#!/usr/bin/env python3
"""Report raw and evidence-adjusted pass rates for one TB2 Harbor job."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Evidence:
    source: str
    text: str


@dataclass(frozen=True)
class InfrastructureFailure:
    task: str
    category: str
    source: str
    excerpt: str


INFRASTRUCTURE_PATTERNS = (
    (
        "provider_connection_error",
        re.compile(r"Connection error|APIConnectionError|provider[^\n]{0,80}connection", re.I),
    ),
    (
        "verifier_missing_python",
        re.compile(
            r"(?:^|\s)-m:\s+command not found|python3?:\s+(?:command not found|not found)|"
            r"No such file or directory[^\n]{0,80}python",
            re.I | re.M,
        ),
    ),
    (
        "docker_daemon_unavailable",
        re.compile(r"Docker daemon is unavailable|Cannot connect to the Docker daemon", re.I),
    ),
    (
        "disk_exhaustion",
        re.compile(r"No space left on device|disk quota exceeded|disk exhaustion", re.I),
    ),
)
VERIFIER_TIMEOUT = re.compile(r"VerifierTimeoutError")


def load_json(path: Path) -> dict[str, object]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"expected JSON object: {path}")
    return data


def task_name(trial: Path) -> str:
    return trial.name.rsplit("__", 1)[0]


def trial_evidence(trial: Path, result: dict[str, object]) -> list[Evidence]:
    evidence: list[Evidence] = []
    exception_info = result.get("exception_info")
    if exception_info:
        text = (
            exception_info
            if isinstance(exception_info, str)
            else json.dumps(exception_info, ensure_ascii=False, sort_keys=True)
        )
        evidence.append(Evidence("result.json:exception_info", text))
    for relative in (Path("exception.txt"), Path("verifier") / "test-stdout.txt"):
        path = trial / relative
        if path.is_file():
            evidence.append(Evidence(relative.as_posix(), path.read_text(encoding="utf-8", errors="replace")))
    return evidence


def reward(result: dict[str, object]) -> object:
    verifier = result.get("verifier_result")
    if not isinstance(verifier, dict):
        return None
    rewards = verifier.get("rewards")
    return rewards.get("reward") if isinstance(rewards, dict) else None


def excerpt(text: str, match: re.Match[str]) -> str:
    line_start = text.rfind("\n", 0, match.start()) + 1
    line_end = text.find("\n", match.end())
    if line_end < 0:
        line_end = len(text)
    return text[line_start:line_end].strip()[:240]


def classify_infrastructure_failure(
    task: str, evidence: list[Evidence]
) -> InfrastructureFailure | None:
    for category, pattern in INFRASTRUCTURE_PATTERNS:
        for item in evidence:
            match = pattern.search(item.text)
            if match:
                return InfrastructureFailure(task, category, item.source, excerpt(item.text, match))
    return None


def read_health(path: Path) -> list[dict[str, object]]:
    records = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid health JSON at line {number}: {path}") from error
        if not isinstance(record, dict):
            raise ValueError(f"health line {number} is not an object: {path}")
        records.append(record)
    if not records:
        raise ValueError(f"health record is empty: {path}")
    return records


def summarize(job: Path) -> tuple[dict[str, object], bool]:
    eval_root = job.resolve().parents[1]
    job_id = job.name
    preflight_path = eval_root / "run-records" / f"{job_id}-preflight.json"
    health_path = eval_root / "run-records" / f"{job_id}-health.jsonl"
    if not preflight_path.is_file():
        raise ValueError(f"missing preflight record: {preflight_path}")
    if not health_path.is_file():
        raise ValueError(f"missing health record: {health_path}")
    preflight = load_json(preflight_path)
    health = read_health(health_path)

    trials = sorted(path.parent for path in job.glob("*__*/result.json"))
    results = [(task_name(trial), trial, load_json(trial / "result.json")) for trial in trials]
    expected_tasks = preflight.get("tasks")
    if not isinstance(expected_tasks, list) or not all(isinstance(task, str) for task in expected_tasks):
        raise ValueError("preflight.tasks must be a string list")
    completed_tasks = [name for name, _, _ in results]
    complete = len(results) == len(expected_tasks) and sorted(completed_tasks) == sorted(expected_tasks)

    passed = sum(reward(result) == 1.0 for _, _, result in results)
    infrastructure: list[InfrastructureFailure] = []
    verifier_timeouts: list[str] = []
    for name, trial, result in results:
        if reward(result) == 1.0:
            continue
        evidence = trial_evidence(trial, result)
        failure = classify_infrastructure_failure(name, evidence)
        if failure is not None:
            infrastructure.append(failure)
        if any(VERIFIER_TIMEOUT.search(item.text) for item in evidence):
            verifier_timeouts.append(name)

    total = len(results)
    effective_total = total - len(infrastructure)
    raw_rate = passed / total if total else 0.0
    effective_rate = passed / effective_total if effective_total else 0.0
    docker_healthy = all(record.get("dockerOk") is True for record in health)
    disk_healthy = all(record.get("event") != "disk_exhaustion" for record in health)
    accepted = complete and docker_healthy and disk_healthy
    report: dict[str, object] = {
        "jobId": job_id,
        "expectedTasks": len(expected_tasks),
        "completedTasks": total,
        "passed": passed,
        "rawRate": raw_rate,
        "effectiveDenominator": effective_total,
        "effectiveRate": effective_rate,
        "infrastructureFailures": infrastructure,
        "verifierTimeouts": sorted(set(verifier_timeouts)),
        "dockerHealthy": docker_healthy,
        "diskHealthy": disk_healthy,
        "complete": complete,
    }
    return report, accepted


def print_report(report: dict[str, object]) -> None:
    total = int(report["completedTasks"])
    passed = int(report["passed"])
    effective_total = int(report["effectiveDenominator"])
    print(f"job: {report['jobId']}")
    print(f"completed: {total}/{report['expectedTasks']}")
    print(f"raw pass rate: {passed}/{total} = {float(report['rawRate']) * 100:.2f}%")
    print(
        f"effective pass rate: {passed}/{effective_total} = "
        f"{float(report['effectiveRate']) * 100:.2f}%"
    )
    failures = report["infrastructureFailures"]
    assert isinstance(failures, list)
    print(f"confirmed infrastructure exclusions: {len(failures)}")
    for failure in failures:
        assert isinstance(failure, InfrastructureFailure)
        print(
            f"  - {failure.task}: {failure.category}; "
            f"evidence={failure.source}: {failure.excerpt}"
        )
    timeouts = report["verifierTimeouts"]
    assert isinstance(timeouts, list)
    print(f"verifier timeout constraints (reported separately, not an allowed exclusion class): {len(timeouts)}")
    for task in timeouts:
        print(f"  - {task}: VerifierTimeoutError")
    print(f"docker healthy throughout: {str(report['dockerHealthy']).lower()}")
    print(f"disk guard not triggered: {str(report['diskHealthy']).lower()}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", type=Path)
    args = parser.parse_args()
    report, accepted = summarize(args.job)
    print_report(report)
    if not accepted:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
