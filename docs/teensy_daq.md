# Teensy 4.1 + AD7606 custom DAQ

Why this exists: the Hantek 1008C integration (see `docs/hantek1008c.md`)
is fully working and calibrated, but hit a hard hardware ceiling -- a
fixed ~4000-sample total capture budget shared evenly across active
channels, completely independent of timebase (confirmed empirically:
sweeping `ns_per_div` from 100us/div to 200ms/div always returned exactly
4000 samples at 1 channel active). With 8 channels active that's only
500 samples per channel -- not enough to resolve both a slow signal
(60Hz) and fast content (kHz-range ignition/injector events) in the same
capture. It's a physical memory-depth limit, not something a driver
rewrite can fix.

**The Hantek isn't being replaced as unusable** -- it remains a
legitimate option for anyone who understands its limits, and its
calibration/UI investment carries forward regardless. This is about
building toward genuine diagnostic-grade multi-channel capture.

## MCU choice history (STM32H7 -> Teensy 4.1)

The original plan targeted STM32H7 for its native USB High-Speed
peripheral. That turned out to be a real gap in the initial research:
**no ST Nucleo board** (including Nucleo-H743ZI2, originally suggested,
and the Nucleo-F767ZI actually ordered first) **exposes true USB-HS on
its built-in connector** -- the MCU silicon supports it via ULPI, but
Nucleo boards don't populate the external ULPI PHY chip required, so
they're limited to USB Full-Speed (12Mbps) out of the box. The Morpho
headers do expose the ULPI pins, so an external USB3300 PHY breakout
(~$10-20) is technically wireable, but ULPI runs a 60MHz clock across 12
signal lines -- community reports are clear that breadboard/dupont
wiring at that speed is unreliable; it needs real PCB-quality wiring.

Next candidate: **STM32H747I-DISCO**, confirmed to have a populated
onboard ULPI PHY (USB3320C-EZK) -- genuine HS out of the box, no wiring
gamble. But it turned out to be effectively unavailable (no real stock,
weeks-plus lead time), which was the deciding constraint.

**Landed on Teensy 4.1** (PJRC/SparkFun, NXP i.MX RT1062, 600MHz
Cortex-M7): genuine USB-HS (480Mbps) **built directly into the MCU
silicon** -- no external ULPI PHY needed at all, which is actually a
step better than the STM32H747I-DISCO approach (removes the whole
external-PHY category, not just the wiring risk within it). Well-proven
in the hobbyist community for exactly this class of workload
(high-channel-count simultaneous streaming -- multi-channel
audio/I2S DAQ projects are a common Teensy 4.x use case), 3 SPI buses +
real DMA, and sold directly by SparkFun/PJRC rather than through the
allocation-constrained ST Discovery distribution channel that left the
H747I-DISCO unavailable.

## Architecture

```
 ┌─────────────────────────────┐  USB-HS (native, no    ┌──────────────────────┐
 │ AD7606 (8ch simultaneous S&H)│  external PHY needed)   │  Backend             │
 │  <- per-channel R-divider +  │                         │  (new ScopeDriver     │
 │     TVS/Zener clamp front-end│                         │   implementation,    │
 │     (native ±10V; external   │                         │   same interface     │
 │     10:1/20:1/100:1 probes   │                         │   HantekScopeDriver  │
 │     for larger signals, same │   ┌───────────────────┐ │   already uses)      │
 │     convention as today)     │──▶│  Teensy 4.1        │─│▶ continuous sample   │
 └───────────────────────────────  │  (i.MX RT1062, SPI  │ │   stream, no fixed   │
                                    │   to ADC, DMA,      │ │   buffer ceiling --  │
                                    │   native USB-HS)    │ │   bounded by host    │
                                    └──────────────────────┘   storage instead    │
                                                       └──────────┬───────────┘
                                                                  │ same
                                                          /ws/stream/scope
                                                                  │
                                                       ┌──────────▼───────────┐
                                                       │  Existing Scope UI    │
                                                       │  (cursors, pan, zoom, │
                                                       │  div-scale, recal,    │
                                                       │  reconnect banner --  │
                                                       │  all reused as-is)    │
                                                       └───────────────────────┘
```

**Key design win, unchanged by the MCU swap**: the entire frontend Scope
tab (cursors, pan, zoom, Time/div + Volts/div + per-channel
Range/Attenuation, Recalibrate button, disconnect banner, resolution
warning) was already built against the abstract `ScopeDriver` interface
and the `ScopeBatch`/`scope_status` wire format
(`backend/app/scope/driver.py`, `backend/app/models.py`), not
Hantek-specific details. A new `TeensyDaqDriver` implementing the same
interface plugs in with **zero frontend changes** -- same pattern as
`LXSCANNER_SCOPE_SOURCE=hantek` today, just add `=teensydaq`.

