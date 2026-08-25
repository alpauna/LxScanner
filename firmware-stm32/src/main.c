/* Phase 0 scaffold: validates the toolchain/board config only. No
 * AD7606/SPI/USB-HS logic yet -- see docs/stm32_daq.md and the plan
 * this was built from for why (no hardware to bench-validate against
 * yet; this session found real bugs in "should be right" protocol
 * assumptions only once real hardware was available to test against).
 */
#include "stm32h7xx_hal.h"

static void SystemClock_Config(void);

int main(void) {
  HAL_Init();
  SystemClock_Config();

  while (1) {
  }
}

/* Placeholder: default clock config. Real clock tree (sized for the
 * ADC/SPI/USB-HS timing this project actually needs) gets configured
 * once hardware is in hand to validate against. */
static void SystemClock_Config(void) {}

void SysTick_Handler(void) { HAL_IncTick(); }
