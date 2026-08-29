/* Phase 2: AD7606C-16 binary streaming over USB Serial.
 *
 * CONVST/BUSY/SPI-read logic is unchanged from Phase 1 bring-up
 * (bench-validated 2026-08-27/28 against a known +/-1.24V reference
 * signal, SPI_MODE0 confirmed correct). This phase replaces the
 * human-readable, throttled debug print with a real streaming wire
 * protocol so the backend (TeensyDaqDriver) can consume it as a scope
 * source -- see docs/teensy_daq.md Phase 2.
 *
 * Frame format (all multi-byte fields little-endian, matching the
 * Cortex-M7's native byte order -- written explicitly byte-by-byte
 * below rather than relying on struct packing):
 *   SYNC        4 bytes   0xA5 0x5A 0xA5 0x5A
 *   N_SAMPLES   uint16    samples per channel in this frame
 *   DT_US       uint32    microseconds between samples
 *   DATA        N_SAMPLES * 8 * int16, raw ADC codes (backend converts
 *               to volts -- keeps hardware-specific scaling out of the
 *               wire format, same spirit as the Hantek driver keeping
 *               its correction factors out of its own raw USB reads)
 *   CHECKSUM    uint8     XOR of every byte from N_SAMPLES through DATA
 *
 * Command protocol (single bytes from the host over the same Serial
 * connection, checked non-blockingly each loop iteration):
 *   'S'         start streaming (default state is stopped, so a host
 *               script never has to race the very first bytes after
 *               USB enumeration)
 *   'X'         stop streaming
 *   'R' + 1     set RANGE pin (0 = +/-5V, 1 = +/-10V) -- takes effect
 *               on the next batch boundary, not mid-batch. Hardware
 *               mode only supports one range shared across all 8
 *               channels, not truly per-channel -- see
 *               TeensyDaqDriver.set_channel_range's docstring for how
 *               the ScopeDriver interface's per-channel signature maps
 *               onto this.
 */
#include <Arduino.h>
#include <SPI.h>

namespace {

// Pin assignments -- see docs/teensy_daq.md, Phase 0 wiring table.
constexpr int PIN_SCLK = 13;      // SPI0 SCK -- shares the onboard LED pin
constexpr int PIN_MISO = 12;      // SPI0 MISO -- AD7606 DOUTA
constexpr int PIN_CONVST = 14;    // also drives WR via the breakout's own tie
constexpr int PIN_RESET = 15;
constexpr int PIN_CS = 16;        // software-controlled, not hardware SPI CS
constexpr int PIN_BUSY = 17;
constexpr int PIN_FRSTDATA = 18;
constexpr int PIN_OS0 = 19;
constexpr int PIN_OS1 = 20;
constexpr int PIN_OS2 = 21;
constexpr int PIN_RANGE = 22;

// Timing, from the AD7606C-16 datasheet (Table 3, Reset Functionality):
// full reset needs RESET held high >=3.2us, then >=274us before the
// first CONVST. Padded with margin since none of this is timing-critical
// at Arduino loop speeds.
constexpr uint32_t RESET_PULSE_US = 10;
constexpr uint32_t RESET_SETTLE_US = 400;

// SPI clock: raised from Phase 1's conservative 1MHz now that the
// dead-bug/flying-wire wiring has proven stable over real bench testing.
// Still well under the datasheet's 63.5MHz max -- this is a cautious
// step, not a jump to the ceiling, since this isn't a finished PCB.
// Re-validate against the known reference signal if raised further.
constexpr uint32_t SPI_CLOCK_HZ = 8'000'000;

SPISettings spiSettings(SPI_CLOCK_HZ, MSBFIRST, SPI_MODE0);

// Samples per channel per frame. At ~8MHz SPI, one 8-channel read takes
// roughly 17-18us (8 transfers x 2us + CS/loop overhead), so 128 samples
// is ~2.3ms per frame -- a responsive ~400+ frames/sec without excessive
// per-frame USB overhead. Tune once real throughput is measured on the
// backend side.
constexpr uint16_t SAMPLES_PER_FRAME = 128;

constexpr uint8_t SYNC_BYTES[4] = {0xA5, 0x5A, 0xA5, 0x5A};

int16_t g_frameBuffer[SAMPLES_PER_FRAME][8];
bool g_streaming = false;

void pulseConvst() {
  digitalWriteFast(PIN_CONVST, LOW);
  delayNanoseconds(50);  // t_LP_CNV min is 10ns; this is generous margin
  digitalWriteFast(PIN_CONVST, HIGH);
}

// Blocks until BUSY falls (conversion complete for all 8 channels) or
// the timeout elapses. Returns false on timeout -- that's a real signal
// something's wrong (miswiring, RESET not applied, etc.), not something
// to silently ignore.
bool waitForConversion() {
  constexpr uint32_t TIMEOUT_US = 50;  // t_CONV max is 0.65us, no oversampling
  uint32_t start = micros();
  while (digitalReadFast(PIN_BUSY) == HIGH) {
    if (micros() - start > TIMEOUT_US) return false;
  }
  return true;
}

// Reads all 8 channels via 8 CS-framed 16-bit SPI transfers on DOUTA,
// per the datasheet's hardware-mode single-DOUTx-line requirement:
// "these 128 SCLK cycles must be framed in groups of 16 SCLK cycles by
// the CS signal" -- CS must toggle between each channel, not stay low
// for one continuous 128-clock burst. Returns false if FRSTDATA didn't
// confirm frame alignment on channel 1.
bool readAllChannels(int16_t (&out)[8]) {
  SPI.beginTransaction(spiSettings);
  bool sawFrstData = false;
  for (int ch = 0; ch < 8; ch++) {
    digitalWriteFast(PIN_CS, LOW);
    if (ch == 0) sawFrstData = (digitalReadFast(PIN_FRSTDATA) == HIGH);
    out[ch] = static_cast<int16_t>(SPI.transfer16(0x0000));
    digitalWriteFast(PIN_CS, HIGH);
  }
  SPI.endTransaction();
  return sawFrstData;
}

void setRange(uint8_t rangeSel) {
  // 0 = +/-5V single-ended, 1 = +/-10V single-ended (Table 10).
  digitalWriteFast(PIN_RANGE, rangeSel ? HIGH : LOW);
  delayMicroseconds(100);  // ~80us settling time per the datasheet, padded
}

// Non-blocking: processes any command bytes waiting on Serial without
// stalling acquisition. Safe to call once per loop iteration.
void handleCommands() {
  while (Serial.available() > 0) {
    int b = Serial.read();
    switch (b) {
      case 'S':
        g_streaming = true;
        break;
      case 'X':
        g_streaming = false;
        break;
      case 'R': {
        uint32_t start = millis();
        while (Serial.available() == 0) {
          if (millis() - start > 100) return;  // malformed command, drop it
        }
        setRange(static_cast<uint8_t>(Serial.read()));
        break;
      }
      default:
        break;  // unknown byte, ignore
    }
  }
}

void sendFrame(uint16_t nSamples, uint32_t dtUs) {
  uint8_t checksum = 0;

  Serial.write(SYNC_BYTES, 4);

  uint8_t header[6];
  header[0] = static_cast<uint8_t>(nSamples & 0xFF);
  header[1] = static_cast<uint8_t>((nSamples >> 8) & 0xFF);
  header[2] = static_cast<uint8_t>(dtUs & 0xFF);
  header[3] = static_cast<uint8_t>((dtUs >> 8) & 0xFF);
  header[4] = static_cast<uint8_t>((dtUs >> 16) & 0xFF);
  header[5] = static_cast<uint8_t>((dtUs >> 24) & 0xFF);
  for (uint8_t b : header) checksum ^= b;
  Serial.write(header, sizeof(header));

  for (uint16_t i = 0; i < nSamples; i++) {
    for (int ch = 0; ch < 8; ch++) {
      uint16_t raw = static_cast<uint16_t>(g_frameBuffer[i][ch]);
      uint8_t lo = static_cast<uint8_t>(raw & 0xFF);
      uint8_t hi = static_cast<uint8_t>((raw >> 8) & 0xFF);
      checksum ^= lo;
      checksum ^= hi;
      Serial.write(lo);
      Serial.write(hi);
    }
  }

  Serial.write(checksum);
}

}  // namespace

