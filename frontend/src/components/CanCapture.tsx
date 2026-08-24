import type { CanFrame } from "../types";

function hex(n: number, width: number): string {
  return n.toString(16).toUpperCase().padStart(width, "0");
}

export function CanCapture({ frames }: { frames: CanFrame[] }) {
  const recent = frames.slice(-200).reverse();
  return (
    <div className="can-capture">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>ID</th>
            <th>DLC</th>
            <th>Data</th>
          </tr>
        </thead>
        <tbody>
          {recent.map((f, i) => (
            <tr key={`${f.ts}-${i}`}>
              <td>{f.ts.toFixed(3)}</td>
              <td>{hex(f.can_id, 3)}</td>
              <td>{f.dlc}</td>
              <td>{f.data.map((b) => hex(b, 2)).join(" ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
