# Component datasheets

Reference datasheets for parts used in the project's hardware, kept
alongside the design docs (`docs/j1850_multiprotocol.md`,
`docs/wiring.md`, `docs/teensy_daq.md`) that cite them.

## J1850 (PWM + VPW) daughter board

All six components verified against their actual datasheets 2026-08-25 --
design confirmed consistent, no changes needed.

| Part | File | Role | Verified findings |
|---|---|---|---|
| LMR64010 | `LMR64010.pdf` | Boost converter, USB 5V -> +7V for the VPW driver | `SHDN` threshold: ON >=1.5V, OFF <=0.5V -- confirms HIGH=enabled/LOW=shutdown as wired to `J1850_VPW_MODE_EN` (GPIO25). Max `SHDN` voltage VIN+0.3V, bias current ~0-2uA -- safe to drive directly from a 3.3V GPIO. |
| DRV8837 | `DRV8837.pdf` | H-bridge driving the PWM differential output | VM range 0-11V (our 5V is fine), VCC (logic) range 1.8-7V (our 3.3V is fine), max logic input voltage 5.5V -- ESP32's 3.3V GPIOs drive IN1/IN2/nSLEEP directly, no level-shifter. `nSLEEP` has an internal pulldown resistor (defaults to sleep/Hi-Z if the GPIO floats during boot -- safe default). |
| TLV7031 | `TLV7031.pdf` | Comparator, PWM receive | **Push-pull output** (no external pull-up needed). Supply range 1.6-6.5V (our 3.3V is fine). 3us propagation delay -- a real fraction of J1850 PWM's short bit times, not a blocker but worth remembering during bring-up given the reference schematic's own "PWM is experimental" caveat. |
| TL331 | `TL331.pdf` | Comparator, VPW receive | **Open-collector output** -- genuinely different from the TLV7031, requires an external pull-up. Confirmed the reference schematic already has one (`R197`, 10k to 3.3V) -- design is correct as-is. Supply range 2-36V comfortably covers the +7V rail. |
| MMBT2907ALT1G | `MMBT2907ALT1G.pdf` | PNP transistor, VPW transmit driver | V(BR)CEO -60V, continuous IC -600mA -- massive headroom over this 7V/low-current application. Turn-on/off switching times in the tens of ns, comfortably fast for VPW's bit timing. No concerns. |
| FDN335N | `FDN335N.pdf` | N-channel MOSFET, VPW TX interface stage (Q2) | Logic-level part explicitly specified down to V<sub>GS</sub>=2.5V (R<sub>DS(ON)</sub> 0.100Ω typ at that gate voltage); V<sub>GS(th)</sub> max 1.5V -- ESP32's 3.3V GPIO fully enhances it with margin, no level-shifter needed. V<sub>DSS</sub> 20V / I<sub>D</sub> 1.7A continuous is far beyond what this low-current interface role needs. Confirms the "no 5V<->3.3V level shifters needed anywhere on this board" conclusion. |
