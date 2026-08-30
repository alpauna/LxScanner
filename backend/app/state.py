from __future__ import annotations

import asyncio
from dataclasses import dataclass

from app.hub import Hub
from app.models import Mode
from app.obd.source import OBD2Source
from app.scope.capture_store import ScopeCaptureStore
from app.scope.driver import ScopeDriver
from app.session.recorder import SessionRecorder


@dataclass
class AppState:
    hub: Hub
    obd_source: OBD2Source
    scope_driver: ScopeDriver
    recorder: SessionRecorder
    capture_store: ScopeCaptureStore
    scope_source: str = "mock"
    scope_task: asyncio.Task | None = None
    current_mode: Mode = "scanner"