void setup() {
  Serial.begin(115200);  // baud is ignored over native USB CDC-ACM

  pinMode(PIN_CONVST, OUTPUT);
  pinMode(PIN_RESET, OUTPUT);
  pinMode(PIN_CS, OUTPUT);
  pinMode(PIN_BUSY, INPUT);
  pinMode(PIN_FRSTDATA, INPUT);
  pinMode(PIN_OS0, OUTPUT);
  pinMode(PIN_OS1, OUTPUT);
  pinMode(PIN_OS2, OUTPUT);
  pinMode(PIN_RANGE, OUTPUT);

  digitalWriteFast(PIN_CONVST, HIGH);  // idle high; pulseConvst() drops it
  digitalWriteFast(PIN_CS, HIGH);      // idle high (deasserted)
  digitalWriteFast(PIN_RESET, LOW);

  // Hardware mode, no oversampling (OS2:OS0 = 0:0:0, Table 14).
  digitalWriteFast(PIN_OS0, LOW);
  digitalWriteFast(PIN_OS1, LOW);
  digitalWriteFast(PIN_OS2, LOW);

  setRange(0);  // +/-5V single-ended default, matches Phase 1

  SPI.begin();

  // Full reset per the datasheet's Reset Functionality section.
  digitalWriteFast(PIN_RESET, HIGH);
  delayMicroseconds(RESET_PULSE_US);
  digitalWriteFast(PIN_RESET, LOW);
  delayMicroseconds(RESET_SETTLE_US);
}

void loop() {
  handleCommands();
  if (!g_streaming) {
    return;
  }

  uint32_t frameStart = micros();
  uint16_t collected = 0;
  bool frstDataOk = true;

  while (collected < SAMPLES_PER_FRAME) {
    pulseConvst();
    if (!waitForConversion()) {
      // Conversion timeout mid-frame -- drop this frame's progress and
      // let the host notice via a gap in timestamps rather than send a
      // partial/misleading frame.
      handleCommands();
      if (!g_streaming) return;
      continue;
    }
    frstDataOk &= readAllChannels(g_frameBuffer[collected]);
    collected++;
  }

  uint32_t frameElapsedUs = micros() - frameStart;
  uint32_t dtUs = frameElapsedUs / SAMPLES_PER_FRAME;
  (void)frstDataOk;  // TODO: surface frame-alignment faults to the host
                      // once the backend has a place to report them

  sendFrame(collected, dtUs);
}
