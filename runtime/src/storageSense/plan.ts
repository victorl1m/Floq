/**
 * Storage Sense: pure selection rules. Candidates (facts gathered elsewhere) in, decisions (remove | keep + reason) out.
 * Nothing here touches the disk, git or the clock, so every safety rule is unit-testable. The executor re-verifies the
 * facts right before acting; this module only decides what is *eligible*.
 *
 * A category threshold of 0 days switches that category off. Anything not positively proven safe is kept.
 */

export const DAY_MS = 24 * 3600 * 1000;

export type Category = "worktree" | "branch" | "scratchpad" | "attachment" | "tmp";
export const CATEGORIES: readonly Category[] = ["worktree", "branch", "scratchpad", "attachment", "tmp"];

export interface StorageSenseConfig {
  /** Days of inactivity before an ended agent's clean, merged worktree is removed. */
  worktreeDays: number;
  /** Days before a merged orphan floq/<agentId> branch is deleted. */
  branchDays: number;
  /** Days before the scratchpad / task output of an ended session is removed. */
  scratchpadDays: number;
  /** Days before an upload under .floq/attachments is removed. */
  attachmentDays: number;
  /** Days before other stale entries directly under the persistent /tmp are removed. */
  tmpDays: number;
  /** Run an extra cleanup when the home's free space drops below this percentage (0 = never). */
  lowSpacePercent: number;
}

export const DEFAULT_CONFIG: StorageSenseConfig = { worktreeDays: 30, branchDays: 30, scratchpadDays: 7, attachmentDays: 60, tmpDays: 14, lowSpacePercent: 10 };

export type ReasonCode =
  | "eligible"
  | "disabled"
  | "too_recent"
  | "agent_live"
  | "agent_exists"
  | "unsaved_work"
  | "not_merged"
  | "unknown_state"
  | "symlink"
  | "other_device"
  | "walk_incomplete"
  | "lock_file"
  | "protected_path"
  | "checked_out";

export interface Decision<T = unknown> {
  category: Category;
  /** Display label: path relative to the home, or the branch name. */
  label: string;
  action: "remove" | "keep";
  reason: ReasonCode;
  /** Human sentence for the report. */
  detail: string;
  /** Anything that is kept because the user may still need it ("has unsaved work"): worth a notification. */
  attention: boolean;
  bytes?: number;
  item: T;
}

export interface WorktreeCandidate {
  category: "worktree";
  workspaceId: string;
  projectId: string;
  /** Home-relative path. */
  path: string;
  /** Sessions attached to the workspace that are running, starting or sleeping (they can be resumed or are working). */
  activeSessions: number;
  /** Newest sign of activity: sessions' last activity, the workspace row, the directory. */
  lastActivityMs: number;
  /** Null when git could not be inspected. */
  git: { uncommittedFiles: number; /** Commits whose patch is not in the base branch (git cherry '+'). null: no base to compare with. */ unmergedPatches: number | null; missing: boolean } | null;
}

export interface BranchCandidate {
  category: "branch";
  projectId: string;
  branch: string;
  /** The agent id embedded in floq/<id>. */
  agentId: string;
  /** A session row (any state) with this id still exists. */
  sessionExists: boolean;
  checkedOutSomewhere: boolean;
  lastCommitMs: number;
  unmergedPatches: number | null;
}

export interface FsCandidate {
  category: "scratchpad" | "attachment" | "tmp";
  /** Home-relative path. */
  path: string;
  isSymlink: boolean;
  isDirectory: boolean;
  sameDevice: boolean;
  /** Newest mtime/ctime anywhere inside; null when the bounded walk was cut short. */
  newestMs: number | null;
  hasLock: boolean;
  bytes: number;
  /** Scratchpads only: the owning session. */
  session?: { state: "live" | "ended" | "missing"; lastActiveMs: number | null };
}

