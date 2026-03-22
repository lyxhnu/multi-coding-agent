from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass
from typing import Any


def _utc_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclass(frozen=True)
class RequestProfile:
    kind: str
    needs_frontend: bool
    needs_backend: bool
    needs_devops: bool = True
    needs_qa: bool = True
    tags: tuple[str, ...] = ()
    focus_notes: tuple[str, ...] = ()


class TaskAllocator:
    def create_initial_board(self, run_id: str, request: str) -> dict[str, Any]:
        profile = self._classify_request(request)
        explicit_paths = self._extract_explicit_paths(request)
        startup = self._task(
            role="PC",
            title="Decompose request and initialize project plan",
            description=(
                "Break down the user request into a concrete multi-agent plan, write the run"
                " plan files, and set acceptance gates."
            ),
            phase="startup",
            priority="high",
            request=request,
            timeout_seconds=600,
        )
        architecture = self._task(
            role="CA",
            title=self._architecture_title(profile),
            description=self._architecture_description(profile),
            phase="design",
            priority="high",
            request=request,
            timeout_seconds=900,
            target_paths=[
                f"backend/workspace/runs/{run_id}/architecture.md",
                f"backend/workspace/runs/{run_id}/shared-memory.md",
            ],
        )
        implementation_tasks = self._implementation_tasks(profile, request, explicit_paths)
        devops = self._task(
            role="DE",
            title=self._devops_title(profile),
            description=self._devops_description(profile),
            phase="testing",
            priority="medium",
            request=request,
            timeout_seconds=1200,
            target_paths=explicit_paths,
        )
        qa = self._task(
            role="QT",
            title=self._qa_title(profile),
            description=self._qa_description(profile),
            phase="testing",
            priority="high",
            request=request,
            timeout_seconds=1200,
            target_paths=explicit_paths,
        )
        delivery = self._task(
            role="PC",
            title="Assemble the final delivery report",
            description=(
                "Summarize implemented work, unresolved issues, and verification results for"
                " the user."
            ),
            phase="delivery",
            priority="high",
            request=request,
            timeout_seconds=900,
            target_paths=explicit_paths,
        )

        architecture["dependencies"] = [startup["task_id"]]

        previous_frontend_task_id: str | None = None
        for task in implementation_tasks:
            if task["owner_role"] == "FD" and previous_frontend_task_id is not None:
                task["dependencies"] = [previous_frontend_task_id]
            else:
                task["dependencies"] = [architecture["task_id"]]

            if task["owner_role"] == "FD":
                previous_frontend_task_id = task["task_id"]

        implementation_dependency_ids = [task["task_id"] for task in implementation_tasks]
        devops["dependencies"] = implementation_dependency_ids or [architecture["task_id"]]
        qa["dependencies"] = [*implementation_dependency_ids, devops["task_id"]]
        delivery["dependencies"] = [qa["task_id"]]

        tasks = [startup, architecture, *implementation_tasks, devops, qa, delivery]

        return {
            "run_id": run_id,
            "schema_version": "1.0",
            "updated_at": _utc_ts(),
            "request_profile": {
                "kind": profile.kind,
                "needs_frontend": profile.needs_frontend,
                "needs_backend": profile.needs_backend,
                "tags": list(profile.tags),
                "focus_notes": list(profile.focus_notes),
            },
            "tasks": tasks,
        }

    def create_followup_tasks(
        self,
        run_id: str,
        request: str,
    ) -> list[dict[str, Any]]:
        return self.create_delta_tasks(run_id, request)

    def create_delta_tasks(
        self,
        run_id: str,
        request: str,
    ) -> list[dict[str, Any]]:
        profile = self._classify_request(request)
        explicit_paths = self._extract_explicit_paths(request)
        tasks = self._implementation_tasks(profile, request, explicit_paths)

        needs_devops = self._looks_like_devops_request(request, explicit_paths)
        if needs_devops or not tasks:
            tasks.append(
                self._task(
                    role="DE",
                    title=self._followup_devops_title(profile),
                    description=self._devops_description(profile),
                    phase="development",
                    priority="high" if needs_devops else "medium",
                    request=request,
                    timeout_seconds=1200,
                    target_paths=explicit_paths,
                )
            )

        qa = self._task(
            role="QT",
            title=self._followup_qa_title(profile),
            description=self._qa_description(profile),
            phase="testing",
            priority="high",
            request=request,
            timeout_seconds=1200,
            target_paths=explicit_paths,
        )
        delivery = self._task(
            role="PC",
            title="Summarize the follow-up delivery result",
            description=(
                "Summarize the incremental work completed for the latest user follow-up,"
                " including what changed, how it was verified, and any residual risks."
            ),
            phase="delivery",
            priority="high",
            request=request,
            timeout_seconds=900,
            target_paths=explicit_paths,
        )

        for task in tasks:
            task["dependencies"] = []
        implementation_dependency_ids = [task["task_id"] for task in tasks]
        qa["dependencies"] = implementation_dependency_ids[:]
        delivery["dependencies"] = [qa["task_id"]]
        return [*tasks, qa, delivery]

    def build_retry_task(self, original_task: dict[str, Any], now_iso: str) -> dict[str, Any]:
        retry_count = int(original_task.get("retry_count", 0) or 0) + 1
        retry_task_id = f"{original_task['task_id']}-retry-{retry_count}"
        return {
            "task_id": retry_task_id,
            "owner_role": original_task.get("owner_role", ""),
            "assigned_to": original_task.get("owner_role", ""),
            "title": original_task.get("title", "Retry unfinished task"),
            "description": original_task.get("description", ""),
            "phase": original_task.get("phase", "development"),
            "priority": "high",
            "status": "queued",
            "progress": 0,
            "request": original_task.get("request", ""),
            "attempts": 0,
            "max_attempts": int(original_task.get("max_attempts", 3) or 3),
            "created_at": now_iso,
            "updated_at": now_iso,
            "timeout_seconds": original_task.get("timeout_seconds"),
            "dependencies": list(original_task.get("dependencies", [])),
            "next_steps": [],
            "verify_command": "",
            "latest_summary": "",
            "latest_error": "",
            "blocked_reason": "",
            "assigned_agent_id": None,
            "target_paths": list(original_task.get("target_paths", [])),
            "acceptance_criteria": list(original_task.get("acceptance_criteria", [])),
            "retry_of": original_task["task_id"],
            "retry_count": retry_count,
            "retry_context": {
                "previous_status": original_task.get("status", ""),
                "previous_error": original_task.get("blocked_reason", "") or original_task.get("latest_error", ""),
                "previous_result_ref": original_task.get("result_ref", ""),
            },
            "created_by": "PC",
        }

    def prioritize_resumable(
        self,
        failed_tasks: list[dict[str, Any]],
        blocked_tasks: list[dict[str, Any]],
        queued_tasks: list[dict[str, Any]],
        task_status_lookup: dict[str, str],
    ) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []

        for task in sorted(failed_tasks, key=self._task_updated_sort_key, reverse=True):
            candidates.append(
                {
                    "task": task,
                    "resume_type": "retry",
                    "priority": 1,
                    "reason": f"failed task: {task.get('blocked_reason', '') or task.get('latest_error', '')}".strip(),
                }
            )

        for task in blocked_tasks:
            dependencies = list(task.get("dependencies", []))
            if all(task_status_lookup.get(dep) == "completed" for dep in dependencies):
                candidates.append(
                    {
                        "task": task,
                        "resume_type": "unblock",
                        "priority": 2,
                        "reason": "blocked task dependencies are satisfied",
                    }
                )

        for task in queued_tasks:
            dependencies = list(task.get("dependencies", []))
            if all(task_status_lookup.get(dep) == "completed" for dep in dependencies):
                candidates.append(
                    {
                        "task": task,
                        "resume_type": "start",
                        "priority": 3,
                        "reason": "queued task dependencies are satisfied",
                    }
                )

        candidates.sort(
            key=lambda item: (
                int(item["priority"]),
                -self._task_updated_sort_key(item["task"]),
            )
        )
        return candidates

    def _looks_like_devops_request(self, request: str, explicit_paths: list[str]) -> bool:
        lowered = request.lower()
        if any(path.startswith("backend/") and path.endswith((".yml", ".yaml", ".json", ".toml", ".env", ".ps1", ".sh")) for path in explicit_paths):
            return True
        devops_terms = (
            "deploy",
            "deployment",
            "docker",
            "compose",
            "build",
            "script",
            "env",
            "environment",
            "ci",
            "cd",
            "pipeline",
            "vercel",
            "nginx",
            "kubernetes",
            "infra",
            "运维",
            "部署",
            "环境",
            "脚本",
            "构建",
        )
        return any(term in lowered or term in request for term in devops_terms)

    def _task_updated_sort_key(self, task: dict[str, Any]) -> float:
        raw = str(task.get("updated_at", "") or "")
        if not raw:
            return 0.0
        try:
            stamp = time.strptime(raw, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            return 0.0
        return time.mktime(stamp)

    def _extract_explicit_paths(self, request: str) -> list[str]:
        matches = re.findall(
            r"(?:frontend|backend|workspace|src|app)[A-Za-z0-9_./\\-]*\.[A-Za-z0-9]+",
            request,
        )
        normalized: list[str] = []
        for match in matches:
            candidate = match.replace("\\", "/").rstrip(".,);:]")
            if candidate not in normalized:
                normalized.append(candidate)
        return normalized

    def _classify_request(self, request: str) -> RequestProfile:
        lowered = request.lower()

        frontend_terms = (
            "frontend",
            "ui",
            "ux",
            "page",
            "route",
            "screen",
            "component",
            "next.js",
            "nextjs",
            "react",
            "canvas",
            "game",
            "gameplay",
            "animation",
            "hud",
        )
        backend_terms = (
            "backend",
            "server",
            "api",
            "fastapi",
            "endpoint",
            "database",
            "db",
            "auth",
            "authentication",
            "queue",
            "worker",
            "websocket",
            "service",
        )
        devops_terms = (
            "deploy",
            "docker",
            "ci",
            "cd",
            "pipeline",
            "vercel",
            "nginx",
            "kubernetes",
            "infra",
            "infrastructure",
        )
        game_terms = (
            "game",
            "gameplay",
            "player",
            "enemy",
            "boss",
            "score",
            "level",
            "wave",
            "canvas",
            "arcade",
            "survival",
        )

        frontend_hits = sum(1 for term in frontend_terms if term in lowered)
        backend_hits = sum(1 for term in backend_terms if term in lowered)
        devops_hits = sum(1 for term in devops_terms if term in lowered)
        game_hits = sum(1 for term in game_terms if term in lowered)

        tags: list[str] = []
        focus_notes: list[str] = []

        if game_hits:
            tags.append("game")
            focus_notes.append(
                "Favor fast, visible gameplay progress early: create the route and a playable loop before polishing."
            )

        if frontend_hits:
            tags.append("frontend")
        if backend_hits:
            tags.append("backend")
        if devops_hits:
            tags.append("deployment")

        if game_hits and backend_hits == 0:
            focus_notes.append(
                "Treat this as a frontend-led implementation unless the request explicitly asks for APIs or storage services."
            )
            return RequestProfile(
                kind="frontend_game",
                needs_frontend=True,
                needs_backend=False,
                tags=tuple(tags),
                focus_notes=tuple(focus_notes),
            )

        if frontend_hits and backend_hits == 0:
            focus_notes.append(
                "Prefer isolated route and UI work; avoid inventing backend scope that the user did not ask for."
            )
            return RequestProfile(
                kind="frontend_only",
                needs_frontend=True,
                needs_backend=False,
                tags=tuple(tags),
                focus_notes=tuple(focus_notes),
            )

        if backend_hits and frontend_hits == 0:
            focus_notes.append(
                "Focus on backend/runtime delivery first; frontend work is unnecessary unless explicitly requested."
            )
            return RequestProfile(
                kind="backend_only",
                needs_frontend=False,
                needs_backend=True,
                tags=tuple(tags),
                focus_notes=tuple(focus_notes),
            )

        if frontend_hits or backend_hits:
            focus_notes.append("Coordinate frontend and backend handoff through concrete contracts.")
            return RequestProfile(
                kind="fullstack",
                needs_frontend=True,
                needs_backend=True,
                tags=tuple(tags),
                focus_notes=tuple(focus_notes),
            )

        focus_notes.append(
            "Assume a repository-wide implementation request that may touch both product surface and runtime."
        )
        return RequestProfile(
            kind="general",
            needs_frontend=True,
            needs_backend=True,
            tags=tuple(tags),
            focus_notes=tuple(focus_notes),
        )

    def _architecture_title(self, profile: RequestProfile) -> str:
        if profile.kind == "frontend_game":
            return "Design the gameplay architecture, route layout, and delivery sequence"
        if profile.kind == "frontend_only":
            return "Design the frontend architecture and implementation contracts"
        if profile.kind == "backend_only":
            return "Design the backend architecture and service contracts"
        return "Design the system architecture and shared contracts"

    def _followup_architecture_title(self, profile: RequestProfile) -> str:
        if profile.kind == "frontend_game":
            return "Plan the gameplay follow-up changes and update implementation order"
        if profile.kind == "frontend_only":
            return "Plan the frontend follow-up changes and update contracts"
        if profile.kind == "backend_only":
            return "Plan the backend follow-up changes and update service contracts"
        return "Plan the follow-up changes and update shared contracts"

    def _architecture_description(self, profile: RequestProfile) -> str:
        focus = " ".join(profile.focus_notes)
        if profile.kind == "frontend_game":
            return (
                "Define the gameplay loop, state model, route/file targets, implementation order,"
                " and concise handoff notes for a playable browser game. "
                f"{focus}".strip()
            )
        if profile.kind == "frontend_only":
            return (
                "Define the route structure, component boundaries, state flow, and implementation order"
                " for the requested frontend feature. "
                f"{focus}".strip()
            )
        if profile.kind == "backend_only":
            return (
                "Define APIs, storage/data contracts, runtime boundaries, and verification points for"
                " the requested backend work. "
                f"{focus}".strip()
            )
        return (
            "Define architectural decisions, shared contracts, handoff points, and implementation order"
            " for the requested work. "
            f"{focus}".strip()
        )

    def _followup_architecture_description(self, profile: RequestProfile) -> str:
        focus = " ".join(profile.focus_notes)
        if profile.kind == "frontend_game":
            return (
                "Interpret the latest follow-up request, update the gameplay architecture or state model"
                " if needed, and leave concise implementation notes for the next coding pass. "
                f"{focus}".strip()
            )
        if profile.kind == "frontend_only":
            return (
                "Interpret the latest follow-up request, update the relevant route or component contracts,"
                " and leave concise implementation notes for the next coding pass. "
                f"{focus}".strip()
            )
        if profile.kind == "backend_only":
            return (
                "Interpret the latest follow-up request, update APIs or runtime contracts if needed,"
                " and leave concise implementation notes for the next coding pass. "
                f"{focus}".strip()
            )
        return (
            "Interpret the latest follow-up request, update shared contracts where needed, and leave"
            " concise implementation notes for the next coding pass. "
            f"{focus}".strip()
        )

    def _implementation_tasks(
        self,
        profile: RequestProfile,
        request: str,
        explicit_paths: list[str],
    ) -> list[dict[str, Any]]:
        tasks: list[dict[str, Any]] = []
        frontend_targets = self._frontend_target_paths(profile, explicit_paths)
        backend_targets = self._backend_target_paths(explicit_paths)

        if profile.needs_backend:
            tasks.append(
                    self._task(
                        role="BD",
                        title=self._backend_title(profile),
                        description=self._backend_description(profile),
                        phase="development",
                        priority="high",
                        request=request,
                        timeout_seconds=1200,
                        target_paths=backend_targets,
                    )
                )

        if profile.needs_frontend and profile.kind == "frontend_game":
            tasks.extend(
                [
                    self._task(
                        role="FD",
                        title="Create the playable game route and core loop",
                        description=(
                            "Create an isolated route for the requested game, wire the page into the"
                            " app without breaking existing screens, and implement a visible playable"
                            " shell with the main loop, rendering surface, and input handling."
                        ),
                        phase="development",
                        priority="high",
                        request=request,
                        timeout_seconds=1200,
                        target_paths=frontend_targets,
                    ),
                    self._task(
                        role="FD",
                        title="Implement gameplay systems, HUD, and polish",
                        description=(
                            "Build the requested mechanics, enemy/spawn systems, scoring, restart flow,"
                            " persistent local state if appropriate, and the UI polish needed to make"
                            " the browser game feel complete."
                        ),
                        phase="development",
                        priority="high",
                        request=request,
                        timeout_seconds=1200,
                        target_paths=frontend_targets,
                    ),
                ]
            )
        elif profile.needs_frontend:
            tasks.append(
                self._task(
                    role="FD",
                    title=self._frontend_title(profile),
                    description=self._frontend_description(profile),
                    phase="development",
                    priority="high",
                    request=request,
                    timeout_seconds=1200,
                    target_paths=frontend_targets,
                )
            )

        return tasks

    def _frontend_target_paths(
        self,
        profile: RequestProfile,
        explicit_paths: list[str],
    ) -> list[str]:
        if not profile.needs_frontend:
            return []

        preferred = [
            path
            for path in explicit_paths
            if path.startswith("frontend/") and path.endswith((".tsx", ".ts", ".jsx", ".js"))
        ]
        if preferred:
            return preferred

        if profile.kind == "frontend_game":
            return ["frontend/src/app/game/page.tsx"]

        return [
            path
            for path in explicit_paths
            if path.startswith("frontend/")
        ]

    def _backend_target_paths(self, explicit_paths: list[str]) -> list[str]:
        return [
            path
            for path in explicit_paths
            if path.startswith("backend/")
        ]

    def _frontend_title(self, profile: RequestProfile) -> str:
        if profile.kind == "frontend_only":
            return "Implement the frontend route and user-facing experience"
        return "Implement frontend/gameplay/UI changes for the request"

    def _frontend_description(self, profile: RequestProfile) -> str:
        focus = " ".join(profile.focus_notes)
        if profile.kind == "frontend_only":
            return (
                "Build the requested route, components, state transitions, and user-facing polish,"
                " keeping the work isolated to the relevant frontend surfaces. "
                f"{focus}".strip()
            )
        return (
            "Build the frontend route, UI, gameplay, interaction model, and user-facing polish"
            " required by the request. "
            f"{focus}".strip()
        )

    def _backend_title(self, profile: RequestProfile) -> str:
        if profile.kind == "backend_only":
            return "Implement backend/runtime delivery for the request"
        return "Implement backend/runtime changes for the request"

    def _backend_description(self, profile: RequestProfile) -> str:
        focus = " ".join(profile.focus_notes)
        return (
            "Build the backend/runtime/server-side pieces required by the request, including new"
            " APIs, logic, persistence, or data flow when needed. "
            f"{focus}".strip()
        )

    def _devops_title(self, profile: RequestProfile) -> str:
        if profile.kind == "frontend_game":
            return "Verify route wiring, build health, and runtime notes for the game"
        if profile.kind == "frontend_only":
            return "Verify frontend wiring and runtime execution notes"
        if profile.kind == "backend_only":
            return "Verify backend runtime commands and environment assumptions"
        return "Prepare verification and runtime execution notes"

    def _followup_devops_title(self, profile: RequestProfile) -> str:
        if profile.kind == "frontend_game":
            return "Verify follow-up gameplay route wiring and runtime notes"
        if profile.kind == "frontend_only":
            return "Verify follow-up frontend wiring and runtime notes"
        if profile.kind == "backend_only":
            return "Verify follow-up backend runtime commands and assumptions"
        return "Prepare verification notes for the follow-up changes"

    def _devops_description(self, profile: RequestProfile) -> str:
        focus = " ".join(profile.focus_notes)
        if profile.kind == "frontend_game":
            return (
                "Confirm the new route is wired correctly, document how to run/build the feature,"
                " and capture any environment assumptions that affect gameplay delivery. "
                f"{focus}".strip()
            )
        if profile.kind == "frontend_only":
            return (
                "Document or wire up the commands, route assumptions, and environment-facing notes"
                " required to build and run the requested frontend work. "
                f"{focus}".strip()
            )
        if profile.kind == "backend_only":
            return (
                "Document runtime commands, environment assumptions, and operational notes for the"
                " delivered backend changes. "
                f"{focus}".strip()
            )
        return (
            "Document or wire up the execution assumptions, commands, and environment-facing notes"
            " required by the request. "
            f"{focus}".strip()
        )

    def _qa_title(self, profile: RequestProfile) -> str:
        if profile.kind == "frontend_game":
            return "Validate the playable browser game and report residual risks"
        if profile.kind == "frontend_only":
            return "Validate the delivered frontend feature"
        if profile.kind == "backend_only":
            return "Validate the delivered backend feature"
        return "Validate the delivered implementation"

    def _followup_qa_title(self, profile: RequestProfile) -> str:
        if profile.kind == "frontend_game":
            return "Validate the follow-up gameplay changes"
        if profile.kind == "frontend_only":
            return "Validate the follow-up frontend changes"
        if profile.kind == "backend_only":
            return "Validate the follow-up backend changes"
        return "Validate the follow-up implementation changes"

    def _qa_description(self, profile: RequestProfile) -> str:
        focus = " ".join(profile.focus_notes)
        if profile.kind == "frontend_game":
            return (
                "Run focused checks on route rendering, core gameplay, restart flow, score/state"
                " behavior, and build health. Capture failures and residual risks in a short report. "
                f"{focus}".strip()
            )
        return (
            "Run focused verification on the delivered feature, capture failures, and produce"
            " a test report with residual risks. "
            f"{focus}".strip()
        )

    def _task(
        self,
        *,
        role: str,
        title: str,
        description: str,
        phase: str,
        priority: str,
        request: str,
        timeout_seconds: int | None = None,
        target_paths: list[str] | None = None,
    ) -> dict[str, Any]:
        task_id = f"task-{uuid.uuid4().hex[:10]}"
        return {
            "task_id": task_id,
            "owner_role": role,
            "title": title,
            "description": description,
            "phase": phase,
            "priority": priority,
            "status": "queued",
            "progress": 0,
            "request": request,
            "attempts": 0,
            "max_attempts": 3,
            "created_at": _utc_ts(),
            "updated_at": _utc_ts(),
            "timeout_seconds": timeout_seconds,
            "dependencies": [],
            "next_steps": [],
            "verify_command": "",
            "latest_summary": "",
            "latest_error": "",
            "blocked_reason": "",
            "assigned_agent_id": None,
            "target_paths": target_paths or [],
        }

    def next_ready_tasks(
        self,
        task_board: dict[str, Any],
        *,
        active_task_ids: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        tasks = task_board.get("tasks", [])
        by_id = {task["task_id"]: task for task in tasks}
        active_task_ids = active_task_ids or set()
        ready: list[dict[str, Any]] = []
        for task in tasks:
            if task.get("task_id") in active_task_ids:
                continue
            if task.get("status") != "queued":
                continue
            dependencies = task.get("dependencies", [])
            if all(by_id.get(dep, {}).get("status") == "completed" for dep in dependencies):
                ready.append(task)
        return ready
