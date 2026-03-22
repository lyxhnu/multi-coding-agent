from __future__ import annotations

import inspect
import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from config import get_settings
from graph.memory_indexer import memory_indexer


def _utc_ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _clean_text(value: str) -> str:
    return " ".join(value.split()).strip()


def _sanitize_error_text(value: str) -> str:
    redacted = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "sk-***", value)
    redacted = re.sub(
        r"(Incorrect API key provided:\s*)([^'\s,]+)",
        r"\1[REDACTED]",
        redacted,
        flags=re.IGNORECASE,
    )
    return redacted


def _matches_memory_types(item: dict[str, Any], memory_types: tuple[str, ...] | None) -> bool:
    if not memory_types:
        return True
    metadata = item.get("metadata", {}) or {}
    memory_type = str(metadata.get("memory_type", "") or "").strip()
    return memory_type in memory_types


class SemanticMemoryService:
    def __init__(self) -> None:
        self.base_dir: Path | None = None
        self._lock = threading.Lock()
        self._sync_client: Any | None = None
        self._async_client: Any | None = None
        self._client_error: str | None = None

    def configure(self, base_dir: Path) -> None:
        self.base_dir = base_dir.resolve()
        memory_indexer.configure(self.base_dir)
        if self.base_dir is not None:
            (self.base_dir / "memory").mkdir(parents=True, exist_ok=True)
        self._sync_client = None
        self._async_client = None
        self._client_error = None

    def rebuild_local_index(self) -> None:
        memory_indexer.rebuild_index()

    def is_mem0_ready(self) -> bool:
        return self._ensure_sync_client() is not None

    def mem0_status(self) -> dict[str, Any]:
        client_ready = self._ensure_sync_client() is not None
        return {
            "ready": client_ready,
            "provider": get_settings().mem0_provider,
            "error": self._client_error,
        }

    @property
    def _audit_path(self) -> Path:
        if self.base_dir is None:
            raise RuntimeError("SemanticMemoryService is not configured")
        return self.base_dir / "memory" / "MEM0_AUDIT.ndjson"

    def _build_client_kwargs(self) -> dict[str, Any]:
        settings = get_settings()
        kwargs: dict[str, Any] = {}
        if settings.mem0_api_key:
            kwargs["api_key"] = settings.mem0_api_key
        if settings.mem0_org_id:
            kwargs["org_id"] = settings.mem0_org_id
        if settings.mem0_project_id:
            kwargs["project_id"] = settings.mem0_project_id
        return kwargs

    def _ensure_sync_client(self) -> Any | None:
        settings = get_settings()
        if self._client_error and self._sync_client is None:
            return None
        if self._sync_client is not None:
            return self._sync_client
        with self._lock:
            if self._sync_client is not None:
                return self._sync_client
            try:
                if settings.mem0_provider == "platform":
                    from mem0 import MemoryClient

                    self._sync_client = MemoryClient(**self._build_client_kwargs())
                else:
                    from mem0 import Memory

                    self._sync_client = Memory()
                self._client_error = None
            except Exception as exc:  # pragma: no cover - optional integration path
                self._client_error = _sanitize_error_text(f"{type(exc).__name__}: {exc}")
                self._sync_client = None
        return self._sync_client

    async def _ensure_async_client(self) -> Any | None:
        settings = get_settings()
        if self._client_error and self._async_client is None:
            return None
        if self._async_client is not None:
            return self._async_client
        with self._lock:
            if self._async_client is not None:
                return self._async_client
        try:
            if settings.mem0_provider == "platform":
                from mem0 import AsyncMemoryClient

                client = AsyncMemoryClient(**self._build_client_kwargs())
            else:
                from mem0 import AsyncMemory

                client = AsyncMemory()
            with self._lock:
                self._async_client = client
                self._client_error = None
            return client
        except Exception as exc:  # pragma: no cover - optional integration path
            with self._lock:
                self._client_error = _sanitize_error_text(f"{type(exc).__name__}: {exc}")
                self._async_client = None
            return None

    def _default_user_id(self, user_id: str | None) -> str:
        settings = get_settings()
        return (user_id or settings.mem0_user_id).strip()

    def _role_scope(self, role_scope: str | None) -> str | None:
        value = (role_scope or "").strip().lower()
        return value or None

    def _mem0_scopes(
        self,
        *,
        user_id: str,
        role_scope: str | None,
    ) -> list[dict[str, Any]]:
        scopes: list[dict[str, Any]] = []
        if role_scope:
            scopes.append(
                {
                    "user_id": user_id,
                    "agent_id": role_scope,
                }
            )
        scopes.append(
            {
                "user_id": user_id,
            }
        )
        return scopes

    def _normalize_search_payload(self, payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, dict):
            rows = payload.get("results", [])
        elif isinstance(payload, list):
            rows = payload
        else:
            rows = []
        normalized: list[dict[str, Any]] = []
        for item in rows:
            if not isinstance(item, dict):
                continue
            text = str(item.get("memory") or item.get("text") or "").strip()
            if not text:
                continue
            memory_id = str(item.get("id", "") or "")
            source = f"mem0://memory/{memory_id}" if memory_id else "mem0://memory"
            normalized.append(
                {
                    "text": text,
                    "score": float(item.get("score", 0.0) or 0.0),
                    "source": source,
                    "memory_id": memory_id,
                    "metadata": item.get("metadata", {}) or {},
                }
            )
        return normalized

    def _merge_results(
        self,
        *groups: list[dict[str, Any]],
        top_k: int,
    ) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for group in groups:
            for item in group:
                text_key = _clean_text(str(item.get("text", ""))).lower()
                source_key = str(item.get("source", "")).lower()
                dedupe_key = (text_key, source_key)
                if not text_key or dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                merged.append(item)
        merged.sort(key=lambda row: float(row.get("score", 0.0) or 0.0), reverse=True)
        return merged[:top_k]

    def _search_mem0_sync(
        self,
        query: str,
        *,
        top_k: int,
        user_id: str | None = None,
        role_scope: str | None = None,
    ) -> list[dict[str, Any]]:
        client = self._ensure_sync_client()
        if client is None:
            return []
        settings = get_settings()
        scopes = self._mem0_scopes(
            user_id=self._default_user_id(user_id),
            role_scope=self._role_scope(role_scope),
        )
        aggregated: list[dict[str, Any]] = []
        for scope in scopes:
            try:
                if settings.mem0_provider == "platform":
                    filters = {
                        "user_id": scope["user_id"],
                        "app_id": settings.mem0_app_id,
                    }
                    if scope.get("agent_id"):
                        filters["agent_id"] = scope["agent_id"]
                    payload = client.search(query=query, limit=top_k, filters=filters)
                else:
                    payload = client.search(
                        query=query,
                        user_id=scope["user_id"],
                        agent_id=scope.get("agent_id"),
                        limit=top_k,
                        filters={"app_id": settings.mem0_app_id},
                    )
            except Exception:
                continue
            aggregated.extend(self._normalize_search_payload(payload))
        return self._merge_results(aggregated, top_k=top_k)

    async def _search_mem0_async(
        self,
        query: str,
        *,
        top_k: int,
        user_id: str | None = None,
        role_scope: str | None = None,
    ) -> list[dict[str, Any]]:
        client = await self._ensure_async_client()
        if client is None:
            return []
        settings = get_settings()
        scopes = self._mem0_scopes(
            user_id=self._default_user_id(user_id),
            role_scope=self._role_scope(role_scope),
        )
        aggregated: list[dict[str, Any]] = []
        for scope in scopes:
            try:
                if settings.mem0_provider == "platform":
                    filters = {
                        "user_id": scope["user_id"],
                        "app_id": settings.mem0_app_id,
                    }
                    if scope.get("agent_id"):
                        filters["agent_id"] = scope["agent_id"]
                    payload = await client.search(query=query, limit=top_k, filters=filters)
                else:
                    payload = await client.search(
                        query=query,
                        user_id=scope["user_id"],
                        agent_id=scope.get("agent_id"),
                        limit=top_k,
                        filters={"app_id": settings.mem0_app_id},
                    )
            except Exception:
                continue
            aggregated.extend(self._normalize_search_payload(payload))
        return self._merge_results(aggregated, top_k=top_k)

    def retrieve(
        self,
        query: str,
        *,
        top_k: int = 3,
        user_id: str | None = None,
        role_scope: str | None = None,
        memory_types: tuple[str, ...] | None = None,
    ) -> list[dict[str, Any]]:
        mem0_results = self._search_mem0_sync(
            query,
            top_k=top_k,
            user_id=user_id,
            role_scope=role_scope,
        )
        filtered = [item for item in mem0_results if _matches_memory_types(item, memory_types)]
        return filtered[:top_k]

    async def aretrieve(
        self,
        query: str,
        *,
        top_k: int = 3,
        user_id: str | None = None,
        role_scope: str | None = None,
        memory_types: tuple[str, ...] | None = None,
    ) -> list[dict[str, Any]]:
        mem0_results = await self._search_mem0_async(
            query,
            top_k=top_k,
            user_id=user_id,
            role_scope=role_scope,
        )
        filtered = [item for item in mem0_results if _matches_memory_types(item, memory_types)]
        return filtered[:top_k]

    def _append_audit_entry(self, payload: dict[str, Any]) -> None:
        if self.base_dir is None:
            return
        with self._lock:
            with self._audit_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def close(self) -> None:
        clients = [self._sync_client, self._async_client]
        self._sync_client = None
        self._async_client = None
        for client in clients:
            if client is None:
                continue
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    continue

    async def aclose(self) -> None:
        clients = [self._sync_client, self._async_client]
        self._sync_client = None
        self._async_client = None
        for client in clients:
            if client is None:
                continue
            close = getattr(client, "close", None)
            if not callable(close):
                continue
            try:
                result = close()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                continue

    def _normalize_store_result(self, payload: Any) -> list[str]:
        if isinstance(payload, dict):
            if isinstance(payload.get("results"), list):
                return [str(item.get("id", "")).strip() for item in payload["results"] if isinstance(item, dict)]
            if "id" in payload:
                return [str(payload.get("id", "")).strip()]
        if isinstance(payload, list):
            ids: list[str] = []
            for item in payload:
                if isinstance(item, dict):
                    memory_id = str(item.get("id", "")).strip()
                    if memory_id:
                        ids.append(memory_id)
            return ids
        return []

    def store(
        self,
        content: str,
        *,
        user_id: str | None = None,
        role_scope: str | None = None,
        run_id: str | None = None,
        category: str = "validated_fact",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        client = self._ensure_sync_client()
        if client is None:
            return {
                "ok": False,
                "error": self._client_error or "mem0 is disabled or unavailable.",
            }

        scope = self._role_scope(role_scope)
        settings = get_settings()
        payload_metadata = {
            "app_id": settings.mem0_app_id,
            "category": category,
            "role_scope": scope or "global",
            "run_id": run_id,
        }
        if metadata:
            payload_metadata.update(metadata)

        try:
            if settings.mem0_provider == "platform":
                result = client.add(
                    messages=[{"role": "user", "content": content}],
                    user_id=self._default_user_id(user_id),
                    app_id=settings.mem0_app_id,
                    agent_id=scope,
                    run_id=run_id,
                    metadata=payload_metadata,
                )
            else:
                result = client.add(
                    messages=[{"role": "user", "content": content}],
                    user_id=self._default_user_id(user_id),
                    agent_id=scope,
                    run_id=run_id,
                    metadata=payload_metadata,
                )
        except Exception as exc:
            return {"ok": False, "error": _sanitize_error_text(f"{type(exc).__name__}: {exc}")}

        memory_ids = [memory_id for memory_id in self._normalize_store_result(result) if memory_id]
        audit_entry = {
            "id": f"audit-{uuid.uuid4().hex[:12]}",
            "timestamp": _utc_ts(),
            "provider": settings.mem0_provider,
            "user_id": self._default_user_id(user_id),
            "role_scope": scope or "global",
            "run_id": run_id,
            "category": category,
            "memory_ids": memory_ids,
            "content_preview": content[:500],
            "metadata": payload_metadata,
        }
        self._append_audit_entry(audit_entry)
        return {
            "ok": True,
            "provider": settings.mem0_provider,
            "memory_ids": memory_ids,
            "stored_count": len(memory_ids) or 1,
            "category": category,
            "role_scope": scope or "global",
        }


semantic_memory = SemanticMemoryService()
