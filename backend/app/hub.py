"""Central asyncio pub/sub hub.

Fans out decoded OBD2/CAN events and scope waveform batches to whichever
frontend WebSocket clients are currently subscribed, and to the session
recorder. Sources (ESP32 ingest, mock generators, the Hantek driver) all
push into the same hub rather than talking to WebSocket clients directly.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class Hub:
    def __init__(self) -> None:
        self._live_subscribers: set[WebSocket] = set()
        self._scope_subscribers: set[WebSocket] = set()
        self.on_live_event = None  # set by the session recorder
        self.on_scope_batch = None

    def add_live_subscriber(self, ws: WebSocket) -> None:
        self._live_subscribers.add(ws)

    def remove_live_subscriber(self, ws: WebSocket) -> None:
        self._live_subscribers.discard(ws)

    def add_scope_subscriber(self, ws: WebSocket) -> None:
        self._scope_subscribers.add(ws)

    def remove_scope_subscriber(self, ws: WebSocket) -> None:
        self._scope_subscribers.discard(ws)

    async def publish_live(self, message: dict) -> None:
        if self.on_live_event is not None:
            self.on_live_event(message)
        await self._broadcast(self._live_subscribers, message)

    async def publish_scope(self, message: dict) -> None:
        if self.on_scope_batch is not None:
            self.on_scope_batch(message)
        await self._broadcast(self._scope_subscribers, message)

    @staticmethod
    async def _broadcast(subscribers: set[WebSocket], message: dict) -> None:
        if not subscribers:
            return
        dead: list[WebSocket] = []
        results = await asyncio.gather(
            *(ws.send_json(message) for ws in subscribers), return_exceptions=True
        )
        for ws, result in zip(subscribers, results):
            if isinstance(result, Exception):
                dead.append(ws)
        for ws in dead:
            subscribers.discard(ws)
