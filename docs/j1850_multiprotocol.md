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
- TX: originally the reference's PNP transistor (MMBT2907A) as an
  open-collector-style single-wire bus driver, plus a discrete N-channel
  MOSFET (FDN335N) as its low-side level-shift interface. **Consolidated
  into a single AP2003** (complementary N+P MOSFET pair, one SOT-23-6L
  package) during our own board's iteration -- see "VPW TX: AP2003"
  below for why and the resulting bias network.
- RX: **TL331** comparator, now behind its own small reverse-battery
  protection network -- see "VPW RX protection" below.
- **Power: needs the +7V rail** (boosted from USB's 5V via **LMR64010**,
  a boost converter -- corrected from an earlier assumption that this
  was a buck from vehicle 12V; it's not, the board is entirely
  USB-powered and 12V-IN-RAW1 on the I/O connector isn't wired to any
  regulator in the reference design).

### VPW TX: AP2003 (replaces discrete FDN335N + MMBT2907ALT1G)

The reference's PNP high-side switch + separate N-MOSFET level-shifter
got consolidated into one **AP2003** -- not an integrated smart high-side
driver IC, just a matched N-channel + P-channel MOSFET pair in a single
6-pin package (`D1`/`G1`/`S1`/`D2`/`G2`/`S2`, fully independent dice, no
internal connection between them). Same bias-network topology as the
discrete version, just consolidated and swapping the PNP for a
P-channel MOSFET:
- `S2` (P-ch source) -> `+7V` directly, with a local decoupling cap.
- `G2` (P-ch gate) <- pull-up to `+7V` (R4, 10k) and, through a small
  gate-damping resistor (R5, 200R, added to kill ringing from the very
  low-impedance N-ch switching into the P-ch's gate capacitance), tied
  to `D1` (N-ch drain).
- `G1` (N-ch gate) <- ESP32 `J1850_VPW_TX` via a 200R series resistor
  (R7), with a 10k pulldown (R9) to default off.
- `S1` (N-ch source) -> GND.
- `D2` (P-ch drain) -> the bus-side network (R1, 1k, then the
  TVS/blocking-diode chain described below).

Benefit over the discrete PNP: a P-channel MOSFET's R<sub>DS(ON)</sub>
(<75mΩ typ @V<sub>GS</sub>=-4.5V) drops only single-digit millivolts at
VPW's modest bus currents, versus a PNP's typical ~0.2-0.3V V<sub>CE(sat)</sub>
-- better driven-HIGH margin. It also draws no continuous bias current
once settled (a MOSFET gate only needs leakage-level current, not a
BJT's continuous base current), so the bias resistors could be sized an
order of magnitude higher than the old PNP network without hurting
switching speed against VPW's ~64-200us bit timing.

### VPW RX protection network

`J1850_BUS` is exposed directly to the OBD2 harness, so the RX path
(comparator `IN+`) needed real reverse-battery/overvoltage protection,
not just the AP2003 swap. Verified, in signal order from the bus:
- **R1 (1k)** in series between the bus node and the local
  TVS/blocking-diode network -- limits fault current into both, without
  sitting in the TX drive path (so it doesn't cost driven-HIGH margin).
- **D2 (SMF12A)**, unidirectional TVS, standoff 12V, clamps ~19.9V max
  at rated pulse current -- catches large transients right at the local
  node (verified against the Littelfuse SMF-series datasheet).
- **D1 (PMEG4010ESBYL)**, a Schottky, in series toward the comparator's
  `IN+` -- structurally blocks reverse conduction during a negative
  fault (rather than just clamping it a diode-drop above zero), so the
  comparator input can't be dragged negative by an external fault at
  all. V<sub>R</sub> 40V, V<sub>F</sub> negligible at the comparator's
  ~25nA bias current (verified).
- **R2 (10k)** pulldown at the comparator's `IN+` (D1's cathode) --
  required for D1's blocking behavior to work at all: without it,
  `IN+` has no discharge path once D1 reverse-biases and would stay
  latched high after the first HIGH pulse, breaking bit reception. With
  R2, the RC time constant against parasitic capacitance is ~200ns,
  nowhere near VPW's bit timing.
- Net result: TL331's own abs-max input range (-0.3V to +36V, verified)
  comfortably absorbs realistic positive transients that make it past
  D1, while negative faults can't reach the comparator input at all.

### PWM RX protection network

Same underlying problem as VPW (raw harness exposure), but a different
fix, because **TLV7031's input abs-max is only V<sub>CC</sub>+0.3V
(~3.6V here)**, not TL331's generous ±36V -- it's a rail-referenced
CMOS-input part, not a wide-range bipolar one. This was a real
functional bug, not just a fault-hardening gap: the original 10k:100k
input divider only attenuated to ~91%, so a normal ~5V PWM HIGH (the
DRV8837 TX stage runs off 5V) landed around 4.5V at the comparator --
over absolute max during ordinary bit reception, not just during faults.

Fixed by resizing **R6/R14 to 100k** (matching R8/R15, both to GND),
giving a clean symmetric 1:1 divider on both differential inputs -- a
normal 5V HIGH now lands at **2.5V**, comfortably under both TLV7031's
recommended input range (-0.1V to V<sub>CC</sub>+0.1V = 3.4V) and the
added clamp diodes' headroom.

Worth noting for future reference: R15 briefly went to `+3.3V` instead
of GND, traced back to the original OpenJ1850 reference circuit's own
`R_PWM_P_BIAS` (100k to `USB_3V3`, a fail-safe idle-state bias). In the
reference that resistor is paired with a **10k** series resistor (a
10:1 ratio, so the bias only pulls ~9% of the node) -- gentle enough not
to matter much. Once the series resistor here became 100k (1:1 ratio)
to fix the abs-max problem, the same bias resistor started pulling half
the node's voltage instead of a tenth, driving V+ to ~4.15V at a normal
5V HIGH -- reintroducing the exact over-voltage problem the resize was
meant to fix. Fixed by moving R15 back to GND, matching R8.

Per-line clamps: **U2/U4 (MM3Z3V3BW)**, one zener per differential
line, downstream of the R6/R14 divider. Chosen over a small dual-channel
ESD/TVS array (ESD7C3.3DT5G-MS was evaluated first) because this node
is already current-limited by the 100k series resistors (a sustained
+14V fault through 100k into a ~3.3V clamp is only ~0.1mA) -- at that
current level, a zener's tighter voltage tolerance matters more than a
TVS's higher energy handling. **Verified**: genuine 3.3V zener
(V<sub>Z</sub> 3.23-3.37V @5mA, ~2% tolerance) -- but note it has no
pulse-current rating at all (300mW max dissipation only), unlike a real
TVS. Fine here specifically because the 100k series resistors already
keep fault current at this node to sub-mA levels.

**Hysteresis**: R16 (4.7M) feeds `OUT` back to the `+` input
(non-inverting, genuine positive feedback -- confirmed correct polarity,
reinforces whatever state the output is already in rather than
oscillating). Sized against R14/R15 (100k each) to give roughly
±35mV of hysteresis at the input node (~2.8% of the 2.5V signal swing)
-- enough to reject chatter from noise sitting near the threshold
(realistic in a vehicle harness) without eating meaningfully into the
signal margin. Purely resistive feedback, so it adds zero propagation
delay on top of TLV7031's own ~3us.

**Output protection**: `OUT` (pin 4) has the *same* tight V<sub>CC</sub>+0.3V
abs-max as the inputs -- it's not inherently more tolerant just because
it's an output. Unlike `J1850_VPW_RX` (TL331's open-collector output is
rated 0-36V, needs nothing extra), `J1850_PWM_RX` gets **D3 (SMF3.3)**
as a clamp downstream of the series resistor R11 (100R). Driven by the
original single 15-pin connector design putting logic signals directly
adjacent to power-rail pins -- since fixed at the connector-architecture
level too (see below), but kept as belt-and-suspenders. **Verified**:
Littelfuse SMF-series TVS (its own document, distinct from the
SMF5.0A-100A family table), V<sub>RWM</sub> 3.3V standoff, clamps to
6.8V@30A (10/1000us).

### Rail protection

Separate `Protection` block, one TVS per supply rail, each rated to
match its rail's nominal voltage -- **all three now confirmed the same
Littelfuse SMF 200W family** (D5 was briefly SMAJ5.0A, a different
die/package family, before being swapped for SMF5.0A):
- **D4 (SMF3.3)** on `+3.3V` -- V<sub>RWM</sub> 3.3V, clamps 6.8V@30A.
- **D5 (SMF5.0A)** on `+5V` -- V<sub>RWM</sub> 5.0V, breaks down
  6.40-7.00V, clamps 9.2V@21.7A.
- **D6 (SMF7.0A)** on `+7V` -- standoff exactly 7.0V (matches the rail),
  breaks down 7.78-8.60V, clamps to 12.0V max at rated pulse current.
  Every downstream part on this rail has comfortable headroom over that
  clamp (AP2003 P-ch 20V, TL331 36V supply, LMR64010 SW pin 40V), so a
  real transient event doesn't cascade damage.
- **D8 (SMF7.0A)**, same part, additionally placed right at the boost
  converter's own output (`+7V`, near C10) -- redundant with D6 but
  harmless, protects close to the source as well as on the shared rail.

All three now confirmed the same Littelfuse SMF 200W family (SMF5.0A
swapped in for an earlier SMAJ5.0A on D5, which was a different
die/package family) -- see `docs/datasheets/README.md` for full specs.

### Connector architecture

Originally one combined 15-pin header carrying every signal (power
rails, ESP32-facing logic, and raw vehicle-bus pins all mixed together)
-- a real mis-mate/short hazard given a 3.6V-rated comparator output
sitting pins away from a +7V rail. **Split into four physical
connectors** instead:
- `POWER` (U5): `+3.3V`, `+5V`, `+7V`, GND -- supply only.
- `ESP32` (U8): `J1850_PWM_TX_EN`, `J1850_PWM_TX_P`, `J1850_PWM_TX_N`,
  `1850_PWM_RX`, `J1850_VPW_TX`, `J1850_VPW_RX` -- logic-level only,
  nothing above 3.3V present on this connector at all.
- `OBD2` (U7): `PGND`, `1850_PWM_PLUS`/`1850_PWM_MINUS` (TX-side,
  driven by the DRV8837), `J1850_PWM_MINUS`/`J1850_PWM_PLUS` (RX-side,
  into the TLV7031), `J1850_BUS` (VPW, single wire, TX and RX share one
  net since VPW is a single-wire bus).

This removes the mis-mate risk at the root rather than needing per-pin
clamps to compensate for it -- no connector on this board carries both
a power rail and a sub-4V-rated logic pin.

The PWM TX-side nets (`1850_PWM_PLUS`/`MINUS`, driven by U6/DRV8837)
and RX-side nets (`J1850_PWM_PLUS`/`MINUS`, into U3/TLV7031) land on
four separate `OBD2` connector pins by design -- confirmed intentional:
they're tied together off-board, at the connector/harness level, not
on the PCB itself.

`GND` and `PGND` (chassis/vehicle-side ground, used at the `OBD2`
connector) are the same net -- drawn with different symbol styles for
clarity, tied together via an explicit short shown near the Connectors
block.

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

## ESP32 pin assignments (confirmed, in `firmware/include/pins.h`)

Physically a separate daughter board (like the CAN transceiver module
already ordered), short wires to the ESP32, same pattern. Picked to
avoid GPIO0/2/12/15 (strapping pins), GPIO6-11 (internal flash, never
usable), GPIO1/3 (UART0/programming), and the existing CAN pins (4, 5):

| Signal | ESP32 pin | Notes |
|---|---|---|
| `J1850_PWM_TX_P` | GPIO13 | DRV8837 IN1 -> OUT1 -> OBD pin 2 |
| `J1850_PWM_TX_N` | GPIO14 | DRV8837 IN2 -> OUT2 -> OBD pin 10 |
| `J1850_PWM_TX_EN` | GPIO27 | DRV8837 nSLEEP: LOW=Hi-Z/RX-only, HIGH=driver enabled |
| `J1850_PWM_RX` | GPIO34 | TLV7031 comparator output (input-only pin, fine for RX) |
| `J1850_VPW_TX` | GPIO26 | to VPW driver transistor (via its bias network) |
| `J1850_VPW_RX` | GPIO35 | TL331 comparator output (input-only pin, fine for RX) |
| `J1850_VPW_MODE_EN` | GPIO25 | **both** "VPW mode active" and "7V boost enable" -- see below |

`J1850_VPW_MODE_EN` does double duty by design: firmware drives it HIGH
when operating in VPW/GM mode, which the daughter board wires directly
to the LMR64010's `SHDN#` pin, enabling the +7V rail only when VPW is
actually in use -- shut down (near-zero quiescent draw) during PWM/Ford
operation, which is the common case given the F150 is the primary
target. **Verified against the LMR64010 datasheet** (SNVS736B, see
`docs/datasheets/`): `SHDN` threshold is device ON at >=1.5V, device OFF
at <=0.5V, confirming HIGH=enabled/LOW=shutdown as assigned above.
Absolute max `SHDN` voltage is VIN+0.3V and bias current is ~0-2uA, so
GPIO25's 3.3V drive is safe directly, no level-shifter needed.

## Datasheets verified (as of 2026-08-26)

**Every part on the current schematic is now datasheet-verified** --
full findings in `docs/datasheets/README.md`: DRV8837, TLV7031, TL331,
LMR64010, AP2003, SMF12A/SMF5.0A/SMF7.0A, SMF3.3, MM3Z3V3BW,
PMEG4010ESBYL. Notably: TLV7031 (PWM RX) is push-pull, TL331 (VPW RX)
is open-collector and needs an external pull-up (R3, present) -- these
two comparators aren't interchangeable if substituting parts later.
TLV7031's input/output abs-max is tightly rail-referenced
(V<sub>CC</sub>+0.3V) unlike TL331's wide ±36V range -- drove the PWM
RX divider resizing and added clamps documented above. No 5V<->3.3V
level shifters needed anywhere on the board: DRV8837 and TLV7031 both
run their logic domains from 3.3V already, TL331's open-collector
output pulls up to 3.3V (not 7V), and the VPW TX interface (now AP2003)
is fully enhanced well below 3.3V on its gate.

**Superseded**: FDN335N and MMBT2907ALT1G (the original discrete VPW TX
pair, consolidated into AP2003) and SMAJ5.0A (briefly on the +5V rail
clamp, swapped for SMF5.0A to keep the rail-protection TVS family
consistent). Datasheets kept in `docs/datasheets/` for reference.

## Open items before ordering/building

- Component sourcing: full updated BOM (AP2003, MM3Z3V3BW x2, SMF3.3
  x2, SMF5.0A, SMF7.0A x2, plus the original DRV8837/TLV7031/TL331/
  LMR64010/passives) -- parts not yet ordered.
- The main 12V-domain reverse-battery protection (a resettable PTC
  fuse on B+ ahead of a TVS) lives on the **ESP32 board, not this
  daughter board** -- out of scope here, not yet reviewed. Worth
  checking the TVS's pulse rating against realistic fault current over
  the PTC's trip time (PTCs are relatively slow, often tens of ms) once
  that schematic's available.
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
