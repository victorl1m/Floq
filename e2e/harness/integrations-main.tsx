// Test harness: the full SettingsDialog on Integrations (or ?section=plugins) with a stateful stub of the runtime. Not part of the app bundle.
//   ?server=none|builtin|external   which WhatsApp (WAHA) server exists at the start (default none)
//   ?enabled=1                      WhatsApp is already on;  ?role=member  a non-admin user;  ?session=WORKING|SCAN_QR_CODE|MISSING
//   ?health=missing|missing-events|stale   what Floq's own webhook check found (until "Repair webhook" is pressed)
//   ?theme=dark ; ?material=solid|acrylic ; ?native=acrylic (translucent window over a fake desktop backdrop)
// window.__calls records every call; the external test accepts the key "good-key" on https://waha.example.com only.
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
if (q.get("material")) document.documentElement.dataset.material = q.get("material")!;
if (q.get("native")) {
  document.documentElement.dataset.nativeMaterial = q.get("native")!;
  document.documentElement.style.setProperty("background", "radial-gradient(60% 70% at 15% 20%, #6d5efc 0, transparent 70%), radial-gradient(55% 60% at 85% 15%, #19b5a5 0, transparent 70%), radial-gradient(70% 70% at 60% 95%, #e0567a 0, transparent 70%), #2b3350", "important");
}
const w = window as unknown as { __calls: Array<{ name: string; args?: unknown }> };
w.__calls = [];
const rec = (name: string, args?: unknown) => { w.__calls.push({ name, args }); };
const role = q.get("role") === "member" ? "member" : "admin";
const builtin = q.get("server") === "builtin";
const now = new Date().toISOString();

const state = {
  enabled: q.get("enabled") === "1",
  settings: (q.get("server") === "external" ? { baseUrl: "https://waha.example.com", messageMe: true } : {}) as Record<string, string | number | boolean>,
  key: q.get("server") === "external",
  phone: null as string | null,
  repaired: false,
};
const mode = () => (state.settings.baseUrl ? "external" : builtin ? "builtin" : "none");
const whatsapp = () => ({
  id: "waha", name: "WhatsApp", version: "4.0.0", description: "WhatsApp in Floq.", icon: "IconBrandWhatsapp", scope: "install", source: "builtin", ui: null,
  status: state.enabled ? "enabled" : "disabled", enabled: state.enabled, userEnabled: state.enabled && role === "admin",
  integration: { kind: "builtin-whatsapp", active: builtin && !state.settings.baseUrl },
  secrets: [{ name: "WAHA_API_KEY", description: "API key of your WAHA instance", required: false, present: state.key || builtin }, { name: "WAHA_WEBHOOK_HMAC", description: "HMAC key configured in WAHA for webhooks.", required: false, present: false }],
  settings: [
    { key: "baseUrl", type: "url", label: "WAHA address", required: false },
    { key: "historyPerChat", type: "number", label: "History: messages per chat", description: "Default 1000." },
    { key: "messageMe", type: "boolean", label: "Let the AI message me freely", description: "On by default once your number is saved." },
    { key: "alwaysAllowSend", type: "boolean", label: "Always allow AI to send messages", description: "WARNING: agents then send to any chat without asking." },
  ],
  contributes: { views: [{ id: "inbox", label: "WhatsApp", icon: "IconBrandWhatsapp" }], taskSources: [], rightSidebarTabs: [], settingsPanel: true },
});
const other = (id: string, name: string) => ({
  id, name, version: "1.0.0", description: name + " tickets as a read-only source in Tasks.", icon: "IconHeadset", scope: "user", source: "installed", ui: null, status: "enabled", enabled: true, userEnabled: true,
  secrets: [], settings: [], contributes: { views: [], taskSources: [], rightSidebarTabs: [], settingsPanel: false },
});
const catalogEntry = (id: string, name: string, extra: object = {}) => ({ id, name, version: "1.0.0", apiVersion: 1, description: name + ".", scope: "user", secrets: [], network: [], contributes: ["taskSources"], builtin: false, installedVersion: null, updateAvailable: false, ...extra });
const session = q.get("session") ?? "WORKING";

