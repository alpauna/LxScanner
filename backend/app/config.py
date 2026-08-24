import os

HOST = "0.0.0.0"
PORT = 8000

# "mock" (default, no hardware needed) or "esp32" (real board over
# /ws/ingest/obd). Override with LXSCANNER_OBD_SOURCE=esp32.
OBD_SOURCE = os.environ.get("LXSCANNER_OBD_SOURCE", "mock")

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
