// Test harness: Settings > Plugins with a stub client. ?theme=dark ; window.__calls records client calls; window.__failNext makes updatePlugin reject.
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { Toaster } from "@/components/ui/sonner";
import { RuntimeContext } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginsProvider } from "@/plugins/host";
import SettingsDialog from "@/components/settings/settings-dialog";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const w = window as unknown as { __calls: Array<{ name: string; args: unknown }>; __failNext: boolean };
w.__calls = []; w.__failNext = false;
const base = { enabled: true, userEnabled: true, status: "enabled", scope: "user", source: "installed", contributes: { views: [], rightSidebarTabs: [], taskSources: [], routes: false, webhooks: [], mcpServers: [], skills: [] }, settings: [], secrets: [], ui: null };
let plugins: any[] = [
  { ...base, id: "helpdesk", name: "Helpdesk", version: "1.0.0", description: "Tickets inbox and replies.", icon: "message", scope: "install" },
  { ...base, id: "movidesk", name: "Movidesk", version: "2.1.0", description: "Tickets as tasks.", source: "builtin" },
  { ...base, id: "gitrepo", name: "Repo plugin", version: "0.3.0", description: "Installed from a GitHub repository." },
  { ...base, id: "current", name: "Up to date", version: "1.0.0", description: "Nothing newer." },
];
let updates: any[] = [
  { id: "helpdesk", name: "Helpdesk", installedVersion: "1.0.0", availableVersion: "1.1.0", repo: null },
  { id: "gitrepo", name: "Repo plugin", installedVersion: "0.3.0", availableVersion: "0.4.0", repo: "acme/repo-plugin" },
];
const client = {
  myRole: async () => "admin",
  listPlugins: async () => plugins,
  pluginUpdates: async () => updates,
  getPluginSecretMigrations: async () => [],
  getPluginSettings: async () => ({}),
  inspectPluginRepo: async (url: string) => { w.__calls.push({ name: "inspect", args: url }); return { id: "gitrepo", name: "Repo plugin", version: "0.4.0", sha256: "abc123" }; },
  updatePlugin: async (id: string, sha256?: string) => {
    w.__calls.push({ name: "update", args: { id, sha256 } });
    await new Promise((r) => setTimeout(r, 600));
    if (w.__failNext) { w.__failNext = false; throw new Error("The new version failed to start"); }
    const u = updates.find((x) => x.id === id)!;
    plugins = plugins.map((p) => (p.id === id ? { ...p, version: u.availableVersion } : p));
    updates = updates.filter((x) => x.id !== id);
    return plugins.find((p) => p.id === id);
  },
  uninstallPlugin: async (id: string, confirm: string) => {
    w.__calls.push({ name: "uninstall", args: { id, confirm } });
    if (confirm !== id) throw new Error("Type the plugin id to confirm.");
    plugins = plugins.filter((p) => p.id !== id);
    updates = updates.filter((x) => x.id !== id);
  },
  purgePluginData: async (id: string, confirm: string) => { w.__calls.push({ name: "purge", args: { id, confirm } }); },
};

function App() {
  const [section] = useState("plugins");
  const value = { client, user: { id: "u1", role: "admin" }, sessions: [], settingsOpen: true, setSettingsOpen: () => {}, settingsSection: section, openSettings: () => {}, navigate: () => {} };
  return (
    <RuntimeContext.Provider value={value as never}>
      <TooltipProvider><PluginsProvider loaders={{}}><SettingsDialog /></PluginsProvider><Toaster /></TooltipProvider>
    </RuntimeContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
