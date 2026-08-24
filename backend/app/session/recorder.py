"""SQLite-backed session recording.

Live OBD2/CAN/DTC events are small and go straight into SQLite rows.
Scope waveform data (phase 5) does not: multi-hundred-kS/s waveforms are
written to a flat binary file per session and only referenced from
SQLite, since embedding that volume of samples as SQLite rows is wasteful.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "sessions.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at REAL NOT NULL,
    ended_at REAL,
    mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    ts REAL NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL
);
"""


class SessionRecorder:
    def __init__(self, db_path: Path = DB_PATH) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        self._active_session_id: int | None = None

    @property
    def active_session_id(self) -> int | None:
        return self._active_session_id

    def start_session(self, mode: str) -> int:
        cur = self._conn.execute(
            "INSERT INTO sessions (started_at, mode) VALUES (?, ?)",
            (time.time(), mode),
        )
        self._conn.commit()
        self._active_session_id = cur.lastrowid
        return self._active_session_id

    def stop_session(self) -> None:
        if self._active_session_id is None:
            return
        self._conn.execute(
            "UPDATE sessions SET ended_at = ? WHERE id = ?",
            (time.time(), self._active_session_id),
        )
        self._conn.commit()
        self._active_session_id = None

    def record_live_event(self, event: dict) -> None:
        if self._active_session_id is None:
            return
        self._conn.execute(
            "INSERT INTO live_events (session_id, ts, event_type, payload) "
            "VALUES (?, ?, ?, ?)",
            (self._active_session_id, event["ts"], event["type"], json.dumps(event)),
        )
        self._conn.commit()

    def list_sessions(self) -> list[dict]:
        cur = self._conn.execute(
            "SELECT id, started_at, ended_at, mode FROM sessions ORDER BY id DESC"
        )
        return [
            {"id": r[0], "started_at": r[1], "ended_at": r[2], "mode": r[3]}
            for r in cur.fetchall()
        ]
