// Delivery ticks. WAHA reports a message's state as a number (-1 ERROR, 0 PENDING, 1 SERVER, 2 DEVICE, 3 READ, 4 PLAYED) and as a name; the stored ack
// only ever goes up (read stays read when a late "delivered" arrives), and an error only marks a message that was not delivered yet. Acks are matched to
// the stored message by its stanza id, the part of the id that is the same whichever chat spelling (phone or lid) and prefix an event or a send answer uses.
import type { Deps } from "./extras.js";
import type { Core } from "./core.js";
import { stanzaOf } from "./ids.js";

const NAMES: Record<string, number> = { ERROR: -1, PENDING: 0, SERVER: 1, DEVICE: 2, READ: 3, PLAYED: 4 };
const clamp = (n: number) => Math.max(-1, Math.min(4, Math.trunc(n)));
/** The ack of a WAHA message or ack payload: its numeric `ack` or its `ackName` (also "ACK_READ" and numeric strings); undefined when it has none. */
export function ackOf(p: Record<string, unknown>): number | undefined {
  for (const v of [p.ack, p.ackName]) {
    if (typeof v === "number" && Number.isFinite(v)) return clamp(v);
    if (typeof v !== "string" || !v.trim()) continue;
    const t = v.trim().toUpperCase().replace(/^ACK_/, "");
    if (/^-?\d+$/.test(t)) return clamp(Number(t));
    if (t in NAMES) return NAMES[t];
  }
  return undefined;
}

/** Raises the ack of our own message with this stanza id. True when a row changed. */
export async function applyAck(core: Core, userId: string, stanza: string, ack: number): Promise<boolean> {
  if (!stanza) return false;
  const r = await core.ctx.db.query(
    `UPDATE {{p}}messages SET ack = $3 WHERE user_id = $1 AND session = $S AND stanza = $2 AND from_me AND (($3 < 0 AND ack IN (0, 1)) OR ack < $3) RETURNING id`,
    [userId, stanza, clamp(ack)]);
  return r.rows.length > 0;
}

export function registerAcks({ core, identity, store }: Deps): void {
  const { ctx } = core;
  const q = (sql: string, params: unknown[]) => ctx.db.query(sql, params);
  // Fallback when the ack webhook does not arrive (WAHA lost it, the session restarted): the newest messages of the chat, straight from WAHA. Forward only.
  ctx.routes.post("/chats/acks/refresh", async ({ userId, body }) => {
    await core.owner(userId);
    const chatId = core.chatId(core.obj(body).chatId);
    const ids = await identity.aliases(userId, chatId);
    const pending = new Set((await q(
      `SELECT stanza FROM {{p}}messages WHERE user_id = $1 AND session = $S AND chat_id = ANY($2::text[]) AND from_me AND ack BETWEEN 0 AND 2 AND deleted_at IS NULL AND sent_at > now() - interval '24 hours' LIMIT 100`,
      [userId, ids])).rows.map((x) => String(x.stanza)));
    if (!pending.size) return { updated: 0, pending: 0 };
    let list: unknown[] | null = null;
    for (const target of (await store.route(userId, chatId)).slice(0, 2)) {
      const r = await core.tryWaha<unknown>(userId, "GET", `/api/{session}/chats/${encodeURIComponent(target)}/messages`, { query: { limit: 30, downloadMedia: false } });
      if (Array.isArray(r)) { list = r; break; }
    }
    if (!list) throw ctx.httpError(502, "waha_unavailable", "WAHA could not list the messages of this chat.");
    let updated = 0;
    for (const m of list) {
      const x = m && typeof m === "object" ? (m as Record<string, unknown>) : {}, ack = ackOf(x), stanza = stanzaOf(x.id);
      if (x.fromMe !== true || ack === undefined || !pending.has(stanza)) continue;
      if (await applyAck(core, userId, stanza, ack)) updated++;
    }
    if (updated) core.publish(userId, "message", { chatId: await identity.canonical(userId, ids[0]), ack: true });
    return { updated, pending: pending.size };
  });
}
