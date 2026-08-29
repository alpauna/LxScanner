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
- **Wired 2026-08-27** (AD7606C-16 breakout -> Teensy 4.1), 1-DOUTA-line
  hardware-mode serial config per the datasheet's own confirmation that
  all 8 channels can still be read this way ("all channels can be read
  from DOUTA by providing eight 16-bit SPI frames between two CONVST
  pulses"):

  | AD7606C-16 pin | Function | Teensy 4.1 |
  |---|---|---|
  | 12, `RD/SCLK` | SCLK | 13 (`SPI0 SCK`, shares the onboard LED pin -- cosmetic flicker only) |
  | 24, `DB7/DOUTA` | Serial data out, all 8 channels | 12 (`SPI0 MISO`) |
  | 9/10, `CONVST`/`WR` | Conversion start (breakout ties these together on-board, matching the datasheet's own suggested WR-to-CONVST strap) | 14 |
  | 11, `RESET` | Reset | 15 |
  | 13, `CS` | Frames each 16-bit read (software-controlled, not hardware SPI CS -- needed to frame 8 individual reads per burst) | 16 |
  | 14, `BUSY` | High during conversion | 17 |
  | 15, `FRSTDATA` | Flags first-channel data on DOUTA | 18 |
  | 3-5, `OS0`-`OS2` | Oversampling select (wired to GPIOs rather than hardwired, for runtime flexibility) | 19, 20, 21 |
  | 8, `RANGE` | Input range select | 22 |

  Not used: Teensy `MOSI` -- nothing to write to the ADC in hardware
  mode, `SDI` stays hardwired high on the breakout.

  **Static-strap investigation** -- three pins (`PAR/SER SEL` pin 6,
  `STBY` pin 7, `V_DRIVE` pin 23) aren't broken out to the breakout's
  header, initially assumed to need bodge wires soldered directly to
  the fine-pitch LQFP package. Checked each with continuity + powered
  voltage measurement before doing that -- **all three turned out to
  already be correctly configured on-board, zero bodge wires needed**:
  - `V_DRIVE` and `STBY`: both already tied to the board's onboard 3.3V
    LDO.
  - `PAR/SER SEL`: initially read as floating on a continuity-beep
    check (most multimeters only beep under ~50-150ohm), but a proper
    resistance measurement found it's pulled to 3.3V via a populated
    10k resistor, R1. There's an unpopulated R2 pad right next to it --
    same pull-up/pull-down-pair pattern as `REF SELECT`'s R5/R8 (see
    the reference section above). Not needed now, but if parallel mode
    is ever wanted later, desolder R1 and populate R2 in its place.
  - For this first bring-up run, `REF SELECT` stays as-shipped (R5 in
    place, internal 2.5V reference) -- the R5->R8 swap to the external
    ADR4525 reference is a deliberately separate, later change, kept
    isolated from this digital bring-up so only one variable changes
    at a time.

### Phase 1 (once the board arrives -- bring-up, bench-validated)
- **Firmware written 2026-08-27** (`firmware-teensy/src/main.cpp`,
  compiles clean via `pio run`): full reset sequence, `CONVST` pulse +
  `BUSY` poll with timeout, 8-channel read via CS-framed 16-bit SPI
  transfers on `DOUTA` (hardware mode, matching the datasheet's
  confirmation that all 8 channels are readable this way), raw-to-volts
  conversion for the +/-5V range, Serial print at a human-readable rate.
  Internal 2.5V reference for this run (REF SELECT as-shipped, per the
  earlier decision to keep that a separate, later change).
  **Bench-validated 2026-08-27** -- flashed and running on real
  hardware. No `BUSY` timeout or `FRSTDATA` misalignment on any read
  (CONVST/BUSY timing confirmed matching the datasheet), all 8 channels
  return distinct values each frame (confirms the CS-framed 8-channel
  read logic is actually capturing 8 separate conversions, not
  re-reading one channel), and readings are smooth/low-noise rather
  than garbled -- `SPI_MODE1` guess appears correct. All 8 channels
  currently read ~3.52-3.53V with tight, correlated clustering -- as
  expected for floating 1MΩ inputs with no test signal connected yet
  (not a fault). Next: connect a known test signal (the 2V/1kHz square
  wave or 24VAC transformer already used for Hantek validation) to
  confirm the ADC tracks a real signal correctly.

  Upload note: this dev machine was missing the PJRC `00-teensy.rules`
  udev rule, which blocked the automatic USB-based bootloader trigger --
  installed it, then needed a physical USB replug before uploads worked
  without pressing the board's program button each time.

  **SPI mode confirmed against a real signal (2026-08-27)**: connected
  a known +/-1.24V, 1kHz signal (verified independently on an
  oscilloscope, and directly at AD7606 pin 49/V1+, ruling out a wiring
  problem) to Channel 1. Initial reading with the `SPI_MODE1` guess was
  a consistent ~1.9-2x too high (e.g. +2.35V/-2.39V for a true
  +-1.24V signal) -- systematically ruled out RANGE pin instability
  (confirmed steady 0V) and the LSB constant (confirmed correct against
  Table 11) before concluding the SPI mode guess itself was wrong. A
  wrong CPHA shifts every sampled bit by one clock edge, which is
  mathematically a x2 error -- matches exactly what was observed
  (smooth, stable, repeatable, but wrong, not random garbage).
  Switched to `SPI_MODE0` (matches a closer reading of Figure 6: the
  MSB is already valid on DOUTA right as CS falls, before the first
  clock pulse, pointing to leading-edge sampling) -- now reads
  +1.165V/-1.197V against the true +/-1.24V signal, within a few
  percent as expected pre-calibration. SPI mode is now confirmed, not
  a guess.
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
- **Firmware rewritten for binary streaming, 2026-08-29** -- Phase 1's
  human-readable ~5Hz text print replaced with a real wire protocol
  (4-byte sync + sample count + us/sample + raw int16 codes for all 8
  channels + XOR checksum), streamed continuously rather than
  throttled. SPI clock raised from Phase 1's conservative 1MHz to 8MHz
  now that the dead-bug wiring has proven stable. CONVST/BUSY/SPI-read
  logic itself unchanged from the bench-validated Phase 1 code.
  Bench-verified with a standalone script against the same known
  +/-1.24V reference signal: zero checksum failures, dt_us=22 achieved
  (~45.4kHz effective simultaneous per-channel rate), and individual
  frames now show real waveform transition edges within a single
  frame (e.g. a captured rising/falling edge mid-frame) -- a
  qualitative jump from Phase 1's single-point-per-print snapshots,
  since 45kHz sampling a 1kHz signal resolves real shape, not just
  aliased points.
- Finalize the wire protocol based on what Phase 1 actually measured.
- **`backend/app/scope/teensydaq/driver.py` written and bench-verified,
  2026-08-29** -- `TeensyDaqDriver` implementing `ScopeDriver`, mirroring
  `HantekScopeDriver`'s structure (background thread owns the blocking
  I/O, pushes parsed batches into an `asyncio.Queue` via
  `loop.call_soon_threadsafe`; reconnect-with-backoff and `scope_status`
  events reused for the same real-world reason Hantek has them). Parses
  the Phase A binary frame protocol, converts raw codes to volts using
  the AD7606C-16's hardware-mode LSB tables. `set_channel_range` sets
  the one RANGE pin shared across all 8 channels (documented
  simplification, same spirit as Hantek's `sample_rate_hz` being
  informational-only for its own hardware-reality mismatch).
  `pyserial` added to the backend's `scope` extras. Verified standalone
  (no FastAPI app needed) against the known +/-1.24V reference signal --
  correct `scope_status`, correct 22us/sample timing matching the
  firmware, V1 batches showing the same signal with visible transitions
  within batches.
