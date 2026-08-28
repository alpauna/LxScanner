# Component datasheets

Reference datasheets for parts used in the project's hardware, kept
alongside the design docs (`docs/j1850_multiprotocol.md`,
`docs/wiring.md`, `docs/teensy_daq.md`) that cite them.

## J1850 (PWM + VPW) daughter board

### Verified, in current design

| Part | File | Role | Verified findings |
|---|---|---|---|
| LMR64010 | `LMR64010.pdf` | Boost converter, USB 5V -> +7V for the VPW driver | `SHDN` threshold: ON >=1.5V, OFF <=0.5V -- confirms HIGH=enabled/LOW=shutdown as wired to `J1850_VPW_MODE_EN` (GPIO25). Max `SHDN` voltage VIN+0.3V, bias current ~0-2uA -- safe to drive directly from a 3.3V GPIO. FB pin abs-max -0.4V to +6V, SW pin -0.4V to +40V, input supply -0.4V to +14.5V. |
| DRV8837 | `DRV8837.pdf` | H-bridge driving the PWM differential output | VM range 0-11V (our 5V is fine), VCC (logic) range 1.8-7V (our 3.3V is fine), max logic input voltage 5.5V -- ESP32's 3.3V GPIOs drive IN1/IN2/nSLEEP directly, no level-shifter. `nSLEEP` has an internal pulldown resistor (defaults to sleep/Hi-Z if the GPIO floats during boot -- safe default). |
| TLV7031 | `TLV7031.pdf` | Comparator, PWM receive | **Push-pull output.** Supply range 1.6-6.5V (our 3.3V is fine). 3us propagation delay. **Input AND output abs-max is tightly rail-referenced: V<sub>EE</sub>-0.3V to V<sub>CC</sub>+0.3V** (~3.6V here) -- unlike TL331, this part has no wide-range input tolerance. Drove a real fix: the original 10k:100k RX divider only attenuated to ~91%, letting a normal 5V PWM HIGH exceed abs-max during ordinary operation, not just faults. Resized to 100k:100k (2.5V nominal) plus added zener/TVS clamps -- see `docs/j1850_multiprotocol.md`. |
| TL331 | `TL331.pdf` | Comparator, VPW receive | **Open-collector output**, requires external pull-up (R3, 10k to 3.3V, present). **Input range -0.3V to +36V** (with respect to ground, independent of V<sub>CC</sub>) -- generous positive headroom, unlike TLV7031. Output also rated 0-36V, so `J1850_VPW_RX` needs no extra output protection the way the PWM side does. |
| AP2003 | `AP2003.pdf` | Dual N+P MOSFET pair, VPW TX high-side switch (replaces discrete FDN335N + MMBT2907ALT1G) | **Not** an integrated smart high-side driver -- two independent MOSFET dice (N-ch + P-ch) in one SOT-23-6L package, wired with the same bias-network topology the discrete parts used. N-ch: V<sub>DS</sub> 20V, I<sub>D</sub> 3A, R<sub>DS(ON)</sub><35mΩ@4.5V, V<sub>GS(th)</sub> 0.5-1.2V. P-ch: V<sub>DS</sub> -20V, I<sub>D</sub> -3A, R<sub>DS(ON)</sub><75mΩ@-4.5V, V<sub>GS(th)</sub> -0.4 to -1V. \|V<sub>GS</sub>\| max 12V both. At VPW's modest bus currents, R<sub>DS(ON)</sub> drops only single-digit mV -- better driven-HIGH margin than the PNP's ~0.2-0.3V V<sub>CE(sat)</sub>. Gate-only bias current (not continuous BJT base current) let the bias resistors move up an order of magnitude from the discrete design. |
| SMF12A / SMF5.0A / SMF7.0A | `SMF12A.pdf` | TVS, one document covers the whole Littelfuse SMF 200W series | SMF12A: VPW bus-side clamp (D2), standoff 12V, clamps 19.9V max, 200W/10.1A peak pulse -- transient-only rating, not for sustained fault current (motivated series R1 upstream). SMF7.0A: +7V rail clamp (D6, D8), standoff 7.0V (matches the rail), breakdown 7.78-8.60V, clamps 12.0V max. SMF5.0A: +5V rail clamp (D5), standoff 5.0V, breakdown 6.40-7.00V, clamps 9.2V@21.7A. All downstream parts on the +7V rail (AP2003 20V, TL331 36V, LMR64010 40V) have comfortable headroom over these clamps. |
| SMF3.3 | `SMF3.3.pdf` | TVS, PWM RX output clamp (D3), +3.3V rail clamp (D4) | Its own separate Littelfuse document from the SMF5.0A-100A family (confirmed the family table doesn't go this low). Same 200W SMF class as D5/D6 above -- **rail protection (D4/D5/D6) is now confirmed all-SMF-series**, resolving the earlier SMF/SMAJ mix. V<sub>RWM</sub> 3.3V standoff, V<sub>BR</sub> 3.4-4.3V, clamps to 6.8V@30A (10/1000µs) or 10.0V@120A (8/20µs). |
| MM3Z3V3BW | `MM3Z3V3BW.pdf` | Zener, PWM RX input clamps (U2, U4) | Genuine 3.3V zener (JSMSEMI MM3Zx.xBW series), V<sub>Z</sub> 3.23-3.37V @5mA (~2% tolerance) -- tight, predictable clamp as intended. **Not a pulse-rated TVS**: 300mW max dissipation, no 8/20µs or 10/1000µs pulse-current spec anywhere in the datasheet. Fine here specifically because R6/R14 (100k) upstream already keep fault current at this node to sub-mA levels -- would not be an appropriate substitute for a real TVS anywhere current isn't already limited that hard. |
| PMEG4010ESBYL | `PMEG4010ESBYL.pdf` | Schottky, VPW RX blocking diode (D1) | V<sub>R</sub> 40V, V<sub>F</sub> ≤0.4V@100mA/≤0.6V@1A -- at the comparator's actual ~25nA input bias current, forward drop is a few mV, no meaningful threshold shift. Reverse leakage ≤30µA@40V. Placed in series toward the comparator's `IN+` specifically to structurally block reverse conduction during a negative fault (not just clamp it) -- requires a pulldown (R2) downstream for normal-operation discharge, since a series diode alone has no path to pull `IN+` back down once it blocks. |

### No longer used

| Part | File | Note |
|---|---|---|
| SMAJ5.0A | `SMAJ5.0A.pdf` | Was briefly on D5 (+5V rail); swapped for SMF5.0A to keep all three rail clamps in the same Littelfuse SMF family. Datasheet kept in case this changes again -- V<sub>RWM</sub> 5.0V standoff, V<sub>BR</sub> 6.40-7.00V, clamps 9.2V@43.5A, 400W (higher power than SMF, but a different die/package family, not a drop-in variant). |

### Superseded (kept for reference)

| Part | File | Why superseded |
|---|---|---|
| MMBT2907ALT1G | `MMBT2907ALT1G.pdf` | Original discrete PNP VPW TX driver; consolidated into AP2003's P-channel half. V(BR)CEO -60V, continuous I<sub>C</sub> -600mA, switching times tens of ns -- was fine electrically, just replaced for the R<sub>DS(ON)</sub>-vs-V<sub>CE(sat)</sub> and part-count benefits above. |
| FDN335N | `FDN335N.pdf` | Original discrete N-channel VPW TX interface MOSFET (Q2); consolidated into AP2003's N-channel half. Logic-level, V<sub>GS(th)</sub> max 1.5V, specified down to V<sub>GS</sub>=2.5V -- fine electrically, replaced for packaging/part-count. |

## Teensy 4.1 + AD7606 DAQ

### Verified, in current design

| Part | File | Role | Verified findings |
|---|---|---|---|
| AD7606C-16 | `AD7606C-16.pdf` | 8-channel simultaneous-sampling ADC, bring-up board | 16-bit, 1MSPS confirmed per channel regardless of resolution (SAR architecture, no speed/resolution trade-off within the family). Pin-for-pin identical to AD7606C-18 (final-PCB target) in every area that matters: `REF SELECT` pin 34, `REFIN/REFOUT` pin 42, absolute max ratings, +-21V input clamp behavior. Analog input clamp is transparent up to +-21V; above that, datasheet explicitly recommends an external series resistor (matched on Vx+/Vx-) to hold clamp current under +-10mA -- basis for the 3-stage input protection network (SMCJ TVS -> 6.8k/1210 resistor -> SMA-style TVS) designed for genuine coil-class transients, not just ESD. SPI mode confirmed empirically against a real +-1.24V signal: `SPI_MODE0`, not the initial `SPI_MODE1` guess (see `docs/teensy_daq.md` Phase 1 for the full debugging story). |
| ADR4525 | `ADR4525.pdf` | External 2.5V precision reference, replacing AD7606's internal band-gap reference | V<sub>OUT</sub> 2.500V exact match for AD7606's `REFIN` requirement. +-0.02% max initial accuracy, down to 0.8ppm/degC (D grade) -- both far better than the internal reference. Output capacitor (min 1uF) required for stability, not just noise -- separate requirement from AD7606's own REFIN/REFCAPA/REFCAPB decoupling. Used via a dedicated, isolated reference module (own regulator + pi-style ferrite filter) -- deliberately not sharing the same physical reference feeding AD7606's `REFIN`, to keep the square-wave generator's switching transients off the ADC's actual measurement reference. |
| LMV721DBVRG | `LMV721DBVRG.pdf` | Unity-gain buffer, precision square-wave generator output stage | True rail-to-rail I/O (works off 3.3V or 5V single supply), unity-gain stable (no decompensation caveat), 1pA typ input bias current (negligible loading on the 100k switch network). Offset voltage 0.8mV typ / 3.5mV max @25degC, up to 4.6mV max over full temp range -- this is the actual accuracy floor of the generator, larger than the reference's own 0.02% error; accepted as adequate given typical performance is ~0.03% of 2.5V. Output current 70mA typ / 38mA min (full temp) -- basis for the 150ohm series resistor between the buffer and the switch network, sized to keep any transient current well under this rating. |
| JTD2302 | `JTD2302.pdf` | N-channel MOSFET, square-wave generator's low-side switch (pulls the op-amp's `+` input to GND through a 100k series resistor) | V<sub>GS(th)</sub> 0.45-0.9V (logic-level, huge margin under 3.3V gate drive), R<sub>DS(ON)</sub> max 49mOhm @V<sub>GS</sub>=2.5V (confirms the cited spec). R<sub>DS(ON)</sub> this low is functionally moot here -- even a plain 2N7002's few-ohm R<sub>DS(ON)</sub> against the 100k series resistor already gives a "low" state within a few hundred uV of true 0V, 1000x+ smaller than the op-amp's own offset voltage, which is the real accuracy floor. Picked for cost, which is a fine reason on its own. |

