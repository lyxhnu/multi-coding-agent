from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from graph.orchestrator import multi_agent_orchestrator

router = APIRouter()


class CreateRunRequest(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: str | None = None
    stream: bool = True


class ContinueRunRequest(BaseModel):
    message: str = Field(..., min_length=1)
    stream: bool = True


class SpawnAgentRequest(BaseModel):
    run_id: str
    role: str
    parent_agent_id: str | None = None
    label: str | None = None
    depth: int = 0


class SendAgentMessageRequest(BaseModel):
    run_id: str
    from_agent_id: str
    session_key: str
    message: dict[str, Any]


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/runs")
async def create_run(payload: CreateRunRequest):
    try:
        if payload.stream:
            async def event_generator():
                async for event in multi_agent_orchestrator.astream_new_run(
                    user_request=payload.message,
                    session_id=payload.session_id,
                ):
                    event_type = str(event.get("type", "message"))
                    data = {key: value for key, value in event.items() if key != "type"}
                    yield _sse(event_type, data)

            return StreamingResponse(event_generator(), media_type="text/event-stream")

        run = await multi_agent_orchestrator.start_background_run(
            user_request=payload.message,
            session_id=payload.session_id,
        )
        return JSONResponse(run)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/runs/{run_id}/continue")
async def continue_run(run_id: str, payload: ContinueRunRequest):
    if not payload.stream:
        raise HTTPException(status_code=400, detail="Continue run currently requires stream=true.")

    try:
        async def event_generator():
            async for event in multi_agent_orchestrator.astream_followup_run(
                run_id=run_id,
                user_request=payload.message,
            ):
                event_type = str(event.get("type", "message"))
                data = {key: value for key, value in event.items() if key != "type"}
                yield _sse(event_type, data)

        return StreamingResponse(event_generator(), media_type="text/event-stream")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/runs")
async def list_runs() -> list[dict[str, Any]]:
    return multi_agent_orchestrator.list_runs()


@router.delete("/runs")
async def clear_runs() -> dict[str, int | bool]:
    try:
        return await multi_agent_orchestrator.clear_all_runs()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/runs/{run_id}")
async def get_run(run_id: str) -> dict[str, Any]:
    try:
        run = multi_agent_orchestrator.get_run(run_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        **run,
        "agents": multi_agent_orchestrator.registry.list_agents(run_id) if multi_agent_orchestrator.registry else [],
        "tasks": multi_agent_orchestrator.get_tasks(run_id),
    }


@router.get("/runs/{run_id}/events")
async def get_run_events(run_id: str, after_seq: int = Query(default=0, ge=0)) -> dict[str, Any]:
    return {"events": multi_agent_orchestrator.get_events(run_id, after_seq=after_seq)}


@router.get("/runs/{run_id}/tasks")
async def get_run_tasks(run_id: str) -> dict[str, Any]:
    return {"tasks": multi_agent_orchestrator.get_tasks(run_id)}


@router.get("/runs/{run_id}/agents")
async def get_run_agents(run_id: str) -> dict[str, Any]:
    if multi_agent_orchestrator.registry is None:
        raise HTTPException(status_code=503, detail="Orchestrator is not initialized")
    return {"agents": multi_agent_orchestrator.registry.list_agents(run_id)}


@router.get("/runs/{run_id}/files")
async def get_run_files(run_id: str) -> dict[str, Any]:
    return {"files": multi_agent_orchestrator.get_run_files(run_id)}


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str) -> dict[str, Any]:
    return multi_agent_orchestrator.cancel_run(run_id)


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: str) -> dict[str, Any]:
    run = multi_agent_orchestrator.resume_run(run_id)
    await multi_agent_orchestrator.continue_run(run_id)
    return run


@router.post("/agents/spawn")
async def spawn_agent(payload: SpawnAgentRequest) -> dict[str, Any]:
    if multi_agent_orchestrator.registry is None:
        raise HTTPException(status_code=503, detail="Orchestrator is not initialized")
    try:
        return multi_agent_orchestrator.registry.spawn_agent(
            payload.run_id,
            payload.role,
            parent_agent_id=payload.parent_agent_id,
            label=payload.label,
            depth=payload.depth,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/agents/send")
async def send_agent_message(payload: SendAgentMessageRequest) -> dict[str, Any]:
    if multi_agent_orchestrator.registry is None:
        raise HTTPException(status_code=503, detail="Orchestrator is not initialized")
    try:
        return multi_agent_orchestrator.registry.sessions_send(
            payload.run_id,
            from_agent_id=payload.from_agent_id,
            session_key=payload.session_key,
            message=payload.message,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/agents/{run_id}/{agent_id}/history")
async def get_agent_history(run_id: str, agent_id: str, limit: int = Query(default=100, ge=1, le=500)) -> dict[str, Any]:
    return {"messages": multi_agent_orchestrator.get_agent_history(run_id, agent_id, limit=limit)}


@router.get("/agents/{run_id}/{agent_id}/status")
async def get_agent_status(run_id: str, agent_id: str) -> dict[str, Any]:
    try:
        return multi_agent_orchestrator.get_agent_status(run_id, agent_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
