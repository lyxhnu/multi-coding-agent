import importlib
import sys
import types
import unittest


def _install_fake_harbor_modules() -> None:
    harbor = types.ModuleType("harbor")
    harbor_agents = types.ModuleType("harbor.agents")
    harbor_agents_installed = types.ModuleType("harbor.agents.installed")
    harbor_agents_installed_base = types.ModuleType("harbor.agents.installed.base")
    harbor_environments = types.ModuleType("harbor.environments")
    harbor_environments_base = types.ModuleType("harbor.environments.base")
    harbor_models = types.ModuleType("harbor.models")
    harbor_models_agent = types.ModuleType("harbor.models.agent")
    harbor_models_agent_context = types.ModuleType("harbor.models.agent.context")

    class BaseInstalledAgent:
        def __init__(self, *args, **kwargs):
            pass

    def with_prompt_template(fn):
        return fn

    class BaseEnvironment:
        pass

    class AgentContext:
        pass

    harbor_agents_installed_base.BaseInstalledAgent = BaseInstalledAgent
    harbor_agents_installed_base.with_prompt_template = with_prompt_template
    harbor_environments_base.BaseEnvironment = BaseEnvironment
    harbor_models_agent_context.AgentContext = AgentContext

    sys.modules["harbor"] = harbor
    sys.modules["harbor.agents"] = harbor_agents
    sys.modules["harbor.agents.installed"] = harbor_agents_installed
    sys.modules["harbor.agents.installed.base"] = harbor_agents_installed_base
    sys.modules["harbor.environments"] = harbor_environments
    sys.modules["harbor.environments.base"] = harbor_environments_base
    sys.modules["harbor.models"] = harbor_models
    sys.modules["harbor.models.agent"] = harbor_models_agent
    sys.modules["harbor.models.agent.context"] = harbor_models_agent_context


class HarnessAgentInstallTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        _install_fake_harbor_modules()
        sys.modules.pop("benchmarks.harbor_agent", None)
        self.module = importlib.import_module("benchmarks.harbor_agent")

    async def test_install_uses_user_repo_urls(self):
        commands = []

        class RecordingAgent(self.module.HarnessAgent):
            async def exec_as_root(self, environment, command):
                commands.append(("root", command))

            async def exec_as_agent(self, environment, command):
                commands.append(("agent", command))

        agent = RecordingAgent()
        await agent.install(environment=object())

        all_commands = "\n".join(command for _, command in commands)
        self.assertNotIn(
            "https://github.com/lazyFrogLOL/Harness_Engineering.git",
            all_commands,
        )
        self.assertIn(
            "https://github.com/lyxhnu/multi-agent.git",
            all_commands,
        )
        self.assertIn(
            "https://github.com/lyxhnu/multi-agent/archive/refs/heads/main.tar.gz",
            all_commands,
        )


if __name__ == "__main__":
    unittest.main()
