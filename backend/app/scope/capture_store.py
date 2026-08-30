"""File-backed storage for scope captures.

A wholly separate concept from SessionRecorder (see its own docstring):
that recorder is typed for small discrete OBD/CAN/DTC events written as
SQLite rows, the wrong shape for waveform volume. A capture is built up
entirely in the browser (same place the live rolling buffer already
lives -- see ScopeView.tsx) and only reaches the backend as one
already-complete payload at Save time, so this only needs to persist it
to disk and hand it back -- no live streaming/recording path, no `Hub`
involvement (its `on_scope_batch` hook stays dormant, as researched
before this was built).

One file pair per capture: `<id>.meta.json` (small, so listing captures
never has to open a multi-MB file) and gzip-compressed
`<id>.data.json.gz` (the bulk `xs`/per-channel arrays -- JSON float
arrays compress well, cheaply avoiding the size cost of plain JSON
without inventing a binary format).
"""
from __future__ import annotations

import gzip
import json
import time
import uuid
from pathlib import Path
from typing import Any

CAPTURES_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "captures"


class ScopeCaptureStore:
    def __init__(self, captures_dir: Path = CAPTURES_DIR) -> None:
        captures_dir.mkdir(parents=True, exist_ok=True)
        self._dir = captures_dir

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        """`payload` matches ScopeCaptureCreate's shape as a plain dict
        (not the pydantic model), keeping this independent of the API
        layer -- same convention as SessionRecorder.record_live_event.
        Returns the resulting meta dict (ScopeCaptureMeta's shape)."""
        capture_id = uuid.uuid4().hex
        xs = payload["xs"]
        meta = {
            "id": capture_id,
            "name": payload.get("name"),
            "source": payload["source"],
            "created_at": time.time(),
            "wall_clock_start_ms": payload["wall_clock_start_ms"],
            "duration_sec": payload["duration_sec"],
            "sample_count": len(xs),
        }
        data = {"xs": xs, "channels": payload["channels"], "data": payload["data"]}
        (self._dir / f"{capture_id}.meta.json").write_text(json.dumps(meta))
        with gzip.open(self._dir / f"{capture_id}.data.json.gz", "wt") as f:
            json.dump(data, f)
        return meta

    def list_meta(self) -> list[dict[str, Any]]:
        metas = [json.loads(p.read_text()) for p in self._dir.glob("*.meta.json")]
        metas.sort(key=lambda m: m["created_at"], reverse=True)
        return metas

    def load_data(self, capture_id: str) -> dict[str, Any]:
        with gzip.open(self._dir / f"{capture_id}.data.json.gz", "rt") as f:
            return json.load(f)

    def delete(self, capture_id: str) -> None:
        for suffix in (".meta.json", ".data.json.gz"):
            (self._dir / f"{capture_id}{suffix}").unlink(missing_ok=True)
