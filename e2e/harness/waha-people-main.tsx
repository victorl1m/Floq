// Test harness for the WAHA chat menu, info panel and new chat / group dialogs: mounts the built-in WhatsApp UI (src/plugins/whatsapp) and opens its ?demo=people stand-in inbox
// against fake, stateful plugin routes
//   ?theme=dark   dark theme      ?engine=GOWS   hides what that engine cannot do      ?admin=0   you are not an admin of the group     ?info=1   info panel open
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

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const isAdmin = params.get("admin") !== "0";

interface Chat { chatId: string; kind: string; name: string | null; phone: string | null; lastBody: string; lastFromMe?: boolean; lastAt: string; total: number; unread: number; archived?: boolean; pinned?: boolean; muted?: boolean; markedUnread?: boolean; blocked?: boolean; avatar: number | null; hidden?: boolean }
const MARINA = "5511987654321@c.us", GROUP = "120363041234567890@g.us", LID = "193847561029384@lid", ENG = "5511933334444@c.us";
let chats: Chat[] = [
  { chatId: MARINA, kind: "user", name: "Marina Costa", phone: "5511987654321", lastBody: "Pode confirmar o endereço de entrega?", lastAt: ago(4 * MIN), total: 12, unread: 2, avatar: 1 },
  { chatId: GROUP, kind: "group", name: "Equipe Zoe · Produção", phone: null, lastBody: "Coleta marcada para as 15h", lastAt: ago(38 * MIN), total: 40, unread: 0, avatar: 1, pinned: true },
  { chatId: LID, kind: "user", name: null, phone: null, lastBody: "Olá, vocês fazem orçamento para brindes corporativos?", lastAt: ago(2 * HOUR), total: 1, unread: 1, avatar: null },
  { chatId: "5511944443333@c.us", kind: "user", name: null, phone: "5511944443333", lastBody: "Boa tarde, ainda tem estoque da ecobag?", lastAt: ago(3 * HOUR), total: 3, unread: 0, avatar: null },
  { chatId: "447911123456@c.us", kind: "user", name: "James Whitfield", phone: "447911123456", lastBody: "Thanks James, the invoice is attached.", lastFromMe: true, lastAt: ago(5 * DAY), total: 6, unread: 0, avatar: null, muted: true },
  { chatId: "5531988887777@c.us", kind: "user", name: "Papelaria Aurora", phone: "5531988887777", lastBody: "Fechado, pode faturar", lastAt: ago(9 * DAY), total: 8, unread: 0, avatar: null },
];
const CONTACTS = [
  ["Ana Souza", "5534999990000", true], ["Bia Nogueira", "5511933334444", true], ["Bruno Lima", "5511888887777", true], ["Carla Mendes", "5531955554444", true], ["Dra. Fernanda Albuquerque de Vasconcelos Montenegro", "5521999887766", true],
  ["Gráfica Ponto Certo", "5551966665555", true], ["Helena Prado", "5561955554444", true], ["James Whitfield", "447911123456", true], ["Lucas", "5541977776666", true], ["Marina Costa", "5511987654321", true],
  ["Papelaria Aurora", "5531988887777", true], ["Rafael Souza", "5511911112222", true], [null, "5521977776666", false],
].map(([name, phone, mine]) => ({ chatId: phone + "@c.us", name, phone, isMyContact: mine, avatar: null }));

interface Member { id: string; name: string; phone: string | null; role: "superadmin" | "admin" | "member"; isMe: boolean }
let members: Member[] = [
  { id: "5511000000000@c.us", name: "", phone: "5511000000000", role: isAdmin ? "admin" : "member", isMe: true },
  { id: "5511911112222@c.us", name: "Rafael Souza", phone: "5511911112222", role: "superadmin", isMe: false },
  { id: ENG, name: "Bia Nogueira", phone: "5511933334444", role: "admin", isMe: false },
  { id: "5511955556666@c.us", name: "", phone: "5511955556666", role: "member", isMe: false },
  { id: "5534999990000@c.us", name: "Ana Souza", phone: "5534999990000", role: "member", isMe: false },
  { id: "5531955554444@c.us", name: "Carla Mendes", phone: "5531955554444", role: "member", isMe: false },
  { id: "77120394857261@lid", name: "", phone: null, role: "member", isMe: false },
  { id: "5551966665555@c.us", name: "Gráfica Ponto Certo", phone: "5551966665555", role: "member", isMe: false },
  { id: "447911123456@c.us", name: "James Whitfield", phone: "447911123456", role: "member", isMe: false },
];
if (!isAdmin) members.sort((a, b) => Number(b.isMe) - Number(a.isMe));
const group = { subject: "Equipe Zoe · Produção", description: "Pedidos, produção e entregas da semana.\nAvisos importantes só aqui: dúvidas no privado.", announce: false, restrict: false, createdAt: "2024-03-14T12:00:00.000Z" };
let inviteN = 1;

