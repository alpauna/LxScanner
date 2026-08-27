/* Phase 1 bring-up: AD7606C-16 basic SPI comms over the Teensy 4.1.
 *
 * Hardware mode, single DOUTA serial line -- confirmed from the
 * datasheet that all 8 channels can still be read this way ("all
 * channels can be read from DOUTA by providing eight 16-bit SPI
 * frames between two CONVST pulses"). Wiring matches
 * docs/teensy_daq.md's Phase 0 wiring table exactly.
 *
 * SPI mode is a best-informed guess from the datasheet's serial
 * timing diagram (Figure 6: data access time is specified *after*
 * each SCLK rising edge, which puts the safe sampling point on the
 * following falling edge -- CPHA=1). This is the first thing to
 * verify against real hardware: if channel values look garbled or
 * bit-shifted rather than just noisy, try the other SPI modes before
 * assuming anything else is wrong.
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

// RANGE pin low = +/-5V single-ended (hardware mode, Table 10). Change
// PIN_RANGE's setup() level and this LSB together if you switch range.
constexpr float LSB_VOLTS = 152.58e-6f;  // +/-5V range, 16-bit

// Timing, from the AD7606C-16 datasheet (Table 3, Reset Functionality):
// full reset needs RESET held high >=3.2us, then >=274us before the
// first CONVST. Padded with margin since none of this is timing-critical
// at Arduino loop speeds.
constexpr uint32_t RESET_PULSE_US = 10;
constexpr uint32_t RESET_SETTLE_US = 400;

// SPI clock: starting conservative (datasheet allows up to 63.5MHz at
// VDRIVE=3.3V) since this is dead-bug/flying-wire wiring on a breadboard-
// style bring-up board, not a clean PCB trace. Raise once basic reads are
// confirmed clean.
constexpr uint32_t SPI_CLOCK_HZ = 1'000'000;

SPISettings spiSettings(SPI_CLOCK_HZ, MSBFIRST, SPI_MODE1);

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
// for one continuous 128-clock burst.
void readAllChannels(int16_t (&out)[8]) {
  SPI.beginTransaction(spiSettings);
  bool sawFrstData = false;
  for (int ch = 0; ch < 8; ch++) {
    digitalWriteFast(PIN_CS, LOW);
    if (ch == 0) sawFrstData = (digitalReadFast(PIN_FRSTDATA) == HIGH);
    out[ch] = static_cast<int16_t>(SPI.transfer16(0x0000));
    digitalWriteFast(PIN_CS, HIGH);
  }
  SPI.endTransaction();
  if (!sawFrstData) {
    Serial.println("WARN: FRSTDATA did not read high during channel 1 -- "
                    "frame alignment may be off");
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);

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

  // +/-5V single-ended (Table 10). Matches LSB_VOLTS above.
  digitalWriteFast(PIN_RANGE, LOW);

  SPI.begin();

  // Full reset per the datasheet's Reset Functionality section.
  digitalWriteFast(PIN_RESET, HIGH);
  delayMicroseconds(RESET_PULSE_US);
  digitalWriteFast(PIN_RESET, LOW);
  delayMicroseconds(RESET_SETTLE_US);

  Serial.println("AD7606C-16 Phase 1 bring-up -- internal reference, "
                  "+/-5V range, no oversampling");
}

void loop() {
  static uint32_t lastPrint = 0;
  int16_t channels[8];

  pulseConvst();
  bool ok = waitForConversion();
  if (!ok) {
    Serial.println("ERROR: BUSY did not fall within timeout -- check "
                    "wiring/RESET/CONVST");
    delay(500);
    return;
  }
  readAllChannels(channels);

  // Print at a human-readable rate, not every conversion -- this is
  // bring-up validation, not the real streaming path.
  if (millis() - lastPrint >= 200) {
    lastPrint = millis();
    for (int ch = 0; ch < 8; ch++) {
      float volts = channels[ch] * LSB_VOLTS;
      Serial.print("V");
      Serial.print(ch + 1);
      Serial.print("=");
      Serial.print(volts, 4);
      Serial.print("V (");
      Serial.print(channels[ch]);
      Serial.print(") ");
    }
    Serial.println();
  }
}
