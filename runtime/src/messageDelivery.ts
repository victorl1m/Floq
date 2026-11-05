import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { badRequest, notFound } from "./errors.js";
import { neutralizeApprovalMarker } from "./approvalText.js";

/**
 * Delivery of agent-to-agent messages into a target TUI, and the recipient inbox that holds long bodies.
 *
 * Why: one `pty.write` of thousands of characters, with no paste framing, reaches the TUI as a raw keystroke burst.
 * The kernel tty buffer (4095 bytes) and the TUI's own input handling can drop all but the tail of such a burst, so
 * the receiver saw only the end of the message (the reply hint). Long bodies are therefore never typed: they are
 * stored here and the receiver gets a short message with a preview plus `floq inbox read ID`.
 */

/** Longest body typed into a terminal as a whole; anything longer goes through the inbox. */
export const INLINE_MAX_CHARS = 1_500;
export const PREVIEW_CHARS = 300;
/** A message at or below this size is a single plain write (same as before); above it, bracketed paste in chunks. */
export const PLAIN_WRITE_MAX = 200;
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";
export const PASTE_CHUNK_CHARS = 256;
export const CHUNK_DELAY_MS = 10;
export const SUBMIT_DELAY_MS = 400;
export const INBOX_MAX_CHARS = 100_000;

export const sha256Prefix = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Control characters (notably ESC, which could close the paste frame early) never reach a terminal; they become a space. */
export function sanitizeForTerminal(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}

