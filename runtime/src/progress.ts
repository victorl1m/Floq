import type pg from "pg";
import { badRequest } from "./errors.js";
import { neutralizeApprovalMarker } from "./approvalText.js";
import { clip, inboxPointer, sanitizeForTerminal } from "./messageDelivery.js";

/**
 * Structured progress channel between a subagent and whoever watches it (`floq progress`, `floq ask-parent`,
 * `floq watch`). Cheap append-only rows per session with a monotonically increasing cursor (`seq`), so a watcher
 * polls with `since=<cursor>` and only ever receives NEW events. Pushes into the parent terminal reuse the outbox.
 */
export const PROGRESS_STATUSES = ["working", "blocked", "done"] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
export type ProgressKind = "progress" | "question";
/** Same cap as `floq ask` (and under the request body limit): a progress text is stored whole or rejected, never cut. */
export const PROGRESS_MESSAGE_MAX = 20_000;
/** Max events one session may write per minute (spam guard), and max pushes typed into the parent per minute. */
export const PROGRESS_RATE_PER_MIN = 30;
export const PUSH_RATE_PER_MIN = 6;
export const WATCH_MAX_WAIT_SEC = 30;
export const WATCH_PAGE = 50;

export interface ProgressEvent { seq: number; kind: ProgressKind; status: ProgressStatus; percent: number | null; message: string; at: string }

export function cleanProgressMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest("message required");
  const clean = neutralizeApprovalMarker(sanitizeForTerminal(value)).replace(/\s+/g, " ").trim();
  if (clean.length > PROGRESS_MESSAGE_MAX) throw badRequest(`message too long (${clean.length} chars, max ${PROGRESS_MESSAGE_MAX}): put the text in a file and send it with --file PATH`);
  return clean;
}

export function cleanPercent(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest("percent must be a number from 0 to 100");
  return Math.round(n);
}

export function cleanStatus(value: unknown, fallback: ProgressStatus = "working"): ProgressStatus {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (PROGRESS_STATUSES as readonly string[]).includes(value)) return value as ProgressStatus;
  throw badRequest("status must be working, blocked or done");
}

/**
 * One-line push typed into the parent terminal. A short message is typed whole; a long one (needsInbox) is passed as
 * `inbox` (already stored for the parent) and typed as a preview plus `floq inbox read ID`, never cut silently.
 */
export function pushLine(child: { id: string; title: string }, event: Pick<ProgressEvent, "kind" | "status" | "percent" | "message">, inbox?: { id: string; chars: number }): string {
  const what = event.kind === "question" ? "QUESTION" : event.status.toUpperCase();
  const pct = event.percent === null ? "" : ` ${event.percent}%`;
  const body = inbox ? inboxPointer(event.message, inbox.id, inbox.chars) : event.message;
  const tail = event.kind === "question" ? `answer with: floq ask ${child.id} "..." --no-wait` : `details: floq watch ${child.id}`;
  return `[Floq ${what}${pct} from subagent ${clip(child.title, 60)} (${child.id})] ${body} -- ${tail}`;
}

export class AgentProgress {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  private async recent(userId: string, sessionId: string, kinds: string, seconds = 60): Promise<number> {
    const r = await this.pool.query(`SELECT count(*)::int AS n FROM agent_progress WHERE user_id = $1 AND session_id = $2 AND ${kinds} AND created_at > now() - ($3 || ' seconds')::interval`, [userId, sessionId, String(seconds)]);
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Appends an event; throws 429-style badRequest when the session writes too fast. Returns whether a push is allowed. */
  async add(userId: string, sessionId: string, event: { kind: ProgressKind; status: ProgressStatus; percent: number | null; message: string }): Promise<{ event: ProgressEvent; push: boolean }> {
    if (await this.recent(userId, sessionId, "true") >= PROGRESS_RATE_PER_MIN) throw badRequest(`progress rate limit: at most ${PROGRESS_RATE_PER_MIN} updates per minute; send fewer, larger updates`);
    const wantsPush = event.kind === "question" || event.status !== "working";
    let push = false;
    if (wantsPush) {
      const last = await this.pool.query("SELECT kind, status, message FROM agent_progress WHERE user_id = $1 AND session_id = $2 AND (kind = 'question' OR status <> 'working') AND created_at > now() - interval '60 seconds' ORDER BY seq DESC LIMIT 1", [userId, sessionId]);
      const dup = last.rows[0] && last.rows[0].kind === event.kind && last.rows[0].status === event.status && last.rows[0].message === event.message;
      push = !dup && (await this.recent(userId, sessionId, "(kind = 'question' OR status <> 'working')")) < PUSH_RATE_PER_MIN;
    }
    const r = await this.pool.query("INSERT INTO agent_progress (user_id, session_id, kind, status, percent, message) VALUES ($1,$2,$3,$4,$5,$6) RETURNING seq, created_at", [userId, sessionId, event.kind, event.status, event.percent, event.message]);
    return { event: { seq: Number(r.rows[0].seq), at: new Date(r.rows[0].created_at).toISOString(), ...event }, push };
  }

  /** Events of one session with seq > since (oldest first, one page). `cursor` is the value to pass next time. */
  async since(userId: string, sessionId: string, since: number): Promise<{ events: ProgressEvent[]; cursor: number }> {
    const r = await this.pool.query("SELECT seq, kind, status, percent, message, created_at FROM agent_progress WHERE user_id = $1 AND session_id = $2 AND seq > $3 ORDER BY seq LIMIT $4", [userId, sessionId, since, WATCH_PAGE]);
    const events = r.rows.map((x) => ({ seq: Number(x.seq), kind: x.kind as ProgressKind, status: x.status as ProgressStatus, percent: x.percent === null ? null : Number(x.percent), message: x.message as string, at: new Date(x.created_at).toISOString() }));
    return { events, cursor: events.length ? events[events.length - 1].seq : since };
  }

  async latestSeq(userId: string, sessionId: string): Promise<number> {
    const r = await this.pool.query("SELECT coalesce(max(seq), 0) AS m FROM agent_progress WHERE user_id = $1 AND session_id = $2", [userId, sessionId]);
    return Number(r.rows[0]?.m ?? 0);
  }
}
