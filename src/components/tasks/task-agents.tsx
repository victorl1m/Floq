import type { SessionSummary } from "@/lib/runtime/types";
import { isOrchestrator } from "@/lib/runtime/orchestrator";
import { AgentAvatar } from "@/components/agents/agent-avatar";

/** Live agents of one project, orchestrator first (the default recipient of tasks). */
export function projectAgents(sessions: readonly SessionSummary[], projectId: string | null | undefined): SessionSummary[] {
  if (!projectId) return [];
  return sessions
    .filter((s) => s.projectId === projectId && !s.archived)
    .sort((a, b) => Number(isOrchestrator(b)) - Number(isOrchestrator(a)) || a.createdAt.localeCompare(b.createdAt));
}

export function AgentLabel({ session, size = 16 }: { session: SessionSummary | undefined; size?: number }) {
  if (!session) return <span className="text-muted-foreground">Agent removed</span>;
  return <span className="inline-flex min-w-0 items-center gap-1.5"><AgentAvatar session={session} size={size} /><span className="truncate">{session.title}</span></span>;
}
