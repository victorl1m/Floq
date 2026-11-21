// A fake of the WAHA plugin's routes for the browser harness: enough state to click through the whole inbox. Mirrors the response shapes of
// floq-plugin-waha/runtime (inbox.ts, messages.ts and the session / chats / contacts / groups / labels / status / channels / calls / presence modules).
type Json = Record<string, unknown>;
interface Opts { state: string; engine: string; emit: (name: string, data: unknown) => void }

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const at = (days: number, h: number, m: number) => { const d = new Date(now - days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); };

export const SELF = "553488880000@c.us", MARINA = "5511987654321@c.us", GROUP = "120363041234567890@g.us", LID = "193847561029384@lid", LONG = "5521999887766@c.us";
const RAFAEL = "5511911112222@c.us", BIA = "5511933334444@c.us";

interface Msg extends Json { id: string; fromMe: boolean; sender: string; senderName: string; body: string; hasMedia: boolean; sentAt: string; type: string; ack: number; reactions: Json[]; replyTo?: Json | null; media?: Json | null }
let seq = 0;
function msg(fromMe: boolean, body: string, sentAt: string, extra: Partial<Msg> = {}): Msg {
  return { id: `${fromMe}_x_M${++seq}`, fromMe, sender: fromMe ? "me" : "", senderName: "", body, hasMedia: Boolean(extra.media), sentAt, type: "chat", ack: fromMe ? 3 : 0, edited: false, deleted: false, starred: false, pinned: false, forwarded: false, media: null, reactions: [], replyTo: null, ...extra };
}
const from = (id: string, name: string) => ({ sender: id, senderName: name });
const media = (mime: string, filename = "", more: Json = {}) => ({ mime, filename, size: null, duration: null, width: null, height: null, gif: false, available: true, ...more });
const quote = (m: Msg) => ({ id: m.id, body: m.body, hasMedia: m.hasMedia, fromMe: m.fromMe, sender: m.fromMe ? "" : m.sender, senderName: m.senderName });

// ---- generated files (no network): pictures from a canvas, a short tone as a voice note, a tiny PDF ----
function picture(seed: number, w = 640, h = 480, label = ""): string {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${(seed * 47) % 360} 70% 62%)`); grad.addColorStop(1, `hsl(${(seed * 47 + 80) % 360} 65% 38%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,.22)";
  for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(((seed + 3) * (i + 1) * 97) % w, ((seed + 5) * (i + 2) * 61) % h, 22 + ((seed + i) * 13) % 70, 0, Math.PI * 2); g.fill(); }
  if (label) { g.fillStyle = "#fff"; g.font = `600 ${Math.round(h / 9)}px system-ui, sans-serif`; g.textAlign = "center"; g.fillText(label, w / 2, h / 2); }
  return c.toDataURL("image/jpeg", 0.82).split(",")[1];
}
function face(seed: number, letter: string): string {
  const c = document.createElement("canvas"); c.width = c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = `hsl(${(seed * 67) % 360} 55% 55%)`; g.fillRect(0, 0, 96, 96);
  g.fillStyle = "rgba(255,255,255,.9)"; g.beginPath(); g.arc(48, 38, 18, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(48, 96, 34, Math.PI, 0); g.fill();
  g.fillStyle = "rgba(0,0,0,.35)"; g.font = "700 14px system-ui"; g.fillText(letter, 6, 16);
  return c.toDataURL("image/jpeg", 0.85);
}
function tone(seconds: number): string {
  const rate = 8000, n = Math.floor(rate * seconds), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * (300 + 200 * Math.sin(i / rate * 3))) * 9000 * (0.4 + 0.6 * Math.abs(Math.sin(i / rate * 5))), true);
  let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}
