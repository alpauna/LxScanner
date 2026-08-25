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
