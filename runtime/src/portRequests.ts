import { randomUUID } from "node:crypto";
import { badRequest, conflict, notFound } from "./errors.js";

/** How long an agent's `floq port open` waits for the user. Enforced here, never by the client. */
export const PORT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_PENDING_PER_SESSION = 5;
const MAX_PENDING_PER_USER = 20;
const LIVENESS_POLL_MS = 2_000;
const PROTOCOLS = ["http", "https", "tcp"] as const;
export type PortProtocol = (typeof PROTOCOLS)[number];

/** What the user sees. `remainingMs` (not a wall-clock time) lets the client count down without trusting clock sync. */
export interface PortRequestView {
  id: string;
  sessionId: string;
  agentName: string;
  port: number;
  protocol: PortProtocol;
  purpose: string;
  /** Port below 1024: shown with a warning, never auto-approved. */
  privileged: boolean;
  remainingMs: number;
  timeoutMs: number;
}

export type PortRequestStatus = "accepted" | "denied" | "timeout" | "cancelled" | "failed";

export type PortRequestFrame =
  | { type: "port-request"; request: PortRequestView }
  | { type: "port-request-resolved"; id: string; sessionId: string; status: PortRequestStatus };

export interface PortRequestOutcome { status: PortRequestStatus; message: string; port: number; protocol: PortProtocol; localUrl?: string }
export type PortDecision = { decision: "allow" } | { decision: "deny" } | { decision: "error"; message: string };

interface Waiter { resolve: (outcome: PortRequestOutcome) => void }
interface Entry {
  view: Omit<PortRequestView, "remainingMs">;
  userId: string;
  deadline: number;
  waiters: Set<Waiter>;
  timer: NodeJS.Timeout;
  liveness: NodeJS.Timeout;
}

export interface PortRequestInput { sessionId: string; agentName: string; port: unknown; protocol?: unknown; purpose?: unknown }

export interface PortRequestsOptions {
  timeoutMs?: number;
  /** Ports the agent may not ask for (runtime listen port, database, ...). */
  isDenied?: (port: number) => boolean;
  /** False once the requesting session is gone; pending requests are then cancelled. */
  isAlive?: (userId: string, sessionId: string) => boolean;
  livenessMs?: number;
}

export interface PendingPortRequest {
  /** Resolves with the user's decision, a timeout or a cancellation; never rejects. */
  promise: Promise<PortRequestOutcome>;
  /** The waiting `floq` call went away: drop it, and the request when nobody else waits on it. */
  abandon: () => void;
}

const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/** Pending "agent wants a port opened" requests. The user decides; the runtime never opens anything on its own. */
export class PortRequests {
  private readonly pending = new Map<string, Entry>();
  private readonly subs = new Set<{ userId: string; fn: (frame: PortRequestFrame) => void }>();
  private readonly timeoutMs: number;

  constructor(private readonly options: PortRequestsOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? PORT_REQUEST_TIMEOUT_MS;
  }

  subscribe(userId: string, fn: (frame: PortRequestFrame) => void): () => void {
    const sub = { userId, fn };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }

  private emit(userId: string, frame: PortRequestFrame): void {
    for (const sub of this.subs) {
      if (sub.userId !== userId) continue;
      try { sub.fn(frame); } catch { /* a dead socket must not block others */ }
    }
  }

  private view(entry: Entry, now = Date.now()): PortRequestView {
    return { ...entry.view, remainingMs: Math.max(0, entry.deadline - now) };
  }

  /** Pending requests of one user, for a (re)connecting client. */
  list(userId: string): PortRequestView[] {
    const now = Date.now();
    return [...this.pending.values()].filter((e) => e.userId === userId).map((e) => this.view(e, now));
  }

