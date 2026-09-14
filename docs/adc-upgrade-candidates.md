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

## [CONFIRM] ADS9817

Requested by name, but **no datasheet has been found for it** — not in either
repo, and not a part number that could be verified. It may be a real part, or it
may be a slip for the **ADS9324** above.

**Confirm the part number before acting on this note.** If ADS9817 is real, drop
its datasheet in `docs/datasheets/` and it can be checked the same way the AD7606
family was — pin by pin, against the actual document rather than from memory.
That method has already caught one wrong claim and one wrong assumption in this
work, and it is cheap.

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
