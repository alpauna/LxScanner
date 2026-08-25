"""Shared calibration logic used by both scripts/calibrate_hantek.py (the
standalone interactive CLI) and HantekScopeDriver.calibrate_channel (the
on-demand path triggered from the web UI). See docs/hantek1008c.md for
the full writeup of why this exists and how it works.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

CALIBRATION_PATH = Path(__file__).resolve().parents[3] / "data" / "hantek_calibration_raw.json"

# Matches HantekScopeDriver's default range_v=5.0 -> vscale 0.125 (see
# _nearest_vscale in driver.py). A channel calibrated at a different
# vscale needs its own calibration point -- see _load_correction_data.
VSCALE = 0.125

# The Hantek 1008C's built-in cal/probe-comp output: confirmed 0V-2V
# unipolar, ground-referenced (2026-08-25).
LOW_VOLTAGE = 0.0
HIGH_VOLTAGE = 2.0
MIN_SAMPLES_PER_LEVEL = 20
# At vscale 0.125, raw units are ~0.00125V each (scale = 0.01 * vscale),
# so a real 2V swing is ~1600 raw units. Require at least half that --
# anything smaller is noise/no-connection, not this cal signal, and
# produces a near-zero swing that back-calculates to wildly implausible
# correction factors (found 2026-08-25: a disconnected/noisy channel
# split its own noise into two "levels" 1.14 raw units apart and passed
# the old sample-count-only check, corrupting that channel's saved
# calibration with garbage).
MIN_RAW_SWING = 800


def split_levels(samples: list[float]) -> tuple[float, float] | None:
    """Splits raw samples of a two-level square wave into (avg_low,
    avg_high). Returns None if the signal doesn't look like a clean
    square wave (e.g. nothing connected, or a non-square signal).
    """
    if max(samples) - min(samples) < MIN_RAW_SWING:
        return None
    mid = (max(samples) + min(samples)) / 2
    low = [v for v in samples if v < mid]
    high = [v for v in samples if v >= mid]
    if len(low) < MIN_SAMPLES_PER_LEVEL or len(high) < MIN_SAMPLES_PER_LEVEL:
        return None
    avg_low = sum(low) / len(low)
    avg_high = sum(high) / len(high)
    if avg_high - avg_low < MIN_RAW_SWING * 0.5:
        return None
    return avg_low, avg_high


def load_raw_calibration(path: Path = CALIBRATION_PATH) -> dict[int, list[dict]]:
    if not path.exists():
        return {ch: [] for ch in range(8)}
    with open(path) as f:
        raw = json.load(f)
    return {ch: raw.get(str(ch), []) for ch in range(8)}


def save_raw_calibration(data: dict[int, list[dict]], path: Path = CALIBRATION_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def make_channel_entry(avg_low: float, avg_high: float, vscale: float, zero_offset: float) -> list[dict]:
    return [
        {
            "test_voltage": LOW_VOLTAGE,
            "measured_value": round(avg_low, 2),
            "vscale": vscale,
            "zero_offset": zero_offset,
        },
        {
            "test_voltage": HIGH_VOLTAGE,
            "measured_value": round(avg_high, 2),
            "vscale": vscale,
            "zero_offset": zero_offset,
        },
    ]


def build_correction_data(raw_calibration: dict[int, list[dict]]) -> list[dict[float, dict[float, float]]]:
    """Converts raw measurement points into the correction_data format
    Hantek1008's constructor expects (see
    Hantek1008Raw.__calc_correction_factor in vendor.py). Mirrors the
    conversion in upstream csvexport.py's -c/--calibrationfile handling.
    """
    correction_data: list[dict[float, dict[float, float]]] = [{} for _ in range(8)]
    for channel_id, channel_cdata in raw_calibration.items():
        for test in channel_cdata:
            vscale = test["vscale"]
            test_voltage = test["test_voltage"]
            units = test["measured_value"] - test["zero_offset"]
            if test_voltage == 0 or units == 0:
                continue
            correction_factor = test_voltage / (units * 0.01 * vscale)
            if not (0.5 < correction_factor < 2.0):
                logger.warning(
                    "Ignoring implausible correction factor %.3f for channel %d "
                    "at %sV (vscale=%s)",
                    correction_factor,
                    channel_id,
                    test_voltage,
                    vscale,
                )
                continue
            correction_data[channel_id].setdefault(vscale, {})[units] = correction_factor
    return correction_data


def load_correction_data(path: Path = CALIBRATION_PATH) -> list[dict[float, dict[float, float]]]:
    if not path.exists():
        logger.warning(
            "No calibration file at %s -- using nominal (uncalibrated) voltage "
            "scaling until a channel is calibrated",
            path,
        )
        return [{} for _ in range(8)]
    data = build_correction_data(load_raw_calibration(path))
    logger.info("Loaded Hantek calibration data from %s", path)
    return data