- Calibration: the Hantek's built-in cal-signal trick doesn't carry over
  (this board has no such reference) -- reuse the original bench-supply
  multi-point DC calibration design instead. Revisit an onboard
  reference generator later if convenient.

## External triggering (planned, 2026-08-28 -- not yet built)

**Design principle**: build hardware for the destination, build firmware
in increments. These are two different axes, not in tension -- "start
simple" applies to firmware complexity (prove threshold triggering
before mask matching); it does *not* mean under-provisioning the
hardware (trigger ADC speed/resolution, ring buffer sizing, timing
infrastructure) such that it needs replacing once the firmware
eventually gets more sophisticated. Pick the trigger ADC with the full
end-goal below in mind, then build toward it in firmware steps that
each stay usable and complete on their own.

**Architecture decided so far**:
- A dedicated, independently-clocked single-channel ADC for
  triggering/sync -- not one of the 8 main AD7606 channels, and not a
  simple analog comparator. Rationale: doesn't consume a main
  measurement channel, runs on its own timing independent of the main
  8-channel conversion cycle (faster trigger response than waiting on
  a shared cycle), and being a real ADC (not just a comparator) keeps
  all threshold/pattern logic in firmware rather than needing to build
  that sophistication into analog hardware. Explicitly "almost a 9th
  channel" (could be fully recorded as data later) but scoped for now
  as trigger-only. Needs its own protection (TVS/ESD), sized to
  whatever it's actually meant to see. Part not yet chosen -- send the
  datasheet once picked for the same verification treatment as
  everything else.
