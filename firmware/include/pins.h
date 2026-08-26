#pragma once

// SN65HVD230 CAN transceiver wiring -- see docs/wiring.md.
// TXD/RXD are arbitrary free GPIOs, not fixed by the ESP32's TWAI
// peripheral; change these if your wiring differs.
constexpr int CAN_TX_PIN = 5;
constexpr int CAN_RX_PIN = 4;
constexpr long CAN_BITRATE = 500000; // OBD-II standard bitrate

constexpr int STATUS_LED_PIN = 2; // onboard LED on most ESP32 DevKitC boards

// J1850 (PWM + VPW) daughter board -- see docs/j1850_multiprotocol.md.
// Picked to avoid: GPIO0/2/12/15 (strapping pins), GPIO6-11 (internal
// flash, never usable), GPIO1/3 (UART0, used for programming/serial
// monitor). RX pins deliberately use ESP32's input-only GPIOs
// (34/35 have no output driver or internal pull-up/down, but that's
// fine here since they only ever receive the comparator outputs).
constexpr int J1850_PWM_TX_P_PIN = 13;   // DRV8837 IN1 -> OUT1 -> OBD pin 2
constexpr int J1850_PWM_TX_N_PIN = 14;   // DRV8837 IN2 -> OUT2 -> OBD pin 10
constexpr int J1850_PWM_TX_EN_PIN = 27;  // DRV8837 nSLEEP: LOW=Hi-Z/RX-only, HIGH=driver enabled
constexpr int J1850_PWM_RX_PIN = 34;     // TLV7031 comparator output (input-only pin)
constexpr int J1850_VPW_TX_PIN = 26;     // to VPW driver transistor base (via its bias network)
constexpr int J1850_VPW_RX_PIN = 35;     // TL331 comparator output (input-only pin)
// Doubles as both "which protocol is active" and "7V boost enable":
// HIGH = VPW/GM mode (also asserts LMR64010 SHDN# high to enable the
// +7V rail the VPW driver needs), LOW = PWM/Ford mode (boost shut down,
// near-zero quiescent draw). Confirmed against the LMR64010 datasheet
// (docs/datasheets/LMR64010.pdf): SHDN device-ON threshold is >=1.5V,
// device-OFF is <=0.5V, so HIGH=enabled/LOW=shutdown is correct; max
// SHDN voltage is VIN+0.3V and bias current ~0-2uA, so ESP32's 3.3V
// GPIO drives it directly, no level-shifter needed.
constexpr int J1850_VPW_MODE_EN_PIN = 25;
