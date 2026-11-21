// Test harness for the WAHA plugin's labels, status, channels, call banner and presence components: the BUILT package, mounted like an installed plugin
// (shared runtime global, Blob import) with fake routes. The inbox view renders the demo screen when the URL has demo=more.
// Served at /__waha/pkg.json by e2e/waha-more.spec.ts.
//   ?theme=dark  dark theme   ?view=status|channels  left pane   ?picker=1  label dialog open   ?pane=chat  narrow: show the conversation
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

const MIN = 60_000, HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A picture drawn on a canvas, as base64 (the runtime serves files that way). */
function picture(w: number, h: number, from: string, to: string, label: string) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, from); grad.addColorStop(1, to);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,.2)"; g.beginPath(); g.arc(w * 0.72, h * 0.3, w * 0.22, 0, 7); g.fill();
  g.fillStyle = "#fff"; g.font = "bold " + Math.round(w / 11) + "px sans-serif"; g.textAlign = "center"; g.fillText(label, w / 2, h * 0.62);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}
const files: Record<string, string> = {
  R2: picture(720, 1280, "#ff8a65", "#7e57c2", "Fresh batch"),
  M2: picture(720, 960, "#26a69a", "#1565c0", "My shop"),
  B1: picture(720, 1280, "#ffd54f", "#ef6c00", "Sale today"),
};

let labels = [{ id: "1", name: "New client", color: "#64c4ff" }, { id: "2", name: "Paid", color: "#55ccb3" }, { id: "3", name: "Follow up", color: "#ffd429" }, { id: "4", name: "VIP", color: "#9368cf" }];
const chatLabels: Record<string, string[]> = { "5511987654321@c.us": ["1", "3"] };
const POSTER = (chatId: string, name: string, phone: string | null, isMe = false) => ({ chatId, name, phone, avatar: null, isMe });
const status = [
  { poster: POSTER("5511900000000@c.us", "My status", "5511900000000", true), items: [
    { id: "M1", type: "text", body: "Open until 6 pm today", background: "#1f7aec", media: null, sentAt: ago(3 * HOUR) },
    { id: "M2", type: "image", body: "New window display", media: { mime: "image/jpeg", available: true }, sentAt: ago(40 * MIN) }] },
  { poster: POSTER("5511911112222@c.us", "Rafael Souza", "5511911112222"), items: [
    { id: "R1", type: "text", body: "Good morning! Production is on schedule and the first batch ships at noon.", background: "#8e24aa", media: null, sentAt: ago(5 * HOUR) },
    { id: "R2", type: "image", body: "Fresh batch", media: { mime: "image/jpeg", available: true }, sentAt: ago(2 * HOUR) },
    { id: "R3", type: "image", body: "", media: { mime: "image/jpeg", available: false }, sentAt: ago(30 * MIN) }] },
  { poster: POSTER("5511933334444@c.us", "Bia Nogueira", "5511933334444"), items: [{ id: "B1", type: "image", body: "Sale today", media: { mime: "image/jpeg", available: true }, sentAt: ago(70 * MIN) }] },
  { poster: POSTER("5521988887777@c.us", "", "5521988887777"), items: [{ id: "U1", type: "text", body: "Hello!", background: "#d4337a", media: null, sentAt: ago(9 * HOUR) }] },
];
const channels = [
  { id: "120363111111111111@newsletter", name: "Zoe Personalizados", description: "News and launches", picture: "", verified: true, role: "SUBSCRIBER", subscribers: 12400 },
  { id: "120363222222222222@newsletter", name: "Papelaria Aurora", description: "Stationery tips", picture: "", verified: false, role: "SUBSCRIBER", subscribers: 830 },
  { id: "120363333333333333@newsletter", name: "Design diário", description: "A design idea every day", picture: "", verified: false, role: "SUBSCRIBER" },
];
const found = [{ id: "120363444444444444@newsletter", name: "Design Weekly", description: "", picture: "", verified: true, role: "GUEST", subscribers: 250000 }, { id: "120363555555555555@newsletter", name: "Brand design club", description: "", picture: "", verified: false, role: "GUEST", subscribers: 4100 }];
const at = (min: number) => ago(min * MIN);
const posts = [
  { id: "P1", fromMe: false, sender: "x", body: "New personalised mugs are in. Order by Friday for delivery before the weekend.", hasMedia: false, type: "chat", sentAt: at(60 * 26), views: 1840, ack: 0 },
  { id: "P2", fromMe: false, sender: "x", body: "Behind the scenes: how a mug gets its name engraved.", hasMedia: true, type: "video", media: { mime: "video/mp4", filename: "v.mp4", size: null, duration: null, width: null, height: null, available: false }, sentAt: at(60 * 5), views: 2210, ack: 0 },
  { id: "P3", fromMe: false, sender: "x", body: "", hasMedia: true, type: "image", media: { mime: "image/jpeg", filename: "p.jpg", size: null, duration: null, width: null, height: null, available: false }, sentAt: at(95), views: 3002, ack: 0, reactions: [{ emoji: "👍", count: 120, mine: false, senders: [] }, { emoji: "❤️", count: 48, mine: false, senders: [] }] },
  { id: "P4", fromMe: false, sender: "x", body: "Reminder: we close at 6 pm today.", hasMedia: false, type: "chat", sentAt: at(12), views: 410, ack: 0 },
];

const calls: Array<{ path: string; method: string; body?: any }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = {
  async pluginFetch(_id: string, path: string, init?: { method?: string; body?: any }) {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    await sleep(10);
    const [route, qs] = path.split("?"), q = new URLSearchParams(qs ?? ""), body = init?.body ?? {};
    if (route === "/labels" && !init?.method) return { labels, supported: true };
    if (route === "/labels") { labels = [...labels, { id: String(labels.length + 5), name: body.name, color: body.color }]; return { ok: true }; }
    if (route === "/labels/update") { labels = labels.map((l) => (l.id === body.id ? { ...l, name: body.name, color: body.color } : l)); return { ok: true }; }
    if (route === "/labels/delete") { labels = labels.filter((l) => l.id !== body.id); return { ok: true }; }
    if (route === "/labels/chat" && !init?.method) return { chatId: q.get("chatId"), labels: chatLabels[q.get("chatId") ?? ""] ?? [] };
    if (route === "/labels/chat") { chatLabels[body.chatId] = body.labels; return { ok: true }; }
    if (route === "/presence") return { chatId: q.get("chatId"), state: "online", lastSeen: null };
    if (route === "/status/list") return status;
    if (route === "/status/media") { const id = q.get("id") ?? ""; if (!files[id]) throw Object.assign(new Error("Gone"), { status: 404 }); return { mime: "image/jpeg", data: files[id] }; }
    if (route === "/status/text" || route === "/status/image" || route === "/status/video") { await sleep(150); return { ok: true }; }
    if (route === "/status/delete") return { ok: true };
    if (route === "/channels") return { channels };
    if (route === "/channels/search") return { channels: found };
    if (route === "/channel/messages") return { id: q.get("id"), messages: posts };
    if (route === "/channel/follow") return { ok: true };
    if (route === "/call/reject") return { ok: true };
    throw Object.assign(new Error("No such route: " + path), { status: 404 });
  },
};
Object.assign(window, {
  __calls: calls,
  /** Simulates a plugin event frame. */
  __event(name: string, data: unknown) { dispatchPluginFrame({ type: "plugin", pluginId: "waha", name, data } as never); },
});

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
