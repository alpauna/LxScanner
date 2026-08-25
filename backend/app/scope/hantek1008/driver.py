"""ScopeDriver implementation backed by the vendored, patched
mfg92/hantek1008py driver (see vendor.py's header for the patch applied
and docs/hantek1008c.md for the bring-up notes that justify it).

pyusb calls in the vendor driver are blocking, so all device I/O runs on
a dedicated background thread; results cross back into asyncio via a
queue fed with `loop.call_soon_threadsafe`. Burst-mode captures (chosen
over roll mode -- see docs/hantek1008c.md for why) happen back-to-back in
a loop, each one taking well under a second even with all 8 channels
active, which comfortably satisfies the device's 7-second keepalive
requirement without a separate ping thread.

On-demand calibration (calibrate_channel) runs on its own thread via
asyncio.to_thread, so `_dev_lock` serializes it against the acquisition
loop -- the vendor driver isn't safe for concurrent USB access from two
threads.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import AsyncIterator

from app.scope.driver import ScopeDriver
from app.scope.hantek1008 import calibration
from app.scope.hantek1008.vendor import Hantek1008

logger = logging.getLogger(__name__)

# 5ms/div * 10 divs = 50ms total window, ~3 cycles of a 60Hz signal.
# The vendor lib's own default (500_000 = 500us/div => 5ms total window)
# is far too short to show anything below ~1kHz as a recognizable shape
# -- a 60Hz sine (16.67ms period) barely moves within 5ms, showing up as
# a flat-looking plateau near whatever point in the cycle got captured,
# not a sine. Found 2026-08-25 with a real probe expecting to see 60Hz
# mains pickup. See set_timebase() for reconfiguring this from the UI.
_DEFAULT_NS_PER_DIV = 5_000_000

# A burst-mode capture spans a fixed window of ns_per_div * _BURST_DIVS,
# independent of channel count or sample count -- validated empirically
# against a known 1kHz reference square wave on 2026-08-25 (500 samples/ch
# at ns_per_div=500_000 with 8 channels active landed exactly on 100
# samples/cycle => 10us/sample => 5ms total window => ns_per_div * 10).
# Wall-clock call duration is NOT a usable proxy for this: it's dominated
# by USB/protocol overhead (the burst readout alone is ~125 separate
# 64-byte transfers, each with a mandated 2ms inter-transfer sleep in the
# vendor driver), not real sample timing. Only verified at the default
# ns_per_div/8-channel configuration so far -- see docs/hantek1008c.md.
_BURST_DIVS = 10


def _nearest_vscale(range_v: float) -> float:
    """Maps a requested input range in volts to the nearest of the three
    hardware-supported vertical scale factors. This is an approximation,
    not a calibrated volts-per-division mapping -- see docs/hantek1008c.md.
    """
    if range_v <= 1.0:
        return 0.02
    if range_v <= 6.0:
        return 0.125
    return 1.0


class HantekScopeDriver(ScopeDriver):
    def __init__(self) -> None:
        self._dev: Hantek1008 | None = None
        self._dev_lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=8)
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._enabled: dict[int, dict] = {ch: {"range_v": 5.0} for ch in range(8)}
        self._ns_per_div = _DEFAULT_NS_PER_DIV

    async def connect(self) -> None:
        self._loop = asyncio.get_running_loop()
        await self._open_device()

    async def disconnect(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            await asyncio.to_thread(self._thread.join, timeout=5)
            self._thread = None
        if self._dev is not None:
            await asyncio.to_thread(self._dev.close)
            self._dev = None

    async def configure_channels(
        self, enabled: dict[int, dict], sample_rate_hz: int
    ) -> None:
        self._enabled = enabled
        # Burst mode is windowed, not rate-controlled directly; ns_per_div
        # stays at the validated default until per-channel-count timing is
        # characterized well enough to target a requested rate accurately.
        if sample_rate_hz != 0:
            logger.info(
                "HantekScopeDriver: requested sample_rate_hz=%s is informational only "
                "for now -- burst mode uses a fixed ns_per_div (%s) until per-channel "
                "timing is characterized",
                sample_rate_hz,
                self._ns_per_div,
            )
        await self._reopen_device()

    async def set_channel_range(self, channel: int, range_v: float) -> None:
        self._enabled[channel] = {**self._enabled.get(channel, {}), "range_v": range_v}
        await self._reopen_device()

    async def set_timebase(self, ns_per_div: int) -> None:
        """Reconfigures the actual capture window (ns_per_div * _BURST_DIVS
        total), not just the display zoom. Needed to see anything slower
        than ~1kHz as a recognizable shape -- the default 500us/div gives
        only a 5ms window, well under one period of e.g. a 60Hz signal.
        Valid values follow a 1-2-5 sequence from 1ns to 200ms -- see
        vendor.py's __burst_mode_ns_per_div_to_id_dic.
        """
        self._ns_per_div = ns_per_div
        await self._reopen_device()

    async def calibrate_channel(self, channel: int) -> dict:
        """Captures one raw burst, splits it into the cal signal's high/low
        levels (see calibration.split_levels), saves it as that channel's
        calibration point, and reopens the device so the new correction
        factor takes effect immediately. Exposed via POST
        /api/scope/calibrate/{channel} for the "Recalibrate" button in the
        Scope tab -- cable/contact quality drifts, so this is meant to be
        run again whenever a channel's readings look off, not just once.
        """
        if not (0 <= channel < 8):
            return {"ok": False, "reason": f"channel must be 0-7, got {channel}"}

        def _measure() -> dict:
            assert self._dev is not None
            with self._dev_lock:
                raw = self._dev.request_samples_burst_mode(mode="raw")
                vscale = self._dev.get_vscale(channel)
                zero_offset = round(self._dev.get_zero_offset(channel), 2)
            levels = calibration.split_levels(raw[channel])
            if levels is None:
                return {
                    "ok": False,
                    "reason": (
                        "Samples don't look like a clean square wave -- check that "
                        "the cal output is connected to this channel"
                    ),
                }
            avg_low, avg_high = levels
            data = calibration.load_raw_calibration()
            data[channel] = calibration.make_channel_entry(avg_low, avg_high, vscale, zero_offset)
            calibration.save_raw_calibration(data)
            return {"ok": True, "low_v": avg_low, "high_v": avg_high}

        if self._dev is None:
            return {"ok": False, "reason": "Scope not connected"}
        result = await asyncio.to_thread(_measure)
        if result["ok"]:
            await self._reopen_device()  # picks up the freshly-saved correction data
        return result

    async def _open_device(self) -> None:
        vscales = [
            _nearest_vscale(self._enabled.get(ch, {}).get("range_v", 5.0))
            for ch in range(8)
        ]
        active = sorted(self._enabled.keys()) or list(range(8))

        def _connect() -> Hantek1008:
            dev = Hantek1008(
                ns_per_div=self._ns_per_div,
                vertical_scale_factor=vscales,
                active_channels=active,
                correction_data=calibration.load_correction_data(),
            )
            dev.connect()
            dev.init()
            return dev

        self._dev = await asyncio.to_thread(_connect)
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._acquire_loop, daemon=True)
        self._thread.start()

    async def _reopen_device(self) -> None:
        await self.disconnect()
        await self._open_device()

    def _acquire_loop(self) -> None:
        assert self._dev is not None and self._loop is not None
        window_seconds = self._ns_per_div * _BURST_DIVS / 1e9
        while not self._stop_event.is_set():
            t_start = time.monotonic()
            try:
                with self._dev_lock:
                    result = self._dev.request_samples_burst_mode()
            except Exception:
                logger.exception("Hantek burst capture failed, stopping acquisition")
                return
            n_samples = len(next(iter(result.values()), []))
            dt = window_seconds / n_samples if n_samples else 0.0
            batch = {
                "type": "scope_batch",
                "t0": t_start,
                "dt": dt,
                "channels": result,
            }
            self._loop.call_soon_threadsafe(self._enqueue, batch)

    def _enqueue(self, batch: dict) -> None:
        if self._queue.full():
            self._queue.get_nowait()  # drop oldest, prioritize freshness
        self._queue.put_nowait(batch)

    async def stream(self) -> AsyncIterator[dict]:
        while True:
            yield await self._queue.get()