const PDF = btoa("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

export function createFake({ state, engine, emit }: Opts) {
  const marina = from(MARINA, "Marina Costa");
  const m1 = msg(false, "Oi! Chegaram as canecas personalizadas?", at(1, 16, 2), marina);
  const m2 = msg(true, "Chegaram sim, ficaram *lindas* 😍", at(1, 16, 5));
  const photo = msg(false, "Esse é o modelo que a cliente pediu", at(0, 9, 12), { ...marina, type: "image", media: media("image/jpeg", "", { width: 640, height: 480 }), reactions: [{ emoji: "❤️", count: 1, mine: true, senders: [] }] });
  const offer = msg(true, "Dá sim. 40 unidades com gravação e caixa kraft fica pronto na quinta à tarde.", at(0, 9, 20), { replyTo: quote(photo) });
  const messages: Record<string, Msg[]> = {
    [MARINA]: [
      m1, m2,
      msg(true, "Mando as fotos amanhã cedo", at(1, 16, 5), { starred: true }),
      msg(false, "Perfeito, obrigada!", at(1, 16, 9), { ...marina, reactions: [{ emoji: "👍", count: 1, mine: true, senders: [] }] }),
      photo,
      msg(false, "Dá para fazer _40 unidades_ até sexta? Ela quer com o nome de cada convidado gravado na lateral e uma caixinha kraft para cada uma.", at(0, 9, 13), marina),
      offer,
      msg(false, "", at(0, 9, 24), { ...marina, type: "ptt", media: media("audio/wav", "", { duration: 7 }) }),
      msg(true, "", at(0, 9, 26), { type: "document", media: media("application/pdf", "orcamento-40-canecas.pdf", { size: 184_320 }), ack: 2 }),
      msg(false, "", at(0, 9, 28), { ...marina, type: "location", location: { lat: -18.9186, lng: -48.2772, name: "Ateliê Zoe", address: "Av. Rondon Pacheco, 1200 - Uberlândia" } }),
      msg(false, "", at(0, 9, 29), { ...marina, type: "vcard", vcards: [{ name: "Carla Transportes", phones: ["5534988776655"], formatted: ["+55 (34) 98877-6655"] }] }),
      msg(true, "", at(0, 9, 30), { type: "poll", poll: { name: "Qual cor de caixa?", multiple: false, voters: 1, options: [{ name: "Kraft natural", votes: 1, voted: false }, { name: "Branca", votes: 0, voted: false }, { name: "Preta fosca", votes: 0, voted: false }] } }),
      msg(false, "Combinado 🙌", at(0, 9, 31), { ...marina, replyTo: quote(offer) }),
      msg(false, "Olha esse fornecedor: https://caixaskraft.example.com/atacado", at(0, 9, 40), { ...marina, preview: { title: "Caixas Kraft no atacado", description: "Embalagens personalizadas a partir de 50 unidades. Entrega para todo o Brasil.", url: "https://caixaskraft.example.com/atacado" }, forwarded: true }),
      msg(true, "Vou pedir amostra, valeu", at(0, 9, 42), { edited: true }),
      msg(false, "", at(0, 9, 43), { ...marina, type: "deleted", deleted: true }),
      msg(false, "", at(0, 9, 44), { ...marina, type: "sticker", media: media("image/jpeg", "", { width: 256, height: 256 }) }),
      msg(false, "", at(0, 9, 45), { ...marina, type: "video", media: media("video/mp4", "", { duration: 14, width: 480, height: 270, available: false }) }),
      msg(false, "", at(0, 9, 50), { ...marina, type: "call", call: { video: false, status: "missed" } }),
      msg(true, "👍", at(0, 10, 2), { ack: 1 }),
      msg(false, "Pode confirmar o endereço de entrega?\nRua das Laranjeiras, 120, apto 54", ago(4 * MIN), marina),
    ],
    [GROUP]: [
      msg(false, "Bom dia, pessoal! Alguém viu o pedido #2231?", at(0, 8, 2), from(RAFAEL, "Rafael Souza")),
      msg(false, "Já está na produção, sai hoje", at(0, 8, 6), from(BIA, "Bia Nogueira")),
      msg(false, "A etiqueta foi impressa ontem", at(0, 8, 6), from(BIA, "Bia Nogueira")),
      msg(true, "Ótimo. @5511933334444 me avisa quando a transportadora coletar", at(0, 8, 10), { mentions: [BIA] }),
      msg(false, "Coleta marcada para as 15h", at(0, 8, 41), from("5511977778888@c.us", "")),
      msg(false, "Segue o comprovante", at(0, 8, 42), { ...from("5511955556666@c.us", ""), type: "image", media: media("image/jpeg", "", { width: 480, height: 640 }) }),
      msg(false, "", at(0, 8, 45), { ...from(RAFAEL, "Rafael Souza"), type: "poll", poll: { name: "Reunião semanal: que dia?", multiple: true, voters: 3, options: [{ name: "Segunda 9h", votes: 2, voted: true }, { name: "Quarta 14h", votes: 1, voted: false }, { name: "Sexta 16h", votes: 0, voted: false }] } }),
      msg(true, "Valeu, time 👏", at(0, 8, 50), { reactions: [{ emoji: "👏", count: 2, mine: false, senders: [RAFAEL, BIA] }, { emoji: "🔥", count: 1, mine: false, senders: [BIA] }] }),
      msg(false, "https://rastreamento.example.com/pedido/2231-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789", ago(38 * MIN), from(RAFAEL, "Rafael Souza")),
    ],
    // The user's own chat: messages that arrived under their lid and under both spellings of their number, shown as one conversation.
    [SELF]: [
      msg(true, "Floq test message: your assistant can reach you on this number.", at(2, 15, 23)),
      msg(false, "Build ok, pode publicar", at(1, 2, 51), from(SELF, "Victor")),
      msg(false, "Sim", at(1, 14, 46), from(SELF, "Victor")),
      msg(true, "*Build v1.0.46 is ready.* All 87 tests pass.", at(1, 21, 26)),
      msg(false, "Pode simplificar", at(1, 21, 27), from(SELF, "Victor")),
      msg(false, "Usa a mesma chave da API", ago(5 * HOUR), from(SELF, "Victor")),
    ],
    [LID]: [msg(false, "Olá, vocês fazem orçamento para brindes corporativos?", ago(2 * HOUR), from(LID, ""))],
    [LONG]: [msg(true, "Enviei a proposta por e-mail", at(2, 11, 30), { ack: 2 })],
  };
  interface Row extends Json { chatId: string; kind: string; name: string | null; phone: string | null; unread: number; last?: Msg }
  const base: Row[] = [
    { chatId: MARINA, kind: "user", name: "Marina Costa", phone: "5511987654321", unread: 2, avatar: 1, pinned: true },
    { chatId: GROUP, kind: "group", name: "Equipe Zoe · Produção", phone: null, unread: 0, avatar: 2 },
    { chatId: SELF, kind: "user", name: "Victor", phone: "5534988880000", unread: 0, isSelf: true, avatar: 3 },
    { chatId: LID, kind: "user", name: null, phone: null, unread: 1 },
    { chatId: "5511944443333@c.us", kind: "user", name: null, phone: "5511944443333", unread: 128, last: msg(false, "Boa tarde, ainda tem estoque da ecobag?", ago(3 * HOUR)) },
    { chatId: LONG, kind: "user", name: "Dra. Fernanda Albuquerque de Vasconcelos Montenegro (Clínica Bem Viver)", phone: "5521999887766", unread: 0, muted: true },
    { chatId: "120363049999999999@g.us", kind: "group", name: null, phone: null, unread: 0, last: msg(false, "", at(3, 14, 0), { type: "image", media: media("image/jpeg"), senderName: "Paulo" }) },
    { chatId: "447911123456@c.us", kind: "user", name: "James Whitfield", phone: "447911123456", unread: 0, last: msg(true, "Thanks James, the invoice is attached. Let me know if the delivery window on Thursday still works for you and the team.", at(5, 10, 15), { ack: 3 }) },
    { chatId: "5531988887777@c.us", kind: "user", name: "Papelaria Aurora", phone: "5531988887777", unread: 0, last: msg(false, "", at(9, 17, 45), { type: "ptt", media: media("audio/ogg", "", { duration: 12 }) }), avatar: 4 },
    { chatId: "5541977776666@c.us", kind: "user", name: "Lucas", phone: "5541977776666", unread: 0, last: msg(false, "👍", at(21, 9, 5)) },
    { chatId: "5551966665555@c.us", kind: "user", name: "Gráfica Ponto Certo", phone: "5551966665555", unread: 0, last: msg(true, "Arte final aprovada", at(40, 13, 20), { ack: 1 }) },
    { chatId: "5561955554444@c.us", kind: "user", name: "Helena Prado", phone: "5561955554444", unread: 0, last: msg(false, "Obrigada pelo atendimento!", at(75, 18, 2)), archived: true },
    { chatId: "5571944443322@c.us", kind: "user", name: "Fornecedor Antigo", phone: "5571944443322", unread: 0, last: msg(false, "Tabela 2024 em anexo", at(120, 11, 0), { type: "document", media: media("application/pdf", "tabela.pdf") }), archived: true },
  ];
  const state_ = new Map(base.map((c) => [c.chatId, { unread: c.unread, archived: c.archived === true, pinned: c.pinned === true, muted: c.muted === true, markedUnread: false, hidden: false }]));
  const extra = new Map(base.filter((c) => c.last).map((c) => [c.chatId, [c.last!]]));
  const log = (id: string) => (messages[id] ??= extra.get(id) ?? []);
  const find = (id: string) => { for (const [chatId, list] of Object.entries(messages)) { const m = list.find((x) => x.id === id); if (m) return { chatId, m, list }; } for (const [chatId, list] of extra) { const m = list.find((x) => x.id === id); if (m) return { chatId, m, list: log(chatId) }; } return null; };
  const row = (c: Row) => {
    const l = log(c.chatId), last = l[l.length - 1], s = state_.get(c.chatId)!;
    return {
      chatId: c.chatId, kind: c.kind, name: c.name, phone: c.phone, isSelf: c.isSelf === true, lastBody: last?.deleted ? "" : last?.body ?? "", lastFromMe: last?.fromMe ?? false, lastHasMedia: last?.hasMedia ?? false, lastType: last?.type ?? "chat",
      lastAck: last?.ack ?? 0, lastDeleted: last?.deleted === true, lastSenderName: c.kind === "group" ? last?.senderName ?? "" : "", lastAt: last?.sentAt ?? ago(0), total: l.length, unread: Math.max(s.unread, s.markedUnread ? 1 : 0), markedUnread: s.markedUnread,
      archived: s.archived, pinned: s.pinned, muted: s.muted, blocked: false, avatar: c.avatar ?? null, labels: c.chatId === MARINA ? ["1"] : [],
    };
  };
  const chats = (archived: boolean) => base.filter((c) => !state_.get(c.chatId)!.hidden && state_.get(c.chatId)!.archived === archived).map(row).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt.localeCompare(a.lastAt));
  const uploads = new Map<string, { mime: string; filename: string; data: string }>();
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fail = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
  let session = state === "qr" ? "SCAN_QR_CODE" : state === "stopped" ? "STOPPED" : state === "failed" ? "FAILED" : "WORKING";
  const labels = [{ id: "1", name: "Cliente novo", color: "#64c4ff" }, { id: "2", name: "Pago", color: "#55ccb3" }, { id: "3", name: "Pendente", color: "#ffb02e" }];
  const features = (() => {
    const not = (...e: string[]) => !e.includes(engine), only = (...e: string[]) => e.includes(engine);
    return { media: true, voice: true, poll: true, pollVote: only("WEBJS", "GOWS"), location: true, contact: true, react: true, edit: true, deleteForEveryone: true, forward: not("GOWS"), star: not("GOWS"), pinMessage: only("WEBJS", "NOWEB"),
      archive: not("GOWS"), deleteChat: only("WEBJS"), clearChat: only("WEBJS"), markUnread: true, block: only("WEBJS"), about: only("WEBJS"), labels: true, status: true, channels: true, channelFollow: only("GOWS"), presence: true, calls: true, groups: true, pairingCode: true, screenshot: only("WEBJS") };
  })();
  const group = { chatId: GROUP, subject: "Equipe Zoe · Produção", description: "Pedidos, produção e expedição. Só assuntos do dia a dia.", owner: RAFAEL, createdAt: at(400, 10, 0), size: 5, iAmAdmin: true, announce: false, restrict: false, avatar: 2,
    participants: [{ id: "me", name: "You", phone: "5534988880000", role: "admin", isMe: true }, { id: RAFAEL, name: "Rafael Souza", phone: "5511911112222", role: "superadmin", isMe: false }, { id: BIA, name: "Bia Nogueira", phone: "5511933334444", role: "admin", isMe: false }, { id: "5511955556666@c.us", name: "", phone: "5511955556666", role: "member", isMe: false }, { id: "5511977778888@c.us", name: "", phone: "5511977778888", role: "member", isMe: false }] };

  async function fetch(pathAndQuery: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const [path, qs] = pathAndQuery.split("?"), query = new URLSearchParams(qs ?? ""), method = init?.method ?? "GET";
    const body = (init?.body ?? {}) as Record<string, any>;
    calls.push({ path: pathAndQuery, method, body: init?.body });
    await sleep(10);
    const ok = { ok: true };
    switch (path) {
      case "/status": return state === "unconfigured" ? { configured: false, missingSettings: ["baseUrl"], missingSecrets: ["WAHA_API_KEY"], session: "default" } : { configured: true, missingSettings: [], missingSecrets: [], session: "default", engine, features, me: { name: "Victor", phone: "5534988880000" } };
      case "/session": return { status: session, engine, me: session === "WORKING" ? { name: "Victor", phone: "5534988880000" } : null, webhook: { configured: true, events: ["message.any"], missingEvents: state === "webhook" ? ["message.ack", "message.reaction"] : [] } };
      case "/session/qr": if (session !== "SCAN_QR_CODE") throw fail(409, "not_scanning", "Not waiting for a scan."); return { value: "2@Zl3fakeQRvalueForTheHarness1234567890abcdefghijklmnopqrstuvwxyz,AbCdEfGh1234567890==,ZyXwVu9876543210==,QwErTy==" };
      case "/session/pair-code": await sleep(200); return { code: "K7QM-2XWP" };
      case "/session/start": case "/session/restart": session = "SCAN_QR_CODE"; emit("session", { status: session }); return { status: session };
      case "/session/stop": session = "STOPPED"; emit("session", { status: session }); return { status: session };
      case "/session/logout": session = "SCAN_QR_CODE"; emit("session", { status: session }); return { status: session };
      case "/phone": return { phone: "+5534988880000", formatted: "+55 (34) 98888-0000" };
      case "/chats": {
        if (state === "loading") await new Promise(() => undefined);
        if (state === "error") throw new Error("WAHA did not answer. Check that your instance is running.");
        if (state === "empty") return { chats: [], archivedCount: 0, me: null };
        return { chats: chats(query.get("archived") === "1"), archivedCount: chats(true).length, me: { name: "Victor", phone: "5534988880000" } };
      }
      case "/messages": {
        const id = query.get("chatId") ?? "", q = (query.get("q") ?? "").toLowerCase(), before = query.get("before"), limit = Number(query.get("limit") ?? 50);
        let list = log(id).filter((m) => (!q || m.body.toLowerCase().includes(q)) && (!before || m.sentAt < before));
        const more = list.length > limit; list = list.slice(-limit);
        return { messages: list.map((m) => ({ ...m })), more };
      }
      case "/read": { const s = state_.get(body.chatId); if (s) { s.unread = 0; s.markedUnread = false; } return ok; }
      case "/send": {
        await sleep(250);
        const id = body.chatId ?? "";
        const original = body.replyTo ? log(id).find((x) => x.id === body.replyTo) : undefined;
        if (body.replyTo && !original) throw fail(400, "invalid_reply", "replyTo is not a message of this chat");
        if (String(body.text).includes("#fail")) throw fail(502, "waha_unavailable", "WAHA could not do that.");
        const m = msg(true, body.text ?? "", new Date().toISOString(), { replyTo: original ? quote(original) : null, ack: 1, ...(body.mentions ? { mentions: body.mentions } : {}) });
        log(id).push(m);
        // The ticks move like on the phone.
        setTimeout(() => { m.ack = 2; emit("message", { chatId: id, ack: true }); }, 700);
        setTimeout(() => { m.ack = 3; emit("message", { chatId: id, ack: true }); }, 1500);
        return { status: "sent", id: m.id };
      }
      case "/send-media": {
        await sleep(350);
        const type = body.kind === "voice" ? "ptt" : body.kind;
        const m = msg(true, body.caption ?? "", new Date().toISOString(), { type, ack: 1, media: media(String(body.mime).split(";")[0], body.kind === "voice" ? "" : body.filename ?? "", { size: Math.floor(String(body.data).length * 0.75), duration: body.duration ?? null }), replyTo: body.replyTo ? quote(log(body.chatId).find((x) => x.id === body.replyTo)!) : null });
        uploads.set(m.id, { mime: String(body.mime).split(";")[0], filename: body.filename ?? "", data: body.data });
        log(body.chatId).push(m);
        return { status: "sent", id: m.id };
      }
      case "/send-location": { const m = msg(true, "", new Date().toISOString(), { type: "location", ack: 1, location: { lat: body.latitude, lng: body.longitude, name: body.title ?? "", address: "" } }); log(body.chatId).push(m); return { status: "sent", id: m.id }; }
      case "/send-contact": { const m = msg(true, "", new Date().toISOString(), { type: "vcard", ack: 1, vcards: (body.contacts ?? []).map((c: any) => ({ name: c.name, phones: [String(c.phone).replace(/\D/g, "")], formatted: ["+" + String(c.phone).replace(/\D/g, "")] })) }); log(body.chatId).push(m); return { status: "sent", id: m.id }; }
      case "/send-poll": { const m = msg(true, "", new Date().toISOString(), { type: "poll", ack: 1, poll: { name: body.name, multiple: body.multiple === true, voters: 0, options: (body.options ?? []).map((name: string) => ({ name, votes: 0, voted: false })) } }); log(body.chatId).push(m); return { status: "sent", id: m.id }; }
      case "/poll-vote": {
        if (!features.pollVote) throw fail(501, "unsupported", "This WAHA engine does not support that.");
        const hit = find(body.messageId); const p = hit?.m.poll as any;
        if (p) { for (const o of p.options) { const want = (body.options ?? []).includes(o.name); if (want && !o.voted) o.votes++; if (!want && o.voted) o.votes--; o.voted = want; } p.voters = Math.max(p.voters, 1); }
        return ok;
      }
      case "/react": {
        const hit = find(body.messageId); if (!hit) throw fail(404, "unknown_message", "That message is not in the inbox.");
        let r = (hit.m.reactions as any[]).map((x) => (x.mine ? { ...x, mine: false, count: x.count - 1 } : x)).filter((x) => x.count > 0);
        if (body.emoji) { const e = r.find((x) => x.emoji === body.emoji); if (e) { e.count++; e.mine = true; } else r = [...r, { emoji: body.emoji, count: 1, mine: true, senders: [] }]; }
        hit.m.reactions = r; return ok;
      }
      case "/edit": { const hit = find(body.messageId); if (hit) { hit.m.body = body.text; hit.m.edited = true; } return ok; }
      case "/delete": { const hit = find(body.messageId); if (hit) { if (body.forEveryone) { hit.m.deleted = true; hit.m.type = "deleted"; hit.m.body = ""; hit.m.media = null; hit.m.hasMedia = false; } else hit.list.splice(hit.list.indexOf(hit.m), 1); } return ok; }
      case "/star": { if (!features.star) throw fail(501, "unsupported", "This WAHA engine does not support that."); const hit = find(body.messageId); if (hit) hit.m.starred = body.star !== false; return ok; }
      case "/pin": { if (!features.pinMessage) throw fail(501, "unsupported", "This WAHA engine does not support that."); const hit = find(body.messageId); if (hit) hit.m.pinned = body.pin !== false; return ok; }
      case "/forward": { const hit = find(body.messageId); for (const to of body.to ?? []) if (hit) log(to).push({ ...hit.m, id: `true_x_M${++seq}`, fromMe: true, sender: "me", senderName: "", sentAt: new Date().toISOString(), forwarded: true, reactions: [], ack: 1 }); return { ok: true, sent: (body.to ?? []).length }; }
      case "/message-info": { const hit = find(query.get("id") ?? ""); if (!hit) throw fail(404, "unknown_message", "That message is not in the inbox."); return { id: hit.m.id, fromMe: hit.m.fromMe, sentAt: hit.m.sentAt, ack: hit.m.ack, edited: hit.m.edited, starred: hit.m.starred, pinned: hit.m.pinned, type: hit.m.type, reactions: (hit.m.reactions as any[]).flatMap((r) => [...(r.mine ? [{ emoji: r.emoji, fromMe: true, name: "", phone: null, at: hit.m.sentAt }] : []), ...r.senders.map((s: string) => ({ emoji: r.emoji, fromMe: false, name: s === RAFAEL ? "Rafael Souza" : s === BIA ? "Bia Nogueira" : "Marina Costa", phone: s.split("@")[0], at: hit.m.sentAt }))]) }; }
      case "/media": {
        const id = query.get("id") ?? "", hit = find(id), up = uploads.get(id);
        await sleep(120);
        if (up) return { mime: up.mime, filename: up.filename, size: Math.floor(up.data.length * 0.75), data: up.data };
        const md = hit?.m.media as any;
        if (!hit || !md) throw fail(404, "no_media", "That message has no file.");
        if (!md.available) throw fail(404, "media_unavailable", "This file is no longer available from WAHA. Open WhatsApp on your phone to see it.");
        const n = Number(id.replace(/\D/g, "")) || 1;
        if (md.mime.startsWith("image/")) { const data = picture(n, md.width ?? 640, md.height ?? 480, hit.m.type === "sticker" ? "😎" : ""); return { mime: "image/jpeg", filename: md.filename, size: Math.floor(data.length * 0.75), data }; }
        if (md.mime.startsWith("audio/")) { const data = tone(md.duration ?? 3); return { mime: "audio/wav", filename: md.filename, size: Math.floor(data.length * 0.75), data }; }
        return { mime: md.mime, filename: md.filename, size: PDF.length, data: PDF };
      }
      case "/avatar": { const c = base.find((x) => x.chatId === query.get("chatId")); return { data: c?.avatar ? face(Number(c.avatar), (c.name ?? "?")[0]) : null }; }
      case "/typing": return ok;
      case "/link": { const s = state_.get(body.chatId); if (s) s.hidden = true; log(body.withChatId).push(...log(body.chatId)); emit("chats", {}); return { ok: true, chatId: body.withChatId }; }
      // ---- chats ----
      case "/chat/archive": state_.get(body.chatId)!.archived = body.archived !== false; return ok;
      case "/chat/pin": state_.get(body.chatId)!.pinned = body.pinned !== false; return ok;
      case "/chat/mute": state_.get(body.chatId)!.muted = Boolean(body.until); return ok;
      case "/chat/unread": state_.get(body.chatId)!.markedUnread = true; return ok;
      case "/chat/delete": state_.get(body.chatId)!.hidden = true; return ok;
      case "/chat/clear": log(body.chatId).length = 0; return ok;
      // ---- contacts and groups ----
      case "/contacts": { const q = (query.get("q") ?? "").toLowerCase(); return { contacts: base.filter((c) => c.kind === "user" && c.name && (!q || c.name.toLowerCase().includes(q) || (c.phone ?? "").includes(q))).map((c) => ({ chatId: c.chatId, name: c.name, phone: c.phone, isMyContact: true, avatar: c.avatar ?? null })) }; }
      case "/contacts/check": { const digits = String(body.phone ?? "").replace(/\D/g, ""); await sleep(200); if (digits.endsWith("0000")) return { exists: false, chatId: null, phone: digits }; return { exists: true, chatId: digits + "@c.us", phone: digits }; }
      case "/contact": { const c = base.find((x) => x.chatId === query.get("chatId")); return { chatId: c?.chatId ?? query.get("chatId"), name: c?.name ?? "", pushName: c?.name?.split(" ")[0] ?? "", phone: c?.phone ?? null, about: c?.name ? "Disponível 🌿" : "", blocked: false, isBusiness: false, isSelf: c?.isSelf === true, avatar: c?.avatar ?? null, aliases: c?.isSelf ? 3 : 1, commonGroups: [] }; }
      case "/contact/block": case "/contact/refresh-picture": case "/contact/save": return ok;
      case "/group": return { ...group, chatId: query.get("chatId") ?? GROUP };
      case "/group/create": { const chatId = "120363047777777777@g.us"; base.push({ chatId, kind: "group", name: body.name, phone: null, unread: 0 }); state_.set(chatId, { unread: 0, archived: false, pinned: false, muted: false, markedUnread: false, hidden: false }); return { chatId }; }
      case "/group/participants": { if (body.action === "remove") group.participants = group.participants.filter((p) => !(body.participants ?? []).includes(p.id)); if (body.action === "promote" || body.action === "demote") for (const p of group.participants) if ((body.participants ?? []).includes(p.id)) p.role = body.action === "promote" ? "admin" : "member"; return ok; }
      case "/group/subject": group.subject = body.subject; return ok;
      case "/group/description": group.description = body.description; return ok;
      case "/group/invite": return { link: "https://chat.whatsapp.com/HarnessInviteCode123" };
      case "/group/invite/revoke": return { link: "https://chat.whatsapp.com/NewInviteCode456" };
      case "/group/leave": case "/group/settings": return ok;
      // ---- labels, status, channels, calls, presence ----
      case "/labels": return method === "GET" ? { labels, supported: true } : ok;
      case "/labels/chat": return method === "GET" ? { labels: query.get("chatId") === MARINA ? ["1"] : [] } : ok;
      case "/labels/update": case "/labels/delete": return ok;
      case "/status/list": return [
        { poster: { chatId: MARINA, name: "Marina Costa", phone: "5511987654321", avatar: 1, isMe: false }, items: [{ id: "s1", type: "image", body: "Nova coleção 🌸", media: { mime: "image/jpeg", available: true }, sentAt: ago(2 * HOUR) }, { id: "s2", type: "text", body: "Promoção só hoje!", background: "#0d8b78", media: null, sentAt: ago(HOUR) }] },
        { poster: { chatId: "5531988887777@c.us", name: "Papelaria Aurora", phone: "5531988887777", avatar: 4, isMe: false }, items: [{ id: "s3", type: "image", body: "", media: { mime: "image/jpeg", available: true }, sentAt: ago(6 * HOUR) }] }];
      case "/status/media": { const data = picture(Number((query.get("id") ?? "s1").replace(/\D/g, "")) + 7, 540, 960); return { mime: "image/jpeg", data }; }
      case "/status/text": case "/status/image": case "/status/video": case "/status/voice": case "/status/delete": return ok;
      case "/channels": return { channels: [{ id: "120363111111111111@newsletter", name: "Floq Updates", description: "Release notes and tips", picture: null, verified: true, role: "SUBSCRIBER", subscribers: 12840 }, { id: "120363222222222222@newsletter", name: "Design Diário", description: "Uma referência por dia", picture: null, verified: false, role: "SUBSCRIBER" }] };
      case "/channel/messages": return { id: query.get("id"), messages: [msg(false, "v1.0.46 is out: one-click plugin updates.", ago(DAY)), msg(false, "Tip: drag a file onto a chat to send it.", ago(3 * HOUR))], more: false };
      case "/channels/search": return { channels: [] };
      case "/channel/follow": return ok;
      case "/calls": return { calls: [] };
      case "/call/reject": return ok;
      case "/presence": { const id = query.get("chatId"); return { chatId: id, state: id === MARINA ? "online" : "unknown", lastSeen: id === LONG ? ago(3 * HOUR) : null }; }
      case "/presence/me": return ok;
    }
    throw fail(404, "not_found", "No such route: " + path);
  }

  return {
    fetch, calls,
    /** Simulates an incoming message event from the plugin runtime. */
    incoming(chatId: string, body: string, sender = chatId, senderName = "", extra: Partial<Msg> = {}) {
      log(chatId).push(msg(false, body, new Date().toISOString(), { sender, senderName, ...extra }));
      const s = state_.get(chatId); if (s) s.unread++;
      emit("message", { chatId, fromMe: false });
    },
    emit,
    setSession(status: string) { session = status; emit("session", { status }); },
    call(video = false) { emit("call", { id: "call-1", chatId: MARINA, name: "Marina Costa", video, status: "ringing" }); },
    presence(chatId: string, state: string) { emit("presence", { chatId, state, lastSeen: null }); },
  };
}
