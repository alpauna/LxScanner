"""OBD2Source backed by an ESP32 connected over the /ws/ingest/obd WebSocket.

The firmware streams JSON events up (PidReading / CanFrame / DtcEvent, see
app.models) via `ingest()`, called from the ingest route, and this source
sends small JSON commands back down ({"cmd": "set_mode", "mode": ...} /
{"cmd": "clear_dtc"}) over the same connection. Only one ESP32 is expected
to be connected at a time for v1.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

from fastapi import WebSocket

from app.models import Mode
from app.obd.source import OBD2Source

logger = logging.getLogger(__name__)


class ESP32Source(OBD2Source):
    def __init__(self) -> None:
        self._ws: WebSocket | None = None
        self._queue: asyncio.Queue[dict] = asyncio.Queue()
        self._mode: Mode = "scanner"

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        self._ws = None

    def set_mode(self, mode: Mode) -> None:
        self._mode = mode
        self._send_command({"cmd": "set_mode", "mode": mode})

    def request_dtc_clear(self) -> None:
        self._send_command({"cmd": "clear_dtc"})

    def _send_command(self, command: dict) -> None:
        if self._ws is None:
            logger.warning("No ESP32 connected, dropping command: %s", command)
            return
        asyncio.create_task(self._ws.send_json(command))

    def attach(self, ws: WebSocket) -> None:
        """Called by the ingest route when the ESP32 connects."""
        self._ws = ws
        self._send_command({"cmd": "set_mode", "mode": self._mode})

    def detach(self, ws: WebSocket) -> None:
        if self._ws is ws:
            self._ws = None

    async def ingest(self, event: dict) -> None:
        await self._queue.put(event)

    async def events(self) -> AsyncIterator[dict]:
        while True:
            yield await self._queue.get()