**Continuous streaming, not one-shot bursts**: this is the actual fix
for the memory-depth problem. Instead of the Hantek's "request a fixed
buffer, get back N samples" burst model, the Teensy free-runs the ADC
(timer-triggered CONVST, DMA-driven SPI readout) and streams sample
blocks over USB continuously. Memory depth becomes "however much the
host wants to buffer/record," not a fixed onboard limit.

## Phased plan

### Phase 0 (done -- see firmware-teensy/)
- This doc, wire-protocol design on paper (framed binary blocks, similar
  shape to `ScopeBatch` so the backend-side translation stays thin).
  Teensyduino has USB Serial (CDC-ACM equivalent) built in and easy to
  use -- start there for simplicity, only move to a raw USB bulk
  transfer approach if CDC framing overhead turns out to actually
  matter once real throughput is measured.
- `firmware-teensy/` -- PlatformIO project targeting `teensy41`
  (Arduino/Teensyduino framework), build config + a blink-only skeleton,
  no peripheral-driving logic yet. Compiles cleanly.
- Ordered: Teensy 4.1 (no headers) + the Teyleten AD7606 breakout module
  (16-bit, 8-channel, 200kHz max, user-selectable SPI/parallel
  interface, 3.3V control-signal level -- confirmed from the product's
  manual: pins include AD_SPI_SCK/MISO/CS/RESET/CONVST/RANGE and
  oversample select AD_OS0-2).

### Phase 1 (once the board arrives -- bring-up, bench-validated)
- Basic SPI comms Teensy <-> AD7606: single-channel single-shot
  conversion, confirm CONVST/BUSY timing matches the datasheet.
- Multi-channel simultaneous sampling at a modest rate.
- Basic USB streaming (raw samples to a simple host script, not the real
  backend yet) -- measure actual throughput.
- **Validate against the same known references already used for the
  Hantek**: the 2V/1kHz square wave and the 24VAC transformer. Reusing
  proven ground-truth signals instead of new ones, and cross-checking
  against the working Hantek itself as a second reference instrument
  where useful.

### Phase 2 (backend integration)
- Finalize the wire protocol based on what Phase 1 actually measured.
- New `backend/app/scope/teensydaq/driver.py` implementing `ScopeDriver`
  (`connect`, `disconnect`, `configure_channels`, `set_channel_range`,
  `set_timebase`, `calibrate_channel`, `stream`) -- mirror
  `HantekScopeDriver`'s structure (`backend/app/scope/hantek1008/driver.py`)
  where the pattern fits, diverge where continuous streaming genuinely
  needs a different shape (no burst-mode "request a batch" call to wrap
  -- more like a persistent read loop). `LXSCANNER_SCOPE_SOURCE=teensydaq`
  wired into `app/main.py` the same way `=hantek` is today.
- Calibration: the Hantek's built-in cal-signal trick doesn't carry over
  (this board has no such reference) -- reuse the original bench-supply
  multi-point DC calibration design instead. Revisit an onboard
  reference generator later if convenient.

## ADC choice: bench test on AD7606C-16, switch to AD7606C-18 for the final PCB

Both datasheet-verified in full (`docs/datasheets/AD7606C-16.pdf`,
findings for AD7606C-18 captured in this doc since that PDF isn't kept
on file -- it was never the part actually ordered, just briefly
mis-identified). **Pin-for-pin identical**: same 64-lead LQFP package,
same pin assignments (`REF SELECT` pin 34, `REFIN/REFOUT` pin 42, same
analog input pins, same absolute max ratings, same ±21V analog input
clamp behavior, same reference/decoupling requirements) -- confirmed by
direct side-by-side comparison of both datasheets' pin configuration
and absolute maximum ratings tables.

**Bench/bring-up board**: AD7606C-16 -- already ordered and in hand
(the Teyleten breakout, see Phase 0 above).

**Final PCB**: AD7606C-18 instead, once layout moves past the
proof-of-concept stage. Reasoning, fully verified rather than assumed:
- **No speed penalty** -- both parts share the same 1 MSPS headline
  rate; confirmed from the AD7606C-16 timing table directly
  (t<sub>CYCLE</sub> min = 1us, matching 1 MSPS exactly). This is a SAR
  architecture, not one where resolution and throughput trade off
  within the family the way they do on delta-sigma parts (see the
  LTC2445 rejection below) -- 18-bit costs nothing in speed here.
