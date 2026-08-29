import os

HOST = "0.0.0.0"
PORT = 8000

# "mock" (default, no hardware needed) or "esp32" (real board over
# /ws/ingest/obd). Override with LXSCANNER_OBD_SOURCE=esp32.
OBD_SOURCE = os.environ.get("LXSCANNER_OBD_SOURCE", "mock")

# "mock" (default, no hardware needed), "hantek" (real Hantek 1008C over
# USB), or "teensy" (Teensy 4.1 + AD7606C-16 DAQ over USB serial).
# Override with LXSCANNER_SCOPE_SOURCE=hantek|teensy.
SCOPE_SOURCE = os.environ.get("LXSCANNER_SCOPE_SOURCE", "mock")

# Serial port for the Teensy DAQ. Override with LXSCANNER_TEENSY_PORT if
# it doesn't enumerate as /dev/ttyACM0.
TEENSY_PORT = os.environ.get("LXSCANNER_TEENSY_PORT", "/dev/ttyACM0")

# Standard OBD-II PIDs polled in scanner mode (mode 01).
SCANNER_PIDS: dict[str, tuple[str, str]] = {
    "0C": ("rpm", "rpm"),
    "0D": ("speed", "km/h"),
    "05": ("coolant_temp", "degC"),
    "11": ("throttle_pos", "%"),
    "42": ("control_module_voltage", "V"),
}

SCOPE_CHANNEL_COUNT = 8
SCOPE_DEFAULT_SAMPLE_RATE_HZ = 50_000
