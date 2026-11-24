// Test harness: the footer "Network" item (forwarded ports + agent browser egress) and the relay's brief notice, Tauri mocked.
// Query: tauri=0 (web build), egress=up|off|paused (initial relay status), here=1 (this computer chose to egress; default 1 when egress=up|paused).
// window.__calls = Tauri invokes, window.__patches = settings saved, window.__setStatus(s) pushes an egress status.
import "./network-tauri";
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RuntimeContext } from "@/lib/runtime/store";
import { NetworkStatus } from "@/components/window/forwarded-ports";
import { BrowserEgressRelay } from "@/components/canvas/browser-egress-relay";
import { setEgressHere, setEgressStatus, type EgressStatus } from "@/lib/browser-egress";
import { startForward } from "@/lib/port-forwarding";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const w = window as unknown as Record<string, any>;
w.__patches = [];
let mode = q.get("mode") ?? (q.get("egress") === "up" || q.get("egress") === "paused" ? "desktop" : "server");
const client = {
  token: "t", baseUrl: "https://floq.test",
  settings: async () => ({ agentBrowserEgress: mode }),
  updateSettings: async (patch: { agentBrowserEgress?: string }) => { w.__patches.push(patch); if (patch.agentBrowserEgress) mode = patch.agentBrowserEgress; return {}; },
  browserEgressUrl: () => "wss://floq.test/v1/browser/egress",
  portTunnelUrl: (s: string, p: number) => `wss://floq.test/tunnel/${s}/${p}`,
};
const now = Date.now();
const up: EgressStatus = {
  running: true, state: "up", error: null, streams: 15, bytesPerMin: 2_400_000, rttMs: 38, usedToday: 412 * 1024 * 1024, dailyCap: 10 * 1024 ** 3, machine: "Work-Laptop",
  recent: [
    { host: "www.google.com", port: 443, bytes: 512_000, start: now - 9000, end: now - 8000, result: "ok" },
    { host: "www.google.com", port: 443, bytes: 120_000, start: now - 7000, end: now - 6000, result: "ok" },
    { host: "fonts.gstatic.com", port: 443, bytes: 80_000, start: now - 5000, end: now - 4000, result: "ok" },
    { host: "192.168.1.10", port: 80, bytes: 0, start: now - 3000, end: now - 3000, result: "denied: private" },
  ],
};
const egress = q.get("egress") ?? "off";
const initial: EgressStatus | null = egress === "up" ? up : egress === "paused" ? { ...up, state: "paused", streams: 0, error: "Paused: daily limit reached", recent: [] } : null;
w.__status = initial;
w.__up = up;
w.__onStart = () => { if (egress === "up" || q.get("startsUp") === "1") w.__setStatus(up); };
w.__setStatus = (s: EgressStatus | null) => { w.__status = s; setEgressStatus(s); };
if (q.get("here") === "1" || (q.get("here") !== "0" && initial)) setEgressHere(true); else setEgressHere(false);
setEgressStatus(initial);
if (q.get("ports") !== "0") void startForward(client as never, "s1", 5173).catch(() => undefined);

function App() {
  const value = { client, user: { id: "u1", role: "admin" }, sessions: [], view: "session", selectedId: "s1", selectedTerminalId: null, userPreferences: { recentForwardPorts: {} }, updateUserPreferences: () => {}, upsertSession: () => {} };
  return (
    <RuntimeContext.Provider value={value as never}>
      <TooltipProvider>
        <div style={{ height: "100vh" }} />
        <footer data-slot="app-footer" className="floq-footer glass-surface fixed inset-x-0 bottom-0 z-30 flex h-8 items-center justify-end border-t border-border px-4 text-[11px] text-muted-foreground select-none">
          <NetworkStatus />
        </footer>
        {q.get("relay") === "1" && <BrowserEgressRelay />}
        <Toaster />
      </TooltipProvider>
    </RuntimeContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
