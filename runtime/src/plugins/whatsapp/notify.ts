// WhatsApp in Floq's island: an incoming message becomes a host notification (sender, account, group, preview, avatar) with Reply, Mark read and
// Open chat. Rules: nothing for a muted chat, for the chat the user is reading right now, for the user's own chat, or for an account whose
// notifications are switched off. On a Floq without ctx.notify the old toast is shown instead.
import type { Core } from "./core.js";
import type { Identity } from "./identity.js";
import type { Store } from "./messages.js";
import type { Inbox } from "./inbox.js";
import type { Parsed } from "./parse.js";
import { isGroup } from "./ids.js";

/** How long a "this chat is on screen" report from the UI counts. The UI repeats it every 20 s while the chat is visible. */
export const FOCUS_TTL_MS = 45_000;
/** The host takes inline avatars up to 32 KiB of data URL; base64 adds a third. */
export const AVATAR_MAX_BYTES = 22 * 1024;
const ACTION_ROUTE = "/notify/action";
const AUDIO_ROUTE = "/notify/audio";
/** Waits before the 2nd, 3rd and 4th try of a voice note WhatsApp could not hand over yet: the first press of Play gets the file. */
export const AUDIO_RETRY_MS = [350, 900, 2000];
/** The host serves audio up to 32 MiB; a longer recording opens in the chat instead. */
const AUDIO_MAX_BYTES = 30 * 1024 * 1024;
const isAudio = (m: Parsed) => (m.type === "ptt" || m.type === "audio") && !!m.media && !m.media.error && !(m.media.size && m.media.size > AUDIO_MAX_BYTES);

interface HostNotify {
  notify?: (userId: string, note: Record<string, unknown>) => Promise<{ id: string }>;
  notifications?: { clear(userId: string, tag: string): Promise<void> };
}
export interface NotifyMessage { chatId: string; m: Parsed; who: string; group: string }
export interface Notifier {
  /** True when this Floq has notifications with actions (ctx.notify). */
  supported(): boolean;
  /** What an incoming message is called in a preview when it has no text. */
  preview(m: Parsed): string;
  /** Decides and sends. "sent", or why not: "off" | "open" | "self" | "unsupported" | "failed". The caller already left out muted chats. */
  message(scope: string, n: NotifyMessage): Promise<"sent" | "off" | "open" | "self" | "unsupported" | "failed">;
  /** The chat was read or answered (here, on the phone, in the island): its notification goes away. */
  read(scope: string, chatId: string): void;
  /** The UI reports which chat is on screen (null: none, or the window is hidden). */
  focus(scope: string, chatId: string | null): void;
  enabled(scope: string): Promise<boolean>;
  setEnabled(scope: string, on: boolean): Promise<void>;
}

export function previewOf(m: Parsed): string {
  const text = m.body.replace(/\s+/g, " ").trim().slice(0, 300);
  const kind = m.type === "image" ? (m.media?.gif ? "GIF" : "Photo") : m.type === "video" ? (m.media?.gif ? "GIF" : "Video") : m.type === "ptt" ? "Voice message" : m.type === "audio" ? "Audio"
    : m.type === "document" ? (m.media?.filename ? `Document: ${m.media.filename}` : "Document") : m.type === "sticker" ? "Sticker" : m.type === "location" ? (m.extra.location?.live ? "Live location" : "Location")
    : m.type === "vcard" ? ((m.extra.vcards?.length ?? 0) > 1 ? "Contacts" : m.extra.vcards?.[0]?.name ? `Contact: ${m.extra.vcards[0].name}` : "Contact") : m.type === "poll" ? (m.extra.poll?.name ? `Poll: ${m.extra.poll.name}` : "Poll")
    : m.type === "call" ? (m.extra.call?.video ? "Video call" : "Voice call") : m.hasMedia ? "File" : "";
  return kind && text ? `${kind}: ${text}` : kind || text || "New message";
}

