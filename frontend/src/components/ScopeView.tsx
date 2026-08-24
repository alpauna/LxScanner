import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useSocket } from "../ws";
import type { ScopeBatch } from "../types";

const CHANNEL_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#42d4f4",
  "#f032e6",
  "#9a9a00",
];
const WINDOW_SAMPLES = 4000;

export function ScopeView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const buffersRef = useRef<number[][]>(
    Array.from({ length: 8 }, () => [] as number[]),
  );
  const xBufferRef = useRef<number[]>([]);
  const dirtyRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const opts: uPlot.Options = {
      width: el.clientWidth || 800,
      height: 420,
      scales: { x: { time: false } },
      series: [
        { label: "t" },
        ...CHANNEL_COLORS.map((color, i) => ({
          label: `ch${i}`,
          stroke: color,
          width: 1,
        })),
      ],
    };
    const initialData = Array.from({ length: 9 }, () => []) as unknown as uPlot.AlignedData;
    const plot = new uPlot(opts, initialData, el);
    plotRef.current = plot;
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, []);

  useSocket<ScopeBatch>("/ws/stream/scope", (batch) => {
    const xs = xBufferRef.current;
    const buffers = buffersRef.current;
    const nSamples = Object.values(batch.channels)[0]?.length ?? 0;
    for (let i = 0; i < nSamples; i++) {
      xs.push(batch.t0 + i * batch.dt);
    }
    for (let ch = 0; ch < 8; ch++) {
      const samples = batch.channels[String(ch)];
      const target = buffers[ch];
      if (samples) {
        for (const s of samples) target.push(s);
      } else {
        for (let i = 0; i < nSamples; i++) target.push(NaN);
      }
    }
    const overflow = xs.length - WINDOW_SAMPLES;
    if (overflow > 0) {
      xs.splice(0, overflow);
      for (const b of buffers) b.splice(0, overflow);
    }
    dirtyRef.current = true;
  });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (dirtyRef.current && plotRef.current) {
        plotRef.current.setData(
          [xBufferRef.current, ...buffersRef.current] as unknown as uPlot.AlignedData,
        );
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <div ref={containerRef} className="scope-view" />;
}
