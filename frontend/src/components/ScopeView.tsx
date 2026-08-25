import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useSocket } from "../ws";
import { calibrateChannel, setChannelRange, setTimebase } from "../api";
import type { ScopeEvent } from "../types";

interface ChannelConfig {
  id: number; // 0-7, matches the backend channel index
  color: string;
  enabled: boolean;
  offset: number; // volts, shifts the trace up/down within the view
  rangeV: number; // hardware input range -- see RANGE_OPTIONS
  attenuation: number; // probe ratio (1, 10, 20, 100) -- see ATTENUATION_OPTIONS
}

interface CursorPair {
  enabled: boolean;
  a: number;
  b: number;
}

type Range = [number, number];
type DragTarget = "h1" | "h2" | "v1" | "v2" | null;

interface PanStart {
  clientX: number;
  clientY: number;
  xRange: Range;
  yRange: Range;
  xUnitsPerPx: number;
  yUnitsPerPx: number;
}

const DEFAULT_CHANNELS: ChannelConfig[] = [
  { id: 0, color: "#dc2626", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // red
  { id: 1, color: "#16a34a", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // green
  { id: 2, color: "#2563eb", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // blue
  { id: 3, color: "#92400e", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // brown
  { id: 4, color: "#000000", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // black
  { id: 5, color: "#eab308", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // yellow
  { id: 6, color: "#f97316", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // orange
  { id: 7, color: "#9333ea", enabled: true, offset: 0, rangeV: 5, attenuation: 1 }, // purple
];

const STORAGE_KEY = "lxscanner-scope-channels";
const DIVS_X = 10;
const DIVS_Y = 8;
// Hardware timebase (ns_per_div) is a fixed 1-2-5 sequence, max 200ms/div
// -- see vendor.py's __burst_mode_ns_per_div_to_id_dic. Values here are
// in seconds and converted to ns_per_div (*1e9) when applied.
const TIME_PER_DIV_OPTIONS = [
  0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1,
  0.2,
];
const VOLTS_PER_DIV_OPTIONS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
// The hardware only has 3 real input ranges (see _nearest_vscale in
// driver.py); these values each land solidly in one bucket. Found
// 2026-08-25: a real signal (10x probe, 60Hz pickup, ~7.7Vpp) clipped
// hard against the default 5V range's actual ~2.5V headroom.
const RANGE_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "±1V (sensitive)" },
  { value: 5, label: "±5V (sensors, default)" },
  { value: 40, label: "±40V (ignition, mains)" },
];
// Probe/attenuator ratio, applied as a display-only multiplier on top of
// the already-calibrated instrument-input voltage -- the actual value at
// the probe tip is attenuation x what the scope's input sees. Distinct
// from RANGE_OPTIONS: range describes the scope's own input headroom
// (what clips), attenuation describes what's between the tip and that
// input. Found 2026-08-25: readings need this to mean anything with a
// 10:1 scope probe, a 20:1 Hantek attenuator, or a 100:1 probe attached.
const ATTENUATION_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1:1 (direct)" },
  { value: 10, label: "10:1 probe" },
  { value: 20, label: "20:1 attenuator" },
  { value: 100, label: "100:1 probe" },
];

function loadChannels(): ChannelConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CHANNELS;
    const parsed = JSON.parse(raw) as Partial<ChannelConfig>[];
    if (Array.isArray(parsed) && parsed.length === 8) {
      return parsed.map((c, i) => ({ ...DEFAULT_CHANNELS[i], ...c }));
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_CHANNELS;
}

function nearestOption(options: number[], value: number): number {
  return options.reduce((best, opt) => (Math.abs(opt - value) < Math.abs(best - value) ? opt : best));
}

function formatTimePerDiv(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return `${(v * 1e6).toFixed(0)} µs/div`;
  if (abs < 1) return `${(v * 1e3).toFixed(0)} ms/div`;
  return `${v.toFixed(2)} s/div`;
}

function formatVoltsPerDiv(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1) return `${(v * 1000).toFixed(0)} mV/div`;
  return `${v.toFixed(2)} V/div`;
}

function formatRelTime(v: number): string {
  const abs = Math.abs(v);
  if (abs < 1e-3) return `${(v * 1e6).toFixed(0)}µs`;
  if (abs < 1) return `${(v * 1e3).toFixed(1)}ms`;
  return `${v.toFixed(3)}s`;
}

function evenSplits(count: number) {
  return (_u: uPlot, _axisIdx: number, min: number, max: number): number[] => {
    const step = (max - min) / count;
    return Array.from({ length: count + 1 }, (_, i) => min + i * step);
  };
}

const LABEL_BASE: Record<"h" | "v", { left: number; top: number }> = {
  h: { left: 2, top: -14 },
  v: { left: 2, top: 2 },
};

function makeCursorEl(orientation: "h" | "v", onStartDrag: () => void): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `scope-cursor scope-cursor-${orientation}`;
  const label = document.createElement("span");
  label.className = "scope-cursor-label";
  const base = LABEL_BASE[orientation];
  label.style.left = `${base.left}px`;
  label.style.top = `${base.top}px`;
  el.appendChild(label);
  // The label bubbles its mousedown up to this same handler (it's a plain
  // DOM child), so grabbing the label drags the cursor exactly like
  // grabbing the line -- just with a much bigger, easier target.
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    onStartDrag();
  });
  return el;
}

