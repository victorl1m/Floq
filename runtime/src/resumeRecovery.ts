/** Pure helpers for recovering from a resume that exits right after launch. Nothing here touches the database. */

/** How a fast exit after `--resume` is read from the last bytes of PTY output. */
export type ResumeExitKind = "not_found" | "in_use" | "transient";

/** Delays before retry 1, 2 and 3 of a transient resume failure. */
export const RESUME_RETRY_BACKOFF_MS = [2_000, 10_000, 30_000] as const;
/** Delays before re-queuing a boot resume that was skipped by a transient error. */
export const BOOT_RESUME_RETRY_MS = [30_000, 120_000] as const;
/** The tail of PTY output inspected to classify an exit. */
export const RESUME_TAIL_BYTES = 2048;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

const NOT_FOUND = [
  /no conversation found/i,                       // claude: No conversation found with session ID
  /no (?:saved )?session found/i,                 // codex / generic
  /no rollout found/i,                            // codex resume <id>
  /session (?:with id )?.{0,80}not found/i,       // opencode: Session not found
  /conversation (?:with id )?.{0,80}not found/i,  // agy
  /could not find (?:a |the )?(?:session|conversation)/i,
];
const IN_USE = [/session id .{0,80}is already in use/i, /already in use/i];

/** Last RESUME_TAIL_BYTES of output with terminal escapes removed. */
export function resumeTail(output: string): string {
  return output.slice(-RESUME_TAIL_BYTES * 2).replace(ANSI, "").slice(-RESUME_TAIL_BYTES);
}

/** Anything unrecognised is transient: the worst case is bounded retries and a failed card with the pointer kept. */
export function classifyResumeExit(output: string): ResumeExitKind {
  const tail = resumeTail(output);
  if (IN_USE.some((re) => re.test(tail))) return "in_use";
  if (NOT_FOUND.some((re) => re.test(tail))) return "not_found";
  return "transient";
}

/** Delay before retry number `attempt` (0-based), or null once the retries are used up. */
export function resumeRetryDelay(attempt: number): number | null {
  return RESUME_RETRY_BACKOFF_MS[attempt] ?? null;
}

/** Delay before boot-resume re-queue number `attempt` (0-based), or null when exhausted. */
export function bootRetryDelay(attempt: number): number | null {
  return BOOT_RESUME_RETRY_MS[attempt] ?? null;
}

/** A boot resume that failed for a reason time can fix (credentials not loaded, shard wake, capacity). */
export function isTransientBootError(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null;
  if (e?.code === "worktree_deleted" || e?.code === "not_found" || e?.status === 404) return false;
  return true;
}

/** Claude's project folder name for a cwd: every non-alphanumeric character becomes "-". */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export const RESUME_FAILED_REASON = "resume_failed";
export const RESUME_FAILED_TITLE = "Couldn't resume, conversation kept";
export const BOOT_PAUSED_TITLE = "Agent paused after restart, conversation kept";