const client = {
  myRole: async () => role,
  settings: async () => ({}),
  listPlugins: async () => [whatsapp(), other("movidesk", "Movidesk"), other("oldie", "Old Tracker")],
  pluginUpdates: async () => [],
  pluginDeprecations: async () => [{ id: "oldie", message: "Old Tracker is now part of Floq: Tasks > Sources." }],
  pluginSources: async () => ({}),
  pluginCatalog: async () => [
    catalogEntry("movidesk", "Movidesk", { installedVersion: "1.0.0" }),
    catalogEntry("azure-devops", "Azure DevOps"),
    catalogEntry("oldie", "Old Tracker", { installedVersion: "1.0.0", deprecated: "Old Tracker is now part of Floq: Tasks > Sources." }),
    catalogEntry("gone", "Gone Plugin", { deprecated: "Gone Plugin is no longer developed." }),
    catalogEntry("waha", "WhatsApp (WAHA)", { builtin: true, scope: "install" }),
  ],
  getPluginSecretMigrations: async () => [],
  getPluginSettings: async (id: string) => (id === "waha" ? { ...state.settings } : {}),
  savePluginSettings: async (id: string, next: Record<string, string | number | boolean>) => { rec("savePluginSettings", { id, settings: next }); state.settings = { ...next }; return { ...state.settings }; },
  getPluginSecrets: async () => whatsapp().secrets.map((s) => ({ ...s, description: s.description, updatedAt: null, scope: "install", editable: true })),
  setPluginSecret: async (id: string, name: string, value: string) => { rec("setPluginSecret", { id, name, length: value.length }); if (name === "WAHA_API_KEY") state.key = true; },
  deletePluginSecret: async (id: string, name: string) => { rec("deletePluginSecret", { id, name }); if (name === "WAHA_API_KEY") state.key = false; },
  setPluginEnabled: async (id: string, on: boolean, level: string) => { rec("setPluginEnabled", { id, on, level }); await new Promise((r) => setTimeout(r, 120)); state.enabled = on; return { plugin: whatsapp(), mcpProblems: [] }; },
  whatsappServer: async () => ({
    builtin: { enabled: builtin, state: builtin ? "running" : "off", version: builtin ? "2026.10.1" : null, engine: builtin ? "NOWEB" : null, tier: builtin ? "CORE" : null, image: builtin ? "devlikeapro/waha:noweb-2026.10.1" : null, managed: builtin },
    plugin: { installed: true, enabled: state.enabled, mode: mode() },
    autoUpdate: { enabled: true, quietMinutes: 30, lastCheckAt: now, last: null }, checkedAt: now,
  }),
  whatsappServerHealth: async () => ({ ok: true, state: "running", latencyMs: 42, version: "2026.10.1", checkedAt: now }),
  testWhatsappServer: async (baseUrl: string, apiKey: string) => {
    rec("testWhatsappServer", { baseUrl, keyLength: apiKey.length });
    await new Promise((r) => setTimeout(r, 150));
    if (baseUrl !== "https://waha.example.com") return { ok: false, state: "unreachable", version: null, engine: null, error: "connection refused" };
    if (apiKey !== "good-key") return { ok: false, state: "unauthorized", version: null, engine: null };
    return { ok: true, state: "running", version: "2026.10.1", engine: "NOWEB" };
  },
  pluginFetch: async (id: string, path: string, init?: { method?: string; body?: any }) => {
    rec("pluginFetch", { id, path, method: init?.method ?? "GET" });
    if (!state.enabled) throw new Error("Plugin is disabled");
    if (path === "/session/webhook-repair") { state.repaired = true; return { state: "ok", repaired: true }; }
    if (path === "/session" && q.get("health") && !state.repaired) return { status: session, engine: "NOWEB", me: { name: "Ana Souza", phone: "5511988887777" }, webhook: null, webhookHealth: { state: q.get("health"), missingEvents: q.get("health") === "missing-events" ? ["message.ack"] : [], lastEnsuredAt: null } };
    if (path === "/session" && q.get("health")) return { status: session, engine: "NOWEB", me: { name: "Ana Souza", phone: "5511988887777" }, webhook: null, webhookHealth: { state: "ok", missingEvents: [], lastEnsuredAt: now } };
    if (path === "/session") return { status: session, engine: "NOWEB", me: session === "WORKING" ? { name: "Ana Souza", phone: "5511988887777" } : null, webhook: session === "MISSING" ? null : { configured: true, events: ["message.any"], missingEvents: q.get("webhook") === "partial" ? ["message.ack", "presence.update"] : [] } };
    if (path === "/accounts") return { primary: "default", accounts: session === "MISSING" ? [] : [{ session: "default", label: "", name: "Ana Souza", phone: "5511988887777", primary: true, status: session, unread: 3 }, ...(q.get("accounts") === "2" ? [{ session: "work", label: "Work", name: "Loja", phone: "5511977776666", primary: false, status: "SCAN_QR_CODE", unread: 0 }] : [])] };
    if (path === "/phone" && init?.method === "POST") { state.phone = init.body.phone || null; return { phone: state.phone, formatted: state.phone ? "+55 (11) 98888-7777" : null }; }
    if (path === "/phone") return { phone: state.phone, formatted: state.phone ? "+55 (11) 98888-7777" : null };
    if (path === "/test-message") return { ok: true };
    return {};
  },
};

function App() {
  const [section, setSection] = useState(q.get("section") ?? "integrations");
  const [open, setOpen] = useState(true);
  const value = {
    client, user: { id: "u1", role }, sessions: [], settingsOpen: open, setSettingsOpen: (v: boolean) => { rec("setSettingsOpen", v); setOpen(v); }, settingsSection: section,
    openSettings: (s?: string) => { if (s) setSection(s); setOpen(true); }, navigate: (view: string, arg?: string) => rec("navigate", { view, arg }),
  };
  return (
    <RuntimeContext.Provider value={value as never}>
      <TooltipProvider><PluginsProvider><SettingsDialog /></PluginsProvider><Toaster /></TooltipProvider>
      {!open && <p data-slot="settings-closed">Settings closed</p>}
    </RuntimeContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
