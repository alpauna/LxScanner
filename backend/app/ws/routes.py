from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.obd.esp32_ws import ESP32Source
from app.state import AppState

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/stream/live")
async def stream_live(ws: WebSocket) -> None:
    state: AppState = ws.app.state.app_state
    await ws.accept()
    state.hub.add_live_subscriber(ws)
    try:
        while True:
            # Frontend doesn't send anything on this channel; just keep the
            # connection open until the client disconnects.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        state.hub.remove_live_subscriber(ws)


@router.websocket("/ws/stream/scope")
async def stream_scope(ws: WebSocket) -> None:
    state: AppState = ws.app.state.app_state
    await ws.accept()
    state.hub.add_scope_subscriber(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        state.hub.remove_scope_subscriber(ws)


@router.websocket("/ws/ingest/obd")
async def ingest_obd(ws: WebSocket) -> None:
    """The ESP32 connects here and streams JSON frames matching app.models
    (PidReading / CanFrame / DtcEvent). Events are handed to the active
    OBD2Source, which the main event pump (`_pump_obd`) forwards to the
    hub -- so ingest never touches the hub directly, keeping a single
    code path regardless of which OBD2Source is configured. If the
    active source is an ESP32Source, it's attached to this connection so
    mode-switch/DTC-clear commands can be sent back down.
    """
    state: AppState = ws.app.state.app_state
    await ws.accept()
    source = state.obd_source
    if isinstance(source, ESP32Source):
        source.attach(ws)
        logger.info("ESP32 attached to ingest link")
    try:
        while True:
            message = await ws.receive_json()
            await source.ingest(message)
    except WebSocketDisconnect:
        logger.info("ESP32 ingest connection closed")
    finally:
        if isinstance(source, ESP32Source):
            source.detach(ws)
