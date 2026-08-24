#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <WiFi.h>

#include "obd2.h"
#include "pins.h"
#include "secrets.h" // copy secrets.h.example -> secrets.h and fill in

// Wire protocol matches backend/app/models.py exactly -- see docs there
// before changing field names.

enum class Mode { SCANNER, CAPTURE };
static Mode currentMode = Mode::SCANNER;

static WebSocketsClient ws;
static bool wsConnected = false;

// PIDs polled in scanner mode -- mirrors app/config.py::SCANNER_PIDS.
struct PidDef {
  uint8_t pid;
  const char *name;
  const char *unit;
};
static const PidDef SCANNER_PIDS[] = {
    {0x0C, "rpm", "rpm"},
    {0x0D, "speed", "km/h"},
    {0x05, "coolant_temp", "degC"},
    {0x11, "throttle_pos", "%"},
    {0x42, "control_module_voltage", "V"},
};
static const int SCANNER_PID_COUNT = sizeof(SCANNER_PIDS) / sizeof(SCANNER_PIDS[0]);

// millis()-based, i.e. device uptime in seconds -- NOT wall-clock time.
// The backend timestamps its own receipt separately; this field is only
// useful for ordering/delta-timing between frames from this device.
static double nowSeconds() { return millis() / 1000.0; }

static void sendPidReading(const char *pid, const char *name, float value,
                            const char *unit) {
  JsonDocument doc;
  doc["type"] = "pid";
  doc["pid"] = pid;
  doc["name"] = name;
  doc["value"] = value;
  doc["unit"] = unit;
  doc["ts"] = nowSeconds();
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

static void sendDtcEvent(String codes[], int count) {
  JsonDocument doc;
  doc["type"] = "dtc";
  JsonArray arr = doc["codes"].to<JsonArray>();
  for (int i = 0; i < count; i++) arr.add(codes[i]);
  doc["ts"] = nowSeconds();
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

static void sendCanFrame(const twai_message_t &msg) {
  JsonDocument doc;
  doc["type"] = "can_frame";
  doc["can_id"] = msg.identifier;
  doc["dlc"] = msg.data_length_code;
  JsonArray data = doc["data"].to<JsonArray>();
  for (int i = 0; i < msg.data_length_code; i++) data.add(msg.data[i]);
  doc["ts"] = nowSeconds();
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

static void handleCommand(const String &payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  const char *cmd = doc["cmd"] | "";
  if (strcmp(cmd, "set_mode") == 0) {
    const char *mode = doc["mode"] | "scanner";
    currentMode = (strcmp(mode, "capture") == 0) ? Mode::CAPTURE : Mode::SCANNER;
  } else if (strcmp(cmd, "clear_dtc") == 0) {
    obd2_clear_dtcs();
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      break;
    case WStype_TEXT:
      handleCommand(String((char *)payload, length));
      break;
    default:
      break;
  }
}

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
    delay(250);
  }
  digitalWrite(STATUS_LED_PIN, HIGH);
}

void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED_PIN, OUTPUT);

  connectWifi();
  obd2_begin();

  ws.begin(BACKEND_HOST, BACKEND_PORT, "/ws/ingest/obd");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
}

static uint32_t lastDtcPollMs = 0;

void loop() {
  ws.loop();
  if (!wsConnected) return;

  if (currentMode == Mode::SCANNER) {
    for (int i = 0; i < SCANNER_PID_COUNT; i++) {
      const PidDef &def = SCANNER_PIDS[i];
      PidResult r = obd2_read_pid(def.pid);
      if (r.ok) {
        char pidHex[3];
        snprintf(pidHex, sizeof(pidHex), "%02X", def.pid);
        sendPidReading(pidHex, def.name, r.value, def.unit);
      }
      ws.loop();
    }

    if (millis() - lastDtcPollMs > 5000) {
      lastDtcPollMs = millis();
      String codes[3];
      int count = obd2_read_dtcs(codes, 3);
      if (count > 0) sendDtcEvent(codes, count);
    }
  } else { // CAPTURE
    twai_message_t rx;
    if (obd2_receive_raw(rx, 50)) {
      sendCanFrame(rx);
    }
  }
}
