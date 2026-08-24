"""Fake 8-channel waveform generator so the scope UI can be built and
tested before the Hantek 1008C driver (phase 4) exists."""
from __future__ import annotations

import asyncio
import math
import time
from collections.abc import AsyncIterator

from app.scope.driver import ScopeDriver

_SAMPLES_PER_BATCH = 500


class MockScopeDriver(ScopeDriver):
    def __init__(self) -> None:
        self._enabled: dict[int, dict] = {ch: {"range_v": 5.0} for ch in range(8)}
        self._sample_rate_hz = 50_000
        self._connected = False
        self._t = 0.0

    async def connect(self) -> None:
        self._connected = True

    async def disconnect(self) -> None:
        self._connected = False

    async def configure_channels(
        self, enabled: dict[int, dict], sample_rate_hz: int
    ) -> None:
        self._enabled = enabled
        self._sample_rate_hz = sample_rate_hz

    async def stream(self) -> AsyncIterator[dict]:
        dt = 1.0 / self._sample_rate_hz
        while self._connected:
            t0 = self._t
            channels: dict[int, list[float]] = {}
            for ch, cfg in self._enabled.items():
                amp = cfg.get("range_v", 5.0) * 0.6
                freq = 50 + ch * 25
                channels[ch] = [
                    amp * math.sin(2 * math.pi * freq * (t0 + i * dt) + ch)
                    for i in range(_SAMPLES_PER_BATCH)
                ]
            self._t += _SAMPLES_PER_BATCH * dt
            yield {"type": "scope_batch", "t0": t0, "dt": dt, "channels": channels}
            # Pace batches roughly in real time rather than as fast as possible.
            await asyncio.sleep(_SAMPLES_PER_BATCH * dt)
