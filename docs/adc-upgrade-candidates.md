# ADC upgrade candidates

Note carried over from the TritonECU work, where the AD7606 family's pin
compatibility was checked part by part against real datasheets. Two findings are
relevant here, and one needs confirming.

---

## ADS9324 — the one worth looking at

While evaluating second sources for the ECU's analog front end, the **TI
ADS9324** turned out to be wrong for that board and interesting for this one.

| | |
|---|---|
| Channels | **16**, simultaneous sampling |
| Throughput | **1 MSPS per channel** |
| Resolution | 16-bit |
| Input | ±12.5 V, ±10 V, ±6.25 V, ±5 V, ±2.5 V differential — **±12.5 V common mode** |
| Analog bandwidth | selectable **25 kHz / 325 kHz** |
| Input impedance | 1 MΩ, integrated PGA, input clamp |
| Open-wire detection | floating inputs read near-zero code |
| Package | VQFN-64, 8 × 8 mm |
| Supplies | 5 V **and 1.8 V** analog, 1.8–3.3 V digital I/O |

### Why it suits this project specifically

**Sixteen channels is the right number for automotive.** The target vehicle has
eight coils and eight injectors. An 8-channel DAQ forces a choice between them;
16 captures ignition and injection **in the same acquisition, on the same
timebase**. That is the class of measurement this project exists to make, and
the reason the Hantek was outgrown.

**±12.5 V common mode with differential inputs** matters more than it looks.
Automotive signals sit on a ground that moves — a coil firing shifts local
ground by volts. Single-ended capture measures the signal *plus* that shift;
differential rejects it.

**Open-wire detection** is a diagnostic feature, not a convenience: a probe that
has fallen off reads near-zero code rather than floating to a plausible-looking
value. On a multi-channel capture where nobody is watching all sixteen traces, a
detached probe that *looks* like a signal is a real failure mode.

**Selectable 25 kHz / 325 kHz bandwidth** covers both ends of the problem
described in `teensy_daq.md` — slow 60 Hz content and kHz-range ignition events.

### What it costs

- **It is not an AD7606 drop-in.** Different package type and size, twice the
  channels, and it needs a **1.8 V analog rail** the current design does not
  generate. This is a new board, not a populate change.
- **New part** — datasheet dated December 2025. Check availability and lifecycle
  before designing around it.
- 16 channels at 1 MSPS is a **lot** of data. Throughput to the host becomes the
  constraint again, which is exactly the wall the Hantek hit for a different
  reason. Work out the link budget before the analog design.

---

## ADS9817 — **2 MSPS**, datasheet still wanted

Reported as a **2 MSPS** part. No datasheet is in either repo yet, so channel
count, package, supplies and interface are all unknown here — drop it in
`docs/datasheets/` and it can be checked the way the AD7606 family was, pin by
pin against the document rather than from memory. That method has already caught
a wrong claim and a wrong assumption in this work.

### But 2 MSPS raises the question that actually decides this

**A faster converter only helps if the capture depth follows.** This project
exists because the Hantek capped at 4000 samples total — a *depth* limit, not a
speed one. Doubling sample rate halves the time a given buffer covers, so speed
without memory makes the original problem worse.

Sustained transfer, for reference:

| ch | MSPS | MB/s | vs USB-HS (~40 MB/s practical) |
|--:|--:|--:|---|
| 8 | 1 | 16.0 | fits |
| 8 | 2 | 32.0 | fits |
| 16 | 1 | 32.0 | fits |
| **16** | **2** | **64.0** | **exceeds** |

So beyond about 16 channels at 1 MSPS, **continuous streaming stops being an
option** — which is fine, because a scope captures a window to RAM and transfers
afterwards. That makes **memory depth the binding constraint**, exactly as it was
on the Hantek.

Capture window at 16 channels × 16-bit (32 bytes per sample set):

| memory | 1 MSPS | 2 MSPS |
|---|--:|--:|
| Teensy 4.1 internal, ~1 MB | 31 ms | **16 ms** |
| **+ 8 MB PSRAM** | **250 ms** | **125 ms** |

**PSRAM is what makes a fast part worth having.** On internal RAM alone, 2 MSPS
buys a 16 ms window — too short to hold a slow 60 Hz cycle alongside the kHz
ignition content, which is the exact failure described in `teensy_daq.md`. With
8 MB of PSRAM the same part gives 125 ms, which covers both.

For scale: 8 MB at 16 channels is **250 000 samples per channel**, against the
Hantek's ~500. **[CHECK]** the PSRAM population on the Teensy 4.1 in hand, and
whether sustained writes keep up at the target rate — PSRAM bandwidth, not the
ADC, is then the next thing to verify.

---

## For reference: the AD7606 footprint is more flexible than it looks

Verified pin-for-pin across all 64 pins, so the existing LQFP-64 layout accepts:

| Part | Vendor | Throughput | Temp |
|---|---|--:|---|
| AD7606 | ADI | 200 kSPS | −40…+85 °C |
| AD7606B | ADI | 800 kSPS | −40…+125 °C |
| AD7606C-16/18 | ADI | 1 MSPS | −40…+125 °C |
| ADS8588S | TI | 200 kSPS | −40…+125 °C |
| ADS8588H | TI | 500 kSPS | −40…+125 °C |

**AD7606C-16 is the speed upgrade for this board with no layout work** — 1 MSPS
on all 8 channels, same footprint, populate-different-part. If the goal is more
samples rather than more channels, that is the cheap route and it needs no new
PCB.

*(Beware `AD7606BSTZ`: the `B` there is a grade letter on the original 200 kSPS
AD7606, not the faster AD7606B. The two are footprint-identical and easy to
confuse in a listing.)*
