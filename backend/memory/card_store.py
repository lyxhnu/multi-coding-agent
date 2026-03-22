from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Any


def _utc_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _tokens(value: str) -> list[str]:
    return [token for token in re.findall(r"[a-zA-Z0-9\u4e00-\u9fff]+", value.lower()) if len(token) > 1]


def _hash_id(prefix: str, value: str) -> str:
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}-{digest}"


def _joined_text(parts: list[str]) -> str:
    return _normalize_text(" ".join(part for part in parts if _normalize_text(part)))


def _infer_project_kind(text: str) -> str:
    lowered = text.lower()
    if any(token in lowered for token in ("金融", "投资", "finance", "trading", "portfolio")):
        return "financial_agent"
    if any(token in lowered for token in ("rag", "llamaindex", "向量", "检索")):
        return "rag_system"
    if any(token in lowered for token in ("旅游", "travel", "planner", "行程")):
        return "planner"
    if any(token in lowered for token in ("客服", "support", "chatbot", "assistant")):
        return "assistant_system"
    return "general_project"


def _infer_stack(text: str) -> list[str]:
    lowered = text.lower()
    stack: list[str] = []
    candidates = [
        ("python", ("python", "fastapi", "pydantic", "uvicorn")),
        ("fastapi", ("fastapi",)),
        ("react", ("react", "tsx", "next.js", "nextjs", "next")),
        ("typescript", ("typescript", "ts", "tsx")),
        ("langgraph", ("langgraph",)),
        ("langchain", ("langchain",)),
        ("llamaindex", ("llamaindex", "llama-index")),
        ("sqlalchemy", ("sqlalchemy",)),
        ("docker", ("docker",)),
        ("glm-5", ("glm-5", "glm5", "zhipu", "智谱")),
    ]
    for label, keywords in candidates:
        if any(keyword in lowered for keyword in keywords):
            stack.append(label)
    return stack


def _delivery_quality(status: str, blocked_reason: str, completed_work: list[str]) -> str:
    if status == "completed":
        return "complete"
    if status in {"blocked", "failed"}:
        return "partial" if completed_work else "failed"
    if blocked_reason:
        return "partial"
    return "partial" if completed_work else "minimal"