export function ScopeView() {
  // Optimistic default: the mock driver never sends scope_status events
  // at all, and a real device that's already connected won't send one
  // until something changes -- absence of an event should never read as
  // "disconnected".
  const [scopeConnected, setScopeConnected] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const buffersRef = useRef<Record<number, number[]>>(
    Object.fromEntries(DEFAULT_CHANNELS.map((c) => [c.id, []])),
  );
  const xBufferRef = useRef<number[]>([]);
  const dirtyRef = useRef(false);
  const tickCounterRef = useRef(0);

  const [channels, setChannels] = useState<ChannelConfig[]>(loadChannels);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  type CalStatus = { state: "busy" | "ok" | "error"; message?: string };
  const [calStatus, setCalStatus] = useState<Record<number, CalStatus>>({});
  const [timebaseBusy, setTimebaseBusy] = useState(false);
  const [rangeBusy, setRangeBusy] = useState<Record<number, boolean>>({});

  const [frozen, setFrozen] = useState(false);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  const [panMode, setPanMode] = useState(false);
  const panModeRef = useRef(panMode);
  panModeRef.current = panMode;
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<PanStart | null>(null);

  const [hCursors, setHCursors] = useState<CursorPair>({ enabled: false, a: 0, b: 0 });
  const [vCursors, setVCursors] = useState<CursorPair>({ enabled: false, a: 0, b: 0 });
  const hCursorsRef = useRef(hCursors);
  hCursorsRef.current = hCursors;
  const vCursorsRef = useRef(vCursors);
  vCursorsRef.current = vCursors;

  const [zoomRange, setZoomRange] = useState<{ x: Range | null; y: Range | null }>({
    x: null,
    y: null,
  });
  // Live auto-fit range, sampled periodically while streaming, so the
  // time/div and volts/div readouts mean something even before the user
  // freezes or manually sets a scale.
  const [liveXRange, setLiveXRange] = useState<Range>([0, 1]);
  const [liveYRange, setLiveYRange] = useState<Range>([-5, 5]);

  const draggingRef = useRef<DragTarget>(null);
  const cursorElsRef = useRef<{
    h1: HTMLDivElement;
    h2: HTMLDivElement;
    v1: HTMLDivElement;
    v2: HTMLDivElement;
  } | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(channels));
  }, [channels]);

  // Only visibility/color/order changes require rebuilding the uPlot
  // instance; offset changes are applied per-frame in the render tick
  // below, without touching series definitions.
  const structuralKey = useMemo(
    () => channels.map((c) => `${c.id}:${c.enabled}:${c.color}`).join("|"),
    [channels],
  );
  const zoomKey = useMemo(
    () => `${zoomRange.x?.join(",") ?? ""}_${zoomRange.y?.join(",") ?? ""}`,
    [zoomRange],
  );

  function buildSeriesData(): uPlot.AlignedData {
    const visible = channelsRef.current.filter((c) => c.enabled);
    const series = visible.map((c) =>
      c.attenuation === 1 && c.offset === 0
        ? buffersRef.current[c.id]
        : buffersRef.current[c.id].map((v) => v * c.attenuation + c.offset),
    );
    return [xBufferRef.current, ...series] as unknown as uPlot.AlignedData;
  }

  function repositionCursors() {
    const plot = plotRef.current;
    const els = cursorElsRef.current;
    if (!plot || !els) return;
    const h = hCursorsRef.current;
    const v = vCursorsRef.current;
    const t0 = xBufferRef.current[0] ?? 0;

    els.h1.style.display = els.h2.style.display = h.enabled ? "block" : "none";
    els.v1.style.display = els.v2.style.display = v.enabled ? "block" : "none";

    if (h.enabled) {
      els.h1.style.top = `${plot.valToPos(h.a, "y")}px`;
      els.h2.style.top = `${plot.valToPos(h.b, "y")}px`;
      els.h1.querySelector(".scope-cursor-label")!.textContent = `${h.a.toFixed(3)} V`;
      els.h2.querySelector(".scope-cursor-label")!.textContent = `${h.b.toFixed(3)} V`;
    }
    if (v.enabled) {
      els.v1.style.left = `${plot.valToPos(v.a, "x")}px`;
      els.v2.style.left = `${plot.valToPos(v.b, "x")}px`;
      els.v1.querySelector(".scope-cursor-label")!.textContent = formatRelTime(v.a - t0);
      els.v2.querySelector(".scope-cursor-label")!.textContent = formatRelTime(v.b - t0);
    }
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const visible = channelsRef.current.filter((c) => c.enabled);
    const t0 = xBufferRef.current[0] ?? 0;
    const opts: uPlot.Options = {
      width: el.clientWidth || 800,
      height: el.clientHeight || 520,
      scales: {
        x: { time: false, ...(zoomRange.x ? { range: () => zoomRange.x! } : {}) },
        y: { ...(zoomRange.y ? { range: () => zoomRange.y! } : {}) },
      },
      axes: [
        {
          splits: evenSplits(DIVS_X),
          values: (_u, ticks) => ticks.map((t) => formatRelTime(t - t0)),
        },
        {
          splits: evenSplits(DIVS_Y),
          values: (_u, ticks) => ticks.map((v) => `${v.toFixed(2)}V`),
          size: 60,
        },
      ],
      series: [
        { label: "t" },
        ...visible.map((c) => ({
          label: `CH${c.id + 1}`,
          stroke: c.color,
          width: 1.5,
        })),
      ],
    };
    const plot = new uPlot(opts, buildSeriesData(), el);
    plotRef.current = plot;

    const h1 = makeCursorEl("h", () => (draggingRef.current = "h1"));
    const h2 = makeCursorEl("h", () => (draggingRef.current = "h2"));
    const v1 = makeCursorEl("v", () => (draggingRef.current = "v1"));
    const v2 = makeCursorEl("v", () => (draggingRef.current = "v2"));
    plot.over.append(h1, h2, v1, v2);
    cursorElsRef.current = { h1, h2, v1, v2 };
    repositionCursors();

    plot.over.addEventListener("mousedown", (e) => {
      if (!panModeRef.current || draggingRef.current) return;
      e.preventDefault();
      const rect = plot.over.getBoundingClientRect();
      const xRange: Range = [plot.scales.x.min ?? 0, plot.scales.x.max ?? 1];
      const yRange: Range = [plot.scales.y.min ?? -5, plot.scales.y.max ?? 5];
      panStartRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        xRange,
        yRange,
        xUnitsPerPx: (xRange[1] - xRange[0]) / rect.width,
        yUnitsPerPx: (yRange[1] - yRange[0]) / rect.height,
      };
      setFrozen(true);
      setIsPanning(true);
    });

    return () => {
      plot.destroy();
      plotRef.current = null;
      cursorElsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey, zoomKey]);

  useEffect(repositionCursors, [hCursors, vCursors]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const plot = plotRef.current;
      if (!plot) return;

      const pan = panStartRef.current;
      if (pan) {
        const dx = (e.clientX - pan.clientX) * pan.xUnitsPerPx;
        const dy = (e.clientY - pan.clientY) * pan.yUnitsPerPx;
        plot.setScale("x", { min: pan.xRange[0] - dx, max: pan.xRange[1] - dx });
        plot.setScale("y", { min: pan.yRange[0] + dy, max: pan.yRange[1] + dy });
        return;
      }

      const which = draggingRef.current;
      if (!which) return;
      const rect = plot.over.getBoundingClientRect();
      if (which === "h1" || which === "h2") {
        const val = plot.posToVal(e.clientY - rect.top, "y");
        setHCursors((prev) => (which === "h1" ? { ...prev, a: val } : { ...prev, b: val }));
      } else {
        const val = plot.posToVal(e.clientX - rect.left, "x");
        setVCursors((prev) => (which === "v1" ? { ...prev, a: val } : { ...prev, b: val }));
      }
    }
    function onUp() {
      draggingRef.current = null;
      const plot = plotRef.current;
      if (panStartRef.current && plot) {
        setZoomRange({
          x: [plot.scales.x.min ?? 0, plot.scales.x.max ?? 1],
          y: [plot.scales.y.min ?? -5, plot.scales.y.max ?? 5],
        });
      }
      panStartRef.current = null;
      setIsPanning(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useSocket<ScopeEvent>("/ws/stream/scope", (event) => {
    if (event.type === "scope_status") {
      setScopeConnected(event.connected);
      return;
    }
    const batch = event;
    // Each burst-mode capture is a self-contained window (a few ms), with
    // real dead time before the next one (USB/protocol overhead between
    // captures -- see docs/hantek1008c.md). Concatenating batches into one
    // rolling buffer drew a straight line across that dead time, faking a
    // ramp between real captures. So each new batch replaces the buffer
    // outright rather than appending to a rolling history.
    const nSamples = Object.values(batch.channels)[0]?.length ?? 0;
    const xs = new Array<number>(nSamples);
    for (let i = 0; i < nSamples; i++) {
      xs[i] = batch.t0 + i * batch.dt;
    }
    xBufferRef.current = xs;
    const buffers: Record<number, number[]> = {};
    for (let ch = 0; ch < 8; ch++) {
      buffers[ch] = batch.channels[String(ch)] ?? new Array(nSamples).fill(NaN);
    }
    buffersRef.current = buffers;
    dirtyRef.current = true;
  });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (dirtyRef.current && plotRef.current && !frozenRef.current) {
        plotRef.current.setData(buildSeriesData());
        dirtyRef.current = false;
        tickCounterRef.current++;
        if (tickCounterRef.current % 15 === 0) {
          const sx = plotRef.current.scales.x;
          const sy = plotRef.current.scales.y;
          if (sx.min != null && sx.max != null) setLiveXRange([sx.min, sx.max]);
          if (sy.min != null && sy.max != null) setLiveYRange([sy.min, sy.max]);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function updateChannel(id: number, patch: Partial<ChannelConfig>) {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  // Reconfigures the channel's actual hardware input range -- distinct
  // from volts/div (a display-only zoom of already-captured data). A
  // signal that exceeds the current range clips before it's even
  // digitized; no amount of display zoom fixes that.
  async function applyChannelRange(id: number, rangeV: number) {
    updateChannel(id, { rangeV });
    setRangeBusy((s) => ({ ...s, [id]: true }));
    try {
      await setChannelRange(id, rangeV);
    } finally {
      setRangeBusy((s) => ({ ...s, [id]: false }));
    }
  }

  function moveChannel(index: number, direction: -1 | 1) {
    setChannels((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // Cable/connection quality drifts, so recalibration is meant to be run
  // whenever a channel's readings look off, not just once at setup --
  // this hits the same on-demand path as scripts/calibrate_hantek.py,
  // using the scope's built-in cal signal (move it to this channel
  // first). Not supported by the mock driver -- the endpoint just
  // returns {ok: false} in that case, shown as the error state below.
  async function recalibrate(channelId: number) {
    setCalStatus((s) => ({ ...s, [channelId]: { state: "busy" } }));
    try {
      const result = await calibrateChannel(channelId);
      setCalStatus((s) => ({
        ...s,
        [channelId]: result.ok
          ? {
              state: "ok",
              message: `${result.low_v?.toFixed(0)}-${result.high_v?.toFixed(0)} raw`,
            }
          : { state: "error", message: result.reason ?? "Calibration failed" },
      }));
    } catch {
      setCalStatus((s) => ({
        ...s,
        [channelId]: { state: "error", message: "Request failed" },
      }));
    }
  }

  // liveXRange/liveYRange (React state) is throttled for display purposes
  // and can lag well behind reality -- e.g. still at its stale initial
  // default for several seconds after load. Placing a cursor from that
  // would put it outside the actually-visible range (rendered, but off
  // screen -- looks exactly like "cursors don't work"). The plot's own
  // scales are always current, so read those directly for anything that
  // needs to be correct right now.
  function getCurrentXRange(): Range {
    if (zoomRange.x) return zoomRange.x;
    const s = plotRef.current?.scales.x;
    return s?.min != null && s?.max != null ? [s.min, s.max] : liveXRange;
  }

  function getCurrentYRange(): Range {
    if (zoomRange.y) return zoomRange.y;
    const s = plotRef.current?.scales.y;
    return s?.min != null && s?.max != null ? [s.min, s.max] : liveYRange;
  }

  function toggleHCursors(enabled: boolean) {
    if (enabled) {
      setFrozen(true);
      const [min, max] = getCurrentYRange();
      const span = max - min || 1;
      setHCursors({ enabled: true, a: min + span * 0.3, b: min + span * 0.7 });
    } else {
      setHCursors((c) => ({ ...c, enabled: false }));
    }
  }

  function toggleVCursors(enabled: boolean) {
    if (enabled) {
      setFrozen(true);
      const [min, max] = getCurrentXRange();
      const span = max - min || 1;
      setVCursors({ enabled: true, a: min + span * 0.3, b: min + span * 0.7 });
    } else {
      setVCursors((c) => ({ ...c, enabled: false }));
    }
  }

  function zoomToCursors() {
    setZoomRange({
      x: vCursors.enabled ? [Math.min(vCursors.a, vCursors.b), Math.max(vCursors.a, vCursors.b)] : null,
      y: hCursors.enabled ? [Math.min(hCursors.a, hCursors.b), Math.max(hCursors.a, hCursors.b)] : null,
    });
  }

  function resetZoom() {
    setZoomRange({ x: null, y: null });
  }

  function resumeLive() {
    setFrozen(false);
    setPanMode(false);
    setHCursors((c) => ({ ...c, enabled: false }));
    setVCursors((c) => ({ ...c, enabled: false }));
    setZoomRange({ x: null, y: null });
  }

  // Reconfigures the actual hardware capture window (not just a display
  // zoom -- see docs/hantek1008c.md, "found needing a real 60Hz sine to
  // display and discovering the default 5ms window can't show one").
  // Takes a moment (device reopen), so this doesn't force a freeze --
  // if live, the new window just shows up on the next batch.
  async function applyTimePerDiv(v: number) {
    setTimebaseBusy(true);
    try {
      await setTimebase(Math.round(v * 1e9));
      setZoomRange((z) => ({ ...z, x: null })); // stale relative to the new window
    } finally {
      setTimebaseBusy(false);
    }
  }

  function applyVoltsPerDiv(v: number) {
    setFrozen(true);
    const [min, max] = zoomRange.y ?? liveYRange;
    const center = (min + max) / 2;
    const half = (v * DIVS_Y) / 2;
    setZoomRange((z) => ({ ...z, y: [center - half, center + half] }));
  }

  const effectiveXRange = zoomRange.x ?? liveXRange;
  const effectiveYRange = zoomRange.y ?? liveYRange;
  const timePerDiv = nearestOption(TIME_PER_DIV_OPTIONS, (effectiveXRange[1] - effectiveXRange[0]) / DIVS_X);
  const voltsPerDiv = nearestOption(VOLTS_PER_DIV_OPTIONS, (effectiveYRange[1] - effectiveYRange[0]) / DIVS_Y);

  // The Hantek 1008C has a fixed ~4000-sample capture budget shared
  // evenly across active channels, independent of the timebase -- see
  // docs/hantek1008c.md. More active channels means fewer samples/div
  // regardless of Time/div, which is what actually limits how well a
  // fast signal resolves, not the timebase setting itself.
  const activeChannelCount = Math.max(channels.filter((c) => c.enabled).length, 1);
  const estSamplesPerDiv = Math.round(4000 / activeChannelCount / DIVS_X);

  const deltaV = Math.abs(hCursors.b - hCursors.a);
  const deltaT = Math.abs(vCursors.b - vCursors.a);
  const freqHz = deltaT > 0 ? 1 / deltaT : null;

  return (
    <div className="scope-container">
      {!scopeConnected && (
        <div className="scope-disconnected-banner">
          ⚠ Scope disconnected — attempting to reconnect…
        </div>
      )}
      <div
        ref={containerRef}
        className={`scope-view${panMode ? " pan-mode" : ""}${isPanning ? " pan-dragging" : ""}`}
      />
      <div className="scope-channel-panel">
        <div className="scope-toolbar">
          <button onClick={resumeLive} disabled={!frozen}>
            {frozen ? "Resume live" : "Live"}
          </button>
          {!frozen && (
            <button onClick={() => setFrozen(true)} title="Hold the trace to place cursors">
              Freeze
            </button>
          )}
          <button
            onClick={() => setPanMode((p) => !p)}
            className={panMode ? "scope-pan-active" : ""}
            title="Drag the view around to follow the captured data"
          >
            ✋ Pan
          </button>
        </div>

        <div className="scope-scale-controls">
          <label>
            Time/div {timebaseBusy && "…"}
            <select
              value={timePerDiv}
              disabled={timebaseBusy}
              onChange={(e) => void applyTimePerDiv(Number(e.target.value))}
            >
              {TIME_PER_DIV_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {formatTimePerDiv(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Volts/div
            <select
              value={voltsPerDiv}
              onChange={(e) => applyVoltsPerDiv(Number(e.target.value))}
            >
              {VOLTS_PER_DIV_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {formatVoltsPerDiv(v)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          className={`scope-resolution-note ${
            estSamplesPerDiv < 20 ? "scope-res-bad" : estSamplesPerDiv < 50 ? "scope-res-marginal" : ""
          }`}
          title="The device has a fixed ~4000-sample capture budget split evenly across active channels, independent of Time/div -- fewer active channels means finer resolution on fast signals in the same capture. See docs/hantek1008c.md."
        >
          ~{estSamplesPerDiv} samples/div ({activeChannelCount} ch active)
          {estSamplesPerDiv < 20 && " -- too few for fast signals, disable channels"}
          {estSamplesPerDiv >= 20 && estSamplesPerDiv < 50 && " -- marginal for fast signals"}
        </div>

        <div className="scope-cursor-controls">
          <label className="scope-cursor-toggle">
            <input
              type="checkbox"
              checked={hCursors.enabled}
              onChange={(e) => toggleHCursors(e.target.checked)}
            />
            Voltage cursors
            {hCursors.enabled && <span className="scope-readout">ΔV {deltaV.toFixed(3)} V</span>}
          </label>
          <label className="scope-cursor-toggle">
            <input
              type="checkbox"
              checked={vCursors.enabled}
              onChange={(e) => toggleVCursors(e.target.checked)}
            />
            Time cursors
            {vCursors.enabled && (
              <span className="scope-readout">
                Δt {(deltaT * 1000).toFixed(3)} ms
                {freqHz !== null && ` (${freqHz.toFixed(2)} Hz)`}
              </span>
            )}
          </label>
          <div className="scope-zoom-actions">
            <button
              onClick={zoomToCursors}
              disabled={!hCursors.enabled && !vCursors.enabled}
            >
              Zoom to cursors
            </button>
            <button onClick={resetZoom} disabled={!zoomRange.x && !zoomRange.y}>
              Reset zoom
            </button>
          </div>
        </div>

        <div className="scope-channel-list">
          {channels.map((c, i) => (
            <div className="scope-channel-block" key={c.id}>
              <div className="scope-channel-row">
                <input
                  type="color"
                  value={c.color}
                  onChange={(e) => updateChannel(c.id, { color: e.target.value })}
                  title="Trace color"
                />
                <label className="scope-channel-label">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={(e) => updateChannel(c.id, { enabled: e.target.checked })}
                  />
                  CH{c.id + 1}
                </label>
                <input
                  className="scope-channel-offset"
                  type="range"
                  min={-50}
                  max={50}
                  step={0.5}
                  value={c.offset}
                  onChange={(e) => updateChannel(c.id, { offset: Number(e.target.value) })}
                  title={`Position offset: ${c.offset} V`}
                />
                <div className="scope-channel-move">
                  <button onClick={() => moveChannel(i, -1)} disabled={i === 0} title="Move up">
                    ▲
                  </button>
                  <button
                    onClick={() => moveChannel(i, 1)}
                    disabled={i === channels.length - 1}
                    title="Move down"
                  >
                    ▼
                  </button>
                </div>
              </div>
              <div className="scope-channel-settings-row">
                <select
                  className="scope-channel-range"
                  value={c.rangeV}
                  disabled={rangeBusy[c.id]}
                  onChange={(e) => void applyChannelRange(c.id, Number(e.target.value))}
                  title="Input range -- a signal exceeding this clips before it's digitized"
                >
                  {RANGE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <select
                  className="scope-channel-atten"
                  value={c.attenuation}
                  onChange={(e) => updateChannel(c.id, { attenuation: Number(e.target.value) })}
                  title="Probe/attenuator ratio -- scales the displayed voltage to match what's actually at the probe tip"
                >
                  {ATTENUATION_OPTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="scope-channel-cal-row">
                <button
                  onClick={() => void recalibrate(c.id)}
                  disabled={calStatus[c.id]?.state === "busy"}
                  title="Move the scope's built-in cal signal to this channel first, then recalibrate"
                >
                  {calStatus[c.id]?.state === "busy" ? "Calibrating…" : "Recalibrate"}
                </button>
                {calStatus[c.id] && calStatus[c.id].state !== "busy" && (
                  <span className={`scope-cal-status scope-cal-${calStatus[c.id].state}`}>
                    {calStatus[c.id].state === "ok" ? "✓" : "✗"} {calStatus[c.id].message}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
