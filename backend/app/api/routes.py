from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.models import Mode
from app.state import AppState


class ModeRequest(BaseModel):
    mode: Mode


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

    return router
