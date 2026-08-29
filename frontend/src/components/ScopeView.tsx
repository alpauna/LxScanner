import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useSocket } from "../ws";
import { calibrateChannel, getScopeSource, setChannelRange, setScopeSource, setTimebase } from "../api";
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
const HISTORY_STORAGE_KEY = "lxscanner-scope-history-seconds";
const DIVS_X = 10;
const DIVS_Y = 8;
// How much retained history the rolling buffer keeps for Freeze+Pan to
// scrub through. Configurable (not just a code constant) since the
// right depth trades off against memory/redraw cost -- 5s at Teensy's
// ~45.4kHz x8ch is ~15MB; 20s is ~58MB and every freeze/pan-commit/
// Volts-div/source-switch rebuilds the whole uPlot instance with
// however much is loaded, so very large values may feel janky.
const HISTORY_SECONDS_OPTIONS = [1, 2, 5, 10, 20];
const DEFAULT_HISTORY_SECONDS = 5;
// Gap threshold is relative to each batch's own dt, not a fixed constant
// -- a fixed threshold that comfortably clears Hantek's ~tens-to-hundreds
// of ms of real inter-burst dead time is not automatically small enough
// for Teensy: its backend queue drops the oldest frame under backpressure
// (see teensydaq/driver.py's _enqueue), and a single dropped frame is
// only ~2.8ms (128 samples x ~22us) -- comfortably *under* a 5ms fixed
// threshold, so it would render as a smeared diagonal instead of a gap.
// A small multiple of the batch's own dt scales correctly for every
// source: tiny for Teensy (so it actually catches a dropped frame) while
// still trivially far below Hantek's real dead time (whose own dt is
// similarly small).
const GAP_THRESHOLD_DT_MULTIPLIER = 3;
const SCOPE_SOURCE_LABELS: Record<string, string> = {
  mock: "Mock",
  hantek: "Hantek 1008C",
  teensy: "Teensy DAQ",
};
// Hantek's hardware timebase (ns_per_div) is a fixed 1-2-5 sequence, max
// 200ms/div -- see vendor.py's __burst_mode_ns_per_div_to_id_dic. Values
// here are in seconds and converted to ns_per_div (*1e9) when applied via
// the setTimebase RPC, which reconfigures the device's actual capture
// window (not just a display zoom).
//
// The Teensy DAQ streams continuously; each displayed frame is a fixed
// ~2.8ms window (128 samples x ~22us/sample, see docs/teensy_daq.md
// Phase A) that gets replaced wholesale on every batch. There's no
// hardware capture-window RPC to reconfigure for it (setTimebase is
// skipped for this source), so its options are a pure display zoom
// within that one frame rather than a request for a different window.
const TIME_PER_DIV_OPTIONS_BY_SOURCE: Record<string, number[]> = {
  hantek: [
    0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1,
    0.2,
  ],
  mock: [
    0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1,
    0.2,
  ],
  teensy: [0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005],
};
const VOLTS_PER_DIV_OPTIONS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
// Hantek's hardware only has 3 real input ranges (see _nearest_vscale in
// driver.py); these values each land solidly in one bucket. Found
// 2026-08-25: a real signal (10x probe, 60Hz pickup, ~7.7Vpp) clipped
// hard against the default 5V range's actual ~2.5V headroom.
//
// The Teensy DAQ's AD7606C-16 runs in hardware mode, where one RANGE pin
// selects +/-5V or +/-10V for all 8 channels at once (not per-channel) --
// see teensydaq/driver.py's set_channel_range docstring.
const RANGE_OPTIONS_BY_SOURCE: Record<string, { value: number; label: string }[]> = {
  hantek: [
    { value: 1, label: "±1V (sensitive)" },
    { value: 5, label: "±5V (sensors, default)" },
    { value: 40, label: "±40V (ignition, mains)" },
  ],
  mock: [
    { value: 1, label: "±1V (sensitive)" },
    { value: 5, label: "±5V (sensors, default)" },
    { value: 40, label: "±40V (ignition, mains)" },
  ],
  teensy: [
    { value: 5, label: "±5V (default)" },
    { value: 10, label: "±10V" },
  ],
};
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