const notifiers = new WeakMap<Core, Notifier>();
/** One notifier per plugin instance (the message handler and the routes share its state). */
export function notifierOf(core: Core, identity: Identity): Notifier {
  const made = notifiers.get(core);
  if (made) return made;
  const host = core.host as unknown as HostNotify;
  const focused = new Map<string, { chatId: string; at: number }>();
  /** Tags with a notification that may still be on screen: reads of other chats cost nothing. */
  const live = new Set<string>();
  const tagOf = (scope: string, chatId: string) => `${core.split(scope).session}:${chatId}`;
  const n: Notifier = {
    supported: () => typeof host.notify === "function",
    preview: previewOf,
    async enabled(scope) { return (await core.ctx.kv.get(scope, "notify")) !== false; },
    async setEnabled(scope, on) { await core.ctx.kv.set(scope, "notify", on); },
    focus(scope, chatId) { if (chatId) focused.set(scope, { chatId, at: Date.now() }); else focused.delete(scope); },
    read(scope, chatId) {
      const tag = tagOf(scope, chatId);
      if (!live.delete(tag) || !host.notifications) return;
      core.bg(host.notifications.clear(core.split(scope).owner, tag));
    },
    async message(scope, { chatId, m, who, group }) {
      if (!n.supported()) return "unsupported";
      if (!(await n.enabled(scope))) return "off";
      const f = focused.get(scope);
      if (f && f.chatId === chatId && Date.now() - f.at < FOCUS_TTL_MS) return "open";
      if ((await identity.selfIds(scope)).has(chatId)) return "self";
      const { owner, session } = core.split(scope);
      const account = core.accountTag(scope);
      let avatar: string | undefined;
      try {
        // In a group the picture is the group's: that is the conversation the reply goes to.
        const a = await identity.avatar(scope, chatId);
        if (a && a.bytes.length <= AVATAR_MAX_BYTES && /^image\/(png|jpeg|webp|gif)$/.test(a.mime)) avatar = `data:${a.mime};base64,${Buffer.from(a.bytes).toString("base64")}`;
      } catch { /* no picture: the island shows initials */ }
      const tag = tagOf(scope, chatId);
      // A voice note or an audio file plays from the island: the card gets a player and the host fetches the file through AUDIO_ROUTE.
      const audio = isAudio(m) && m.msgId ? { route: AUDIO_ROUTE, played: true, ...(m.media!.duration && m.media!.duration > 0 ? { duration: m.media!.duration } : {}) } : undefined;
      try {
        await host.notify!(owner, {
          kind: "message", title: who || group || "New message", body: previewOf(m), subtitle: [account, who ? group : ""].filter(Boolean).join(" · ") || undefined, avatar, tag,
          actions: [{ id: "reply", label: "Reply", input: { placeholder: isGroup(chatId) && group ? `Message ${group}`.slice(0, 80) : "Message" } }, { id: "read", label: "Mark read" }],
          actionRoute: ACTION_ROUTE, data: { session, chatId, ...(audio ? { msgId: m.msgId } : {}) }, ...(audio ? { audio } : {}), target: { view: "inbox", params: { chat: chatId, session } },
        });
        live.add(tag);
        return "sent";
      } catch (error) {
        core.ctx.log.warn("notification failed", { error: error instanceof Error ? error.message : "error" });
        return "failed";
      }
    },
  };
  notifiers.set(core, n);
  return n;
}

