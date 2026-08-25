"""Scope driver interface.

The Hantek 1008C implementation (phase 4) wraps a reverse-engineered USB
protocol with real quirks -- a 7-second keepalive requirement, per-channel
sample-rate ceilings, temperature-dependent calibration. Isolating it
behind this interface means the rest of the backend never depends on
those details, and the driver can be swapped or hardened independently.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator


class ScopeDriver(ABC):
    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...

    @abstractmethod
    async def configure_channels(
        self, enabled: dict[int, dict], sample_rate_hz: int
    ) -> None:
        """`enabled` maps channel number (0-7) to {"range_v": float}."""
        ...

    @abstractmethod
    def stream(self) -> AsyncIterator[dict]:
        """Yields ScopeBatch dicts (see app.models)."""
        ...

    async def calibrate_channel(self, channel: int) -> dict:
        """Measures and saves a fresh calibration point for one channel.
        Not every driver has a meaningful notion of this (e.g. the mock),
        so it's concrete-with-a-default rather than abstract; returns
        {"ok": False, "reason": ...} unless overridden."""
        return {"ok": False, "reason": "This scope driver does not support calibration"}
