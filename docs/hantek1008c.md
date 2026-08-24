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
