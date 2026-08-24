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

- OBD2 pin 6 (CAN-H) → transceiver `CANH`
- OBD2 pin 14 (CAN-L) → transceiver `CANL`
- Transceiver `VCC` → ESP32 `3.3V`
- Transceiver `GND` → ESP32 `GND` → OBD2 pin 4
- Transceiver `TXD` → ESP32 GPIO5 (`CAN_TX_PIN` in `firmware/include/pins.h`)
- Transceiver `RXD` → ESP32 GPIO4 (`CAN_RX_PIN`)
- If the board has an `Rs` (slope control) pin, tie it to GND for
  high-speed mode (most breakouts do this by default).

**Do not add a 120Ω termination resistor** on the transceiver board when
connected to a real vehicle -- the bus is already terminated at both ends
inside the car. Only add one for bench testing with a bare transceiver pair
and no live vehicle bus.

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
