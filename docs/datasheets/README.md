# Component datasheets

Reference datasheets for parts used in the project's hardware, kept
alongside the design docs (`docs/j1850_multiprotocol.md`,
`docs/wiring.md`, `docs/teensy_daq.md`) that cite them.

## J1850 (PWM + VPW) daughter board

| Part | File | Role | Status |
|---|---|---|---|
| LMR64010 | `LMR64010.pdf` | Boost converter, USB 5V -> +7V for the VPW driver | Added -- `SHDN` polarity verified against it (see `docs/j1850_multiprotocol.md`) |
| DRV8837 | -- | H-bridge driving the PWM differential output | Not yet added |
| TLV7031 | -- | Comparator, PWM receive | Not yet added |
| TL331 | -- | Comparator, VPW receive | Not yet added |
| MMBT2907ALT1G | -- | PNP transistor, VPW transmit driver | Not yet added |

Add more here as they're sourced -- same pattern as `LMR64010.pdf`.
