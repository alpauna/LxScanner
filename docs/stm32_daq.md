# STM32H7 + AD7606 custom DAQ

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

## Architecture

- **ADC**: AD7606 family (Analog Devices) -- 8-channel *true*
  simultaneous sample-and-hold (independent S&H per channel, unlike the
  Hantek's shared/muxed ADC), 16-bit, up to 200kSPS/channel, native
  ±5V/±10V input ranges. Hobbyist-usable breakout modules exist
  (~$30-50) -- not a bare chip needing a custom 4-layer PCB to start.
- **MCU**: STM32H7 -- native USB High-Speed (480Mbps). RP2040/RP2350 was
  considered and ruled out: USB Full-Speed (12Mbps raw) is already at or
  past the limit for even modest 8-channel streaming rates.
- **Continuous streaming, not one-shot bursts** -- this is the actual
  fix for the memory-depth problem. The STM32 free-runs the ADC
  (timer-triggered CONVST, DMA-driven readout) and streams sample blocks
  over USB continuously. Memory depth becomes "however much the host
  wants to buffer," not a fixed onboard limit.
- **Analog front-end**: per-channel resistor divider + TVS/Zener clamp
  into the AD7606's native ±10V range -- the same well-trodden approach
  commercial automotive attenuator probes use, not exotic design.
  Larger signals (0-40V sensors, 400V+ ignition primary) go through
  external attenuator probes (same 10:1/20:1/100:1 convention already in
  use), same as any commercial scope -- the board itself doesn't need to
  tolerate hundreds of volts directly.
- **Reference project**: [yildi1337/DAQv2](https://github.com/yildi1337/DAQv2)
  (STM32H7 + AD7768-family + USB-HS, built after hitting the same
  USB-Full-Speed wall) is the closest existing architecture found. No
  ready-made STM32H7+AD7606 project exists -- this is a real build.

## Backend integration (zero frontend changes)

The entire Scope tab (cursors, pan, zoom, Time/div + Volts/div +
per-channel Range/Attenuation, Recalibrate button, disconnect banner,
resolution warning) was built against the abstract `ScopeDriver`
interface (`backend/app/scope/driver.py`) and the
`ScopeBatch`/`scope_status` wire format (`backend/app/models.py`), not
Hantek-specific details. A new `Stm32DaqDriver` implementing the same
interface plugs in with `LXSCANNER_SCOPE_SOURCE=stm32daq`, same pattern
as `=hantek` today -- no frontend changes needed if the interface
contract is honored.

## Phased plan

1. **Now (no hardware)**: this doc, wire-protocol design on paper
   (framed binary blocks, similar shape to `ScopeBatch`), firmware
   project scaffold (`firmware-stm32/`, build config only, no
   peripheral-driving logic), order Nucleo-H743ZI2 (~$25) + one AD7606
   breakout (~$40).
2. **Bring-up (once boards arrive)**: SPI comms to the AD7606
   (single-channel single-shot, verify CONVST/BUSY timing against the
   datasheet), multi-channel simultaneous sampling, basic USB streaming
   to a plain host script (validate real throughput -- start with USB
   CDC-ACM for simplicity, only move to a custom vendor bulk class if
   CDC overhead actually turns out to matter). Validate against the same
   known references already used for the Hantek: the 2V/1kHz square
   wave and the 24VAC transformer -- and cross-check against the working
   Hantek itself as a second reference instrument.
3. **Backend integration**: `backend/app/scope/stm32daq/driver.py`
   implementing `ScopeDriver`, mirroring `HantekScopeDriver`'s structure
   where it fits, diverging for continuous streaming where it doesn't
   (no burst-mode "request a batch" call to wrap -- more like a
   persistent read loop). Calibration: the Hantek's built-in cal-signal
   trick doesn't carry over (no such reference on this board) -- reuse
   the original bench-supply multi-point DC calibration design instead.
4. **Scale up**: all 8 channels, real automotive bench testing
   (ignition, injector, wideband O2), then custom PCB only after the
   dev-board proof-of-concept validates the architecture.

## Ground rule

No firmware logic gets written speculatively before hardware exists to
validate against. This session found real bugs in "should be right"
protocol assumptions for the Hantek only once actual hardware was
available to test with (the dt/timing formula was off by 77x until
checked against a known signal; a real upstream driver bug only surfaced
once calibration hardware was actually run). Same discipline applies
here.
