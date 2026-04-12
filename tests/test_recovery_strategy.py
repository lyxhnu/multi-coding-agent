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

from agents import AgentRuntimeState
from middlewares import RecoveryStrategyMiddleware


class RecoveryStrategyTests(unittest.TestCase):
    def test_repeated_environment_failures_switch_to_env_fix(self):
        state = AgentRuntimeState()
        middleware = RecoveryStrategyMiddleware()

        middleware.observe_tool_result("run_bash", {"command": "foo"}, "[error] command not found", state)
        middleware.observe_tool_result("run_bash", {"command": "foo"}, "[error] command not found", state)

        self.assertEqual(state.recovery.mode, "ENV_FIX")

    def test_repeated_same_failure_switches_to_spec_recheck(self):
        state = AgentRuntimeState()
        middleware = RecoveryStrategyMiddleware()

        middleware.observe_verification_failure("pytest::task_x failed", state)
        middleware.observe_verification_failure("pytest::task_x failed", state)

        self.assertEqual(state.recovery.mode, "SPEC_RECHECK")

    def test_repeated_edits_with_same_failure_switch_to_rethink(self):
        state = AgentRuntimeState()
        middleware = RecoveryStrategyMiddleware()

        middleware.observe_verification_failure("assert result.txt mismatch", state)
        middleware.observe_verification_failure("assert result.txt mismatch", state)
        middleware.observe_edit_attempt("result.txt", state)
        middleware.observe_edit_attempt("result.txt", state)

        self.assertEqual(state.recovery.mode, "RETHINK")
        self.assertTrue(state.task_board.requires_update)


if __name__ == "__main__":
    unittest.main()
