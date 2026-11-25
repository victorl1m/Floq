// The message store: rows from webhooks and from WAHA's own history, folded per canonical chat; the chat list and the conversation the UI and agents read.
import { pgJson } from "./pgsafe.js";
import type { Core, WebhookEvent } from "./core.js";
import { notifierOf } from "./notify.js";
import type { Identity } from "./identity.js";
import { CHAT_ID, digitsOf, displayDigits, isGroup, isUser, kindOf, lidOf, normId, pnOf, stanzaOf } from "./ids.js";
import { MESSAGE_EVENTS, parseMessage, rec, type MediaMeta, type MessageExtra, type Parsed } from "./parse.js";
import { formatPhone } from "./shared/phone.js";
import { ackOf, applyAck } from "./acks.js";

/** WAHA's chat list is re-read at most this often. */
export const CHATS_SYNC_EVERY_MS = 60_000;
/** A chat's history is re-read from WAHA at most this often while it is open. */
export const CHAT_SYNC_EVERY_MS = 20_000;
/** Media kept in the database: per file and in total (oldest files go first). Avatars are separate and small. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
export const MEDIA_TOTAL_BYTES = 400 * 1024 * 1024;

export interface Store {
  /**
   * Inserts or refreshes a message. Returns "new" for a row that was not there. Learns id links and contact names on the way.
   * `history`: the row comes from WAHA's stored history (the import), so it counts as received when it was sent and old messages are not unread.
   */
  save(userId: string, m: Parsed, opts?: { real?: boolean; history?: boolean }): Promise<"new" | "known" | "skipped">;
  listChats(userId: string, opts?: { archived?: boolean }): Promise<{ chats: Record<string, unknown>[]; archivedCount: number }>;
  listMessages(userId: string, chatId: string, opts?: { limit?: unknown; before?: unknown; q?: unknown; sync?: boolean }): Promise<{ messages: Record<string, unknown>[]; more: boolean }>;
  markRead(userId: string, chatId: string): Promise<void>;
  /** The stored row of a message id (any alias of its chat), or a 404. */
  row(userId: string, msgId: unknown): Promise<Record<string, unknown>>;
  /** Address to write to: where the contact last wrote from, then the canonical id, then the other aliases. */
  route(userId: string, chatId: string): Promise<string[]>;
  mediaBytes(userId: string, msgId: string): Promise<{ mime: string; filename: string; bytes: Uint8Array }>;
  putBlob(userId: string, key: string, mime: string, bytes: Uint8Array): Promise<void>;
  syncChats(userId: string, force?: boolean): Promise<boolean>;
  syncChat(userId: string, chatId: string, force?: boolean): Promise<boolean>;
  setState(userId: string, chatId: string, patch: Record<string, unknown>): Promise<void>;
  /**
   * Records an edit of a message (from WhatsApp or made here). Every edit is kept; the newest by time is the message's text, the first text stays in
   * orig_body. An edit whose message is not stored yet waits and is applied when the message arrives. A repeat (same id, or same text within two
   * minutes: Floq's own edit coming back from WAHA) is not a new version. True when the stored text changed.
   */
  edit(userId: string, op: EditOp): Promise<boolean>;
  /**
   * Marks a message deleted for everyone, keeping everything Floq has of it. A message Floq does not have yet gets a row of its own ("lost") so the
   * chat shows the deletion; its content fills in if it comes later. Never calls WhatsApp. True when the message was not deleted before.
   */
  revoke(userId: string, op: RevokeOp): Promise<boolean>;
  /** Every text a message had, oldest first (the original, then each edit), with when it was written. Empty when Floq never saw an edit's text. */
  versions(userId: string, row: Record<string, unknown>): Promise<Array<{ body: string; at: string }>>;
}
export interface EditOp { stanza: string; editId: string; body: string; at: Date; quiet?: boolean }
/** revoker: "me", the id of who deleted it, or "" when unknown. targetFromMe / targetSender: who sent the deleted message, when known. */
export interface RevokeOp { stanza: string; chatId?: string; targetFromMe: boolean | null; targetSender: string; revoker: string; at: Date; history?: boolean; quiet?: boolean }

const iso = (v: unknown) => new Date(v as string).toISOString();