- **Ring buffer for pre-trigger capture**: continuously buffer recent
  samples from the 8 main channels even while waiting for a trigger, so
  a captured event includes what led up to it, not just what came
  after -- the standard real-oscilloscope trigger architecture, and
  meaningfully more useful for diagnostics than post-trigger-only
  capture (e.g. seeing a coil begin to arc before it fully discharges).

**End-goal vision**: a "zone"/mask-style trigger, analogous to a
camera's autofocus zone -- specify a tolerance region (not a single
threshold) that a waveform must fall within to trigger, with hysteresis
in *both* amplitude and timing/frequency (a percentage-wide tolerance
band "bolding" the reference waveform above, below, and in time). This
is a real, established test-equipment concept, usually called **mask
testing** or waveform/template testing (used for eye-diagram/signal-
qualification testing on high-end scopes) -- same mechanism, just
triggering *on* conformance to the mask rather than flagging violation
of it.

**Incremental firmware roadmap toward that end goal** (each step a
complete, usable capability on its own -- nothing gets thrown away
climbing the ladder):
1. Simple threshold/edge trigger (single level, single direction) --
   first firmware increment once the trigger ADC is in hand.
2. Timing-sequence trigger (a specific pattern of crossings within
   timing windows, e.g. rising edge then falling edge within X-Y us
   then another rising edge) -- first taste of the timing-tolerance
   dimension, without needing continuous waveform correlation.
3. Amplitude tolerance band -- trigger when the signal stays within a
   percentage envelope around a reference level, rather than a single
   hard threshold. The amplitude half of "bolding" on its own.
4. Full 2D mask/zone trigger -- combine 3 with the timing dimension
   from 2, giving the actual zone/region trigger described above.
   Genuine continuous waveform-correlation/pattern-matching (comparing
   live samples against a stored template) is a further step past this
   if ever needed -- a real DSP problem (similarity metric, real-time
   compute budget, false-positive/negative tuning), not a firmware
   add-on, and only worth building if the mask/zone approach above
   proves insufficient in practice.

### Trigger ADC: ADS8861, and its input protection network

**Part chosen (2026-08-28)**: `ADS8861IDGS` (Texas Instruments), 16-bit,
1MSPS, true-differential SAR ADC. Picked over two other candidates
after working through real trade-offs:
- **AD7980** (Analog Devices): fast (1MSPS) and easy package (MSOP-10),
  but pseudo-differential unipolar 0V-to-V<sub>REF</sub> input only --
  didn't meet the bipolar requirement.
- **AD7682/AD7689** (Analog Devices): genuine bipolar mode
  (-V<sub>REF</sub>/2 to +V<sub>REF</sub>/2), and a bonus -- built-in
  4-/8-channel MUX and sequencer, real room to grow into multiple
  trigger/aux channels later. But only available in LFCSP/WLCSP (no
  MSOP option), a real step down in hand-assembly friendliness, plus a
  4x slower 250kSPS max.
