# Terminal Agent Core Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the terminal agent so it can keep shell state across commands, maintain a mandatory task board, and switch recovery strategy based on repeated failures instead of relying on prompt-only nudges.

**Architecture:** Introduce a per-agent runtime state object in the agent loop, then hang three capabilities off that state: a persistent shell session, a structured progress board, and a recovery state machine. Keep the public tool surface small: reuse `run_bash`, add one explicit `update_progress` tool, and enforce both capabilities inside the agent execution path rather than through prompt wording.

**Tech Stack:** Python standard library (`pty`, `os`, `selectors`, `signal`, `subprocess`, `dataclasses`, `unittest`), existing middleware architecture, existing OpenAI tool-calling loop

---

## File Map

**Create**
- `shell_session.py` — persistent PTY-backed shell session with command execution, timeout interrupt, and cleanup
- `tests/test_shell_session.py` — unit tests for PTY shell behavior
- `tests/test_task_tracking.py` — tests for progress-tool enforcement and task board updates
- `tests/test_recovery_strategy.py` — tests for failure classification and strategy switching
- `tests/test_terminal_agent_flow.py` — integration-level tests for agent runtime state + middleware interaction

**Modify**
- `agents.py` — add runtime state, tool guards, tool execution context, shell/session lifecycle
- `tools.py` — route `run_bash` through runtime shell session, add `update_progress`, support runtime-aware tool execution
- `middlewares.py` — replace soft task tracking with enforcement middleware; add recovery strategy middleware
- `profiles/terminal.py` — update builder system prompt and middleware stack to reflect stateful shell, mandatory tracking, and mode-based recovery

**Do Not Modify**
- `harness.py` — no orchestrator changes are needed for this capability slice
- `context.py` — keep existing context compaction/reset behavior unchanged for this pass

## Design Constraints

- No compatibility layer that keeps both stateless and stateful `run_bash` paths alive. The terminal profile should move to the new execution model directly.
- No extra user-facing tools beyond what the agent actually needs. Only add `update_progress`.
- No generic workflow engine. Recovery is a small, explicit state machine with four modes only.
- No “soft reminder” implementation for tracking or recovery. Enforcement must happen in code.

## Runtime Model

Add one runtime object owned by `Agent.run()`:

```python
@dataclass
class TaskBoard:
    goal: str = ""
    steps: list[str] = field(default_factory=list)
    current_step: str = ""
    completed_steps: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    next_action: str = ""
    update_count: int = 0


@dataclass
class RecoveryState:
    mode: str = "NORMAL"   # NORMAL, ENV_FIX, SPEC_RECHECK, RETHINK, FINAL_VERIFY
    failure_signature: str = ""
    repeat_count: int = 0
    last_successful_action: str = ""
    last_verification_result: str = ""


@dataclass
class AgentRuntimeState:
    shell_session: PersistentShellSession | None = None
    task_board: TaskBoard = field(default_factory=TaskBoard)
    recovery: RecoveryState = field(default_factory=RecoveryState)
```

This object lives for one `Agent.run()` call and is passed to tools/middlewares through the agent execution layer.

### Task 1: Introduce Agent Runtime State

**Files:**
- Modify: `agents.py`
- Test: `tests/test_terminal_agent_flow.py`

- [ ] **Step 1: Write the failing runtime-state test**

```python
def test_agent_creates_runtime_state_once_per_run():
    agent = Agent(name="builder", system_prompt="x", use_tools=False)
    state = agent._create_runtime_state("goal text")
    assert state.task_board.goal == "goal text"
    assert state.recovery.mode == "NORMAL"
    assert state.shell_session is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_terminal_agent_flow -v`
Expected: FAIL because `_create_runtime_state` does not exist yet

- [ ] **Step 3: Add runtime-state dataclasses and creation path**

Implementation notes:
- Add a private helper in `agents.py` to initialize runtime state from the incoming task text
- Store runtime state in the `Agent.run()` stack frame, not on a process-global singleton
- Make `TraceWriter` logging aware of recovery mode changes only if needed; do not redesign tracing now

- [ ] **Step 4: Thread runtime state into tool execution**

