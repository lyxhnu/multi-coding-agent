"""
Harbor adapter — runs the pi coding agent (@earendil-works/pi-coding-agent)
on Terminal-Bench 2.0, side by side with our own HarnessAgent.

Same InstalledAgent pattern as harbor_agent.py, but the payload is a
self-contained node22+pi runtime tarball built once on the host by
scripts/build_pi_runtime.sh (linux/amd64, ~76MB). Nothing is fetched from
inside the container: this session has watched container networking drop three
separate times, and a benchmark row that dies in npm install measures the
network, not the agent.

pi differences that shape this adapter:
  - Headless mode is `pi -p "<instruction>"`: full read/bash/edit/write tool
    loop, exits when the model stops. No trust prompts in -p mode.
  - Model access comes from ~/.pi/agent/models.json. The dashscope entry is
    generated on the HOST with the real API key and uploaded as a file, so the
    key never appears in an exec command line (Harbor logs those).
  - compat.supportsDeveloperRole/supportsReasoningEffort are false: the
    dashscope OpenAI-compatible layer rejects both fields.
  - Sessions are written to /logs/agent so traces survive the container the
    same way harness traces do.

Usage:
  cd eval && AGENT=pi bash run_tb2.sh cobol-modernization
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import tempfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# The rig lives inside the pi source tree, so every payload path is derived from this file's location
# rather than hardcoded. EVAL_ROOT is pi-main/eval; PI_ROOT is the pi checkout that gets evaluated.
EVAL_ROOT = Path(__file__).resolve().parent.parent
PI_ROOT = EVAL_ROOT.parent

RUNTIME_TARBALL = EVAL_ROOT / "assets" / "pi-runtime-linux-x64.tar.gz"

# Standalone CPython, shared with harbor_agent.py's Step 3. pi itself never needs Python — this is
# purely for the *verifier*: patch_tb2_tests.py rewrites each task's test.sh to run pytest through
# `HARNESS_PY=$(command -v python3 || command -v python)`, and many TB2 images ship no interpreter at
# all. When it resolves to nothing the script dies on `-m: command not found` before a single
# assertion runs, and the trial scores 0 no matter what the agent did. In run 2026-08-16__14-35-38
# that silently zeroed 11 of 40 tasks for pi while harness scored 40/40 evaluable — harness happens
# to install Python for its own sake, so it accidentally satisfied the verifier's hidden dependency.
CPYTHON_TARBALL = EVAL_ROOT / "assets" / "cpython-3.12-x86_64.tar.gz"

# Local pi source build (scripts/build_pi_runtime_from_source.sh output). Preferred over the
# npm-release tarball so an edit-build-eval loop on the pi source picks up local changes without any
# env var juggling. Now a sibling path inside the same checkout instead of an absolute one, which is
# the whole point of moving the rig in here: the thing under test and the thing testing it move together.
SOURCE_TARBALL = PI_ROOT / ".harbor" / "pi-runtime-linux-x64.tar.gz"


def _resolve_tarball() -> Path:
    """Which runtime to install, most explicit wins.

    1. PI_RUNTIME_TARBALL env var — explicit choice, error if missing
    2. pi source build — present once the user builds from source
    3. npm-release build (assets/) — the original fallback
    """
    override = os.environ.get("PI_RUNTIME_TARBALL", "").strip()
    if override:
        p = Path(override)
        if not p.exists():
            raise FileNotFoundError(f"PI_RUNTIME_TARBALL set but missing: {p}")
        return p
    if SOURCE_TARBALL.exists():
        return SOURCE_TARBALL
    return RUNTIME_TARBALL


class PiAgent(BaseInstalledAgent):
    """Installs the prebuilt pi runtime in the container and runs `pi -p`."""

    @staticmethod
    def name() -> str:
        return "pi-agent"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._model_name = model_name or os.environ.get("HARNESS_MODEL", "qwen3.7-plus")

    def _models_json(self) -> dict:
        """dashscope provider entry for ~/.pi/agent/models.json.

        Generated per-run so the model id always matches what run() selects,
        and so the API key comes from the host environment at install time.
        """
        return {
            "providers": {
                "dashscope": {
                    "name": "DashScope",
                    "baseUrl": os.environ.get(
                        "OPENAI_BASE_URL",
                        "https://dashscope.aliyuncs.com/compatible-mode/v1"),
                    "api": "openai-completions",
                    "apiKey": os.environ.get("OPENAI_API_KEY", ""),
                    "compat": {
                        "supportsDeveloperRole": False,
                        # Keep reasoning_effort disabled for the benchmark adapter for now. The model
                        # accepts low/minimal, but pi's current DashScope/Qwen compat projection still
                        # routes through enable_thinking and can produce provider-side validation errors
                        # when max_completion_tokens equals the provider's default thinking budget.
                        # maxTokens=65536 below is the short-term mitigation for length stops.
                        "supportsReasoningEffort": False,
                    },
                    "models": [
                        {
                            "id": self._model_name,
                            "name": self._model_name,
                            "reasoning": True,
                            "contextWindow": 131072,
                            # Probed 2026-08-17/18 against DashScope: this model accepts
                            # max_completion_tokens=65536, both with and without reasoning_effort.
                            # The codebase now caps the context guard's reserved output headroom at
                            # 32768, so raising the provider output cap no longer makes shake/compaction
                            # fire at ~40% of the context window.
                            #
                            # Benchmark-environment config only; it says nothing about pi's defaults.
                            "maxTokens": 65536,
                            # DashScope accepts OpenAI-style reasoning_effort values. Probed directly:
                            # low is accepted, and minimal disables reported reasoning_tokens. Keep the
                            # explicit map so pi never falls back to a provider/model default budget.
                            "thinkingLevelMap": {
                                "low": "low",
                                "minimal": "minimal",
                                "off": "none",
                            },
                        }
                    ],
                }
            }
        }

    def _settings_json(self) -> dict:
        """~/.pi/agent/settings.json for a non-interactive benchmark run.

        pi's PermissionService classifies each bash command as allow/ask/deny. `ask` needs an approval
        round-trip and `pi -p` has no channel for one, so the core agent fails closed and refuses the
        call. That is a defensible default for an unattended session on a real machine, but here it
        silently rewrote the experiment: run 2026-08-16__11-51-28 produced 491 refusals across 33 of 40
        tasks (python3, pip, pytest, cd, mkdir, apt-get, ...), pushed the median turn count from 13 to
        31, and sent agents off reading pi's own policy.ts looking for a way out. That run measured the
        permission layer, not the agent.

        The trial already runs inside a disposable Harbor container, which is the real isolation
        boundary, so bypassPermissions is both safe here and the only setting that keeps results
        comparable to the pre-permission-layer baseline (jobs/2026-08-15__14-40-03).
        """
        return {
            "permissions": {
                "mode": "bypassPermissions",
                # Decisions are still written to ~/.pi/agent/audit/permissions.jsonl, so a finished run
                # can be audited for what a stricter mode would have stopped.
                "audit": True,
            }
        }

    async def install(self, environment: BaseEnvironment) -> None:
        tarball = _resolve_tarball()
        if not tarball.exists():
            raise FileNotFoundError(
                f"{tarball} missing — build one first: "
                "scripts/build_pi_runtime.sh (npm release) or "
                "scripts/build_pi_runtime_from_source.sh (local pi-main source)")

        # Stage tarball + models.json together; one upload_dir call delivers
        # both, and the key rides inside a file instead of a logged command.
        with tempfile.TemporaryDirectory() as tmpdir:
            staged = Path(tmpdir) / "pi-agent"
            staged.mkdir()
            shutil.copy2(tarball, staged / "pi-runtime-linux-x64.tar.gz")
            (staged / "models.json").write_text(json.dumps(self._models_json(), indent=2))
            (staged / "settings.json").write_text(json.dumps(self._settings_json(), indent=2))
            if CPYTHON_TARBALL.exists():
                shutil.copy2(CPYTHON_TARBALL, staged / "cpython.tar.gz")
            await self.exec_as_root(environment, command="mkdir -p /home/user/pi-agent")
            await environment.upload_dir(staged, "/home/user/pi-agent")

        # Unpack the runtime and place models.json for both HOMEs — Harbor may
        # exec the agent as root or as user depending on the image.
        await self.exec_as_root(
            environment,
            command=(
                "tar -xzf /home/user/pi-agent/pi-runtime-linux-x64.tar.gz -C /opt && "
                "for h in /root /home/user; do "
                "  mkdir -p $h/.pi/agent && "
                "  cp /home/user/pi-agent/models.json $h/.pi/agent/models.json && "
                # settings.json must land before pi starts: settings are read once at startup, so
                # an agent that hits the restriction mid-run cannot write this file to free itself.
                "  cp /home/user/pi-agent/settings.json $h/.pi/agent/settings.json; "
                "done && "
                "chown -R user:user /home/user/.pi /home/user/pi-agent 2>/dev/null || true; "
                "rm -f /home/user/pi-agent/pi-runtime-linux-x64.tar.gz; "
                # pi's shebang is `#!/usr/bin/env node`, so node must be on
                # PATH even when pi itself is called by absolute path.
                "PATH=/opt/pi-runtime/bin:$PATH pi --version"
            ),
        )

        # Provide python3 for the verifier when the image has none (see CPYTHON_TARBALL).
        # Never shadows an interpreter the image already ships: the task may depend on that exact one.
        await self.exec_as_root(
            environment,
            command=(
                "if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then "
                "  echo \"image python: $(command -v python3 || command -v python)\"; "
                "elif [ -f /home/user/pi-agent/cpython.tar.gz ]; then "
                "  mkdir -p /opt/python && "
                "  tar -xzf /home/user/pi-agent/cpython.tar.gz -C /opt/python --strip-components=1 && "
                "  ln -sf /opt/python/bin/python3 /usr/local/bin/python3 && "
                "  ln -sf /opt/python/bin/python3 /usr/local/bin/python && "
                "  ln -sf /opt/python/bin/pip3 /usr/local/bin/pip3 && "
                "  rm -f /home/user/pi-agent/cpython.tar.gz && "
                "  echo \"verifier python installed: $(/usr/local/bin/python3 --version)\"; "
                "else "
                "  echo 'WARNING: no python in image and no cpython tarball staged; "
                "the verifier will fail before running any assertion' >&2; "
                "fi"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped = shlex.quote(instruction)
        model = shlex.quote(f"dashscope/{self._model_name}")
        # Session lands in /logs/agent (Harbor host mount) for post-run
        # analysis; no --no-session precisely because we want that trace.
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p /logs/agent && "
                "cd /app && "
                "PATH=/opt/pi-runtime/bin:$PATH "
                "PI_SKIP_VERSION_CHECK=1 "
                f"pi -p --model {model} --session-dir /logs/agent {escaped}"
            ),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        pass
