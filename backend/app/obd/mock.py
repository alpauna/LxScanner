"""Generates plausible fake PID/CAN/DTC traffic so the frontend and backend
plumbing can be developed and tested without any ESP32 or vehicle attached.
"""
from __future__ import annotations

import asyncio
import random
import time
from collections.abc import AsyncIterator

from app.config import SCANNER_PIDS
from app.models import Mode
from app.obd.source import OBD2Source


class MockOBD2Source(OBD2Source):
    def __init__(self) -> None:
        self._mode: Mode = "scanner"
        self._running = False
        self._rpm = 800.0
        self._speed = 0.0

    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False

    def set_mode(self, mode: Mode) -> None:
        self._mode = mode

    def request_dtc_clear(self) -> None:
        pass

    async def events(self) -> AsyncIterator[dict]:
        while self._running:
            if self._mode == "scanner":
                for event in self._sample_pids():
                    yield event
                await asyncio.sleep(0.2)
            else:
                yield self._sample_can_frame()
                await asyncio.sleep(0.02)

    def _sample_pids(self) -> list[dict]:
        self._rpm = max(700.0, self._rpm + random.uniform(-150, 150))
        self._speed = max(0.0, min(140.0, self._speed + random.uniform(-3, 3)))
        ts = time.time()
        values = {
            "0C": self._rpm,
            "0D": self._speed,
            "05": 85 + random.uniform(-2, 2),
            "11": random.uniform(0, 40),
            "42": 13.8 + random.uniform(-0.3, 0.3),
        }
        return [
            {
                "type": "pid",
                "pid": pid,
                "name": name,
                "value": round(values[pid], 2),
                "unit": unit,
                "ts": ts,
            }
            for pid, (name, unit) in SCANNER_PIDS.items()
        ]

    def _sample_can_frame(self) -> dict:
        return {
            "type": "can_frame",
            "can_id": random.choice([0x7E8, 0x123, 0x201, 0x316]),
            "dlc": 8,
            "data": [random.randint(0, 255) for _ in range(8)],
            "ts": time.time(),
        }
