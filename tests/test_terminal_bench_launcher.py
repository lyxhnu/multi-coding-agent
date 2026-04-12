import os
import shutil
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from benchmarks.run_terminal_bench import (
    build_harbor_run_command,
    build_launch_environment,
    default_local_dataset_path,
    ensure_local_dataset,
    is_valid_harbor_dataset,
    resolve_harbor_executable,
    rewrite_task_images_to_ghcr,
)


class TerminalBenchLauncherTests(unittest.TestCase):
    def _workspace_path(self, name: str) -> Path:
        path = Path(os.getcwd()) / "workspace" / f"{name}-{uuid.uuid4().hex}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def test_build_command_uses_current_harbor_task_filter_flag(self):
        command = build_harbor_run_command(
            harbor_executable="harbor",
            tasks=["fix-git", "headless-terminal"],
            runner_env=None,
            dataset_path=None,
            force_build=False,
        )

        self.assertEqual(
            command,
            [
                "harbor",
                "run",
                "-d",
                "terminal-bench@2.0",
                "--agent-import-path",
                "benchmarks.harbor_agent:HarnessAgent",
                "--include-task-name",
                "fix-git",
                "--include-task-name",
                "headless-terminal",
            ],
        )

    def test_build_command_can_target_local_dataset_path(self):
        command = build_harbor_run_command(
            harbor_executable="harbor",
            tasks=["fix-git"],
            runner_env="daytona",
            dataset_path=Path("E:/tmp/terminal-bench-2"),
            force_build=False,
        )

        self.assertEqual(
            command,
            [
                "harbor",
                "run",
                "--path",
                "E:\\tmp\\terminal-bench-2",
                "--agent-import-path",
                "benchmarks.harbor_agent:HarnessAgent",
                "--env",
                "daytona",
                "--include-task-name",
                "fix-git",
            ],
        )

    def test_build_command_can_force_environment_build(self):
        command = build_harbor_run_command(
            harbor_executable="harbor",
            tasks=["fix-git"],
            runner_env=None,
            dataset_path=Path("E:/tmp/terminal-bench-2"),
            force_build=True,
        )

        self.assertEqual(
            command,
            [
                "harbor",
                "run",
                "--path",
                "E:\\tmp\\terminal-bench-2",
                "--agent-import-path",
                "benchmarks.harbor_agent:HarnessAgent",
                "--force-build",
                "--include-task-name",
                "fix-git",
            ],
        )

    def test_build_environment_uses_repo_local_temp_and_loads_missing_dotenv_values(self):
        repo_root = self._workspace_path("test-terminal-bench-launcher-env")
        try:
            dotenv_path = repo_root / ".env"
            dotenv_path.write_text(
                "OPENAI_API_KEY=test-key\nHARNESS_MODEL=dotenv-model\n",
                encoding="utf-8",
            )
            base_env = {
                "PATH": "base-path",
                "HARNESS_MODEL": "existing-model",
            }

            env = build_launch_environment(repo_root, base_env=base_env, dotenv_path=dotenv_path)

            expected_temp = str((repo_root / ".harbor" / "tmp").resolve())
            self.assertEqual(env["TEMP"], expected_temp)
            self.assertEqual(env["TMP"], expected_temp)
            self.assertEqual(env["OPENAI_API_KEY"], "test-key")
            self.assertEqual(env["HARNESS_MODEL"], "existing-model")
        finally:
            shutil.rmtree(repo_root, ignore_errors=True)

    def test_resolve_harbor_executable_falls_back_to_user_scripts(self):
        repo_root = self._workspace_path("test-terminal-bench-launcher-bin")
        try:
            appdata = repo_root / "AppData" / "Roaming"
            scripts_dir = appdata / "Python" / "Python312" / "Scripts"
            scripts_dir.mkdir(parents=True, exist_ok=True)
            harbor_path = scripts_dir / "harbor.exe"
            harbor_path.write_text("", encoding="utf-8")

            with patch("benchmarks.run_terminal_bench.shutil.which", return_value=None):
                resolved = resolve_harbor_executable(
                    {
                        "APPDATA": str(appdata),
                        "USERPROFILE": str(repo_root / "UserProfile"),
                    }
                )

            self.assertEqual(resolved, str(harbor_path))
        finally:
            shutil.rmtree(repo_root, ignore_errors=True)

    def test_default_local_dataset_path_is_repo_scoped(self):
        repo_root = Path("E:/repo-root")

        resolved = default_local_dataset_path(repo_root)

        self.assertEqual(
            resolved,
            (repo_root / ".harbor" / "datasets" / "terminal-bench-2").resolve(),
        )

    def test_is_valid_harbor_dataset_requires_task_toml(self):
        repo_root = self._workspace_path("test-terminal-bench-validity")
        try:
            invalid_dataset = repo_root / "terminal-bench-2"
            invalid_dataset.mkdir(parents=True, exist_ok=True)
            (invalid_dataset / ".git").mkdir(exist_ok=True)

            self.assertFalse(is_valid_harbor_dataset(invalid_dataset))

            valid_task_dir = invalid_dataset / "fix-git"
            valid_task_dir.mkdir(parents=True, exist_ok=True)
            (valid_task_dir / "task.toml").write_text("name='fix-git'\n", encoding="utf-8")

            self.assertTrue(is_valid_harbor_dataset(invalid_dataset))
        finally:
            shutil.rmtree(repo_root, ignore_errors=True)

    def test_ensure_local_dataset_reclones_invalid_partial_checkout(self):
        repo_root = self._workspace_path("test-terminal-bench-reclone")
        dataset_path = repo_root / ".harbor" / "datasets" / "terminal-bench-2"
        dataset_path.mkdir(parents=True, exist_ok=True)
        downloaded_paths = []

        def fake_download(path):
            downloaded_paths.append(path)
            task_dir = dataset_path / "fix-git"
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "task.toml").write_text("name='fix-git'\n", encoding="utf-8")

        try:
            with patch("benchmarks.run_terminal_bench.shutil.rmtree") as rmtree_mock, patch(
                "benchmarks.run_terminal_bench._download_and_extract_dataset_archive",
                side_effect=fake_download,
            ) as download_mock:
                resolved = ensure_local_dataset(dataset_path)

            self.assertEqual(resolved, dataset_path.resolve())
            self.assertTrue(is_valid_harbor_dataset(dataset_path))
            self.assertEqual(download_mock.call_count, 1)
            self.assertEqual(rmtree_mock.call_count, 1)
            self.assertEqual(downloaded_paths, [dataset_path.resolve()])
        finally:
            shutil.rmtree(repo_root, ignore_errors=True)

    def test_rewrite_task_images_to_ghcr_rewrites_each_task_toml(self):
        repo_root = self._workspace_path("test-terminal-bench-ghcr-rewrite")
        dataset_path = repo_root / ".harbor" / "datasets" / "terminal-bench-2"
        try:
            task_dir = dataset_path / "break-filter-js-from-html"
            task_dir.mkdir(parents=True, exist_ok=True)
            task_file = task_dir / "task.toml"
            task_file.write_text(
                "\n".join(
                    [
                        'version = "1.0"',
                        "",
                        "[environment]",
                        'docker_image = "alexgshaw/break-filter-js-from-html:20251031"',
                    ]
                ),
                encoding="utf-8",
            )

            rewritten = rewrite_task_images_to_ghcr(dataset_path)

            self.assertEqual(rewritten, 1)
            self.assertIn(
                'docker_image = "ghcr.io/laude-institute/terminal-bench/break-filter-js-from-html:2.0"',
                task_file.read_text(encoding="utf-8"),
            )
        finally:
            shutil.rmtree(repo_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
