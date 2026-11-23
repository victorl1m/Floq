// Test harness: mounts the built-in WhatsApp UI (src/plugins/whatsapp) the way the app mounts it,
// against a fake of the plugin's routes (see ./waha-fake.ts). Not part of the app bundle.
//   ?theme=dark            dark theme
//   ?state=empty|loading|error|unconfigured|qr|stopped|failed
//   ?engine=WEBJS|NOWEB|GOWS
//   ?frame=1               mount inside the app's .workspace-frame (the host styles every input and textarea in there)
//   ?material=solid|acrylic|mica|vibrancy   data-material on <html>;  ?native=acrylic|mica|vibrancy   data-native-material (translucent window) over a fake desktop backdrop
//   ?accounts=2|3          several WhatsApp accounts attached (default: one); two more WAHA sessions can always be attached
//   ?import=running|done|failed   history import state at the start (running waits at 34 of 120 chats until __fake.of(session).importTick(n));  ?willImport=0;  ?historyError=text
//   ?shell=1               the real host shell: the app's sidebar (ui/sidebar) beside the .workspace-frame, as App.tsx lays them out (implies frame=1)
//   ?bare=1                do not load the app stylesheet at all: proves the plugin's own stylesheet carries its layout
import React from "react";
import ReactDOM from "react-dom/client";
import "./font-shim";
import { RuntimeContext } from "@/lib/runtime/store";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar, SidebarContent, SidebarProvider } from "@/components/ui/sidebar";
import { PluginBoundary } from "@/plugins/host";
import { dispatchPluginFrame } from "@/plugins/events";
import type { PluginInfo } from "@/lib/runtime/types";
import type { UiPluginDefinition } from "@/plugins/sdk";
import "@/plugins/shared-runtime";
import { createFake } from "./waha-fake";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
if (params.get("material")) document.documentElement.dataset.material = params.get("material")!;
if (params.get("native")) {
  document.documentElement.dataset.nativeMaterial = params.get("native")!;
  // Stands in for what the OS draws behind a translucent window.
  document.documentElement.style.setProperty("background", "radial-gradient(60% 70% at 15% 20%, #6d5efc 0, transparent 70%), radial-gradient(55% 60% at 85% 15%, #19b5a5 0, transparent 70%), radial-gradient(70% 70% at 60% 95%, #e0567a 0, transparent 70%), #2b3350", "important");
}
const shell = params.get("shell") === "1";
const framed = shell || params.get("frame") === "1";
if (params.get("bare") !== "1") await import("@/index.css");
else document.body.style.margin = "0";

const fake = createFake({ state: params.get("state") ?? "ok", engine: params.get("engine") ?? "WEBJS", accounts: Number(params.get("accounts") ?? 1), import: params.get("import") ?? undefined, willImport: params.get("willImport") !== "0", historyError: params.get("historyError") ?? undefined, emit: (name, data) => dispatchPluginFrame({ type: "plugin", pluginId: "waha", name, data }) });
const client = { pluginFetch: (_id: string, path: string, init?: { method?: string; body?: unknown }) => fake.fetch(path, init) };
Object.assign(window, { __calls: fake.calls, __incoming: fake.incoming, __fake: fake });

// The integration's UI is part of the app now (src/plugins/whatsapp): imported like the app imports it, no package, no Blob.
const pkg = { manifest: { id: "waha", name: "WhatsApp", version: "builtin" } };
const def = (await import("@/plugins/whatsapp")).default as UiPluginDefinition;
const Inbox = def.views!.inbox;
const plugin = { id: pkg.manifest.id, name: pkg.manifest.name, version: pkg.manifest.version } as unknown as PluginInfo;
const runtime = { client, user: { id: "u1" }, navigate: () => undefined, openSettings: () => undefined } as unknown as React.ContextType<typeof RuntimeContext>;

const main = (
  <main className={framed ? "workspace-frame workspace-surface workspace-view relative min-w-0 overflow-hidden" + (shell ? " flex-1" : "") : "bg-background"} style={framed ? { minHeight: 0 } : { position: "relative", height: "100vh", minHeight: 0 }} data-version={pkg.manifest.version} data-workspace-view="plugin">
    <div style={{ position: "absolute", inset: 0 }} data-plugin-view="waha/inbox">
      <PluginBoundary pluginId="waha"><Inbox plugin={plugin} view={{ id: "inbox", label: "WhatsApp", icon: "IconBrandWhatsapp" } as never} /></PluginBoundary>
    </div>
  </main>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <RuntimeContext.Provider value={runtime}>
      {shell ? (
        <SidebarProvider>
          <Sidebar aria-label="Workspace navigation" collapsible="offcanvas" className="border-r-0">
            <SidebarContent><ul style={{ padding: 16, display: "grid", gap: 14, fontSize: 14 }}>{["Tasks & Automations", "Skills & MCP", "Secrets", "Terminal", "WhatsApp", "Projects"].map((t) => <li key={t}>{t}</li>)}</ul></SidebarContent>
          </Sidebar>
          {main}
        </SidebarProvider>
      ) : main}
      <Toaster />
    </RuntimeContext.Provider>
  </TooltipProvider>,
);
