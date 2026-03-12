from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Type

from langchain_core.callbacks.manager import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr


class ReadFileInput(BaseModel):
    path: str = Field(..., description="Relative path inside the project root")


class ReadFileTool(BaseTool):
    name: str = "read_file"
    description: str = (
        "Read a local file under the generated project root or the current run workspace. "
        "Use relative paths like frontend/src/app/page.tsx or "
        "backend/workspace/runs/<run_id>/architecture.md."
    )
    args_schema: Type[BaseModel] = ReadFileInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _root_dir: Path = PrivateAttr()
    _extra_roots: tuple[Path, ...] = PrivateAttr(default=())
    _path_aliases: tuple[tuple[str, Path], ...] = PrivateAttr(default=())

    def __init__(
        self,
        root_dir: Path,
        extra_roots: list[Path] | None = None,
        path_aliases: dict[str, Path] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._root_dir = root_dir.resolve()
        self._extra_roots = tuple(path.resolve() for path in (extra_roots or []))
        self._path_aliases = tuple(
            (alias.replace("\\", "/").strip("/"), target.resolve())
            for alias, target in (path_aliases or {}).items()
        )

    def _candidate_for_root(self, root: Path, path: str) -> Path:
        candidate = (root / path).resolve()
        if root not in candidate.parents and candidate != root:
            raise ValueError("Path traversal detected.")
        return candidate

    def _resolve_path(self, path: str) -> Path:
        normalized = path.replace("\\", "/").strip("/")
        for alias, target_root in self._path_aliases:
            if normalized == alias:
                return target_root
            if normalized.startswith(alias + "/"):
                remainder = normalized[len(alias) + 1 :]
                return self._candidate_for_root(target_root, remainder)
        candidates: list[Path] = []
        for root in (self._root_dir, *self._extra_roots):
            try:
                candidate = self._candidate_for_root(root, normalized)
            except ValueError:
                continue
            candidates.append(candidate)
            if candidate.exists():
                return candidate
        if candidates:
            return candidates[0]
        raise ValueError("Path traversal detected.")

    def _run(
        self,
        path: str,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        try:
            file_path = self._resolve_path(path)
        except ValueError as exc:
            return f"Read failed: {exc}"
        if not file_path.exists():
            return "Read failed: file does not exist."
        if file_path.is_dir():
            return "Read failed: path is a directory."
        return file_path.read_text(encoding="utf-8")[:10000]

    async def _arun(
        self,
        path: str,
        run_manager: AsyncCallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, path, None)