- **4x finer resolution** for the same input range (e.g., ±5V range:
  152.58uV/LSB at 16-bit vs. 38.1uV/LSB at 18-bit) -- directly useful
  for this project's original motivation (resolving both large and
  subtle signal content in the same capture).
- **Modest, not dramatic, SNR gain**: 93dB (18-bit) vs. 92dB (16-bit)
  on the ±20V differential range -- only 1dB apart, meaning the real
  noise floor (front-end/reference, not pure quantization) is nearly
  identical between the two; the extra resolution mainly buys more
  digital codes below that same noise floor.
- **Zero layout or firmware cost** -- pin-for-pin identical as noted
  above, and same SPI/parallel interface and timing, so everything
  built against the AD7606C-16 (reference network, input protection
  stages, SPI bring-up firmware) carries forward unchanged.
- **Equal price as of 2026-08-26** ($53.12 each) -- no cost trade-off
  either, at least at the time of checking.

**Considered and rejected**: LTC2445 (24-bit, $21.60, cheaper and
higher nominal resolution) -- disqualified on architecture, not price.
It's a multiplexed delta-sigma ADC (all channels scanned sequentially
through one converter via an internal MUX), not simultaneous-sampling
SAR like the AD7606 family -- there is no moment where all 8 channels
are captured at once regardless of speed setting, which matters for
correlating timing between channels (e.g., ignition coil vs. crank/cam
signal). Its own datasheet states all 8 differential channels scan at
just 500Hz in 1x mode, and its noise-vs-speed table shows genuinely
low-noise operation (200nV<sub>RMS</sub>) requires dropping to 13.8Hz
per channel -- 4-5 orders of magnitude slower than the AD7606 family's
1 MSPS simultaneous, in the regime where its extra resolution would
matter. Its own Applications list (weigh scales, thermocouples, DVMs,
direct temperature measurement) confirms it's built for slow/DC
precision measurement, not transient capture -- the wrong category of
part for resolving kHz-range ignition/injector edges, the actual reason
this custom DAQ exists.

### Phase 3 (scale up)
- All 8 channels, real automotive bench testing (ignition, injector,
  wideband O2 -- the actual wide-timescale signals that motivated this).
- Only after the dev-board proof-of-concept validates the core
  architecture: custom PCB design (proper per-channel analog front-end,
  connectors, enclosure).
- **AD7606C-16 layout guidelines** (confirmed from the datasheet's own
  Layout Guidelines section, relevant to the custom PCB): split
  analog/digital ground planes joined in exactly one place, as close as
  possible to the ADC -- matches the plan already decided for the final
  board (single tie-in right next to the ADC). Also: run the analog
  ground plane under the AD7606C-16 itself (no digital lines
  underneath), shield fast-switching signals like `CONVST`/clocks with
  digital ground and keep them away from analog paths entirely (no
  digital/analog crossovers), and place `REFIN/REFOUT`/`REFCAPA`/
  `REFCAPB` decoupling caps as close as possible to their respective
  pins, ideally on the same board side as the ADC.
- **External 2.5V reference** (bring-up board, not yet the final PCB):
  swapping the AD7606C-16's internal reference for an external
  **ADR4525** (2.500V exact match, ±0.02% initial accuracy, down to
  0.8ppm/°C -- datasheet-verified, see `docs/datasheets/ADR4525.pdf`)
  via a small daughter board + 3 short flying wires (5V, GND, filtered
  V<sub>OUT</sub>). Requires flipping `REF SELECT` (pin 34) from its
  as-shipped high strap (internal reference) to GND (external
  reference) -- without that, the internal reference stays active and
  the external one has no effect. Daughter board carries a full π
  filter (1µF -- ferrite bead ~10Ω@100MHz -- 1µF) on the reference
  output before the flying wire, satisfying both ADR4525's own required
  output-stability cap and general noise filtering in one design. The
  AD7606C-16's own required decoupling (100nF at `REFIN/REFOUT`, 10µF
  at `REFCAPA`/`REFCAPB`, the latter already present on the breakout
  and confirmed present via measurement) stays regardless of reference
  source.
