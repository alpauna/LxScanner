"""Adapter-agnostic OBD2/CAN data source.

The ESP32-over-WiFi link (added in phase 2) is the default implementation,
but anything that can yield the same event dicts -- a Bluetooth ELM327
dongle, a replayed capture file, another ESP32 sniffing a bus -- can plug
in here without touching the backend's WebSocket/session code.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from app.models import Mode


class OBD2Source(ABC):
    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    def set_mode(self, mode: Mode) -> None: ...

    @abstractmethod
    def request_dtc_clear(self) -> None: ...

    @abstractmethod
    def events(self) -> AsyncIterator[dict]:
        """Yields PidReading / CanFrame / DtcEvent dicts (see app.models)."""
        ...

    async def ingest(self, event: dict) -> None:
        """Feeds an externally-received event (e.g. from the ESP32 ingest
        WebSocket) into this source so it surfaces from `events()`. No-op
        for sources that generate their own data (e.g. the mock source)."""
