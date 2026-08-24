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
