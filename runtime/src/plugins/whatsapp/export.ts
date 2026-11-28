// Export of conversations: WhatsApp's own export format (a .txt, optionally with the media in a .zip), an optional readable transcript, and
// "export all chats" for an account. Built to stream: messages are read page by page (keyset on sent_at, id), text is produced lazily and
// zip entries are written one after the other, so a chat of any size takes a bounded amount of memory (one page, one media file at a time).
// Nothing is ever asked of WhatsApp here: a file that Floq did not keep is listed as unavailable.
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import type { Deps } from "./extras.js";
import type { PluginDownload } from "../sdk.js";
import { digitsOf, displayDigits, isGroup } from "./ids.js";
import { rec, type MediaMeta, type MessageExtra } from "./parse.js";
import { formatPhone } from "./shared/phone.js";
import { runtimeTimeZone } from "../../timezone.js";

export type TranscriptFormat = "none" | "html" | "md";
export interface ExportOptions {
  /** One chat; left out = every chat of the account. */
  chatId?: string;
  /** Name of that chat as the UI shows it (used when the stored contact has none). */
  name?: string;
  /** Put the files Floq kept in the export; without it a file is "<Media omitted>". */
  media: boolean;
  transcript: TranscriptFormat;
  /** Deleted messages show what Floq kept of them. */
  originals: boolean;
  /** BCP 47 tag the dates follow (the UI's locale) and the IANA time zone they are shown in. */
  locale?: string;
  tz?: string;
}

/** Rows per page of the keyset walk. */
export const EXPORT_PAGE = 500;
const DELETED = "<This message was deleted>";

interface Attach { name: string; label: string; mime: string; stanza: string; available: boolean; sentAt: Date }
interface Content { body: string; attach: Attach | null; extra: string[]; edited: boolean }
interface Item { at: Date; who: string; fromMe: boolean; system: boolean; content: Content; edited: boolean; deleted: boolean; original: Content | null }

