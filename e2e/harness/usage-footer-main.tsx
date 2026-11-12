// Renders the footer usage meters from fixture payloads (the shape UsageService returns for Max 5x/20x, Pro, errors).
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { UsageMetersView } from "@/components/window/usage-meter";
import type { ProvidersUsage } from "@/lib/runtime/types";

const soon = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const max5x: ProvidersUsage = {
  codex: null,
  claude: {
    connected: true, plan: "Max 5x", fetchedAt: new Date().toISOString(),
    windows: [
      { id: "five_hour", label: "Current session (5h)", usedPercent: 42, resetsAt: soon(95) },
      { id: "seven_day", label: "Weekly", usedPercent: 71.5, resetsAt: soon(3 * 1440 + 200) },
      { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 18, resetsAt: soon(3 * 1440 + 200) },
      { id: "seven_day_sonnet", label: "Weekly · Sonnet", usedPercent: 9, resetsAt: soon(3 * 1440 + 200) },
      { id: "extra_usage", label: "Extra usage", usedPercent: 24.6, resetsAt: null, detail: "$12.30 of $50.00" },
    ],
  },
};
const cases: Record<string, ProvidersUsage> = {
  max5x,
  pro: { codex: null, claude: { connected: true, plan: "Pro", fetchedAt: new Date().toISOString(), windows: [max5x.claude!.windows[0], max5x.claude!.windows[1]] } },
  forbidden: { codex: null, claude: { connected: true, plan: "Max 20x", fetchedAt: new Date().toISOString(), windows: [], error: "Claude token cannot read usage (missing scope), reconnect it in Settings" } },
};
const key = new URLSearchParams(location.search).get("case") ?? "max5x";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ padding: "340px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
    {Object.keys(cases).map((k) => (
      <div key={k} data-testid={k} className="text-[11px] text-muted-foreground"><b>{k}</b><UsageMetersView usage={cases[k]} isRefreshing={false} refresh={async () => {}} /></div>
    ))}
    <span data-testid="selected">{key}</span>
  </div>,
);
