from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _utc_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _now() -> float:
    return time.time()


def _sha256_text(content: str) -> str:
    return f"sha256:{hashlib.sha256(content.encode('utf-8')).hexdigest()}"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(path)


def _slugify_request(request: str) -> str:
    tokens = re.findall(r"[a-z0-9]+", request.lower())
    slug = "-".join(tokens[:5]).strip("-")
    return slug[:48] or "project"


@dataclass(frozen=True)
class RunPaths:
    root: Path
    run_json: Path
    agents_json: Path
    task_board_json: Path
    conversation_ndjson: Path
    messages_ndjson: Path
    events_ndjson: Path
    project_config_yaml: Path
    project_plan_md: Path
    architecture_md: Path
    shared_memory_md: Path
    agent_status_json: Path
    error_log: Path
    orchestrator_log: Path
    snapshots_index_json: Path
    handoff_dir: Path
    reviews_dir: Path
    reports_dir: Path
    artifacts_dir: Path
    worktrees_dir: Path
    histories_dir: Path
    logs_dir: Path
    summaries_dir: Path
    summaries_history_dir: Path
    conversation_summary_json: Path
    phase_current_json: Path


class RunManager:
    def __init__(self, backend_dir: Path, project_root: Path) -> None:
        self.backend_dir = backend_dir.resolve()
        self.project_root = project_root.resolve()
        self.app_root = self.project_root / "APP"
        self.runs_dir = self.backend_dir / "workspace" / "runs"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._event_seq: dict[str, int] = {}

    def _read_message_ids(self, run_id: str) -> set[str]:
        path = self._paths(run_id).messages_ndjson
        if not path.exists():
            return set()
        message_ids: set[str] = set()
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            message_id = str(payload.get("messageId", "") or "")
            if message_id:
                message_ids.add(message_id)
        return message_ids

    def initialize(self) -> None:
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.app_root.mkdir(parents=True, exist_ok=True)
        for path in self.runs_dir.glob("run-*"):
            if path.is_dir():
                self._event_seq[path.name] = self._read_last_seq(path / "events.ndjson")

    def _read_last_seq(self, path: Path) -> int:
        if not path.exists():
            return 0
        last_seq = 0
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                last_seq = max(last_seq, int(payload.get("seq", 0) or 0))
        except OSError:
            return 0
        return last_seq

    def _paths(self, run_id: str) -> RunPaths:
        root = self.runs_dir / run_id
        return RunPaths(
            root=root,
            run_json=root / "run.json",
            agents_json=root / "agents.json",
            task_board_json=root / "task-board.json",
            conversation_ndjson=root / "conversation.ndjson",
            messages_ndjson=root / "messages.ndjson",
            events_ndjson=root / "events.ndjson",
            project_config_yaml=root / "project-config.yaml",
            project_plan_md=root / "project-plan.md",
            architecture_md=root / "architecture.md",
            shared_memory_md=root / "shared-memory.md",
            agent_status_json=root / "logs" / "agent-status.json",
            error_log=root / "logs" / "error.log",
            orchestrator_log=root / "logs" / "orchestrator.log",
            snapshots_index_json=root / "snapshots" / "index.json",
            handoff_dir=root / "handoff",
            reviews_dir=root / "reviews",
            reports_dir=root / "reports",
            artifacts_dir=root / "artifacts",
            worktrees_dir=root / "worktrees",
            histories_dir=root / "histories",
            logs_dir=root / "logs",
            summaries_dir=root / "summaries",
            summaries_history_dir=root / "summaries" / "history",
            conversation_summary_json=root / "summaries" / "conversation.json",
            phase_current_json=root / "summaries" / "phase-current.json",
        )

    def _agent_fs_key(self, agent_id: str) -> str:
        return agent_id.replace(":", "-").replace("/", "-").replace("\\", "-")

    def _ensure_tree(self, paths: RunPaths) -> None:
        paths.root.mkdir(parents=True, exist_ok=True)
        for folder in (
            paths.handoff_dir,
            paths.reviews_dir,
            paths.reports_dir,
            paths.artifacts_dir,
            paths.worktrees_dir,
            paths.histories_dir,
            paths.logs_dir,
            paths.summaries_dir,
            paths.summaries_history_dir,
            paths.snapshots_index_json.parent,
        ):
            folder.mkdir(parents=True, exist_ok=True)
        for role in ("PC", "CA", "FD", "BD", "DE", "QT"):
            (paths.handoff_dir / f"{role}.md").touch(exist_ok=True)

    def _project_dir_name(self, run_id: str, user_request: str) -> str:
        slug = _slugify_request(user_request)
        return f"{slug}-{run_id}"

    def project_dir_relative(self, run_id: str) -> str:
        run = self.load_run(run_id)
        stored = str(run.get("project_dir", "") or "").replace("\\", "/").strip("/")
        if stored:
            return stored
        fallback = f"APP/project-{run_id}"
        return fallback

    def project_root_for_run(self, run_id: str) -> Path:
        relative = self.project_dir_relative(run_id)
        target = (self.project_root / relative).resolve()
        target.mkdir(parents=True, exist_ok=True)
        return target

    def _resolve_write_target(self, run_id: str, relative_path: str) -> tuple[str, Path]:
        normalized = relative_path.replace("\\", "/").strip("/")
        run_prefix = f"backend/workspace/runs/{run_id}/"
        project_dir = self.project_dir_relative(run_id)
        project_root = self.project_root_for_run(run_id)

        if normalized.startswith(run_prefix):
            target = (self.project_root / normalized).resolve()
            if self.project_root not in target.parents and target != self.project_root:
                raise ValueError("Path traversal detected.")
            return normalized, target

        if normalized.startswith(project_dir + "/"):
            target = (self.project_root / normalized).resolve()
            if project_root not in target.parents and target != project_root:
                raise ValueError("Path traversal detected.")
            return normalized, target

        target = (project_root / normalized).resolve()
        if project_root not in target.parents and target != project_root:
            raise ValueError("Path traversal detected.")
        storage_path = f"{project_dir}/{normalized}" if normalized else project_dir
        return storage_path, target

    def create_run(
        self,
        *,
        user_request: str,
        session_id: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        paths = self._paths(run_id)
        self._ensure_tree(paths)
        project_dir_name = self._project_dir_name(run_id, user_request)
        project_dir = f"APP/{project_dir_name}"
        project_root = (self.project_root / project_dir).resolve()
        project_root.mkdir(parents=True, exist_ok=True)

        now = _now()
        run_payload = {
            "schema_version": "1.0",
            "run_id": run_id,
            "session_id": session_id,
            "status": "queued",
            "phase": "startup",
            "created_at": now,
            "updated_at": now,
            "created_at_iso": _utc_ts(),
            "updated_at_iso": _utc_ts(),
            "request": user_request,
            "config_version": 1,
            "active_agent_ids": [],
            "current_task_ids": [],
            "project_name": project_dir_name,
            "project_dir": project_dir,
        }
        task_board = {
            "run_id": run_id,
            "schema_version": "1.0",
            "updated_at": _utc_ts(),
            "tasks": [],
        }
        agents = {
            "run_id": run_id,
            "schema_version": "1.0",
            "updated_at": _utc_ts(),
            "agents": [],
        }
        snapshots = {
            "run_id": run_id,
            "schema_version": "1.0",
            "updated_at": _utc_ts(),
            "files": {},
            "snapshots": [],
        }
        project_config = {
            "project": {
                "name": project_dir_name,
                "request": user_request,
                "session_id": session_id or "",
                "project_dir": project_dir,
            },
            "run": {
                "id": run_id,
                "created_at": _utc_ts(),
            },
            "settings": config or {},
        }

        _atomic_write(
            paths.run_json,
            json.dumps(run_payload, ensure_ascii=False, indent=2),
        )
        _atomic_write(
            paths.task_board_json,
            json.dumps(task_board, ensure_ascii=False, indent=2),
        )
        _atomic_write(paths.conversation_ndjson, "")
        _atomic_write(
            paths.agents_json,
            json.dumps(agents, ensure_ascii=False, indent=2),
        )
        _atomic_write(
            paths.snapshots_index_json,
            json.dumps(snapshots, ensure_ascii=False, indent=2),
        )
        _atomic_write(paths.messages_ndjson, "")
        _atomic_write(paths.events_ndjson, "")
        _atomic_write(paths.error_log, "")
        _atomic_write(paths.orchestrator_log, "")
        _atomic_write(
            paths.project_plan_md,
            (
                f"# Project Plan\n\n"
                f"- Run ID: `{run_id}`\n"
                f"- Session ID: `{session_id or 'n/a'}`\n"
                f"- Status: queued\n"
                f"- Project Directory: `{project_dir}`\n"
                f"- Request: {user_request}\n"
            ),
        )
        _atomic_write(
            paths.project_config_yaml,
            self._to_simple_yaml(project_config),
        )
        _atomic_write(
            paths.architecture_md,
            "# Architecture\n\nPending architect output.\n",
        )
        _atomic_write(
            paths.shared_memory_md,
            "# Shared Memory\n\nPending shared notes.\n",
        )
        _atomic_write(
            paths.conversation_summary_json,
            json.dumps(
                {
                    "summary_type": "conversation_summary",
                    "version": 1,
                    "updated_at": _utc_ts(),
                    "covers_messages_up_to": 1,
                    "user_goal": user_request,
                    "constraints": [],
                    "archived_completed_work": [],
                    "key_decisions": [],
                    "user_clarifications": [],
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
        _atomic_write(
            paths.phase_current_json,
            json.dumps(
                {
                    "summary_type": "phase_summary",
                    "phase": "startup",
                    "version": 1,
                    "updated_at": _utc_ts(),
                    "status": "queued",
                    "completed_tasks": [],
                    "in_progress_tasks": [],
                    "blocked_tasks": [],
                    "failed_tasks": [],
                    "files_changed": [],
                    "phase_decisions": [],
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
        _atomic_write(
            paths.agent_status_json,
            json.dumps({"run_id": run_id, "agents": []}, ensure_ascii=False, indent=2),
        )

        self._event_seq[run_id] = 0
        self.append_event(
            run_id,
            "run_created",
            {
                "summary": "Multi-agent run created.",
                "phase": "startup",
                "status": "queued",
                "session_id": session_id,
            },
        )
        return run_payload

    def _to_simple_yaml(self, payload: dict[str, Any], indent: int = 0) -> str:
        lines: list[str] = []
        pad = "  " * indent
        for key, value in payload.items():
            if isinstance(value, dict):
                lines.append(f"{pad}{key}:")
                lines.append(self._to_simple_yaml(value, indent + 1))
            elif isinstance(value, list):
                lines.append(f"{pad}{key}:")
                for item in value:
                    if isinstance(item, dict):
                        lines.append(f"{pad}  -")
                        lines.append(self._to_simple_yaml(item, indent + 2))
                    else:
                        lines.append(f"{pad}  - {item}")
            else:
                lines.append(f"{pad}{key}: {value}")
        return "\n".join(lines) + "\n"

    def load_run(self, run_id: str) -> dict[str, Any]:
        return json.loads(self._paths(run_id).run_json.read_text(encoding="utf-8"))

    def update_run(self, run_id: str, **patch: Any) -> dict[str, Any]:
        paths = self._paths(run_id)
        with self._lock:
            payload = self.load_run(run_id)
            payload.update(patch)
            payload["updated_at"] = _now()
            payload["updated_at_iso"] = _utc_ts()
            _atomic_write(paths.run_json, json.dumps(payload, ensure_ascii=False, indent=2))
            return payload

    def list_runs(self) -> list[dict[str, Any]]:
        runs: list[dict[str, Any]] = []
        for path in sorted(self.runs_dir.glob("run-*/run.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            payload["updated_at"] = float(payload.get("updated_at", 0) or 0)
            runs.append(payload)
        runs.sort(key=lambda item: item.get("updated_at", 0), reverse=True)
        return runs

    def load_agents(self, run_id: str) -> dict[str, Any]:
        return json.loads(self._paths(run_id).agents_json.read_text(encoding="utf-8"))

    def save_agents(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        payload["updated_at"] = _utc_ts()
        _atomic_write(
            self._paths(run_id).agents_json,
            json.dumps(payload, ensure_ascii=False, indent=2),
        )
        _atomic_write(
            self._paths(run_id).agent_status_json,
            json.dumps(payload, ensure_ascii=False, indent=2),
        )
        return payload

    def load_task_board(self, run_id: str) -> dict[str, Any]:
        payload = json.loads(self._paths(run_id).task_board_json.read_text(encoding="utf-8"))
        changed = False
        for task in payload.get("tasks", []):
            if task.get("status") == "pending":
                task["status"] = "queued"
                changed = True
        if changed:
            self.save_task_board(run_id, payload)
        return payload

    def save_task_board(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        payload["updated_at"] = _utc_ts()
        _atomic_write(
            self._paths(run_id).task_board_json,
            json.dumps(payload, ensure_ascii=False, indent=2),
        )
        return payload

    def append_message(self, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(payload)
        normalized.setdefault("schemaVersion", "1.0")
        normalized.setdefault("messageId", f"msg-{uuid.uuid4().hex[:12]}")
        normalized.setdefault("timestamp", _utc_ts())
        normalized.setdefault("delivery", {"status": "pending"})
        with self._lock:
            if normalized["messageId"] in self._read_message_ids(run_id):
                return normalized
            with self._paths(run_id).messages_ndjson.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(normalized, ensure_ascii=False) + "\n")
        return normalized

    def append_conversation_message(
        self,
        run_id: str,
        role: str,
        content: str,
        *,
        metadata: dict[str, Any] | None = None,
        followup_meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "id": f"conv-{uuid.uuid4().hex[:12]}",
            "role": role,
            "content": content,
            "timestamp": _utc_ts(),
            "metadata": metadata or {},
        }
        if followup_meta:
            payload["followup_meta"] = followup_meta
        with self._lock:
            with self._paths(run_id).conversation_ndjson.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return payload

    def read_conversation(self, run_id: str, limit: int = 100) -> list[dict[str, Any]]:
        path = self._paths(run_id).conversation_ndjson
        if not path.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows[-limit:]

    def append_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        with self._lock:
            next_seq = self._event_seq.get(run_id, 0) + 1
            self._event_seq[run_id] = next_seq
            event = {
                "schema_version": "1.0",
                "event_id": f"evt-{uuid.uuid4().hex[:12]}",
                "seq": next_seq,
                "type": event_type,
                "timestamp": _utc_ts(),
                "run_id": run_id,
            }
            event.update(payload)
            with self._paths(run_id).events_ndjson.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        return event

    def read_events(self, run_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for line in self._paths(run_id).events_ndjson.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if int(payload.get("seq", 0) or 0) > after_seq:
                events.append(payload)
        return events

    def append_history(
        self,
        run_id: str,
        agent_id: str,
        role: str,
        content: str,
        *,
        tool_calls: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "id": f"hist-{uuid.uuid4().hex[:12]}",
            "agent_id": agent_id,
            "role": role,
            "content": content,
            "tool_calls": tool_calls or [],
            "timestamp": _utc_ts(),
            "metadata": metadata or {},
        }
        history_path = self._paths(run_id).histories_dir / f"{self._agent_fs_key(agent_id)}.ndjson"
        with self._lock:
            with history_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return payload

    def read_history(self, run_id: str, agent_id: str, limit: int = 100) -> list[dict[str, Any]]:
        history_path = self._paths(run_id).histories_dir / f"{self._agent_fs_key(agent_id)}.ndjson"
        if not history_path.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line in history_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows[-limit:]

    def _read_json_file(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def write_conversation_summary(
        self,
        run_id: str,
        agent_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        paths = self._paths(run_id)
        current = self.read_conversation_summary(run_id)
        previous_version = int(current.get("version", 0) or 0)
        next_version = previous_version + 1 if previous_version else int(payload.get("version", 1) or 1)
        normalized = {
            **payload,
            "summary_type": "conversation_summary",
            "version": next_version,
            "updated_at": _utc_ts(),
        }
        if current:
            history_path = (
                f"backend/workspace/runs/{run_id}/summaries/history/"
                f"conversation-v{previous_version}.json"
            )
            self.write_project_text(
                run_id,
                agent_id,
                history_path,
                json.dumps(current, ensure_ascii=False, indent=2) + "\n",
            )
        entry = self.write_project_text(
            run_id,
            agent_id,
            f"backend/workspace/runs/{run_id}/summaries/conversation.json",
            json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
        )
        self.append_event(
            run_id,
            "summary_updated",
            {
                "agent_id": agent_id,
                "summary_type": "conversation_summary",
                "path": entry["path"],
                "version": entry["version"],
                "snapshot_id": entry["snapshot_id"],
                "summary": "Conversation summary refreshed.",
            },
        )
        return entry

    def read_conversation_summary(self, run_id: str) -> dict[str, Any]:
        return self._read_json_file(self._paths(run_id).conversation_summary_json)

    def read_phase_summary(self, run_id: str, phase: str | None = None) -> dict[str, Any]:
        current = self._read_json_file(self._paths(run_id).phase_current_json)
        if not phase or not current:
            return current
        if str(current.get("phase", "")) == phase:
            return current
        history_dir = self._paths(run_id).summaries_history_dir
        candidates = sorted(history_dir.glob(f"phase-{phase}-v*.json"))
        if not candidates:
            return {}
        return self._read_json_file(candidates[-1])

    def write_phase_summary(
        self,
        run_id: str,
        phase: str,
        agent_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        current = self.read_phase_summary(run_id)
        previous_version = int(current.get("version", 0) or 0)
        next_version = previous_version + 1 if previous_version else int(payload.get("version", 1) or 1)
        normalized = {
            **payload,
            "summary_type": "phase_summary",
            "phase": phase,
            "version": next_version,
            "updated_at": _utc_ts(),
        }
        if current:
            history_path = (
                f"backend/workspace/runs/{run_id}/summaries/history/"
                f"phase-{str(current.get('phase', phase))}-v{previous_version}.json"
            )
            self.write_project_text(
                run_id,
                agent_id,
                history_path,
                json.dumps(current, ensure_ascii=False, indent=2) + "\n",
            )
        entry = self.write_project_text(
            run_id,
            agent_id,
            f"backend/workspace/runs/{run_id}/summaries/phase-current.json",
            json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
        )
        self.append_event(
            run_id,
            "summary_updated",
            {
                "agent_id": agent_id,
                "summary_type": "phase_summary",
                "phase": phase,
                "path": entry["path"],
                "version": entry["version"],
                "snapshot_id": entry["snapshot_id"],
                "summary": f"Phase summary refreshed for {phase}.",
            },
        )
        return entry

    def write_project_text(
        self,
        run_id: str,
        agent_id: str,
        relative_path: str,
        content: str,
        *,
        expected_version: int | None = None,
    ) -> dict[str, Any]:
        storage_path, target = self._resolve_write_target(run_id, relative_path)

        entry: dict[str, Any]
        with self._lock:
            snapshots = json.loads(
                self._paths(run_id).snapshots_index_json.read_text(encoding="utf-8")
            )
            current = snapshots["files"].get(storage_path, {})
            current_version = int(current.get("version", 0) or 0)
            if expected_version is not None and current_version != expected_version:
                raise ValueError(
                    f"Version conflict for {storage_path}: expected {expected_version}, got {current_version}."
                )

            target.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write(target, content)

            next_version = current_version + 1
            snapshot_id = f"snap-{uuid.uuid4().hex[:12]}"
            entry = {
                "path": storage_path,
                "version": next_version,
                "hash": _sha256_text(content),
                "snapshot_id": snapshot_id,
                "generated_by": agent_id,
                "updated_at": _utc_ts(),
            }
            snapshots["files"][storage_path] = entry
            snapshots["snapshots"].append(entry)
            snapshots["updated_at"] = _utc_ts()
            _atomic_write(
                self._paths(run_id).snapshots_index_json,
                json.dumps(snapshots, ensure_ascii=False, indent=2),
            )
        self.append_event(
            run_id,
            "file_write",
            {
                "agent_id": agent_id,
                "path": storage_path,
                "version": entry["version"],
                "snapshot_id": entry["snapshot_id"],
                "hash": entry["hash"],
            },
        )
        return entry

    def get_file_version(self, run_id: str, relative_path: str) -> dict[str, Any] | None:
        normalized, _target = self._resolve_write_target(run_id, relative_path)
        snapshots = json.loads(self._paths(run_id).snapshots_index_json.read_text(encoding="utf-8"))
        return snapshots.get("files", {}).get(normalized)

    def list_run_files(self, run_id: str) -> list[str]:
        root = self._paths(run_id).root
        files: list[str] = []
        for path in root.rglob("*"):
            if path.is_file():
                files.append(str(path.relative_to(self.project_root)).replace("\\", "/"))
        return sorted(files)

    def append_log(self, run_id: str, name: str, content: str) -> None:
        paths = self._paths(run_id)
        log_path = paths.logs_dir / name
        with self._lock:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(content.rstrip() + "\n")

    def run_root(self, run_id: str) -> Path:
        return self._paths(run_id).root

    def delete_run(self, run_id: str) -> bool:
        root = self.run_root(run_id)
        if not root.exists():
            self._event_seq.pop(run_id, None)
            return False
        shutil.rmtree(root, ignore_errors=False)
        self._event_seq.pop(run_id, None)
        return True

    def clear_runs(self) -> int:
        removed = 0
        for path in sorted(self.runs_dir.glob("run-*")):
            if not path.is_dir():
                continue
            shutil.rmtree(path, ignore_errors=False)
            self._event_seq.pop(path.name, None)
            removed += 1
        return removed
