"""
Harbor adapter — runs our harness agent on Terminal-Bench 2.0 via Harbor framework.

Harbor has two agent types:
  - External (BaseAgent): agent runs outside container, sends commands via environment.exec()
  - Installed (BaseInstalledAgent): agent is installed inside the container

We use Installed agent — our harness.py runs natively inside the container,
so run_bash just works as subprocess without any bridging.

Usage:
  # Install harbor
  pip install harbor

  # Test on hello-world task
  harbor run -d "terminal-bench@2.0" \
    --agent-import-path benchmarks.harbor_agent:HarnessAgent \
    --task-names hello-world

  # Full benchmark
  harbor run -d "terminal-bench@2.0" \
    --agent-import-path benchmarks.harbor_agent:HarnessAgent

  # With Daytona (no Docker needed locally)
  harbor run -d "terminal-bench@2.0" \
    --agent-import-path benchmarks.harbor_agent:HarnessAgent \
    --env daytona
"""
from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class HarnessAgent(BaseInstalledAgent):
    """
    Installs our harness inside the Harbor container and runs it
    with --profile terminal for each task.
    """

    @staticmethod
    def name() -> str:
        return "harness-agent"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._model_name = model_name

    async def install(self, environment: BaseEnvironment) -> None:
        """Install dependencies and clone our repo into the container.

        Strategy: never use apt-get for python (too slow/unreliable on Daytona).
        1. Ensure git exists (apt-get only for git, which is tiny and fast)
        2. Clone repo (includes vendor_wheels/)
        3. If no python3 → download standalone python from GitHub (~30MB)
        4. Install openai from vendored wheels (fully offline)
        """
        # Step 1: Get harness code into container
        # Try git clone first, fall back to curl/wget tarball if no git
        await self.exec_as_root(
            environment,
            command=(
                # Ensure we have a download tool (curl or wget)
                # Most images have at least one; if not, install curl
                "( command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || "
                "  ( for i in $(seq 1 15); do "
                "      fuser /var/lib/dpkg/lock >/dev/null 2>&1 || break; sleep 2; "
                "    done && "
                "    apt-get update -qq 2>/dev/null && "
                "    apt-get install -y -qq curl 2>/dev/null ) "
                ") || true"
            ),
        )

        await self.exec_as_agent(
            environment,
            command=(
                "if [ -d /home/user/harness-agent ]; then "
                "  echo 'harness-agent already exists'; "
                "elif command -v git >/dev/null 2>&1; then "
                "  git clone --depth 1 "
                "    https://github.com/lyxhnu/multi-agent.git "
                "    /home/user/harness-agent; "
                "else "
                "  echo 'No git, downloading tarball...' && "
                "  mkdir -p /home/user/harness-agent && "
                "  URL='https://github.com/lyxhnu/multi-agent/archive/refs/heads/main.tar.gz' && "
                "  ( curl -sL \"$URL\" 2>/dev/null || wget -qO- \"$URL\" 2>/dev/null ) "
                "    | tar -xz --strip-components=1 -C /home/user/harness-agent; "
                "fi"
            ),
        )

        # Step 3: Ensure python3 >= 3.11 (openai + pydantic v2 need it)
        # Old containers ship Python 3.9/3.10 where import openai crashes
        # on pydantic v2 or anyio incompatibilities. Check the actual version
        # and install standalone 3.12 if it's too old or missing entirely.
        await self.exec_as_root(
            environment,
            command=(
                "NEED_INSTALL=0; "
                "if command -v python3 >/dev/null 2>&1; then "
                "  PY_VER=$(python3 -c 'import sys; print(sys.version_info[:2])' 2>/dev/null) && "
                "  PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info[0])' 2>/dev/null) && "
                "  PY_MINOR=$(python3 -c 'import sys; print(sys.version_info[1])' 2>/dev/null) && "
                "  echo \"python3 found: $(python3 --version) (parsed: $PY_MAJOR.$PY_MINOR)\" && "
                "  if [ \"$PY_MAJOR\" -lt 3 ] 2>/dev/null || [ \"$PY_MINOR\" -lt 11 ] 2>/dev/null; then "
                "    echo \"Python $PY_MAJOR.$PY_MINOR is too old (need >= 3.11), upgrading...\"; "
                "    NEED_INSTALL=1; "
                "  fi; "
                "else "
                "  echo 'No python3 found'; "
                "  NEED_INSTALL=1; "
                "fi; "
                "if [ \"$NEED_INSTALL\" = \"1\" ]; then "
                "  echo 'Installing standalone Python 3.12 from GitHub...' && "
                "  URL='https://github.com/astral-sh/python-build-standalone/releases/"
                "download/20250604/cpython-3.12.11+20250604-x86_64-unknown-linux-gnu-install_only.tar.gz' && "
                "  ( curl -sL -o /tmp/python.tar.gz \"$URL\" 2>/dev/null || "
                "    wget -q -O /tmp/python.tar.gz \"$URL\" 2>/dev/null || "
                "    ( apt-get update -qq 2>/dev/null && apt-get install -y -qq curl 2>/dev/null && "
                "      curl -sL -o /tmp/python.tar.gz \"$URL\" ) "
                "  ) && "
                "  mkdir -p /opt/python && "
                "  tar -xzf /tmp/python.tar.gz -C /opt/python --strip-components=1 && "
                # Symlink to /usr/local/bin so it shadows the old system python3
                "  ln -sf /opt/python/bin/python3 /usr/local/bin/python3 && "
                "  ln -sf /opt/python/bin/pip3 /usr/local/bin/pip3 && "
                # Also update the bare 'python' command if it exists
                "  ln -sf /opt/python/bin/python3 /usr/local/bin/python && "
                "  rm -f /tmp/python.tar.gz && "
                # Force hash table refresh so bash picks up the new binary
                "  hash -r 2>/dev/null; "
                "  echo \"standalone python installed: $(/usr/local/bin/python3 --version)\"; "
                "else "
                "  echo 'Python version OK, no upgrade needed'; "
                "fi"
            ),
        )

        # Step 4: Install openai from vendored wheels (fully offline)
        # Use /usr/local/bin/python3 explicitly to ensure we target the
        # correct interpreter (the standalone 3.12 if we just installed it,
        # not a stale system python that might still be on PATH).
        await self.exec_as_root(
            environment,
            command=(
                "PYTHON=$(command -v python3); "
                # Verify openai actually imports cleanly — a stale install
                # against an old Python will fail at import time even though
                # the package directory exists.
                "$PYTHON -c 'import openai; print(\"openai OK\")' 2>/dev/null || "
                # Try pip with vendored wheels
                "( $PYTHON -m pip install --break-system-packages --no-index --force-reinstall "
                "  --find-links=/home/user/harness-agent/vendor_wheels "
                "  openai 2>/dev/null && "
                "  $PYTHON -c 'import openai' 2>/dev/null ) || "
                "( pip3 install --break-system-packages --no-index --force-reinstall "
                "  --find-links=/home/user/harness-agent/vendor_wheels "
                "  openai 2>/dev/null && "
                "  $PYTHON -c 'import openai' 2>/dev/null ) || "
                # No pip at all — unzip wheels directly into the new python's site-packages
                "( SITE=$($PYTHON -c 'import site; print(site.getsitepackages()[0])') && "
                "  mkdir -p \"$SITE\" && "
                "  for whl in /home/user/harness-agent/vendor_wheels/*.whl; do "
                "    $PYTHON -m zipfile -e \"$whl\" \"$SITE\" 2>/dev/null; "
                "  done && "
                "  $PYTHON -c 'import openai; print(\"openai installed via wheel unzip\")' ) || "
                "echo 'FATAL: failed to install openai'"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run our harness with --profile terminal on the given task."""
        escaped = shlex.quote(instruction)

        # Build env vars string for the command
        env_vars = []
        for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "HARNESS_MODEL"):
            val = os.environ.get(key)
            if val:
                env_vars.append(f"{key}={shlex.quote(val)}")

        env_vars.append("HARNESS_WORKSPACE=/app")
        env_vars.append("HARNESS_FLAT_WORKSPACE=1")
        env_prefix = " ".join(env_vars)

        # Run harness with system python3
        await self.exec_as_agent(
            environment,
            command=(
                f"cd /home/user/harness-agent && "
                f"{env_prefix} "
                f"python3 harness.py --profile terminal {escaped}"
            ),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Called after run() completes. Could parse logs if needed."""
        pass
