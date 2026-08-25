#!/usr/bin/env python3
"""Interactive full-unit calibration for the Hantek 1008C, one channel at
a time, using the scope's own built-in 2Vp-p 1kHz calibration/probe-comp
output as the voltage reference.

For recalibrating a single channel later (e.g. after reseating a cable),
use the "Recalibrate" button on the Scope tab instead -- it does the same
measurement via POST /api/scope/calibrate/{channel} without needing to
stop the backend. This script is for calibrating all 8 channels from
scratch, which needs the backend stopped since only one process can hold
the USB device at a time.

See app/scope/hantek1008/calibration.py for the shared measurement logic
and docs/hantek1008c.md for the full writeup.

Usage:
    backend/.venv/bin/python backend/scripts/calibrate_hantek.py

You'll be prompted once per channel to move the cal output's wire there
and press Enter. The device auto-disconnects after 7 seconds of no
commands, so this keeps a keepalive ping running while waiting on you --
take as long as you need moving the wire. Progress is resumable: if you
quit partway (or it fails) and re-run, previously-calibrated channels
from the existing output file are kept.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.scope.hantek1008 import calibration  # noqa: E402
from app.scope.hantek1008.vendor import Hantek1008  # noqa: E402


def main() -> None:
    calibration_data = calibration.load_raw_calibration()
    already_done = [ch + 1 for ch, data in calibration_data.items() if data]
    if already_done:
        print(f"Resuming -- channels already calibrated: {already_done}")

    device = Hantek1008(active_channels=list(range(8)), vertical_scale_factor=calibration.VSCALE)
    device.connect()
    device.init()
    device.pause()  # keeps the device alive via pings while we wait on input()

    try:
        for ch in range(8):
            cmd = input(
                f"Connect the cal output to channel {ch + 1} (CH{ch + 1}), then "
                f"press Enter (or 's' to skip this channel, 'q' to quit and save "
                f"what's measured so far): "
            )
            if cmd == "q":
                break
            if cmd == "s":
                continue

            device.cancel_pause()
            try:
                result = device.request_samples_burst_mode(mode="raw")
            finally:
                device.pause()

            levels = calibration.split_levels(result[ch])
            if levels is None:
                print(
                    f"  Channel {ch + 1}: samples don't look like a clean square "
                    f"wave (min={min(result[ch])}, max={max(result[ch])}) -- "
                    f"skipping. Check the connection and try again later if needed."
                )
                continue

            avg_low, avg_high = levels
            vscale = device.get_vscale(ch)
            zero_offset = round(device.get_zero_offset(ch), 2)
            calibration_data[ch] = calibration.make_channel_entry(
                avg_low, avg_high, vscale, zero_offset
            )
            print(f"  Channel {ch + 1}: low={avg_low:.1f}, high={avg_high:.1f} raw units")
    finally:
        try:
            device.close()
        except Exception as e:  # noqa: BLE001 -- best-effort cleanup, must not block saving
            print(f"(device.close() failed, ignoring: {e})")
        calibration.save_raw_calibration(calibration_data)
        print(f"Wrote {calibration.CALIBRATION_PATH}")


if __name__ == "__main__":
    main()
