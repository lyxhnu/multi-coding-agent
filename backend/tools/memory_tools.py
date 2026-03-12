from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Type

from langchain_core.callbacks.manager import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from graph.memory_indexer import memory_indexer
from graph.run_manager import RunManager


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
    description: str = "Search long-term memory and run-level shared memory documents."
    args_schema: Type[BaseModel] = MemorySearchInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _backend_dir: Path = PrivateAttr()
    _run_manager: RunManager = PrivateAttr()
    _run_id: str = PrivateAttr()

    def __init__(
        self,
        *,
        backend_dir: Path,
        run_manager: RunManager,
        run_id: str,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._backend_dir = backend_dir.resolve()
        self._run_manager = run_manager
        self._run_id = run_id

    def _run(
        self,
        query: str,
        top_k: int = 3,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        results = list(memory_indexer.retrieve(query, top_k=top_k))
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