/** Cuts from the start (never from the tail) at a code point boundary, never in the middle of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Splits into chunks of at most `size` UTF-16 units without separating a surrogate pair. Joining gives the input back. */
export function chunkText(text: string, size = PASTE_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * The last bracketed-paste mode the TUI announced (`ESC[?2004h` on, `ESC[?2004l` off) in its recent output;
 * undefined when it never announced either.
 */
export function bracketedPasteState(output: string): boolean | undefined {
  const on = output.lastIndexOf("\u001b[?2004h");
  const off = output.lastIndexOf("\u001b[?2004l");
  if (on < 0 && off < 0) return undefined;
  return on > off;
}

export interface TypeOptions {
  /** Wrap text above PLAIN_WRITE_MAX in bracketed paste markers. */
  bracketed: boolean;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Only the runtime's own approval line (typed after the USER decided in the app) is trusted. Everything else has
   * `[FLOQ APPROVAL` look-alikes neutralized so no agent can forge a user approval for another agent.
   */
  trusted?: boolean;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const chains = new Map<string, Promise<unknown>>();

/** Runs deliveries to the same terminal strictly one after another, so two senders never interleave their chunks. */
export function serialPerTarget<T>(key: string, job: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(job);
  const tail = next.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

/**
 * Types one logical message and submits it. Small text: one plain write. Larger text: ESC[200~ + ordered chunks +
 * ESC[201~ (plain ordered chunks when the TUI has no bracketed paste), a pause, then a separate Enter.
 */
export async function typeMessage(write: (data: string) => void, text: string, options: TypeOptions): Promise<void> {
  const sleep = options.sleep ?? wait;
  const safe = options.trusted ? sanitizeForTerminal(text) : neutralizeApprovalMarker(sanitizeForTerminal(text));
  if (safe.length <= PLAIN_WRITE_MAX) {
    write(safe);
  } else {
    if (options.bracketed) write(PASTE_START);
    const chunks = chunkText(safe);
    for (let i = 0; i < chunks.length; i++) {
      write(chunks[i]);
      if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
    }
    if (options.bracketed) write(PASTE_END);
  }
  await sleep(SUBMIT_DELAY_MS);
  write("\r");
}

export const needsInbox = (body: string) => body.length > INLINE_MAX_CHARS;

/** The body part typed for an inbox message: a preview and how to read the rest. Single line. */
export function inboxPointer(body: string, id: string, chars: number): string {
  const preview = clip(body.replace(/\s+/g, " ").trim(), PREVIEW_CHARS);
  return `${preview} ... [preview only: the full message is ${chars} chars. Read all of it with: floq inbox read ${id}]`;
}

export interface InboxItem { id: string; fromId: string; fromTitle: string; chars: number; sha256: string; createdAt: string }

/** Long agent-to-agent bodies, readable only by the receiving session of the same user. */
export class MessageInbox {
  constructor(private readonly pool: pg.Pool) {}

  async store(userId: string, from: { id: string; title: string }, toSessionId: string, body: string): Promise<{ id: string; chars: number; sha256: string }> {
    if (body.length > INBOX_MAX_CHARS) throw badRequest(`message too large (max ${INBOX_MAX_CHARS} chars)`);
    body = neutralizeApprovalMarker(body);
    const id = randomBytes(8).toString("hex");
    await this.pool.query(
      "INSERT INTO agent_inbox (id, user_id, from_session_id, from_title, to_session_id, body, chars, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, userId, from.id, from.title.slice(0, 120), toSessionId, body, body.length, sha256Prefix(body)],
    );
    return { id, chars: body.length, sha256: sha256Prefix(body) };
  }

  async list(userId: string, sessionId: string): Promise<InboxItem[]> {
    const r = await this.pool.query("SELECT id, from_session_id, from_title, chars, sha256, created_at FROM agent_inbox WHERE user_id = $1 AND to_session_id = $2 ORDER BY created_at DESC, id LIMIT 50", [userId, sessionId]);
    return r.rows.map((x) => ({ id: x.id as string, fromId: x.from_session_id as string, fromTitle: x.from_title as string, chars: Number(x.chars), sha256: x.sha256 as string, createdAt: new Date(x.created_at).toISOString() }));
  }

  /** Only the recipient session (same user) can read. Anything else is a plain 404, never a hint that the id exists. */
  async read(userId: string, sessionId: string, id: unknown): Promise<{ id: string; from: string; fromTitle: string; chars: number; sha256: string; body: string }> {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw badRequest("inbox id must be the 16-character id from the message");
    const r = await this.pool.query("SELECT id, from_session_id, from_title, chars, sha256, body FROM agent_inbox WHERE id = $1 AND user_id = $2 AND to_session_id = $3", [id, userId, sessionId]);
    const row = r.rows[0];
    if (!row) throw notFound("No such message in your inbox");
    return { id: row.id as string, from: row.from_session_id as string, fromTitle: row.from_title as string, chars: Number(row.chars), sha256: row.sha256 as string, body: neutralizeApprovalMarker(row.body as string) };
  }
}


/** Queued messages older than this are not typed any more; approval decisions expire sooner (approvals live 10 min). */
export const OUTBOX_MESSAGE_MAX_AGE_MS = 24 * 60 * 60_000;
export const OUTBOX_APPROVAL_MAX_AGE_MS = 15 * 60_000;

export interface OutboxRow { id: string; userId: string; toSessionId: string; kind: "message" | "approval"; text: string; attempts: number; ageMs: number }

/**
 * Durable queue of everything typed into an agent terminal by the runtime: agent messages and user approval decisions.
 * A row is written BEFORE any delivery attempt and `delivered_at` is set only after the text was typed into a live
 * session, so an asleep, still-starting or restarted target gets it on its next ready instead of losing it.
 */
export class AgentOutbox {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async enqueue(userId: string, toSessionId: string, kind: "message" | "approval", text: string): Promise<string> {
    const id = randomBytes(12).toString("hex");
    await this.pool.query("INSERT INTO agent_outbox (id, user_id, to_session_id, kind, text) VALUES ($1,$2,$3,$4,$5)", [id, userId, toSessionId, kind, text]);
    return id;
  }

  /** Undelivered rows for one session in creation order. */
  async pending(userId: string, sessionId: string): Promise<OutboxRow[]> {
    const r = await this.pool.query("SELECT id, user_id, to_session_id, kind, text, attempts, (extract(epoch from now() - created_at) * 1000)::float8 AS age_ms FROM agent_outbox WHERE user_id = $1 AND to_session_id = $2 AND delivered_at IS NULL AND expired_at IS NULL ORDER BY created_at, id", [userId, sessionId]);
    return r.rows.map((x) => ({ id: x.id as string, userId: x.user_id as string, toSessionId: x.to_session_id as string, kind: x.kind as "message" | "approval", text: x.text as string, attempts: Number(x.attempts), ageMs: Number(x.age_ms) }));
  }

  /** Rows too old to type are marked expired (never typed). */
  async expire(ids: string[]): Promise<void> {
    for (const id of ids) await this.pool.query("UPDATE agent_outbox SET expired_at = now() WHERE id = $1 AND delivered_at IS NULL AND expired_at IS NULL", [id]);
  }

  async attempt(id: string): Promise<void> {
    await this.pool.query("UPDATE agent_outbox SET attempts = attempts + 1 WHERE id = $1 AND delivered_at IS NULL", [id]);
  }

  /** True only for the call that actually flipped the row. */
  async markDelivered(id: string): Promise<boolean> {
    const r = await this.pool.query("UPDATE agent_outbox SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL", [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async isDelivered(id: string): Promise<boolean> {
    const r = await this.pool.query("SELECT delivered_at FROM agent_outbox WHERE id = $1", [id]);
    return r.rows[0]?.delivered_at != null;
  }
}
