import sys
import types
import unittest


def _install_fake_openai_module() -> None:
    openai = types.ModuleType("openai")

    class OpenAI:
        def __init__(self, *args, **kwargs):
            pass

    openai.OpenAI = OpenAI
    sys.modules["openai"] = openai


_install_fake_openai_module()

from agents import Agent
from middlewares import RecoveryStrategyMiddleware, TaskTrackingEnforcementMiddleware
from profiles.terminal import TerminalProfile


class AgentRuntimeStateTests(unittest.TestCase):
    def test_agent_creates_runtime_state_once_per_run(self):
        agent = Agent(name="builder", system_prompt="x", use_tools=False)
        state = agent._create_runtime_state("goal text")

        self.assertEqual(state.task_board.goal, "goal text")
        self.assertEqual(state.recovery.mode, "NORMAL")
        self.assertIsNone(state.shell_session)

    def test_terminal_builder_prompt_mentions_stateful_shell_progress_and_recovery(self):
        prompt = TerminalProfile().builder().system_prompt

        self.assertIn("persistent shell", prompt.lower())
        self.assertIn("update_progress", prompt)
        self.assertIn("recovery mode", prompt.lower())

    def test_terminal_builder_uses_enforcement_middlewares(self):
        middlewares = TerminalProfile().builder().middlewares

        self.assertTrue(any(isinstance(mw, TaskTrackingEnforcementMiddleware) for mw in middlewares))
        self.assertTrue(any(isinstance(mw, RecoveryStrategyMiddleware) for mw in middlewares))


if __name__ == "__main__":
    unittest.main()
