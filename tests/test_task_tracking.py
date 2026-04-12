import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path


def _install_fake_openai_module() -> None:
    openai = types.ModuleType("openai")

    class OpenAI:
        def __init__(self, *args, **kwargs):
            pass

    openai.OpenAI = OpenAI
    sys.modules["openai"] = openai


_install_fake_openai_module()

import config
from agents import AgentRuntimeState
from middlewares import TaskTrackingEnforcementMiddleware
from tools import execute_tool


class UpdateProgressToolTests(unittest.TestCase):
    def test_update_progress_updates_runtime_state_and_file(self):
        temp_dir = os.path.join(os.getcwd(), "workspace", "test-progress-tool")
        old_workspace = config.WORKSPACE
        try:
            os.makedirs(temp_dir, exist_ok=True)
            config.WORKSPACE = temp_dir
            state = AgentRuntimeState()
            result = execute_tool(
                "update_progress",
                {
                    "goal": "fix task",
                    "steps": ["inspect", "edit", "verify"],
                    "current_step": "inspect",
                    "completed_steps": [],
                    "blockers": [],
                    "next_action": "read tests",
                },
                runtime_state=state,
                agent_name="builder",
            )
            self.assertIn("Updated progress", result)
            self.assertEqual(state.task_board.current_step, "inspect")
            self.assertEqual(state.task_board.update_count, 1)
            self.assertTrue(Path(temp_dir, config.PROGRESS_FILE).exists())
        finally:
            config.WORKSPACE = old_workspace
            shutil.rmtree(temp_dir, ignore_errors=True)


class TaskTrackingEnforcementTests(unittest.TestCase):
    def test_builder_cannot_run_bash_before_progress_update(self):
        middleware = TaskTrackingEnforcementMiddleware()
        state = AgentRuntimeState()

        blocked = middleware.before_tool(
            "run_bash",
            {"command": "pwd"},
            messages=[],
            runtime_state=state,
            agent_name="builder",
        )

        self.assertIsNotNone(blocked)
        self.assertIn("update_progress", blocked)

    def test_builder_cannot_exit_without_final_progress_update(self):
        middleware = TaskTrackingEnforcementMiddleware()
        state = AgentRuntimeState()
        state.task_board.update_count = 1
        state.task_board.needs_final_update = True

        blocked = middleware.pre_exit(messages=[], runtime_state=state, agent_name="builder")

        self.assertIsNotNone(blocked)
        self.assertIn("update_progress", blocked)


if __name__ == "__main__":
    unittest.main()
