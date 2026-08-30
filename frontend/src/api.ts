import type { Mode } from "./types";

export async function setMode(mode: Mode): Promise<void> {
  await fetch("/api/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export async function startSession(): Promise<{ session_id: number }> {
  const res = await fetch("/api/session/start", { method: "POST" });
  return res.json();
}

export async function stopSession(): Promise<void> {
  await fetch("/api/session/stop", { method: "POST" });
}

export async function clearDtc(): Promise<void> {
  await fetch("/api/dtc/clear", { method: "POST" });
}

export interface CalibrateResult {
  ok: boolean;
  reason?: string;
  low_v?: number;
  high_v?: number;
}

export async function calibrateChannel(channel: number): Promise<CalibrateResult> {
  const res = await fetch(`/api/scope/calibrate/${channel}`, { method: "POST" });
  return res.json();
}

export async function setChannelRange(channel: number, rangeV: number): Promise<void> {
  await fetch(`/api/scope/channel/${channel}/range`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ range_v: rangeV }),
  });
}

export async function setTimebase(nsPerDiv: number): Promise<void> {
  await fetch("/api/scope/timebase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ns_per_div: nsPerDiv }),
  });
}

export interface ScopeSourceInfo {
  active: string;
  available: string[];
}

export async function getScopeSource(): Promise<ScopeSourceInfo> {
  const res = await fetch("/api/scope/source");
  return res.json();
}

export interface SetScopeSourceResult {
  ok: boolean;
  source?: string;
  error?: string;
}

export async function setScopeSource(source: string): Promise<SetScopeSourceResult> {
  const res = await fetch("/api/scope/source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
  return res.json();
}

export interface ScopeCaptureCreate {
  name: string | null;
  source: string;
  wall_clock_start_ms: number;
  duration_sec: number;
  channels: number[];
  xs: number[];
  data: Record<number, (number | null)[]>;
}

export interface ScopeCaptureMeta {
  id: string;
  name: string | null;
  source: string;
  created_at: number;
  wall_clock_start_ms: number;
  duration_sec: number;
  sample_count: number;
}

export interface ScopeCaptureData {
  xs: number[];
  channels: number[];
  data: Record<number, (number | null)[]>;
}

export async function saveCapture(payload: ScopeCaptureCreate): Promise<ScopeCaptureMeta> {
  const res = await fetch("/api/scope/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function listCaptures(): Promise<ScopeCaptureMeta[]> {
  const res = await fetch("/api/scope/captures");
  return res.json();
}

export async function loadCapture(id: string): Promise<ScopeCaptureData> {
  const res = await fetch(`/api/scope/capture/${id}`);
  return res.json();
}

export async function deleteCapture(id: string): Promise<void> {
  await fetch(`/api/scope/capture/${id}`, { method: "DELETE" });
}