Implementation notes:
- Change `tools.execute_tool(...)` to accept `runtime_state` and `agent_name`
- Update every tool invocation site in `agents.py`
- Keep non-runtime-aware tools pure; they can ignore the extra parameters

- [ ] **Step 5: Run tests to verify runtime state passes**

Run: `python -m unittest tests.test_terminal_agent_flow -v`
Expected: PASS

### Task 2: Build the Persistent Shell Session

**Files:**
- Create: `shell_session.py`
- Test: `tests/test_shell_session.py`

- [ ] **Step 1: Write the failing shell-state tests**

```python
def test_shell_preserves_working_directory():
    shell = PersistentShellSession(cwd=temp_dir)
    shell.run("mkdir -p subdir && cd subdir")
    result = shell.run("pwd")
    assert result.stdout.strip().endswith("/subdir")


def test_shell_preserves_environment_variables():
    shell = PersistentShellSession(cwd=temp_dir)
    shell.run("export FOO=bar")
    result = shell.run("printf '%s' \"$FOO\"")
    assert result.stdout == "bar"


def test_shell_timeout_interrupts_command_but_keeps_session_alive():
    shell = PersistentShellSession(cwd=temp_dir)
    timed_out = shell.run("sleep 5", timeout=1)
    follow_up = shell.run("echo alive")
    assert timed_out.timed_out is True
    assert "alive" in follow_up.stdout
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_shell_session -v`
Expected: FAIL because `shell_session.py` does not exist

- [ ] **Step 3: Implement `PersistentShellSession`**

Core API:

```python
@dataclass
class ShellResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False


class PersistentShellSession:
    def __init__(self, cwd: str): ...
    def run(self, command: str, timeout: int = 300) -> ShellResult: ...
    def interrupt(self) -> None: ...
    def close(self) -> None: ...
```

Implementation rules:
- Start one `/bin/bash --noprofile --norc` PTY per agent
- `cd` into workspace exactly once during session init
- Wrap every command with a unique sentinel that prints a machine-parsable exit code marker
- Use `selectors` to read until sentinel, not a fixed sleep
- On timeout, send `SIGINT` to the PTY foreground process group and return `timed_out=True`
- Never silently respawn a dead shell in this pass; if the shell dies, surface an explicit error

- [ ] **Step 4: Run tests to verify the shell session passes**

Run: `python -m unittest tests.test_shell_session -v`
Expected: PASS

### Task 3: Replace Stateless `run_bash`

**Files:**
- Modify: `tools.py`
- Modify: `agents.py`
- Test: `tests/test_terminal_agent_flow.py`

- [ ] **Step 1: Write the failing `run_bash` integration test**

```python
def test_run_bash_uses_agent_shell_session():
    state = AgentRuntimeState(shell_session=FakeShellSession())
    result = execute_tool("run_bash", {"command": "pwd"}, runtime_state=state, agent_name="builder")
    assert "pwd" in state.shell_session.commands
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_terminal_agent_flow -v`
Expected: FAIL because `execute_tool` is not runtime-aware yet

- [ ] **Step 3: Rewrite `run_bash` to require runtime state**

Implementation notes:
- Remove direct `subprocess.run(...)` use from the terminal execution path
- `run_bash` should call `runtime_state.shell_session.run(command, timeout)`
- Reuse existing `_smart_truncate_output()` on the returned stdout/stderr
- Preserve the current text contract:
  - successful output returns stdout/stderr text
  - timeout returns `[error] Command timed out after ...`
  - shell failure returns `[error] ...`

- [ ] **Step 4: Ensure shell lifecycle is closed exactly once**

Implementation notes:
- In `Agent.run()`, create shell session lazily on first `run_bash`
- In `finally`, always close `runtime_state.shell_session` if present

- [ ] **Step 5: Run tests to verify `run_bash` migration passes**

Run: `python -m unittest tests.test_shell_session tests.test_terminal_agent_flow -v`
Expected: PASS

### Task 4: Add Structured Progress Tracking Tool

**Files:**
- Modify: `tools.py`
- Test: `tests/test_task_tracking.py`

