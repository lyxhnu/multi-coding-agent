from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any
from typing import Type

from langchain_core.callbacks.manager import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from graph.run_manager import RunManager
from graph.semantic_memory import semantic_memory


def _keyword_matches(text: str, query: str) -> int:
    tokens = [token.lower() for token in re.findall(r"\w+", query) if len(token) > 1]
    lowered = text.lower()
    return sum(lowered.count(token) for token in tokens)


class MemoryGetInput(BaseModel):
    path: str = Field(
        default="memory/MEMORY.md",
        description="Path relative to backend/ for shared memory or run files under backend/workspace/runs",
    )


class MemorySearchInput(BaseModel):
    query: str = Field(..., description="Search query")
    top_k: int = Field(default=3, ge=1, le=10)


class MemoryStoreInput(BaseModel):
    content: str = Field(..., description="Stable memory to store for future runs.")
    category: str = Field(
        default="validated_fact",
        description="Short category such as architecture_decision, test_findings, or env_fix.",
    )
    verified: bool = Field(
        default=False,
        description="Whether this fact has been validated and is safe to promote into long-term memory.",
    )


class MemoryGetTool(BaseTool):
    name: str = "memory_get"
    description: str = "Read a shared memory file such as memory/MEMORY.md or a run shared-memory.md file."
    args_schema: Type[BaseModel] = MemoryGetInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _backend_dir: Path = PrivateAttr()

    def __init__(self, *, backend_dir: Path, **kwargs) -> None:
        super().__init__(**kwargs)
        self._backend_dir = backend_dir.resolve()

    def _resolve(self, path: str) -> Path:
        normalized = path.replace("\\", "/").strip("/")
        candidate = (self._backend_dir / normalized).resolve()
        if self._backend_dir not in candidate.parents and candidate != self._backend_dir:
            raise ValueError("Path traversal detected.")
        return candidate

    def _run(
        self,
        path: str = "memory/MEMORY.md",
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        try:
            file_path = self._resolve(path)
        except ValueError as exc:
            return f"Memory read failed: {exc}"
        if not file_path.exists() or file_path.is_dir():
            return "Memory read failed: file does not exist."
        return file_path.read_text(encoding="utf-8")[:10000]

    async def _arun(
        self,
        path: str = "memory/MEMORY.md",
        run_manager: AsyncCallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, path, None)


class MemorySearchTool(BaseTool):
    name: str = "memory_search"
    description: str = "Search mem0-backed long-term memory and run-level shared memory documents."
    args_schema: Type[BaseModel] = MemorySearchInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _backend_dir: Path = PrivateAttr()
    _run_manager: RunManager = PrivateAttr()
    _run_id: str = PrivateAttr()
    _agent_role: str | None = PrivateAttr(default=None)

    def __init__(
        self,
        *,
        backend_dir: Path,
        run_manager: RunManager,
        run_id: str,
        agent_role: str | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._backend_dir = backend_dir.resolve()
        self._run_manager = run_manager
        self._run_id = run_id
        self._agent_role = agent_role

    def _run(
        self,
        query: str,
        top_k: int = 3,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        results: list[dict[str, Any]] = []
        results.extend(
            list(
                semantic_memory.retrieve(
                    query,
                    top_k=top_k,
                    role_scope=self._agent_role,
                    memory_types=("preference", "episode", "failure_fix"),
                )
            )
        )
        shared_memory = self._run_manager.run_root(self._run_id) / "shared-memory.md"
        if shared_memory.exists():
            content = shared_memory.read_text(encoding="utf-8")
            score = _keyword_matches(content, query)
            if score > 0:
                results.append(
                    {
                        "text": content[:1200],
                        "score": float(score),
                        "source": str(shared_memory.relative_to(self._backend_dir)).replace("\\", "/"),
                    }
                )
        if not results:
            return "No relevant shared memory found."
        results.sort(key=lambda item: float(item.get("score", 0.0) or 0.0), reverse=True)
        lines = []
        for index, item in enumerate(results[:top_k], start=1):
            lines.append(
                f"[{index}] {item.get('source', 'memory/MEMORY.md')} "
                f"(score={float(item.get('score', 0.0) or 0.0):.3f})\n{item.get('text', '')}"
            )
        return "\n\n".join(lines)[:5000]

    async def _arun(
        self,
        query: str,
        top_k: int = 3,
        run_manager: AsyncCallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, query, top_k, None)


class MemoryStoreTool(BaseTool):
    name: str = "memory_store"
    description: str = (
        "Store a stable, reusable fact into Mem0 long-term memory. "
        "Use only for validated knowledge such as proven environment fixes, architecture decisions, or test conclusions."
    )
    args_schema: Type[BaseModel] = MemoryStoreInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _run_id: str = PrivateAttr()
    _agent_id: str = PrivateAttr()
    _agent_role: str = PrivateAttr()
    _run_manager: RunManager = PrivateAttr()

    def __init__(
        self,
        *,
        run_id: str,
        agent_id: str,
        agent_role: str,
        run_manager: RunManager,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._run_id = run_id
        self._agent_id = agent_id
        self._agent_role = agent_role
        self._run_manager = run_manager

    def _run(
        self,
        content: str,
        category: str = "validated_fact",
        verified: bool = False,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        if not verified:
            return "Memory store skipped: only verified facts should be promoted to long-term memory."
        result = semantic_memory.store(
            content,
            role_scope=self._agent_role,
            run_id=self._run_id,
            category=category,
            metadata={
                "verified": True,
                "writer_agent_id": self._agent_id,
            },
        )
        if not result.get("ok"):
            return f"Memory store failed: {result.get('error', 'unknown error')}"
        self._run_manager.append_event(
            self._run_id,
            "memory_store",
            {
                "agent_id": self._agent_id,
                "summary": f"{self._agent_role} promoted a verified fact into long-term memory.",
                "category": category,
                "memory_ids": result.get("memory_ids", []),
            },
        )
        return (
            f"Stored {result.get('stored_count', 1)} long-term memory item(s) "
            f"for role {self._agent_role} in category {category}."
        )

    async def _arun(
        self,
        content: str,
        category: str = "validated_fact",
        verified: bool = False,
        run_manager: AsyncCallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, content, category, verified, None)
