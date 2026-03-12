from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from graph.run_manager import RunManager


ROLE_ORDER = ("PC", "CA", "FD", "BD", "DE", "QT")
_UNSET = object()


def _utc_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _fs_key(value: str) -> str:
    return value.replace(":", "-").replace("/", "-").replace("\\", "-")


class AgentRegistry:
    def __init__(self, run_manager: RunManager) -> None:
        self.run_manager = run_manager
        self._lock = threading.Lock()

    def _load_agents(self, run_id: str) -> list[dict[str, Any]]:
        payload = self.run_manager.load_agents(run_id)
        return list(payload.get("agents", []))

    def _save_agents(self, run_id: str, agents: list[dict[str, Any]]) -> list[dict[str, Any]]:
        self.run_manager.save_agents(
            run_id,
            {
                "run_id": run_id,
                "schema_version": "1.0",
                "agents": agents,
            },
        )
        self.run_manager.update_run(
            run_id,
            active_agent_ids=[
                item["agent_id"]
                for item in agents
                if item.get("status") not in {"completed", "failed", "cancelled"}
            ],
        )
        return agents

    def list_agents(self, run_id: str) -> list[dict[str, Any]]:
        return self._load_agents(run_id)

    def get_agent(self, run_id: str, agent_id: str) -> dict[str, Any]:
        for agent in self._load_agents(run_id):
            if agent.get("agent_id") == agent_id:
                return agent
        raise KeyError(f"Unknown agent: {agent_id}")

    def _next_instance(self, run_id: str, role: str) -> int:
        instances = [
            int(item.get("instance", 0) or 0)
            for item in self._load_agents(run_id)
            if item.get("role") == role
        ]
        return max(instances, default=0) + 1

    def spawn_agent(
        self,
        run_id: str,
        role: str,
        *,
        parent_agent_id: str | None = None,
        label: str | None = None,
        depth: int = 0,
    ) -> dict[str, Any]:
        normalized_role = role.upper()
        with self._lock:
            agents = self._load_agents(run_id)
            if depth >= 5:
                raise ValueError("sessions_spawn is not allowed at this depth.")
            if parent_agent_id:
                active_children = sum(
                    1
                    for item in agents
                    if item.get("parent_agent_id") == parent_agent_id
                    and item.get("status") not in {"completed", "failed", "cancelled"}
                )
                if active_children >= 5:
                    raise ValueError("sessions_spawn has reached max active children.")

            instance = self._next_instance(run_id, normalized_role)
            session_suffix = uuid.uuid4().hex[:8]
            agent_id = f"agent:{normalized_role.lower()}:{run_id}:{instance}"
            session_key = f"agent:{normalized_role.lower()}:{run_id}:{session_suffix}"
            agent = {
                "agent_id": agent_id,
                "role": normalized_role,
                "label": label or normalized_role.lower(),
                "session_key": session_key,
                "parent_agent_id": parent_agent_id,
                "status": "idle",
                "depth": depth,
                "instance": instance,
                "current_task_id": None,
                "current_phase": "startup",
                "progress": 0,
                "heartbeat_at": _utc_ts(),
                "created_at": _utc_ts(),
                "updated_at": _utc_ts(),
                "worktree": str(
                    Path("backend")
                    / "workspace"
                    / "runs"
                    / run_id
                    / "worktrees"
                    / _fs_key(agent_id)
                ).replace("\\", "/"),
            }
            (self.run_manager.run_root(run_id) / "worktrees" / _fs_key(agent_id)).mkdir(
                parents=True,
                exist_ok=True,
            )
            agents.append(agent)
            self._save_agents(run_id, agents)
            self.run_manager.append_event(
                run_id,
                "agent_spawned",
                {
                    "agent_id": agent_id,
                    "session_key": session_key,
                    "role": normalized_role,
                    "status": "idle",
                },
            )
            return agent

    def set_status(
        self,
        run_id: str,
        agent_id: str,
        *,
        status: str,
        current_task_id: str | None | object = _UNSET,
        current_phase: str | None | object = _UNSET,
        progress: int | None | object = _UNSET,
    ) -> dict[str, Any]:
        with self._lock:
            agents = self._load_agents(run_id)
            for agent in agents:
                if agent.get("agent_id") != agent_id:
                    continue
                agent["status"] = status
                agent["updated_at"] = _utc_ts()
                agent["heartbeat_at"] = _utc_ts()
                if current_task_id is not _UNSET:
                    agent["current_task_id"] = current_task_id
                if current_phase is not _UNSET:
                    agent["current_phase"] = current_phase
                if progress is not _UNSET:
                    agent["progress"] = max(0, min(100, progress))
                self._save_agents(run_id, agents)
                self.run_manager.append_event(
                    run_id,
                    "agent_status",
                    {
                        "agent_id": agent_id,
                        "role": agent.get("role"),
                        "status": status,
                        "task_id": agent.get("current_task_id"),
                        "phase": agent.get("current_phase"),
                        "progress": agent.get("progress", 0),
                    },
                )
                return agent
        raise KeyError(f"Unknown agent: {agent_id}")

    def heartbeat(self, run_id: str, agent_id: str) -> dict[str, Any]:
        return self.set_status(run_id, agent_id, status=self.get_agent(run_id, agent_id)["status"])

    def find_by_session_key(self, run_id: str, session_key: str) -> dict[str, Any]:
        for agent in self._load_agents(run_id):
            if agent.get("session_key") == session_key:
                return agent
        raise KeyError(f"Unknown session key: {session_key}")

    def sessions_history(self, run_id: str, session_key: str, limit: int = 100) -> list[dict[str, Any]]:
        agent = self.find_by_session_key(run_id, session_key)
        return self.run_manager.read_history(run_id, agent["agent_id"], limit=limit)

    def sessions_send(
        self,
        run_id: str,
        *,
        from_agent_id: str,
        session_key: str,
        message: dict[str, Any] | str,
    ) -> dict[str, Any]:
        target = self.find_by_session_key(run_id, session_key)
        if isinstance(message, str):
            try:
                message_payload = json.loads(message)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid sessions_send payload: {exc}") from exc
        else:
            message_payload = message
        stored = self.run_manager.append_message(run_id, message_payload)
        self.run_manager.append_event(
            run_id,
            "message_sent",
            {
                "agent_id": from_agent_id,
                "target_agent_id": target["agent_id"],
                "session_key": session_key,
                "message_id": stored["messageId"],
                "message_type": stored.get("type"),
                "task_id": stored.get("metadata", {}).get("taskId"),
            },
        )
        self.run_manager.append_history(
            run_id,
            target["agent_id"],
            "assistant",
            str(stored.get("content", {}).get("details", "")),
            metadata={
                "message_id": stored["messageId"],
                "message_type": stored.get("type"),
                "from_agent_id": from_agent_id,
                "to_agent_id": target["agent_id"],
            },
        )
        self.run_manager.append_event(
            run_id,
            "message_acked",
            {
                "agent_id": target["agent_id"],
                "source_agent_id": from_agent_id,
                "session_key": session_key,
                "message_id": stored["messageId"],
                "message_type": stored.get("type"),
                "task_id": stored.get("metadata", {}).get("taskId"),
            },
        )
        return {
            "runId": run_id,
            "status": "sent",
            "messageId": stored["messageId"],
            "targetAgentId": target["agent_id"],
        }

    def base_agents(self, run_id: str) -> list[dict[str, Any]]:
        existing = {agent["role"]: agent for agent in self._load_agents(run_id)}
        created: list[dict[str, Any]] = []
        for role in ROLE_ORDER:
            if role in existing:
                created.append(existing[role])
                continue
            parent = created[0]["agent_id"] if created else None
            depth = 0 if role == "PC" else 1
            created.append(
                self.spawn_agent(
                    run_id,
                    role,
                    parent_agent_id=parent,
                    depth=depth,
                    label=role.lower(),
                )
            )
        return created