export function createStore(core: Core, identity: Identity): Store {
  const { ctx } = core;
  const q = (sql: string, params: unknown[]) => ctx.db.query(sql, params);
  const CID = `COALESCE(lm.pn, m.chat_id)`;
  const MSGS = `SELECT m.*, ${CID} AS cid FROM {{p}}messages m LEFT JOIN {{p}}lid_map lm ON lm.user_id = m.user_id AND lm.session = m.session AND lm.lid = m.chat_id WHERE m.user_id = $1 AND m.session = $S`;
  // Per account (the "user id" every function gets is the account's scope).
  const chatsSyncedAt = new Map<string, number>();
  const chatSynced = new Map<string, number>();
  const caching = new Set<string>();
  /** One download per message at a time: the bubble, the lightbox and a save share it. */
  const fetching = new Map<string, Promise<{ mime: string; filename: string; bytes: Uint8Array }>>();

  async function putBlob(userId: string, key: string, mime: string, bytes: Uint8Array) {
    await q(`INSERT INTO {{p}}media_blobs (user_id, session, key, mime, bytes, size) VALUES ($1,$S,$2,$3,$4,$5) ON CONFLICT (user_id, session, key) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, size = EXCLUDED.size, created_at = now()`, [userId, key, mime, Buffer.from(bytes), bytes.length]);
    // Keep the total bounded: drop the oldest message media.
    const total = Number((await q(`SELECT COALESCE(SUM(size),0)::bigint AS n FROM {{p}}media_blobs WHERE user_id = $1 AND session = $S AND key LIKE 'm:%'`, [userId])).rows[0]?.n ?? 0);
    if (total > MEDIA_TOTAL_BYTES) {
      await q(`DELETE FROM {{p}}media_blobs WHERE user_id = $1 AND session = $S AND key IN (SELECT b.key FROM {{p}}media_blobs b WHERE b.user_id = $1 AND b.session = $S AND b.key LIKE 'm:%'
        -- the file of a deleted message is what the user can still recover: it goes last
        ORDER BY EXISTS (SELECT 1 FROM {{p}}messages d WHERE d.user_id = $1 AND d.session = $S AND d.deleted_at IS NOT NULL AND 'm:' || d.stanza = b.key), b.created_at ASC LIMIT 20)`, [userId]);
    }
  }

  /** Downloads a message's file while WAHA still has it (WAHA deletes downloaded files after a few minutes). Background, never throws. */
  function cacheMedia(userId: string, stanza: string, media: MediaMeta | null) {
    if (!media?.url || media.error || !stanza || caching.has(userId + stanza)) return;
    if (media.size && media.size > MEDIA_MAX_BYTES) return;
    caching.add(userId + stanza);
    core.bg((async () => {
      try {
        const has = await q(`SELECT 1 AS x FROM {{p}}media_blobs WHERE user_id = $1 AND session = $S AND key = $2`, [userId, "m:" + stanza]);
        if (has.rows.length) return;
        const f = await core.wahaBytes(userId, media.url!);
        if (f.bytes.length && f.bytes.length <= MEDIA_MAX_BYTES) await putBlob(userId, "m:" + stanza, media.mime || f.mime, f.bytes);
      } catch { /* shown as "not available" until WAHA can serve it again */ }
      finally { caching.delete(userId + stanza); }
    })());
  }

  const store: Store = {
    putBlob,
    async save(userId, m, opts = {}) {
      const real = opts.real !== false;
      for (const l of m.links) { await identity.seen(userId, l.pn, true); await identity.link(userId, l.lid, l.pn); }
      if (pnOf(m.chatId)) await identity.seen(userId, m.chatId, real && (!m.fromMe || m.source === "app"));
      if (m.type === "reaction" || m.reaction) {
        if (m.reaction?.target) await react(userId, m.reaction.target, m.fromMe ? "me" : m.sender, m.reaction.emoji, m.sentAt);
        return "skipped";
      }
      // A delete or an edit is applied to its message; the protocol message itself is never a row (nor unread, nor the chat's preview).
      if (m.protocol) {
        const op = m.protocol, quiet = opts.history === true;
        if (op.kind === "revoke" && op.target) {
          await store.revoke(userId, { stanza: op.target, chatId: m.chatId, targetFromMe: op.targetFromMe, targetSender: op.targetSender, revoker: m.fromMe ? "me" : m.sender, at: op.at ?? m.sentAt, history: opts.history, quiet });
        } else if (op.kind === "edit" && op.target) {
          await store.edit(userId, { stanza: op.target, editId: m.stanza || "t:" + (op.at ?? m.sentAt).getTime(), body: op.body, at: op.at ?? m.sentAt, quiet });
        }
        return "skipped";
      }
      // The same message can arrive under the contact's lid and under its phone id: that proves both are one chat.
      if (m.stanza && isUser(m.chatId)) {
        const twin = (await q(`SELECT chat_id, msg_id FROM {{p}}messages WHERE user_id = $1 AND session = $S AND stanza = $2 AND msg_id <> $3 AND from_me = $4 LIMIT 1`, [userId, m.stanza, m.msgId, m.fromMe])).rows[0];
        if (twin && isUser(String(twin.chat_id)) && String(twin.chat_id) !== m.chatId) {
          const a = String(twin.chat_id), lid = lidOf(a) ?? lidOf(m.chatId), pn = pnOf(a) ?? pnOf(m.chatId);
          if (lid && pn) await identity.link(userId, lid, pn);
          m = { ...m, msgId: String(twin.msg_id), chatId: a };
        }
      }
      // A group message is one row whatever address its id spells the sender with (lid on the webhook, phone id in the history, or none).
      if (m.stanza && isGroup(m.chatId)) {
        const twin = (await q(`SELECT msg_id FROM {{p}}messages WHERE user_id = $1 AND session = $S AND chat_id = $2 AND stanza = $3 AND msg_id <> $4 AND from_me = $5 LIMIT 1`, [userId, m.chatId, m.stanza, m.msgId, m.fromMe])).rows[0];
        if (twin) m = { ...m, msgId: String(twin.msg_id) };
      }
      // A row Floq made for a message deleted before it arrived: the message, now here, fills it in (whatever spelling its id has).
      if (m.stanza && !m.revoked) {
        const lostRow = (await q(`SELECT msg_id FROM {{p}}messages WHERE user_id = $1 AND session = $S AND stanza = $2 AND lost AND chat_id = ANY($3::text[]) LIMIT 1`, [userId, m.stanza, await identity.aliases(userId, m.chatId)])).rows[0];
        if (lostRow) m = { ...m, msgId: String(lostRow.msg_id) };
      }
      // A message we sent through the API and recorded without an id comes back on the webhook with its real id: adopt it instead of showing it twice.
      if (m.fromMe) {
        const ids = await identity.aliases(userId, m.chatId);
        const ghost = (await q(
          `SELECT id FROM {{p}}messages WHERE user_id = $1 AND session = $S AND chat_id = ANY($2::text[]) AND from_me AND msg_id LIKE 'out-%' AND body = $3 AND type = $4
             AND sent_at > $5::timestamptz - interval '3 minutes' AND sent_at < $5::timestamptz + interval '3 minutes'
             AND NOT EXISTS (SELECT 1 FROM {{p}}messages x WHERE x.session = $6 AND x.msg_id = $7) ORDER BY sent_at DESC LIMIT 1`,
          [userId, ids, m.body, m.type, m.sentAt.toISOString(), m.session, m.msgId])).rows[0];
        if (ghost) await q(`UPDATE {{p}}messages SET msg_id = $2, stanza = $3 WHERE id = $1`, [ghost.id, m.msgId, m.stanza]);
      }
      const r = m.reply;
      const ins = await q(
        `INSERT INTO {{p}}messages (user_id, session, chat_id, msg_id, stanza, from_me, sender, sender_name, body, has_media, sent_at, reply_to, reply_body, reply_sender, reply_media, type, media, extra, ack, created_at, deleted_at, lost, edited_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19, CASE WHEN $20::boolean THEN $11::timestamptz ELSE now() END,
                 CASE WHEN $21::boolean THEN $11::timestamptz END, $21::boolean, $22::timestamptz)
         ON CONFLICT (session, msg_id) DO NOTHING RETURNING id`,
        [userId, m.session, m.chatId, m.msgId, m.stanza, m.fromMe, m.sender, m.senderName, m.body, m.hasMedia, m.sentAt.toISOString(), r?.id ?? "", r?.body ?? "", r?.sender ?? "", r?.hasMedia ?? false,
          m.type, m.media ? pgJson(m.media) : null, Object.keys(m.extra).length ? pgJson(m.extra) : null, m.ack, opts.history === true, m.revoked === true, m.editedAt ? m.editedAt.toISOString() : null]);
      const fresh = ins.rows.length > 0;
      let filled = false;
      if (!fresh && m.revoked) {
        // Deleted since Floq stored it: what Floq has stays (that is what the user can recover).
        await q(`UPDATE {{p}}messages SET deleted_at = COALESCE(deleted_at, GREATEST(sent_at, $3::timestamptz)) WHERE session = $1 AND msg_id = $2`, [m.session, m.msgId, m.sentAt.toISOString()]);
      } else if (!fresh) {
        const r2 = m.reply;
        filled = (await q(
          `UPDATE {{p}}messages SET body = $3, type = $4, media = $5::jsonb, extra = $6::jsonb, has_media = $7, sender = $8, sender_name = $9, sent_at = $10, from_me = $11,
             reply_to = $12, reply_body = $13, reply_sender = $14, reply_media = $15, lost = FALSE WHERE session = $1 AND msg_id = $2 AND lost RETURNING id`,
          [m.session, m.msgId, m.body, m.type, m.media ? pgJson(m.media) : null, Object.keys(m.extra).length ? pgJson(m.extra) : null, m.hasMedia, m.sender, m.senderName, m.sentAt.toISOString(), m.fromMe,
            r2?.id ?? "", r2?.body ?? "", r2?.sender ?? "", r2?.hasMedia ?? false])).rows.length > 0;
      }
      if (!fresh && !filled) {
        // Seen before (history sync, or an event repeated): acks only go up, details fill in.
        await q(
          `UPDATE {{p}}messages SET ack = GREATEST(ack, $3), type = CASE WHEN type IN ('chat','unknown') AND $4 <> 'unknown' THEN $4 ELSE type END,
             media = CASE WHEN $5::jsonb IS NOT NULL AND (media IS NULL OR media->>'url' IS NULL OR $5::jsonb->>'url' IS NOT NULL) THEN $5::jsonb ELSE media END,
             extra = COALESCE(extra, $6::jsonb), sender_name = CASE WHEN sender_name = '' THEN $7 ELSE sender_name END
           WHERE session = $1 AND msg_id = $2`,
          [m.session, m.msgId, m.ack, m.type, m.media ? pgJson(m.media) : null, Object.keys(m.extra).length ? pgJson(m.extra) : null, m.senderName]);
      }
      if (!m.fromMe && !isGroup(m.chatId) && (m.senderName || m.senderPhone)) await identity.upsertContact(userId, m.chatId, { pushName: m.senderName, phone: m.senderPhone });
      if (!m.fromMe && isGroup(m.chatId) && m.senderName && isUser(m.sender)) await identity.upsertContact(userId, m.sender, { pushName: m.senderName });
      if (!fresh && m.editedAt) await q(`UPDATE {{p}}messages SET edited_at = COALESCE(edited_at, $3::timestamptz) WHERE session = $1 AND msg_id = $2`, [m.session, m.msgId, m.editedAt.toISOString()]);
      // Edits that came before the message (an import, webhooks out of order) apply now.
      if ((fresh || filled) && m.stanza && !m.revoked) await applyEdits(userId, m.stanza);
      if (filled && opts.history !== true) await touched(userId, m.stanza, "deleted");
      cacheMedia(userId, m.stanza, m.media);
      return fresh ? "new" : "known";
    },

    async listChats(userId, opts = {}) {
      const selfIds = await identity.selfIds(userId);
      const me = await identity.me(userId);
      const meChat = me?.id ? await identity.canonical(userId, me.id) : "";
      const r = await q(
        `WITH msgs AS (${MSGS}),
         vis AS (SELECT u.* FROM msgs u LEFT JOIN {{p}}chat_state st ON st.user_id = $1 AND st.session = $S AND st.chat_id = u.cid WHERE st.cleared_at IS NULL OR u.sent_at > st.cleared_at),
         agg AS (SELECT cid, MAX(sent_at) AS last_at, COUNT(*)::int AS total FROM vis GROUP BY cid),
         -- One pass each instead of a scan per chat: an imported history has thousands of chats.
         lst AS (SELECT DISTINCT ON (cid) cid, body, from_me, has_media, type, ack, deleted_at, sender_name, sender FROM vis ORDER BY cid, sent_at DESC, id DESC),
         unr AS (SELECT u.cid, COUNT(*)::int AS n FROM vis u LEFT JOIN {{p}}chat_reads r ON r.user_id = $1 AND r.session = $S AND r.chat_id = u.chat_id
                  WHERE u.from_me = FALSE AND (r.read_at IS NULL OR u.created_at > r.read_at) GROUP BY u.cid)
         SELECT a.cid AS chat_id, a.last_at, a.total, l.body AS last_body, l.from_me AS last_from_me, l.has_media AS last_has_media, l.type AS last_type, l.ack AS last_ack, l.deleted_at AS last_deleted,
                COALESCE((SELECT NULLIF(k2.name, '') FROM {{p}}contacts k2 WHERE k2.user_id = $1 AND k2.session = $S AND k2.chat_id = l.sender LIMIT 1), NULLIF(l.sender_name, ''), (SELECT NULLIF(k2.push_name, '') FROM {{p}}contacts k2 WHERE k2.user_id = $1 AND k2.session = $S AND k2.chat_id = l.sender LIMIT 1), '') AS last_sender_name, c.name AS name, c.push_name AS push_name, c.phone AS phone, c.has_picture AS has_picture, c.picture_at AS picture_at, c.blocked AS blocked,
                COALESCE(st.archived, FALSE) AS archived, COALESCE(st.pinned, FALSE) AS pinned, st.muted_until AS muted_until, COALESCE(st.marked_unread, FALSE) AS marked_unread, COALESCE(st.labels, '[]'::jsonb) AS labels,
                COALESCE(unr.n, 0) AS unread
           FROM agg a
           LEFT JOIN {{p}}chat_state st ON st.user_id = $1 AND st.session = $S AND st.chat_id = a.cid
           LEFT JOIN lst l ON l.cid = a.cid
           LEFT JOIN unr ON unr.cid = a.cid
           LEFT JOIN LATERAL (
             SELECT MAX(NULLIF(k.name, '')) AS name, MAX(NULLIF(k.push_name, '')) AS push_name, MAX(NULLIF(k.phone, '')) AS phone, BOOL_OR(k.has_picture) AS has_picture, MAX(k.picture_at) AS picture_at, BOOL_OR(k.blocked) AS blocked
               FROM {{p}}contacts k WHERE k.user_id = $1 AND k.session = $S AND (k.chat_id = a.cid OR k.chat_id IN (SELECT lid FROM {{p}}lid_map WHERE user_id = $1 AND session = $S AND pn = a.cid))) c ON TRUE
          WHERE (COALESCE(st.hidden, FALSE) = FALSE OR st.cleared_at IS NOT NULL) -- people-wiring: a message newer than cleared_at (only those are in agg) brings a deleted chat back
          ORDER BY COALESCE(st.pinned, FALSE) DESC, a.last_at DESC LIMIT 1000`, [userId]);
      const all = r.rows.map((x) => {
        const chatId = String(x.chat_id), kind = kindOf(chatId);
        const digits = digitsOf(chatId) ?? (x.phone ? String(x.phone) : null);
        const isSelf = selfIds.has(chatId);
        const name = (x.name ? String(x.name) : "") || (x.push_name ? String(x.push_name) : "") || (isSelf && me?.name && meChat === chatId ? me.name : "");
        return {
          chatId, kind: kind === "channel" || kind === "status" ? "other" : kind, name: name || null, phone: digits ? displayDigits(digits) : null, isSelf,
          lastBody: x.last_deleted ? "" : String(x.last_body ?? "").slice(0, 200), lastFromMe: x.last_from_me === true, lastHasMedia: x.last_has_media === true, lastType: String(x.last_type ?? "chat"),
          lastAck: Number(x.last_ack) || 0, lastDeleted: Boolean(x.last_deleted), lastSenderName: kind === "group" ? String(x.last_sender_name ?? "") : "",
          lastAt: iso(x.last_at), total: Number(x.total) || 0, unread: Math.max(Number(x.unread) || 0, x.marked_unread === true ? 1 : 0), markedUnread: x.marked_unread === true,
          archived: x.archived === true, pinned: x.pinned === true, muted: x.muted_until ? new Date(x.muted_until as string).getTime() > Date.now() : false, blocked: x.blocked === true,
          avatar: x.has_picture === true && x.picture_at ? new Date(x.picture_at as string).getTime() : null, labels: Array.isArray(x.labels) ? x.labels : [],
        };
      });
      const archived = all.filter((c) => c.archived);
      return { chats: (opts.archived ? archived : all.filter((c) => !c.archived)).slice(0, 500), archivedCount: archived.length };
    },

    async listMessages(userId, chatId, opts = {}) {
      const n = Math.min(200, Math.max(1, Number.parseInt(String(opts.limit ?? "50"), 10) || 50));
      const ids = await identity.aliases(userId, chatId);
      const before = typeof opts.before === "string" && !Number.isNaN(Date.parse(opts.before)) ? new Date(opts.before).toISOString() : null;
      const search = typeof opts.q === "string" && opts.q.trim() ? "%" + opts.q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => "\\" + c) + "%" : null;
      const r = await q(
        `SELECT t.*, COALESCE(sm.pn, t.sender) AS sender_c, COALESCE(rm.pn, t.reply_sender) AS reply_sender_c,
                COALESCE(NULLIF(sc.name, ''), NULLIF(t.sender_name, ''), NULLIF(sc.push_name, ''), '') AS sender_label,
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('emoji', x.emoji, 'sender', COALESCE(xm.pn, x.sender)) ORDER BY x.at), '[]'::jsonb) FROM {{p}}reactions x LEFT JOIN {{p}}lid_map xm ON xm.user_id = $1 AND xm.session = $S AND xm.lid = x.sender WHERE x.user_id = $1 AND x.session = $S AND x.stanza = t.stanza AND t.stanza <> '') AS reactions,
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('voter', v.voter, 'options', v.options)), '[]'::jsonb) FROM {{p}}poll_votes v WHERE v.user_id = $1 AND v.session = $S AND v.stanza = t.stanza AND t.type = 'poll') AS votes,
                EXISTS (SELECT 1 FROM {{p}}media_blobs b WHERE b.user_id = $1 AND b.session = $S AND b.key = 'm:' || t.stanza) AS cached
           FROM (
           SELECT m.* FROM {{p}}messages m LEFT JOIN {{p}}chat_state st ON st.user_id = $1 AND st.session = $S AND st.chat_id = $5
            WHERE m.user_id = $1 AND m.session = $S AND m.chat_id = ANY($2::text[]) AND (st.cleared_at IS NULL OR m.sent_at > st.cleared_at)
              AND ($4::timestamptz IS NULL OR m.sent_at < $4::timestamptz) AND ($6::text IS NULL OR (m.body ILIKE $6 AND m.deleted_at IS NULL))
            ORDER BY m.sent_at DESC, m.id DESC LIMIT $3) t
           LEFT JOIN {{p}}lid_map sm ON sm.user_id = $1 AND sm.session = $S AND sm.lid = t.sender
           LEFT JOIN {{p}}lid_map rm ON rm.user_id = $1 AND rm.session = $S AND rm.lid = t.reply_sender
           LEFT JOIN {{p}}contacts sc ON sc.user_id = $1 AND sc.session = $S AND sc.chat_id = COALESCE(sm.pn, t.sender)
          ORDER BY t.sent_at ASC, t.id ASC`, [userId, ids, n + 1, before, ids[0], search]);
      const more = r.rows.length > n;
      const page = more ? r.rows.slice(1) : r.rows;
      const rows = page.map((x) => shape(x));
      // "Deleted by admin <name>": the names of the admins who deleted messages on this page.
      const admins = [...new Set(page.map((x) => String(x.deleted_by ?? "")).filter((b) => b.startsWith("admin:")).map((b) => b.slice(6)))];
      if (admins.length) {
        const names = new Map((await q(`SELECT chat_id, COALESCE(NULLIF(name, ''), push_name, '') AS n FROM {{p}}contacts WHERE user_id = $1 AND session = $S AND chat_id = ANY($2::text[])`, [userId, admins])).rows.map((k) => [String(k.chat_id), String(k.n ?? "")]));
        rows.forEach((m, i) => { const b = String(page[i].deleted_by ?? ""); if (b.startsWith("admin:")) { const id = b.slice(6); (m as Record<string, unknown>).deletedByName = names.get(id) || (digitsOf(id) ? formatPhone(displayDigits(digitsOf(id)!)) : ""); } });
      }
      // A quote points at the original when it is on this page (so the UI can jump to it); otherwise it shows what the reply itself carried.
      const byStanza = new Map(rows.map((m) => [stanzaOf(m.id), m]));
      const messages = rows.map((m, i) => {
        const row = page[i];
        const ref = typeof row.reply_to === "string" && row.reply_to ? row.reply_to : "";
        if (!ref) return { ...m, replyTo: null };
        const o = byStanza.get(ref);
        const sender = o ? o.sender : String(row.reply_sender_c ?? "");
        return { ...m, replyTo: {
          id: o ? o.id : "", body: (o ? o.body : String(row.reply_body ?? "")).slice(0, 400), hasMedia: o ? o.hasMedia : row.reply_media === true,
          fromMe: o ? o.fromMe : sender === "me", sender: sender === "me" ? "" : sender, senderName: o ? o.senderName : "",
        } };
      });
      if (opts.sync !== false && !before && !search) core.bg(store.syncChat(userId, ids[0]).then((changed) => { if (changed) core.publish(userId, "message", { chatId: ids[0], sync: true }); }));
      return { messages, more };
    },

    async markRead(userId, chatId) {
      const ids = await identity.aliases(userId, chatId);
      for (const id of ids) {
        await q(`INSERT INTO {{p}}chat_reads (user_id, session, chat_id, read_at) VALUES ($1,$S,$2,now()) ON CONFLICT (user_id, session, chat_id) DO UPDATE SET read_at = now()`, [userId, id]);
      }
      await q(`UPDATE {{p}}chat_state SET marked_unread = FALSE WHERE user_id = $1 AND session = $S AND chat_id = $2 AND marked_unread`, [userId, ids[0]]);
    },

    async row(userId, msgId) {
      if (typeof msgId !== "string" || !msgId || msgId.length > 200) throw ctx.httpError(400, "invalid_message", "messageId is invalid");
      const x = (await q(`SELECT * FROM {{p}}messages WHERE user_id = $1 AND session = $S AND msg_id = $2 LIMIT 1`, [userId, msgId])).rows[0];
      if (!x) throw ctx.httpError(404, "unknown_message", "That message is not in the inbox.");
      return x;
    },

    async route(userId, chatId) {
      const every = await identity.aliases(userId, chatId);
      if (every.length < 2) return every;
      // The other spelling of a number is only a way to find the chat, never an address to write to, unless WAHA itself reported it.
      const real = new Set((await q(`SELECT id FROM {{p}}known_ids WHERE user_id = $1 AND session = $S AND id = ANY($2::text[])`, [userId, every])).rows.map((x) => String(x.id)));
      const ids = every.filter((id, i) => i === 0 || !pnOf(id) || real.has(id));
      const last = (await q(`SELECT chat_id FROM {{p}}messages WHERE user_id = $1 AND session = $S AND chat_id = ANY($2::text[]) AND from_me = FALSE ORDER BY sent_at DESC LIMIT 1`, [userId, ids])).rows[0]?.chat_id;
      const kv = await ctx.kv.get(userId, `route:${ids[0]}`);
      const first = typeof last === "string" && ids.includes(last) ? last : typeof kv === "string" && ids.includes(kv) ? kv : ids[0];
      return [first, ...ids.filter((i) => i !== first)];
    },

    async mediaBytes(userId, msgId) {
      const x = await store.row(userId, msgId);
      const media = rec(x.media) as unknown as MediaMeta, stanza = String(x.stanza ?? "");
      if (!x.media) throw ctx.httpError(404, "no_media", "That message has no file.");
      const filename = String(media.filename ?? "");
      const hit = (await q(`SELECT mime, bytes FROM {{p}}media_blobs WHERE user_id = $1 AND session = $S AND key = $2`, [userId, "m:" + stanza])).rows[0];
      if (hit) return { mime: String(hit.mime || media.mime || "application/octet-stream"), filename, bytes: hit.bytes as Uint8Array };
      // A deleted message's file is only what Floq kept: nothing is asked of WhatsApp for it.
      if (x.deleted_at) throw ctx.httpError(404, "media_not_kept", "Floq did not keep this file before the message was deleted.");
      const key = userId + "\n" + String(x.id);
      const running = fetching.get(key);
      if (running) return running;
      const job = (async () => {
        // "Gone" is only what WAHA itself says is gone (a 404, or a message it has no file for). Anything else (WAHA down, busy, the session
        // starting) is a passing failure: a 503 the UI tries again by itself instead of telling the user to pick up the phone.
        const is404 = (e: unknown) => (e as { status?: number } | null)?.status === 404;
        let passing = false;
        const tryUrl = async (url: unknown, definitive: boolean) => {
          if (typeof url !== "string" || !url) return null;
          try { const f = await core.wahaBytes(userId, url); if (f.bytes.length) return f; if (!definitive) passing = true; return null; }
          catch (e) { if (!definitive || !is404(e)) passing = true; return null; }
        };
        // The address the message came with: a 404 here only means WAHA cleaned its downloads (it does after a few minutes).
        let f = await tryUrl(media.url, true);
        if (!f) {
          // No address yet (a message imported from the history has none) or WAHA dropped the file: have WAHA download the message's media again.
          passing = false;
          let fresh: Record<string, unknown> = {};
          try { fresh = rec(await core.waha(userId, "GET", `/api/{session}/chats/${encodeURIComponent(String(x.chat_id))}/messages/${encodeURIComponent(String(x.msg_id))}`, { query: { downloadMedia: true } })); }
          catch (e) { if (!is404(e)) passing = true; }
          // A file WAHA has just downloaded and cannot serve is a hiccup, not a missing file.
          f = await tryUrl(rec(fresh.media).url, false);
        }
        const flagged = rec(x.extra).mediaGone === true;
        if (!f) {
          if (passing) throw ctx.httpError(503, "media_busy", "WhatsApp could not hand over this file right now. Try again in a moment.");
          if (!flagged) await q(`UPDATE {{p}}messages SET extra = COALESCE(extra, '{}'::jsonb) || '{"mediaGone":true}'::jsonb WHERE id = $1`, [x.id]).catch(() => undefined);
          throw ctx.httpError(404, "media_unavailable", "This file is no longer available from WAHA. Open WhatsApp on your phone to see it.");
        }
        if (flagged) await q(`UPDATE {{p}}messages SET extra = extra - 'mediaGone' WHERE id = $1`, [x.id]).catch(() => undefined);
        const mime = media.mime || f.mime || "application/octet-stream";
        if (f.bytes.length <= MEDIA_MAX_BYTES) await putBlob(userId, "m:" + stanza, mime, f.bytes).catch(() => undefined);
        return { mime, filename, bytes: f.bytes };
      })();
      fetching.set(key, job);
      try { return await job; } finally { fetching.delete(key); }
    },

    async syncChats(userId, force = false) {
      const now = Date.now();
      if (!force && now - (chatsSyncedAt.get(userId) ?? 0) < CHATS_SYNC_EVERY_MS) return false;
      chatsSyncedAt.set(userId, now);
      try {
        const c = await core.config(userId);
        if (!c.base || !c.apiKey) return false;
        let list = await core.tryWaha<unknown[]>(userId, "GET", "/api/{session}/chats/overview", { query: { limit: 60, offset: 0 } });
        if (!Array.isArray(list)) list = await core.tryWaha<unknown[]>(userId, "GET", "/api/{session}/chats", { query: { limit: 60, offset: 0, sortBy: "conversationTimestamp", sortOrder: "desc" } });
        if (!Array.isArray(list)) return false;
        let changed = false, pictures = 0;
        for (const item of list) {
          const o = rec(item), id = normId(o.id);
          if (!id || id === "status@broadcast" || id.endsWith("@newsletter") || id.endsWith("@broadcast")) continue;
          const name = typeof o.name === "string" ? o.name.trim() : "";
          // WAHA falls back to the number or the id when it has no name: that is not a name.
          if (name && !name.includes("@") && !/^[+\d\s()-]+$/.test(name)) await identity.upsertContact(userId, id, { name });
          const last = rec(o.lastMessage);
          if (Object.keys(last).length) {
            const m = parseMessage({ ...last, from: last.from ?? (last.fromMe ? undefined : id), to: last.to ?? (last.fromMe ? id : undefined) }, c.session, await identity.me(userId));
            if (m && (m.chatId === id || isGroup(id) === isGroup(m.chatId))) { if ((await store.save(userId, { ...m, chatId: isGroup(id) ? id : m.chatId })) === "new") changed = true; }
          }
          if (typeof o.picture === "string" && o.picture && pictures < 12) {
            const k = (await q(`SELECT picture_at FROM {{p}}contacts WHERE user_id = $1 AND session = $S AND chat_id = $2`, [userId, id])).rows[0];
            if (!k?.picture_at || now - new Date(k.picture_at as string).getTime() > 24 * 3600_000) { pictures++; if (await identity.saveAvatar(userId, id, o.picture)) changed = true; }
          }
          const st = rec(o._chat);
          if (typeof st.archived === "boolean" || typeof st.archive === "boolean") await store.setState(userId, await identity.canonical(userId, id), { archived: st.archived === true || st.archive === true });
        }
        return changed;
      } catch { return false; }
    },

    async syncChat(userId, chatId, force = false) {
      const now = Date.now();
      if (!force && now - (chatSynced.get(userId + chatId) ?? 0) < CHAT_SYNC_EVERY_MS) return false;
      chatSynced.set(userId + chatId, now);
      if (chatSynced.size > 500) chatSynced.clear();
      try {
        const c = await core.config(userId);
        if (!c.base || !c.apiKey) return false;
        const me = await identity.me(userId);
        let changed = false;
        const acks = async () => JSON.stringify((await q(`SELECT SUM(ack)::int AS a, COUNT(*)::int AS n FROM {{p}}messages WHERE user_id = $1 AND session = $S AND chat_id = ANY($2::text[])`, [userId, await identity.aliases(userId, chatId)])).rows[0]);
        const was = await acks();
        for (const target of await store.route(userId, chatId)) {
          const list = await core.tryWaha<unknown[]>(userId, "GET", `/api/{session}/chats/${encodeURIComponent(target)}/messages`, { query: { limit: 40, downloadMedia: false } });
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            const o = rec(item);
            const m = parseMessage({ ...o, from: o.from ?? (o.fromMe ? undefined : target), to: o.to ?? (o.fromMe ? target : undefined) }, c.session, me);
            if (!m) continue;
            if (!isGroup(target) && isGroup(m.chatId)) continue;
            if ((await store.save(userId, isGroup(target) ? { ...m, chatId: target } : m)) === "new") changed = true;
          }
          break;
        }
        return changed || (await acks()) !== was;
      } catch { return false; }
    },

    async setState(userId, chatId, patch) {
      const cols = ["archived", "pinned", "muted_until", "marked_unread", "cleared_at", "hidden", "labels"].filter((k) => patch[k] !== undefined);
      if (!cols.length) return;
      const vals = cols.map((k) => (k === "labels" ? pgJson(patch[k]) : patch[k]));
      await q(
        `INSERT INTO {{p}}chat_state (user_id, session, chat_id, ${cols.join(", ")}) VALUES ($1,$S,$2,${cols.map((k, i) => `$${i + 3}${k === "labels" ? "::jsonb" : ""}`).join(", ")})
         ON CONFLICT (user_id, session, chat_id) DO UPDATE SET ${cols.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}, updated_at = now()`, [userId, chatId, ...vals]);
    },

    async edit(userId, op) {
      if (!op.stanza) return false;
      const body = op.body.slice(0, 8000), at = op.at.toISOString();
      const dup = (await q(
        `SELECT 1 AS x FROM {{p}}message_edits WHERE user_id = $1 AND session = $S AND stanza = $2
           AND (edit_id = $3 OR (body = $4 AND at BETWEEN $5::timestamptz - interval '2 minutes' AND $5::timestamptz + interval '2 minutes')) LIMIT 1`,
        [userId, op.stanza, op.editId.slice(0, 200), body, at])).rows.length > 0;
      if (!dup) await q(`INSERT INTO {{p}}message_edits (user_id, session, stanza, edit_id, body, at) VALUES ($1,$S,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [userId, op.stanza, op.editId.slice(0, 200), body, at]);
      const changed = await applyEdits(userId, op.stanza);
      if (changed && !op.quiet) await touched(userId, op.stanza, "edited");
      return changed;
    },

    async revoke(userId, op) {
      if (!op.stanza) return false;
      const at = op.at.toISOString();
      const rows = (await q(`SELECT id, chat_id, from_me, sender, deleted_at FROM {{p}}messages WHERE user_id = $1 AND session = $S AND stanza = $2`, [userId, op.stanza])).rows;
      /** "admin:<id>" when someone deleted another person's message in a group. */
      const byOf = async (chatId: string, origFromMe: boolean, origSender: string) => {
        if (op.revoker === "me") return "me";
        if (!op.revoker || !isGroup(chatId)) return "sender";
        const rev = await identity.canonical(userId, op.revoker);
        if (origFromMe) return "admin:" + rev;
        if (!origSender) return "sender";
        return (await identity.canonical(userId, origSender)) === rev ? "sender" : "admin:" + rev;
      };
      if (rows.length) {
        const x = rows[0], fresh = rows.some((r) => !r.deleted_at);
        const by = await byOf(String(x.chat_id), x.from_me === true, String(x.sender ?? ""));
        await q(`UPDATE {{p}}messages SET deleted_at = COALESCE(deleted_at, $3::timestamptz), deleted_by = CASE WHEN deleted_by = '' THEN $4 ELSE deleted_by END WHERE user_id = $1 AND session = $S AND stanza = $2`, [userId, op.stanza, at, by]);
        if (!fresh || op.quiet) return fresh;
        // The island card of an incoming message that is now deleted goes away (when it is the chat's newest one: that is what the card shows).
        if (x.from_me !== true) {
          const newest = (await q(`SELECT stanza FROM {{p}}messages WHERE user_id = $1 AND session = $S AND chat_id = $2 AND from_me = FALSE ORDER BY sent_at DESC, id DESC LIMIT 1`, [userId, x.chat_id])).rows[0];
          if (newest && String(newest.stanza) === op.stanza) notifierOf(core, identity).read(userId, await identity.canonical(userId, String(x.chat_id)));
        }
        await touched(userId, op.stanza, "deleted");
        return true;
      }
      const chatId = op.chatId ?? "";
      if (!chatId || !CHAT_ID.test(chatId) || chatId === "status@broadcast") return false;
      const fromMe = op.targetFromMe ?? op.revoker === "me";
      const sender = fromMe ? "me" : op.targetSender || (isGroup(chatId) ? (op.revoker !== "me" ? op.revoker : "") : chatId);
      const by = await byOf(chatId, fromMe, sender);
      const msgId = `${fromMe}_${chatId}_${op.stanza}` + (isGroup(chatId) && !fromMe && sender ? "_" + sender : "");
      const ins = await q(
        `INSERT INTO {{p}}messages (user_id, session, chat_id, msg_id, stanza, from_me, sender, body, sent_at, type, ack, deleted_at, deleted_by, lost, created_at)
         VALUES ($1,$S,$2,$3,$4,$5,$6,'',$7,'chat',$8,$7,$9,TRUE, CASE WHEN $10::boolean THEN $7::timestamptz ELSE now() END) ON CONFLICT (session, msg_id) DO NOTHING RETURNING id`,
        [userId, chatId, msgId.slice(0, 200), op.stanza, fromMe, sender, at, fromMe ? 1 : 0, by, op.history === true]);
      if (ins.rows.length && !op.quiet) await touched(userId, op.stanza, "deleted");
      return ins.rows.length > 0;
    },

    async versions(userId, x) {
      const stanza = String(x.stanza ?? "");
      if (!stanza || x.orig_body === null || x.orig_body === undefined) return [];
      const edits = (await q(`SELECT body, at FROM {{p}}message_edits WHERE user_id = $1 AND session = $S AND stanza = $2 ORDER BY at ASC, edit_id ASC`, [userId, stanza])).rows;
      const out: Array<{ body: string; at: string }> = [{ body: String(x.orig_body), at: iso(x.sent_at) }];
      for (const e of edits) { const body = String(e.body ?? ""); if (body !== out[out.length - 1].body) out.push({ body, at: iso(e.at) }); }
      return out.length > 1 ? out : [];
    },
  };

  /** Makes the newest recorded edit the message's text (the first text is kept in orig_body). True when the row changed. */
  async function applyEdits(userId: string, stanza: string): Promise<boolean> {
    const r = await q(
      `UPDATE {{p}}messages m SET orig_body = COALESCE(m.orig_body, m.body), body = e.body, edited_at = e.at
         FROM (SELECT body, at FROM {{p}}message_edits WHERE user_id = $1 AND session = $S AND stanza = $2 ORDER BY at DESC, edit_id DESC LIMIT 1) e
        WHERE m.user_id = $1 AND m.session = $S AND m.stanza = $2 AND m.lost = FALSE AND (m.body <> e.body OR m.edited_at IS DISTINCT FROM e.at) RETURNING m.id`, [userId, stanza]);
    return r.rows.length > 0;
  }

  /** One stored row as the UI and agents see it. Never carries a WAHA URL. */
  function shape(x: Record<string, unknown>) {
    const media = x.media ? (rec(x.media) as unknown as MediaMeta) : null, extra = (x.extra ? rec(x.extra) : {}) as MessageExtra;
    const deleted = Boolean(x.deleted_at);
    const reactions = new Map<string, { emoji: string; count: number; mine: boolean; senders: string[] }>();
    for (const r of Array.isArray(x.reactions) ? (x.reactions as Array<Record<string, unknown>>) : []) {
      const e = String(r.emoji ?? ""); if (!e) continue;
      const cur = reactions.get(e) ?? { emoji: e, count: 0, mine: false, senders: [] };
      cur.count++; if (r.sender === "me") cur.mine = true; else cur.senders.push(String(r.sender ?? ""));
      reactions.set(e, cur);
    }
    let poll: Record<string, unknown> | undefined;
    if (extra.poll && !deleted) {
      const votes = Array.isArray(x.votes) ? (x.votes as Array<Record<string, unknown>>) : [];
      poll = { name: extra.poll.name, multiple: extra.poll.multiple, voters: votes.length, options: extra.poll.options.map((name) => ({
        name, votes: votes.filter((v) => Array.isArray(v.options) && (v.options as unknown[]).includes(name)).length,
        voted: votes.some((v) => v.voter === "me" && Array.isArray(v.options) && (v.options as unknown[]).includes(name)) })) };
    }
    const sender = String(x.sender_c ?? x.sender ?? "");
    const by = String(x.deleted_by ?? "");
    const deletedAt = deleted && new Date(x.deleted_at as string).getTime() > new Date(x.sent_at as string).getTime() ? iso(x.deleted_at) : null;
    // What a deleted message was, as Floq had it (the user can reveal it); null when Floq never had its content.
    const original = deleted && x.lost !== true ? {
      type: String(x.type ?? "chat"), body: String(x.body ?? ""), hasMedia: x.has_media === true,
      media: media ? { mime: media.mime, filename: media.filename, size: media.size ?? null, duration: media.duration ?? null, width: media.width ?? null, height: media.height ?? null, gif: media.gif === true, ...(media.animated ? { animated: true } : {}), ...(media.lottie ? { lottie: true } : {}), available: x.cached === true } : null,
      ...(extra.location ? { location: extra.location } : {}), ...(extra.vcards ? { vcards: extra.vcards.map((v) => ({ name: v.name, phones: v.phones, formatted: v.phones.map((p) => formatPhone(p)) })) } : {}),
      ...(extra.poll ? { poll: { name: extra.poll.name, multiple: extra.poll.multiple, voters: 0, options: extra.poll.options.map((name) => ({ name, votes: 0, voted: false })) } } : {}),
      ...(extra.preview ? { preview: extra.preview } : {}), ...(extra.mentions ? { mentions: extra.mentions } : {}), forwarded: extra.forwarded === true, edited: Boolean(x.edited_at),
    } : null;
    return {
      id: String(x.msg_id), fromMe: x.from_me === true, sender, senderName: String(x.sender_label ?? x.sender_name ?? ""),
      body: deleted ? "" : String(x.body ?? ""), type: deleted ? "deleted" : String(x.type ?? "chat"), hasMedia: !deleted && x.has_media === true, sentAt: iso(x.sent_at),
      ack: Number(x.ack) || 0, edited: Boolean(x.edited_at) && !deleted, editedAt: x.edited_at && !deleted ? iso(x.edited_at) : null, deleted, starred: x.starred === true, pinned: x.pinned === true, forwarded: extra.forwarded === true,
      ...(deleted ? { deletedAt, deletedBy: by === "me" ? "me" : by.startsWith("admin:") ? "admin" : by === "sender" ? "sender" : null, original } : {}),
      media: media && !deleted ? { mime: media.mime, filename: media.filename, size: media.size ?? null, duration: media.duration ?? null, width: media.width ?? null, height: media.height ?? null, gif: media.gif === true, ...(media.animated ? { animated: true } : {}), ...(media.lottie ? { lottie: true } : {}), available: x.cached === true || (extra as { mediaGone?: boolean }).mediaGone !== true } : null,
      ...(extra.location && !deleted ? { location: extra.location } : {}), ...(extra.vcards && !deleted ? { vcards: extra.vcards.map((v) => ({ name: v.name, phones: v.phones, formatted: v.phones.map((p) => formatPhone(p)) })) } : {}),
      ...(poll ? { poll } : {}), ...(extra.preview && !deleted ? { preview: extra.preview } : {}), ...(extra.mentions ? { mentions: extra.mentions } : {}), ...(extra.call ? { call: extra.call } : {}),
      reactions: [...reactions.values()],
    };
  }

  async function react(userId: string, stanza: string, sender: string, emoji: string, at: Date) {
    if (!stanza) return;
    const who = sender === "me" ? "me" : await identity.canonical(userId, sender);
    if (!emoji) await q(`DELETE FROM {{p}}reactions WHERE user_id = $1 AND session = $S AND stanza = $2 AND sender = $3`, [userId, stanza, who]);
    else await q(`INSERT INTO {{p}}reactions (user_id, session, stanza, sender, emoji, at) VALUES ($1,$S,$2,$3,$4,$5) ON CONFLICT (user_id, session, stanza, sender) DO UPDATE SET emoji = EXCLUDED.emoji, at = EXCLUDED.at`, [userId, stanza, who, emoji.slice(0, 16), at.toISOString()]);
  }
  const chatOfStanza = async (userId: string, stanza: string) => {
    const x = (await q(`SELECT chat_id FROM {{p}}messages WHERE user_id = $1 AND session = $S AND stanza = $2 LIMIT 1`, [userId, stanza])).rows[0];
    return x ? identity.canonical(userId, String(x.chat_id)) : null;
  };
  const touched = async (userId: string, stanza: string, what: string) => { const chatId = await chatOfStanza(userId, stanza); if (chatId) core.publish(userId, "message", { chatId, [what]: true }); };

  // ---- WAHA events ----
  for (const name of MESSAGE_EVENTS) core.on(name, async (userId, e: WebhookEvent) => {
    const m = parseMessage(e.payload, e.session, e.me);
    if (!m || m.chatId === "status@broadcast" || m.chatId.endsWith("@newsletter") || m.chatId.endsWith("@broadcast")) return;
    const res = await store.save(userId, m);
    const chatId = await identity.canonical(userId, m.chatId);
    if (res === "skipped") { if (!m.protocol) core.publish(userId, "message", { chatId, reaction: true }); return; }
    if (res !== "new") return;
    if (m.fromMe || m.revoked) { core.publish(userId, "message", { chatId, fromMe: true }); return; }
    if (m.type === "system") return;
    core.publish(userId, "message", { chatId, fromMe: false, preview: m.body.slice(0, 120) });
    const st = (await q(`SELECT muted_until, archived FROM {{p}}chat_state WHERE user_id = $1 AND session = $S AND chat_id = $2`, [userId, chatId])).rows[0];
    if (st?.muted_until && new Date(st.muted_until as string).getTime() > Date.now()) return;
    // The name the user saved for the contact comes first, then the name the person set on WhatsApp, then the number.
    const known = async (id: string) => { const k = (await q(`SELECT name, push_name FROM {{p}}contacts WHERE user_id = $1 AND session = $S AND chat_id = ANY($2::text[]) ORDER BY (name <> '') DESC LIMIT 1`, [userId, await identity.aliases(userId, id)])).rows[0]; return { saved: String(k?.name || ""), push: String(k?.push_name || "") }; };
    const g = isGroup(chatId) ? await known(chatId) : null, group = g ? g.saved || g.push : "";
    const c = await known(isGroup(chatId) ? m.sender : chatId);
    let who = c.saved || m.senderName || c.push || (m.senderPhone ? formatPhone(displayDigits(m.senderPhone)) : "");
    // Floq's island (sender, preview, reply, mark read, open chat) where the host has it; the plain toast on an older Floq.
    if ((await notifierOf(core, identity).message(userId, { chatId, m, who, group })) !== "unsupported") return;
    if (group) who = who ? `${who} in ${group}` : group;
    ctx.toast(userId, { title: `WhatsApp: ${who || "new message"}`, description: m.body.slice(0, 120) || (m.hasMedia ? "Sent a file" : m.type === "location" ? "Sent a location" : m.type === "vcard" ? "Sent a contact" : m.type === "poll" ? "Sent a poll" : "") });
  });
  for (const ackEvent of ["message.ack", "message.ack.group"]) core.on(ackEvent, async (userId, e) => {
    const p = e.payload, stanza = stanzaOf(p.id);
    const ack = ackOf(p);
    if (!stanza || ack === undefined) return;
    if (await applyAck(core, userId, stanza, ack)) await touched(userId, stanza, "ack");
  });
  core.on("message.reaction", async (userId, e) => {
    const p = e.payload, r = rec(p.reaction), stanza = stanzaOf(r.messageId);
    const fromMe = p.fromMe === true, sender = fromMe ? "me" : normId(p.participant) || normId(p.from);
    const secs = Number(p.timestamp);
    await react(userId, stanza, sender, typeof r.text === "string" ? r.text : "", new Date(Number.isFinite(secs) && secs > 0 ? secs * (secs < 1e12 ? 1000 : 1) : Date.now()));
    await touched(userId, stanza, "reaction");
  });
  // payload: { id: the edit's own id, editedMessageId: the edited message (no chat), body: the new text, _data } (every engine). message.any
  // brings the same edit as a protocol message: both end as one version.
  core.on("message.edited", async (userId, e) => {
    const p = e.payload, d = rec(p._data);
    const m = parseMessage(p, e.session, e.me), op = m?.protocol?.kind === "edit" ? m.protocol : null;
    const target = stanzaOf(p.editedMessageId ?? d.editedMessageId ?? op?.target ?? "");
    const body = typeof p.body === "string" ? p.body : op ? op.body : null;
    if (!target || body === null) return;
    const secs = Number(p.timestamp);
    const at = op?.at ?? (Number.isFinite(secs) && secs > 0 ? new Date(secs * (secs < 1e12 ? 1000 : 1)) : new Date());
    let editId = m?.stanza ?? stanzaOf(p.id ?? "");
    if (!editId || editId === target) editId = "t:" + at.getTime();
    await store.edit(userId, { stanza: target, editId, body, at });
  });
  // payload: { revokedMessageId, after: the revoke (a protocol message), before: the message as it was (WEBJS) or null }.
  core.on("message.revoked", async (userId, e) => {
    const p = e.payload, after = rec(p.after), before = rec(p.before);
    const a = Object.keys(after).length ? parseMessage(after, e.session, e.me) : null;
    const op = a?.protocol?.kind === "revoke" ? a.protocol : null;
    const target = stanzaOf(p.revokedMessageId ?? op?.target ?? before.id ?? "");
    if (!target) return;
    // The message as it was, when the engine hands it over: kept, so it can be recovered even if Floq never stored it.
    const b = Object.keys(before).length ? parseMessage(before, e.session, e.me) : null;
    if (b && b.stanza === target && !b.protocol && (b.body || b.hasMedia)) await store.save(userId, b, { real: false });
    await store.revoke(userId, {
      stanza: target, chatId: a?.chatId ?? b?.chatId, targetFromMe: op?.targetFromMe ?? b?.fromMe ?? null, targetSender: op?.targetSender || (b && !b.fromMe ? b.sender : ""),
      revoker: a ? (a.fromMe ? "me" : a.sender) : b?.fromMe ? "me" : "", at: op?.at ?? a?.sentAt ?? new Date(),
    });
  });
  core.on("poll.vote", async (userId, e) => {
    const p = e.payload, vote = rec(p.vote), stanza = stanzaOf(rec(p.poll).id);
    if (!stanza) return;
    const voter = vote.fromMe === true ? "me" : await identity.canonical(userId, normId(vote.participant) || normId(vote.from));
    const options = (Array.isArray(vote.selectedOptions) ? vote.selectedOptions : []).filter((o): o is string => typeof o === "string").slice(0, 12);
    await q(`INSERT INTO {{p}}poll_votes (user_id, session, stanza, voter, options) VALUES ($1,$S,$2,$3,$4::jsonb) ON CONFLICT (user_id, session, stanza, voter) DO UPDATE SET options = EXCLUDED.options, at = now()`, [userId, stanza, voter, pgJson(options)]);
    await touched(userId, stanza, "poll");
  });
  core.on("chat.archive", async (userId, e) => {
    const id = normId(e.payload.id);
    if (!id) return;
    await store.setState(userId, await identity.canonical(userId, id), { archived: e.payload.archived === true });
    core.publish(userId, "chats", {});
  });
  return store;
}
