// Test harness: Settings > Browser "Route browser traffic through this computer" with a mocked Tauri bridge.
// Query: tauri=0 (web build, default 1), mode=server|desktop|desktop-fallback (runtime setting), fail=1 (saving the mode fails).
// window.__calls = Tauri invokes, window.__modes = modes saved. Status/recent come from window.__status (set by the test).
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { BrowserEgressSettings } from "@/components/settings/browser-egress-settings";
import { SettingsGroup } from "@/components/settings/ui";
import type { BrowserEgressMode } from "@/lib/runtime/browser-types";

const q = new URLSearchParams(location.search);
const w = window as unknown as Record<string, any>;
w.__calls = []; w.__modes = [];
w.__status = {
  running: true, state: "up", error: null, streams: 2, bytesPerMin: 1_500_000, rttMs: 42, usedToday: 3 * 1024 * 1024, dailyCap: 10 * 1024 ** 3, machine: "Work-Laptop",
  recent: [
    { host: "example.com", port: 443, bytes: 20480, start: 1_700_000_000_000, end: 1_700_000_001_000, result: "ok" },
    { host: "localhost", port: 3000, bytes: 0, start: 1_700_000_002_000, end: 1_700_000_002_000, result: "denied" },
  ],
};
if (q.get("tauri") !== "0") {
  w.isTauri = true;
  w.__TAURI_INTERNALS__ = {
    transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (s: string) => s,
    async invoke(cmd: string, args: unknown) {
      w.__calls.push({ cmd, args });
      if (cmd === "egress_status") return w.__status;
    },
  };
}

function App() {
  const [mode, setMode] = React.useState<BrowserEgressMode>((q.get("mode") as BrowserEgressMode) ?? "server");
  return (
    <div style={{ maxWidth: 720, margin: "20px auto" }}>
      <SettingsGroup title="Browser">
        <BrowserEgressSettings mode={mode} onMode={async (next) => {
          if (q.get("fail")) throw new Error("server said no");
          w.__modes.push(next); setMode(next);
        }} />
      </SettingsGroup>
      <span data-testid="mode">{mode}</span>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
