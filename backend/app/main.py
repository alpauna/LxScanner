from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import register as register_api
from app.config import OBD_SOURCE, SCOPE_SOURCE
from app.hub import Hub
from app.obd.esp32_ws import ESP32Source
from app.obd.mock import MockOBD2Source
from app.obd.source import OBD2Source
from app.scope.capture_store import ScopeCaptureStore
from app.scope.factory import create_scope_driver, pump_scope
from app.session.recorder import SessionRecorder
from app.state import AppState
from app.ws.routes import router as ws_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _pump_obd(state: AppState) -> None:
    await state.obd_source.start()
    async for event in state.obd_source.events():
        await state.hub.publish_live(event)


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub = Hub()
    recorder = SessionRecorder()
    hub.on_live_event = recorder.record_live_event
    capture_store = ScopeCaptureStore()

    obd_source: OBD2Source = ESP32Source() if OBD_SOURCE == "esp32" else MockOBD2Source()
    logger.info("OBD2 source: %s", OBD_SOURCE)

    scope_driver = create_scope_driver(SCOPE_SOURCE)
    await scope_driver.connect()
    logger.info("Scope source: %s", SCOPE_SOURCE)

    state = AppState(
        hub=hub,
        obd_source=obd_source,
        scope_driver=scope_driver,
        recorder=recorder,
        capture_store=capture_store,
        scope_source=SCOPE_SOURCE if SCOPE_SOURCE in ("mock", "hantek", "teensy") else "mock",
    )
    app.state.app_state = state
    app.include_router(register_api(state))

    obd_task = asyncio.create_task(_pump_obd(state))
    state.scope_task = asyncio.create_task(pump_scope(state.hub, state.scope_driver))
    try:
        yield
    finally:
        obd_task.cancel()
        if state.scope_task is not None:
            state.scope_task.cancel()
        await state.obd_source.stop()
        await state.scope_driver.disconnect()


def create_app() -> FastAPI:
    app = FastAPI(title="LxScanner backend", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(ws_router)
    return app


app = create_app()
