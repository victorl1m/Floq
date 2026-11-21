// Test harness for the WAHA connection screen, reconnect bar and account menu: loads the BUILT package like waha-composer-main.tsx and renders its
// "?demo=session" view against fake session routes. window.__set(status) changes the fake WAHA and pushes the live "session" event.
//   ?theme=dark   ?view=screen|inbox   ?status=WORKING|SCAN_QR_CODE|...   ?engine=WEBJS|NOWEB|GOWS   ?webhook=missing|env|ok
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

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
await import("@/index.css");

const WANTED = ["message.any", "message.ack", "message.ack.group", "message.reaction", "message.edited", "message.revoked", "session.status", "presence.update", "poll.vote", "chat.archive", "call.received", "call.accepted", "call.rejected", "label.upsert", "label.deleted", "label.chat.added", "label.chat.deleted", "group.v2.join", "group.v2.leave", "group.v2.update", "group.v2.participants"];
// A WAHA raw QR value: "2@" + three base64 blobs.
const b64 = (n: number, seed: number) => { let s = seed, o = ""; const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; o += a[(s >> 8) % 64]; } return o; };
let qrN = 0;
const qrValue = () => `2@${b64(64, 7 + qrN)},${b64(44, 11 + qrN)},${b64(44, 13 + qrN)},1`;

const webhookMode = params.get("webhook") ?? "ok";
const state = {
  status: params.get("status") ?? "SCAN_QR_CODE",
  engine: params.get("engine") ?? "WEBJS",
  me: { name: "Zoe Personalizações", phone: "5511987654321" } as { name: string; phone: string } | null,
  missing: webhookMode === "missing" ? WANTED.slice(7) : [] as string[],
  env: webhookMode === "env",
};
const calls: Array<{ path: string; method: string; body?: unknown }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const set = (status: string) => { state.status = status; dispatchPluginFrame({ type: "plugin", pluginId: "waha", name: "session", data: { status } }); };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8CAFQ0nCQCCmQ/h/mNylAAAAABJRU5ErkJggg==";

const client = {
  async pluginFetch(_id: string, path: string, init?: { method?: string; body?: unknown }) {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    await sleep(15);
    if (path === "/status") return { configured: true, missingSettings: [], missingSecrets: [], session: "default" };
    if (path === "/session") {
      const down = state.status === "UNREACHABLE" || state.status === "UNAUTHORIZED";
      return {
        status: state.status, engine: down ? "" : state.engine, me: state.status === "WORKING" ? state.me : null,
        webhook: state.env || down ? null : { configured: true, events: WANTED.filter((e) => !state.missing.includes(e)), missingEvents: state.missing }, wantedEvents: WANTED,
      };
    }
    if (path === "/session/qr") { if (state.status !== "SCAN_QR_CODE") throw fail(409, "not_scanning", "WhatsApp is not waiting for a scan right now."); qrN++; return { value: qrValue() }; }
    if (path === "/phone") return { phone: "+5511987654321", formatted: "+55 (11) 98765-4321" };
    if (path === "/session/pair-code") {
      const b = init?.body as { phone?: string };
      if (!/\d{8}/.test(b.phone ?? "")) throw fail(400, "invalid_phone", "Pick the country and type the number.");
      await sleep(150); return { code: "WXYZ-1234" };
    }
    if (path === "/session/start" || path === "/session/restart") { await sleep(200); set("STARTING"); return { ok: true }; }
    if (path === "/session/stop") { set("STOPPED"); return { ok: true }; }
    if (path === "/session/logout") { set("SCAN_QR_CODE"); return { ok: true }; }
    if (path === "/session/webhook-events") { const added = state.missing; state.missing = []; return { ok: true, added }; }
    if (path === "/session/screenshot") { if (state.engine !== "WEBJS") throw fail(501, "unsupported", "This WAHA engine does not support that."); return { image: "data:image/png;base64," + PNG }; }
    throw new Error("No such route: " + path);
  },
};
Object.assign(window, { __calls: calls, __set: set, __state: state });

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
