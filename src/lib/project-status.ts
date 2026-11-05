import type { SessionSummary } from "./runtime/types";

type StatusSession = Pick<SessionSummary, "state" | "activity" | "projectId" | "exitCode">;

export type ProjectStatusKind = "errored" | "running" | "finished";
export interface ProjectCounts { working: number; failed: number }
/** Per-project memory (in memory only): was it working at the last look, and is a finish unacknowledged. */
export interface ProjectMemory { wasWorking: boolean; finished: boolean }
export interface ProjectStatus { kind: ProjectStatusKind; count: number; label: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** An agent has failed, or exited with a non-zero exit code. */
export function isErroredSession(s: Pick<StatusSession, "state" | "exitCode">): boolean {
  return s.state === "failed" || (s.state === "exited" && s.exitCode != null && s.exitCode !== 0);
}

/** Actively working = a running agent with an open turn (idle, waiting-for-input and asleep do not count). */
export function isWorkingSession(s: Pick<StatusSession, "state" | "activity">): boolean {
  return s.state === "running" && s.activity === "working";
}

export function countByProject(sessions: readonly StatusSession[]): Map<string, ProjectCounts> {
  const out = new Map<string, ProjectCounts>();
  for (const s of sessions) {
    if (!s.projectId) continue;
    const c = out.get(s.projectId) ?? { working: 0, failed: 0 };
    if (isWorkingSession(s)) c.working++;
    if (isErroredSession(s)) c.failed++;
    out.set(s.projectId, c);
  }
  return out;
}

/** Advance one project's memory. Opening/viewing the project acknowledges a finish. */
export function advanceMemory(prev: ProjectMemory | undefined, counts: ProjectCounts | undefined, viewing: boolean): ProjectMemory {
  const working = (counts?.working ?? 0) > 0;
  const before = prev ?? { wasWorking: false, finished: false };
  if (viewing) return { wasWorking: working, finished: false };
  if (working) return { wasWorking: true, finished: false };
  if (before.wasWorking) return { wasWorking: false, finished: true };
  return before;
}

/** Precedence: errored > running > finished. */
export function projectStatus(counts: ProjectCounts | undefined, memory: ProjectMemory | undefined): ProjectStatus | null {
  if (counts && counts.failed > 0) return { kind: "errored", count: counts.failed, label: counts.failed === 1 ? "An agent failed" : `${counts.failed} agents failed` };
  if (counts && counts.working > 0) return { kind: "running", count: counts.working, label: `${plural(counts.working, "agent")} working` };
  if (memory?.finished) return { kind: "finished", count: 0, label: "Agents finished" };
  return null;
}