- **ADS8861**: solved all three at once -- true-differential input with
  a *wider* usable range than AD7682's fixed bipolar mode (per the
  datasheet's own diagram: a much larger diamond-shaped input space
  than a "traditional" differential ADC, with a wide 0V-to-V<sub>REF</sub>
  common-mode range independent of the differential signal), MSOP-10
  package confirmed via the `DGS` package suffix (same hand-assembly
  friendliness as AD7980), and full 1MSPS speed (no compromise vs.
  AD7980). No architecture gives up anything here except AD7682's
  built-in multi-channel MUX, which isn't needed for the current
  trigger-only scope.

**Input protection network**, assuming V<sub>REF</sub>=2.5V (adjust
values if a different reference voltage is chosen):

The base datasheet gives only a voltage-only absolute max (-0.3V to
V<sub>REF</sub>+0.3V) with no stated current tolerance -- a real gap
compared to AD7980/AD7682, which both explicitly rated their internal
clamp diodes at ±130mA. Resolved by TI's own application note,
*"Circuit for Protecting Low-Voltage SAR ADC From Electrical Overstress
With Minimal Impact on Performance"* (SBAA372A), written for the
sibling part ADS8860 (same family, same input structure): confirms the
internal ESD diodes tolerate **±10mA continuous**, and provides a
complete worked reference design, validated on real hardware with
*better* AC performance than the ADC's own typical spec (measured SNR
93.3dB / THD -113.7dB vs. typical 92dB / -108dB) -- proof that a
correctly-sized protection network costs nothing in measurement
quality.

Combining that reference design's methodology with this project's
existing 3-stage main-channel philosophy (since TI's example assumes a
benign +-12V op-amp fault, not a genuine automotive coil-discharge
event):
1. **Front TVS**: reuse the same SMCJ-class bidirectional TVS as the
   main AD7606 channels (~33-36V standoff, 1500W peak-pulse-power
   class) -- absorbs the bulk of a real transient's energy, clamping a
   fault to roughly 45-55V residual.
2. **R1 = 10kOhm**, between the TVS and the local clamp diodes, sized
   against the confirmed ±10mA rating: (50V - 2.9V)/10kOhm ~= 4.7mA,
   about 47% of the limit -- comparable margin to the main channels'
   own protection network. Same 1210 case size for pulse-energy
   survivability.
3. **Local Schottky clamp diodes** (BAT54-class, per TI's reference):
   chosen for low forward voltage (~0.3-0.42V), low leakage, and
   *low capacitance* -- diode capacitance is nonlinear with voltage and
   can introduce distortion if too high, a real AC-performance
   consideration beyond just clamping. D1 to REF (or a buffered copy),
   D2 to GND.
4. **Rfilt = 15Ohm**, right at the ADC pins -- TI's own optimized value
   for this exact 1MSPS SAR family (their calculated minimum was
   12Ohm, tuned up via simulation for best settling). Reused directly
   rather than re-derived, since it's already validated on real
   hardware on the same ADC family. Does double duty: final protection
   margin, and settling the SAR ADC's own switched-capacitor sampling
   kickback (a real requirement independent of protection).

Verified via TI's own formula: R<sub>filt</sub> > (V<sub>ADC_in_min</sub>
- V<sub>fD2</sub>) / I<sub>ADC_in_max</sub> = (-0.3V - (-0.42V))/10mA
~= 12Ohm minimum -- 15Ohm clears this with margin, matching TI's own
result exactly.

### Attenuation

Trigger source signals are the same class as the main 8 channels
(automotive signals up to tens of volts) -- confirmed the same
convention already used there applies here too: **external 10:1/20:1/
100:1 probes**, software-selectable ratio (per the existing scope UI
feature), not an on-board switched-ratio network. This meaningfully
simplifies the trigger front-end -- it only needs *one fixed*
attenuation stage sized for whatever amplitude arrives after an
appropriate external probe has already been chosen, the same
relationship the main channels have between their native ADC range and
external probe ratios. No switching hardware (relays/analog muxes) on
the trigger board itself.

