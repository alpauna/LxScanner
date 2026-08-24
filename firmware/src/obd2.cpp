#include "obd2.h"
#include "pins.h"

static void twai_send_request(uint8_t mode, uint8_t pid, bool includePid) {
  twai_message_t msg = {};
  msg.identifier = 0x7DF; // functional (broadcast) OBD-II request
  msg.extd = 0;
  msg.data_length_code = 8;
  msg.data[0] = includePid ? 0x02 : 0x01; // additional-byte count
  msg.data[1] = mode;
  msg.data[2] = includePid ? pid : 0x00;
  for (int i = 3; i < 8; i++) msg.data[i] = 0x00; // pad; some ECUs prefer 0xAA
  twai_transmit(&msg, pdMS_TO_TICKS(100));
}

static bool is_obd_response(const twai_message_t &msg) {
  return msg.identifier >= 0x7E8 && msg.identifier <= 0x7EF;
}

void obd2_begin() {
  twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(
      (gpio_num_t)CAN_TX_PIN, (gpio_num_t)CAN_RX_PIN, TWAI_MODE_NORMAL);
  twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  twai_driver_install(&g_config, &t_config, &f_config);
  twai_start();
}

PidResult obd2_read_pid(uint8_t pid) {
  twai_send_request(0x01, pid, true);

  twai_message_t rx;
  uint32_t deadline = millis() + 200;
  while (millis() < deadline) {
    if (twai_receive(&rx, pdMS_TO_TICKS(50)) != ESP_OK) continue;
    if (!is_obd_response(rx)) continue;
    if (rx.data[1] != 0x41 || rx.data[2] != pid) continue;

    uint8_t a = rx.data[3];
    uint8_t b = rx.data[4];
    float value;
    switch (pid) {
      case 0x0C: value = ((a * 256) + b) / 4.0f; break;      // RPM
      case 0x0D: value = a; break;                            // Speed (km/h)
      case 0x05: value = a - 40; break;                        // Coolant temp (degC)
      case 0x11: value = a * 100.0f / 255.0f; break;           // Throttle (%)
      case 0x42: value = ((a * 256) + b) / 1000.0f; break;     // Module voltage (V)
      default: return {false, 0};
    }
    return {true, value};
  }
  return {false, 0};
}

int obd2_read_dtcs(String outCodes[], int maxCodes) {
  twai_send_request(0x03, 0x00, false);

  twai_message_t rx;
  uint32_t deadline = millis() + 200;
  while (millis() < deadline) {
    if (twai_receive(&rx, pdMS_TO_TICKS(50)) != ESP_OK) continue;
    if (!is_obd_response(rx)) continue;
    if (rx.data[1] != 0x43) continue;

    static const char letter[] = {'P', 'C', 'B', 'U'};
    static const char hexDigit[] = "0123456789ABCDEF";
    int count = 0;
    // Up to 3 DTCs fit in one 8-byte frame (bytes 2-7, 2 bytes each).
    for (int i = 2; i + 1 < 8 && count < maxCodes; i += 2) {
      uint8_t b1 = rx.data[i];
      uint8_t b2 = rx.data[i + 1];
      if (b1 == 0 && b2 == 0) continue; // unused slot
      char code[6];
      code[0] = letter[(b1 >> 6) & 0x03];
      code[1] = '0' + ((b1 >> 4) & 0x03);
      code[2] = hexDigit[b1 & 0x0F];
      code[3] = hexDigit[(b2 >> 4) & 0x0F];
      code[4] = hexDigit[b2 & 0x0F];
      code[5] = '\0';
      outCodes[count++] = String(code);
    }
    return count;
  }
  return 0;
}

void obd2_clear_dtcs() { twai_send_request(0x04, 0x00, false); }

bool obd2_receive_raw(twai_message_t &outMsg, uint32_t timeoutMs) {
  return twai_receive(&outMsg, pdMS_TO_TICKS(timeoutMs)) == ESP_OK;
}
