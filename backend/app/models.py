"""Wire-format schemas shared by the ESP32 ingest link, the backend, and the frontend."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Mode = Literal["scanner", "capture"]


class PidReading(BaseModel):
    type: Literal["pid"] = "pid"
    pid: str
    name: str
    value: float
    unit: str
    ts: float


class CanFrame(BaseModel):
    type: Literal["can_frame"] = "can_frame"
    can_id: int
    dlc: int
    data: list[int]
    ts: float


class DtcEvent(BaseModel):
    type: Literal["dtc"] = "dtc"
    codes: list[str]
    ts: float


class ScopeBatch(BaseModel):
    """One batch of samples across all enabled scope channels.

    `channels` is indexed by channel number (0-7); a channel that isn't
    enabled is simply omitted from the dict rather than sent as zeros.
    """

    type: Literal["scope_batch"] = "scope_batch"
    t0: float
    dt: float
    channels: dict[int, list[float]]


class ScopeCaptureCreate(BaseModel):
    """A complete, already-built capture handed up from the frontend for
    Save -- the browser is the source of truth for capture accumulation
    (see ScopeView.tsx), this is just the persisted-to-disk shape."""

    name: str | None = None
    source: str
    wall_clock_start_ms: float
    duration_sec: float
    channels: list[int]
    xs: list[float]
    data: dict[int, list[float | None]]


class ScopeCaptureMeta(BaseModel):
    id: str
    name: str | None
    source: str
    created_at: float
    wall_clock_start_ms: float
    duration_sec: float
    sample_count: int


LiveEvent = PidReading | CanFrame | DtcEvent
