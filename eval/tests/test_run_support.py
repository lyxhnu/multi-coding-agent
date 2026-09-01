from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import run_health_monitor  # noqa: E402
import write_run_preflight  # noqa: E402


class RunSupportTest(unittest.TestCase):
    def test_source_fingerprint_changes_for_source_but_ignores_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "packages" / "agent" / "src" / "agent.ts"
            source.parent.mkdir(parents=True)
            source.write_text("one", encoding="utf-8")
            first = write_run_preflight.source_fingerprint(root)
            jobs = root / "eval" / "jobs" / "job"
            jobs.mkdir(parents=True)
            (jobs / "result.json").write_text("ignored", encoding="utf-8")
            self.assertEqual(write_run_preflight.source_fingerprint(root), first)
            source.write_text("two", encoding="utf-8")
            self.assertNotEqual(write_run_preflight.source_fingerprint(root), first)

    def test_task_images_records_inspected_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            tasks = Path(temp)
            task = tasks / "task-a"
            task.mkdir()
            (task / "task.toml").write_text(
                '[environment]\ndocker_image = "example/image:tag"\n', encoding="utf-8"
            )
            inspected = {
                "Id": "sha256:abc",
                "RepoDigests": ["example/image@sha256:def"],
                "Architecture": "amd64",
                "Os": "linux",
            }
            with patch.object(
                write_run_preflight,
                "command_output",
                return_value=json.dumps(inspected),
            ):
                images = write_run_preflight.task_images(tasks, ["task-a"])
            self.assertEqual(images[0]["id"], "sha256:abc")
            self.assertEqual(images[0]["tasks"], ["task-a"])

    def test_health_monitor_records_normal_command_exit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            health = root / "health.jsonl"
            with patch.object(run_health_monitor, "docker_ok", return_value=True):
                code = run_health_monitor.run_monitored(
                    [sys.executable, "-c", "raise SystemExit(0)"],
                    health,
                    root,
                    0.000001,
                    0.1,
                    0.1,
                )
            self.assertEqual(code, 0)
            records = [json.loads(line) for line in health.read_text().splitlines()]
            self.assertTrue(records)
            self.assertTrue(all(record["dockerOk"] for record in records))
            self.assertEqual(records[-1]["event"], "harbor_exit")

    def test_health_monitor_exit_codes_are_documented(self) -> None:
        self.assertIn("Exit 2", run_health_monitor.__doc__ or "")
        self.assertIn("Exit 3", run_health_monitor.__doc__ or "")


if __name__ == "__main__":
    unittest.main()
