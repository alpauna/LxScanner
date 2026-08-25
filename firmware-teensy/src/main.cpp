/* Phase 0 scaffold: validates the toolchain/board config only. No
 * AD7606/SPI/USB-HS logic yet -- see docs/teensy_daq.md and the plan
 * this was built from for why (no hardware to bench-validate against
 * until the board arrives; this session found real bugs in "should be
 * right" protocol assumptions only once real hardware was available to
 * test against).
 */
#include <Arduino.h>

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
