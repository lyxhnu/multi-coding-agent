from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.chat import router as chat_router
from api.compress import router as compress_router
from api.config_api import router as config_router
from api.files import router as files_router
from api.runs import router as runs_router
from api.sessions import router as sessions_router
from api.tokens import router as tokens_router
from config import get_settings
from graph.agent import agent_manager
from graph.orchestrator import multi_agent_orchestrator
from graph.semantic_memory import semantic_memory
from memory.card_store import card_store
from tools.skills_scanner import refresh_snapshot


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    refresh_snapshot(settings.backend_dir)
    agent_manager.initialize(settings.backend_dir)
    semantic_memory.configure(settings.backend_dir)
    semantic_memory.rebuild_local_index()
    card_store.initialize(settings.backend_dir)
    multi_agent_orchestrator.initialize(settings.backend_dir, settings.project_root)
    await multi_agent_orchestrator.recover_incomplete_runs()
    try:
        yield
    finally:
        await semantic_memory.aclose()


app = FastAPI(
    title="multi-coding agent API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_router, prefix="/api", tags=["chat"])
app.include_router(sessions_router, prefix="/api", tags=["sessions"])
app.include_router(files_router, prefix="/api", tags=["files"])
app.include_router(runs_router, prefix="/api", tags=["runs"])
app.include_router(tokens_router, prefix="/api", tags=["tokens"])
app.include_router(compress_router, prefix="/api", tags=["compress"])
app.include_router(config_router, prefix="/api", tags=["config"])


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
