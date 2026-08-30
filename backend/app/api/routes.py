from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.models import Mode, ScopeCaptureCreate, ScopeCaptureMeta
from app.scope.factory import SCOPE_SOURCES, switch_scope_source
from app.state import AppState


class ModeRequest(BaseModel):
    mode: Mode


class ChannelRangeRequest(BaseModel):
    range_v: float


class TimebaseRequest(BaseModel):
    ns_per_div: int


class ScopeSourceRequest(BaseModel):
    source: str


def register(app_state: AppState) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    @router.post("/mode")
    async def set_mode(req: ModeRequest) -> dict:
        app_state.obd_source.set_mode(req.mode)
        app_state.current_mode = req.mode
        return {"mode": req.mode}

    @router.post("/session/start")
    async def start_session() -> dict:
        session_id = app_state.recorder.start_session(app_state.current_mode)
        return {"session_id": session_id}

    @router.post("/session/stop")
    async def stop_session() -> dict:
        app_state.recorder.stop_session()
        return {"status": "stopped"}

    @router.get("/session")
    async def list_sessions() -> list[dict]:
        return app_state.recorder.list_sessions()

    @router.post("/dtc/clear")
    async def clear_dtc() -> dict:
        app_state.obd_source.request_dtc_clear()
        return {"status": "requested"}

    @router.post("/scope/calibrate/{channel}")
    async def calibrate_channel(channel: int) -> dict:
        return await app_state.scope_driver.calibrate_channel(channel)

    @router.post("/scope/channel/{channel}/range")
    async def set_channel_range(channel: int, req: ChannelRangeRequest) -> dict:
        await app_state.scope_driver.set_channel_range(channel, req.range_v)
        return {"channel": channel, "range_v": req.range_v}

    @router.post("/scope/timebase")
    async def set_timebase(req: TimebaseRequest) -> dict:
        await app_state.scope_driver.set_timebase(req.ns_per_div)
        return {"ns_per_div": req.ns_per_div}

    @router.get("/scope/source")
    async def get_scope_source() -> dict:
        return {"active": app_state.scope_source, "available": list(SCOPE_SOURCES)}

    @router.post("/scope/source")
    async def set_scope_source(req: ScopeSourceRequest) -> dict:
        return await switch_scope_source(app_state, req.source)

    # Scope captures: a wholly separate concept from /session/* above --
    # SessionRecorder records small discrete OBD/CAN/DTC events into
    # SQLite, the wrong shape for waveform volume. A capture is built up
    # entirely in the browser (see ScopeView.tsx) and only reaches here
    # as one already-complete payload at Save time -- see
    # app.scope.capture_store's docstring.
    @router.post("/scope/capture", response_model=ScopeCaptureMeta)
    async def save_capture(req: ScopeCaptureCreate) -> dict:
        # Wrapped in to_thread: a synchronous multi-MB gzip+write on the
        # event loop would stall the concurrent OBD/scope WebSocket pumps.
        return await asyncio.to_thread(app_state.capture_store.save, req.model_dump())

    @router.get("/scope/captures", response_model=list[ScopeCaptureMeta])
    async def list_captures() -> list[dict]:
        return app_state.capture_store.list_meta()

    @router.get("/scope/capture/{capture_id}")
    async def get_capture(capture_id: str) -> dict:
        try:
            return await asyncio.to_thread(app_state.capture_store.load_data, capture_id)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="capture not found")

    @router.delete("/scope/capture/{capture_id}")
    async def delete_capture(capture_id: str) -> dict:
        app_state.capture_store.delete(capture_id)
        return {"status": "deleted"}

    return router
