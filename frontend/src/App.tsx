import { useState } from "react";
import { useSocket } from "./ws";
import { setMode, startSession, stopSession } from "./api";
import { LivePids } from "./components/LivePids";
import { DtcPanel } from "./components/DtcPanel";
import { CanCapture } from "./components/CanCapture";
import { ScopeView } from "./components/ScopeView";
import type { LiveEvent, PidReading, CanFrame, DtcEvent, Mode } from "./types";

type Tab = "live" | "dtc" | "capture" | "scope";

const MAX_CAN_FRAMES = 500;

export default function App() {
  const [tab, setTab] = useState<Tab>("live");
  const [mode, setModeState] = useState<Mode>("scanner");
  const [pids, setPids] = useState<Record<string, PidReading>>({});
  const [canFrames, setCanFrames] = useState<CanFrame[]>([]);
  const [dtcs, setDtcs] = useState<DtcEvent[]>([]);

  useSocket<LiveEvent>("/ws/stream/live", (event) => {
    if (event.type === "pid") {
      setPids((prev) => ({ ...prev, [event.pid]: event }));
    } else if (event.type === "can_frame") {
      setCanFrames((prev) => [...prev.slice(-(MAX_CAN_FRAMES - 1)), event]);
    } else if (event.type === "dtc") {
      setDtcs((prev) => [...prev, event]);
    }
  });

  async function handleModeChange(next: Mode) {
    setModeState(next);
    await setMode(next);
  }

  return (
    <div className="app">
      <header>
        <h1>LxScanner</h1>
        <div className="controls">
          <label>
            Mode:
            <select
              value={mode}
              onChange={(e) => void handleModeChange(e.target.value as Mode)}
            >
              <option value="scanner">Scanner</option>
              <option value="capture">Capture</option>
            </select>
          </label>
          <button onClick={() => void startSession()}>Start session</button>
          <button onClick={() => void stopSession()}>Stop session</button>
        </div>
      </header>
      <nav>
        <button onClick={() => setTab("live")} disabled={tab === "live"}>
          Live PIDs
        </button>
        <button onClick={() => setTab("dtc")} disabled={tab === "dtc"}>
          DTCs
        </button>
        <button onClick={() => setTab("capture")} disabled={tab === "capture"}>
          CAN Capture
        </button>
        <button onClick={() => setTab("scope")} disabled={tab === "scope"}>
          Scope
        </button>
        <div id="scope-toolbar-slot" className="scope-toolbar-slot" />
      </nav>
      <main>
        {tab === "live" && <LivePids pids={pids} />}
        {tab === "dtc" && <DtcPanel dtcs={dtcs} />}
        {tab === "capture" && <CanCapture frames={canFrames} />}
        {tab === "scope" && <ScopeView />}
      </main>
    </div>
  );
}