export type Candidate = WorktreeCandidate | BranchCandidate | FsCandidate;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ALLOWED_FS: Record<FsCandidate["category"], RegExp> = {
  scratchpad: new RegExp(`^\\.floq/tmp/claude-\\d+/[^/]+/${UUID}$`, "i"),
  attachment: new RegExp(`^\\.floq/attachments/${UUID}$`, "i"),
  tmp: /^\.floq\/tmp\/(?!claude-\d+$)[^/.][^/]*$/,
};
const FLOQ_BRANCH = new RegExp(`^floq/(${UUID})$`, "i");
const WORKTREE_PATH = new RegExp(`^\\.floq/worktrees/${UUID}$`, "i");

/** The only home-relative locations Storage Sense may ever delete from. Artifacts, transcripts, checkpoints, the vault and checkouts are not on this list. */
export function isAllowedFsPath(category: FsCandidate["category"], rel: string): boolean {
  if (rel.includes("\0") || rel.split("/").some((part) => part === ".." || part === "." || part === "")) return false;
  return ALLOWED_FS[category].test(rel);
}
export function isFloqBranch(name: string): boolean { return FLOQ_BRANCH.test(name); }
export function isManagedWorktreePath(rel: string): boolean { return WORKTREE_PATH.test(rel); }

function days(ms: number): number { return Math.floor(ms / DAY_MS); }
function keep<T extends Candidate>(item: T, label: string, reason: ReasonCode, detail: string, attention = false, bytes?: number): Decision<T> {
  return { category: item.category, label, action: "keep", reason, detail, attention, bytes, item };
}
function remove<T extends Candidate>(item: T, label: string, detail: string, bytes?: number): Decision<T> {
  return { category: item.category, label, action: "remove", reason: "eligible", detail, attention: false, bytes, item };
}

function threshold(config: StorageSenseConfig, category: Category): number {
  const value = { worktree: config.worktreeDays, branch: config.branchDays, scratchpad: config.scratchpadDays, attachment: config.attachmentDays, tmp: config.tmpDays }[category];
  return Number.isFinite(value) && value > 0 ? value * DAY_MS : 0;
}

export function decideWorktree(c: WorktreeCandidate, config: StorageSenseConfig, now: number): Decision<WorktreeCandidate> {
  const limit = threshold(config, "worktree");
  if (!limit) return keep(c, c.path, "disabled", "Worktree cleanup is off");
  if (!isManagedWorktreePath(c.path)) return keep(c, c.path, "protected_path", "Not a Floq-created worktree");
  if (c.activeSessions > 0) return keep(c, c.path, "agent_live", "An agent in this worktree is running or sleeping");
  if (!c.git) return keep(c, c.path, "unknown_state", "Git could not inspect this worktree");
  if (now - c.lastActivityMs < limit) return keep(c, c.path, "too_recent", `Active ${days(now - c.lastActivityMs)} days ago (threshold ${days(limit)})`);
  if (c.git.missing) return remove(c, c.path, "Directory is already gone; drops the stale git entry");
  if (c.git.uncommittedFiles > 0) return keep(c, c.path, "unsaved_work", `Has unsaved work: ${c.git.uncommittedFiles} uncommitted file(s)`, true);
  if (c.git.unmergedPatches === null) return keep(c, c.path, "unknown_state", "No base branch to compare with", true);
  if (c.git.unmergedPatches > 0) return keep(c, c.path, "not_merged", `Has unsaved work: ${c.git.unmergedPatches} commit(s) not in the base branch`, true);
  return remove(c, c.path, "Clean, merged into the base branch and idle");
}

export function decideBranch(c: BranchCandidate, config: StorageSenseConfig, now: number): Decision<BranchCandidate> {
  const limit = threshold(config, "branch");
  if (!limit) return keep(c, c.branch, "disabled", "Branch cleanup is off");
  if (!isFloqBranch(c.branch)) return keep(c, c.branch, "protected_path", "Not a Floq-created branch");
  if (c.sessionExists) return keep(c, c.branch, "agent_exists", "Its agent still exists");
  if (c.checkedOutSomewhere) return keep(c, c.branch, "checked_out", "Checked out in a worktree");
  if (now - c.lastCommitMs < limit) return keep(c, c.branch, "too_recent", `Last commit ${days(now - c.lastCommitMs)} days ago (threshold ${days(limit)})`);
  if (c.unmergedPatches === null) return keep(c, c.branch, "unknown_state", "No base branch to compare with", true);
  if (c.unmergedPatches > 0) return keep(c, c.branch, "not_merged", `Has unsaved work: ${c.unmergedPatches} commit(s) not in the base branch`, true);
  return remove(c, c.branch, "Orphan branch whose content is in the base branch");
}

