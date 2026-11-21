// Test harness: mounts the BUILT WhatsApp (WAHA) plugin bundle the way the app mounts an installed plugin (shared runtime global + Blob import),
// against fake plugin routes. Playwright serves the package at /__waha/pkg.json (see e2e/waha-inbox.spec.ts). Not part of the app bundle.
//   ?theme=dark            dark theme
//   ?state=empty|loading|error|unconfigured
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

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "ok";
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
if (params.get("bare") !== "1") await import("@/index.css");
else document.body.style.margin = "0";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const at = (days: number, h: number, m: number) => { const d = new Date(now - days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); };

interface Quote { id: string; body: string; hasMedia?: boolean; fromMe: boolean; sender: string; senderName?: string }
interface Msg { id: string; fromMe: boolean; sender: string; senderName: string; body: string; hasMedia: boolean; sentAt: string; replyTo?: Quote | null }
let seq = 0;
const msg = (fromMe: boolean, body: string, sentAt: string, sender = "", senderName = "", hasMedia = false): Msg => ({ id: "m" + ++seq, fromMe, sender: fromMe ? "me" : sender, senderName, body, hasMedia, sentAt });

const MARINA = "5511987654321@c.us", GROUP = "120363041234567890@g.us", LID = "193847561029384@lid", LONG = "5521999887766@c.us";
const quote = (m: Msg): Quote => ({ id: m.id, body: m.body, hasMedia: m.hasMedia, fromMe: m.fromMe, sender: m.fromMe ? "" : m.sender, senderName: m.senderName });
const messages: Record<string, Msg[]> = {
  [MARINA]: [
    msg(false, "Oi! Chegaram as canecas personalizadas?", at(1, 16, 2), MARINA, "Marina Costa"),
    msg(true, "Chegaram sim, ficaram lindas", at(1, 16, 5)),
    msg(true, "Mando as fotos amanhã cedo", at(1, 16, 5)),
    msg(false, "Perfeito, obrigada!", at(1, 16, 9), MARINA, "Marina Costa"),
    msg(false, "", at(0, 9, 12), MARINA, "Marina Costa", true),
    msg(false, "Esse é o modelo que a cliente pediu. Dá para fazer 40 unidades até sexta? Ela quer com o nome de cada convidado gravado na lateral e uma caixinha kraft para cada uma.", at(0, 9, 13), MARINA, "Marina Costa"),
    msg(true, "Dá sim. 40 unidades com gravação e caixa kraft fica pronto na quinta à tarde.", at(0, 9, 20)),
    msg(true, "Te passo o orçamento em 10 min", at(0, 9, 20)),
    msg(false, "Combinado 🙌", at(0, 9, 31), MARINA, "Marina Costa"),
    msg(false, "Pode confirmar o endereço de entrega?\nRua das Laranjeiras, 120, apto 54", ago(4 * MIN), MARINA, "Marina Costa"),
  ],
  [GROUP]: [
    msg(false, "Bom dia, pessoal! Alguém viu o pedido #2231?", at(0, 8, 2), "5511911112222@c.us", "Rafael Souza"),
    msg(false, "Já está na produção, sai hoje", at(0, 8, 6), "5511933334444@c.us", "Bia Nogueira"),
    msg(false, "A etiqueta foi impressa ontem", at(0, 8, 6), "5511933334444@c.us", "Bia Nogueira"),
    msg(true, "Ótimo. Me avisem quando a transportadora coletar", at(0, 8, 10)),
    msg(false, "Coleta marcada para as 15h", at(0, 8, 41), "77120394857261@lid", ""),
    msg(false, "", at(0, 8, 42), "5511955556666@c.us", "", true),
    msg(false, "Segue o comprovante", at(0, 8, 42), "5511955556666@c.us", ""),
    msg(true, "Valeu, time 👏", at(0, 8, 50)),
    msg(false, "https://rastreamento.example.com/pedido/2231-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789", ago(38 * MIN), "5511911112222@c.us", "Rafael Souza"),
  ],
  [LID]: [msg(false, "Olá, vocês fazem orçamento para brindes corporativos?", ago(2 * HOUR), LID, "")],
  [LONG]: [msg(true, "Enviei a proposta por e-mail", at(2, 11, 30))],
};
const base = [
  { chatId: MARINA, kind: "user", name: "Marina Costa", phone: "5511987654321", unread: 2 },
  { chatId: GROUP, kind: "group", name: "Equipe Zoe · Produção", phone: null, unread: 0 },
  { chatId: LID, kind: "user", name: null, phone: null, unread: 1 },
  { chatId: "5511944443333@c.us", kind: "user", name: null, phone: "5511944443333", unread: 128, last: msg(false, "Boa tarde, ainda tem estoque da ecobag?", ago(3 * HOUR)) },
  { chatId: LONG, kind: "user", name: "Dra. Fernanda Albuquerque de Vasconcelos Montenegro (Clínica Bem Viver)", phone: "5521999887766", unread: 0 },
  { chatId: "120363049999999999@g.us", kind: "group", name: null, phone: null, unread: 0, last: msg(false, "", at(3, 14, 0), "", "", true) },
  { chatId: "447911123456@c.us", kind: "user", name: "James Whitfield", phone: "447911123456", unread: 0, last: msg(true, "Thanks James, the invoice is attached. Let me know if the delivery window on Thursday still works for you and the team.", at(5, 10, 15)) },
  { chatId: "5531988887777@c.us", kind: "user", name: "Papelaria Aurora", phone: "5531988887777", unread: 0, last: msg(false, "Fechado, pode faturar", at(9, 17, 45)) },
  { chatId: "5541977776666@c.us", kind: "user", name: "Lucas", phone: "5541977776666", unread: 0, last: msg(false, "👍", at(21, 9, 5)) },
  { chatId: "5551966665555@c.us", kind: "user", name: "Gráfica Ponto Certo", phone: "5551966665555", unread: 0, last: msg(true, "Arte final aprovada", at(40, 13, 20)) },
  { chatId: "5561955554444@c.us", kind: "user", name: "Helena Prado", phone: "5561955554444", unread: 0, last: msg(false, "Obrigada pelo atendimento!", at(75, 18, 2)) },
] as Array<{ chatId: string; kind: string; name: string | null; phone: string | null; unread: number; last?: Msg }>;
// Replies: to my message, to a photo, to a group member, and to a message that is not loaded any more.
{
  const m = messages[MARINA], g = messages[GROUP];
  m[8].replyTo = quote(m[7]);
  m[6].replyTo = quote(m[4]);
  g[3].replyTo = quote(g[1]);
  g[8].replyTo = { id: "", body: "Qual é o código de rastreio do 2231? O cliente está perguntando desde ontem e preciso responder hoje ainda.", fromMe: false, sender: "5511955556666@c.us", senderName: "" };
}
const unread = new Map(base.map((c) => [c.chatId, c.unread]));
const extra = new Map(base.filter((c) => c.last).map((c) => [c.chatId, [c.last!]]));
const log = (id: string) => messages[id] ?? extra.get(id) ?? [];
const chats = () => base.map((c) => {
  const l = log(c.chatId), last = l[l.length - 1];
  return { chatId: c.chatId, kind: c.kind, name: c.name, phone: c.phone, lastBody: last?.body ?? "", lastFromMe: last?.fromMe ?? false, lastHasMedia: last?.hasMedia ?? false, lastAt: last?.sentAt ?? ago(0), total: l.length, unread: unread.get(c.chatId) ?? 0 };
}).sort((a, b) => b.lastAt.localeCompare(a.lastAt));

