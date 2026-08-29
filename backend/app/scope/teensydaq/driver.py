"""ScopeDriver implementation for the Teensy 4.1 + AD7606C-16 custom DAQ.

Mirrors HantekScopeDriver's structure (app.scope.hantek1008.driver) where
the pattern fits: pyserial reads are blocking, same problem the Hantek
driver solves with pyusb, so a background thread owns the port and
pushes parsed batches into an asyncio.Queue via
loop.call_soon_threadsafe. Reconnect-with-backoff and scope_status
events are reused for the same real-world reason Hantek has them (a
USB cable coming loose), which also makes the frontend's existing
disconnect banner work against this driver with zero frontend changes.

Wire protocol (see firmware-teensy/src/main.cpp for the authoritative
description): 4-byte sync (0xA5 0x5A 0xA5 0x5A), uint16 sample count,
uint32 microseconds/sample, raw int16 codes for 8 channels x N samples,
1-byte XOR checksum. The firmware sends raw ADC codes -- this driver
does the volts conversion, keeping hardware-specific scaling out of the
wire format (same spirit as Hantek's correction factors living in the
driver, not the vendor protocol).
"""
from __future__ import annotations

import asyncio
import logging
import struct
import threading
import time
from collections.abc import AsyncIterator

import serial

from app.config import TEENSY_PORT
from app.scope.driver import ScopeDriver

logger = logging.getLogger(__name__)

_SYNC = bytes([0xA5, 0x5A, 0xA5, 0x5A])
_HEADER_FMT = "<HI"  # n_samples: uint16, dt_us: uint32
_HEADER_SIZE = struct.calcsize(_HEADER_FMT)

# LSB size by hardware-mode RANGE selection (Table 10/11 of the
# AD7606C-16 datasheet -- see docs/datasheets/AD7606C-16.pdf).
_LSB_VOLTS_BY_RANGE = {
    5.0: 152.58e-6,
    10.0: 305.175e-6,
}

_RECONNECT_MIN_DELAY = 1.0
_RECONNECT_MAX_DELAY = 10.0
_SERIAL_TIMEOUT = 1.0
_BAUD = 115200  # ignored over native USB CDC-ACM, kept for pyserial's API


def _nearest_range(range_v: float) -> float:
    return min(_LSB_VOLTS_BY_RANGE, key=lambda r: abs(r - range_v))


