export type Mode = "scanner" | "capture";

export interface PidReading {
  type: "pid";
  pid: string;
  name: string;
  value: number;
  unit: string;
  ts: number;
}

export interface CanFrame {
  type: "can_frame";
  can_id: number;
  dlc: number;
  data: number[];
  ts: number;
}

export interface DtcEvent {
  type: "dtc";
  codes: string[];
  ts: number;
}

export type LiveEvent = PidReading | CanFrame | DtcEvent;

export interface ScopeBatch {
  type: "scope_batch";
  t0: number;
  dt: number;
  // JSON-serialized from a Python dict[int, list[float]] -- keys arrive as strings.
  channels: Record<string, number[]>;
}
