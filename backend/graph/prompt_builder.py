from __future__ import annotations

from pathlib import Path

from config import get_settings

SYSTEM_COMPONENTS: tuple[tuple[str, str], ...] = (
    ("Skills Snapshot", "SKILLS_SNAPSHOT.md"),
    ("Soul", "workspace/SOUL.md"),
    ("Identity", "workspace/IDENTITY.md"),
    ("User Profile", "workspace/USER.md"),
    ("Agents Guide", "workspace/AGENTS.md"),
    ("Long-term Memory", "memory/MEMORY.md"),
)


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated]"


def _read_component(base_dir: Path, relative_path: str, limit: int) -> str:
    path = base_dir / relative_path
    if not path.exists():
        return f"[missing component: {relative_path}]"
    return _truncate(path.read_text(encoding="utf-8"), limit)


def build_system_prompt(base_dir: Path, rag_mode: bool) -> str:
    settings = get_settings()
    parts: list[str] = []

    for label, relative_path in SYSTEM_COMPONENTS:
        if relative_path == "memory/MEMORY.md":
            parts.append(
                "<!-- Long-term Memory -->\n"
                "长期记忆主要通过 mem0 检索动态注入。"
                "不要把 MEMORY.md 当作默认长期记忆上下文；只有当前检索到的长期记忆才应视为有效。"
            )
            continue

        content = _read_component(base_dir, relative_path, settings.component_char_limit)
        parts.append(f"<!-- {label} -->\n{content}")

    return "\n\n".join(parts)
