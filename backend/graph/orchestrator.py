from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, AsyncIterator

from langchain.agents import create_agent

from config import get_settings, runtime_config
from graph.agent import agent_manager
from graph.agent_registry import AgentRegistry
from graph.memory_indexer import memory_indexer
from graph.progress_tracker import ProgressTracker
from graph.prompt_builder import build_system_prompt
from graph.run_manager import RunManager
from graph.task_allocator import TaskAllocator
from tools.fetch_url_tool import FetchURLTool
from tools.memory_tools import MemoryGetTool, MemorySearchTool
from tools.python_repl_tool import PythonReplTool
from tools.read_file_tool import ReadFileTool
from tools.search_knowledge_tool import SearchKnowledgeBaseTool
from tools.session_tools import SessionsHistoryTool, SessionsSendTool, SessionsSpawnTool
from tools.terminal_tool import TerminalTool
from tools.write_file_tool import WriteFileTool


def _stringify_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return str(content or "")


class MultiAgentOrchestrator:
    def __init__(self) -> None:
        self.backend_dir: Path | None = None
        self.project_root: Path | None = None
        self.run_manager: RunManager | None = None
        self.registry: AgentRegistry | None = None
        self.allocator = TaskAllocator()
        self.progress = ProgressTracker()
        self._active_runs: dict[str, asyncio.Task[None]] = {}
        self._run_locks: dict[str, asyncio.Lock] = {}
        self._cancel_requested: set[str] = set()
        self._parallel_task_limit = 3
        self._task_timeout_seconds = 600

    def initialize(self, backend_dir: Path, project_root: Path) -> None:
        settings = get_settings()
        self.backend_dir = backend_dir.resolve()
        self.project_root = project_root.resolve()
        self.run_manager = RunManager(self.backend_dir, self.project_root)
        self.run_manager.initialize()
        self.registry = AgentRegistry(self.run_manager)
        self._task_timeout_seconds = settings.multi_agent_task_timeout_seconds

    def _track_run_task(self, run_id: str, task: asyncio.Task[None]) -> None:
        self._active_runs[run_id] = task

        def _cleanup(_task: asyncio.Task[None]) -> None:
            self._active_runs.pop(run_id, None)
            self._run_locks.pop(run_id, None)

        task.add_done_callback(_cleanup)

    def _run_lock(self, run_id: str) -> asyncio.Lock:
        lock = self._run_locks.get(run_id)
        if lock is None:
            lock = asyncio.Lock()
            self._run_locks[run_id] = lock
        return lock

    def _require_runtime(self) -> tuple[Path, Path, RunManager, AgentRegistry]:
        if (
            self.backend_dir is None
            or self.project_root is None
            or self.run_manager is None
            or self.registry is None
        ):
            raise RuntimeError("MultiAgentOrchestrator is not initialized")
        return self.backend_dir, self.project_root, self.run_manager, self.registry

    def list_runs(self) -> list[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        return run_manager.list_runs()

    def get_run(self, run_id: str) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        return run_manager.load_run(run_id)

    def get_tasks(self, run_id: str) -> list[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        return run_manager.load_task_board(run_id).get("tasks", [])

    def get_events(self, run_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        return run_manager.read_events(run_id, after_seq=after_seq)

    def get_run_files(self, run_id: str) -> list[str]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        return run_manager.list_run_files(run_id)

    def get_agent_status(self, run_id: str, agent_id: str) -> dict[str, Any]:
        _backend_dir, _project_root, _run_manager, registry = self._require_runtime()
        return registry.get_agent(run_id, agent_id)

    def get_agent_history(self, run_id: str, agent_id: str, limit: int = 100) -> list[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        return run_manager.read_history(run_id, agent_id, limit=limit)

    def cancel_run(self, run_id: str) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        self._cancel_requested.add(run_id)
        run = run_manager.update_run(run_id, status="cancel_requested")
        run_manager.append_event(run_id, "run_cancel_requested", {"status": "cancel_requested"})
        return run

    def resume_run(self, run_id: str) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        self._cancel_requested.discard(run_id)
        return run_manager.update_run(run_id, status="queued")

    async def clear_all_runs(self) -> dict[str, int | bool]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        active_tasks = list(self._active_runs.items())
        self._cancel_requested.update(run_id for run_id, _task in active_tasks)
        for _run_id, task in active_tasks:
            task.cancel()
        if active_tasks:
            await asyncio.gather(*(task for _run_id, task in active_tasks), return_exceptions=True)
        self._active_runs.clear()
        self._run_locks.clear()
        self._cancel_requested.clear()
        removed_runs = run_manager.clear_runs()
        return {"ok": True, "removed_runs": removed_runs}

    async def astream_new_run(
        self,
        *,
        user_request: str,
        session_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        run = run_manager.create_run(
            user_request=user_request,
            session_id=session_id,
            config=self._runtime_settings_payload(),
        )
        run_id = run["run_id"]
        board = self.allocator.create_initial_board(run_id, user_request)
        run_manager.save_task_board(run_id, board)
        agents = registry.base_agents(run_id)
        run_manager.append_event(
            run_id,
            "task_board_initialized",
            {"task_count": len(board["tasks"]), "agent_count": len(agents)},
        )
        await self._write_default_plan_files(run_id, user_request, board, agents)
        self._bootstrap_startup_task(run_id)

        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        for event in run_manager.read_events(run_id, after_seq=0):
            yield event

        task = asyncio.create_task(self._execute_run(run_id, user_request, queue))
        self._track_run_task(run_id, task)
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            await asyncio.gather(task, return_exceptions=True)

    async def start_background_run(
        self,
        *,
        user_request: str,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        run = run_manager.create_run(
            user_request=user_request,
            session_id=session_id,
            config=self._runtime_settings_payload(),
        )
        run_id = run["run_id"]
        board = self.allocator.create_initial_board(run_id, user_request)
        run_manager.save_task_board(run_id, board)
        agents = registry.base_agents(run_id)
        run_manager.append_event(
            run_id,
            "task_board_initialized",
            {"task_count": len(board["tasks"]), "agent_count": len(agents)},
        )
        await self._write_default_plan_files(run_id, user_request, board, agents)
        self._bootstrap_startup_task(run_id)
        task = asyncio.create_task(self._execute_run(run_id, user_request, None))
        self._track_run_task(run_id, task)
        return run

    async def continue_run(self, run_id: str) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        run = run_manager.load_run(run_id)
        if run_id in self._active_runs:
            return
        task = asyncio.create_task(self._execute_run(run_id, str(run.get("request", "")), None))
        self._track_run_task(run_id, task)

    async def recover_incomplete_runs(self) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        recoverable = {"queued", "in_progress", "cancel_requested"}
        for run in run_manager.list_runs():
            run_id = str(run.get("run_id", ""))
            status = str(run.get("status", ""))
            if run_id and status in recoverable and run_id not in self._active_runs:
                await self.continue_run(run_id)

    async def _write_default_plan_files(
        self,
        run_id: str,
        request: str,
        board: dict[str, Any],
        agents: list[dict[str, Any]],
    ) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        run = run_manager.load_run(run_id)
        lines = [
            "# Project Plan",
            "",
            f"- Request: {request}",
            f"- Run ID: `{run_id}`",
            f"- Generated Project Directory: `{run.get('project_dir', '')}`",
            "",
            "## Agents",
        ]
        for agent in agents:
            lines.append(
                f"- `{agent['role']}` -> `{agent['agent_id']}` ({agent['session_key']})"
            )
        lines.extend(["", "## Tasks"])
        for task in board.get("tasks", []):
            lines.append(
                f"- `{task['task_id']}` [{task['phase']}] `{task['owner_role']}` {task['title']}"
            )
        run_manager.write_project_text(
            run_id,
            "agent:pc:bootstrap:0",
            f"backend/workspace/runs/{run_id}/project-plan.md",
            "\n".join(lines) + "\n",
        )

    def _bootstrap_startup_task(self, run_id: str) -> None:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        board = run_manager.load_task_board(run_id)
        startup_task = next(
            (task for task in board.get("tasks", []) if task.get("phase") == "startup"),
            None,
        )
        if startup_task is None or startup_task.get("status") == "completed":
            return

        pc_agent = next(item for item in registry.list_agents(run_id) if item["role"] == "PC")
        self.progress.update_task(
            board,
            startup_task["task_id"],
            status="completed",
            progress=100,
            assigned_agent_id=pc_agent["agent_id"],
            latest_summary="Bootstrap plan, task board, and base agents were initialized by the orchestrator.",
            next_steps=["Proceed to architecture design."],
            verify_command="",
        )
        run_manager.save_task_board(run_id, board)
        registry.set_status(
            run_id,
            pc_agent["agent_id"],
            status="completed",
            current_task_id=startup_task["task_id"],
            current_phase="startup",
            progress=100,
        )
        run_manager.append_event(
            run_id,
            "task_update",
            {
                "agent_id": pc_agent["agent_id"],
                "role": "PC",
                "task_id": startup_task["task_id"],
                "status": "completed",
                "progress": 100,
                "title": startup_task["title"],
                "summary": "Startup bootstrap completed automatically.",
            },
        )

    async def _execute_run(
        self,
        run_id: str,
        user_request: str,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        try:
            await self._emit(queue, run_id, "run_started", {"status": "in_progress", "phase": "startup"})
            run_manager.update_run(run_id, status="in_progress", phase="startup")
            await self._recover_orphaned_tasks(run_id, queue)

            while True:
                if run_id in self._cancel_requested:
                    run_manager.update_run(run_id, status="cancelled", current_task_ids=[])
                    await self._emit(queue, run_id, "run_cancelled", {"status": "cancelled"})
                    break

                board = run_manager.load_task_board(run_id)
                active_task_ids = self.progress.active_task_ids(board)
                ready_tasks = self.allocator.next_ready_tasks(board, active_task_ids=active_task_ids)
                if ready_tasks:
                    batch = self._select_parallel_tasks(ready_tasks)
                    batch_phase = str(batch[0].get("phase", "in_progress"))
                    run_manager.update_run(run_id, status="in_progress", phase=batch_phase)
                    await self._emit(
                        queue,
                        run_id,
                        "parallel_batch_started",
                        {
                            "phase": batch_phase,
                            "task_ids": [task["task_id"] for task in batch],
                            "roles": [task["owner_role"] for task in batch],
                        },
                    )
                    results = await asyncio.gather(
                        *(
                            self._execute_task(run_id, task["task_id"], user_request, queue)
                            for task in batch
                        ),
                        return_exceptions=True,
                    )
                    unexpected = [item for item in results if isinstance(item, Exception)]
                    if unexpected:
                        raise unexpected[0]
                    await self._emit(
                        queue,
                        run_id,
                        "parallel_batch_completed",
                        {
                            "phase": batch_phase,
                            "task_ids": [task["task_id"] for task in batch],
                        },
                    )
                    continue

                if active_task_ids:
                    await asyncio.sleep(0.1)
                    continue

                summary = self.progress.summarize(board)
                if summary.get("completed") == summary.get("total"):
                    run_manager.update_run(run_id, status="completed", phase="done", current_task_ids=[])
                    await self._emit(queue, run_id, "task_complete", {"status": "completed"})
                    await self._emit(queue, run_id, "run_complete", {"status": "completed"})
                elif summary.get("failed") or summary.get("blocked"):
                    run_manager.update_run(run_id, status="blocked", current_task_ids=[])
                    await self._emit(
                        queue,
                        run_id,
                        "run_blocked",
                        {
                            "status": "blocked",
                            "status_counts": summary.get("status_counts", {}),
                        },
                    )
                else:
                    run_manager.update_run(run_id, status="blocked", current_task_ids=[])
                    await self._emit(
                        queue,
                        run_id,
                        "run_blocked",
                        {
                            "status": "blocked",
                            "reason": "No ready tasks remained and no active work was running.",
                            "status_counts": summary.get("status_counts", {}),
                        },
                    )
                break
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"fatal: {exc}")
            run_manager.update_run(run_id, status="failed", current_task_ids=[])
            await self._emit(queue, run_id, "error", {"error": str(exc), "status": "failed"})
        finally:
            if queue is not None:
                await queue.put(None)

    async def _execute_task(
        self,
        run_id: str,
        task_id: str,
        user_request: str,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> None:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        async with self._run_lock(run_id):
            board = run_manager.load_task_board(run_id)
            task = next(item for item in board["tasks"] if item["task_id"] == task_id)
            if task.get("status") not in {"pending", "queued"}:
                return

            role = task["owner_role"]
            agent = next(item for item in registry.list_agents(run_id) if item["role"] == role)
            phase = task["phase"]

            self.progress.update_task(
                board,
                task_id,
                status="in_progress",
                progress=5,
                assigned_agent_id=agent["agent_id"],
                increment_attempts=True,
            )
            run_manager.save_task_board(run_id, board)
            self._update_run_current_tasks(run_id, add_task_id=task_id, phase=phase, status="in_progress")
            registry.set_status(
                run_id,
                agent["agent_id"],
                status="in_progress",
                current_task_id=task_id,
                current_phase=phase,
                progress=10,
            )

        await self._emit(
            queue,
            run_id,
            "agent_dispatch",
            {
                "agent_id": agent["agent_id"],
                "role": role,
                "task_id": task_id,
                "phase": phase,
                "title": task["title"],
            },
        )

        pc_agent = next(item for item in registry.list_agents(run_id) if item["role"] == "PC")
        assignment = self._build_assignment_message(run_id, pc_agent["agent_id"], agent, task)
        registry.sessions_send(
            run_id,
            from_agent_id=pc_agent["agent_id"],
            session_key=agent["session_key"],
            message=assignment,
        )

        timeout_seconds = self._task_timeout_for(task)
        try:
            result = await asyncio.wait_for(
                self._run_agent_task(run_id, agent, task, user_request, queue),
                timeout=timeout_seconds,
            )
            async with self._run_lock(run_id):
                board = run_manager.load_task_board(run_id)
                self.progress.update_task(
                    board,
                    task_id,
                    status="completed",
                    progress=100,
                    latest_summary=result["summary"],
                    next_steps=result["next_steps"],
                    verify_command=result["verify_command"],
                )
                run_manager.save_task_board(run_id, board)
                self._update_run_current_tasks(run_id, remove_task_id=task_id)
                registry.set_status(
                    run_id,
                    agent["agent_id"],
                    status="completed",
                    current_task_id=task_id,
                    current_phase=phase,
                    progress=100,
                )
                self._refresh_blocked_tasks(run_id)
            await self._emit(
                queue,
                run_id,
                "task_update",
                {
                    "agent_id": agent["agent_id"],
                    "role": role,
                    "task_id": task_id,
                    "status": "completed",
                    "progress": 100,
                },
            )
        except asyncio.TimeoutError:
            exc = RuntimeError(
                f"Agent task timed out after {timeout_seconds} seconds."
            )
            attempts = int(task.get("attempts", 0) or 0)
            max_attempts = int(task.get("max_attempts", 3) or 3)
            next_status = "queued" if attempts < max_attempts else "failed"
            async with self._run_lock(run_id):
                board = run_manager.load_task_board(run_id)
                self.progress.update_task(
                    board,
                    task_id,
                    status=next_status,
                    progress=0,
                    latest_error=str(exc),
                    next_steps=["Review timeout cause and split the task if needed."],
                )
                run_manager.save_task_board(run_id, board)
                run_manager.append_log(run_id, "error.log", f"{task_id}: {exc}")
                self._update_run_current_tasks(run_id, remove_task_id=task_id)
                registry.set_status(
                    run_id,
                    agent["agent_id"],
                    status="idle" if next_status == "queued" else "failed",
                    current_task_id=None if next_status == "queued" else task_id,
                    current_phase=phase,
                    progress=0,
                )
                if next_status == "failed":
                    self._block_dependents(run_id, task_id, str(exc))
            await self._emit(
                queue,
                run_id,
                "task_timeout",
                {
                    "agent_id": agent["agent_id"],
                    "role": role,
                    "task_id": task_id,
                    "status": next_status,
                    "timeout_seconds": timeout_seconds,
                    "error": str(exc),
                },
            )
            if next_status == "queued":
                await self._emit(
                    queue,
                    run_id,
                    "retry",
                    {
                        "agent_id": agent["agent_id"],
                        "role": role,
                        "task_id": task_id,
                        "timeout_seconds": timeout_seconds,
                        "error": str(exc),
                    },
                )
        except Exception as exc:
            attempts = int(task.get("attempts", 0) or 0)
            max_attempts = int(task.get("max_attempts", 3) or 3)
            next_status = "queued" if attempts < max_attempts else "failed"
            async with self._run_lock(run_id):
                board = run_manager.load_task_board(run_id)
                self.progress.update_task(
                    board,
                    task_id,
                    status=next_status,
                    progress=0,
                    latest_error=str(exc),
                    next_steps=["Inspect logs and retry with refined instructions."],
                )
                run_manager.save_task_board(run_id, board)
                run_manager.append_log(run_id, "error.log", f"{task_id}: {exc}")
                self._update_run_current_tasks(run_id, remove_task_id=task_id)
                registry.set_status(
                    run_id,
                    agent["agent_id"],
                    status="idle" if next_status == "queued" else "failed",
                    current_task_id=None if next_status == "queued" else task_id,
                    current_phase=phase,
                    progress=0,
                )
                if next_status == "failed":
                    self._block_dependents(run_id, task_id, str(exc))
            if next_status == "queued":
                await self._emit(
                    queue,
                    run_id,
                    "retry",
                    {
                        "agent_id": agent["agent_id"],
                        "role": role,
                        "task_id": task_id,
                        "error": str(exc),
                    },
                )
            else:
                await self._emit(
                    queue,
                    run_id,
                    "task_update",
                    {
                        "agent_id": agent["agent_id"],
                        "role": role,
                        "task_id": task_id,
                        "status": "failed",
                        "progress": 0,
                        "error": str(exc),
                    },
                )

    async def _recover_orphaned_tasks(
        self,
        run_id: str,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> None:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        requeued: list[dict[str, str]] = []
        async with self._run_lock(run_id):
            board = run_manager.load_task_board(run_id)
            changed = False
            for task in board.get("tasks", []):
                if task.get("status") != "in_progress":
                    continue
                self.progress.update_task(
                    board,
                    task["task_id"],
                    status="queued",
                    progress=0,
                    latest_error=task.get("latest_error") or "Task was re-queued during run recovery.",
                    next_steps=["Resume the task from the last durable handoff and continue."],
                )
                requeued.append(
                    {
                        "task_id": str(task["task_id"]),
                        "role": str(task.get("owner_role", "")),
                    }
                )
                changed = True

            if changed:
                run_manager.save_task_board(run_id, board)
                run_manager.update_run(run_id, current_task_ids=[])
                for agent in registry.list_agents(run_id):
                    if agent.get("status") == "in_progress":
                        registry.set_status(
                            run_id,
                            agent["agent_id"],
                            status="idle",
                            current_task_id=None,
                            progress=0,
                        )

        for item in requeued:
            await self._emit(
                queue,
                run_id,
                "task_requeued",
                {
                    "task_id": item["task_id"],
                    "role": item["role"],
                    "reason": "Recovered orphaned in-progress task before resuming the run.",
                },
            )

    def _select_parallel_tasks(self, ready_tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not ready_tasks:
            return []

        phase = str(ready_tasks[0].get("phase", "development"))
        selected: list[dict[str, Any]] = []
        seen_roles: set[str] = set()
        for task in ready_tasks:
            if str(task.get("phase", phase)) != phase:
                continue
            role = str(task.get("owner_role", ""))
            if role in seen_roles:
                continue
            selected.append(task)
            seen_roles.add(role)
            if len(selected) >= self._parallel_task_limit:
                break
        return selected

    def _update_run_current_tasks(
        self,
        run_id: str,
        *,
        add_task_id: str | None = None,
        remove_task_id: str | None = None,
        phase: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        run = run_manager.load_run(run_id)
        current_task_ids = [str(task_id) for task_id in run.get("current_task_ids", [])]
        if add_task_id and add_task_id not in current_task_ids:
            current_task_ids.append(add_task_id)
        if remove_task_id:
            current_task_ids = [task_id for task_id in current_task_ids if task_id != remove_task_id]

        patch: dict[str, Any] = {"current_task_ids": current_task_ids}
        if phase is not None:
            patch["phase"] = phase
        if status is not None:
            patch["status"] = status
        return run_manager.update_run(run_id, **patch)

    def _task_timeout_for(self, task: dict[str, Any]) -> int:
        raw = task.get("timeout_seconds")
        if raw is None:
            return self._task_timeout_seconds
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return self._task_timeout_seconds
        return value if value > 0 else self._task_timeout_seconds

    def _runtime_settings_payload(self) -> dict[str, Any]:
        settings = get_settings()
        return {
            "llm_provider": settings.llm_provider,
            "llm_model": settings.llm_model,
            "terminal_timeout_seconds": settings.terminal_timeout_seconds,
            "multi_agent_task_timeout_seconds": settings.multi_agent_task_timeout_seconds,
            "parallel_task_limit": self._parallel_task_limit,
        }

    def _refresh_blocked_tasks(self, run_id: str) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        board = run_manager.load_task_board(run_id)
        tasks_by_id = {task["task_id"]: task for task in board.get("tasks", [])}
        changed = False
        for task in board.get("tasks", []):
            if task.get("status") != "blocked":
                continue
            dependencies = task.get("dependencies", [])
            if all(tasks_by_id.get(dep, {}).get("status") == "completed" for dep in dependencies):
                task["status"] = "pending"
                task["blocked_reason"] = ""
                changed = True
        if changed:
            run_manager.save_task_board(run_id, board)

    def _block_dependents(self, run_id: str, failed_task_id: str, reason: str) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        board = run_manager.load_task_board(run_id)
        timestamp = run_manager.load_run(run_id).get("updated_at_iso", "")
        changed = False
        for task in board.get("tasks", []):
            if failed_task_id in task.get("dependencies", []) and task.get("status") in {"pending", "queued"}:
                task["status"] = "blocked"
                task["blocked_reason"] = f"Blocked by {failed_task_id}: {reason}"
                task["updated_at"] = timestamp
                changed = True
        if changed:
            run_manager.save_task_board(run_id, board)

    def _build_assignment_message(
        self,
        run_id: str,
        from_agent_id: str,
        target_agent: dict[str, Any],
        task: dict[str, Any],
    ) -> dict[str, Any]:
        attachments = self._attachment_refs(
            run_id,
            [
                f"backend/workspace/runs/{run_id}/project-plan.md",
                f"backend/workspace/runs/{run_id}/shared-memory.md",
                f"backend/workspace/runs/{run_id}/architecture.md",
            ],
        )
        return {
            "schemaVersion": "1.0",
            "messageId": f"msg-{task['task_id']}",
            "correlationId": f"corr-{task['task_id']}",
            "replyTo": None,
            "type": "task_assignment",
            "from": from_agent_id,
            "to": target_agent["agent_id"],
            "timestamp": None,
            "content": {
                "subject": task["title"],
                "details": task["description"],
                "attachments": attachments,
            },
            "metadata": {
                "runId": run_id,
                "taskId": task["task_id"],
                "priority": task["priority"],
                "dependsOn": task.get("dependencies", []),
            },
        }

    def _attachment_refs(self, run_id: str, paths: list[str]) -> list[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        attachments: list[dict[str, Any]] = []
        for path in paths:
            version = run_manager.get_file_version(run_id, path)
            attachments.append(
                {
                    "path": path,
                    "version": int((version or {}).get("version", 0) or 0),
                    "hash": (version or {}).get("hash", ""),
                    "snapshotId": (version or {}).get("snapshot_id", ""),
                }
            )
        return attachments

    async def _run_agent_task(
        self,
        run_id: str,
        agent: dict[str, Any],
        task: dict[str, Any],
        user_request: str,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        role = agent["role"]
        model = agent_manager._build_chat_model()
        tools = self._build_tools_for_agent(run_id, agent)
        system_prompt = self._build_role_prompt(run_id, agent, task)
        langchain_agent = create_agent(model=model, tools=tools, system_prompt=system_prompt)

        history = self.get_agent_history(run_id, agent["agent_id"], limit=50)
        messages: list[dict[str, str]] = []
        for item in history:
            role_name = item.get("role")
            if role_name not in {"user", "assistant"}:
                continue
            messages.append({"role": role_name, "content": str(item.get("content", ""))})

        prompt = self._task_prompt(run_id, agent, task, user_request)
        messages.append({"role": "user", "content": prompt})
        run_manager.append_history(
            run_id,
            agent["agent_id"],
            "user",
            prompt,
            metadata={"task_id": task["task_id"], "phase": task["phase"]},
        )

        if runtime_config.get_rag_mode():
            retrievals = memory_indexer.retrieve(prompt, top_k=3)
            if retrievals:
                await self._emit(
                    queue,
                    run_id,
                    "retrieval",
                    {
                        "agent_id": agent["agent_id"],
                        "role": role,
                        "task_id": task["task_id"],
                        "results": retrievals,
                    },
                )
                context_lines = ["[RAG retrieved memory context]"]
                for index, item in enumerate(retrievals, start=1):
                    context_lines.append(
                        f"{index}. Source: {item.get('source', 'memory/MEMORY.md')}\n{item.get('text', '')}"
                    )
                messages.append({"role": "assistant", "content": "\n\n".join(context_lines)})

        final_content_parts: list[str] = []
        last_ai_message = ""
        pending_tools: dict[str, dict[str, str]] = {}
        tool_calls: list[dict[str, str]] = []

        async for mode, payload in langchain_agent.astream(
            {"messages": messages},
            stream_mode=["messages", "updates"],
        ):
            if mode == "messages":
                chunk, _metadata = payload
                if getattr(chunk, "type", "") == "tool":
                    continue
                text = _stringify_content(getattr(chunk, "content", ""))
                if text:
                    final_content_parts.append(text)
                    await self._emit(
                        queue,
                        run_id,
                        "token",
                        {
                            "agent_id": agent["agent_id"],
                            "role": role,
                            "task_id": task["task_id"],
                            "content": text,
                        },
                    )
                continue

            if mode != "updates":
                continue

            for update in payload.values():
                for agent_message in update.get("messages", []):
                    message_type = getattr(agent_message, "type", "")
                    tool_call_entries = getattr(agent_message, "tool_calls", []) or []

                    if message_type == "ai" and not tool_call_entries:
                        candidate = _stringify_content(getattr(agent_message, "content", ""))
                        if candidate:
                            last_ai_message = candidate

                    if tool_call_entries:
                        for tool_call in tool_call_entries:
                            call_id = str(tool_call.get("id") or tool_call.get("name"))
                            tool_name = str(tool_call.get("name", "tool"))
                            tool_args = tool_call.get("args", "")
                            if not isinstance(tool_args, str):
                                tool_args = json.dumps(tool_args, ensure_ascii=False)
                            pending_tools[call_id] = {"tool": tool_name, "input": str(tool_args)}
                            tool_calls.append({"tool": tool_name, "input": str(tool_args), "output": ""})
                            await self._emit(
                                queue,
                                run_id,
                                "tool_start",
                                {
                                    "agent_id": agent["agent_id"],
                                    "role": role,
                                    "task_id": task["task_id"],
                                    "tool": tool_name,
                                    "input": str(tool_args),
                                },
                            )

                    if message_type == "tool":
                        tool_call_id = str(getattr(agent_message, "tool_call_id", ""))
                        pending = pending_tools.pop(
                            tool_call_id,
                            {"tool": getattr(agent_message, "name", "tool"), "input": ""},
                        )
                        output = _stringify_content(getattr(agent_message, "content", ""))
                        if tool_calls:
                            tool_calls[-1]["output"] = output
                        await self._emit(
                            queue,
                            run_id,
                            "tool_end",
                            {
                                "agent_id": agent["agent_id"],
                                "role": role,
                                "task_id": task["task_id"],
                                "tool": pending["tool"],
                                "output": output,
                            },
                        )

        final_content = "".join(final_content_parts).strip() or last_ai_message.strip()
        self._sync_expected_outputs(run_id, agent, task)
        summary = final_content or "Task finished without a textual summary."
        run_manager.append_history(
            run_id,
            agent["agent_id"],
            "assistant",
            summary,
            tool_calls=tool_calls,
            metadata={"task_id": task["task_id"], "phase": task["phase"]},
        )
        await self._write_handoff(run_id, agent, task, summary)
        return {
            "summary": summary,
            "tool_calls": tool_calls,
            "verify_command": self._default_verify_command(agent["role"]),
            "next_steps": self._default_next_steps(agent["role"]),
        }

    def _build_tools_for_agent(self, run_id: str, agent: dict[str, Any]) -> list[Any]:
        backend_dir, _host_project_root, run_manager, registry = self._require_runtime()
        role = agent["role"]
        project_root = run_manager.project_root_for_run(run_id)
        run_root = run_manager.run_root(run_id)
        return [
            TerminalTool(root_dir=project_root),
            PythonReplTool(root_dir=project_root),
            FetchURLTool(),
            ReadFileTool(
                root_dir=project_root,
                path_aliases={
                    f"backend/workspace/runs/{run_id}": run_root,
                    "backend/workspace/AGENTS.md": backend_dir / "workspace" / "AGENTS.md",
                    "backend/memory/MEMORY.md": backend_dir / "memory" / "MEMORY.md",
                    "backend/SKILLS_SNAPSHOT.md": backend_dir / "SKILLS_SNAPSHOT.md",
                },
            ),
            SearchKnowledgeBaseTool(root_dir=backend_dir),
            WriteFileTool(
                project_root=project_root,
                run_manager=run_manager,
                run_id=run_id,
                agent_id=agent["agent_id"],
            ),
            MemoryGetTool(backend_dir=backend_dir),
            MemorySearchTool(backend_dir=backend_dir, run_manager=run_manager, run_id=run_id),
            SessionsSpawnTool(
                run_id=run_id,
                current_agent_id=agent["agent_id"],
                current_role=role,
                registry=registry,
                run_manager=run_manager,
            ),
            SessionsSendTool(
                run_id=run_id,
                current_agent_id=agent["agent_id"],
                registry=registry,
            ),
            SessionsHistoryTool(run_id=run_id, registry=registry),
        ]

    def _build_role_prompt(self, run_id: str, agent: dict[str, Any], task: dict[str, Any]) -> str:
        backend_dir, _host_project_root, run_manager, _registry = self._require_runtime()
        project_root = run_manager.project_root_for_run(run_id)
        base_prompt = build_system_prompt(backend_dir, runtime_config.get_rag_mode())
        role = agent["role"]
        boundary = {
            "PC": "Coordinate the project, manage task decomposition, and synthesize delivery status.",
            "CA": "Own architecture, schemas, boundaries, and shared contracts.",
            "FD": "Prefer frontend/* and UI-facing white-box changes.",
            "BD": "Prefer backend/* runtime, APIs, storage, and toolchain changes.",
            "DE": "Own execution commands, scripts, and environment-facing notes.",
            "QT": "Own validation, testing, bug finding, and test reports.",
        }[role]
        contract = (
            f"\n\n[Multi-Agent Run Contract]\n"
            f"- You are role {role} for run {run_id}.\n"
            f"- Agent ID: {agent['agent_id']}\n"
            f"- Session key: {agent['session_key']}\n"
            f"- Current task: {task['task_id']} / {task['title']}\n"
            f"- Responsibility: {boundary}\n"
            f"- Use write_file instead of shell redirection for project edits whenever possible.\n"
            f"- Use sessions_send for handoffs when another role needs your output.\n"
            f"- Keep changes white-box and traceable.\n"
            f"- The execution environment is Windows PowerShell. Do not assume bash utilities like head or ls -la.\n"
            f"- This run is a greenfield build inside the generated project root, not a refactor of the host repository.\n"
            f"- Do not inspect the host repository unless the task explicitly names a host-side file that must be changed.\n"
            f"- Keep exploration tight: inspect only the files needed to start, then make the smallest viable write quickly.\n"
            f"- If the task provides explicit target paths, create or update those exact paths instead of inventing alternatives.\n"
            f"- Do not dump full source files or huge command outputs into your final summary.\n"
            f"- Generated project root: {project_root}\n"
            f"- Run root: {backend_dir / 'workspace' / 'runs' / run_id}\n"
        )
        if role == "CA":
            contract += (
                "- Keep architecture output concise and implementation-facing.\n"
                "- Avoid large ASCII diagrams and avoid pasting existing files verbatim.\n"
                "- Prefer the canonical run files architecture.md and shared-memory.md for design output.\n"
            )
        return base_prompt + contract

    def _task_prompt(
        self,
        run_id: str,
        agent: dict[str, Any],
        task: dict[str, Any],
        user_request: str,
    ) -> str:
        target_paths = task.get("target_paths", [])
        extra = ""
        if agent["role"] == "CA":
            extra = (
                "\nFor this design task, produce a concise architecture.md and a short handoff."
                " Focus on folder structure, game loop/state, and implementation order."
                " Do not create oversized diagrams or copy existing files into the summary."
            )
        elif agent["role"] == "FD" and target_paths:
            extra = (
                "\nStart by creating or updating the explicit frontend target path(s) before broad polish."
                " Get the first playable result on disk as early as possible."
            )
        target_line = (
            f"Target paths: {', '.join(str(path) for path in target_paths)}\n"
            if target_paths
            else ""
        )
        return (
            f"Run ID: {run_id}\n"
            f"Agent role: {agent['role']}\n"
            f"Task ID: {task['task_id']}\n"
            f"Task title: {task['title']}\n"
            f"Task phase: {task['phase']}\n"
            f"{target_line}"
            f"User request: {user_request}\n"
            f"Task description: {task['description']}\n"
            f"Dependencies: {', '.join(task.get('dependencies', [])) or 'none'}\n"
            f"Please do the work directly in the repository, use tools transparently, and leave a concise"
            f" summary of what you changed plus any follow-up verification steps."
            f"{extra}"
        )

    def _sync_expected_outputs(self, run_id: str, agent: dict[str, Any], task: dict[str, Any]) -> None:
        _backend_dir, project_root, run_manager, _registry = self._require_runtime()
        if agent["role"] != "CA":
            return

        promotions = [
            (
                f"backend/workspace/runs/{run_id}/artifacts/architecture.md",
                f"backend/workspace/runs/{run_id}/architecture.md",
            ),
            (
                f"backend/workspace/runs/{run_id}/artifacts/shared-memory.md",
                f"backend/workspace/runs/{run_id}/shared-memory.md",
            ),
        ]
        for source_rel, target_rel in promotions:
            source_path = (project_root / source_rel).resolve()
            target_path = (project_root / target_rel).resolve()
            if not source_path.exists():
                continue

            source_text = source_path.read_text(encoding="utf-8")
            target_text = target_path.read_text(encoding="utf-8") if target_path.exists() else ""
            if not self._should_promote_output(target_rel, source_text, target_text):
                continue

            run_manager.write_project_text(
                run_id,
                agent["agent_id"],
                target_rel,
                source_text if source_text.endswith("\n") else source_text + "\n",
            )

    def _should_promote_output(self, target_rel: str, source_text: str, target_text: str) -> bool:
        if not source_text.strip():
            return False

        normalized_target = target_rel.replace("\\", "/")
        normalized_current = target_text.strip()
        if not normalized_current:
            return True
        if normalized_target.endswith("/architecture.md"):
            return normalized_current == "# Architecture\n\nPending architect output."
        if normalized_target.endswith("/shared-memory.md"):
            return normalized_current == "# Shared Memory\n\nPending shared notes."
        return normalized_current != source_text.strip()

    async def _write_handoff(
        self,
        run_id: str,
        agent: dict[str, Any],
        task: dict[str, Any],
        summary: str,
    ) -> None:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        handoff_rel = f"backend/workspace/runs/{run_id}/handoff/{agent['role']}.md"
        existing_path = run_manager.run_root(run_id) / "handoff" / f"{agent['role']}.md"
        existing = existing_path.read_text(encoding="utf-8") if existing_path.exists() else ""
        next_content = (
            existing
            + f"\n## {task['task_id']} - {task['title']}\n\n"
            + f"- Agent: `{agent['agent_id']}`\n"
            + f"- Phase: `{task['phase']}`\n"
            + f"- Summary: {summary}\n"
        )
        run_manager.write_project_text(
            run_id,
            agent["agent_id"],
            handoff_rel,
            next_content.strip() + "\n",
        )
        if agent["role"] != "PC":
            pc_agent = next(item for item in registry.list_agents(run_id) if item["role"] == "PC")
            registry.sessions_send(
                run_id,
                from_agent_id=agent["agent_id"],
                session_key=pc_agent["session_key"],
                message=json.dumps(
                    {
                        "schemaVersion": "1.0",
                        "messageId": f"msg-{task['task_id']}-handoff",
                        "correlationId": f"corr-{task['task_id']}",
                        "replyTo": None,
                        "type": "handoff",
                        "from": agent["agent_id"],
                        "to": pc_agent["agent_id"],
                        "timestamp": None,
                        "content": {
                            "subject": task["title"],
                            "details": summary,
                            "attachments": self._attachment_refs(run_id, [handoff_rel]),
                        },
                        "metadata": {
                            "runId": run_id,
                            "taskId": task["task_id"],
                            "priority": task["priority"],
                        },
                    },
                    ensure_ascii=False,
                ),
            )

    def _default_verify_command(self, role: str) -> str:
        return {
            "FD": "npm.cmd run lint",
            "BD": "python -m pytest",
            "DE": "python -m uvicorn app:app --help",
            "QT": "npm.cmd run lint && python -m pytest",
        }.get(role, "")

    def _default_next_steps(self, role: str) -> list[str]:
        return {
            "PC": ["Review completion status and prepare the final report."],
            "CA": ["Hand off architecture constraints to implementation agents."],
            "FD": ["Verify UI renders the new run dashboard and timeline."],
            "BD": ["Verify the new API routes and run storage behavior."],
            "DE": ["Confirm route wiring and runtime assumptions."],
            "QT": ["Write the final test report with risks and gaps."],
        }.get(role, [])

    async def _emit(
        self,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        event = run_manager.append_event(run_id, event_type, payload)
        if queue is not None:
            await queue.put(event)
        return event


multi_agent_orchestrator = MultiAgentOrchestrator()