class LocalMemoryCardStore:
    def __init__(self) -> None:
        self.base_dir: Path | None = None
        self.cards_dir: Path | None = None
        self.preferences_dir: Path | None = None
        self.episodes_dir: Path | None = None
        self.failure_fixes_dir: Path | None = None
        self.index_path: Path | None = None
        self._lock = threading.Lock()

    def initialize(self, base_dir: Path) -> None:
        self.base_dir = base_dir.resolve()
        self.cards_dir = self.base_dir / "memory" / "cards"
        self.preferences_dir = self.cards_dir / "preferences"
        self.episodes_dir = self.cards_dir / "episodes"
        self.failure_fixes_dir = self.cards_dir / "failure_fixes"
        self.index_path = self.cards_dir / "index.json"
        for path in (
            self.cards_dir,
            self.preferences_dir,
            self.episodes_dir,
            self.failure_fixes_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
        if not self.index_path.exists():
            self._write_json(self.index_path, {"updated_at": _utc_ts(), "cards": []})
        else:
            self.rebuild_index()

    def _require_paths(self) -> tuple[Path, Path, Path, Path, Path]:
        if (
            self.cards_dir is None
            or self.preferences_dir is None
            or self.episodes_dir is None
            or self.failure_fixes_dir is None
            or self.index_path is None
        ):
            raise RuntimeError("LocalMemoryCardStore is not initialized")
        return (
            self.cards_dir,
            self.preferences_dir,
            self.episodes_dir,
            self.failure_fixes_dir,
            self.index_path,
        )

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _read_json(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _card_dir_for_type(self, memory_type: str) -> Path:
        _cards_dir, preferences_dir, episodes_dir, failure_fixes_dir, _index_path = self._require_paths()
        if memory_type == "preference":
            return preferences_dir
        if memory_type == "episode":
            return episodes_dir
        if memory_type == "failure_fix":
            return failure_fixes_dir
        raise ValueError(f"Unsupported memory type: {memory_type}")

    def _card_path(self, memory_type: str, memory_id: str) -> Path:
        return self._card_dir_for_type(memory_type) / f"{memory_id}.json"

    def _relative_card_path(self, memory_type: str, memory_id: str) -> str:
        path = self._card_path(memory_type, memory_id)
        return str(path.relative_to(self.base_dir)).replace("\\", "/")

    def rebuild_index(self) -> dict[str, Any]:
        _cards_dir, _preferences_dir, _episodes_dir, _failure_fixes_dir, index_path = self._require_paths()
        cards: list[dict[str, Any]] = []
        for path in sorted(self.cards_dir.rglob("*.json")):
            if path == index_path:
                continue
            payload = self._read_json(path)
            if not payload:
                continue
            cards.append(
                {
                    "memory_id": payload.get("memory_id", ""),
                    "memory_type": payload.get("memory_type", ""),
                    "title": payload.get("title", ""),
                    "summary": payload.get("summary", ""),
                    "priority": payload.get("priority", "active"),
                    "source_runs": payload.get("source_runs", []),
                    "path": str(path.relative_to(self.base_dir)).replace("\\", "/"),
                    "updated_at": payload.get("updated_at", ""),
                }
            )
        index_payload = {"updated_at": _utc_ts(), "cards": cards}
        self._write_json(index_path, index_payload)
        return index_payload

    def update_preferences_from_summary(
        self,
        *,
        run_id: str,
        summary: dict[str, Any],
    ) -> list[dict[str, Any]]:
        candidates = [
            _normalize_text(item)
            for item in summary.get("constraints", []) or []
            if _normalize_text(item)
        ]
        if not candidates:
            return []

        updated_cards: list[dict[str, Any]] = []
        with self._lock:
            for candidate in candidates:
                memory_id = _hash_id("pref", candidate.lower())
                path = self._card_path("preference", memory_id)
                existing = self._read_json(path)
                occurrence_count = int(existing.get("occurrence_count", 0) or 0) + 1
                source_runs = list(dict.fromkeys([*existing.get("source_runs", []), run_id]))
                payload = {
                    "schema_version": "1.0",
                    "memory_id": memory_id,
                    "memory_type": "preference",
                    "title": candidate,
                    "summary": candidate,
                    "normalized_key": candidate.lower(),
                    "keywords": _tokens(candidate),
                    "source_runs": source_runs,
                    "occurrence_count": occurrence_count,
                    "priority": "active" if occurrence_count >= 2 else "low_priority",
                    "updated_at": _utc_ts(),
                    "mem0_synced_at": existing.get("mem0_synced_at"),
                }
                self._write_json(path, payload)
                updated_cards.append(payload)
            self.rebuild_index()
        return updated_cards

    def create_episode(
        self,
        *,
        run_id: str,
        run_payload: dict[str, Any],
        task_board: dict[str, Any],
        conversation_summary: dict[str, Any],
        phase_summary: dict[str, Any],
    ) -> dict[str, Any]:
        memory_id = f"episode-{run_id}"
        path = self._card_path("episode", memory_id)
        request_text = _normalize_text(str(run_payload.get("request", "")))
        combined_text = _joined_text(
            [
                request_text,
                str(conversation_summary.get("user_goal", "")),
                " ".join(str(item) for item in conversation_summary.get("constraints", []) or []),
                json.dumps(phase_summary or {}, ensure_ascii=False),
            ]
        )
        completed_work = [
            _normalize_text(task.get("latest_summary", "") or task.get("title", ""))
            for task in task_board.get("tasks", [])
            if task.get("status") == "completed"
        ]
        completed_work = [item for item in completed_work if item][:6]
        blocked_reasons = [
            _normalize_text(task.get("blocked_reason", "") or task.get("latest_error", ""))
            for task in task_board.get("tasks", [])
            if task.get("status") in {"blocked", "failed"}
        ]
        blocked_reasons = [item for item in blocked_reasons if item]
        blocked_reason = blocked_reasons[0] if blocked_reasons else ""
        status = str(run_payload.get("status", "") or "")
        summary = request_text or str(conversation_summary.get("user_goal", "") or "")
        if status == "completed":
            summary = f"{summary}。项目已完成并进入交付阶段。"
        elif blocked_reason:
            summary = f"{summary}。当前状态 {status}，主要阻塞原因：{blocked_reason}"
        elif completed_work:
            summary = f"{summary}。当前状态 {status}，已完成部分核心工作。"

        existing = self._read_json(path)
        payload = {
            "schema_version": "1.0",
            "memory_id": memory_id,
            "memory_type": "episode",
            "run_id": run_id,
            "title": request_text[:160] or summary[:160],
            "project_kind": _infer_project_kind(combined_text),
            "stack": _infer_stack(combined_text),
            "status": status,
            "summary": _normalize_text(summary),
            "completed_work": completed_work,
            "block_reason": blocked_reason,
            "delivery_quality": _delivery_quality(status, blocked_reason, completed_work),
            "source_runs": [run_id],
            "priority": "active",
            "updated_at": _utc_ts(),
            "mem0_synced_at": existing.get("mem0_synced_at"),
        }
        with self._lock:
            self._write_json(path, payload)
            self.rebuild_index()
        return payload

    def create_failure_fix_cards(
        self,
        *,
        run_id: str,
        task_board: dict[str, Any],
        run_payload: dict[str, Any],
        conversation_summary: dict[str, Any],
    ) -> list[dict[str, Any]]:
        request_text = _normalize_text(str(run_payload.get("request", "")))
        combined_text = _joined_text(
            [
                request_text,
                str(conversation_summary.get("user_goal", "")),
                " ".join(str(item) for item in conversation_summary.get("constraints", []) or []),
            ]
        )
        project_kind = _infer_project_kind(combined_text)
        stack = _infer_stack(combined_text)
        cards: list[dict[str, Any]] = []
        with self._lock:
            for task in task_board.get("tasks", []):
                if str(task.get("status", "")) != "failed_then_fixed":
                    continue
                task_id = str(task.get("task_id", "") or "")
                if not task_id:
                    continue
                memory_id = f"fix-{run_id}-{task_id}"
                path = self._card_path("failure_fix", memory_id)
                existing = self._read_json(path)
                failure = _normalize_text(task.get("latest_error", "") or task.get("blocked_reason", ""))
                fix = _normalize_text(task.get("latest_summary", "") or "")
                verification = fix or "Task was recovered successfully after a previous failure."
                payload = {
                    "schema_version": "1.0",
                    "memory_id": memory_id,
                    "memory_type": "failure_fix",
                    "run_id": run_id,
                    "task_id": task_id,
                    "title": _normalize_text(task.get("title", "") or f"Fix for {task_id}")[:160],
                    "project_kind": project_kind,
                    "stack": stack,
                    "category": f"{str(task.get('owner_role', '')).lower()}_recovery".strip("_") or "general_recovery",
                    "symptom": failure or "Task failed and required recovery work.",
                    "fix": fix or "Recovered successfully after retry.",
                    "verification": verification,
                    "source_runs": [run_id],
                    "priority": "active",
                    "updated_at": _utc_ts(),
                    "mem0_synced_at": existing.get("mem0_synced_at"),
                }
                self._write_json(path, payload)
                cards.append(payload)
            if cards:
                self.rebuild_index()
        return cards

    def mark_mem0_synced(self, memory_type: str, memory_id: str) -> None:
        path = self._card_path(memory_type, memory_id)
        payload = self._read_json(path)
        if not payload:
            return
        payload["mem0_synced_at"] = _utc_ts()
        with self._lock:
            self._write_json(path, payload)
            self.rebuild_index()

    def all_cards(self, memory_types: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        _cards_dir, _preferences_dir, _episodes_dir, _failure_fixes_dir, _index_path = self._require_paths()
        records: list[dict[str, Any]] = []
        for memory_type in ("preference", "episode", "failure_fix"):
            if memory_types and memory_type not in memory_types:
                continue
            for path in sorted(self._card_dir_for_type(memory_type).glob("*.json")):
                payload = self._read_json(path)
                if payload:
                    records.append(payload)
        return records

    def search(
        self,
        query: str,
        *,
        memory_types: tuple[str, ...] | None = None,
        top_k: int = 3,
    ) -> list[dict[str, Any]]:
        search_tokens = _tokens(query)
        if not search_tokens:
            return []

        candidates: list[dict[str, Any]] = []
        for card in self.all_cards(memory_types):
            haystack = " ".join(
                [
                    str(card.get("title", "")),
                    str(card.get("summary", "")),
                    str(card.get("project_kind", "")),
                    " ".join(str(item) for item in card.get("stack", []) or []),
                    str(card.get("block_reason", "")),
                    str(card.get("symptom", "")),
                    str(card.get("fix", "")),
                ]
            ).lower()
            score = sum(haystack.count(token) for token in search_tokens)
            if score <= 0:
                continue
            priority = str(card.get("priority", "active"))
            adjusted_score = float(score) if priority == "active" else float(score) * 0.5
            candidates.append(
                {
                    "memory_id": card.get("memory_id", ""),
                    "memory_type": card.get("memory_type", ""),
                    "title": card.get("title", ""),
                    "summary": card.get("summary", ""),
                    "score": adjusted_score,
                    "priority": priority,
                    "path": self._relative_card_path(str(card.get("memory_type", "")), str(card.get("memory_id", ""))),
                    "payload": card,
                }
            )
        candidates.sort(key=lambda item: item.get("score", 0.0), reverse=True)
        return candidates[:top_k]

    def build_mem0_payload(self, card: dict[str, Any]) -> dict[str, Any]:
        memory_type = str(card.get("memory_type", ""))
        if memory_type == "preference":
            content = f"User preference: {card.get('summary', '')}"
            category = "preference"
        elif memory_type == "episode":
            completed_work = ", ".join(str(item) for item in card.get("completed_work", [])[:3] if _normalize_text(str(item)))
            block_reason = _normalize_text(str(card.get("block_reason", "") or ""))
            content = (
                f"Project episode: {card.get('title', '')}. "
                f"Status={card.get('status', '')}. "
                f"Summary={card.get('summary', '')}. "
                f"Completed work={completed_work or 'none'}. "
                f"Block reason={block_reason or 'none'}."
            )
            category = "episode"
        else:
            content = (
                f"Failure fix: {card.get('title', '')}. "
                f"Symptom={card.get('symptom', '')}. "
                f"Fix={card.get('fix', '')}. "
                f"Verification={card.get('verification', '')}."
            )
            category = "failure_fix"

        return {
            "content": _normalize_text(content)[:1200],
            "category": category,
            "metadata": {
                "source_path": self._relative_card_path(memory_type, str(card.get("memory_id", ""))),
                "memory_id": card.get("memory_id", ""),
                "memory_type": memory_type,
                "priority": card.get("priority", "active"),
                "source_runs": card.get("source_runs", []),
                "stack": card.get("stack", []),
                "project_kind": card.get("project_kind", ""),
                "status": card.get("status", ""),
            },
        }


card_store = LocalMemoryCardStore()