export function registerNotify({ core, identity, store, inbox }: { core: Core; identity: Identity; store: Store; inbox: Inbox }): void {
  const { ctx } = core;
  const R = ctx.routes;
  const notifier = notifierOf(core, identity);

  // The host calls this when the user uses a button of the notification. The session and chat come from what this plugin stored with the
  // notification (the host hands it back; the app never sends it), and the scoped route already made sure the caller is the owner.
  R.post(ACTION_ROUTE, async ({ userId, body }) => {
    const o = core.obj(body), data = core.obj(o.data);
    const scope = await core.scope(core.split(userId).owner, typeof data.session === "string" ? data.session : "");
    const chatId = core.chatId(data.chatId);
    if (o.actionId === "reply") {
      const sent = await inbox.sendText(scope, chatId, core.text(o.input));
      seen(scope, chatId);
      return { ok: true, id: sent.id };
    }
    if (o.actionId === "read") {
      await store.markRead(scope, chatId);
      seen(scope, chatId);
      core.publish(scope, "chats", {});
      return { ok: true };
    }
    throw ctx.httpError(400, "invalid_action", "Unknown action");
  });
  // The host calls this for the audio of a notification (the island's player): "fetch" hands over the file, "played" tells WhatsApp the user
  // listened. The file is the cached copy when there is one (media is cached as it arrives); otherwise it is downloaded now, and a passing
  // failure (WhatsApp still fetching it, WAHA busy) is tried again here so the first press of Play is enough.
  R.post(AUDIO_ROUTE, async ({ userId, body }) => {
    const o = core.obj(body), data = core.obj(o.data);
    const scope = await core.scope(core.split(userId).owner, typeof data.session === "string" ? data.session : "");
    const msgId = typeof data.msgId === "string" ? data.msgId : "";
    if (!msgId) throw ctx.httpError(404, "no_media", "That message has no file.");
    if (o.audio === "played") {
      // Only this message is acknowledged (the blue microphone); the chat stays unread here until the user reads or answers it.
      const chatId = core.chatId(data.chatId);
      core.bg(store.route(scope, chatId).then(([target]) => core.tryWaha(scope, "POST", "/api/sendSeen", { body: { chatId: target, messageIds: [msgId] } })));
      return { ok: true };
    }
    if (o.audio !== "fetch") throw ctx.httpError(400, "invalid_audio", "Unknown audio request");
    for (let n = 0; ; n++) {
      try {
        const f = await store.mediaBytes(scope, msgId);
        if (f.bytes.length > AUDIO_MAX_BYTES) throw ctx.httpError(413, "audio_too_large", "This audio is too large to play here. Open the chat to listen.");
        return { mime: /^(audio\/|application\/ogg)/i.test(f.mime) ? f.mime : "audio/ogg", data: Buffer.from(f.bytes).toString("base64") };
      } catch (e) {
        if ((e as { status?: number } | null)?.status !== 503 || n >= AUDIO_RETRY_MS.length) throw e;
        await new Promise((r) => setTimeout(r, AUDIO_RETRY_MS[n]));
      }
    }
  });
  /** Blue ticks for the other side, like opening the chat on the phone. Best effort. */
  const seen = (scope: string, chatId: string) => core.bg(store.route(scope, chatId).then(([target]) => core.tryWaha(scope, "POST", "/api/sendSeen", { body: { chatId: target } })));

  R.post("/notify/focus", async ({ userId, body }) => {
    const raw = core.obj(body).chatId;
    const chatId = raw === null || raw === undefined || raw === "" ? null : await identity.canonical(userId, core.chatId(raw));
    notifier.focus(userId, chatId);
    if (chatId) notifier.read(userId, chatId);
    return { ok: true };
  });
  R.get("/notify/settings", async ({ userId }) => ({ supported: notifier.supported(), enabled: await notifier.enabled(userId) }));
  R.post("/notify/settings", async ({ userId, body }) => {
    const on = core.obj(body).enabled;
    if (typeof on !== "boolean") throw ctx.httpError(400, "invalid_enabled", "enabled must be true or false");
    await notifier.setEnabled(userId, on);
    return { supported: notifier.supported(), enabled: on };
  });

  // Answered or read somewhere else (the phone, WhatsApp Web): the notification has done its job.
  for (const name of ["message", "message.any"]) core.on(name, async (scope, e) => {
    if (e.payload.fromMe !== true) return;
    const raw = e.payload.to ?? e.payload.from ?? e.payload.chatId;
    if (typeof raw === "string" && raw) notifier.read(scope, await identity.canonical(scope, raw));
  });
  core.on("message.ack", async (scope, e) => {
    // An incoming message that this account read on another device arrives as a READ ack that is not ours to show.
    const p = e.payload;
    if (p.fromMe === true || !(Number(p.ack) >= 3 || p.ackName === "READ" || p.ackName === "PLAYED")) return;
    const raw = p.from ?? p.chatId;
    if (typeof raw === "string" && raw) notifier.read(scope, await identity.canonical(scope, raw));
  });
}
