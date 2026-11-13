// Test harness: Ctrl+K palette + SettingsDialog sharing real open/section state. ?admin=1 makes the user an admin.
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { RuntimeContext } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import SettingsDialog from "@/components/settings/settings-dialog";
import CommandPalette from "@/components/sidebar/command-palette";
import { Kbd } from "@/components/ui/kbd";

const q = new URLSearchParams(location.search);
const settings = { claudeAutoApprove: true, codexAutoApprove: true, gitName: null, gitEmail: null, github: null, agentBrowser: true, agentBrowserEgress: "server" };
const client = {
  settings: async () => settings,
  updateSettings: async () => settings,
  myRole: async () => (q.get("admin") ? "admin" : "member"),
  providersStatus: async () => ({ claude: { connected: true, plan: "max" }, codex: { connected: true } }),
  claudeAccounts: async () => [],
  browserStatus: async () => ({ state: "running", agents: 1, tabs: 2, profile: "~/.floq/browser/profile" }),
  browserData: async () => ({ domains: [], bookmarks: 0 }),
  fallbackAction: async () => ({ applied: true }),
};

function App() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("account");
  const value = {
    client, sessions: [], projects: [], searchOpen, setSearchOpen, settingsOpen, setSettingsOpen, settingsSection,
    openSettings: (s?: string) => { if (s) setSettingsSection(s); setSettingsOpen(true); },
    navigate: () => {}, openCanvas: () => {}, openSession: () => {}, setNewAgentOpen: () => {},
  };
  return (
    <RuntimeContext.Provider value={value as never}>
      <TooltipProvider>
        <div className="floq-surface sidebar-search m-6 w-64"><button type="button" data-testid="search-trigger" className="flex h-9 w-full items-center gap-2 px-3" onClick={() => setSearchOpen(true)}><span>Search</span><Kbd className="ml-auto">Ctrl K</Kbd></button></div>
        <CommandPalette /><SettingsDialog />
      </TooltipProvider>
    </RuntimeContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
