import { createHash } from "node:crypto";
import type pg from "pg";
import { HttpError, badRequest, notFound } from "./errors.js";
import { log } from "./logger.js";
import { APPROVAL_ID, actionHash, cleanActionText, cleanDetailText, formatApprovalLine, formatRequesterNotice, isIrreversibleAction, newApprovalId } from "./approvalText.js";

/**
 * User approvals for irreversible or outward-facing agent actions.
 *
 * Trust model: an approval comes into existence only through `resolve(userId, id, ...)`, which the HTTP layer calls
 * from the user's authenticated app session (never from the per-session agent token used by `floq`). Agents can
 * request, poll, verify and cancel; they can never grant. The runtime itself types the decision into the target's
 * terminal, and the target proves it with `floq approval verify <id> --consume`, which asks this module.
 */

export const APPROVAL_DEFAULT_TTL_MS = 10 * 60_000;
export const APPROVAL_MIN_TTL_MS = 30_000;
export const APPROVAL_MAX_TTL_MS = 60 * 60_000;
export const ACTION_MAX = 200;
export const DETAIL_MAX = 1_000;
export const MAX_PENDING_PER_SESSION = 3;
export const MAX_PENDING_PER_USER = 12;
export const RATE_WINDOW_MS = 10 * 60_000;
export const RATE_MAX_PER_WINDOW = 10;
const ACTIVE_POLL_MS = 90_000;
/**
 * A request made with `floq approval request --wait` has a waiter that long-polls status (each poll lasts at most 55 s).
 * When no poll arrives for this long the waiter is gone (interrupted, killed, timed out), so nobody would act on an
 * answer: the request is withdrawn instead of staying on the user's screen, where a late Allow would grant to no one.
 */
export const WAITER_GONE_MS = 75_000;
/** Pending requests never expire on a clock: the user answers yes or no. This far-future instant only fills the stored expiry. */
const NEVER_MS = 10 * 365 * 24 * 3_600_000;

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired" | "cancelled" | "consumed";

/** `kind: "plugin"` marks a requester that is a Floq plugin, not an agent session: nothing is typed into a terminal and no liveness check applies. */
/**
 * `agent_approvals.requester_session_id/target_session_id` are UUID columns, and a plugin requester has no session. Persist a stable
 * name-based (v5-style) UUID of its id instead; the real id and `kind: "plugin"` stay in `meta`, which is what `load()` reads back.
 */