export function decideFs(c: FsCandidate, config: StorageSenseConfig, now: number): Decision<FsCandidate> {
  const limit = threshold(config, c.category);
  if (!limit) return keep(c, c.path, "disabled", "This category is off", false, c.bytes);
  if (!isAllowedFsPath(c.category, c.path)) return keep(c, c.path, "protected_path", "Outside the locations Storage Sense may clean", false, c.bytes);
  if (c.isSymlink) return keep(c, c.path, "symlink", "Symbolic links are never followed or removed");
  if (!c.sameDevice) return keep(c, c.path, "other_device", "On another filesystem", false, c.bytes);
  if (c.session?.state === "live") return keep(c, c.path, "agent_live", "Its session is running or sleeping", false, c.bytes);
  if (c.newestMs === null) return keep(c, c.path, "walk_incomplete", "Too large to verify in one pass", false, c.bytes);
  if (c.hasLock) return keep(c, c.path, "lock_file", "Contains a lock or pid file", false, c.bytes);
  const idleSince = Math.max(c.newestMs, c.session?.lastActiveMs ?? 0);
  if (now - idleSince < limit) return keep(c, c.path, "too_recent", `Used ${days(now - idleSince)} days ago (threshold ${days(limit)})`, false, c.bytes);
  return remove(c, c.path, c.session ? "Scratch data of an ended session" : "Unused", c.bytes);
}

export function decide(c: Candidate, config: StorageSenseConfig, now: number): Decision {
  switch (c.category) {
    case "worktree": return decideWorktree(c, config, now);
    case "branch": return decideBranch(c, config, now);
    default: return decideFs(c, config, now);
  }
}

export function planCleanup(candidates: Candidate[], config: StorageSenseConfig, now: number): Decision[] {
  return candidates.map((c) => decide(c, config, now));
}

export interface ReportEntry { category: Category; label: string; action: "removed" | "would-remove" | "kept" | "failed"; reason: ReasonCode | "error"; detail: string; bytes?: number; attention?: boolean }
export interface StorageSenseReport {
  at: string;
  dryRun: boolean;
  trigger: "schedule" | "low-space" | "manual";
  durationMs: number;
  /** The run stopped at its time budget; the rest is picked up next time. */
  partial: boolean;
  freedBytes: number;
  freePercentBefore: number | null;
  counts: { removed: number; kept: number; failed: number; attention: number };
  entries: ReportEntry[];
}

/** Notification text, or null when there is nothing worth interrupting the user for. */
export function summarize(report: StorageSenseReport): { title: string; body: string; level: "info" | "warning" } | null {
  if (report.dryRun) return null;
  const { removed, attention, failed } = report.counts;
  if (!removed && !attention && !failed) return null;
  const parts: string[] = [];
  if (removed) parts.push(`Removed ${removed} item${removed === 1 ? "" : "s"}${report.freedBytes ? ` (${formatBytes(report.freedBytes)} freed)` : ""}.`);
  if (attention) parts.push(`${attention} kept because ${attention === 1 ? "it has" : "they have"} unsaved work.`);
  if (failed) parts.push(`${failed} could not be cleaned.`);
  return { title: "Storage Sense", body: parts.join(" "), level: attention || failed ? "warning" : "info" };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Cap the report so it stays small enough to store and send: keeps every attention entry first, then removals, then the rest. */
export function trimEntries(entries: ReportEntry[], max = 200): ReportEntry[] {
  if (entries.length <= max) return entries;
  const rank = (e: ReportEntry) => (e.attention ? 0 : e.action === "failed" ? 1 : e.action === "removed" || e.action === "would-remove" ? 2 : 3);
  return [...entries].sort((a, b) => rank(a) - rank(b)).slice(0, max);
}
