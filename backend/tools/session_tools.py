from __future__ import annotations

import asyncio
import json
import uuid
from typing import Type

from langchain_core.callbacks.manager import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from graph.agent_registry import AgentRegistry
from graph.run_manager import RunManager


class SessionSpawnInput(BaseModel):
    task: str = Field(..., description="Task description for the child agent")
    label: str | None = Field(default=None)
    runtime: str = Field(default="subagent")
    agentId: str | None = Field(default=None)
    model: str | None = Field(default=None)
    thinking: str | None = Field(default=None)
    runTimeoutSeconds: int | None = Field(default=None)
    thread: bool | None = Field(default=None)
    mode: str | None = Field(default="session")
    cleanup: str | None = Field(default="keep")
    sandbox: str | None = Field(default="inherit")


class SessionSendInput(BaseModel):
    sessionKey: str | None = Field(default=None)
    label: str | None = Field(default=None)
    agentId: str | None = Field(default=None)
    message: str = Field(..., description="JSON string or plain-text handoff message")
    timeoutSeconds: int | None = Field(default=30)


class SessionsHistoryInput(BaseModel):
    sessionKey: str = Field(..., description="Target session key")
    limit: int = Field(default=20, ge=1, le=200)
    includeTools: bool = Field(default=True)


class SessionsSpawnTool(BaseTool):
    name: str = "sessions_spawn"
    description: str = "Create a real child agent session for the current multi-agent run."
    args_schema: Type[BaseModel] = SessionSpawnInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _run_id: str = PrivateAttr()
    _current_agent_id: str = PrivateAttr()
    _current_role: str = PrivateAttr()
    _registry: AgentRegistry = PrivateAttr()
    _run_manager: RunManager = PrivateAttr()

    def __init__(
        self,
        *,
        run_id: str,
        current_agent_id: str,
        current_role: str,
        registry: AgentRegistry,
        run_manager: RunManager,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._run_id = run_id
        self._current_agent_id = current_agent_id
        self._current_role = current_role
        self._registry = registry
        self._run_manager = run_manager

    def _run(
        self,
        task: str,
        label: str | None = None,
        runtime: str = "subagent",
        agentId: str | None = None,
        model: str | None = None,
        thinking: str | None = None,
        runTimeoutSeconds: int | None = None,
        thread: bool | None = None,
        mode: str | None = "session",
        cleanup: str | None = "keep",
        sandbox: str | None = "inherit",
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        if self._current_role != "PC":
            return json.dumps(
                {
                    "status": "forbidden",
                    "error": "Only the PC agent may spawn new agents by default.",
                },
                ensure_ascii=False,
            )
        target_role = (agentId or label or "subagent").split("-")[0].upper()
        try:
            child = self._registry.spawn_agent(
                self._run_id,
                target_role,
                parent_agent_id=self._current_agent_id,
                depth=self._registry.get_agent(self._run_id, self._current_agent_id).get("depth", 0) + 1,
                label=label or target_role.lower(),
            )
        except Exception as exc:
            self._run_manager.append_event(
                self._run_id,
                "spawn_rejected",
                {
                    "agent_id": self._current_agent_id,
                    "role": self._current_role,
                    "error": str(exc),
                },
            )
            return json.dumps({"status": "forbidden", "error": str(exc)}, ensure_ascii=False)

        message_id = f"msg-{uuid.uuid4().hex[:12]}"
        self._run_manager.append_message(
            self._run_id,
            {
                "schemaVersion": "1.0",
                "messageId": message_id,
                "correlationId": f"corr-{uuid.uuid4().hex[:8]}",
                "replyTo": None,
                "type": "task_assignment",
                "from": self._current_agent_id,
                "to": child["agent_id"],
                "timestamp": child["created_at"],
                "content": {
                    "subject": label or f"Spawned {target_role} agent",
                    "details": task,
                    "attachments": [],
                },
                "metadata": {
                    "runId": self._run_id,
                    "taskId": None,
                    "priority": "medium",
                    "spawned": True,
                },
            },
        )
        self._run_manager.append_history(
            self._run_id,
            child["agent_id"],
            "assistant",
            task,
            metadata={"spawned_by": self._current_agent_id, "message_id": message_id},
        )
        return json.dumps(
            {
                "status": "accepted",
                "childSessionKey": child["session_key"],
                "runId": self._run_id,
                "mode": mode or "session",
                "note": f"Spawned {child['agent_id']}",
            },
            ensure_ascii=False,
        )

    async def _arun(self, **kwargs) -> str:
        return await asyncio.to_thread(self._run, **kwargs)


class SessionsSendTool(BaseTool):
    name: str = "sessions_send"
    description: str = "Send a structured or plain-text message to another agent session."
    args_schema: Type[BaseModel] = SessionSendInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _run_id: str = PrivateAttr()
    _current_agent_id: str = PrivateAttr()
    _registry: AgentRegistry = PrivateAttr()

    def __init__(
        self,
        *,
        run_id: str,
        current_agent_id: str,
        registry: AgentRegistry,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._run_id = run_id
        self._current_agent_id = current_agent_id
        self._registry = registry

    def _normalize_message(self, message: str, session_key: str) -> dict[str, object]:
        try:
            payload = json.loads(message)
            if isinstance(payload, dict) and "type" in payload:
                return payload
        except json.JSONDecodeError:
            pass

        return {
            "schemaVersion": "1.0",
            "messageId": f"msg-{uuid.uuid4().hex[:12]}",
            "correlationId": f"corr-{uuid.uuid4().hex[:8]}",
            "replyTo": None,
            "type": "handoff",
            "from": self._current_agent_id,
            "to": session_key,
            "timestamp": None,
            "content": {
                "subject": "Agent handoff",
                "details": message,
                "attachments": [],
            },
            "metadata": {
                "runId": self._run_id,
                "taskId": None,
                "priority": "medium",
            },
        }

    def _run(
        self,
        sessionKey: str | None = None,
        label: str | None = None,
        agentId: str | None = None,
        message: str = "",
        timeoutSeconds: int | None = 30,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        session_key = sessionKey
        if not session_key and agentId:
            session_key = self._registry.get_agent(self._run_id, agentId)["session_key"]
        if not session_key:
            return json.dumps(
                {"status": "error", "error": "sessions_send requires sessionKey or agentId."},
                ensure_ascii=False,
            )
        payload = self._normalize_message(message, session_key)
        try:
            response = self._registry.sessions_send(
                self._run_id,
                from_agent_id=self._current_agent_id,
                session_key=session_key,
                message=payload,
            )
        except Exception as exc:
            return json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False)
        return json.dumps(response, ensure_ascii=False)

    async def _arun(self, **kwargs) -> str:
        return await asyncio.to_thread(self._run, **kwargs)


class SessionsHistoryTool(BaseTool):
    name: str = "sessions_history"
    description: str = "Read another agent session history for coordination or review."
    args_schema: Type[BaseModel] = SessionsHistoryInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _run_id: str = PrivateAttr()
    _registry: AgentRegistry = PrivateAttr()

    def __init__(self, *, run_id: str, registry: AgentRegistry, **kwargs) -> None:
        super().__init__(**kwargs)
        self._run_id = run_id
        self._registry = registry

    def _run(
        self,
        sessionKey: str,
        limit: int = 20,
        includeTools: bool = True,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        try:
            messages = self._registry.sessions_history(self._run_id, sessionKey, limit=limit)
        except Exception as exc:
            return json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False)
        if not includeTools:
            messages = [
                {key: value for key, value in item.items() if key != "tool_calls"}
                for item in messages
            ]
        return json.dumps({"status": "ok", "messages": messages}, ensure_ascii=False)

    async def _arun(self, **kwargs) -> str:
        return await asyncio.to_thread(self._run, **kwargs)
