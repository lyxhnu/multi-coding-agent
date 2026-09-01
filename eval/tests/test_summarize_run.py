from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ANALYSIS = Path(__file__).resolve().parents[1] / "analysis"
sys.path.insert(0, str(ANALYSIS))

from summarize_run import summarize  # noqa: E402


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def result(reward: float | None, exception: str = "") -> dict[str, object]:
    return {
        "verifier_result": {"rewards": {"reward": reward}},
        "exception_info": exception,
    }


class SummarizeRunTest(unittest.TestCase):
    def make_run(self, root: Path) -> Path:
        eval_root = root / "eval"
        job = eval_root / "jobs" / "job-1"
        write_json(
            eval_root / "run-records" / "job-1-preflight.json",
            {"tasks": ["pass", "provider", "python", "docker", "disk", "trial-log-only"]},
        )
        health = eval_root / "run-records" / "job-1-health.jsonl"
        health.parent.mkdir(parents=True, exist_ok=True)
        health.write_text(
            json.dumps({"dockerOk": True, "event": "sample"}) + "\n",
            encoding="utf-8",
        )
        cases = {
            "pass": result(1.0),
            "provider": result(0.0, "stdout: Connection error."),
            "python": result(0.0),
            "docker": result(0.0, "Docker daemon is unavailable"),
            "disk": result(0.0, "No space left on device"),
            "trial-log-only": result(0.0),
        }
        for name, body in cases.items():
            trial = job / f"{name}__abc"
            write_json(trial / "result.json", body)
        python_trial = job / "python__abc"
        (python_trial / "verifier").mkdir()
        (python_trial / "verifier" / "test-stdout.txt").write_text(
            "test.sh: -m: command not found", encoding="utf-8"
        )
        (job / "trial-log-only__abc" / "trial.log").write_text(
            "Connection error and No space left on device", encoding="utf-8"
        )
        return job

    def test_reports_only_four_evidence_backed_infrastructure_classes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            report, accepted = summarize(self.make_run(Path(temp)))
            self.assertTrue(accepted)
            self.assertEqual(report["passed"], 1)
            self.assertEqual(report["completedTasks"], 6)
            self.assertEqual(report["effectiveDenominator"], 2)
            failures = report["infrastructureFailures"]
            self.assertEqual(
                {failure.category for failure in failures},
                {
                    "provider_connection_error",
                    "verifier_missing_python",
                    "docker_daemon_unavailable",
                    "disk_exhaustion",
                },
            )

    def test_rejects_incomplete_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            job = self.make_run(Path(temp))
            (job / "pass__abc" / "result.json").unlink()
            _, accepted = summarize(job)
            self.assertFalse(accepted)

    def test_rejects_unhealthy_health_record(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            job = self.make_run(Path(temp))
            health = job.parents[1] / "run-records" / "job-1-health.jsonl"
            health.write_text(
                json.dumps({"dockerOk": False, "event": "docker_daemon_unavailable"}) + "\n"
            )
            _, accepted = summarize(job)
            self.assertFalse(accepted)


if __name__ == "__main__":
    unittest.main()