- [ ] **Step 1: Write the failing `update_progress` tests**

```python
def test_update_progress_updates_runtime_state_and_file():
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
    assert state.task_board.current_step == "inspect"
    assert Path(config.WORKSPACE, "progress.md").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_task_tracking -v`
Expected: FAIL because `update_progress` does not exist

- [ ] **Step 3: Implement `update_progress`**

Tool schema:

```python
{
    "name": "update_progress",
    "required": ["goal", "steps", "current_step", "completed_steps", "blockers", "next_action"],
}
```

Behavior rules:
- Update `runtime_state.task_board`
- Increment `update_count`
- Write a deterministic Markdown snapshot to `progress.md`
- Reject empty `goal`, empty `steps`, or `current_step` not present in `steps`

- [ ] **Step 4: Run tests to verify `update_progress` passes**

Run: `python -m unittest tests.test_task_tracking -v`
Expected: PASS

### Task 5: Enforce Progress Before Work

**Files:**
- Modify: `agents.py`
- Modify: `middlewares.py`
- Test: `tests/test_task_tracking.py`

- [ ] **Step 1: Write the failing enforcement tests**

```python
def test_builder_cannot_run_bash_before_progress_update():
    agent = build_test_agent_with_enforcement()
    outcome = agent._guard_tool_call("run_bash", runtime_state=AgentRuntimeState())
    assert outcome.blocked is True
    assert "update_progress" in outcome.message


def test_builder_cannot_exit_without_final_progress_update():
    middleware = TaskTrackingEnforcementMiddleware()
    state = AgentRuntimeState()
    state.task_board.update_count = 1
    middleware.mark_work_started()
    assert middleware.pre_exit(messages=[], runtime_state=state) is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_task_tracking -v`
Expected: FAIL because enforcement middleware/guard does not exist

- [ ] **Step 3: Replace soft tracking with enforcement**

Implementation rules:
- Delete `TaskTrackingMiddleware` usage from the terminal builder pipeline
- Add `TaskTrackingEnforcementMiddleware`
- Block these tool calls when `task_board.update_count == 0`:
  - `run_bash`
  - `write_file`
  - `delegate_task`
- After recovery mode changes, require one more `update_progress` before further work
- On first pre-exit attempt after work has started, require a final `update_progress` if no update happened since the last action burst

- [ ] **Step 4: Update terminal profile middleware stack**

Implementation notes:
- Replace `TaskTrackingMiddleware(...)` in `profiles/terminal.py`
- Update builder prompt text so the model knows `update_progress` is mandatory and first-class

- [ ] **Step 5: Run tests to verify enforcement passes**

Run: `python -m unittest tests.test_task_tracking tests.test_terminal_agent_flow -v`
Expected: PASS

### Task 6: Implement Recovery Strategy State Machine

**Files:**
- Modify: `middlewares.py`
- Modify: `agents.py`
- Test: `tests/test_recovery_strategy.py`

- [ ] **Step 1: Write the failing recovery tests**

```python
def test_repeated_environment_failures_switch_to_env_fix():
    state = AgentRuntimeState()
    middleware = RecoveryStrategyMiddleware()
    middleware.observe_tool_result("run_bash", {"command": "foo"}, "[error] command not found", state)
    middleware.observe_tool_result("run_bash", {"command": "foo"}, "[error] command not found", state)
    assert state.recovery.mode == "ENV_FIX"


def test_repeated_same_failure_switches_to_spec_recheck():
    state = AgentRuntimeState()
    middleware = RecoveryStrategyMiddleware()
    middleware.observe_verification_failure("pytest::task_x failed", state)
    middleware.observe_verification_failure("pytest::task_x failed", state)
    assert state.recovery.mode == "SPEC_RECHECK"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_recovery_strategy -v`
Expected: FAIL because recovery middleware does not exist

- [ ] **Step 3: Implement `RecoveryStrategyMiddleware`**

Recovery modes:
- `NORMAL`
- `ENV_FIX`
- `SPEC_RECHECK`
- `RETHINK`
- `FINAL_VERIFY`

