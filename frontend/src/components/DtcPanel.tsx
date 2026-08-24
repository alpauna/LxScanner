import { clearDtc } from "../api";
import type { DtcEvent } from "../types";

export function DtcPanel({ dtcs }: { dtcs: DtcEvent[] }) {
  const latest = dtcs[dtcs.length - 1];
  const codes = latest?.codes ?? [];
  return (
    <div className="dtc-panel">
      <button onClick={() => void clearDtc()}>Clear DTCs</button>
      <ul>
        {codes.length === 0 && <li>No stored codes</li>}
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </div>
  );
}
