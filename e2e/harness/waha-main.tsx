// Test harness: mounts the BUILT WhatsApp (WAHA) plugin bundle the way the app mounts an installed plugin (shared runtime global + Blob import),
// against a fake of the plugin's routes (see ./waha-fake.ts). Playwright serves the package at /__waha/pkg.json (e2e/waha-inbox.spec.ts). Not part of the app bundle.
//   ?theme=dark            dark theme
//   ?state=empty|loading|error|unconfigured|qr|stopped|failed
//   ?engine=WEBJS|NOWEB|GOWS
//   ?bare=1                do not load the app stylesheet at all: proves the plugin's own stylesheet carries its layout
import React from "react";
import ReactDOM from "react-dom/client";
import "./font-shim";
import { RuntimeContext } from "@/lib/runtime/store";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginBoundary } from "@/plugins/host";
import { dispatchPluginFrame } from "@/plugins/events";
import type { PluginInfo } from "@/lib/runtime/types";
import type { UiPluginDefinition } from "@/plugins/sdk";
import "@/plugins/shared-runtime";
import { createFake } from "./waha-fake";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
if (params.get("bare") !== "1") await import("@/index.css");
else document.body.style.margin = "0";

const fake = createFake({ state: params.get("state") ?? "ok", engine: params.get("engine") ?? "WEBJS", emit: (name, data) => dispatchPluginFrame({ type: "plugin", pluginId: "waha", name, data }) });
const client = { pluginFetch: (_id: string, path: string, init?: { method?: string; body?: unknown }) => fake.fetch(path, init) };
Object.assign(window, { __calls: fake.calls, __incoming: fake.incoming, __fake: fake });

const pkg = (await (await fetch("/__waha/pkg.json")).json()) as { manifest: { id: string; name: string; version: string }; ui: string };
const url = URL.createObjectURL(new Blob([pkg.ui], { type: "text/javascript" }));
const def = ((await import(/* @vite-ignore */ url)) as { default: UiPluginDefinition }).default;
const Inbox = def.views!.inbox;
const plugin = { id: pkg.manifest.id, name: pkg.manifest.name, version: pkg.manifest.version } as unknown as PluginInfo;
const runtime = { client, user: { id: "u1" }, navigate: () => undefined, openSettings: () => undefined } as unknown as React.ContextType<typeof RuntimeContext>;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <RuntimeContext.Provider value={runtime}>
      <main className="bg-background" style={{ position: "relative", height: "100vh", minHeight: 0 }} data-version={pkg.manifest.version}>
        <div style={{ position: "absolute", inset: 0 }} data-plugin-view="waha/inbox">
          <PluginBoundary pluginId="waha"><Inbox plugin={plugin} view={{ id: "inbox", label: "WhatsApp", icon: "IconBrandWhatsapp" } as never} /></PluginBoundary>
        </div>
      </main>
      <Toaster />
    </RuntimeContext.Provider>
  </TooltipProvider>,
);
