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

### Phase 3 (scale up)
- All 8 channels, real automotive bench testing (ignition, injector,
  wideband O2 -- the actual wide-timescale signals that motivated this).
- Only after the dev-board proof-of-concept validates the core
  architecture: custom PCB design (proper per-channel analog front-end,
  connectors, enclosure).

## Ground rule

No firmware logic gets written speculatively before hardware exists to
validate against. This session found real bugs in "should be right"
protocol assumptions for the Hantek only once actual hardware was
available to test with (the dt/timing formula was off by 77x until
checked against a known signal; a real upstream driver bug only surfaced
once calibration hardware was actually run). Same discipline applies
here.
