import type pg from "pg";
import { HttpError, badRequest, notFound } from "./errors.js";

export type LinkKind = "recruit" | "message" | "manual";
export type MessageEventKind = "ask" | "reply" | "recruit";

export interface AgentLink {
  id: string;
  projectId: string | null;
  fromSessionId: string;
  toSessionId: string;
  kind: LinkKind;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  /** Set when the wire joins an agent of another project: the end that is NOT in the project the list was requested for. */
  foreign?: { sessionId: string; title: string; projectId: string | null; projectName: string; direction: "out" | "in" };
}

/** Present on events for messages that crossed projects (drives the "Agent A messaged Agent B in project X" toast). */
export interface CrossProjectInfo { fromTitle: string; toTitle: string; fromProject: string; toProject: string; toProjectId?: string | null }

export interface AgentMessageEvent {
  type: "agent-message";
  linkId: string;
  fromSessionId: string;
  toSessionId: string;
  projectId: string | null;
  kind: MessageEventKind;
  preview: string;
  at: string;
  cross?: CrossProjectInfo;
}

export const PREVIEW_CHARS = 200;
export const EVENTS_PER_PROJECT = 200;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const UUID = /^[0-9a-f-]{36}$/i;

/** Single line, first meaningful text, at most PREVIEW_CHARS (ellipsis included). */
export function makePreview(text: string | null | undefined, max = PREVIEW_CHARS): string {
  const one = String(text ?? "").replace(ANSI, "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

/** Upsert semantics (mirrors the SQL): an existing link keeps its kind; counters only move on a sent message. */
export type Bump = "message" | "reply" | "none";
export function mergeLink(
  existing: AgentLink | null,
  kind: LinkKind,
  bump: Bump,
  now: string,
  make: () => Pick<AgentLink, "id" | "projectId" | "fromSessionId" | "toSessionId">,
): AgentLink {
  const base: AgentLink = existing ?? { ...make(), kind, createdAt: now, lastMessageAt: null, messageCount: 0 };
  return {
    ...base,
    messageCount: base.messageCount + (bump === "message" ? 1 : 0),
    lastMessageAt: bump === "none" ? base.lastMessageAt : now,
  };
}

interface SessionRef { id: string; user_id: string; project_id: string | null }

/** Manual links: both sessions must belong to the caller, be distinct and share a project. */
export function authorizeManualLink(userId: string, from: SessionRef | undefined, to: SessionRef | undefined): void {
  if (!from || !to || from.user_id !== userId || to.user_id !== userId) throw notFound("Session not found");
  if (from.id === to.id) throw badRequest("An agent cannot be linked to itself", "self_link");
  if ((from.project_id ?? null) !== (to.project_id ?? null)) throw new HttpError(403, "other_project", "Agents are in different projects");
}

/** Per-project ring buffer of recent events, scoped by owning user, plus live subscribers. */
export class EventHub {
  private readonly buffers = new Map<string, Array<{ userId: string; event: AgentMessageEvent }>>();
  private readonly subs = new Set<{ userId: string; fn: (event: AgentMessageEvent) => void }>();
  constructor(private readonly cap = EVENTS_PER_PROJECT) {}

  publish(userId: string, event: AgentMessageEvent): void {
    const key = event.projectId ?? "";
    const buf = this.buffers.get(key) ?? [];
    buf.push({ userId, event });
    if (buf.length > this.cap) buf.splice(0, buf.length - this.cap);
    this.buffers.set(key, buf);
    for (const sub of this.subs) {
      if (sub.userId !== userId) continue;
      try { sub.fn(event); } catch { /* a dead socket must not block others */ }
    }
  }

  /** Oldest first. `projectId` "none" addresses sessions without a registered project. */
  recent(userId: string, projectId: string, limit = 50): AgentMessageEvent[] {
    const buf = this.buffers.get(projectId === "none" ? "" : projectId) ?? [];
    const mine = buf.filter((e) => e.userId === userId).map((e) => e.event);
    return mine.slice(-Math.max(1, Math.min(limit, this.cap)));
  }

  subscribe(userId: string, fn: (event: AgentMessageEvent) => void): () => void {
    const sub = { userId, fn };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }
}

const COLS = "l.id, l.project_id, l.from_session_id, l.to_session_id, l.kind, l.created_at, l.last_message_at, l.message_count";
const FOREIGN_COLS = "f.project_id AS f_project, t.project_id AS t_project, f.title AS f_title, t.title AS t_title, fp.name AS f_pname, tp.name AS t_pname";

function toLink(r: Record<string, unknown>, viewProject?: string | null): AgentLink {
  const link = baseLink(r);
  if (viewProject === undefined || r.f_project === undefined) return link;
  const fromHere = (r.f_project ?? null) === viewProject;
  const toHere = (r.t_project ?? null) === viewProject;
  if (fromHere && toHere) return link;
  const out = fromHere;
  const other = out ? "t" : "f";
  return { ...link, foreign: { sessionId: (out ? r.to_session_id : r.from_session_id) as string, title: String(r[other + "_title"] ?? "agent"), projectId: (r[other + "_project"] as string | null) ?? null, projectName: String(r[other + "_pname"] ?? ((r[other + "_project"] as string | null) ? "project" : "(scratch)")), direction: out ? "out" : "in" } };
}

function baseLink(r: Record<string, unknown>): AgentLink {
  return {
    id: r.id as string,
    projectId: (r.project_id as string | null) ?? null,
    fromSessionId: r.from_session_id as string,
    toSessionId: r.to_session_id as string,
    kind: r.kind as LinkKind,
    createdAt: new Date(r.created_at as string).toISOString(),
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at as string).toISOString() : null,
    messageCount: Number(r.message_count) || 0,
  };
}

export class AgentLinks {
  readonly hub = new EventHub();
  constructor(private readonly pool: pg.Pool) {}

  private async session(id: string): Promise<SessionRef | undefined> {
    if (!UUID.test(id)) return undefined;
    return (await this.pool.query("SELECT id, user_id, project_id FROM agent_sessions WHERE id = $1", [id])).rows[0] as SessionRef | undefined;
  }

  /** Synthesize 'recruit' links for sessions that have a parent_session_id but no link yet. */
  async backfill(userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_links (project_id, from_session_id, to_session_id, kind)
       SELECT c.project_id, c.parent_session_id, c.id, 'recruit'
       FROM agent_sessions c JOIN agent_sessions p ON p.id = c.parent_session_id AND p.user_id = c.user_id
       WHERE c.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM agent_links x
           WHERE (x.from_session_id = c.parent_session_id AND x.to_session_id = c.id)
              OR (x.from_session_id = c.id AND x.to_session_id = c.parent_session_id))
       ON CONFLICT DO NOTHING`,
      [userId],
    );
  }

  /** Links of one project (a project UUID, or "none" for sessions outside a registered project). */
  async list(userId: string, projectId: string): Promise<AgentLink[]> {
    const none = projectId === "none";
    if (!none && !UUID.test(projectId)) return [];
    await this.backfill(userId);
    const r = await this.pool.query(
      `SELECT ${COLS}, ${FOREIGN_COLS} FROM agent_links l
       JOIN agent_sessions f ON f.id = l.from_session_id
       JOIN agent_sessions t ON t.id = l.to_session_id
       LEFT JOIN floq_projects fp ON fp.id = f.project_id
       LEFT JOIN floq_projects tp ON tp.id = t.project_id
       WHERE f.user_id = $1 AND t.user_id = $1 AND ${none ? "(f.project_id IS NULL OR t.project_id IS NULL)" : "(f.project_id = $2 OR t.project_id = $2)"}
       ORDER BY l.created_at`,
      none ? [userId] : [userId, projectId],
    );
    return r.rows.map((row) => toLink(row, none ? null : projectId));
  }

  async createManual(userId: string, fromId: unknown, toId: unknown): Promise<AgentLink> {
    if (typeof fromId !== "string" || typeof toId !== "string") throw badRequest("fromSessionId and toSessionId required");
    authorizeManualLink(userId, await this.session(fromId), await this.session(toId));
    return this.upsert(fromId, toId, "manual", "none");
  }

  /** Returns the two sessions the removed wire joined, so their wired context can be refreshed. */
  async remove(userId: string, id: string): Promise<string[]> {
    if (!UUID.test(id)) throw notFound("Link not found");
    const r = await this.pool.query(
      "DELETE FROM agent_links l USING agent_sessions f WHERE l.id = $1 AND f.id = l.from_session_id AND f.user_id = $2 RETURNING l.from_session_id, l.to_session_id",
      [id, userId],
    );
    if (!r.rowCount) throw notFound("Link not found");
    return [r.rows[0].from_session_id as string, r.rows[0].to_session_id as string];
  }

  /**
   * Create or update the wire between two sessions. An existing link in either direction is reused and keeps its
   * kind; `message` bumps count and last_message_at, `reply` only last_message_at.
   */
  async upsert(fromId: string, toId: string, kind: LinkKind, bump: Bump): Promise<AgentLink> {
    const reverse = await this.pool.query("SELECT 1 FROM agent_links WHERE from_session_id = $1 AND to_session_id = $2", [toId, fromId]);
    const [a, b] = reverse.rows[0] ? [toId, fromId] : [fromId, toId];
    const project = (await this.session(fromId))?.project_id ?? null;
    const r = await this.pool.query(
      `INSERT INTO agent_links (project_id, from_session_id, to_session_id, kind, last_message_at, message_count)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 = 'none' THEN NULL ELSE now() END, CASE WHEN $5 = 'message' THEN 1 ELSE 0 END)
       ON CONFLICT (from_session_id, to_session_id) DO UPDATE SET
         message_count = agent_links.message_count + CASE WHEN $5 = 'message' THEN 1 ELSE 0 END,
         last_message_at = CASE WHEN $5 = 'none' THEN agent_links.last_message_at ELSE now() END
       RETURNING id, project_id, from_session_id, to_session_id, kind, created_at, last_message_at, message_count`,
      [project, a, b, kind, bump],
    );
    return toLink(r.rows[0]);
  }

  /** Upsert the link and push a live event. Never throws: wires are decoration, not a reason to fail an ask. */
  async record(userId: string, fromId: string, toId: string, kind: LinkKind, bump: Bump, eventKind: MessageEventKind, text: string, cross?: CrossProjectInfo): Promise<void> {
    try {
      const link = await this.upsert(fromId, toId, kind, bump);
      this.hub.publish(userId, {
        type: "agent-message",
        linkId: link.id,
        fromSessionId: fromId,
        toSessionId: toId,
        projectId: link.projectId,
        kind: eventKind,
        preview: makePreview(text),
        at: new Date().toISOString(),
        ...(cross ? { cross } : {}),
      });
    } catch {
      // best effort
    }
  }
}
