from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Type

from langchain_core.callbacks.manager import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr

from graph.run_manager import RunManager


class WriteFileInput(BaseModel):
    path: str = Field(..., description="Relative path inside the project root")
    content: str = Field(..., description="New file content")
    expected_version: int | None = Field(
        default=None,
        description="Expected current version for optimistic concurrency control",
    )


class WriteFileTool(BaseTool):
    name: str = "write_file"
    description: str = (
        "Write a local file under the project root with snapshot tracking and optimistic version "
        "checks. Prefer this over shell redirection for project files."
    )
    args_schema: Type[BaseModel] = WriteFileInput
    model_config = ConfigDict(arbitrary_types_allowed=True)
    _project_root: Path = PrivateAttr()
    _run_manager: RunManager = PrivateAttr()
    _run_id: str = PrivateAttr()
    _agent_id: str = PrivateAttr()

    def __init__(
        self,
        *,
        project_root: Path,
        run_manager: RunManager,
        run_id: str,
        agent_id: str,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._project_root = project_root.resolve()
        self._run_manager = run_manager
        self._run_id = run_id
        self._agent_id = agent_id

    def _run(
        self,
        path: str,
        content: str,
        expected_version: int | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        try:
            snapshot = self._run_manager.write_project_text(
                self._run_id,
                self._agent_id,
                path,
                content,
                expected_version=expected_version,
            )
        except Exception as exc:
            return f"Write failed: {exc}"
        return (
            f"Wrote {path} version={snapshot['version']} "
            f"snapshot_id={snapshot['snapshot_id']} hash={snapshot['hash']}"
        )

    async def _arun(
        self,
        path: str,
        content: str,
        expected_version: int | None = None,
        run_manager: AsyncCallbackManagerForToolRun | None = None,
    ) -> str:
        return await asyncio.to_thread(self._run, path, content, expected_version, None)
