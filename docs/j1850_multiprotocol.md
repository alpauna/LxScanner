# J1850 (PWM + VPW) support, integrated into the ESP32

## Why

The ESP32 firmware currently only speaks ISO 15765-4 (OBD-II over CAN),
which covers essentially every 2008+ vehicle but nothing older. Primary
target: a **2001 Ford F150**, which uses **SAE J1850 PWM** (Ford's
variant; GM used VPW, Chrysler/Euro/Asian makes mostly used ISO9141-2/
KWP2000 K-line -- not covered here, see the K-line research separately
if that becomes a priority). Decided to cover both J1850 variants (PWM
and VPW) together since the reference circuit already implements both.

## Reference: OpenJ1850 (egtechgeek), MIT licensed

[github.com/egtechgeek/OpenJ1850](https://github.com/egtechgeek/OpenJ1850)
-- a real, professionally-designed PCB (EasyEDA project, genuine
schematic + BOM, not a hobby sketch), MIT licensed (verified directly:
`gh api repos/egtechgeek/OpenJ1850 --jq '.license'` -> MIT). Confirmed by
reading the actual schematic PDF (`Hardware/USB_Dongle/SCH_J1850 USB
Dongle.pdf`), not just the BOM.

**We're adapting the analog transceiver circuits, not the board
architecture.** OpenJ1850 as designed is its own standalone USB dongle
(dedicated STM32G031 MCU + USB-to-host connection) -- decided instead to
wire the same transceiver stages into the **ESP32** (driven by its
GPIOs) rather than add a third separate USB device alongside the ESP32
(WiFi, CAN) and the Teensy DAQ (USB, scope). Earlier research confirmed
the ESP32 has real headroom for this: CAN already runs on dedicated TWAI
hardware, and J1850's interrupt-driven pulse timing is proven feasible
on ESP32 by existing open-source projects (see prior research in this
doc's history / conversation).

## What's actually in the reference circuit (confirmed from the schematic)

**PWM transceiver** (page 4 of the schematic) -- this is what the F150
needs:
- TX: **DRV8837** (TI motor-driver H-bridge, repurposed as a
  differential line driver -- no dedicated single-chip J1850 PWM
  transceiver IC exists commercially, this is the standard hobbyist
  workaround). `TX_P -> IN1 -> OUT1 -> PWM+` (OBD pin 2), `TX_N -> IN2 ->
  OUT2 -> PWM-` (OBD pin 10). Firmware must drive TX_P/TX_N as
  complementary signals. `nSLEEP`/enable pin: LOW = Hi-Z/RX-only, HIGH =
  driver enabled.
- RX: **TLV7031** comparator reading the differential PWM+/PWM- lines.
- **Power: runs on plain USB_5V (VM pin), not the 7V rail.** RX side
  (TLV7031) runs on 3.3V. No boost converter needed for PWM alone.
- Schematic's own caveat, worth taking seriously: *"PWM IMPLEMENTATION
  IS EXPERIMENTAL AND MAY REQUIRE FIRMWARE OR HARDWARE TUNING FOR
  SPECIFIC VEHICLES."* Expect real bring-up effort against the actual
  F150, not a drop-in-and-done result.
- Also per the schematic: PWM+/PWM- polarity may vary by
  implementation -- if communication fails, swap OBD pins 2 and 10.

**VPW transceiver** (page 3) -- for GM coverage, added alongside PWM
since the reference already implements it:
- TX: PNP transistor (**MMBT2907A**) as an open-collector-style single-
  wire bus driver.
- RX: **TL331** comparator.
- **Power: needs the +7V rail** (boosted from USB's 5V via **LMR64010**,
  a boost converter -- corrected from an earlier assumption that this
  was a buck from vehicle 12V; it's not, the board is entirely
  USB-powered and 12V-IN-RAW1 on the I/O connector isn't wired to any
  regulator in the reference design).

## Design decision: gate the 7V boost off the mode-select signal

The reference schematic has a physical DIP switch (`J1850_MODE_SELECT`)
wired to the STM32's PA8, read in firmware to decide VPW-vs-PWM protocol
handling. The schematic doesn't show the LMR64010's `SHDN#` (shutdown)
pin tied to anything specific -- worth verifying against the datasheet's
default behavior before assuming it's always-enabled.

**Plan for our version**: tie `SHDN#` to the same mode-select signal
(now an ESP32 GPIO instead of PA8) so the 7V boost converter only powers
up when VPW mode is actually selected, sitting shut down (near-zero
quiescent draw) during PWM-only operation -- which is the common case
given the F150 is the primary target. Reuses infrastructure already in
the reference design rather than adding a separate switch.

## Open items before ordering/building

- ESP32 GPIO pin assignments for: PWM TX_P, TX_N, TX_EN; PWM RX; VPW TX;
  VPW RX; boost `SHDN#` control -- TBD, to be added to
  `firmware/include/pins.h` once decided (avoid conflicts with the
  existing CAN TX/RX pins from `docs/wiring.md`).
- Component sourcing: DRV8837, TLV7031, TL331, MMBT2907ALT1G, LMR64010,
  plus supporting passives per the BOM -- not yet ordered.
- Firmware: port bit-timing/framing logic from OpenJ1850's STM32
  firmware and/or [voodoomods/J1850-VPW-ESP32-Interface-GM-Class2](https://github.com/voodoomods/J1850-VPW-ESP32-Interface-GM-Class2)
  (already ESP32-specific) to our firmware -- not started.

## Ground rule (same as the Teensy DAQ)

No firmware logic gets written before the transceiver components are in
hand to bench-validate against -- this session found real bugs in
"should be right" protocol assumptions (Hantek dt/timing, a real
upstream driver bug) only once actual hardware existed to test with, and
the schematic's own "PWM is experimental" warning is reason enough to
expect the same here.