/** Formats the dates of one export: the locale decides the order and separators, the time zone what clock they show. */
export function dateFormats(locale?: string, tz?: string) {
  const loc = (() => { try { return locale && Intl.DateTimeFormat.supportedLocalesOf([locale]).length ? locale : "en-GB"; } catch { return "en-GB"; } })();
  const zone = (() => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz || runtimeTimeZone(); } catch { return runtimeTimeZone(); } })();
  const day = new Intl.DateTimeFormat(loc, { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric" });
  const time = new Intl.DateTimeFormat(loc, { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const iso = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
  return {
    locale: loc, zone,
    /** "25/11/2026, 14:03:22" in the user's own style. */
    stamp: (d: Date) => plain(day.format(d)) + ", " + plain(time.format(d)),
    /** "2026-11-25-14-03-22": what goes into a media file name. */
    file: (d: Date) => { const p = Object.fromEntries(iso.formatToParts(d).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}`; },
  };
}

const LABELS: Record<string, string> = { image: "PHOTO", video: "VIDEO", audio: "AUDIO", ptt: "AUDIO", sticker: "STICKER" };
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov", "video/webm": "webm",
  "audio/ogg": "opus", "audio/opus": "opus", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav", "application/pdf": "pdf", "text/plain": "txt", "application/zip": "zip", "application/was": "was" };
const safe = (s: string) => s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
const extOf = (media: MediaMeta) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(media.filename ?? "");
  const mime = String(media.mime ?? "").split(";")[0].trim().toLowerCase();
  return (m ? m[1].toLowerCase() : EXT[mime]) || (mime.includes("/") ? safe(mime.split("/")[1]).slice(0, 8) || "bin" : "bin");
};
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

const asFlag = (v: unknown) => v === "1" || v === "true";

/** GET /export: the file itself, streamed. It is reached through the signed link (POST /v1/plugins/waha/download-link), never read into the UI. */
export function registerExport(deps: Deps): void {
  const { core } = deps;
  const exporter = createExporter(deps);
  core.ctx.routes.get("/export", async ({ userId, query }) => {
    await core.owner(userId);
    const all = asFlag(query.all);
    if (!all && !query.chatId) throw core.ctx.httpError(400, "invalid_chat", "Pick a chat to export.");
    const transcript: TranscriptFormat = query.transcript === "html" || query.transcript === "md" ? query.transcript : "none";
    return exporter.open(userId, {
      chatId: all ? undefined : core.chatId(query.chatId), name: query.name, media: asFlag(query.media), transcript, originals: asFlag(query.originals),
      locale: query.locale?.slice(0, 35), tz: query.tz?.slice(0, 64),
    });
  });
}

export interface Exporter { open(userId: string, o: ExportOptions): Promise<PluginDownload> }

export function createExporter({ core, identity, store }: Deps): Exporter {
  const { ctx } = core;
  const q = (sql: string, params: unknown[]) => ctx.db.query(sql, params);

  /** Who a message is from: the saved name, else the name WhatsApp showed, else the number. */
  const personName = (label: unknown, sender: string) => {
    const n = String(label ?? "").trim();
    if (n) return n;
    const d = digitsOf(sender);
    return d ? "+" + formatPhone(displayDigits(d)).replace(/^\+/, "") : "";
  };

  /** Page by page, oldest first. The cursor is the last row's own timestamp text (full precision) and id. */
  async function* rows(userId: string, ids: string[], signal: AbortSignal) {
    let at: string | null = null, last = 0;
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const r = await q(
        `SELECT m.id, m.sent_at::text AS sent_txt, m.sent_at, m.from_me, m.sender, m.body, m.has_media, m.type, m.media, m.extra, m.edited_at, m.deleted_at, m.lost, m.stanza,
                COALESCE(sm.pn, m.sender) AS sender_c,
                COALESCE(NULLIF(sc.name, ''), NULLIF(m.sender_name, ''), NULLIF(sc.push_name, ''), '') AS sender_label,
                EXISTS (SELECT 1 FROM {{p}}media_blobs b WHERE b.user_id = $1 AND b.session = $S AND b.key = 'm:' || m.stanza) AS cached
           FROM {{p}}messages m
           LEFT JOIN {{p}}chat_state st ON st.user_id = $1 AND st.session = $S AND st.chat_id = $5
           LEFT JOIN {{p}}lid_map sm ON sm.user_id = $1 AND sm.session = $S AND sm.lid = m.sender
           LEFT JOIN {{p}}contacts sc ON sc.user_id = $1 AND sc.session = $S AND sc.chat_id = COALESCE(sm.pn, m.sender)
          WHERE m.user_id = $1 AND m.session = $S AND m.chat_id = ANY($2::text[]) AND (st.cleared_at IS NULL OR m.sent_at > st.cleared_at)
            AND ($3::timestamptz IS NULL OR (m.sent_at, m.id) > ($3::timestamptz, $4::bigint))
          ORDER BY m.sent_at ASC, m.id ASC LIMIT $6`, [userId, ids, at, last, ids[0], EXPORT_PAGE]);
      for (const x of r.rows) yield x;
      if (r.rows.length < EXPORT_PAGE) return;
      const tail = r.rows[r.rows.length - 1];
      at = String(tail.sent_txt); last = Number(tail.id);
    }
  }

  /** The items of one chat, in order. Deterministic: every pass over the same chat (text, transcript, media) numbers the files the same way. */
  async function* items(userId: string, chatId: string, title: string, o: ExportOptions, fmt: ReturnType<typeof dateFormats>, myName: string, signal: AbortSignal): AsyncGenerator<Item> {
    const ids = await identity.aliases(userId, chatId);
    const group = isGroup(chatId);
    let n = 0;
    for await (const x of rows(userId, ids, signal)) {
      const type = String(x.type ?? "chat"), at = new Date(x.sent_at as string), deleted = Boolean(x.deleted_at), lost = x.lost === true;
      if (type === "reaction") continue;
      const media = x.media ? (rec(x.media) as unknown as MediaMeta) : null, extra = (x.extra ? rec(x.extra) : {}) as MessageExtra;
      const fromMe = x.from_me === true;
      const who = fromMe ? myName : group ? personName(x.sender_label, String(x.sender_c ?? "")) || "Unknown" : title;
      // What a message carries; a deleted one only has something when Floq kept it.
      const content = (): Content => {
        const lines: string[] = [];
        if (extra.location) lines.push(`location: https://maps.google.com/?q=${extra.location.lat},${extra.location.lng}${extra.location.name ? " (" + oneLine(extra.location.name) + ")" : ""}`);
        for (const v of extra.vcards ?? []) lines.push(`contact: ${v.name}${v.phones.length ? " " + v.phones.map((p) => "+" + p).join(", ") : ""}`);
        if (extra.poll) lines.push(`POLL:\n${extra.poll.name}${extra.poll.options.map((p) => "\nOPTION: " + p).join("")}`);
        if (extra.call) lines.push(extra.call.video ? "Video call" : "Voice call");
        let attach: Attach | null = null;
        if (media && x.has_media === true && !["location", "vcard", "poll", "call", "system"].includes(type)) {
          n++;
          const num = String(n).padStart(8, "0"), stamp = fmt.file(at);
          const label = LABELS[type];
          const name = label ? `${num}-${label}-${stamp}.${extOf(media)}` : `${num}-${safe(media.filename || "") || `DOC-${stamp}.${extOf(media)}`}`;
          attach = { name, label: label ?? "DOC", mime: String(media.mime ?? ""), stanza: String(x.stanza ?? ""), available: x.cached === true, sentAt: at };
        }
        return { body: String(x.body ?? ""), attach, extra: lines, edited: Boolean(x.edited_at) };
      };
      if (deleted) {
        // Floq never had the content of a row it made for a message that was already gone (lost).
        yield { at, who, fromMe, system: false, content: { body: "", attach: null, extra: [], edited: false }, edited: false, deleted: true, original: o.originals && !lost ? content() : null };
        continue;
      }
      if (type === "system") { if (String(x.body ?? "").trim()) yield { at, who: "", fromMe: false, system: true, content: { body: String(x.body), attach: null, extra: [], edited: false }, edited: false, deleted: false, original: null }; continue; }
      const c = content();
      if (type === "unknown" && !c.body && !c.attach && !c.extra.length) continue;
      yield { at, who, fromMe, system: false, content: c, edited: Boolean(x.edited_at), deleted: false, original: null };
    }
  }

  /** The text of a content: the file line (or "<Media omitted>"), the extras, then the text. */
  const contentText = (c: Content, o: ExportOptions) => {
    const t = [
      ...(c.attach ? [o.media ? `<attached: ${c.attach.name}>${c.attach.available ? "" : " (file not available)"}` : "<Media omitted>"] : []),
      ...c.extra, ...(c.body ? [c.body] : []),
    ].join("\n");
    return c.edited ? (t ? t + " <edited>" : "<edited>") : t;
  };
  const itemText = (it: Item, o: ExportOptions) => {
    if (it.deleted) { const orig = it.original ? contentText(it.original, o) : ""; return DELETED + (orig ? ` (original: ${orig})` : ""); }
    return contentText(it.content, o);
  };

  async function* txt(userId: string, chatId: string, title: string, o: ExportOptions, fmt: ReturnType<typeof dateFormats>, myName: string, signal: AbortSignal): AsyncGenerator<string> {
    let first = true;
    for await (const it of items(userId, chatId, title, o, fmt, myName, signal)) {
      const body = itemText(it, o);
      yield (first ? "" : "\n") + `[${fmt.stamp(it.at)}] ${it.system ? "" : it.who + ": "}${body}`;
      first = false;
    }
    if (!first) yield "\n";
  }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const mdEsc = (s: string) => s.replace(/([\\*_`<>])/g, "\\$1");
  async function* transcript(kind: "html" | "md", userId: string, chatId: string, title: string, o: ExportOptions, fmt: ReturnType<typeof dateFormats>, myName: string, signal: AbortSignal): AsyncGenerator<string> {
    const html = kind === "html";
    if (html) {
      yield `<!doctype html><html lang="${esc(fmt.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#efeae2;--in:#fff;--out:#d9fdd3;--ink:#111b21;--mute:#667781}@media(prefers-color-scheme:dark){:root{--bg:#0b141a;--in:#202c33;--out:#005c4b;--ink:#e9edef;--mute:#8696a0}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:16px}h1{font-size:18px;margin:8px 0 16px}
.m{max-width:80%;margin:4px 0;padding:6px 10px;border-radius:10px;background:var(--in);width:fit-content;white-space:pre-wrap;word-break:break-word}.m.me{margin-left:auto;background:var(--out)}.m b{display:block;font-size:12px;color:var(--mute)}.m time{display:block;font-size:11px;color:var(--mute);text-align:right}
.s{margin:10px auto;text-align:center;font-size:12px;color:var(--mute)}.x{font-style:italic;color:var(--mute)}.m img,.m video{max-width:100%;border-radius:6px;display:block}.m .orig{margin-top:4px;padding-left:8px;border-left:3px solid var(--mute)}
</style></head><body><main><h1>${esc(title)}</h1>\n`;
    } else yield `# ${mdEsc(title)}\n\n`;
    const show = (c: Content) => {
      const parts: string[] = [];
      if (c.attach) {
        const a = c.attach;
        if (!o.media) parts.push(html ? '<span class="x">Media omitted</span>' : "_Media omitted_");
        else if (!a.available) parts.push(html ? `<span class="x">${esc(a.name)} (file not available)</span>` : `_${mdEsc(a.name)} (file not available)_`);
        else if (html) {
          const src = encodeURI(a.name);
          parts.push(a.mime.startsWith("image/") ? `<a href="${src}"><img src="${src}" alt="${esc(a.name)}"></a>` : a.mime.startsWith("video/") ? `<video controls src="${src}"></video>` : a.mime.startsWith("audio/") ? `<audio controls src="${src}"></audio>` : `<a href="${src}">${esc(a.name)}</a>`);
        } else parts.push(a.mime.startsWith("image/") ? `![${mdEsc(a.name)}](${encodeURI(a.name)})` : `[${mdEsc(a.name)}](${encodeURI(a.name)})`);
      }
      for (const e of c.extra) parts.push(html ? esc(e) : mdEsc(e));
      if (c.body) parts.push(html ? esc(c.body) : mdEsc(c.body));
      return parts.join(html ? "\n" : "\n\n");
    };
    for await (const it of items(userId, chatId, title, o, fmt, myName, signal)) {
      const when = fmt.stamp(it.at);
      let body: string;
      if (it.deleted) body = (html ? `<span class="x">${esc(DELETED)}</span>` : `_${mdEsc(DELETED)}_`) + (it.original ? (html ? `<div class="orig">${show(it.original)}</div>` : `\n\n> ${show(it.original).replace(/\n/g, "\n> ")}`) : "");
      else body = show(it.content) + (it.edited ? (html ? ' <span class="x">(edited)</span>' : " _(edited)_") : "");
      if (html) yield it.system ? `<div class="s">${esc(it.content.body)} · ${esc(when)}</div>\n` : `<div class="m${it.fromMe ? " me" : ""}"><b>${esc(it.who)}</b>${body}<time>${esc(when)}</time></div>\n`;
      else yield it.system ? `*${mdEsc(it.content.body)}* · ${when}\n\n` : `**${mdEsc(it.who)}** · ${when}\n\n${body}\n\n`;
    }
    if (html) yield "</main></body></html>\n";
  }

  /** Resolves when the zip has taken in the whole entry (the next one is only made then). */
  function addEntry(zip: ZipFile, name: string, stream: Readable, opts: { mtime: Date; store?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.once("end", resolve); stream.once("close", resolve); stream.once("error", reject);
      zip.addReadStream(stream, name, { mtime: opts.mtime, compress: !opts.store });
    });
  }
  const text = (gen: AsyncGenerator<string>) => Readable.from(gen, { objectMode: false });

  async function mediaFile(userId: string, stanza: string): Promise<Buffer | null> {
    const hit = (await q(`SELECT bytes FROM {{p}}media_blobs WHERE user_id = $1 AND session = $S AND key = $2`, [userId, "m:" + stanza])).rows[0];
    return hit ? Buffer.from(hit.bytes as Uint8Array) : null;
  }

  /** One chat into a zip, under `dir` ("" or "Name/"): the text file, the transcript, then the files (a second walk, so no list of files is kept). */
  async function zipChat(zip: ZipFile, dir: string, userId: string, chatId: string, title: string, o: ExportOptions, fmt: ReturnType<typeof dateFormats>, myName: string, signal: AbortSignal) {
    const now = new Date();
    await addEntry(zip, dir + "_chat.txt", text(txt(userId, chatId, title, o, fmt, myName, signal)), { mtime: now });
    if (o.transcript !== "none") await addEntry(zip, dir + (o.transcript === "html" ? "chat.html" : "chat.md"), text(transcript(o.transcript, userId, chatId, title, o, fmt, myName, signal)), { mtime: now });
    if (!o.media) return;
    for await (const it of items(userId, chatId, title, o, fmt, myName, signal)) {
      const a = (it.deleted ? it.original?.attach : it.content.attach) ?? null;
      if (!a || !a.available) continue;
      const bytes = await mediaFile(userId, a.stanza);
      if (bytes) await addEntry(zip, dir + a.name, Readable.from([bytes], { objectMode: false }), { mtime: a.sentAt, store: a.label !== "DOC" });
    }
  }

  return {
    async open(userId, o) {
      const fmt = dateFormats(o.locale, o.tz);
      const me = await identity.me(userId);
      const myName = me?.name || (me?.id ? "+" + displayDigits(me.id.split("@")[0]) : "You");
      const zipped = !o.chatId || o.media || o.transcript !== "none";
      if (o.chatId) {
        const chatId = await identity.canonical(userId, o.chatId);
        const title = (o.name ?? "").trim().slice(0, 100) || (isGroup(chatId) ? "Group chat" : digitsOf(chatId) ? "+" + displayDigits(digitsOf(chatId)!) : "Chat");
        const base = `WhatsApp Chat - ${safe(title) || "chat"}`;
        if (!zipped) return { floqDownload: true, filename: base + ".txt", contentType: "text/plain; charset=utf-8", write: (out, signal) => pipeline(text(txt(userId, chatId, title, o, fmt, myName, signal)), out, { signal }) };
        return { floqDownload: true, filename: base + ".zip", contentType: "application/zip", write: (out, signal) => zipTo(out, signal, (zip) => zipChat(zip, "", userId, chatId, title, o, fmt, myName, signal)) };
      }
      return {
        floqDownload: true, filename: `WhatsApp Chats - ${safe(myName) || "account"}.zip`, contentType: "application/zip",
        write: (out, signal) => zipTo(out, signal, async (zip) => {
          const listed = [...(await store.listChats(userId, {})).chats, ...(await store.listChats(userId, { archived: true })).chats] as Array<{ chatId: string; name: string | null; phone: string | null }>;
          const used = new Set<string>();
          for (const c of listed) {
            if (signal.aborted) return;
            const title = c.name || (c.phone ? "+" + c.phone : isGroup(c.chatId) ? "Group chat" : c.chatId);
            let folder = safe(title) || "chat", i = 1;
            while (used.has(folder.toLowerCase())) folder = `${safe(title) || "chat"} (${++i})`;
            used.add(folder.toLowerCase());
            await zipChat(zip, folder + "/", userId, c.chatId, title, o, fmt, myName, signal);
          }
          if (!listed.length) await addEntry(zip, "README.txt", Readable.from(["There are no chats to export.\n"], { objectMode: false }), { mtime: new Date() });
        }),
      };
    },
  };

  /** Runs `fill` while the zip streams to `out`; a stopped download (signal) tears everything down. */
  async function zipTo(out: Writable, signal: AbortSignal, fill: (zip: ZipFile) => Promise<void>): Promise<void> {
    const zip = new ZipFile();
    const piping = pipeline(zip.outputStream as Readable, out, { signal });
    piping.catch(() => undefined);
    try { await fill(zip); zip.end(); } catch (error) { (zip.outputStream as Readable).destroy(); await piping.catch(() => undefined); throw error; }
    await piping;
  }
}
