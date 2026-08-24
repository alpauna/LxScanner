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
backend/    FastAPI app: ingest, decoding, session recording, WebSocket hub
frontend/   React + Vite dashboard
firmware/   ESP32 (PlatformIO) firmware: TWAI CAN + OBD-II + WiFi uplink
docs/       Wiring/power notes, Hantek 1008C driver notes
```

## Status

- **Backend**: working end-to-end with mock OBD2/scope data sources, so
  the full stack runs and streams realistic fake data with no hardware
  attached at all.
- **Frontend**: built (Live PIDs, DTCs, CAN Capture, 8-channel Scope
  tabs), not yet run in this environment — no Node.js available here.
- **Firmware**: WiFi + TWAI CAN + OBD-II mode 01 (PIDs) / 03 (read DTCs) /
  04 (clear DTCs) + raw capture mode. Compiles cleanly against the ESP32
  Arduino framework; not yet flashed/tested against real hardware.
- **Hantek 1008C driver**: not started yet (planned next phase — see
  `docs/hantek1008c.md` for the approach and known risks).

## Running the backend (mock data, no hardware needed)

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/uvicorn app.main:app --reload
```

REST API at `http://localhost:8000/api/*`, WebSocket streams at
`/ws/stream/live` and `/ws/stream/scope`.

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
