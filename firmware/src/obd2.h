#pragma once

#include <Arduino.h>
#include <driver/twai.h>

// Minimal SAE J1979 (OBD-II over CAN, ISO 15765-4, 500 kbit/s, 11-bit IDs)
// client. Known limitations, deliberately out of scope for v1:
//   - No ISO-TP (ISO 15765-2) multi-frame reassembly, so a DTC response
//     spanning more than one CAN frame (more than ~3 codes) is truncated.
//   - 29-bit extended CAN IDs (used by some trucks/older GM vehicles)
//     aren't supported, only the standard 11-bit 0x7DF/0x7E8-0x7EF range.

struct PidResult {
  bool ok;
  float value;
};

void obd2_begin();

// Sends a mode 01 request for `pid` and blocks briefly for the response.
PidResult obd2_read_pid(uint8_t pid);

// Sends a mode 03 request and decodes DTCs from a single response frame.
// Returns the number of codes found (0 on timeout/no codes); writes up to
// `maxCodes` 5-character codes (e.g. "P0301") into `outCodes`.
int obd2_read_dtcs(String outCodes[], int maxCodes);

// Sends a mode 04 (clear DTCs) request. Fire-and-forget.
void obd2_clear_dtcs();

// Receives one raw CAN frame with a short timeout, for capture mode.
// Returns true if a frame was received.
bool obd2_receive_raw(twai_message_t &outMsg, uint32_t timeoutMs);
