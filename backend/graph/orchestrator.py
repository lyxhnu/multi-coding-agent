from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from langchain.agents import create_agent

from config import get_settings, runtime_config
from graph.agent import agent_manager
from graph.agent_registry import AgentRegistry
from graph.progress_tracker import ProgressTracker
from graph.prompt_builder import build_system_prompt
from graph.run_manager import RunManager
from graph.semantic_memory import semantic_memory
from graph.task_allocator import TaskAllocator
from memory.card_store import card_store
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


def _compact_text(content: Any, limit: int = 240) -> str:
    text = re.sub(r"\s+", " ", str(content or "")).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


@dataclass(frozen=True)
class FollowupIntent:
    type: str
    confidence: str
    reason: str
    related_task_ids: list[str] = field(default_factory=list)
    source: str = "rule"


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
        self._followup_recent_message_limit = 8
        self._agent_recent_history_limit = 10
        self._followup_answer_timeout_seconds = 30

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

    def get_conversation(self, run_id: str, limit: int = 100) -> list[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        return run_manager.read_conversation(run_id, limit=limit)

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
        run_manager.append_conversation_message(
            run_id,
            "user",
            user_request,
            metadata={"kind": "initial_request"},
        )
        run_manager.append_event(
            run_id,
            "user_message",
            {
                "content": user_request,
                "summary": "Initial user request",
            },
        )
        board = self.allocator.create_initial_board(run_id, user_request)
        run_manager.save_task_board(run_id, board)
        agents = registry.base_agents(run_id)
        run_manager.append_event(
            run_id,
            "task_board_initialized",
            {"task_count": len(board["tasks"]), "agent_count": len(agents)},
        )
        await self._write_default_plan_files(run_id, user_request, board, agents)
        self._bootstrap_summaries(run_id)
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
        run_manager.append_conversation_message(
            run_id,
            "user",
            user_request,
            metadata={"kind": "initial_request"},
        )
        run_manager.append_event(
            run_id,
            "user_message",
            {
                "content": user_request,
                "summary": "Initial user request",
            },
        )
        board = self.allocator.create_initial_board(run_id, user_request)
        run_manager.save_task_board(run_id, board)
        agents = registry.base_agents(run_id)
        run_manager.append_event(
            run_id,
            "task_board_initialized",
            {"task_count": len(board["tasks"]), "agent_count": len(agents)},
        )
        await self._write_default_plan_files(run_id, user_request, board, agents)
        self._bootstrap_summaries(run_id)
        self._bootstrap_startup_task(run_id)
        task = asyncio.create_task(self._execute_run(run_id, user_request, None))
        self._track_run_task(run_id, task)
        return run

    async def astream_followup_run(
        self,
        *,
        run_id: str,
        user_request: str,
    ) -> AsyncIterator[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        run = run_manager.load_run(run_id)
        if run_id in self._active_runs:
            raise RuntimeError("The selected run is still active. Wait for it to finish before sending a new follow-up.")

        board = run_manager.load_task_board(run_id)
        intent = self.followup_intent_router(
            user_message=user_request,
            run_status=str(run.get("status", "")),
            task_board=board,
        )
        intent_payload = self._followup_intent_payload(intent)

        run_manager.append_conversation_message(
            run_id,
            "user",
            user_request,
            metadata={"kind": "followup_request"},
            followup_meta=intent_payload,
        )

        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        await self._emit(
            queue,
            run_id,
            "user_message",
            {
                "content": user_request,
                "summary": "Follow-up request received",
            },
        )
        await self._emit(
            queue,
            run_id,
            "followup_routed",
            {
                "intent": intent.type,
                "confidence": intent.confidence,
                "reason": intent.reason,
                "source": intent.source,
                "related_task_ids": intent.related_task_ids,
                "channel": intent.type,
                "summary": f"Follow-up routed to {intent.type}.",
            },
        )

        if intent.type == "answer":
            task = asyncio.create_task(self._run_followup_response_readonly(run_id, user_request, intent, queue))
        elif intent.type == "resume":
            task = asyncio.create_task(self._resume_unfinished_tasks(run_id, user_request, intent, queue))
        elif intent.type == "modify":
            task = asyncio.create_task(self._append_followup_tasks(run_id, user_request, intent, queue))
        else:
            raise RuntimeError(f"Unsupported follow-up intent: {intent.type}")
        self._track_run_task(run_id, task)

        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            await asyncio.gather(task, return_exceptions=True)

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

    def _legacy_followup_requires_work(self, user_request: str) -> bool:
        lowered = user_request.lower()
        if re.search(r"(frontend|backend|src|app|workspace)[A-Za-z0-9_./\\-]*\.[A-Za-z0-9]+", user_request):
            return True

        work_terms = (
            "修改",
            "改一下",
            "改成",
            "改为",
            "新增",
            "添加",
            "增加",
            "实现",
            "修复",
            "优化",
            "重构",
            "删除",
            "替换",
            "调整",
            "继续做",
            "继续实现",
            "补充",
            "支持",
            "create ",
            "add ",
            "update ",
            "modify ",
            "change ",
            "implement ",
            "fix ",
            "refactor ",
            "remove ",
            "replace ",
            "support ",
        )
        question_terms = (
            "?",
            "？",
            "为什么",
            "怎么",
            "如何",
            "是什么",
            "解释",
            "说明",
            "分析",
            "why ",
            "how ",
            "what ",
            "explain ",
            "analyze ",
        )
        if any(term in lowered for term in work_terms):
            return True
        if any(term in lowered for term in question_terms):
            return False
        return False

    def _legacy_append_followup_tasks(self, run_id: str, user_request: str) -> list[dict[str, Any]]:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        board = run_manager.load_task_board(run_id)
        for task in board.get("tasks", []):
            if task.get("status") not in {"failed", "blocked"}:
                continue
            task["status"] = "superseded"
            task["blocked_reason"] = "Superseded by a later follow-up request in the same run."
        new_tasks = self.allocator.create_followup_tasks(run_id, user_request)
        board["tasks"].extend(new_tasks)
        run_manager.save_task_board(run_id, board)

        pc_agent = next(item for item in registry.list_agents(run_id) if item["role"] == "PC")
        self._append_followup_notes(
            run_id,
            pc_agent["agent_id"],
            user_request,
            [task["task_id"] for task in new_tasks],
        )
        return new_tasks

    def _append_followup_notes(
        self,
        run_id: str,
        agent_id: str,
        user_request: str,
        task_ids: list[str],
    ) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        run_root = run_manager.run_root(run_id)
        task_line = ", ".join(task_ids) if task_ids else "none"
        note = (
            "\n## Follow-up Request\n\n"
            f"- Request: {user_request}\n"
            f"- Planned Tasks: {task_line}\n"
        )

        for relative_path, actual_path in (
            (f"backend/workspace/runs/{run_id}/project-plan.md", run_root / "project-plan.md"),
            (f"backend/workspace/runs/{run_id}/shared-memory.md", run_root / "shared-memory.md"),
        ):
            existing = actual_path.read_text(encoding="utf-8") if actual_path.exists() else ""
            run_manager.write_project_text(
                run_id,
                agent_id,
                relative_path,
                existing.rstrip() + note + "\n",
            )

    def _followup_intent_payload(self, intent: FollowupIntent) -> dict[str, Any]:
        return {
            "intent": intent.type,
            "confidence": intent.confidence,
            "reason": intent.reason,
            "source": intent.source,
            "related_task_ids": list(intent.related_task_ids),
        }

    def _looks_like_question(self, message: str) -> bool:
        lowered = message.lower()
        signals = (
            "?",
            "\uFF1F",
            "\u4e3a\u4ec0\u4e48",
            "\u600e\u4e48\u56de\u4e8b",
            "\u600e\u4e48",
            "\u5982\u4f55",
            "\u662f\u4ec0\u4e48",
            "\u89e3\u91ca",
            "\u8bf4\u660e",
            "\u5206\u6790",
            "\u505a\u5230\u54ea",
            "\u8fdb\u5ea6",
            "\u72b6\u6001",
            "\u80fd\u8dd1\u5417",
            "why ",
            "how ",
            "what ",
            "status",
            "progress",
            "explain ",
        )
        return any(signal in lowered or signal in message for signal in signals)

    def _has_modify_signal(self, message: str) -> bool:
        lowered = message.lower()
        signals = (
            "\u6539",
            "\u4fee\u6539",
            "\u52a0",
            "\u8865",
            "\u6362",
            "\u5220",
            "\u589e\u52a0",
            "\u8c03\u6574",
            "\u4f18\u5316",
            "\u4fee",
            "create ",
            "add ",
            "update ",
            "modify ",
            "change ",
            "implement ",
            "fix ",
            "refactor ",
            "remove ",
            "replace ",
            "support ",
        )
        return any(signal in lowered or signal in message for signal in signals)

    def _has_resume_signal(self, message: str) -> bool:
        lowered = message.lower()
        signals = (
            "\u7ee7\u7eed",
            "\u63a5\u7740",
            "\u8d85\u65f6",
            "\u91cd\u8bd5",
            "\u7ee7\u7eed\u505a",
            "\u505a\u5b8c",
            "resume",
            "retry",
            "continue",
        )
        return any(signal in lowered or signal in message for signal in signals)

    def _followup_role_hints(self, message: str) -> set[str]:
        lowered = message.lower()
        hints: set[str] = set()
        if any(term in lowered or term in message for term in ("\u524d\u7aef", "\u9875\u9762", "\u754c\u9762", "ui", "frontend", "react", "route")):
            hints.add("FD")
        if any(term in lowered or term in message for term in ("\u540e\u7aef", "\u63a5\u53e3", "api", "backend", "auth", "database", "\u6570\u636e\u5e93", "\u670d\u52a1")):
            hints.add("BD")
        if any(term in lowered or term in message for term in ("\u90e8\u7f72", "\u811a\u672c", "docker", "env", "\u73af\u5883", "build", "deploy")):
            hints.add("DE")
        if any(term in lowered or term in message for term in ("\u6d4b\u8bd5", "\u6821\u9a8c", "\u9a8c\u8bc1", "qa", "test")):
            hints.add("QT")
        if any(term in lowered or term in message for term in ("\u67b6\u6784", "\u8bbe\u8ba1", "architecture", "contract")):
            hints.add("CA")
        return hints

    def _find_related_tasks(self, user_message: str, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        hints = self._followup_role_hints(user_message)
        lowered = user_message.lower()
        scored: list[tuple[int, str, dict[str, Any]]] = []
        for task in tasks:
            score = 0
            role = str(task.get("owner_role", ""))
            if hints and role in hints:
                score += 3
            haystack = " ".join(
                [
                    str(task.get("title", "")).lower(),
                    str(task.get("description", "")).lower(),
                    " ".join(str(path).lower() for path in task.get("target_paths", [])),
                ]
            )
            for token in filter(None, re.split(r"\s+", lowered)):
                if len(token) < 3:
                    continue
                if token in haystack:
                    score += 1
            if score <= 0:
                continue
            scored.append((score, str(task.get("updated_at", "")), task))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [item[2] for item in scored[:3]]

    def followup_intent_router(
        self,
        *,
        user_message: str,
        run_status: str,
        task_board: dict[str, Any],
    ) -> FollowupIntent:
        msg = user_message.strip()
        tasks = list(task_board.get("tasks", []))
        failed_tasks = [task for task in tasks if task.get("status") == "failed"]
        blocked_tasks = [task for task in tasks if task.get("status") == "blocked"]
        queued_tasks = [task for task in tasks if task.get("status") == "queued"]
        has_unfinished = bool(failed_tasks or blocked_tasks or queued_tasks)

        if run_status == "completed":
            if self._looks_like_question(msg) and not self._has_modify_signal(msg):
                return FollowupIntent(
                    type="answer",
                    confidence="high",
                    reason="run already completed and the follow-up is a status question",
                    source="run_state",
                )
            return FollowupIntent(
                type="modify",
                confidence="high",
                reason="run already completed; non-question follow-up defaults to modify",
                source="run_state",
            )

        if self._has_resume_signal(msg) and has_unfinished:
            prioritized = self.allocator.prioritize_resumable(
                failed_tasks=failed_tasks,
                blocked_tasks=blocked_tasks,
                queued_tasks=queued_tasks,
                task_status_lookup={str(task["task_id"]): str(task.get("status", "")) for task in tasks},
            )
            return FollowupIntent(
                type="resume",
                confidence="high",
                reason="resume signal matched and the run still has unfinished work",
                related_task_ids=[item["task"]["task_id"] for item in prioritized[:3]],
                source="task_state",
            )

        related_unfinished = self._find_related_tasks(msg, [*failed_tasks, *blocked_tasks, *queued_tasks])
        if related_unfinished:
            return FollowupIntent(
                type="resume",
                confidence="medium",
                reason="follow-up appears related to unfinished tasks",
                related_task_ids=[str(task["task_id"]) for task in related_unfinished],
                source="task_state",
            )

        has_question = self._looks_like_question(msg)
        has_modify = self._has_modify_signal(msg)
        if has_question and not has_modify:
            return FollowupIntent(
                type="answer",
                confidence="high",
                reason="question signals matched without modification signals",
                source="rule",
            )
        if has_modify:
            return FollowupIntent(
                type="modify",
                confidence="high",
                reason="modification signals matched",
                source="rule",
            )
        if has_unfinished:
            return FollowupIntent(
                type="resume",
                confidence="low",
                reason="unfinished work exists so resume is preferred by default",
                source="fallback",
            )
        return FollowupIntent(
            type="answer",
            confidence="low",
            reason="no unfinished work remains so the follow-up defaults to answer",
            source="fallback",
        )

    async def _append_followup_tasks(
        self,
        run_id: str,
        user_request: str,
        intent: FollowupIntent,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        try:
            board = run_manager.load_task_board(run_id)
            new_tasks = self.allocator.create_delta_tasks(run_id, user_request)
            board["tasks"].extend(new_tasks)
            run_manager.save_task_board(run_id, board)

            first_phase = str(new_tasks[0].get("phase", "development")) if new_tasks else "development"
            run_manager.update_run(run_id, status="queued", phase=first_phase, current_task_ids=[])
            await self._emit(
                queue,
                run_id,
                "followup_planned",
                {
                    "status": "queued",
                    "phase": first_phase,
                    "channel": "modify",
                    "summary": "Planned incremental modification work inside the current run.",
                    "task_ids": [task["task_id"] for task in new_tasks],
                    "created_task_ids": [task["task_id"] for task in new_tasks],
                    "related_task_ids": intent.related_task_ids,
                },
            )
            await self._execute_run(run_id, user_request, queue)
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"followup-modify: {exc}")
            await self._emit(
                queue,
                run_id,
                "error",
                {
                    "channel": "modify",
                    "error": str(exc),
                    "status": "failed",
                },
            )
        finally:
            if queue is not None:
                await queue.put(None)

    async def _resume_unfinished_tasks(
        self,
        run_id: str,
        user_request: str,
        intent: FollowupIntent,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        try:
            board = run_manager.load_task_board(run_id)
            tasks = list(board.get("tasks", []))
            prioritized = self.allocator.prioritize_resumable(
                failed_tasks=[task for task in tasks if task.get("status") == "failed"],
                blocked_tasks=[task for task in tasks if task.get("status") == "blocked"],
                queued_tasks=[task for task in tasks if task.get("status") == "queued"],
                task_status_lookup={str(task["task_id"]): str(task.get("status", "")) for task in tasks},
            )
            if intent.related_task_ids:
                selected_ids = set(intent.related_task_ids)
                prioritized = [item for item in prioritized if item["task"]["task_id"] in selected_ids] or prioritized
            selected = prioritized[:3]
            if not selected:
                raise RuntimeError("No unfinished task could be resumed for this follow-up request.")

            now_iso = run_manager.load_run(run_id).get("updated_at_iso", "")
            resumed_task_ids: list[str] = []
            retried_task_ids: list[str] = []
            for candidate in selected:
                task = candidate["task"]
                resume_type = str(candidate["resume_type"])
                if resume_type == "retry":
                    retry_task = self.allocator.build_retry_task(task, str(now_iso))
                    handoff_path = run_manager.run_root(run_id) / "handoff" / f"{task['owner_role']}.md"
                    if handoff_path.exists():
                        retry_task["retry_context"]["previous_result_ref"] = (
                            f"backend/workspace/runs/{run_id}/handoff/{task['owner_role']}.md"
                        )
                    task["retried_by"] = retry_task["task_id"]
                    task["retry_count"] = retry_task["retry_count"]
                    task["updated_at"] = str(now_iso)
                    for dependent in board.get("tasks", []):
                        dependencies = list(dependent.get("dependencies", []))
                        if task["task_id"] not in dependencies:
                            continue
                        dependent["dependencies"] = [
                            retry_task["task_id"] if dependency == task["task_id"] else dependency
                            for dependency in dependencies
                        ]
                        dependent["updated_at"] = str(now_iso)
                    board["tasks"].append(retry_task)
                    resumed_task_ids.append(retry_task["task_id"])
                    retried_task_ids.append(retry_task["task_id"])
                    continue

                if resume_type == "unblock":
                    task["status"] = "queued"
                    task["blocked_reason"] = ""
                    task["updated_at"] = str(now_iso)
                    resumed_task_ids.append(task["task_id"])
                    continue

                task["status"] = "queued"
                task["updated_at"] = str(now_iso)
                resumed_task_ids.append(task["task_id"])

            run_manager.save_task_board(run_id, board)
            first_resumed_id = resumed_task_ids[0]
            first_phase = next(
                (str(task.get("phase", "development")) for task in board.get("tasks", []) if task.get("task_id") == first_resumed_id),
                "development",
            )
            run_manager.update_run(run_id, status="queued", phase=first_phase, current_task_ids=[])
            await self._emit(
                queue,
                run_id,
                "followup_planned",
                {
                    "status": "queued",
                    "phase": first_phase,
                    "channel": "resume",
                    "summary": "Prepared unfinished work for resumption inside the current run.",
                    "task_ids": resumed_task_ids,
                    "retried_task_ids": retried_task_ids,
                    "related_task_ids": intent.related_task_ids,
                },
            )
            await self._execute_run(run_id, user_request, queue)
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"followup-resume: {exc}")
            await self._emit(
                queue,
                run_id,
                "error",
                {
                    "channel": "resume",
                    "error": str(exc),
                    "status": "failed",
                },
            )
        finally:
            if queue is not None:
                await queue.put(None)

    def _extract_constraints(self, texts: list[str]) -> list[str]:
        constraints: list[str] = []
        seen: set[str] = set()
        markers = ("不要", "必须", "需要", "使用", "prefer", "must", "need", "use ", "avoid")
        for text in texts:
            for chunk in re.split(r"[。！？!?\n;；]", str(text or "")):
                normalized = _compact_text(chunk, 160)
                lowered = normalized.lower()
                if not normalized:
                    continue
                if not any(marker in normalized or marker in lowered for marker in markers):
                    continue
                key = lowered.strip()
                if key in seen:
                    continue
                seen.add(key)
                constraints.append(normalized)
        return constraints[:8]

    def _extract_user_clarifications(self, conversation: list[dict[str, Any]], run_id: str) -> list[dict[str, Any]]:
        clarifications: list[dict[str, Any]] = []
        seen: set[str] = set()
        markers = ("不要", "必须", "需要", "优先", "先", "prefer", "must", "need", "should")
        for seq, item in enumerate(conversation, start=1):
            if str(item.get("role", "")) != "user":
                continue
            content = _compact_text(item.get("content", ""), 180)
            lowered = content.lower()
            if not content:
                continue
            if not any(marker in content or marker in lowered for marker in markers):
                continue
            if lowered in seen:
                continue
            seen.add(lowered)
            clarifications.append(
                {
                    "seq": seq,
                    "content": content,
                    "ref": f"backend/workspace/runs/{run_id}/conversation.ndjson:{seq}",
                }
            )
        return clarifications[:8]

    def _conversation_summary_needs_refresh(self, run_id: str, threshold: int = 8) -> bool:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        summary = run_manager.read_conversation_summary(run_id)
        conversation = run_manager.read_conversation(run_id, limit=256)
        covered = int(summary.get("covers_messages_up_to", 0) or 0)
        return not summary or max(0, len(conversation) - covered) > threshold

    def _parse_json_object(self, content: str) -> dict[str, Any]:
        text = str(content or "").strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        return json.loads(text)

    def _generate_conversation_summary_payload(
        self,
        run_id: str,
        *,
        previous_summary: dict[str, Any],
        conversation: list[dict[str, Any]],
        active_view: dict[str, Any],
    ) -> dict[str, Any]:
        model = agent_manager._build_chat_model()
        recent_limit = self._followup_recent_message_limit
        covered = int(previous_summary.get("covers_messages_up_to", 0) or 0)
        cutoff = max(0, len(conversation) - recent_limit)
        start_index = max(0, covered)
        messages_to_summarize = [
            {
                "seq": index,
                "role": item.get("role", ""),
                "content": str(item.get("content", "")),
            }
            for index, item in enumerate(conversation, start=1)
            if start_index < index <= cutoff
        ]
        if not messages_to_summarize and previous_summary:
            return previous_summary

        response = model.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "You are a factual summarizer for a multi-agent coding run. "
                        "Output strict JSON only. "
                        "Do not infer missing facts. "
                        "Keep only these fields: user_goal, constraints, key_decisions, "
                        "archived_completed_work, user_clarifications."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "run_id": run_id,
                            "previous_summary": previous_summary or {},
                            "task_board_active_view": active_view,
                            "messages_to_summarize": messages_to_summarize,
                        },
                        ensure_ascii=False,
                    ),
                },
            ]
        )
        payload = self._parse_json_object(_stringify_content(getattr(response, "content", "")))
        return {
            "covers_messages_up_to": cutoff,
            "user_goal": str(payload.get("user_goal", previous_summary.get("user_goal", ""))),
            "constraints": list(payload.get("constraints", previous_summary.get("constraints", [])) or [])[:8],
            "key_decisions": list(payload.get("key_decisions", previous_summary.get("key_decisions", [])) or [])[:8],
            "archived_completed_work": list(
                payload.get("archived_completed_work", previous_summary.get("archived_completed_work", [])) or []
            )[:8],
            "user_clarifications": list(
                payload.get("user_clarifications", previous_summary.get("user_clarifications", [])) or []
            )[:8],
        }

    def _generate_phase_summary_payload(
        self,
        run_id: str,
        *,
        phase: str,
        phase_tasks: list[dict[str, Any]],
        previous_summary: dict[str, Any],
    ) -> dict[str, Any]:
        model = agent_manager._build_chat_model()
        response = model.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "You are a factual phase summarizer for a multi-agent coding run. "
                        "Output strict JSON only. "
                        "Do not infer missing facts. "
                        "Keep only these fields: status, completed_tasks, in_progress_tasks, "
                        "blocked_tasks, failed_tasks, files_changed, phase_decisions."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "run_id": run_id,
                            "phase": phase,
                            "previous_summary": previous_summary or {},
                            "phase_tasks": phase_tasks,
                        },
                        ensure_ascii=False,
                    ),
                },
            ]
        )
        payload = self._parse_json_object(_stringify_content(getattr(response, "content", "")))
        return {
            "phase": phase,
            "status": str(payload.get("status", previous_summary.get("status", "queued"))),
            "completed_tasks": list(payload.get("completed_tasks", []))[:8],
            "in_progress_tasks": list(payload.get("in_progress_tasks", []))[:8],
            "blocked_tasks": list(payload.get("blocked_tasks", []))[:8],
            "failed_tasks": list(payload.get("failed_tasks", []))[:8],
            "files_changed": list(payload.get("files_changed", []))[:12],
            "phase_decisions": list(payload.get("phase_decisions", []))[:8],
        }

    def _task_board_active_view(self, run_id: str, role: str | None = None) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        run = run_manager.load_run(run_id)
        board = run_manager.load_task_board(run_id)
        tasks = list(board.get("tasks", []))
        if role and role not in {"PC", "CA"}:
            filtered = [task for task in tasks if str(task.get("owner_role", "")) == role]
            if filtered:
                tasks = filtered

        active_tasks = [
            {
                "task_id": task.get("task_id", ""),
                "title": task.get("title", ""),
                "owner_role": task.get("owner_role", ""),
                "status": task.get("status", ""),
                "phase": task.get("phase", ""),
                "dependencies": task.get("dependencies", []),
                "blocked_reason": task.get("blocked_reason", "") or task.get("latest_error", ""),
            }
            for task in tasks
            if task.get("status") in {"queued", "assigned", "in_progress", "blocked", "failed"}
        ][:8]
        recent_completed = [
            {
                "task_id": task.get("task_id", ""),
                "title": task.get("title", ""),
                "owner_role": task.get("owner_role", ""),
                "phase": task.get("phase", ""),
                "summary": _compact_text(task.get("latest_summary", "") or "completed", 180),
            }
            for task in tasks
            if task.get("status") == "completed"
        ][-5:]
        return {
            "current_phase": run.get("phase", ""),
            "run_status": run.get("status", ""),
            "active_tasks": active_tasks,
            "recent_completed_tasks": recent_completed,
        }

    def _handoff_context(self, run_id: str, role: str) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        handoff_dir = run_manager.run_root(run_id) / "handoff"
        if role in {"PC", "CA"}:
            items: list[dict[str, str]] = []
            for path in sorted(handoff_dir.glob("*.md")):
                content = _compact_text(path.read_text(encoding="utf-8"), 500)
                if not content or "Pending" in content:
                    continue
                items.append({"role": path.stem, "summary": content})
            return {"scope": "all", "items": items[:6]}

        own_path = handoff_dir / f"{role}.md"
        if not own_path.exists():
            return {"scope": "own", "items": []}
        content = own_path.read_text(encoding="utf-8").strip()
        if not content or "Pending" in content:
            return {"scope": "own", "items": []}
        return {
            "scope": "own",
            "items": [
                {
                    "role": role,
                    "content": content[:4000],
                }
            ],
        }

    def _refresh_conversation_summary(self, run_id: str, agent_id: str) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        try:
            conversation = run_manager.read_conversation(run_id, limit=32)
            payload = self._generate_conversation_summary_payload(
                run_id,
                previous_summary=run_manager.read_conversation_summary(run_id),
                conversation=conversation,
                active_view=self._task_board_active_view(run_id, role="PC"),
            )
            run_manager.write_conversation_summary(run_id, agent_id, payload)
            return payload
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"conversation-summary: {exc}")
            run_manager.append_event(
                run_id,
                "summary_failed",
                {
                    "summary_type": "conversation_summary",
                    "agent_id": agent_id,
                    "error": str(exc),
                },
            )
            fallback = run_manager.read_conversation_summary(run_id)
            if fallback:
                run_manager.append_event(
                    run_id,
                    "summary_fallback_used",
                    {
                        "summary_type": "conversation_summary",
                        "agent_id": agent_id,
                        "summary": "Using the previous conversation summary after a refresh failure.",
                    },
                )
            return fallback

    def _refresh_phase_summary(self, run_id: str, phase: str, agent_id: str) -> dict[str, Any]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        try:
            board = run_manager.load_task_board(run_id)
            phase_tasks = [task for task in board.get("tasks", []) if str(task.get("phase", "")) == phase]
            if not phase_tasks:
                return {}
            payload = self._generate_phase_summary_payload(
                run_id,
                phase=phase,
                phase_tasks=phase_tasks,
                previous_summary=run_manager.read_phase_summary(run_id, phase),
            )
            run_manager.write_phase_summary(run_id, phase, agent_id, payload)
            return payload
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"phase-summary:{phase}: {exc}")
            run_manager.append_event(
                run_id,
                "summary_failed",
                {
                    "summary_type": "phase_summary",
                    "phase": phase,
                    "agent_id": agent_id,
                    "error": str(exc),
                },
            )
            fallback = run_manager.read_phase_summary(run_id, phase)
            if fallback:
                run_manager.append_event(
                    run_id,
                    "summary_fallback_used",
                    {
                        "summary_type": "phase_summary",
                        "phase": phase,
                        "agent_id": agent_id,
                        "summary": "Using the previous phase summary after a refresh failure.",
                    },
                )
            return fallback

    def _bootstrap_summaries(self, run_id: str) -> None:
        writer_agent_id = "agent:pc:bootstrap:0"
        self._refresh_conversation_summary(run_id, writer_agent_id)
        self._refresh_phase_summary(run_id, "startup", writer_agent_id)

    async def _handle_phase_transition(
        self,
        run_id: str,
        previous_phase: str,
        next_phase: str,
        agent_id: str,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> None:
        if previous_phase and previous_phase != next_phase:
            self._refresh_phase_summary(run_id, previous_phase, agent_id)
            self._refresh_conversation_summary(run_id, agent_id)
            await self._emit(
                queue,
                run_id,
                "phase_switched",
                {
                    "agent_id": agent_id,
                    "from": previous_phase,
                    "to": next_phase,
                    "summary": f"Run phase switched from {previous_phase} to {next_phase}.",
                },
            )
        self._refresh_phase_summary(run_id, next_phase, agent_id)

    def _format_structured_context(self, label: str, payload: dict[str, Any]) -> str:
        return f"[{label}]\n" + json.dumps(payload, ensure_ascii=False, indent=2)

    def _followup_context_summary(self, run_id: str, preferred_phase: str | None = None) -> list[dict[str, str]]:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        conversation_summary = run_manager.read_conversation_summary(run_id)
        phase_summary = run_manager.read_phase_summary(run_id, preferred_phase)
        messages: list[dict[str, str]] = []
        if conversation_summary:
            messages.append(
                {
                    "role": "assistant",
                    "content": self._format_structured_context("Conversation summary", conversation_summary),
                }
            )
        if phase_summary:
            messages.append(
                {
                    "role": "assistant",
                    "content": self._format_structured_context("Phase summary", phase_summary),
                }
            )
        messages.append(
            {
                "role": "assistant",
                "content": self._format_structured_context(
                    "Task board active view",
                    self._task_board_active_view(run_id, role="PC"),
                ),
            }
        )
        handoff_context = self._handoff_context(run_id, "PC")
        if handoff_context.get("items"):
            messages.append(
                {
                    "role": "assistant",
                    "content": self._format_structured_context("Handoff context", handoff_context),
                }
            )
        return messages

    def _build_followup_tools(self, run_id: str, agent: dict[str, Any], channel: str) -> list[Any]:
        backend_dir, _host_project_root, run_manager, registry = self._require_runtime()
        role = agent["role"]
        project_root = run_manager.project_root_for_run(run_id)
        run_root = run_manager.run_root(run_id)
        read_only_tools: list[Any] = [
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
            MemoryGetTool(backend_dir=backend_dir),
            MemorySearchTool(
                backend_dir=backend_dir,
                run_manager=run_manager,
                run_id=run_id,
                agent_role=role,
            ),
            SessionsHistoryTool(run_id=run_id, registry=registry),
        ]
        return read_only_tools

    def _build_readonly_followup_prompt(self, run_id: str, agent: dict[str, Any]) -> str:
        backend_dir, _host_project_root, run_manager, _registry = self._require_runtime()
        project_root = run_manager.project_root_for_run(run_id)
        base_prompt = build_system_prompt(backend_dir, runtime_config.get_rag_mode())
        contract = (
            f"\n\n[Run Follow-up Contract]\n"
            f"- You are the PC agent continuing run {run_id}.\n"
            f"- Agent ID: {agent['agent_id']}\n"
            f"- Session key: {agent['session_key']}\n"
            f"- This is the answer channel. Answer the user using the current run state only.\n"
            f"- Do not create tasks. Do not write files. Do not run shell commands. Do not modify the project.\n"
            f"- Base your answer on the current task board, summaries, handoff files, reports, and generated files.\n"
            f"- If the run is incomplete, explain what remains and why. If the run failed or blocked, explain the exact blocker.\n"
            f"- Keep the answer concise, factual, and grounded in the existing run.\n"
            f"- Generated project root: {project_root}\n"
            f"- Run root: {backend_dir / 'workspace' / 'runs' / run_id}\n"
        )
        return base_prompt + contract

    async def _run_followup_response_readonly(
        self,
        run_id: str,
        user_request: str,
        intent: FollowupIntent,
        queue: asyncio.Queue[dict[str, Any] | None],
    ) -> None:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        run = run_manager.load_run(run_id)
        pc_agent = next(item for item in registry.list_agents(run_id) if item["role"] == "PC")
        previous_run_status = str(run.get("status", "completed"))
        previous_run_phase = str(run.get("phase", "done"))
        previous_agent_status = str(pc_agent.get("status", "completed"))
        previous_agent_phase = str(pc_agent.get("current_phase", previous_run_phase))
        previous_agent_progress = int(pc_agent.get("progress", 100) or 100)

        run_manager.update_run(run_id, status="in_progress", phase="conversation")
        registry.set_status(
            run_id,
            pc_agent["agent_id"],
            status="in_progress",
            current_task_id=None,
            current_phase="conversation",
            progress=20,
        )
        await self._emit(
            queue,
            run_id,
            "followup_started",
            {
                "agent_id": pc_agent["agent_id"],
                "role": "PC",
                "status": "in_progress",
                "phase": "conversation",
                "channel": intent.type,
                "summary": "Answering the follow-up inside the current run.",
            },
        )

        run_manager.append_history(
            run_id,
            pc_agent["agent_id"],
            "user",
            user_request,
            metadata={"phase": "conversation", "followup": True, "channel": intent.type},
        )

        async def _answer_once() -> tuple[str, list[dict[str, str]]]:
            model = agent_manager._build_chat_model()
            tools = self._build_followup_tools(run_id, pc_agent, channel="answer")
            langchain_agent = create_agent(
                model=model,
                tools=tools,
                system_prompt=self._build_readonly_followup_prompt(run_id, pc_agent),
            )

            if self._conversation_summary_needs_refresh(run_id, threshold=self._followup_recent_message_limit):
                self._refresh_conversation_summary(run_id, pc_agent["agent_id"])

            conversation = run_manager.read_conversation(run_id, limit=self._followup_recent_message_limit)
            messages: list[dict[str, str]] = []
            for item in conversation[:-1]:
                role = str(item.get("role", ""))
                if role not in {"user", "assistant"}:
                    continue
                messages.append({"role": role, "content": str(item.get("content", ""))})
            messages.extend(self._followup_context_summary(run_id, preferred_phase=previous_run_phase))
            messages.append({"role": "user", "content": user_request})

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
                                "agent_id": pc_agent["agent_id"],
                                "role": "PC",
                                "channel": "answer",
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
                                        "agent_id": pc_agent["agent_id"],
                                        "role": "PC",
                                        "channel": "answer",
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
                                    "agent_id": pc_agent["agent_id"],
                                    "role": "PC",
                                    "channel": "answer",
                                    "tool": pending["tool"],
                                    "output": output,
                                },
                            )

            summary = "".join(final_content_parts).strip() or last_ai_message.strip() or "No follow-up reply was generated."
            return summary, tool_calls

        try:
            summary, tool_calls = await asyncio.wait_for(
                _answer_once(),
                timeout=self._followup_answer_timeout_seconds,
            )
            run_manager.append_history(
                run_id,
                pc_agent["agent_id"],
                "assistant",
                summary,
                tool_calls=tool_calls,
                metadata={"phase": "conversation", "followup": True, "channel": intent.type},
            )
            run_manager.append_conversation_message(
                run_id,
                "assistant",
                summary,
                metadata={"agent_id": pc_agent["agent_id"], "kind": "followup_reply", "channel": intent.type},
            )
            await self._emit(
                queue,
                run_id,
                "assistant_message",
                {
                    "agent_id": pc_agent["agent_id"],
                    "role": "PC",
                    "content": summary,
                    "summary": "PC follow-up reply",
                },
            )
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"followup-answer: {exc}")
            await self._emit(
                queue,
                run_id,
                "error",
                {
                    "agent_id": pc_agent["agent_id"],
                    "role": "PC",
                    "channel": "answer",
                    "error": str(exc),
                    "status": "failed",
                },
            )
        finally:
            run_manager.update_run(run_id, status=previous_run_status, phase=previous_run_phase, current_task_ids=[])
            registry.set_status(
                run_id,
                pc_agent["agent_id"],
                status=previous_agent_status,
                current_task_id=None,
                current_phase=previous_agent_phase,
                progress=previous_agent_progress,
            )
            await queue.put(None)

    def _build_followup_prompt(self, run_id: str, agent: dict[str, Any]) -> str:
        backend_dir, _host_project_root, run_manager, _registry = self._require_runtime()
        project_root = run_manager.project_root_for_run(run_id)
        base_prompt = build_system_prompt(backend_dir, runtime_config.get_rag_mode())
        contract = (
            f"\n\n[Run Follow-up Contract]\n"
            f"- You are the PC agent continuing run {run_id}.\n"
            f"- Agent ID: {agent['agent_id']}\n"
            f"- Session key: {agent['session_key']}\n"
            f"- The user did not ask to create a new run. Continue within the current run context.\n"
            f"- Answer based on the current project state, recent completed work, run documents, and generated files.\n"
            f"- If the user is asking for explanation or clarification, answer directly and do not create a new plan.\n"
            f"- Keep the answer concise, actionable, and grounded in the existing run.\n"
            f"- Generated project root: {project_root}\n"
            f"- Run root: {backend_dir / 'workspace' / 'runs' / run_id}\n"
        )
        return base_prompt + contract

    async def _run_followup_response(
        self,
        run_id: str,
        user_request: str,
        queue: asyncio.Queue[dict[str, Any] | None],
    ) -> None:
        _backend_dir, _project_root, run_manager, registry = self._require_runtime()
        run = run_manager.load_run(run_id)
        pc_agent = next(item for item in registry.list_agents(run_id) if item["role"] == "PC")
        previous_run_status = str(run.get("status", "completed"))
        previous_run_phase = str(run.get("phase", "done"))
        previous_agent_status = str(pc_agent.get("status", "completed"))
        previous_agent_phase = str(pc_agent.get("current_phase", previous_run_phase))
        previous_agent_progress = int(pc_agent.get("progress", 100) or 100)

        run_manager.update_run(run_id, status="in_progress", phase="conversation")
        registry.set_status(
            run_id,
            pc_agent["agent_id"],
            status="in_progress",
            current_task_id=None,
            current_phase="conversation",
            progress=20,
        )
        await self._emit(
            queue,
            run_id,
            "followup_started",
            {
                "agent_id": pc_agent["agent_id"],
                "role": "PC",
                "status": "in_progress",
                "phase": "conversation",
                "summary": "Continuing the current run without creating a new run.",
            },
        )

        run_manager.append_history(
            run_id,
            pc_agent["agent_id"],
            "user",
            user_request,
            metadata={"phase": "conversation", "followup": True},
        )

        try:
            model = agent_manager._build_chat_model()
            tools = self._build_tools_for_agent(run_id, pc_agent)
            langchain_agent = create_agent(
                model=model,
                tools=tools,
                system_prompt=self._build_followup_prompt(run_id, pc_agent),
            )

            if self._conversation_summary_needs_refresh(run_id, threshold=self._followup_recent_message_limit):
                self._refresh_conversation_summary(run_id, pc_agent["agent_id"])

            conversation = run_manager.read_conversation(
                run_id,
                limit=self._followup_recent_message_limit,
            )
            messages: list[dict[str, str]] = []
            for item in conversation[:-1]:
                role = str(item.get("role", ""))
                if role not in {"user", "assistant"}:
                    continue
                messages.append({"role": role, "content": str(item.get("content", ""))})
            messages.extend(self._followup_context_summary(run_id, preferred_phase=previous_run_phase))
            messages.append({"role": "user", "content": user_request})

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
                                "agent_id": pc_agent["agent_id"],
                                "role": "PC",
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
                                        "agent_id": pc_agent["agent_id"],
                                        "role": "PC",
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
                                    "agent_id": pc_agent["agent_id"],
                                    "role": "PC",
                                    "tool": pending["tool"],
                                    "output": output,
                                },
                            )

            summary = "".join(final_content_parts).strip() or last_ai_message.strip() or "No follow-up reply was generated."
            run_manager.append_history(
                run_id,
                pc_agent["agent_id"],
                "assistant",
                summary,
                tool_calls=tool_calls,
                metadata={"phase": "conversation", "followup": True},
            )
            run_manager.append_conversation_message(
                run_id,
                "assistant",
                summary,
                metadata={"agent_id": pc_agent["agent_id"], "kind": "followup_reply"},
            )
            await self._emit(
                queue,
                run_id,
                "assistant_message",
                {
                    "agent_id": pc_agent["agent_id"],
                    "role": "PC",
                    "content": summary,
                    "summary": "PC follow-up reply",
                },
            )
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"followup: {exc}")
            await self._emit(
                queue,
                run_id,
                "error",
                {
                    "agent_id": pc_agent["agent_id"],
                    "role": "PC",
                    "error": str(exc),
                    "status": "failed",
                },
            )
        finally:
            run_manager.update_run(run_id, status=previous_run_status, phase=previous_run_phase, current_task_ids=[])
            registry.set_status(
                run_id,
                pc_agent["agent_id"],
                status=previous_agent_status,
                current_task_id=None,
                current_phase=previous_agent_phase,
                progress=previous_agent_progress,
            )
            await queue.put(None)

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
                    current_run = run_manager.load_run(run_id)
                    previous_phase = str(current_run.get("phase", "startup"))
                    pc_agent = next(item for item in _registry.list_agents(run_id) if item["role"] == "PC")
                    if batch_phase != previous_phase:
                        await self._handle_phase_transition(
                            run_id,
                            previous_phase,
                            batch_phase,
                            pc_agent["agent_id"],
                            queue,
                        )
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
                    await self._finalize_run_memory(run_id, queue)
                    await self._emit(queue, run_id, "task_complete", {"status": "completed"})
                    await self._emit(queue, run_id, "run_complete", {"status": "completed"})
                elif summary.get("failed") or summary.get("blocked"):
                    run_manager.update_run(run_id, status="blocked", current_task_ids=[])
                    await self._finalize_run_memory(run_id, queue)
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
                    await self._finalize_run_memory(run_id, queue)
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
            await self._finalize_run_memory(run_id, queue)
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
            if task.get("status") != "queued":
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
                    task["status"] = "queued"
                    task["blocked_reason"] = ""
                    changed = True
        if changed:
            run_manager.save_task_board(run_id, board)

    async def _append_long_term_memory_context(
        self,
        *,
        run_id: str,
        query: str,
        memory_types: tuple[str, ...],
        messages: list[dict[str, str]],
        queue: asyncio.Queue[dict[str, Any] | None] | None,
        agent_id: str,
        role: str,
        task_id: str | None = None,
    ) -> None:
        backend_dir, _project_root, _run_manager, _registry = self._require_runtime()
        semantic_results = semantic_memory.retrieve(
            query,
            top_k=3,
            role_scope=role,
            memory_types=memory_types,
        )
        results: list[dict[str, Any]] = []
        for item in semantic_results:
            metadata = item.get("metadata", {}) or {}
            source_path = str(metadata.get("source_path", "") or "")
            memory_id = str(metadata.get("memory_id", "") or "")
            memory_type = str(metadata.get("memory_type", "") or "")
            summary = str(item.get("text", "") or "")
            title = memory_id or memory_type or "memory"
            priority = str(metadata.get("priority", "active") or "active")

            if source_path:
                card_path = (backend_dir / source_path).resolve()
                if card_path.exists():
                    try:
                        payload = json.loads(card_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        payload = {}
                    if payload:
                        title = str(payload.get("title", "") or title)
                        summary = str(payload.get("summary", "") or summary)
                        priority = str(payload.get("priority", priority) or priority)

            results.append(
                {
                    "memory_id": memory_id,
                    "memory_type": memory_type,
                    "title": title,
                    "summary": summary,
                    "score": float(item.get("score", 0.0) or 0.0),
                    "priority": priority,
                    "path": source_path,
                }
            )
        if not results:
            return
        await self._emit(
            queue,
            run_id,
            "memory_recalled",
            {
                "agent_id": agent_id,
                "role": role,
                "task_id": task_id,
                "results": [
                    {
                        "memory_id": item.get("memory_id", ""),
                        "memory_type": item.get("memory_type", ""),
                        "title": item.get("title", ""),
                        "path": item.get("path", ""),
                    }
                    for item in results
                ],
                "summary": "Loaded cross-run memory cards.",
            },
        )
        payload = {
            "memory_cards": [
                {
                    "memory_id": item.get("memory_id", ""),
                    "memory_type": item.get("memory_type", ""),
                    "title": item.get("title", ""),
                    "summary": item.get("summary", ""),
                    "priority": item.get("priority", "active"),
                    "path": item.get("path", ""),
                }
                for item in results
            ]
        }
        messages.append(
            {
                "role": "assistant",
                "content": self._format_structured_context("Cross-run memory", payload),
            }
        )

    async def _finalize_run_memory(
        self,
        run_id: str,
        queue: asyncio.Queue[dict[str, Any] | None] | None,
    ) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        try:
            run = run_manager.load_run(run_id)
            board = run_manager.load_task_board(run_id)
            conversation_summary = self._refresh_conversation_summary(run_id, "agent:pc:memory:0")
            phase_summary: dict[str, Any] = {}
            if str(run.get("phase", "")):
                phase_summary = self._refresh_phase_summary(run_id, str(run.get("phase", "")), "agent:pc:memory:0")

            created_cards: list[dict[str, Any]] = []
            created_cards.extend(card_store.update_preferences_from_summary(run_id=run_id, summary=conversation_summary))
            created_cards.append(
                card_store.create_episode(
                    run_id=run_id,
                    run_payload=run,
                    task_board=board,
                    conversation_summary=conversation_summary,
                    phase_summary=phase_summary,
                )
            )
            created_cards.extend(
                card_store.create_failure_fix_cards(
                    run_id=run_id,
                    task_board=board,
                    run_payload=run,
                    conversation_summary=conversation_summary,
                )
            )

            for card in created_cards:
                await self._emit(
                    queue,
                    run_id,
                    "memory_created",
                    {
                        "memory_id": card.get("memory_id", ""),
                        "memory_type": card.get("memory_type", ""),
                        "priority": card.get("priority", "active"),
                        "summary": f"Stored local {card.get('memory_type', '')} card.",
                    },
                )

            synced: list[str] = []
            for card in created_cards:
                memory_type = str(card.get("memory_type", ""))
                if card.get("mem0_synced_at"):
                    continue
                if memory_type == "preference" and int(card.get("occurrence_count", 0) or 0) < 2:
                    continue
                payload = card_store.build_mem0_payload(card)
                result = semantic_memory.store(
                    payload["content"],
                    run_id=run_id,
                    category=str(payload["category"]),
                    metadata=payload["metadata"],
                )
                if not result.get("ok"):
                    continue
                card_store.mark_mem0_synced(memory_type, str(card.get("memory_id", "")))
                synced.append(str(card.get("memory_id", "")))

            if synced:
                await self._emit(
                    queue,
                    run_id,
                    "memories_synced",
                    {
                        "memory_ids": synced,
                        "summary": "Synced long-term memory cards to mem0.",
                    },
                )
        except Exception as exc:
            run_manager.append_log(run_id, "error.log", f"memory-finalize: {exc}")
            await self._emit(
                queue,
                run_id,
                "memory_finalize_failed",
                {
                    "error": str(exc),
                    "summary": "Long-term memory finalization failed; the run output remains intact.",
                },
            )

    def _block_dependents(self, run_id: str, failed_task_id: str, reason: str) -> None:
        _backend_dir, _project_root, run_manager, _registry = self._require_runtime()
        board = run_manager.load_task_board(run_id)
        timestamp = run_manager.load_run(run_id).get("updated_at_iso", "")
        changed = False
        for task in board.get("tasks", []):
            if failed_task_id in task.get("dependencies", []) and task.get("status") == "queued":
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

        history = self.get_agent_history(
            run_id,
            agent["agent_id"],
            limit=self._agent_recent_history_limit,
        )
        messages: list[dict[str, str]] = []
        conversation_summary = run_manager.read_conversation_summary(run_id)
        phase_summary = run_manager.read_phase_summary(run_id, str(task.get("phase", "")))
        if conversation_summary:
            messages.append(
                {
                    "role": "assistant",
                    "content": self._format_structured_context("Conversation summary", conversation_summary),
                }
            )
        if phase_summary:
            messages.append(
                {
                    "role": "assistant",
                    "content": self._format_structured_context("Phase summary", phase_summary),
                }
            )
        messages.append(
            {
                "role": "assistant",
                "content": self._format_structured_context(
                    "Task board active view",
                    self._task_board_active_view(run_id, role=role),
                ),
            }
        )
        handoff_context = self._handoff_context(run_id, role)
        if handoff_context.get("items"):
            messages.append(
                {
                    "role": "assistant",
                    "content": self._format_structured_context("Handoff context", handoff_context),
                }
            )
        retry_context = task.get("retry_context", {})
        if retry_context:
            messages.append(
                {
                    "role": "assistant",
                    "content": self._format_structured_context("Retry context", retry_context),
                }
            )
            previous_result_ref = str(retry_context.get("previous_result_ref", "") or "")
            if previous_result_ref:
                run_root = run_manager.run_root(run_id)
                relative_ref = previous_result_ref.replace(f"backend/workspace/runs/{run_id}/", "")
                retry_ref_path = run_root / relative_ref
                if retry_ref_path.exists():
                    retry_ref_text = retry_ref_path.read_text(encoding="utf-8").strip()
                    if retry_ref_text:
                        messages.append(
                            {
                                "role": "assistant",
                                "content": f"[Previous handoff]\n{retry_ref_text[:4000]}",
                            }
                        )
        memory_types: tuple[str, ...] = ("failure_fix",)
        if role == "PC" and str(task.get("phase", "")) == "startup":
            memory_types = ("preference", "episode", "failure_fix")
        await self._append_long_term_memory_context(
            run_id=run_id,
            query=task.get("description", "") or user_request,
            memory_types=memory_types,
            messages=messages,
            queue=queue,
            agent_id=agent["agent_id"],
            role=role,
            task_id=str(task.get("task_id", "")),
        )
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
        tools: list[Any] = [
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
            MemorySearchTool(
                backend_dir=backend_dir,
                run_manager=run_manager,
                run_id=run_id,
                agent_role=role,
            ),
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
        return tools

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
        retry_line = ""
        if task.get("retry_of"):
            retry_line = (
                f"Retry of: {task.get('retry_of')}\n"
                f"Previous error: {task.get('retry_context', {}).get('previous_error', '')}\n"
            )
        return (
            f"Run ID: {run_id}\n"
            f"Agent role: {agent['role']}\n"
            f"Task ID: {task['task_id']}\n"
            f"Task title: {task['title']}\n"
            f"Task phase: {task['phase']}\n"
            f"{target_line}"
            f"{retry_line}"
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
