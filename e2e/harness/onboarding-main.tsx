// Test harness: AutoApproveNotice + SettingsDialog with real open/section state. Acknowledged flag persists in
// localStorage ("ack") so reloads behave like the server-side per-user flag. ?dark=1 forces dark.
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { RuntimeContext } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import SettingsDialog from "@/components/settings/settings-dialog";
import { AutoApproveNotice } from "@/components/onboarding/auto-approve-notice";

const q = new URLSearchParams(location.search);
if (q.get("dark")) document.documentElement.classList.add("dark");
const settings: Record<string, unknown> = { claudeAutoApprove: true, codexAutoApprove: true, gitName: null, gitEmail: null, github: null, agentBrowser: true, agentBrowserEgress: "server" };
const client = {
  settings: async () => ({ ...settings, autoApproveAcknowledged: localStorage.getItem("ack") === "1" }),
  updateSettings: async (patch: Record<string, unknown>) => { if (patch.autoApproveAcknowledged) localStorage.setItem("ack", "1"); return settings; },
  myRole: async () => "member",
  providersStatus: async () => ({ claude: { connected: true, plan: "max" }, codex: { connected: true } }),
  claudeAccounts: async () => [],
  browserStatus: async () => ({ state: "running", agents: 1, tabs: 2, profile: "~/.floq/browser/profile" }),
  browserData: async () => ({ domains: [], bookmarks: 0 }),
  fallbackAction: async () => ({ applied: true }),
};

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("account");
  const value = {
    client, user: { id: "u1" }, sessions: [], projects: [], settingsOpen, setSettingsOpen, settingsSection,
    openSettings: (s?: string) => { if (s) setSettingsSection(s); setSettingsOpen(true); },
  };
  return (
    <RuntimeContext.Provider value={value as never}>
      <TooltipProvider><AutoApproveNotice /><SettingsDialog /></TooltipProvider>
    </RuntimeContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