  /** Validate and open a request (throws HttpError for bad input). */
  request(userId: string, input: PortRequestInput): PendingPortRequest {
    const port = input.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("port must be an integer between 1 and 65535", "invalid_port");
    if (this.options.isDenied?.(port)) throw badRequest(`Port ${port} belongs to Floq itself and cannot be opened`, "port_denied");
    const protocol = input.protocol === undefined ? "http" : input.protocol;
    if (!PROTOCOLS.includes(protocol as PortProtocol)) throw badRequest("protocol must be http, https or tcp", "invalid_protocol");
    const purpose = typeof input.purpose === "string" ? clean(input.purpose, 200) : "";

    const attach = (entry: Entry): PendingPortRequest => {
      const waiter = {} as Waiter;
      const promise = new Promise<PortRequestOutcome>((resolve) => { waiter.resolve = resolve; });
      entry.waiters.add(waiter);
      const id = entry.view.id;
      return {
        promise,
        abandon: () => {
          entry.waiters.delete(waiter);
          if (!entry.waiters.size) this.settle(id, "cancelled", "The agent stopped waiting.");
        },
      };
    };

    // The same agent asking again for the same port joins the request already in front of the user.
    let forUser = 0;
    let forSession = 0;
    for (const entry of this.pending.values()) {
      if (entry.userId !== userId) continue;
      if (entry.view.sessionId === input.sessionId) {
        if (entry.view.port === port) return attach(entry);
        forSession++;
      }
      forUser++;
    }
    if (forSession >= MAX_PENDING_PER_SESSION || forUser >= MAX_PENDING_PER_USER) throw conflict("Too many port requests are waiting for the user; wait for them to be answered", "too_many_requests");

    const id = randomUUID();
    const entry: Entry = {
      view: { id, sessionId: input.sessionId, agentName: clean(input.agentName, 80), port, protocol: protocol as PortProtocol, purpose, privileged: port < 1024, timeoutMs: this.timeoutMs },
      userId,
      deadline: Date.now() + this.timeoutMs,
      waiters: new Set(),
      timer: setTimeout(() => this.settle(id, "timeout", `No response within ${Math.round(this.timeoutMs / 1000)}s; request cancelled and port ${port} was not opened.`), this.timeoutMs),
      liveness: setInterval(() => {
        if (this.options.isAlive && !this.options.isAlive(userId, input.sessionId)) this.settle(id, "cancelled", "The agent session ended before the user answered.");
      }, this.options.livenessMs ?? LIVENESS_POLL_MS),
    };
    entry.timer.unref();
    entry.liveness.unref();
    this.pending.set(id, entry);
    const handle = attach(entry);
    this.emit(userId, { type: "port-request", request: this.view(entry) });
    return handle;
  }

  /** Apply the user's answer. Throws 404 when the request is gone (expired, cancelled or answered elsewhere). */
  resolve(userId: string, id: string, decision: PortDecision): PortRequestStatus {
    const entry = this.pending.get(id);
    if (!entry || entry.userId !== userId) throw notFound("That port request is no longer pending (it may have expired)");
    const { port, protocol } = entry.view;
    if (decision.decision === "allow") {
      this.settle(id, "accepted", `The user allowed it. localhost:${port} on the user's computer now forwards to port ${port} in this session (${protocol}).`, `${protocol === "tcp" ? "tcp" : protocol}://localhost:${port}`);
      return "accepted";
    }
    if (decision.decision === "deny") {
      this.settle(id, "denied", "user denied");
      return "denied";
    }
    this.settle(id, "failed", `The user allowed it, but the port could not be opened on their computer: ${clean(String(decision.message ?? "unknown error"), 200)}`);
    return "failed";
  }

  /** Cancel everything a session is waiting on (it exited or was deleted). */
  cancelSession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.view.sessionId === sessionId) this.settle(id, "cancelled", "The agent session ended before the user answered.");
    }
  }

  private settle(id: string, status: PortRequestStatus, message: string, localUrl?: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    clearInterval(entry.liveness);
    const outcome: PortRequestOutcome = { status, message, port: entry.view.port, protocol: entry.view.protocol, ...(localUrl ? { localUrl } : {}) };
    for (const waiter of entry.waiters) waiter.resolve(outcome);
    this.emit(entry.userId, { type: "port-request-resolved", id, sessionId: entry.view.sessionId, status });
  }
}