const calls: Array<{ path: string; method: string; body?: unknown }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = {
  async pluginFetch(_id: string, path: string, init?: { method?: string; body?: unknown }) {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    await sleep(10);
    const body = (init?.body ?? {}) as { chatId?: string; text?: string; replyTo?: string };
    if (path === "/status") return state === "unconfigured" ? { configured: false, missingSettings: ["baseUrl"], missingSecrets: ["WAHA_API_KEY"], session: "default" } : { configured: true, missingSettings: [], missingSecrets: [], session: "default" };
    if (path === "/chats") {
      if (state === "loading") await new Promise(() => undefined);
      if (state === "error") throw new Error("WAHA did not answer. Check that your instance is running.");
      return { chats: state === "empty" ? [] : chats() };
    }
    if (path.startsWith("/messages")) return { messages: log(new URLSearchParams(path.split("?")[1]).get("chatId") ?? "") };
    if (path === "/read") { unread.set(body.chatId ?? "", 0); return { ok: true }; }
    if (path === "/send") {
      await sleep(250);
      const id = body.chatId ?? "";
      const original = body.replyTo ? log(id).find((x) => x.id === body.replyTo) : undefined;
      if (body.replyTo && !original) throw new Error("replyTo is not a message of this chat");
      (messages[id] ??= [...log(id)]).push({ ...msg(true, body.text ?? "", new Date().toISOString()), replyTo: original ? quote(original) : null });
      return { ok: true };
    }
    throw new Error("No such route: " + path);
  },
};
Object.assign(window, {
  __calls: calls,
  /** Simulates an incoming message event from the plugin runtime. */
  __incoming(chatId: string, body: string, sender = chatId, senderName = "") {
    (messages[chatId] ??= [...log(chatId)]).push(msg(false, body, new Date().toISOString(), sender, senderName));
    unread.set(chatId, (unread.get(chatId) ?? 0) + 1);
    dispatchPluginFrame({ type: "plugin", pluginId: "waha", name: "message", data: { chatId, fromMe: false } });
  },
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