Transition rules:
- 2 consecutive environment-class failures → `ENV_FIX`
- same failure signature repeated twice → `SPEC_RECHECK`
- repeated file edits + unchanged failure signature → `RETHINK`
- time critical warning or explicit verification phase → `FINAL_VERIFY`

Failure signatures should be normalized from:
- tool result text
- verification/test failure text
- loop-detection events

- [ ] **Step 4: Add tool guards for each recovery mode**

Allowed actions by mode:
- `ENV_FIX`: install/check path/process/permissions only
- `SPEC_RECHECK`: read-only actions + `update_progress`
- `RETHINK`: `update_progress` required before edits
- `FINAL_VERIFY`: verify/fix only; block feature-expansion actions

Implementation notes:
- Enforce in `agents.py` before tool execution
- Return a blocking tool-result message instead of executing illegal actions

- [ ] **Step 5: Run tests to verify recovery state switching passes**

Run: `python -m unittest tests.test_recovery_strategy -v`
Expected: PASS

### Task 7: Wire Recovery into Terminal Builder Behavior

**Files:**
- Modify: `profiles/terminal.py`
- Test: `tests/test_terminal_agent_flow.py`

- [ ] **Step 1: Write the failing terminal-profile test**

```python
def test_terminal_builder_prompt_mentions_stateful_shell_progress_and_recovery():
    prompt = TerminalProfile().builder().system_prompt
    assert "stateful shell" in prompt.lower()
    assert "update_progress" in prompt
    assert "recovery mode" in prompt.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_terminal_agent_flow -v`
Expected: FAIL because the current prompt does not describe these capabilities

- [ ] **Step 3: Rewrite the builder prompt**

Prompt requirements:
- Say `run_bash` executes in one persistent shell session
- Require `update_progress` before substantive work
- Explain that repeated failures switch the agent into a constrained recovery mode
- Explain that in recovery mode, the agent must obey the mode-specific objective instead of continuing normal edits

- [ ] **Step 4: Run tests to verify prompt wiring passes**

Run: `python -m unittest tests.test_terminal_agent_flow -v`
Expected: PASS

### Task 8: End-to-End Regression Pass

**Files:**
- Test: `tests/test_shell_session.py`
- Test: `tests/test_task_tracking.py`
- Test: `tests/test_recovery_strategy.py`
- Test: `tests/test_terminal_agent_flow.py`

- [ ] **Step 1: Run the full targeted suite**

Run: `python -m unittest tests.test_shell_session tests.test_task_tracking tests.test_recovery_strategy tests.test_terminal_agent_flow -v`
Expected: PASS

- [ ] **Step 2: Run one smoke syntax/import check on the modified modules**

Run:
```bash
python -c "import agents, tools, middlewares, profiles.terminal, shell_session; print('imports ok')"
```

Expected: `imports ok`

- [ ] **Step 3: Manually verify the intended capability edges**

Run:
```bash
python -m unittest tests.test_shell_session -v
```

Check:
- persistent directory state works
- persistent environment state works
- timeout interrupts only the command, not the shell session

- [ ] **Step 4: Commit after green verification**

```bash
git add agents.py tools.py middlewares.py profiles/terminal.py shell_session.py tests/test_shell_session.py tests/test_task_tracking.py tests/test_recovery_strategy.py tests/test_terminal_agent_flow.py docs/superpowers/plans/2026-04-08-terminal-agent-core-capabilities.md
git commit -m "feat: strengthen terminal agent runtime capabilities"
```

## Acceptance Criteria

- `run_bash` executes inside one persistent shell session per agent run
- `cd`, `export`, and long-lived background process state persist across commands
- `update_progress` exists and is mandatory before substantive builder work
- builder cannot silently skip tracking or finish without final tracking update
- repeated failures deterministically switch the builder into a constrained recovery mode
- recovery mode changes are enforced in code, not merely described in prompts
- targeted test suite passes without depending on Harbor or external services

## Notes

- Do not add asynchronous parallel shell execution in this pass.
- Do not redesign the planner/evaluator architecture in this pass.
- Do not add task-category routing or benchmark metadata plumbing in this pass.
- This plan intentionally upgrades only the agent’s core execution model.