export function persistedPartyId(agent: { id: string; kind?: string }): string {
  if (agent.kind !== "plugin") return agent.id;
  const h = createHash("sha1").update("floq-plugin-approval:" + agent.id).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** How long a plugin waits for the user before giving up (the approval is withdrawn). Nothing else bounds a pending approval. */
export const PLUGIN_APPROVAL_WAIT_MS = 10 * 60_000;

export interface ApprovalAgent { id: string; name: string; provider: "claude" | "codex"; projectId: string | null; projectName: string | null; kind?: "agent" | "plugin" }

export interface ApprovalRecord {
  id: string;
  userId: string;
  requester: ApprovalAgent;
  target: ApprovalAgent;
  action: string;
  actionHash: string;
  detail: string;
  irreversible: boolean;
  status: ApprovalStatus;
  createdAt: number;
  /** The user has until here to answer. */
  expiresAt: number;
  /** After Allow: how long the single-use grant can still be verified. */
  validUntil: number | null;
  decidedAt: number | null;
  ttlMs: number;
  /** Requested with --wait: withdrawn when the waiter stops polling (see WAITER_GONE_MS). */
  waiter?: boolean;
}

/** What the user's app shows. */
export interface ApprovalView {
  id: string;
  requester: ApprovalAgent;
  target: ApprovalAgent;
  action: string;
  detail: string;
  irreversible: boolean;
  createdAt: string;
  expiresAt: string;
  remainingMs: number;
  timeoutMs: number;
}

export type ApprovalFrame =
  | { type: "approval-request"; approval: ApprovalView }
  | { type: "approval-resolved"; id: string; status: ApprovalStatus; requesterSessionId: string; targetSessionId: string };

export type VerifyStatus = "GRANTED" | "DENIED" | "EXPIRED" | "CONSUMED" | "PENDING" | "CANCELLED" | "UNKNOWN" | "ACTION_MISMATCH";
export interface VerifyResult {
  status: VerifyStatus;
  /** True only when this exact call authorizes the caller to act: GRANTED, for the caller's own session, action matching when given. */
  valid: boolean;
  id: string;
  action?: string;
  targetSessionId?: string;
  targetName?: string;
  validUntil?: string;
  consumed?: boolean;
  message: string;
}

export interface ApprovalsOptions {
  pool?: Pick<pg.Pool, "query">;
  now?: () => number;
  /** Redacts secret values of the given sessions from text. */
  scrub?: (userId: string, sessionIds: string[], text: string) => Promise<string>;
  /** False once the requesting session is gone: its pending requests are then cancelled. */
  isAlive?: (userId: string, sessionId: string) => boolean;
  /** Types text into a session's terminal as the runtime (trusted). Called after the user decided. Errors are logged, never thrown. */
  deliver?: (userId: string, sessionId: string, text: string) => Promise<boolean>;
  livenessMs?: number;
}

export interface RequestInput {
  requester: ApprovalAgent;
  target: ApprovalAgent;
  action: unknown;
  detail?: unknown;
  ttlSec?: unknown;
  /** True when the requester blocks on the answer (`--wait`). */
  waiting?: unknown;
}

interface Timers { expiry?: NodeJS.Timeout; liveness?: NodeJS.Timeout }

export class Approvals {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly timers = new Map<string, Timers>();
  private readonly polled = new Map<string, number>();
  private readonly changes = new Set<() => void>();
  private readonly requests = new Map<string, number[]>();
  private readonly subs = new Set<{ userId: string; fn: (frame: ApprovalFrame) => void }>();
  private readonly now: () => number;

  constructor(private readonly options: ApprovalsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** At startup: requests that were waiting when the runtime stopped cannot be answered any more. */
  async init(): Promise<void> {
    try { await this.options.pool?.query("UPDATE agent_approvals SET status='expired' WHERE status='pending'"); } catch (error) { log.warn("approval.init_failed", { error: String(error).slice(0, 120) }); }
  }

  subscribe(userId: string, fn: (frame: ApprovalFrame) => void): () => void {
    const sub = { userId, fn };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }

  private emit(userId: string, frame: ApprovalFrame): void {
    for (const sub of this.subs) {
      if (sub.userId !== userId) continue;
      try { sub.fn(frame); } catch { /* a dead socket must not block others */ }
    }
  }

  private view(a: ApprovalRecord, now = this.now()): ApprovalView {
    return {
      id: a.id, requester: a.requester, target: a.target, action: a.action, detail: a.detail, irreversible: a.irreversible,
      createdAt: new Date(a.createdAt).toISOString(), expiresAt: new Date(a.expiresAt).toISOString(), remainingMs: Math.max(0, a.expiresAt - now), timeoutMs: a.ttlMs,
    };
  }

  private ids(a: ApprovalRecord) {
    return { approvalId: a.id, userId: a.userId, requesterSessionId: a.requester.id, targetSessionId: a.target.id, requesterProjectId: a.requester.projectId, targetProjectId: a.target.projectId, actionHash: a.actionHash };
  }

  private persist(a: ApprovalRecord): void {
    const pool = this.options.pool;
    if (!pool) return;
    const meta = JSON.stringify({ requester: a.requester, target: a.target, irreversible: a.irreversible, ttlMs: a.ttlMs });
    void Promise.resolve(pool.query(
      `INSERT INTO agent_approvals (id,user_id,requester_session_id,target_session_id,requester_project_id,target_project_id,action,action_hash,detail,status,meta,created_at,expires_at,valid_until,decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,to_timestamp($12/1000.0),to_timestamp($13/1000.0),to_timestamp($14/1000.0),to_timestamp($15/1000.0))
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, valid_until=EXCLUDED.valid_until, decided_at=EXCLUDED.decided_at`,
      [a.id, a.userId, persistedPartyId(a.requester), persistedPartyId(a.target), a.requester.projectId, a.target.projectId, a.action, a.actionHash, a.detail, a.status, meta, a.createdAt, a.expiresAt, a.validUntil, a.decidedAt],
    )).catch((error) => log.warn("approval.persist_failed", { approvalId: a.id, error: String(error).slice(0, 120) }));
  }

  /** Looks the record up in memory, then in the database (after a restart). Applies lazy expiry. */
  private async load(id: string): Promise<ApprovalRecord | undefined> {
    let a = this.records.get(id);
    if (!a && this.options.pool && APPROVAL_ID.test(id)) {
      try {
        const r = await this.options.pool.query("SELECT id,user_id,action,action_hash,detail,status,meta,(extract(epoch from created_at)*1000)::float8 AS created_ms,(extract(epoch from expires_at)*1000)::float8 AS expires_ms,(extract(epoch from valid_until)*1000)::float8 AS valid_ms,(extract(epoch from decided_at)*1000)::float8 AS decided_ms FROM agent_approvals WHERE id=$1", [id]);
        const row = r.rows[0];
        if (row) {
          const meta = row.meta as { requester: ApprovalAgent; target: ApprovalAgent; irreversible: boolean; ttlMs: number };
          a = { id: row.id, userId: row.user_id, requester: meta.requester, target: meta.target, action: row.action, actionHash: row.action_hash, detail: row.detail, irreversible: meta.irreversible, status: row.status, createdAt: Number(row.created_ms), expiresAt: Number(row.expires_ms), validUntil: row.valid_ms == null ? null : Number(row.valid_ms), decidedAt: row.decided_ms == null ? null : Number(row.decided_ms), ttlMs: meta.ttlMs };
          this.records.set(id, a);
        }
      } catch { /* treated as unknown */ }
    }
    if (a) this.refresh(a);
    return a;
  }

  /** Server-side expiry: independent of any client, timer or clock in the app. */
  private refresh(a: ApprovalRecord): void {
    const t = this.now();
    if (a.status === "pending" && a.waiter && t - (this.polled.get(a.id) ?? a.createdAt) >= WAITER_GONE_MS) {
      log.info("agent.approval_waiter_gone", this.ids(a));
      this.settle(a, "cancelled");
    }
    else if (a.status === "granted" && a.validUntil != null && t >= a.validUntil) this.settle(a, "expired");
  }

  private settle(a: ApprovalRecord, status: ApprovalStatus): void {
    const wasPending = a.status === "pending";
    a.status = status;
    if (status !== "pending") a.decidedAt ??= this.now();
    const timers = this.timers.get(a.id);
    if (timers && status !== "granted") { clearTimeout(timers.expiry); clearInterval(timers.liveness); this.timers.delete(a.id); }
    this.persist(a);
    log.info("agent.approval_" + (status === "granted" ? "granted" : status === "denied" ? "denied" : status === "consumed" ? "consumed" : status === "cancelled" ? "cancelled" : "expired"), this.ids(a));
    if (wasPending || status === "expired" || status === "cancelled") this.emit(a.userId, { type: "approval-resolved", id: a.id, status, requesterSessionId: a.requester.id, targetSessionId: a.target.id });
    for (const fn of [...this.changes]) fn();
  }

  /** Pending requests of one user (for a connecting client). */
  list(userId: string): ApprovalView[] {
    const t = this.now();
    const out: ApprovalView[] = [];
    for (const a of this.records.values()) {
      if (a.userId !== userId) continue;
      this.refresh(a);
      if (a.status === "pending") out.push(this.view(a, t));
    }
    return out.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
  }

  /** Agent side: validate and open a request. An identical pending request from the same requester is returned, not duplicated. */
  async request(userId: string, input: RequestInput): Promise<{ approval: ApprovalView; id: string; deduped: boolean }> {
    if (typeof input.action !== "string" || !input.action.trim()) throw badRequest("action required: say exactly what you want to do, e.g. --action \"git push origin main\"", "invalid_action");
    if (input.detail !== undefined && typeof input.detail !== "string") throw badRequest("detail must be text", "invalid_detail");
    const ids = [input.requester.id, input.target.id];
    const scrub = async (text: string) => (this.options.scrub ? this.options.scrub(userId, ids, text) : text);
    const action = cleanActionText(await scrub(cleanActionText(input.action, 2000)), ACTION_MAX);
    const detail = typeof input.detail === "string" ? cleanDetailText(await scrub(cleanDetailText(input.detail, 4000)), DETAIL_MAX) : "";
    if (!action) throw badRequest("action is empty after cleaning", "invalid_action");
    const hash = actionHash(action);
    const t = this.now();

    // The user decides when to answer: nothing expires while pending. ttlMs is only how long a GRANT stays usable.
    const ttlMs = APPROVAL_DEFAULT_TTL_MS;
    // 0 = "no timeout" (what the CLI sends when --timeout is omitted).
    if (input.ttlSec !== undefined && input.ttlSec !== null && input.ttlSec !== "" && input.ttlSec !== 0) {
      const sec = Number(input.ttlSec);
      if (!Number.isFinite(sec) || sec <= 0) throw badRequest("timeout must be a positive number of seconds", "invalid_timeout");
      // accepted for older agents, but no longer limits how long the request waits
    }

    let forSession = 0;
    let forUser = 0;
    for (const a of this.records.values()) {
      if (a.userId !== userId) continue;
      this.refresh(a);
      if (a.status !== "pending") continue;
      if (a.requester.id === input.requester.id && a.target.id === input.target.id && a.actionHash === hash) {
        if (input.waiting === true) { a.waiter = true; this.polled.set(a.id, t); }
        return { approval: this.view(a, t), id: a.id, deduped: true };
      }
      if (a.requester.id === input.requester.id) forSession++;
      forUser++;
    }
    if (forSession >= MAX_PENDING_PER_SESSION || forUser >= MAX_PENDING_PER_USER) throw new HttpError(409, "too_many_approvals", "Too many approval requests are waiting for the user. Wait for them to be answered (or cancel some) before asking again.");
    const recent = (this.requests.get(input.requester.id) ?? []).filter((at) => t - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX_PER_WINDOW) throw new HttpError(429, "approval_rate", `Rate limit: at most ${RATE_MAX_PER_WINDOW} approval requests per ${RATE_WINDOW_MS / 60_000} minutes per agent. Tell the user in your answer instead.`);
    recent.push(t);
    this.requests.set(input.requester.id, recent);

    const id = newApprovalId();
    const a: ApprovalRecord = { id, userId, requester: input.requester, target: input.target, action, actionHash: hash, detail, irreversible: isIrreversibleAction(action + " " + detail), status: "pending", createdAt: t, expiresAt: t + NEVER_MS, validUntil: null, decidedAt: null, ttlMs, waiter: input.waiting === true };
    this.records.set(id, a);
    if (a.waiter) this.polled.set(id, t);
    const timers: Timers = {
      liveness: setInterval(() => {
        if (input.requester.kind !== "plugin" && this.options.isAlive && !this.options.isAlive(userId, input.requester.id)) { if (a.status === "pending") this.settle(a, "cancelled"); }
        else this.refresh(a);
      }, this.options.livenessMs ?? 2_000),
    };
    timers.liveness?.unref();
    this.timers.set(id, timers);
    this.persist(a);
    log.info("agent.approval_requested", { ...this.ids(a), irreversible: a.irreversible, ttlSec: Math.round(ttlMs / 1000) });
    const view = this.view(a, t);
    this.emit(userId, { type: "approval-request", approval: view });
    return { approval: view, id, deduped: false };
  }

  /**
   * USER side only. The caller (HTTP layer) must have authenticated `userId` with the user's app session.
   * Throws 404 when the id is unknown to this user, 409 when it is no longer pending.
   */
  async resolve(userId: string, id: string, decision: unknown): Promise<{ status: ApprovalStatus }> {
    if (decision !== "allow" && decision !== "deny") throw badRequest("decision must be allow or deny", "invalid_decision");
    const a = typeof id === "string" ? await this.load(id) : undefined;
    if (!a || a.userId !== userId) throw notFound("That approval request is no longer pending (it may have expired)");
    if (a.status !== "pending") throw new HttpError(409, "not_pending", "That approval request is no longer pending (it may have expired)");
    const t = this.now();
    a.decidedAt = t;
    if (decision === "allow") {
      a.validUntil = t + Math.min(a.ttlMs, APPROVAL_DEFAULT_TTL_MS);
      const timers = this.timers.get(a.id);
      if (timers) { clearTimeout(timers.expiry); clearInterval(timers.liveness); timers.expiry = setTimeout(() => this.refresh(a), a.validUntil - t + 20); timers.expiry.unref(); }
    }
    this.settle(a, decision === "allow" ? "granted" : "denied");
    void this.announce(a);
    return { status: a.status };
  }

  /** The runtime types the decision (marked as issued by the user) into the target, and a short notice into the requester. */
  private async announce(a: ApprovalRecord): Promise<void> {
    const deliver = this.options.deliver;
    if (!deliver || a.target.kind === "plugin") return;
    const decision = a.status === "granted" ? "granted" : "denied";
    const base = { id: a.id, action: a.action, decision, validUntil: a.validUntil ?? 0 } as const;
    try {
      await deliver(a.userId, a.target.id, formatApprovalLine(base));
      log.info("agent.approval_delivered", { ...this.ids(a), decision });
    } catch (error) { log.warn("approval.deliver_failed", { ...this.ids(a), error: String(error).slice(0, 120) }); }
    if (a.requester.id !== a.target.id && !this.requesterWaiting(a.id)) {
      try { await deliver(a.userId, a.requester.id, formatRequesterNotice({ ...base, forTarget: { name: a.target.name } })); } catch { /* best effort */ }
    }
  }

  private requesterWaiting(id: string): boolean {
    return this.now() - (this.polled.get(id) ?? 0) < ACTIVE_POLL_MS;
  }

  /** Requester (or target) asks for the state; optionally waits up to `waitMs` for it to leave "pending". */
  async status(userId: string, sessionId: string, id: unknown, waitMs = 0): Promise<{ id: string; status: ApprovalStatus | "unknown"; action?: string; target?: string; targetSessionId?: string; expiresAt?: string; validUntil?: string; message: string }> {
    let a = typeof id === "string" ? await this.load(id) : undefined;
    if (!a || a.userId !== userId || (a.requester.id !== sessionId && a.target.id !== sessionId)) return { id: String(id).slice(0, 40), status: "unknown", message: "UNKNOWN: no such approval request for this session" };
    this.polled.set(a.id, this.now());
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 55_000));
    while (a.status === "pending" && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => { this.changes.delete(done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, Math.min(1_000, Math.max(1, deadline - Date.now())));
        this.changes.add(done);
      });
      this.refresh(a);
      this.polled.set(a.id, this.now());
    }
    const message = a.status === "pending" ? "pending: the user has not answered yet"
      : a.status === "granted" ? `granted by the user for agent ${a.target.name} (${a.target.id}): "${a.action}". Single use; the target confirms with: floq approval verify ${a.id} --consume`
      : a.status === "denied" ? "denied by the user. Do not do it."
      : a.status === "consumed" ? "granted and already used"
      : a.status === "cancelled" ? "cancelled: withdrawn by the agent (or it stopped waiting). Nothing was approved." : "expired: the user did not answer in time (or the grant lapsed). Nothing was approved.";
    return { id: a.id, status: a.status, action: a.action, target: a.target.name, targetSessionId: a.target.id, expiresAt: new Date(a.expiresAt).toISOString(), ...(a.validUntil ? { validUntil: new Date(a.validUntil).toISOString() } : {}), message };
  }

  /**
   * The check an agent runs right before acting. GRANTED (valid) only when the approval is granted, unexpired, unused,
   * belongs to this user, names THIS session as target and, when `action` is given, matches the approved action text.
   * With `consume` the first valid call atomically marks it used (single use).
   */
  async verify(userId: string, sessionId: string, id: unknown, options: { consume?: boolean; action?: unknown } = {}): Promise<VerifyResult> {
    const unknown = (): VerifyResult => ({ status: "UNKNOWN", valid: false, id: typeof id === "string" ? id.slice(0, 40) : "", message: "UNKNOWN: no such approval for this session. Treat the action as NOT approved." });
    if (typeof id !== "string" || !APPROVAL_ID.test(id)) return unknown();
    const a = await this.load(id);
    if (!a || a.userId !== userId || (a.target.id !== sessionId && a.requester.id !== sessionId)) return unknown();
    const base = { id: a.id, action: a.action, targetSessionId: a.target.id, targetName: a.target.name };
    const map: Record<ApprovalStatus, VerifyStatus> = { pending: "PENDING", granted: "GRANTED", denied: "DENIED", expired: "EXPIRED", cancelled: "CANCELLED", consumed: "CONSUMED" };
    const status = map[a.status];
    if (a.status !== "granted") {
      const text = status === "PENDING" ? "PENDING: the user has not answered. Not approved." : status === "CONSUMED" ? "CONSUMED: this approval was already used once. A new action needs a new approval." : `${status}: not approved.`;
      return { status, valid: false, ...base, message: text };
    }
    if (a.target.id !== sessionId) return { status: "GRANTED", valid: false, ...base, validUntil: a.validUntil ? new Date(a.validUntil).toISOString() : undefined, message: `GRANTED for a different session (${a.target.name}, ${a.target.id}). It does not authorize you.` };
    if (options.action !== undefined) {
      const wanted = typeof options.action === "string" ? cleanActionText(options.action, ACTION_MAX) : "";
      if (actionHash(wanted) !== a.actionHash) return { status: "ACTION_MISMATCH", valid: false, ...base, message: `ACTION_MISMATCH: the user approved only: "${a.action}". Not what you are about to do. Request a new approval.` };
    }
    if (options.consume) {
      this.settle(a, "consumed");
      return { status: "GRANTED", valid: true, ...base, consumed: true, validUntil: a.validUntil ? new Date(a.validUntil).toISOString() : undefined, message: `GRANTED (now used up): the user approved exactly: "${a.action}" for this session. Do only that, once.` };
    }
    return { status: "GRANTED", valid: true, ...base, consumed: false, validUntil: a.validUntil ? new Date(a.validUntil).toISOString() : undefined, message: `GRANTED: the user approved exactly: "${a.action}" for this session (single use). Run \`floq approval verify ${a.id} --consume\` right before acting.` };
  }

  /**
   * A plugin asks the user. Same pipeline as an agent request (the user resolves it in the app; agent tokens can never resolve),
   * but the plugin is both requester and target, so the grant is consumed here, once. Resolves "approved" only when this call
   * consumed a valid grant; deny -> "denied"; everything else (expiry, cancel, abort, plugin stopped) -> "expired".
   */
  async askAsPlugin(userId: string, plugin: { id: string; name: string }, input: { action: unknown; detail?: unknown }, signal?: AbortSignal, timeoutMs = PLUGIN_APPROVAL_WAIT_MS): Promise<"approved" | "denied" | "expired"> {
    const who: ApprovalAgent = { id: "plugin:" + plugin.id, name: plugin.name, provider: "claude", projectId: null, projectName: null, kind: "plugin" };
    const { id } = await this.request(userId, { requester: who, target: who, action: input.action, detail: input.detail, waiting: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted || Date.now() >= deadline) { await this.cancel(userId, who.id, id).catch(() => undefined); return "expired"; }
      const st = await this.status(userId, who.id, id, Math.min(5_000, Math.max(1, deadline - Date.now())));
      if (st.status === "pending") continue;
      if (st.status === "granted") return (await this.verify(userId, who.id, id, { consume: true })).valid ? "approved" : "expired";
      return st.status === "denied" ? "denied" : "expired";
    }
  }

  /** The requester withdraws a pending request. */
  async cancel(userId: string, sessionId: string, id: unknown): Promise<{ status: ApprovalStatus }> {
    const a = typeof id === "string" ? await this.load(id) : undefined;
    if (!a || a.userId !== userId || a.requester.id !== sessionId) throw notFound("No such approval request from this session");
    if (a.status === "pending") this.settle(a, "cancelled");
    return { status: a.status };
  }

  /** Session ended or was deleted: drop what it was waiting on. */
  cancelSession(sessionId: string): void {
    for (const a of this.records.values()) if (a.status === "pending" && a.requester.id === sessionId) this.settle(a, "cancelled");
  }

  /** Test helper: run lazy expiry for all records now. */
  sweep(): void {
    for (const a of this.records.values()) this.refresh(a);
  }
}