### Considered and rejected

| Part | Why rejected |
|---|---|
| LTC2445 | 24-bit multiplexed delta-sigma ADC, not simultaneous-sampling SAR -- no moment where all 8 channels are captured at once regardless of speed setting, and its own datasheet states 500Hz for all 8 channels in 1x mode (13.8Hz per channel for genuinely low-noise operation) -- 4-5 orders of magnitude too slow for transient capture, the reason this DAQ exists. Built for slow/DC precision measurement (weigh scales, thermocouples, DVMs), not automotive transient capture. |
| MCP37D31-80 | 80Msps pipelined ADC, AEC-Q100 automotive-qualified, genuinely good per-channel math (10Msps/channel with all 8 active) -- but still a multiplexed architecture (one ADC core behind an 8-channel MUX, not true simultaneous sampling), needs DDR LVDS/parallel CMOS output requiring an FPGA-class digital backend (Teensy 4.1's SPI/GPIO can't ingest it), and TFBGA-121 fine-pitch package incompatible with this project's hand-assembly approach. Worth remembering for a future FPGA-backed high-speed design, not this one. |
| RS8411BXF | Considered as an LMV721 alternative for the square-wave generator's buffer. Didn't win on the spec that actually matters: offset voltage 4mV max @25degC (vs LMV721's 3.5mV) and no guaranteed max at all over the full temp range (only typical). Also not rail-to-rail input (needs 2V headroom below V+), meaning it can't run off the board's 3.3V rail for a 0-2.5V signal the way LMV721 can -- an added constraint with no accuracy benefit in return. |

