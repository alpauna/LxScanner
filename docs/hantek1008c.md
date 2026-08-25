# Hantek 1008C integration notes

There is no vendor SDK for the 1008C, and no official sigrok/OpenHantek
support (a 2019 request was closed WONTFIX; sigrok's wiki still lists it as
"planned"). OpenHantek6022 targets a different chip/product line (the
6022BE, Cypress FX2-based) and does not apply here.

The only usable prior art is the reverse-engineered Python driver
[`mfg92/hantek1008py`](https://github.com/mfg92/hantek1008py) (Apache 2.0).
Its own README notes the reverse engineering was only done to the extent
needed for a thesis, doesn't cover every config option, and the author no
longer has hardware to maintain it against -- so budget real bench time
against your specific unit rather than assuming it "just works."

Key protocol facts baked into the phase-4 plan:

- Plain USB control/bulk transfers, 64 bytes max per transfer. No
  Cypress-style firmware upload step (unlike the 6022 series) -- it
  enumerates with stock firmware.
- **The device auto-disconnects if it doesn't receive a command within 7
  seconds.** The driver needs a background keepalive thread even when idle.
- Max sample rate drops sharply as more channels are enabled: ~2.4 MS/s at
  1 channel, ~1.2 MS/s at 2. Budget well under that per-channel with all 8
  enabled, and verify empirically on the bench.
- ADC zero-offset is temperature-dependent, so calibration/zeroing needs to
  happen at runtime, not once at startup.

**First bring-up step when phase 4 starts**: run `mfg92/hantek1008py`'s own
example scripts directly against your unit *before* building the
`ScopeDriver` wrapper, to confirm the RE'd protocol actually works against
your specific 1008C revision.

## Bring-up results (2026-08-25, real hardware)

Done ahead of schedule since the scope was already plugged in. Findings:

- **USB permissions**: the device node is `root:root` by default on Linux
  and `pyusb` can't open it without a udev rule. Fixed with
  `/etc/udev/rules.d/99-hantek1008c.rules`:
  `SUBSYSTEM=="usb", ATTR{idVendor}=="0783", ATTR{idProduct}=="5725", MODE="0666", GROUP="plugdev"`,
  then `sudo udevadm control --reload-rules && sudo udevadm trigger` and a
  replug. Confirmed VID:PID `0783:5725` matches the driver exactly
  (descriptor strings read back as `YDJ-2088`, an unbranded OEM string).
- **Missing init step**: `connect()` alone only opens the USB endpoints.
  You must also call `dev.init()` before requesting samples, or channel
  voltage conversion throws (`get_zero_offset` asserts on `None`) --
  `init()` is what runs the zero-offset/calibration sequence
  (`_init1`/`_init2`/`_init3`). Not obvious from `Hantek1008Raw.connect()`
  alone; only found by reading `csvexport.py`'s own `connect()` helper.
- **The 4 hardcoded assertions in `_init3()` (commands `0xe5`, `0xf7`,
  `0xf8`, `0xfa`) all failed against this unit**, exactly as the README
  warned. Comparing the byte patterns (they look like per-channel
  gain/offset tables, not fixed protocol values) confirms these are
  **per-unit factory calibration data read back from the device's own
  EEPROM**, not a protocol constant -- i.e. the original author's
  `assert response == <hardcoded bytes>` was capturing calibration data
  specific to *their* unit and asserting it as if it were universal. This
  is a driver bug, not a real compatibility problem. Relaxing these four
  asserts to a warning log (instead of failing) let the rest of init and
  every subsequent capture complete normally with valid data.
- **Both roll mode and burst mode work, with all 8 channels active**:
  - Burst mode, `ns_per_div=500_000` (default), 8 channels: 500
    samples/channel in ~0.43s per capture call.
  - Roll mode, `sampling_rate=440`, 8 channels: works, but batches are
    tiny (3 samples/channel per read) since throughput is divided across
    all 8 channels -- confirms the documented per-channel-count
    throughput scaling.
  - Channels 1-7 (0-indexed) read near-zero millivolt noise as expected
    for floating/unconnected inputs. Channel 0 read a constant ~31.9V,
    which needs checking before trusting any single-channel capture --
    either something is actually connected to that input, or the
    calibration mismatch above is producing a bad zero-offset/scale for
    that specific channel. Worth an empirical check (known voltage on
    channel 0) before building the `ScopeDriver` wrapper on top of this.

**Net effect on the risk assessment**: the core acquisition path (init,
8-channel burst capture, 8-channel roll capture) works against this
specific unit once the calibration-mismatch assertions are relaxed. The
7-second keepalive requirement and true max sustained sample rate under
continuous streaming (as opposed to one-off capture calls) still need
validation before the `ScopeDriver` wrapper is built.

## ScopeDriver integration (2026-08-25)

`backend/app/scope/hantek1008/driver.py` implements `ScopeDriver` on top of
the vendored driver: burst-mode captures run back-to-back on a background
thread (pyusb is blocking) and cross into asyncio via a queue. Verified
live end-to-end: `LXSCANNER_SCOPE_SOURCE=hantek`, connect a client to
`/ws/stream/scope`, and channel 0 (the 24VAC transformer signal) visibly
oscillates batch-to-batch, confirming this is a live changing waveform
flowing through the real backend, not a frozen reading.

**Range/vscale gotcha found during this test**: the hardware only offers
three vertical scale factors (0.02, 0.125, 1.0), and `driver.py` maps a
requested `range_v` to the nearest one (`_nearest_vscale`). The driver's
default per-channel `range_v` is 5.0, which maps to the 0.125 (more
sensitive, narrower-range) scale -- correct for typical automotive sensor
signals (most are 0-5V), but it visibly clips/distorts a signal as large
as the 24VAC transformer (~34V peak): readings came back in the
single-digit volts range instead of the correct ~±30V. Explicitly
configuring that channel with `range_v=40` (mapping to the 1.0 scale) via
`configure_channels()` fixed it and matched the earlier raw bench-test
readings. **Any channel expected to see more than a few volts (ignition
primary, injector drivers, this transformer test signal, etc.) needs its
range configured wider than the 5V default before capturing it** -- there
is no REST/UI control for this yet (still TODO), only the
`configure_channels()` method itself.

## dt/timing bug found and fixed (2026-08-25)

The frontend's time/div and voltage-cursor-derived frequency readings were
wrong, discovered using a real 2V-peak 1kHz square wave (verified against
an independent scope) fed into one channel. Root cause: `driver.py`
originally computed `dt = wall_clock_call_duration / n_samples`. That's
wrong -- the wall-clock duration of a `request_samples_burst_mode()` call
is dominated by USB/protocol overhead (the readout is ~125 separate
64-byte transfers, each with a mandated 2ms inter-transfer sleep in the
vendor driver's `__write_and_receive`), not real sample timing. Measured
against the known 1kHz square wave: raw samples showed a clean ~50-high/
~50-low repeating pattern (100 samples/cycle), so the true rate is
`(1/1000s) / 100 = 10us/sample`. The old wall-clock-based estimate gave
~779us/sample at the same settings -- **~77x too slow** -- which explains
both symptoms reported: the waveform looked corrupted (a 1ms period
signal displayed as if its period were ~77ms is unrecognizable) and the
frontend's auto time/div kept landing on a huge fixed-feeling value (the
4000-sample rolling buffer, at the inflated dt, appeared to span several
seconds instead of tens of milliseconds).

Fix: derive `dt` from the device's configured window instead of wall-clock
timing. Empirically, a burst capture spans a fixed time window of
`ns_per_div * 10` regardless of channel/sample count (500 samples/ch at
the default `ns_per_div=500_000` with 8 channels gives exactly the
10us/sample computed above: `500_000ns * 10 / 500 = 10_000ns = 10us`).
`_BURST_DIVS = 10` and `dt = (ns_per_div * _BURST_DIVS / 1e9) / n_samples`
in `driver.py` now uses this. **Only verified at the default
ns_per_div/8-channel configuration** -- if `ns_per_div` or active channel
count changes, re-verify against a known-frequency signal before trusting
the timebase.

## Voltage calibration (2026-08-25)

With the dt fix in place, waveform shape and timing were confirmed
correct, but the measured *amplitude* was still off (~2.22V measured vs.
a known 2.00V peak reference -- ~11% high). Root cause: the vendor
driver's raw-to-volt conversion (`__raw_to_volt` in vendor.py) uses a
fixed nominal gain constant (`0.01 * vscale`), not one calibrated for
this specific unit. Since this unit's calibration EEPROM already reads
differently from the reference unit the driver was written against (the
four mismatched `_init3()` bytes noted above), its actual analog
front-end gain is plausibly off by a similar margin, and nothing
compensates for that without real per-unit calibration data.

Fix: a two-part calibration pipeline, mirroring upstream csvexport.py's
`--calibrate`/`-c` flow but adapted to run against our patched vendor
driver and, more conveniently, against the Hantek 1008C's own built-in
2Vp-p 1kHz calibration/probe-comp output rather than an external bench
supply. That output is a single pin (confirmed 0V-2V unipolar,
ground-referenced), moved by hand between channels -- but since it's a
clean two-level square wave, one burst capture gives both the 0V and 2V
calibration points at once (thresholded at the midpoint, each half
averaged), with no need to dial in different DC voltages per point:

- `backend/scripts/calibrate_hantek.py` -- interactive script you run
  yourself (physical access to move the cal output's wire is required,
  so this can't be automated). Prompts once per channel to connect the
  cal output there, captures a burst, splits it into high/low levels,
  and writes `backend/data/hantek_calibration_raw.json`. Currently
  calibrates only at vscale 0.125 (matching `HantekScopeDriver`'s
  default `range_v=5.0`) -- re-run for a different vscale/range if you
  routinely capture larger signals with a different `range_v`.
- `driver.py::_load_correction_data` -- loads that file (if present),
  converts each calibration point into a `correction_factor` using the
  same formula as upstream (`test_voltage / (units * 0.01 * vscale)`),
  and passes the result as `correction_data` into the `Hantek1008`
  constructor. Falls back to nominal (uncalibrated) scaling with a
  logged warning if no calibration file exists yet -- this is the
  current default state until the script above is run.

**Two more real bugs found running this for the first time:**

1. The script's `input()` waits (while you physically move the cal
   output's wire between channels) took longer than the device's
   7-second keepalive timeout with no commands being sent, causing a USB
   disconnect (`usb.core.USBError: [Errno 19] No such device`) partway
   through the first run -- and the already-measured channel's data was
   lost because `device.close()` also failed against the now-gone
   device, crashing before the output file got written. Fixed: the
   script now runs `device.pause()`/`cancel_pause()` around each
   `input()` wait (keeping it alive indefinitely), and file-saving no
   longer depends on `device.close()` succeeding. It's also resumable --
   re-running loads already-calibrated channels from the existing output
   file.
2. **A real upstream bug** in `vendor.py`'s
   `__calc_correction_factor`: when a channel/vscale has exactly one
   correction point (the normal case here -- the 0V point is
   intentionally excluded from `correction_data`, matching upstream's
   own convention), it did `channel_cd[0]`, indexing a dict keyed by raw
   ADC delta values (e.g. `1673.19`) as if it were a list -- guaranteed
   `KeyError` unless a point's delta happened to be exactly 0. Fixed to
   `next(iter(channel_cd.values()))`.

**Result, verified live over `/ws/stream/scope` against the known 2V
reference on channel 8**: -0.004V to 2.020V, under ~1% error (down from
~11% before calibration). All 8 channels stream cleanly with the fix.

## Capture window and input range were both silently wrong for real
## signals (2026-08-25)

Found with a real 10x scope probe expecting to see 60Hz mains pickup and
not seeing it. Two separate problems, both now fixed with real UI
controls rather than one-off patches:

1. **Capture window too short for anything below ~1kHz.** The default
   `ns_per_div=500_000` (500us/div) gives only a 5ms total window
   (`ns_per_div * _BURST_DIVS`). A 60Hz signal has a 16.67ms period, so
   a 5ms capture shows well under a third of one cycle -- it looks like
   a flat-ish plateau near whatever point in the cycle got captured, not
   a sine. Worse, the frontend's Time/div selector only *zoomed into*
   the already-captured window -- it never touched the real hardware
   timebase, so there was no way to actually see more than 5ms no matter
   what the UI said. Fixed: bumped the default to `5_000_000` (5ms/div,
   50ms total, ~3 cycles of 60Hz), and added
   `HantekScopeDriver.set_timebase()` / `POST /api/scope/timebase`,
   wired to the Time/div selector so it now reconfigures the actual
   capture window (device reopen, ~1-2s) instead of just zooming.
2. **Signal amplitude exceeding the input range clips before it's even
   digitized.** The default per-channel range (`range_v=5.0` ->
   vscale 0.125, ~±2.5V headroom) is right for typical automotive sensor
   signals but clipped this test signal (~7.7Vpp after 10x probe
   attenuation) hard -- flat plateaus at both rails instead of a sine.
   No amount of volts/div (a display-only zoom) fixes clipping that
   already happened in hardware. Fixed: added
   `HantekScopeDriver.set_channel_range()` / `POST
   /api/scope/channel/{channel}/range` and a per-channel Range selector
   in the UI (±1V / ±5V / ±40V, matching the hardware's actual three
   vscale buckets -- see `_nearest_vscale`).

**Verified against an independent reference scope** after both fixes:
waveform shape, timing, and amplitude all matched.

## USB reconnection (2026-08-25)

There was no recovery path at all if the USB connection dropped -- a
capture failure just logged an exception and the acquisition thread
exited permanently, leaving `/ws/stream/scope` silently going stale with
no indication anything was wrong. Given how many times a lead/cable came
loose over the course of this session's testing, this needed fixing.

`HantekScopeDriver._acquire_loop` now calls `_reconnect_with_backoff()`
on any capture failure instead of returning: closes the stale handle,
retries `connect()`/`init()` with backoff (1.0s, x1.5 per attempt, capped
at 10s) until it succeeds or the driver is stopped, and pushes
`{"type": "scope_status", "connected": bool}` events through the same
queue as `scope_batch` so the frontend can show a real disconnected
state (red banner on the Scope tab) instead of just going stale.

**Verified two ways**: a `dev.reset()` soft USB reset did *not* reliably
reproduce a dropout (didn't interrupt an in-flight transfer). A real
physical unplug/replug of the USB cable did -- observed in the backend
log: `USBError: [Errno 32] Pipe error` -> four backoff retries -> `Hantek
reconnected`, with the frontend's disconnected banner confirmed appearing
and disappearing in sync.

## Single-sample "jump" artifact -- investigated, root cause not yet
## isolated (2026-08-25)

Reported viewing a genuinely clean signal (the 24VAC transformer, same
one used in the very first bring-up test) at 1ms/div: the waveform
showed a sharp near-vertical jump partway through an otherwise-smooth
ramp -- not physically plausible for a 60Hz sine, and specifically a
concern because a diagnostic tool showing a fake transient is actively
misleading, worse than showing nothing.

**Ruled out** (each backed by a direct raw-hardware test, not just a
plausible-sounding theory):

- **Not the batch-concatenation bug from earlier** (the one fixed by
  making each batch replace the display instead of appending). Captured
  raw single-channel data directly from the vendor driver, bypassing the
  whole frontend/backend pipeline entirely -- the jump is present in the
  raw sample array itself, one array, no batches involved.
- **Not cross-channel ADC-mux crosstalk**, despite being a reasonable
  first guess (multiple channels sharing one ADC, time-multiplexed,
  could plausibly bleed into each other). Tested with only channel 1
  active (no other channel to interfere): the jump still occurred
  (2.83V single-sample step, n=4000 samples).
- **Not random electrical noise on the signal**. Ran 6 repeated captures
  at identical settings (1 channel active, 1ms/div): every single one
  had exactly one large jump (>0.3V, physically impossible for this
  signal at this sample rate), and it landed at **sample index 563 four
  times and 565 twice** -- consistent, not randomly distributed. Random
  noise would land at random positions; this doesn't.
- **Not the readout's two-part USB command structure** (`__send_cmd(0xc6/0xa6, parameter=0x02)`
  then `...=0x03)`, concatenated before being split into samples --
  a very plausible seam for exactly this kind of artifact). Called the
  private two-part readout directly: with 1 channel active, the `0x02`
  part came back **empty** and all 4000 samples were in one contiguous
  `0x03` block -- no seam at index 563 to explain it.

**Not yet isolated**: what specifically causes it. Given it's
deterministic (same index, repeatably) but not explained by the known
protocol structure, it's most plausibly an internal, undocumented
behavior of the device's own capture-buffer management (e.g. an internal
DMA/buffer-refill boundary we have no visibility into -- there is no
protocol documentation for this device beyond what's been reverse
engineered) rather than anything in this codebase. Not confirmed either
way with certainty.

**Deliberately not fixed yet**: the obvious mitigation is a despike
filter (detect an isolated single-sample outlier surrounded by two
close-together neighbors, replace it), but silently correcting displayed
data in a *diagnostic* tool is a real decision, not a safe default -- a
naive despike filter can't reliably distinguish "impossible glitch" from
"real fast transient the user specifically needs to see" (an ignition
spark, an injector opening edge, etc.), and hiding the latter would be
worse than the original problem. Needs a decision on the actual approach
(e.g. correct-but-visibly-flag vs. leave raw and document vs. further
investigation into the timing) before implementing anything that alters
displayed values.

## Fixed ~4000-sample memory depth, shared across active channels
## (2026-08-25) -- this is the real reason "60Hz looks good / 1kHz looks
## bad" (or vice versa), not a bug

Directly relevant to why a signal that varies a lot in the time domain
(needing both a wide window to show slow content and fine resolution to
show fast content in the same capture) can look bad: burst-mode capture
has a **fixed total sample budget that does not scale with the requested
time window**, confirmed empirically by sweeping `ns_per_div` from
100us/div to 200ms/div (a 2000x range) with 1 channel active -- every
single setting returned exactly **4000 samples**. Widening the window
doesn't cost you samples; the device just spreads the same fixed budget
across more time (courser `dt`), and narrowing it spreads the same
budget across less time (finer `dt`). This budget is **shared evenly
across active channels**, confirmed separately: 4000 samples/channel at
1 channel active, 2000 at 2 channels, 500 at 8 channels -- consistent
with a genuine fixed hardware memory depth (a very typical "4K-point"
budget spec for a scope in this price class), not a software or protocol
limitation. (One data point, `ns_per_div=100_000_000` (100ms/div), failed
with a protocol handshake error rather than returning data -- a separate,
unexplained issue, not a memory-depth question.)

**Why this explains the reported symptom**: with **8 channels active**,
you only get 500 samples total. A window wide enough to show several 60Hz
cycles (e.g. 50ms) leaves `dt = 50ms / 500 = 100us/sample` -- only ~10
samples per 1kHz cycle layered on top, visibly rough. With only **1-2
channels active**, the same 50ms window gives `dt = 50ms / 4000 = 12.5us`
-- ~80 samples per 1kHz cycle, while still showing multiple 60Hz cycles,
**in the same single capture**. The fix for wanting to see both a slow
and a fast signal well isn't a different timebase setting -- it's fewer
simultaneously active channels, since that's what actually controls the
per-channel sample budget.

**This also means zooming never loses data.** Every pan/cursor/zoom
operation in the frontend operates on the already-fully-captured sample
array for the whole window -- there's no re-capture or decimation
involved. So the right capture strategy is: minimize active channels for
a precision capture, pick `ns_per_div` wide enough to comfortably show
the slowest signal of interest (doesn't cost any resolution to go wider,
per the above), then pan/zoom into whatever sub-region needs a closer
look -- the full-density real data for the entire window is already
there to zoom into.

**Hard ceiling, not fixable by a driver rewrite.** This 4000-sample
budget is the device's physical capture memory, not a limitation of
`mfg92/hantek1008py`'s protocol implementation -- reimplementing the USB
driver from scratch would not change it. If this ceiling turns out to be
a real constraint for the intended use (capturing genuinely
wide-bandwidth automotive signals -- ignition, injector, wideband O2,
etc. -- across many channels simultaneously with real resolution on
fast content), it's a hardware capability question, not a software one.
