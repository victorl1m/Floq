import type { SessionSummary } from "./types";

/** Tailwind classes shared by every orchestrator highlight (violet matches the canvas 'recruit' wire). */
export const ORCHESTRATOR_TEXT = "text-violet-600 dark:text-violet-400";

/** The explicit orchestrator marker: the server-side session role. Never inferred from recruiting. */
export const ORCHESTRATOR_ROLE = "orchestrator";
export const ORCHESTRATOR_HINT = "Only the orchestrator can recruit agents; other agents must ask it.";
export const isOrchestrator = (session: Pick<SessionSummary, "role">): boolean => session.role === ORCHESTRATOR_ROLE;

/**
 * Recruited-agent count per EXPLICIT orchestrator id (role === "orchestrator"). Recruits are sessions with
 * that id as `parentSessionId`, plus `extraLinks` (canvas recruit wires, from -> to). Others get no entry.
 */
export function recruitCounts(sessions: readonly SessionSummary[], extraLinks: readonly { from: string; to: string }[] = []): Map<string, number> {
  const ids = new Set(sessions.map((session) => session.id));
  const leads = new Set(sessions.filter(isOrchestrator).map((session) => session.id));
  const children = new Map<string, Set<string>>();
  for (const lead of leads) children.set(lead, new Set());
  const add = (parent: string, child: string) => {
    if (parent === child || !ids.has(child)) return;
    children.get(parent)?.add(child);
  };
  for (const session of sessions) if (session.parentSessionId) add(session.parentSessionId, session.id);
  for (const link of extraLinks) add(link.from, link.to);
  return new Map([...children].map(([id, set]) => [id, set.size]));
}

export const orchestratorIds = (sessions: readonly SessionSummary[]): Set<string> => new Set(sessions.filter(isOrchestrator).map((session) => session.id));

export const orchestratorLabel = (count: number) => `Orchestrator · ${count} agent${count === 1 ? "" : "s"}`;

/** Marks or unmarks an agent as the orchestrator through the runtime; the caller supplies the session upsert. */
export async function setOrchestrator(
  client: { setSessionRole: (id: string, role: string | null) => Promise<SessionSummary> },
  session: SessionSummary,
  on: boolean,
  upsert: (session: SessionSummary) => void,
  notify: { success: (message: string, options?: { description?: string }) => void; error: (message: string, options?: { description?: string }) => void },
) {
  upsert({ ...session, role: on ? ORCHESTRATOR_ROLE : null });
  try {
    upsert(await client.setSessionRole(session.id, on ? ORCHESTRATOR_ROLE : null));
    notify.success(on ? `${session.title} is now the orchestrator` : `${session.title} is no longer the orchestrator`, on ? { description: ORCHESTRATOR_HINT } : undefined);
  } catch (error) {
    upsert(session);
    notify.error("Could not change the orchestrator role", { description: error instanceof Error ? error.message : String(error) });
  }
}