const calls: Array<{ path: string; method: string; body?: unknown }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const svg = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; const a = h % 360; return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 60% 62%)"/><stop offset="1" stop-color="hsl(${(a + 50) % 360} 55% 42%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="50" cy="38" r="17" fill="rgba(255,255,255,.85)"/><path d="M16 100c2-24 17-36 34-36s32 12 34 36Z" fill="rgba(255,255,255,.85)"/></svg>`)}`; };
const chat = (id: string) => chats.find((c) => c.chatId === id);
const q = (path: string) => new URLSearchParams(path.split("?")[1] ?? "");

const client = {
  /** The signed link of a streamed plugin download: recorded, and it points nowhere (the spec checks what was asked, not the file). */
  async pluginDownloadUrl(id: string, path: string, query: Record<string, string> = {}) { ((window as unknown as { __downloads?: unknown[] }).__downloads ??= []).push({ id, path, query }); return "http://localhost:1420/__export-test?" + new URLSearchParams(query).toString(); },
  async pluginFetch(_id: string, path: string, init?: { method?: string; body?: unknown }) {
    const method = init?.method ?? "GET", body = (init?.body ?? {}) as Record<string, any>;
    calls.push({ path, method, body: init?.body });
    await sleep(15);
    const route = path.split("?")[0];
    switch (route) {
      case "/status": return { configured: true, missingSettings: [], missingSecrets: [], session: "default" };
      case "/chats": return { chats: chats.filter((c) => !c.hidden && !c.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastAt.localeCompare(a.lastAt)), archivedCount: chats.filter((c) => c.archived).length };
      case "/avatar": return { data: svg(q(path).get("chatId") ?? "") };
      case "/read": { const c = chat(body.chatId); if (c) { c.unread = 0; c.markedUnread = false; } return { ok: true }; }
      case "/chat/archive": { const c = chat(body.chatId); if (c) c.archived = body.archived; return { ok: true, ...(params.get("engine") === "GOWS" ? { localOnly: true } : {}) }; }
      case "/chat/pin": { const c = chat(body.chatId); if (c) c.pinned = body.pinned; return { ok: true }; }
      case "/chat/mute": { const c = chat(body.chatId); if (c) c.muted = body.until !== null; return { ok: true }; }
      case "/chat/unread": { const c = chat(body.chatId); if (c) { c.markedUnread = true; c.unread = Math.max(1, c.unread); } return { ok: true }; }
      case "/chat/delete": { const c = chat(body.chatId); if (c) c.hidden = true; return { ok: true }; }
      case "/chat/clear": { const c = chat(body.chatId); if (c) { c.lastBody = ""; c.total = 0; } return { ok: true }; }
      case "/contacts": { const s = (q(path).get("q") ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""); return { contacts: CONTACTS.filter((c) => !s || ((c.name ?? "") + " " + c.phone).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").includes(s)) }; }
      case "/contacts/check": {
        const d = String(body.phone).replace(/\D/g, "");
        if (d.endsWith("0000") && d !== "5534999990000") return { exists: false, chatId: null, phone: d };
        return { exists: true, chatId: d + "@c.us", phone: d };
      }
      case "/contact": {
        const c = chat(q(path).get("chatId") ?? "");
        const merged = (q(path).get("chatId") ?? "").endsWith("@lid");
        return { chatId: c?.chatId, name: c?.name ?? "", pushName: c?.name ? "" : c?.chatId === LID ? "Priscila" : "", phone: c?.phone, about: c?.name === "Marina Costa" ? "Disponível para pedidos de segunda a sexta, das 9h às 18h." : "", blocked: !!c?.blocked, isBusiness: c?.name === "Papelaria Aurora", isSelf: false, avatar: c?.avatar, aliases: merged ? 2 : 1, commonGroups: [] };
      }
      case "/contact/block": { const c = chat(body.chatId); if (c) c.blocked = body.blocked; return { ok: true, blocked: body.blocked }; }
      case "/contact/save": { const c = chat(body.chatId); if (c) c.name = `${body.firstName} ${body.lastName}`.trim(); return { ok: true, name: c?.name }; }
      case "/contact/refresh-picture": return { ok: true, avatar: Date.now() };
      case "/link": return { ok: true, chatId: body.withChatId };
      case "/group": return { chatId: GROUP, subject: group.subject, description: group.description, owner: "5511911112222@c.us", createdAt: group.createdAt, size: members.length, participants: members, iAmAdmin: isAdmin, announce: group.announce, restrict: group.restrict, avatar: 1 };
      case "/group/create": { const id = "1203630" + String(Math.floor(Math.random() * 1e8)) + "@g.us"; chats.unshift({ chatId: id, kind: "group", name: body.name, phone: null, lastBody: "", lastAt: new Date().toISOString(), total: 0, unread: 0, avatar: null }); return { chatId: id }; }
      case "/group/participants": {
        const ids: string[] = body.participants;
        if (body.action === "add") for (const id of ids) { const c = CONTACTS.find((x) => x.chatId === id); members.push({ id, name: c?.name ?? "", phone: id.split("@")[0], role: "member", isMe: false }); }
        if (body.action === "remove") members = members.filter((m) => !ids.includes(m.id));
        if (body.action === "promote") members.forEach((m) => { if (ids.includes(m.id)) m.role = "admin"; });
        if (body.action === "demote") members.forEach((m) => { if (ids.includes(m.id)) m.role = "member"; });
        return { ok: true };
      }
      case "/group/subject": group.subject = body.subject.trim(); { const c = chat(GROUP); if (c) c.name = group.subject; } return { ok: true, subject: group.subject };
      case "/group/description": group.description = body.description.trim(); return { ok: true, description: group.description };
      case "/group/settings": if (typeof body.announce === "boolean") group.announce = body.announce; if (typeof body.restrict === "boolean") group.restrict = body.restrict; return { ok: true };
      case "/group/invite": return { link: "https://chat.whatsapp.com/Kx7Qp2LmN9aVb" + inviteN };
      case "/group/invite/revoke": inviteN++; return { link: "https://chat.whatsapp.com/Kx7Qp2LmN9aVb" + inviteN };
      case "/group/leave": return { ok: true };
    }
    if (route === "/fail") throw fail(501, "unsupported", "no");
    throw new Error("No such route: " + path);
  },
};
Object.assign(window, { __calls: calls, __chats: () => chats, __event: (name: string, data: unknown) => dispatchPluginFrame({ type: "plugin", pluginId: "waha", name, data }) });

// The integration's UI is part of the app now (src/plugins/whatsapp): imported like the app imports it, no package, no Blob.
const pkg = { manifest: { id: "waha", name: "WhatsApp", version: "builtin" } };
const def = (await import("@/plugins/whatsapp")).default as UiPluginDefinition;
const Inbox = def.views!.inbox;
const plugin = { id: pkg.manifest.id, name: pkg.manifest.name, version: pkg.manifest.version } as unknown as PluginInfo;
const runtime = { client, user: { id: "u1" }, navigate: () => undefined, openSettings: () => undefined } as unknown as React.ContextType<typeof RuntimeContext>;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <RuntimeContext.Provider value={runtime}>
      <main className="bg-background" style={{ position: "relative", height: "100vh", minHeight: 0 }}>
        <div style={{ position: "absolute", inset: 0 }} data-plugin-view="waha/inbox">
          <PluginBoundary pluginId="waha"><Inbox plugin={plugin} view={{ id: "inbox", label: "WhatsApp", icon: "IconBrandWhatsapp" } as never} /></PluginBoundary>
        </div>
      </main>
      <Toaster />
    </RuntimeContext.Provider>
  </TooltipProvider>,
);