- **Analog input protection** (bring-up board): the AD7606C-16 has
  built-in clamp protection per channel (transparent up to ±21V, clamps
  above that) and its datasheet explicitly recommends an external
  series resistor -- matched on both Vx+ and Vx- -- to hold fault
  current under the ±10mA absolute max for inputs beyond ±21V. That's
  sufficient for ESD-class events but not for genuine inductive
  discharge (e.g. accidentally probing an ignition coil or injector) --
  the on-chip clamp alone has no dedicated energy-absorbing element.
  Designed a 3-stage cascaded network per channel, cost not a
  constraint, targeting real coil-class transients (order of a few
  hundred volts, not just ESD-level):
  1. **SMCJ-class bidirectional TVS** at the input connector (~33-36V
     standoff -- clear of the ADC's full native ±20V range -- 1500W
     peak-pulse-power class) absorbs the bulk of a real transient's
     energy before it reaches anything else.
  2. **6.8kΩ series resistor, 1210 case size, matched on both legs**
     (per the datasheet's own offset-matching recommendation) -- limits
     current into the chip's internal clamp with real margin (~5mA
     headroom under the residual voltage past Stage 1), while staying
     small enough to keep 1MΩ input-impedance loading and Johnson-noise
     contribution negligible. Larger case size than a standard 1206 for
     better pulse-energy survivability of the resistor itself.
  3. **SMA-style bidirectional TVS** (~24V standoff) right at the ADC
     pin as a fast, low-capacitance backup to the chip's own internal
     clamp -- coordinated cascaded protection, the same philosophy used
     in real bench-instrument (scope/DMM) input protection.
  Component datasheets for this network not yet obtained -- verify
  clamping voltage, response time, and capacitance against this design
  once specific part numbers are picked.

## Future consideration: Ethernet instead of/alongside USB

Noted 2026-08-25, deliberately deferred -- USB is the right starting
point (simpler bring-up, matches the wire-protocol design above). Worth
exploring later: **the Teensy 4.1 has a built-in Ethernet PHY on-board**
(a 4.1-specific feature, absent on the 4.0) -- QNEthernet or
NativeEthernet libraries give real 100Mbps Ethernet with no extra
hardware purchase needed to try it. Potential upside for an in-vehicle
deployment: more robust/longer cable runs than USB, no host USB-driver
quirks, and PoE-style remote power delivery is possible over Ethernet if
useful for a permanently-mounted setup. Not needed for Phase 1/2
bring-up -- revisit once the USB-based streaming path is proven and if
real deployment needs (cable length, robustness) actually call for it.

## Decision: keep the ESP32 (CAN) and this DAQ (scope) as separate
## devices, not consolidated onto one chip

Considered and deliberately rejected 2026-08-25: moving CAN/OBD2
handling onto the same RT1062/Teensy 4.1 that runs the scope DAQ. The
chip is technically capable (FlexCAN peripherals on-board, plenty of
600MHz M7 headroom -- CAN's light interrupt-driven load wouldn't
meaningfully compete with ADC/USB streaming), but the two subsystems
have genuinely different physical deployment models:

- The ESP32 OBD2 scanner is meant to live *at the OBD2 port*, wireless
  over WiFi, independent of wherever the laptop sits -- mountable in the
  vehicle (see `docs/wiring.md`).
- This DAQ is a *bench instrument*, USB-tethered to the laptop for
  hand-probing specific signals -- current setup is bench-only, not an
  in-vehicle deployment.

Consolidating them would mean either running a physical USB cable from
the OBD2 port to the laptop (impractical in a vehicle) or adding a
separate WiFi module to the RT1062 board just to recover what the ESP32
already does natively (i.MX RT1062 has no built-in WiFi, unlike ESP32).
It would also couple two firmware codebases with different timing
characteristics (CAN interrupt handling vs. DMA-driven ADC/USB
streaming) right as the DAQ's own bring-up is already the ambitious
part -- the project has worked well so far specifically because OBD2/CAN
and scope capture stayed cleanly separated.

**Revisit later, not now**: a "condensed" single-board version
(consolidated chip + WiFi, for a permanently-mounted in-vehicle unit
combining both) is a real future direction worth exploring -- but only
after the separated bench architecture (ESP32 for CAN, this DAQ for
scope, merged in the web app) is actually proven out. Both devices
already unify cleanly in the backend today (`OBD2Source` and
`ScopeDriver` interfaces), so this stays purely a hardware-consolidation
question, not an app-architecture one, whenever it comes up again.

## Ground rule

No firmware logic gets written speculatively before hardware exists to
validate against. This session found real bugs in "should be right"
protocol assumptions for the Hantek only once actual hardware was
available to test with (the dt/timing formula was off by 77x until
checked against a known signal; a real upstream driver bug only surfaced
once calibration hardware was actually run). Same discipline applies
here.