**Design decision: reuse R1 (the fault-current resistor) as the
attenuator's series element**, rather than adding a separate stage --
R1 already sits between the TVS and the local clamp diodes; adding a
shunt resistor from that same node does double duty (fault-current
limiting and signal attenuation) without extra series resistance that
would cost settling time on top of what's already there.

**Bias point, not just attenuation**: ADS8861's common-mode range is 0V
to V<sub>REF</sub>, not centered on 0V. A bipolar source attenuated
straight to `AGND` would only use the bottom half of that window (and
go negative, out of range, on the low half-cycle). The shunt resistor
references to **V<sub>REF</sub>/2 (1.25V)**, generated from a clean,
buffered tap off the same reference infrastructure (not a raw resistor
divider off REF) -- centers the attenuated signal in the middle of the
ADC's usable range with equal headroom both directions.

**Sizing**: targeting roughly +-1V swing around the 1.25V bias for a
+-20V post-probe signal (comfortable margin under the 0-2.5V window)
means about 20:1 on-board attenuation. With R1 fixed at 10kOhm:

R<sub>shunt</sub>/(R1 + R<sub>shunt</sub>) = 1/20 -> R<sub>shunt</sub>
~= 10kOhm/19 ~= 526Ohm -> round to a standard **510Ohm or 560Ohm**.

**Open item**: this shunt resistor sits in parallel with the local
clamp diodes' own path during a real fault. The diodes should still
carry the bulk of fault current once conducting (much lower impedance
than the ~530Ohm shunt), so the earlier ~47%-margin fault-current
calculation should hold with only a small addition -- but this needs to
be re-verified with the actual final shunt value once chosen, not
assumed negligible.

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
- **Precision 0-2.5V square-wave test signal generator** (designed
  2026-08-28, not yet built): a self-built, reference-accurate 1kHz/50%
  duty cycle test signal, extending the same "validate against known
  references" discipline used for the Hantek work to a signal the
  project generates itself rather than borrows.
  - **Dedicated, isolated 2.5V reference module**: its own ADR4525 +
    regulator + ferrite-bead filter, physically and electrically
    separate from the ADR4525 feeding the AD7606's `REFIN` -- so the
    generator's own switching transients never reach the ADC's actual
    measurement reference. Confirmed as the right call rather than
    sharing/buffering off the same reference.
  - **Switching mechanism**: a single N-channel MOSFET (`JTD2302`, see
    above) pulls the LMV721 buffer's `+` input to GND through a 100kΩ
    series resistor (`R4`), driven directly by a Teensy GPIO at 1kHz.
    Considered and rejected first: reusing the AP2003-style
    complementary-pair switch *after* the buffer (would fight the
    op-amp's own active output -- sustained contention, imprecise low
    level, wasted power); using an op-amp's own enable/shutdown pin as
    the switch (LMV721N's disabled-output behavior is undocumented in
    its datasheet -- likely high-Z, would leave the "off" state
    floating rather than a clean 0V, and its turn-on/turn-off timing is
    asymmetric enough to distort the duty cycle even if it did work).
  - **Why R4=100k doesn't hurt accuracy despite being a resistor
    divider** (initially flagged as a repeat of the R15/PWM-RX-bias bug
    from the J1850 board, then corrected once the actual values were
    checked): the R15 bug involved two *comparable* impedances (100k
    against 100k, ~50/50 divider, large error). Here R4 sits against
    two very different, both heavily lopsided loads -- the op-amp's
    ~1pA input bias current when the switch is off (voltage drop
    ~100fV, i.e. nothing), and the MOSFET's few-ohm-to-49mΩ
    R<sub>DS(ON)</sub> when the switch is on (divider ratio ~7x10<sup>-5</sup>,
    landing within a few hundred µV of true 0V). R4's own tolerance
    barely matters in either state. The real accuracy floor ends up
    being the LMV721's own offset voltage (0.8mV typ/3.5mV max), not
    the divider.
  - **Buffer**: LMV721 in unity-gain follower, output through a 150Ω
    series resistor sized against LMV721's own 38mA min output current
    rating (full temp range) to bound any transient current, negligible
    against the µA-level load this only ever drives (AD7606 input,
    maybe a scope probe).
  - Not yet built or bench-validated -- next step once parts are in
    hand.

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
