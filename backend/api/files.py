from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from config import get_settings
from graph.agent import agent_manager
from graph.memory_indexer import memory_indexer
from tools.skills_scanner import refresh_snapshot, scan_skills

router = APIRouter()

BLOCKED_PARTS = {".git", ".next", "node_modules", "__pycache__"}


class SaveFileRequest(BaseModel):
    path: str = Field(..., min_length=1)
    content: str


def _resolve_path(relative_path: str) -> Path:
    normalized = relative_path.replace("\\", "/").strip("/")
    settings = get_settings()
    candidate = (settings.project_root / normalized).resolve()
    if settings.project_root not in candidate.parents and candidate != settings.project_root:
        raise HTTPException(status_code=400, detail="Path traversal detected")
    if any(part in BLOCKED_PARTS for part in candidate.parts):
        raise HTTPException(status_code=400, detail="Path is blocked")
    return candidate


@router.get("/files")
async def read_file(path: str = Query(..., min_length=1)) -> dict[str, str]:
    file_path = _resolve_path(path)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return {
        "path": path.replace("\\", "/"),
        "content": file_path.read_text(encoding="utf-8"),
    }


@router.post("/files")
async def save_file(payload: SaveFileRequest) -> dict[str, Any]:
    file_path = _resolve_path(payload.path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(payload.content, encoding="utf-8")

    normalized = payload.path.replace("\\", "/")
    if normalized == "backend/memory/MEMORY.md" or normalized == "memory/MEMORY.md":
        memory_indexer.rebuild_index()
    if normalized.startswith("backend/skills/") or normalized.startswith("skills/"):
        refresh_snapshot(get_settings().backend_dir)

    return {"ok": True, "path": normalized}


@router.get("/skills")
async def list_skills() -> list[dict[str, str]]:
    settings = get_settings()
    if agent_manager.base_dir is None:
        raise HTTPException(status_code=503, detail="Agent manager is not initialized")
    skills = [skill.__dict__ for skill in scan_skills(settings.backend_dir)]
    for skill in skills:
        path = str(skill.get("path", ""))
        if path and not path.startswith("backend/"):
            skill["path"] = f"backend/{path}"
    return skills
