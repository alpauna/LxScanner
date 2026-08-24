#pragma once

// SN65HVD230 CAN transceiver wiring -- see docs/wiring.md.
// TXD/RXD are arbitrary free GPIOs, not fixed by the ESP32's TWAI
// peripheral; change these if your wiring differs.
constexpr int CAN_TX_PIN = 5;
constexpr int CAN_RX_PIN = 4;
constexpr long CAN_BITRATE = 500000; // OBD-II standard bitrate

constexpr int STATUS_LED_PIN = 2; // onboard LED on most ESP32 DevKitC boards
