/**
 * Whether the canvas of one project should auto-open a Browser node. The runtime's `agents` count is user-wide (every project), so it must
 * never decide on its own: only a connected agent session that belongs to THIS project counts. A runtime that does not list
 * `agentSessions` gives no way to tell the projects apart, so it never auto-opens (safer than opening a browser in every project).
 */
export function projectAgentConnected(status: { agents?: number; agentSessions?: string[] }, projectSessionIds: ReadonlySet<string>): boolean {
  if ((status.agents ?? 0) === 0 || !Array.isArray(status.agentSessions)) return false;
  return status.agentSessions.some((id) => projectSessionIds.has(id));
}