function loadHistorySeconds(): number {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (raw) {
      const n = Number(raw);
      if (HISTORY_SECONDS_OPTIONS.includes(n)) return n;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_HISTORY_SECONDS;
}

function nearestOption(options: number[], value: number): number {
  return options.reduce((best, opt) => (Math.abs(opt - value) < Math.abs(best - value) ? opt : best));
}

// Plain for-loop rather than `dst.push(...src)` -- spread/apply has an
// engine argument-count ceiling that a large batch could in principle hit.
function appendAll<T>(dst: T[], src: readonly T[]) {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

function lowerBound(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
  const [scopeSource, setScopeSourceState] = useState<string>("mock");
  const [availableSources, setAvailableSources] = useState<string[]>(["mock"]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const buffersRef = useRef<Record<number, (number | null)[]>>(
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

  // Desired live-window width in seconds, driven by the Time/div control.
  // Promoted to real state (rather than derived from the current zoom
  // span, as before) because the live x-range now has to be *computed*
  // from it every render -- see the plot-creation effect's x scale
  // `range()` below. The ref mirror is required, not just idiomatic:
  // that `range()` closure lives inside an effect keyed on
  // structuralKey/zoomKey, so it wouldn't see a plain-state update.
  const [timePerDivSec, setTimePerDivSec] = useState(0.001);
  const timePerDivSecRef = useRef(timePerDivSec);
  timePerDivSecRef.current = timePerDivSec;

  const [historySeconds, setHistorySeconds] = useState<number>(loadHistorySeconds);
  const historySecondsRef = useRef(historySeconds);
  historySecondsRef.current = historySeconds;

  const [panMode, setPanMode] = useState(false);
  const panModeRef = useRef(panMode);
  panModeRef.current = panMode;
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<PanStart | null>(null);
  // The x range() function's drag branch returns this, not uPlot's own
  // dataMin/dataMax -- setData() calls from ongoing background ingestion
  // (which never pauses, even mid-drag) also trigger range() with
  // auto-fit bounds unrelated to the drag, and would otherwise stomp the
  // dragged position between mousemove events. This ref is the single
  // source of truth for "where the drag currently is," updated only by
  // onMove's own setScale() call below.
  const panScaleXRef = useRef<Range | null>(null);

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
  // Live auto-fit Y range, sampled periodically while streaming, so the
  // Volts/div readout means something even before the user freezes or
  // manually sets a scale. X has no equivalent -- see computeLiveXRange.
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

  useEffect(() => {
    localStorage.setItem(HISTORY_STORAGE_KEY, String(historySeconds));
  }, [historySeconds]);

  useEffect(() => {
    getScopeSource()
      .then((info) => {
        setScopeSourceState(info.active);
        setAvailableSources(info.available);
        // The initial timePerDivSec (0.001) isn't a valid option for
        // every source's list (Teensy's tops out at 500us) -- applySource
        // clamps on an explicit switch, but this passive mount-time fetch
        // needs the same treatment for whatever source the backend
        // already happened to be on. Found via a real repro: with
        // 0.001 outside Teensy's option list, the <select> silently fell
        // back to displaying its first option while the actual
        // timePerDivSec state stayed stuck at 0.001 -- so the dropdown
        // read "10 us/div" while the rendered window was really 10ms
        // wide (0.001 * DIVS_X), a visible, confusing desync.
        setTimePerDivSec((prev) =>
          nearestOption(TIME_PER_DIV_OPTIONS_BY_SOURCE[info.active] ?? TIME_PER_DIV_OPTIONS_BY_SOURCE.mock, prev),
        );
      })
      .catch(() => {
        // Backend not reachable yet -- keep the "mock" default, the
        // socket-status banner already covers reporting disconnection.
      });
  }, []);

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
    // Always hand uPlot fresh array objects, never buffersRef.current's
    // own arrays directly (even in the "no transform needed" fast path)
    // -- ingestion now appends in place via .push() for performance
    // (see the WS handler), rather than replacing the array wholesale
    // like the old per-batch code did. uPlot's setData() likely does a
    // reference-equality fast path internally; handing back the *same*
    // mutated-in-place array on a later call can make it think nothing
    // changed and skip reprocessing, even though the contents grew.
    const series = visible.map((c) =>
      c.attenuation === 1 && c.offset === 0
        ? buffersRef.current[c.id].slice()
        : buffersRef.current[c.id].map((v) => (v === null ? null : v * c.attenuation + c.offset)),
    );
    return [xBufferRef.current.slice(), ...series] as unknown as uPlot.AlignedData;
  }

  // Drops retained history older than `seconds` (relative to the newest
  // sample), by timestamp rather than sample count -- avoids needing to
  // reason about per-source rate math, and self-amortizes: most calls are
  // a no-op (buffer not yet 2x over target), so the O(n) slice only
  // actually runs roughly once per `seconds` worth of new data. This also
  // means a sudden large forward time jump (tab backgrounded, one batch
  // arrives with a far-future t0) gets caught on the very next batch,
  // where a count-based ratio might not notice for a while.
  function trimBuffers(seconds: number) {
    const xs = xBufferRef.current;
    if (xs.length === 0) return;
    const latest = xs[xs.length - 1];
    if (xs[0] >= latest - seconds * 2) return;
    const cutIdx = lowerBound(xs, latest - seconds);
    if (cutIdx <= 0) return;
    xBufferRef.current = xs.slice(cutIdx);
    for (let ch = 0; ch < 8; ch++) {
      buffersRef.current[ch] = buffersRef.current[ch].slice(cutIdx);
    }
  }

  function clearHistory() {
    xBufferRef.current = [];
    for (let ch = 0; ch < 8; ch++) buffersRef.current[ch] = [];
  }

  // Computes the live sliding window directly from the buffer/ref, not
  // from the plot's last-rendered scale -- the plot's scale is only as
  // fresh as the last time setData()/range() actually ran, which is
  // gated by the RAF render tick and can lag arbitrarily (confirmed via
  // a throttled tab lagging several seconds behind the true buffer here).
  // xBufferRef/timePerDivSecRef are written synchronously and are always
  // current regardless of rendering cadence.
  function computeLiveXRange(): Range {
    const buf = xBufferRef.current;
    const latest = buf.length ? buf[buf.length - 1] : 1;
    return [latest - timePerDivSecRef.current * DIVS_X, latest];
  }

  function repositionCursors() {
    const plot = plotRef.current;
    const els = cursorElsRef.current;
    if (!plot || !els) return;
    const h = hCursorsRef.current;
    const v = vCursorsRef.current;
    // The viewport's own left edge, not the buffer's oldest retained
    // sample -- with retained history that could be many seconds back,
    // which would make cursor deltas read as huge, meaningless offsets.
    const t0 = plot.scales.x.min ?? 0;

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
    const opts: uPlot.Options = {
      width: el.clientWidth || 800,
      height: el.clientHeight || 520,
      scales: {
        x: {
          time: false,
          range: () => {
            // Active pan drag: return the drag's own tracked position
            // (panScaleXRef), not uPlot's dataMin/dataMax -- background
            // ingestion never pauses mid-drag, and its setData() calls
            // also invoke this range() function with auto-fit bounds
            // unrelated to the drag, which would otherwise stomp the
            // dragged position between mousemove events (confirmed: the
            // final position after a full drag matched the pre-drag
            // position exactly, with no net movement).
            if (panStartRef.current) return panScaleXRef.current ?? computeLiveXRange();
            if (zoomRange.x) return zoomRange.x;
            // Live: slide a window of the desired Time/div width to
            // follow the newest retained sample, rather than trusting
            // uPlot's own auto-fit (which would show the *entire*
            // retained history compressed, not a scrolling recent slice,
            // now that the buffer can hold many seconds of it).
            return computeLiveXRange();
          },
        },
        y: { ...(zoomRange.y ? { range: () => zoomRange.y! } : {}) },
      },
      axes: [
        {
          splits: evenSplits(DIVS_X),
          // Reads the viewport's own left edge (u.scales.x.min), not a
          // closure-captured buffer start -- same reasoning as
          // repositionCursors above.
          values: (u, ticks) => ticks.map((t) => formatRelTime(t - (u.scales.x.min ?? 0))),
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
      panScaleXRef.current = xRange;
      // No zoomRange pin here -- the x range() function above already
      // tracks the live drag position for the whole drag duration
      // (panStartRef.current branch), and onUp's setZoomRange commit
      // below naturally derives `frozen = true` once the drag ends.
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
        panScaleXRef.current = [pan.xRange[0] - dx, pan.xRange[1] - dx];
        plot.setScale("x", { min: panScaleXRef.current[0], max: panScaleXRef.current[1] });
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
        // panScaleXRef, not plot.scales.x -- same reasoning as the
        // range() drag branch above: background ingestion's own setData
        // calls can race a read of the plot's scale right at mouseup.
        setZoomRange({
          x: panScaleXRef.current ?? [plot.scales.x.min ?? 0, plot.scales.x.max ?? 1],
          y: [plot.scales.y.min ?? -5, plot.scales.y.max ?? 5],
        });
      }
      panStartRef.current = null;
      panScaleXRef.current = null;
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
    const nSamples = Object.values(batch.channels)[0]?.length ?? 0;
    if (nSamples === 0) return;
    const newXs = new Array<number>(nSamples);
    for (let i = 0; i < nSamples; i++) {
      newXs[i] = batch.t0 + i * batch.dt;
    }

    // Timeline went backwards (stray backend-restart edge case -- a
    // fresh process's monotonic clock starts small again): can't bridge
    // it, so discard the old, now-incomparable history.
    const xs0 = xBufferRef.current;
    if (xs0.length > 0 && newXs[0] < xs0[xs0.length - 1]) {
      clearHistory();
    }

    const xs = xBufferRef.current;
    const lastX = xs.length ? xs[xs.length - 1] : null;
    // Each burst-mode capture is a self-contained window, with real dead
    // time before the next one for Hantek (USB/protocol overhead between
    // captures -- see docs/hantek1008c.md); Teensy/Mock have no designed
    // gap. Rather than replacing the buffer outright (which drew a
    // straight line across that dead time, faking a ramp), insert one
    // null marker -- uPlot's documented gap sentinel -- when the gap is
    // real, then append into the rolling history. The marker goes into
    // all 8 raw channel arrays (not just enabled ones), since
    // buildSeriesData filters to enabled channels afterward and every
    // array must stay the same length.
    if (lastX !== null && newXs[0] - lastX > batch.dt * GAP_THRESHOLD_DT_MULTIPLIER) {
      xs.push(lastX + 1e-9);
      for (let ch = 0; ch < 8; ch++) buffersRef.current[ch].push(null);
    }

    appendAll(xs, newXs);
    for (let ch = 0; ch < 8; ch++) {
      const values = batch.channels[String(ch)] ?? new Array<null>(nSamples).fill(null);
      appendAll(buffersRef.current[ch], values);
    }

    // Skip trimming while frozen: the pinned viewport can be anywhere in
    // the buffer, and trimming purely relative to "now" would eventually
    // age it out from under the user mid-inspection (reproduced: freeze,
    // wait longer than historySeconds, the pinned window silently falls
    // out of the retained range, leaving a blank chart with the
    // underlying data already gone -- not just out of view). Ingestion
    // still keeps running so nothing is missed; resumeLive() re-imposes
    // the bound in one catch-up trim once the pin is released.
    if (zoomRange.x === null) trimBuffers(historySecondsRef.current);
    dirtyRef.current = true;
  });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // No longer gated on frozen: ingestion/rendering must keep running
      // in the background while paused, so panning can reach data
      // accumulated *during* the pause, and Resume-live has no gap to
      // catch up on. Freeze instead pins the viewport (zoomRange) --
      // see freezeViewport below -- which the x/y range() functions
      // respect regardless of whether setData keeps getting called.
      if (dirtyRef.current && plotRef.current) {
        plotRef.current.setData(buildSeriesData());
        dirtyRef.current = false;
        tickCounterRef.current++;
        // Y only -- X's "live" range is now computeLiveXRange() (buffer-
        // based, always current), so there's nothing left reading a
        // throttled liveXRange snapshot.
        if (tickCounterRef.current % 15 === 0) {
          const sy = plotRef.current.scales.y;
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

  // liveYRange (React state) is throttled for display purposes and can
  // lag well behind reality -- e.g. still at its stale initial default
  // for several seconds after load. Placing a cursor from that would put
  // it outside the actually-visible range (rendered, but off screen --
  // looks exactly like "cursors don't work"). The plot's own Y scale is
  // current as of the last actual render, which is good enough for Y
  // (bounded values, unlike X's ever-advancing timestamp -- see
  // computeLiveXRange for why X needs a stronger guarantee).
  function getCurrentXRange(): Range {
    if (zoomRange.x) return zoomRange.x;
    // computeLiveXRange (buffer/ref-based), not the plot's rendered
    // scale -- the scale is only as fresh as the last RAF-gated setData
    // call, which can lag behind the true buffer (confirmed: a throttled
    // tab lagged several seconds here, and this feeds Freeze's pin).
    return computeLiveXRange();
  }

  function getCurrentYRange(): Range {
    if (zoomRange.y) return zoomRange.y;
    const s = plotRef.current?.scales.y;
    return s?.min != null && s?.max != null ? [s.min, s.max] : liveYRange;
  }

  // Pins the viewport at its current live position, on both axes. This
  // *is* what "frozen" means now (see the derived `frozen` below) --
  // every action that used to just flip a `frozen` boolean must pin
  // zoomRange instead, or the live x range() function above keeps
  // sliding forward under a nominally "frozen" trace. Callers that need
  // the pinned value in the same tick (e.g. for cursor placement math)
  // must use the return value, not re-read zoomRange state afterward --
  // setState isn't synchronous.
  function freezeViewport(): { x: Range; y: Range } {
    const x = getCurrentXRange();
    const y = getCurrentYRange();
    setZoomRange({ x, y });
    return { x, y };
  }

  function toggleHCursors(enabled: boolean) {
    if (enabled) {
      const { y } = freezeViewport();
      const [min, max] = y;
      const span = max - min || 1;
      setHCursors({ enabled: true, a: min + span * 0.3, b: min + span * 0.7 });
    } else {
      setHCursors((c) => ({ ...c, enabled: false }));
    }
  }

  function toggleVCursors(enabled: boolean) {
    if (enabled) {
      const { x } = freezeViewport();
      const [min, max] = x;
      const span = max - min || 1;
      setVCursors({ enabled: true, a: min + span * 0.3, b: min + span * 0.7 });
    } else {
      setVCursors((c) => ({ ...c, enabled: false }));
    }
  }

  function zoomToCursors() {
    // Preserve the current pin on an axis whose cursors aren't enabled,
    // rather than forcing it back to `null` (live) -- with `frozen`
    // derived from `zoomRange.x`, blindly nulling it here would silently
    // un-freeze time as a side effect of a Y-only cursor zoom.
    setZoomRange((z) => ({
      x: vCursors.enabled ? [Math.min(vCursors.a, vCursors.b), Math.max(vCursors.a, vCursors.b)] : z.x,
      y: hCursors.enabled ? [Math.min(hCursors.a, hCursors.b), Math.max(hCursors.a, hCursors.b)] : z.y,
    }));
  }

  function resetZoom() {
    setZoomRange({ x: null, y: null });
  }

  function resumeLive() {
    setPanMode(false);
    setHCursors((c) => ({ ...c, enabled: false }));
    setVCursors((c) => ({ ...c, enabled: false }));
    setZoomRange({ x: null, y: null });
    // Catch up trimming skipped while frozen (see the WS handler) --
    // otherwise a long pause leaves the buffer over-grown until enough
    // new data organically arrives to trigger the next trim.
    trimBuffers(historySecondsRef.current);
  }

  // Sets the desired live-window width. For Hantek this also reconfigures
  // the actual hardware capture window (not just a display zoom -- see
  // docs/hantek1008c.md, "found needing a real 60Hz sine to display and
  // discovering the default 5ms window can't show one") -- the Teensy DAQ
  // has no such RPC (every frame is a fixed ~22us/sample stream with no
  // settable window), so that branch is skipped for it, and Mock's
  // backend `set_timebase` is a no-op. Either way, going live (zoomRange.x
  // = null) hands control to the x scale's range() function in the
  // plot-creation effect, which now computes the sliding live window from
  // `timePerDivSec` on every render -- no freeze/absolute-zoom hack needed
  // (the retained rolling buffer means there's always real data to slide
  // across, unlike the old single-frame-per-batch model).
  async function applyTimePerDiv(v: number) {
    setTimebaseBusy(true);
    try {
      setTimePerDivSec(v);
      if (scopeSource !== "teensy") await setTimebase(Math.round(v * 1e9));
      setZoomRange((z) => ({ ...z, x: null }));
    } finally {
      setTimebaseBusy(false);
    }
  }

  // Switches the active physical scope source. Connects the new driver
  // before disturbing anything (see backend/app/scope/factory.py) -- on
  // failure the backend leaves the previous source running untouched, so
  // roll the UI back to it too rather than showing a source that isn't
  // actually active. scopeConnected resets to true optimistically, same
  // reasoning as its initial default: absence of a scope_status event
  // must never read as "disconnected".
  async function applySource(source: string) {
    const previous = scopeSource;
    setScopeSourceState(source);
    setScopeConnected(true);
    setSourceBusy(true);
    // A source switch isn't a gap to bridge, it's a different, often
    // incomparable clock entirely (Hantek/Teensy use the backend
    // process's time.monotonic(); Mock's is a synthetic clock that
    // resets to 0 on every fresh MockDriver instance, which is
    // constructed anew on every switch to mock) -- clear the retained
    // history rather than let a real gap-marker try to bridge it, and
    // drop anything anchored to the old timeline. Doing this
    // unconditionally (not just on success) is fine: the backend
    // connects the new driver before touching the old one, so a failed
    // switch never actually interrupted the previous stream -- a
    // rolled-back switch just costs one buffer refill.
    clearHistory();
    setZoomRange({ x: null, y: null });
    setHCursors((c) => ({ ...c, enabled: false }));
    setVCursors((c) => ({ ...c, enabled: false }));
    setTimePerDivSec((prev) =>
      nearestOption(TIME_PER_DIV_OPTIONS_BY_SOURCE[source] ?? TIME_PER_DIV_OPTIONS_BY_SOURCE.mock, prev),
    );
    try {
      const result = await setScopeSource(source);
      if (!result.ok) {
        setScopeSourceState(previous);
      }
    } catch {
      setScopeSourceState(previous);
    } finally {
      setSourceBusy(false);
    }
  }

  function applyVoltsPerDiv(v: number) {
    // Pins X too (freezing time), not just Y -- otherwise, since `frozen`
    // is now derived from `zoomRange.x`, a Volts/div change would leave
    // time free to keep sliding under a nominally "frozen" Y.
    const { x, y } = freezeViewport();
    const [min, max] = y;
    const center = (min + max) / 2;
    const half = (v * DIVS_Y) / 2;
    setZoomRange({ x, y: [center - half, center + half] });
  }

  const rangeOptions = RANGE_OPTIONS_BY_SOURCE[scopeSource] ?? RANGE_OPTIONS_BY_SOURCE.mock;
  const timePerDivOptions =
    TIME_PER_DIV_OPTIONS_BY_SOURCE[scopeSource] ?? TIME_PER_DIV_OPTIONS_BY_SOURCE.mock;

  const effectiveYRange = zoomRange.y ?? liveYRange;
  const voltsPerDiv = nearestOption(VOLTS_PER_DIV_OPTIONS, (effectiveYRange[1] - effectiveYRange[0]) / DIVS_Y);
  const frozen = zoomRange.x !== null;

  // The Hantek 1008C has a fixed ~4000-sample capture budget shared
  // evenly across active channels, independent of the timebase -- see
  // docs/hantek1008c.md. More active channels means fewer samples/div
  // regardless of Time/div, which is what actually limits how well a
  // fast signal resolves, not the timebase setting itself. This is
  // specifically a Hantek hardware limit -- the Teensy DAQ streams
  // continuously with no such fixed onboard budget, so the warning only
  // applies when Hantek is the active source.
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
          <label>
            Source {sourceBusy && "…"}
            <select
              value={scopeSource}
              disabled={sourceBusy}
              onChange={(e) => void applySource(e.target.value)}
            >
              {availableSources.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_SOURCE_LABELS[s] ?? s}
                </option>
              ))}
            </select>
          </label>
          <button onClick={resumeLive} disabled={!frozen}>
            {frozen ? "Resume live" : "Live"}
          </button>
          {!frozen && (
            <button onClick={() => freezeViewport()} title="Hold the trace to place cursors">
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
              value={timePerDivSec}
              disabled={timebaseBusy}
              onChange={(e) => void applyTimePerDiv(Number(e.target.value))}
            >
              {timePerDivOptions.map((v) => (
                <option key={v} value={v}>
                  {formatTimePerDiv(v)}
                </option>
              ))}
            </select>
          </label>
          <label>
            History
            <select
              value={historySeconds}
              onChange={(e) => {
                const next = Number(e.target.value);
                setHistorySeconds(next);
                trimBuffers(next);
                dirtyRef.current = true;
              }}
            >
              {HISTORY_SECONDS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}s
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

        {scopeSource === "hantek" && (
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
        )}

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
                  {rangeOptions.map((r) => (
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
