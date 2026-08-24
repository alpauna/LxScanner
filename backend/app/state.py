from __future__ import annotations

from dataclasses import dataclass

from app.hub import Hub
from app.models import Mode
from app.obd.source import OBD2Source
from app.scope.driver import ScopeDriver
from app.session.recorder import SessionRecorder


@dataclass
class AppState:
    hub: Hub
    obd_source: OBD2Source
    scope_driver: ScopeDriver
    recorder: SessionRecorder
    current_mode: Mode = "scanner"
