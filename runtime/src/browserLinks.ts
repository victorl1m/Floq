import type pg from "pg";
import { badRequest, conflict, notFound } from "./errors.js";
import { NODE_ID } from "./browserProtocol.js";

/**
 * Wires between an agent and a canvas Browser node (docs/design/agent-browser.md, "Linked browser"). Same shape as note links:
 * rows are owned by the user, die with the agent session, and show up in the agent's wired context.
 * An agent drives one Browser node at a time: linking it to another node replaces the earlier wire (the browser can scope an agent to a single page).
 * Many agents may share one node.
 */
export interface BrowserLink { nodeId: string; sessionId: string; projectId: string | null }
const UUID = /^[0-9a-f-]{36}$/i;

export class BrowserLinks {
  constructor(private readonly pool: pg.Pool) {}

  async list(userId: string, projectId?: string | null): Promise<BrowserLink[]> {
    const r = projectId === undefined
      ? await this.pool.query("SELECT node_id, session_id, project_id FROM browser_links WHERE user_id = $1 ORDER BY created_at", [userId])
      : await this.pool.query("SELECT node_id, session_id, project_id FROM browser_links WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY created_at", [userId, projectId]);
    return r.rows.map((x: Record<string, unknown>) => ({ nodeId: x.node_id as string, sessionId: x.session_id as string, projectId: (x.project_id as string | null) ?? null }));
  }
  /** Node ids registered on a project's canvas. A node belongs to exactly one project. */
  async nodes(userId: string, projectId: string | null): Promise<string[]> {
    const r = await this.pool.query("SELECT node_id FROM browser_nodes WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY created_at", [userId, projectId]);
    return r.rows.map((x: { node_id: string }) => x.node_id);
  }
  /** Registers a node on a project. Idempotent; a node already owned by another project is refused (409), never moved. */
  async claim(userId: string, nodeId: unknown, projectId: string | null): Promise<void> {
    if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) throw badRequest("nodeId required", "invalid_node");
    if (projectId !== null && !UUID.test(projectId)) throw badRequest("projectId invalid", "invalid_node");
    await this.pool.query("INSERT INTO browser_nodes (user_id, node_id, project_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [userId, nodeId, projectId]);
    const owner = (await this.pool.query("SELECT project_id FROM browser_nodes WHERE user_id = $1 AND node_id = $2", [userId, nodeId])).rows[0] as { project_id: string | null };
    if ((owner.project_id ?? null) !== projectId) throw conflict("This browser belongs to another project", "browser_node_other_project");
  }
  forUser(userId: string): Promise<Array<{ sessionId: string; nodeId: string }>> { return this.list(userId); }

  /** Returns the session ids whose wired context changed (the agent itself, plus none else) and the node it was moved away from, if any. */
  async link(userId: string, nodeId: unknown, sessionId: unknown): Promise<{ link: BrowserLink; replacedNode: string | null }> {
    if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) throw badRequest("nodeId required", "invalid_link");
    if (typeof sessionId !== "string" || !UUID.test(sessionId)) throw badRequest("sessionId required", "invalid_link");
    const s = (await this.pool.query("SELECT project_id FROM agent_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId])).rows[0] as { project_id: string | null } | undefined;
    if (!s) throw notFound("Session not found");
    await this.claim(userId, nodeId, s.project_id ?? null); // an agent can only be wired to a browser of its own project
    const old = await this.pool.query("DELETE FROM browser_links WHERE user_id = $1 AND session_id = $2 AND node_id <> $3 RETURNING node_id", [userId, sessionId, nodeId]);
    await this.pool.query("INSERT INTO browser_links (user_id, node_id, session_id, project_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [userId, nodeId, sessionId, s.project_id ?? null]);
    return { link: { nodeId, sessionId, projectId: s.project_id ?? null }, replacedNode: (old.rows[0]?.node_id as string | undefined) ?? null };
  }

  async unlink(userId: string, nodeId: string, sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM browser_links WHERE user_id = $1 AND node_id = $2 AND session_id = $3", [userId, nodeId, sessionId]);
  }

  /** The node was closed: its wires go. Returns the sessions that were linked. */
  async removeNode(userId: string, nodeId: string): Promise<string[]> {
    await this.pool.query("DELETE FROM browser_nodes WHERE user_id = $1 AND node_id = $2", [userId, nodeId]);
    const r = await this.pool.query("DELETE FROM browser_links WHERE user_id = $1 AND node_id = $2 RETURNING session_id", [userId, nodeId]);
    return r.rows.map((x: { session_id: string }) => x.session_id);
  }

  /** The node an agent session is linked to, if any. */
  async nodeOf(userId: string, sessionId: string): Promise<string | null> {
    const r = await this.pool.query("SELECT node_id FROM browser_links WHERE user_id = $1 AND session_id = $2 LIMIT 1", [userId, sessionId]);
    return (r.rows[0]?.node_id as string | undefined) ?? null;
  }
}
