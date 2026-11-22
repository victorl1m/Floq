// Test harness: Settings > Plugins (?section=plugins) or Runtime (?section=runtime) with a stub client for the built-in WhatsApp server.
// ?theme=dark ; ?mode=builtin|external ; ?scenario=available|external|busy|login ; window.__calls records calls.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { Toaster } from "@/components/ui/sonner";
import { RuntimeContext } from "@/lib/runtime/store";
import { RuntimeError } from "@/lib/runtime/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginsProvider } from "@/plugins/host";
import SettingsDialog from "@/components/settings/settings-dialog";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const w = window as unknown as { __calls: Array<{ name: string; args: unknown }> };
w.__calls = [];
const mode = q.get("mode") ?? "builtin";
const scenario = q.get("scenario") ?? "available";
const base = { enabled: true, userEnabled: true, status: "enabled", scope: "install", source: "builtin", contributes: { views: [], rightSidebarTabs: [], taskSources: [], routes: false, webhooks: [], mcpServers: [], skills: [] }, ui: null };
const plugins: any[] = [{
  ...base, id: "waha", name: "WhatsApp (WAHA)", version: "1.0.0", description: "WhatsApp inbox and replies.", icon: "message",
  integration: { kind: "builtin-whatsapp", active: mode === "builtin" },
  settings: [{ key: "baseUrl", label: "WAHA address", type: "string", required: false }],
  secrets: [{ name: "WAHA_API_KEY", description: "Key of the WAHA server.", required: false, present: true }],
}];
const now = new Date().toISOString();
const wa: any = {
  builtin: { enabled: true, state: "running", version: "2026.10.1", engine: "NOWEB", tier: "CORE", image: "devlikeapro/waha:noweb-2026.10.1", managed: true },
  plugin: { installed: true, enabled: true, mode },
  autoUpdate: { enabled: false, quietMinutes: 30, lastCheckAt: now, last: { at: now, ok: true, from: "2026.9.2", to: "2026.10.1", rolledBack: false, message: "Updated and healthy." } },
  checkedAt: now,
};
const external = scenario === "external";
const updates: any = {
  items: [
    { target: "runtime", current: "1.0.46", latest: "1.0.46", updateAvailable: false, source: "npm" },
    { target: "claude", current: "2.1.0", latest: "2.1.0", updateAvailable: false, source: "npm" },
    { target: "whatsapp", current: "2026.10.1", latest: "2026.11.2", updateAvailable: true, source: "docker hub", managed: !external },
  ],
  checkedAt: now, activeSessions: 0, applying: null,
};
const rec = (name: string, args?: unknown) => w.__calls.push({ name, args });
const client = {
  myRole: async () => "admin",
  settings: async () => ({}),
  getSettings: async () => ({}),
  listPlugins: async () => plugins,
  pluginUpdates: async () => [],
  getPluginSecretMigrations: async () => [],
  getPluginSettings: async () => ({ baseUrl: "" }),
  getPluginSecrets: async () => [{ name: "WAHA_API_KEY", description: "Key of the WAHA server.", required: false, present: true, updatedAt: null, scope: "install", editable: true }],
  whatsappServer: async () => wa,
  whatsappServerHealth: async () => {
    rec("health");
    await new Promise((r) => setTimeout(r, 250));
    if (q.get("health") === "fail") throw new Error("Connection refused");
    return { ok: true, state: "running", latencyMs: 42, version: "2026.10.1", checkedAt: now };
  },
  setWhatsappAutoUpdate: async (body: any) => {
    rec("auto", body);
    wa.autoUpdate = { ...wa.autoUpdate, ...body };
    return wa;
  },
  checkUpdates: async () => updates,
  applyUpdate: async (target: string, force: boolean) => {
    rec("apply", { target, force });
    await new Promise((r) => setTimeout(r, 200));
    if (scenario === "busy" && !force) throw new RuntimeError(409, "whatsapp_busy", "Messages were sent or received in the last 30 minutes.");
    if (scenario === "login") throw new RuntimeError(409, "whatsapp_login_active", "A QR login is in progress. Try again after it finishes.");
    updates.items = updates.items.map((i: any) => (i.target === target ? { ...i, current: i.latest, updateAvailable: false } : i));
    return { target, ok: true, restarting: false, log: "", activeSessions: 0 };
  },
};

function App() {
  const value = { client, user: { id: "u1", role: "admin" }, sessions: [], settingsOpen: true, setSettingsOpen: () => {}, settingsSection: q.get("section") ?? "plugins", openSettings: () => {}, navigate: () => {} };
  return (
    <RuntimeContext.Provider value={value as never}>
      <TooltipProvider><PluginsProvider loaders={{}}><SettingsDialog /></PluginsProvider><Toaster /></TooltipProvider>
    </RuntimeContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
