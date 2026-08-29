from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.models import Mode
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

    return router
