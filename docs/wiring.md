# ESP32 ↔ OBD2 wiring

## OBD2 connector (SAE J1962) pins used

| Pin | Signal |
|-----|--------|
| 4   | Chassis ground |
| 6   | CAN-H |
| 14  | CAN-L |
| 16  | Battery+ (12V, constant/unswitched, fused in-vehicle) |

You've already got an OBD2 pigtail/breakout socket on order -- that's what
gives screw-terminal or wire access to these four pins without cutting a
factory harness.

## CAN bus (SN65HVD230 transceiver)

The SN65HVD230 is 3.3V-native, so it wires directly to the ESP32 with no
level shifter:

| SN65HVD230 pin | ESP32 pin | Notes |
|-----------------|-----------|-------|
| `VCC`           | `3V3`     | 3.3V only -- never feed this from `5V`/`VIN` |
| `GND`           | `GND`     | Also common with OBD2 pin 4 (chassis ground) |
| `TXD`           | `GPIO5`   | `CAN_TX_PIN` in `firmware/include/pins.h` |
| `RXD`           | `GPIO4`   | `CAN_RX_PIN` in `firmware/include/pins.h` |
| `CANH`          | --        | To OBD2 pin 6 |
| `CANL`          | --        | To OBD2 pin 14 |
| `Rs` (if present) | `GND`   | Ties the transceiver into high-speed mode; most breakouts already do this by default |

GPIO4/GPIO5 are arbitrary free pins picked for this build, not fixed by
the ESP32's TWAI peripheral -- if you rewire to different GPIOs, update
`CAN_TX_PIN`/`CAN_RX_PIN` in `firmware/include/pins.h` to match.

**Do not add a 120Ω termination resistor** on the transceiver board when
connected to a real vehicle -- the bus is already terminated at both ends
inside the car. Only add one for bench testing with a bare transceiver pair
and no live vehicle bus.

## J1850 (PWM + VPW) daughter board

Second small board, short wires to the ESP32, same pattern as the CAN
transceiver above. Full circuit rationale (why these ICs, the PWM/VPW
power difference, the mode/boost-enable design) is in
`docs/j1850_multiprotocol.md` -- this is just the pin reference:

| Signal | ESP32 pin | Notes |
|---|---|---|
| `J1850_PWM_TX_P` | GPIO13 | DRV8837 IN1 -> OUT1 -> OBD pin 2 |
| `J1850_PWM_TX_N` | GPIO14 | DRV8837 IN2 -> OUT2 -> OBD pin 10 |
| `J1850_PWM_TX_EN` | GPIO27 | DRV8837 nSLEEP: LOW=Hi-Z/RX-only, HIGH=driver enabled |
| `J1850_PWM_RX` | GPIO34 | TLV7031 comparator output (input-only pin) |
| `J1850_VPW_TX` | GPIO26 | to VPW driver transistor (via its bias network) |
| `J1850_VPW_RX` | GPIO35 | TL331 comparator output (input-only pin) |
| `J1850_VPW_MODE_EN` | GPIO25 | HIGH = VPW mode + enables the +7V boost (LMR64010 `SHDN#`); LOW = PWM mode, boost shut down |

PWM (OBD pins 2/10) runs on plain 5V -- no boost converter needed.
VPW (OBD pin 2, single-wire) needs the +7V rail, only powered up in VPW
mode via `J1850_VPW_MODE_EN`. **Not yet verified**: the LMR64010
`SHDN#` pin's actual active-high-vs-active-low polarity against its
datasheet -- confirm before wiring, the assignment above assumes the
"SHDN#" naming convention (bar = active-low shutdown) but that's
inferred, not confirmed against the part itself.

## Power

Pin 16 is nominally 12V but noisy and dips hard (down to ~6V) during
engine cranking. For a bench setup, just power the ESP32 over USB and only
wire CAN-H/CAN-L/GND to the OBD2 port -- this is what phase 2 development
should use.

For a standalone in-car unit later: feed pin 16 into a buck converter
module (LM2596/MP2307-style, wide input range e.g. 6–40V, ~$3–5) stepping
down to 5V into the ESP32's `5V`/`VIN` pin. The board's onboard regulator
then handles 5V→3.3V for the ESP32 and the CAN transceiver. Don't feed 12V
directly into the ESP32's 3.3V or 5V pins.

## Bill of materials (bench setup)

- ESP32 DevKitC (WROOM-32) -- ~$6–10
- SN65HVD230 CAN transceiver breakout -- ~$2–3
- OBD2 pigtail/breakout cable -- ordered
- J1850 daughter board components (not yet ordered): DRV8837, TLV7031,
  TL331, MMBT2907ALT1G, LMR64010, plus supporting passives -- see
  `docs/j1850_multiprotocol.md` for the full circuit and BOM reference
- (later, in-car) 12V→5V buck converter module

## Known firmware limitations (v1)

- No ISO-TP (ISO 15765-2) multi-frame reassembly: a DTC response spanning
  more than one CAN frame (more than ~3 codes) will be truncated. Fine for
  initial development; worth revisiting once real-vehicle testing starts.
- Only the standard 11-bit OBD-II addressing (request `0x7DF`, responses
  `0x7E8`-`0x7EF`) is supported, not 29-bit extended IDs used by some
  trucks/older GM vehicles.
- The `ts` field the firmware sends is `millis()/1000.0` -- device uptime
  in seconds, not wall-clock time. Useful for ordering/delta-timing
  between frames from the same device, not for cross-device sync.
