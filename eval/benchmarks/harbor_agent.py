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
        # Step 1: Get harness code into container.
        # Prefer uploading the local workspace. This avoids relying on outbound
        # GitHub access from the benchmark container and also tests the exact
        # code currently checked out in this workspace.
        # NOTE: .cache_python/ (standalone CPython tarball) rides along in the
        # upload so Step 3 can install Python fully offline.
        repo_root = Path(__file__).resolve().parent.parent
        try:
            import shutil
            import tempfile

            ignore = shutil.ignore_patterns(
                ".git",
                ".env",
                ".venv",
                ".uv-cache",
                ".uv-python",
                ".docker-images",
                # Verifier-only payload: reaches the container via the task's
                # tests/_wheels directory, not through the agent upload.
                ".cache_pytest_wheels",
                "__pycache__",
                "jobs",
                "workspace",
                "local_tasks",
                "*.pyc",
                ".DS_Store",
            )
            with tempfile.TemporaryDirectory() as tmpdir:
                staged_repo = Path(tmpdir) / "harness-agent"
                shutil.copytree(repo_root, staged_repo, ignore=ignore)
                await self.exec_as_root(
                    environment,
                    command="mkdir -p /home/user/harness-agent",
                )
                await environment.upload_dir(staged_repo, "/home/user/harness-agent")
                await self.exec_as_root(
                    environment,
                    command="chown -R user:user /home/user/harness-agent 2>/dev/null || true",
                )
        except Exception:
            # Fallback for remote runners where direct upload is unavailable.
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
                    "    https://github.com/lazyFrogLOL/Harness_Engineering.git "
                    "    /home/user/harness-agent; "
                    "else "
                    "  echo 'No git, downloading tarball...' && "
                    "  mkdir -p /home/user/harness-agent && "
                    "  URL='https://github.com/lazyFrogLOL/Harness_Engineering/archive/refs/heads/master.tar.gz' && "
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
                "  echo 'Installing standalone Python 3.12...' && "
                "  ARCH=$(uname -m) && "
                "  case \"$ARCH\" in aarch64|arm64) PYARCH=aarch64 ;; *) PYARCH=x86_64 ;; esac && "
                # Offline-first: the repo upload ships .cache_python/ with a
                # pre-downloaded tarball, so minimal images (no curl/wget/python)
                # need no network at all. Mirrors are only a fallback.
                "  TARBALL=/home/user/harness-agent/.cache_python/cpython-3.12-${PYARCH}.tar.gz && "
                "  if [ ! -f \"$TARBALL\" ]; then "
                "    TARBALL=/tmp/python.tar.gz && "
                "    URL1=\"https://registry.npmmirror.com/-/binary/python-build-standalone/20250604/cpython-3.12.11%2B20250604-${PYARCH}-unknown-linux-gnu-install_only.tar.gz\" && "
                "    URL2=\"https://github.com/astral-sh/python-build-standalone/releases/download/20250604/cpython-3.12.11+20250604-${PYARCH}-unknown-linux-gnu-install_only.tar.gz\" && "
                "    ( curl -sL -o \"$TARBALL\" \"$URL1\" 2>/dev/null || "
                "      wget -q -O \"$TARBALL\" \"$URL1\" 2>/dev/null || "
                "      curl -sL -o \"$TARBALL\" \"$URL2\" 2>/dev/null || "
                "      wget -q -O \"$TARBALL\" \"$URL2\" 2>/dev/null ); "
                "  fi && "
                "  mkdir -p /opt/python && "
                "  tar -xzf \"$TARBALL\" -C /opt/python --strip-components=1 && "
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

        # Step 4: Install openai. Prefer vendored wheels for offline x86_64
        # runners, then fall back to Aliyun PyPI for ARM64/local Docker where
        # the vendored native wheels may not match the container architecture.
        await self.exec_as_root(
            environment,
            command=(
                "PYTHON=$(command -v python3); "
                # Verify openai actually imports cleanly — a stale install
                # against an old Python or wrong architecture will fail here.
                "$PYTHON -c 'import openai; print(\"openai OK\")' 2>/dev/null || "
                # Try pip with vendored wheels
                "( $PYTHON -m pip install --break-system-packages --no-index --force-reinstall "
                "  --find-links=/home/user/harness-agent/vendor_wheels "
                "  openai 2>/dev/null && "
                "  $PYTHON -c 'import openai' 2>/dev/null ) || "
                # Fall back to a reachable PyPI mirror for native ARM64 wheels
                "( $PYTHON -m pip install --break-system-packages --force-reinstall "
                "  -i https://mirrors.aliyun.com/pypi/simple "
                "  --trusted-host mirrors.aliyun.com openai 2>/dev/null && "
                "  $PYTHON -c 'import openai' 2>/dev/null ) || "
                "( pip3 install --break-system-packages --force-reinstall "
                "  -i https://mirrors.aliyun.com/pypi/simple "
                "  --trusted-host mirrors.aliyun.com openai 2>/dev/null && "
                "  $PYTHON -c 'import openai' 2>/dev/null ) || "
                # Last resort — unzip wheels directly into the active python's site-packages
                "( SITE=$($PYTHON -c 'import site; print(site.getsitepackages()[0])') && "
                "  mkdir -p \"$SITE\" && "
                "  for whl in /home/user/harness-agent/vendor_wheels/*.whl; do "
                "    $PYTHON -m zipfile -e \"$whl\" \"$SITE\" 2>/dev/null; "
                "  done && "
                "  $PYTHON -c 'import openai; print(\"openai installed via wheel unzip\")' ) || "
                "( echo 'FATAL: failed to install openai'; exit 1 )"
            ),
        )

    @staticmethod
    def _task_name(environment: BaseEnvironment) -> str | None:
        """Best-effort task short name from the Harbor environment.

        Harbor sets ``environment_name`` to the task short name and ``session_id``
        to ``<trial_name>__env`` where trial_name is ``<task>__<hash>``. Both are
        tried because a wrong attribute name here silently disables skill
        matching and task metadata lookup with no error anywhere.
        """
        name = getattr(environment, "environment_name", None) or getattr(
            environment, "_environment_name", None)
        if name:
            return str(name)
        session = getattr(environment, "session_id", None)
        if session:
            # "<task>__<hash>__env" -> "<task>"
            return str(session).split("__")[0] or None
        return None

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
        for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "HARNESS_MODEL",
                    "HARNESS_FAST_MODEL", "FOREGROUND_BLOCK_BUDGET",
                    "STREAM_LLM", "LLM_STALL_TIMEOUT", "LLM_MAX_BUDGET_FRACTION"):
            val = os.environ.get(key)
            if val:
                env_vars.append(f"{key}={shlex.quote(val)}")

        # The task name is what lets the harness find task-specific metadata
        # (timeout, difficulty) and its matching skill guide. TB2 instructions
        # describe the problem without ever naming the task, so name-based
        # skill matching is dead without this.
        task_name = self._task_name(environment)
        if task_name:
            env_vars.append(f"HARNESS_TASK_NAME={shlex.quote(task_name)}")

        # Harbor grants agent_timeout_sec * multiplier of wall clock. Pass the
        # multiplier through so the harness budgets against the real ceiling
        # instead of the raw per-task timeout.
        multiplier = os.environ.get("HARNESS_TIMEOUT_MULTIPLIER")
        if multiplier:
            env_vars.append(f"HARNESS_TIMEOUT_MULTIPLIER={shlex.quote(multiplier)}")

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
