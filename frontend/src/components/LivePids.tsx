import type { PidReading } from "../types";

export function LivePids({ pids }: { pids: Record<string, PidReading> }) {
  const entries = Object.values(pids).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="pid-grid">
      {entries.length === 0 && <p>Waiting for data…</p>}
      {entries.map((p) => (
        <div key={p.pid} className="pid-tile">
          <div className="pid-name">{p.name}</div>
          <div className="pid-value">{p.value}</div>
          <div className="pid-unit">{p.unit}</div>
        </div>
      ))}
    </div>
  );
}
