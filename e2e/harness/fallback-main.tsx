// Test harness: usage-limit fallback settings group + card badge with a stub client. ?theme=dark, ?kind=model|paused
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { Toaster } from "@/components/ui/sonner";
import { RuntimeContext } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageFallbackGroup } from "@/components/settings/usage-fallback-group";
import { FallbackBadge } from "@/components/canvas/fallback-badge";
import { FallbackPolicyMenu } from "@/components/canvas/fallback-policy-menu";
import { ClaudeAccountsGroup } from "@/components/settings/claude-accounts-group";
import type { SettingsPatch, UserSettings } from "@/lib/runtime/types";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const w = window as unknown as { __calls: Array<{ name: string; args: unknown }> };
w.__calls = [];
let accounts = [
  { slot: "primary", label: "Primary", plan: "max", active: true, status: "connected" },
  { slot: "acct_b0b0b0b0", label: "Work", plan: "pro", active: false, status: "connected" },
];
const client = {
  claudeAccounts: async () => (q.get("single") ? accounts.slice(0, 1) : accounts),
  providersStatus: async () => ({ claude: { connected: true }, codex: { connected: q.get("codex") !== "off" } }),
  activateClaudeAccount: async (slot: string) => { w.__calls.push({ name: "activate", args: [slot] }); accounts = accounts.map((a) => ({ ...a, active: a.slot === slot })); return accounts; },
  reorderClaudeAccounts: async (slots: string[]) => { w.__calls.push({ name: "reorder", args: slots }); accounts = slots.map((slot, i) => ({ ...accounts.find((a) => a.slot === slot)!, active: i === 0 })); return accounts; },
  removeClaudeAccount: async (slot: string) => { w.__calls.push({ name: "remove", args: [slot] }); accounts = accounts.filter((a) => a.slot !== slot); return accounts; },
  renameClaudeAccount: async (slot: string, label: string) => { w.__calls.push({ name: "rename", args: [slot, label] }); accounts = accounts.map((a) => (a.slot === slot ? { ...a, label } : a)); return accounts; },
  claudeOAuthStart: async () => ({ flowId: "f1", authorizeUrl: "https://example.test/authorize" }),
  fallbackAction: async (...args: unknown[]) => { w.__calls.push({ name: "fallbackAction", args }); return q.get("still") && args[1] === "return" ? { applied: false, reason: "still_limited", resetsAt: "2026-11-16T09:00:00.000Z" } : { applied: true }; } };

function App() {
  const [settings, setSettings] = useState({ claudeAutoApprove: true, codexAutoApprove: true, gitName: null, gitEmail: null, github: null } as UserSettings);
  const patch = async (update: SettingsPatch & Partial<UserSettings>) => { w.__calls.push({ name: "patch", args: update }); setSettings((s) => ({ ...s, ...update } as UserSettings)); };
  const kind = (q.get("kind") === "paused" ? "paused" : q.get("kind") === "account" ? "account" : "model") as "paused" | "account" | "model";
  return (
    <div className="bg-background p-4 text-foreground" style={{ maxWidth: 640 }}>
      <UsageFallbackGroup settings={settings} patch={patch} />
      {q.get("accounts") && <ClaudeAccountsGroup />}
      {q.get("policy") && <div style={{ marginTop: 16 }}><FallbackPolicyMenu sessionId="s1" value={q.get("policy") === "pause" ? "pause" : null} /></div>}
      <div style={{ marginTop: 16 }}><FallbackBadge sessionId="s1" fallback={{ kind, label: kind === "account" ? "Work" : "Sonnet", originLabel: "Opus", resetsAt: "2026-11-16T09:00:00.000Z", keep: false }} /></div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RuntimeContext.Provider value={{ client, sessions: [] } as never}><TooltipProvider><App /><Toaster /></TooltipProvider></RuntimeContext.Provider>,
);