class TeensyDaqDriver(ScopeDriver):
    def __init__(self) -> None:
        self._ser: serial.Serial | None = None
        self._ser_lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=8)
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._enabled: dict[int, dict] = {ch: {"range_v": 5.0} for ch in range(8)}
        self._range_v = 5.0
        self._connected = False
        # Virtual sample clock -- see _read_frame for why this replaces a
        # fresh time.monotonic() read per frame. Reset on every fresh
        # serial connection (initial connect and each successful
        # reconnect), since continuity genuinely breaks there.
        self._t0_anchor: float | None = None
        self._samples_emitted = 0

    async def connect(self) -> None:
        self._loop = asyncio.get_running_loop()
        await self._open_port()

    async def disconnect(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            await asyncio.to_thread(self._thread.join, timeout=5)
            self._thread = None
        if self._ser is not None:
            await asyncio.to_thread(self._close_port)

    async def configure_channels(
        self, enabled: dict[int, dict], sample_rate_hz: int
    ) -> None:
        self._enabled = enabled
        if sample_rate_hz != 0:
            logger.info(
                "TeensyDaqDriver: requested sample_rate_hz=%s is informational "
                "only -- the firmware free-runs at whatever rate CONVST/SPI "
                "timing allows (~45kHz simultaneous per-channel at the current "
                "8MHz SPI clock, bench-measured 2026-08-29)",
                sample_rate_hz,
            )
        range_vs = {cfg.get("range_v", 5.0) for cfg in enabled.values()}
        if len(range_vs) > 1:
            logger.warning(
                "TeensyDaqDriver: AD7606C-16 hardware mode shares one RANGE "
                "pin across all 8 channels -- requested per-channel ranges %s "
                "aren't independently settable; using %s for all channels",
                range_vs,
                next(iter(range_vs)),
            )
        if range_vs:
            await self.set_channel_range(next(iter(enabled)), next(iter(range_vs)))

    async def set_channel_range(self, channel: int, range_v: float) -> None:
        """AD7606C-16 hardware mode has one RANGE pin shared across all 8
        channels, not independent per-channel ranges -- so despite the
        interface's per-channel signature, this sets the range for every
        channel. Documented simplification, same spirit as Hantek's
        driver treating sample_rate_hz as informational-only for its own
        hardware-reality mismatch."""
        self._enabled[channel] = {**self._enabled.get(channel, {}), "range_v": range_v}
        nearest = _nearest_range(range_v)
        self._range_v = nearest
        range_sel = 0 if nearest == 5.0 else 1
        if self._ser is not None:
            await asyncio.to_thread(self._send_command, bytes([ord("R"), range_sel]))

    def _send_command(self, cmd: bytes) -> None:
        with self._ser_lock:
            if self._ser is not None:
                self._ser.write(cmd)

    def _connect_port(self) -> serial.Serial:
        """Blocking; runs on a worker thread. Shared by the initial
        connect and by the reconnect loop after a dropout."""
        ser = serial.Serial(TEENSY_PORT, _BAUD, timeout=_SERIAL_TIMEOUT)
        ser.reset_input_buffer()
        range_sel = 0 if self._range_v == 5.0 else 1
        ser.write(bytes([ord("R"), range_sel]))
        ser.write(b"S")
        return ser

    async def _open_port(self) -> None:
        self._ser = await asyncio.to_thread(self._connect_port)
        self._t0_anchor = None
        self._samples_emitted = 0
        self._set_connected(True)
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._acquire_loop, daemon=True)
        self._thread.start()

    def _close_port(self) -> None:
        with self._ser_lock:
            if self._ser is not None:
                try:
                    self._ser.write(b"X")
                except Exception:
                    pass
                self._ser.close()
                self._ser = None

    def _set_connected(self, connected: bool) -> None:
        if connected == self._connected:
            return
        self._connected = connected
        if self._loop is not None:
            self._loop.call_soon_threadsafe(
                self._enqueue, {"type": "scope_status", "connected": connected}
            )

    def _reconnect_with_backoff(self) -> bool:
        """Blocks (on the acquisition thread) retrying the serial connection
        until it succeeds or _stop_event is set. Returns False if given up
        due to shutdown, True once reconnected."""
        self._close_port()
        self._set_connected(False)

        delay = _RECONNECT_MIN_DELAY
        while not self._stop_event.is_set():
            try:
                with self._ser_lock:
                    self._ser = self._connect_port()
                self._t0_anchor = None
                self._samples_emitted = 0
                logger.info("Teensy DAQ reconnected")
                self._set_connected(True)
                return True
            except Exception:
                logger.warning(
                    "Teensy DAQ reconnect attempt failed, retrying in %.1fs", delay
                )
                self._stop_event.wait(delay)
                delay = min(delay * 1.5, _RECONNECT_MAX_DELAY)
        return False

    def _read_exact(self, n: int) -> bytes | None:
        """Reads exactly n bytes or returns None on timeout/closed port --
        never returns a short read silently."""
        assert self._ser is not None
        buf = bytearray()
        while len(buf) < n:
            chunk = self._ser.read(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return bytes(buf)

    def _hunt_sync(self) -> bool:
        assert self._ser is not None
        window = bytearray(4)
        while not self._stop_event.is_set():
            b = self._ser.read(1)
            if not b:
                return False
            window = window[1:] + b
            if bytes(window) == _SYNC:
                return True
        return False

    def _read_frame(self) -> dict | None:
        """Reads one frame, validates its checksum, and returns a
        scope_batch dict -- or None if the frame was corrupt/timed out
        (caller should just try again, not treat it as a disconnect)."""
        if not self._hunt_sync():
            return None
        header = self._read_exact(_HEADER_SIZE)
        if header is None:
            return None
        n_samples, dt_us = struct.unpack(_HEADER_FMT, header)
        data = self._read_exact(n_samples * 8 * 2)
        if data is None:
            return None
        checksum_byte = self._read_exact(1)
        if checksum_byte is None:
            return None

        computed = 0
        for b in header:
            computed ^= b
        for b in data:
            computed ^= b
        if computed != checksum_byte[0]:
            logger.debug("Teensy DAQ: checksum mismatch, dropping frame")
            return None

        samples = struct.unpack(f"<{n_samples * 8}h", data)
        lsb = _LSB_VOLTS_BY_RANGE[self._range_v]
        channels: dict[int, list[float]] = {}
        for ch in range(8):
            if ch not in self._enabled:
                continue
            channels[ch] = [samples[i * 8 + ch] * lsb for i in range(n_samples)]

        # t0 is when *sample 0 of this frame* was acquired -- not when this
        # read finished. A fresh time.monotonic() here would measure "now,"
        # i.e. after the whole frame's serial transfer + checksum + unpack,
        # which varies with OS/serial scheduling jitter (bench-measured
        # 2026-08-29: adjacent frames' timestamps computed this way jittered
        # by up to several ms, even went *negative* relative to the prior
        # frame's computed end -- meaningless given the ADC free-runs
        # continuously with no real gap between frames). Since the hardware
        # sample rate itself is the authoritative clock, derive each frame's
        # start from a running sample count instead: anchor once per
        # connection to this frame's back-computed start (now minus its own
        # duration), then every later frame's t0 is purely
        # anchor + samples-emitted-so-far * dt -- immune to per-frame wall-
        # clock jitter, and stays correct across a frame the backend's own
        # outbound queue later drops under backpressure (see _enqueue),
        # since samples_emitted only depends on frames this method actually
        # read from the device, not on whether they reach a subscriber.
        dt_sec = dt_us / 1e6
        if self._t0_anchor is None:
            self._t0_anchor = time.monotonic() - n_samples * dt_sec
            self._samples_emitted = 0
        t0 = self._t0_anchor + self._samples_emitted * dt_sec
        self._samples_emitted += n_samples

        return {
            "type": "scope_batch",
            "t0": t0,
            "dt": dt_sec,
            "channels": channels,
        }

    def _acquire_loop(self) -> None:
        assert self._loop is not None
        while not self._stop_event.is_set():
            try:
                with self._ser_lock:
                    assert self._ser is not None
                batch = self._read_frame()
            except Exception:
                logger.exception("Teensy DAQ read failed -- USB likely disconnected")
                if not self._reconnect_with_backoff():
                    return  # shutting down
                continue
            if batch is None:
                continue  # dropped/corrupt frame or read timeout, keep going
            self._loop.call_soon_threadsafe(self._enqueue, batch)

    def _enqueue(self, batch: dict) -> None:
        if self._queue.full():
            self._queue.get_nowait()  # drop oldest, prioritize freshness
        self._queue.put_nowait(batch)

    async def stream(self) -> AsyncIterator[dict]:
        while True:
            yield await self._queue.get()
