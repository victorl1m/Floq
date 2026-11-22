// Test harness for the WAHA conversation log: loads the built-in WhatsApp UI (src/plugins/whatsapp) and opens its ?demo=bubbles view,
// which carries its own fake routes (every bubble kind, menu, dialogs, lightbox).
//   ?theme=dark   dark theme      &chat=group   group chat      &engine=NOWEB|GOWS      &contacts=0      &hasmore=1
import React from "react";
import ReactDOM from "react-dom/client";
import "./font-shim";
import { RuntimeContext } from "@/lib/runtime/store";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginBoundary } from "@/plugins/host";
import type { PluginInfo } from "@/lib/runtime/types";
import type { UiPluginDefinition } from "@/plugins/sdk";
import "@/plugins/shared-runtime";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
await import("@/index.css");

// The integration's UI is part of the app now (src/plugins/whatsapp): imported like the app imports it, no package, no Blob.
const pkg = { manifest: { id: "waha", name: "WhatsApp", version: "builtin" } };
const def = (await import("@/plugins/whatsapp")).default as UiPluginDefinition;
const Inbox = def.views!.inbox;
const plugin = { id: pkg.manifest.id, name: pkg.manifest.name, version: pkg.manifest.version } as unknown as PluginInfo;
const runtime = { client: { async pluginFetch() { throw new Error("the demo has its own routes"); } }, user: { id: "u1" }, navigate: () => undefined, openSettings: () => undefined } as unknown as React.ContextType<typeof RuntimeContext>;

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
