# ADC upgrade candidates

Note carried over from the TritonECU work, where the AD7606 family's pin
compatibility was checked part by part against real datasheets. Two findings are
relevant here, and one needs confirming.

---

## Scope is 8 channels — and that changes the answer

**Target is 8 channels.** Sixteen is a later expansion, once 8 works correctly.
PSRAM is not populated. That reframes everything below, because **at 8 channels
the Teensy 4.1 already meets the requirement.**

### The arithmetic, at 8 channels × 16-bit (16 bytes per sample set)

| memory | 1 MSPS | 500 kSPS | 100 kSPS | 10 kSPS |
|---|--:|--:|--:|--:|
| **Teensy 4.1 internal, 1 MB** | **62 ms** | **125 ms** | **625 ms** | **6.25 s** |
| STM32H7B3, 1.4 MB | 88 ms | 175 ms | 875 ms | 8.75 s |
| i.MX RT1170, 2 MB | 125 ms | 250 ms | 1.25 s | 12.5 s |
| + 8 MB PSRAM | 500 ms | 1.00 s | 5.00 s | 50 s |

Against what a window has to cover:

| | |
|---|--:|
| One 4-stroke cycle at 6000 rpm | 20 ms |
| One 4-stroke cycle at 600 rpm (idle) | 200 ms |
| One 4-stroke cycle at 200 rpm (cranking) | **600 ms** |
| One 60 Hz mains cycle | 16.7 ms |

**The existing 1 MB covers all of it, because the rate/depth trade is now
available.** 1 MSPS × 62 ms holds a redline cycle three times over; 100 kSPS ×
625 ms holds a complete cranking sequence. **That trade is precisely what the
Hantek did not have** — 4000 samples regardless of timebase meant no choice at
all. The fix was never more memory; it was memory you can spend as you like.

### So replacing the CPU is solving a problem that is not there

Asked for a part with more internal memory or a better CPU, the honest answer is
that neither is the constraint:

- **CPU is not loaded.** 8 channels at 1 MSPS is 16 MB/s, moved by DMA. A
  600 MHz M7 is not working hard.
- **More internal RAM is barely available.** 1 MB on the RT1062 is already near
  the top of what any MCU carries. The realistic steps are **1.4×** (STM32H7B3,
  1.4 MB) or **2×** (i.MX RT1170, 2 MB). Neither is transformative, and both cost
  the Teensy ecosystem. ESP32-P4 (768 kB) and RP2350 (520 kB) are *downgrades* on
  this axis.
- **PSRAM is the only large lever — 8×** — and it is a populate option on the
  board already in hand, not a redesign.

**If a replacement is still wanted, i.MX RT1170** is the one worth considering:
2 MB, 1 GHz M7 plus an M4, USB-HS, and the same NXP family as the RT1062 so the
DMA and FlexIO work carries over. But it buys 2× on the one axis that is not
currently binding.

### What actually binds first: the ADC link

| rate (8 ch, 16-bit) | link | serial feasible? |
|--:|--:|---|
| 200 kSPS | 26 Mbit/s | yes |
| **1 MSPS** | **128 Mbit/s** | **no** |
| 2 MSPS | 256 Mbit/s | no |

Two DOUT lines at 50 MHz give about 100 Mbit/s, so **serial runs out somewhere
near 600 kSPS on 8 channels**. Above that the ADC's **parallel interface** is
required — 16 bits wide, driven by FlexIO and DMA on the RT1062.

**That is the design decision a faster ADC forces — not the CPU, and not the
memory.** Settle the interface before shopping for converters.

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

### Gen 2: ADS9324 + i.MX RT1170, and they genuinely belong together

The expansion argument is that the vehicle has eight coils and eight injectors,
so an 8-channel DAQ forces a choice between them while 16 captures ignition and
injection **in the same acquisition, on the same timebase**.

Two details found in the datasheet make this pairing better than a shopping list:

**The ADS9324 is configurable as 2, 4, 8 or 16 channels.** It is not only the
16-channel part — it *is* the 8-channel part too, in the same silicon. So gen 2
can be brought up in **8-channel mode against known-good behaviour** and expanded
to 16 by configuration, with no second board. That matches the plan of proving 8
before reaching for 16.

**The serial interface is 1, 2, 4 or 8 lanes.** That dissolves the interface wall
described above — instead of needing a 16-bit parallel bus, bandwidth is bought
with lanes:

| | total | 4-lane | 8-lane |
|---|--:|--:|--:|
| 8 ch @ 1 MSPS | 128 Mbit/s | 32 Mbit/s | 16 Mbit/s |
| 16 ch @ 1 MSPS | 256 Mbit/s | 64 Mbit/s | 32 Mbit/s |

At 8 lanes even the full 16-channel case is **32 Mbit/s per lane**, which is
undemanding. The parallel-bus requirement was an AD7606 constraint, not a
fundamental one.

**The RT1170 side lines up:**

| | 1 MSPS | 100 kSPS |
|---|--:|--:|
| 2 MB, 8 ch | 125 ms | 1.25 s |
| 2 MB, 16 ch | 62.5 ms | 625 ms |

Doubling the channels against doubled memory holds the same window the Teensy
gives at 8 channels today — and the rate/depth trade still covers a 600 ms
cranking capture at 100 kSPS. The extra cores earn their place at 32 MB/s
sustained, and the RT1170's configurable I/O voltage suits a part whose IOVDD
runs 1.8–3.3 V.

### What gen 2 still costs

- **A new board.** VQFN-64 at 8 × 8 mm, not the LQFP-64, plus an **AVDD_1V8**
  rail the current design does not generate.
- **A different reference:** 4.096 V on-chip at 15 ppm/°C, against the AD7606
  family's 2.5 V. Scaling and calibration both change.
- **A new part** — datasheet dated December 2025. **[CHECK]** availability before
  designing around it.

### Sequencing

1. **Now:** prove 8 channels on the existing AD7606 + Teensy 4.1. The memory and
   CPU already suffice, per the arithmetic above.
2. **Gen 2:** ADS9324 + RT1170 on a new board, brought up in 8-channel mode
   against the proven gen-1 behaviour, then expanded to 16 in configuration.

Building a gen-2 board now to obtain 8 channels that already work would be
motion without progress.

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
