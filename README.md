# LxScanner

An automotive diagnostics dashboard combining:

- An **ESP32-based OBD2/CAN scanner** — live PIDs, DTC read/clear, and raw
  CAN bus capture, connected to the vehicle's OBD2 port.
- A **Hantek 1008C** 8-channel USB automotive oscilloscope, for capturing
  and graphing raw analog signals (sensors, injectors, ignition, etc.)
  alongside the CAN data.
- A single **web dashboard** tying both together, with live views and
  session recording/export.

## Architecture

```
 ┌───────────────┐   WiFi/WebSocket   ┌─────────────────────────────┐
 │  ESP32 board   │ ─────────────────▶│  Backend (Python/FastAPI)   │
 │  + SN65HVD230  │   JSON CAN frames │  - OBD2/CAN ingest + decode │
 │  CAN transceiver│  + DTC commands  │  - Hantek 1008C driver      │
 │  → OBD2 port   │◀───────────────── │  - Session recorder         │
 └───────────────┘                    │  - WebSocket broadcast hub  │
                                       │                              │
 ┌───────────────┐   USB (pyusb)      │                              │
 │ Hantek 1008C   │◀──────────────────┤                              │
 └───────────────┘                    └──────────────┬───────────────┘
                                                       │ WebSocket/REST
                                              ┌────────▼────────┐
                                              │  Web frontend    │
                                              │  (React + Vite)  │
                                              │  Live PIDs / DTCs│
                                              │  CAN capture     │
                                              │  8-ch scope      │
                                              └──────────────────┘
```

The backend's ESP32 link is behind an `OBD2Source` interface and the scope
behind a `ScopeDriver` interface, so both the OBD2 data source and the
scope hardware are swappable without touching the rest of the app. See
`docs/hantek1008c.md` for why that isolation matters for the scope driver
specifically (it wraps a reverse-engineered USB protocol with no vendor
SDK).

## Repo layout

```
backend/         FastAPI app: ingest, decoding, session recording, WebSocket hub
frontend/        React + Vite dashboard
firmware/        ESP32 (PlatformIO) firmware: TWAI CAN + OBD-II + WiFi uplink
firmware-teensy/ Teensy 4.1 (PlatformIO) firmware: custom multi-channel DAQ, see docs/teensy_daq.md
docs/            Wiring/power notes, Hantek 1008C driver notes, Teensy DAQ design
```

## Status

- **Hantek 1008C scope**: live and verified against real hardware,
  including an independent reference scope confirming waveform shape,
  timing, and amplitude all match. Full writeup in
  `docs/hantek1008c.md`. Working:
  - Real (patched) driver on a background thread, streamed over
    `/ws/stream/scope`.
  - Per-unit voltage calibration using the scope's own built-in cal
    signal — standalone script for calibrating all 8 channels from
    scratch, or an on-demand "Recalibrate" button per channel in the UI
    (cable/contact quality drifts, so this is meant to be re-run, not a
    one-time setup step).
  - Scope tab: one big overlay chart, per-channel color/enable/reorder/
    vertical-offset controls, draggable voltage/time cursors with live
    ΔV/Δt/frequency readouts, a pan tool, and real Time/div + Volts/div +
    per-channel input-range controls that reconfigure the actual
    hardware (not just a display zoom) — plus a probe/attenuator ratio
    setting (1:1/10:1/20:1/100:1) so the displayed voltage matches what's
    actually at the probe tip.
  - USB reconnection with backoff if the connection drops (a lead coming
    loose, etc.), with a status banner in the UI — verified against a
    real physical unplug/replug.
- **Backend**: also runs with mock OBD2/scope data sources when no
  hardware is attached, for frontend/UI development.
- **Frontend**: React + Vite dashboard (Live PIDs, DTCs, CAN Capture,
  Scope tabs).
- **Firmware**: WiFi + TWAI CAN + OBD-II mode 01 (PIDs) / 03 (read DTCs) /
  04 (clear DTCs) + raw capture mode. Compiles cleanly against the ESP32
  Arduino framework; not yet flashed/tested against real hardware (next
  phase — the scope side got tested first since the hardware was already
  on hand).
- **Teensy 4.1 + AD7606 custom DAQ**: in progress, replacing the Hantek's
  fixed ~4000-sample memory-depth ceiling (confirmed hard hardware limit,
  not a driver issue — see `docs/hantek1008c.md`) with continuous
  streaming and true per-channel simultaneous sampling. Full design in
  `docs/teensy_daq.md`, including the MCU selection story (STM32H7 was
  the original plan, but no ST Nucleo board actually exposes true USB-HS
  without an external PHY chip, and the one Discovery board that does
  wasn't in stock — Teensy 4.1's i.MX RT1062 has USB-HS built directly
  into the silicon, no external PHY at all, and is reliably available).
  Phase 0 (project scaffold, compiles cleanly against a Teensy 4.1) is
  done; proof-of-concept hardware arrives imminently, before any
  peripheral-driving firmware gets written. The Hantek isn't going away
  — it stays a valid option for anyone who understands its limits, and
  its calibration/UI work carries forward regardless (the new driver
  plugs into the same `ScopeDriver` interface with zero frontend
  changes).

## Running the backend (mock data, no hardware needed)

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/uvicorn app.main:app --reload
```

REST API at `http://localhost:8000/api/*`, WebSocket streams at
`/ws/stream/live` and `/ws/stream/scope`.

Set `LXSCANNER_OBD_SOURCE=esp32` and/or `LXSCANNER_SCOPE_SOURCE=hantek`
to switch either source off its mock and onto real hardware.

## Running the frontend

```sh
cd frontend
npm install
npm run dev
```

Proxies `/api` and `/ws` to `localhost:8000` (see `vite.config.ts`).

## Flashing the ESP32 firmware

```sh
cd firmware
cp include/secrets.h.example include/secrets.h   # fill in WiFi + backend IP
pio run -t upload
```

Wiring and power details for the SN65HVD230 CAN transceiver and the OBD2
connector are in `docs/wiring.md`. Run the backend with
`LXSCANNER_OBD_SOURCE=esp32` to switch it off the mock source and onto the
real board.

## Calibrating the Hantek 1008C

The driver's raw-to-volt conversion isn't accurate per-unit out of the
box (~11% error observed) until calibrated against a known voltage —
conveniently, the 1008C has a built-in 2Vp-p 1kHz cal/probe-comp output
that works for this. To calibrate all 8 channels from scratch:

```sh
cd backend
.venv/bin/python scripts/calibrate_hantek.py
```

Needs the backend stopped first (only one process can hold the USB
device). It'll prompt you to move the cal output's wire to each channel
in turn. To recalibrate a single channel later — cable/contact quality
drifts, so this isn't a one-time step — use the "Recalibrate" button on
that channel in the Scope tab instead; it does the same measurement
without needing to stop the backend. Full details in
`docs/hantek1008c.md`.
