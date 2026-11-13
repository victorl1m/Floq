// Test harness: full SettingsDialog with a stub client. ?section=browser|accounts|agents
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { Toaster } from "@/components/ui/sonner";
import { RuntimeContext } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import SettingsDialog from "@/components/settings/settings-dialog";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const w = window as unknown as { __calls: Array<{ name: string; args: unknown }> };
w.__calls = [];
let settings: Record<string, unknown> = { claudeAutoApprove: true, codexAutoApprove: true, gitName: null, gitEmail: null, github: null, agentBrowser: true, agentBrowserEgress: "server" };
const client = {
  settings: async () => settings,
  updateSettings: async (u: object) => { w.__calls.push({ name: "updateSettings", args: u }); settings = { ...settings, ...u }; return settings; },
  myRole: async () => "member",
  providersStatus: async () => ({ claude: { connected: true, plan: "max" }, codex: { connected: true } }),
  claudeAccounts: async () => [{ slot: "primary", label: "Primary", plan: "max", active: true, status: "connected" }],
  browserStatus: async () => ({ state: "running", agents: 1, tabs: 2, profile: "~/.floq/browser/profile" }),
  browserData: async () => ({ domains: [], bookmarks: 0 }),
  fallbackAction: async () => ({ applied: true }),
};

function App() {
  const [section, setSection] = useState(q.get("section") ?? "account");
  return (
    <RuntimeContext.Provider value={{ client, sessions: [], settingsOpen: true, setSettingsOpen: () => {}, settingsSection: section, openSettings: (s?: string) => s && setSection(s) } as never}>
      <TooltipProvider><SettingsDialog /><Toaster /></TooltipProvider>
    </RuntimeContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
