import { lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { conflict } from "./errors.js";
import { safeRelative } from "./shard.js";

/**
 * Deleting a project removes only what Floq itself created for it on the user's volume:
 *   - the primary checkout  `.floq/projects/<project id>`
 *   - its worktrees         `.floq/worktrees/<uuid>`
 * Anything else a (legacy/imported) project row points at is left alone and reported. The original remote repository
 * is never contacted.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WORKTREE_DIR = new RegExp(`^\\.floq/worktrees/${UUID}$`, "i");
const PROJECT_DIR = new RegExp(`^\\.floq/projects/${UUID}$`, "i");

export type CheckoutKind = "project" | "worktree";

export interface WorkspaceRow { id: string; cwd: string; isWorktree: boolean }

/** Count ordinary files and symlinks without following links; null means the directory could not be inspected. */
export function countPlainFiles(root: string): number | null {
  let count = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
      else count += 1;
    }
  };
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 1;
    visit(root);
    return count;
  } catch { return null; }
}

export interface PlannedCheckout {
  workspaceId: string;
  /** Path relative to the user's home, normalised. */
  cwd: string;
  kind: CheckoutKind;
  /** True only for directories Floq created and is allowed to delete. */
  managed: boolean;
}

/** Decide, from the database rows alone, which checkouts Floq may delete. Pure. */
export function planCheckouts(projectId: string, workspaces: WorkspaceRow[]): PlannedCheckout[] {
  const planned: PlannedCheckout[] = [];
  for (const workspace of workspaces) {
    let cwd: string;
    try { cwd = safeRelative(workspace.cwd); }
    catch { planned.push({ workspaceId: workspace.id, cwd: workspace.cwd, kind: workspace.isWorktree ? "worktree" : "project", managed: false }); continue; }
    const kind: CheckoutKind = workspace.isWorktree ? "worktree" : "project";
    const managed = kind === "worktree"
      ? WORKTREE_DIR.test(cwd)
      : PROJECT_DIR.test(cwd) && cwd.toLowerCase() === `.floq/projects/${projectId}`.toLowerCase();
    planned.push({ workspaceId: workspace.id, cwd, kind, managed });
  }
  return planned;
}

/** Number of changed or untracked files in `git status --porcelain=v1` output. */
export function countPorcelain(stdout: string): number {
  return stdout.split(/\r?\n/).filter((line) => /^[ MADRCUT?!]{2} \S/.test(line)).length;
}

function norm(path: string): string {
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export type RemoveOutcome = "removed" | "missing" | "link-removed";

/**
 * Remove one Floq-managed checkout directory under `home` (host path of the user's mounted volume).
 * Refuses (throws) rather than guesses: the relative path must match the managed pattern, `.floq` and its
 * `projects`/`worktrees` parent must be real directories (not links), and the target's real path must be exactly
 * where its name says. If the target itself is a link it is unlinked (never followed), so a symlink planted at the
 * project path can never redirect the delete to another location.
 */
export function removeManagedCheckout(home: string, relativePath: string, kind: CheckoutKind): RemoveOutcome {
  let rel: string;
  try { rel = safeRelative(relativePath); }
  catch { throw conflict("The checkout path is invalid; nothing was deleted from disk.", "unsafe_project_path"); }
  if (!(kind === "worktree" ? WORKTREE_DIR : PROJECT_DIR).test(rel)) throw conflict("This directory is not managed by Floq; it was left in place.", "unsafe_project_path");

  let homeReal: string;
  try { homeReal = realpathSync.native(home); }
  catch { throw conflict("Your workspace is unavailable.", "unsafe_project_path"); }
  const [dot, group, leaf] = rel.split("/");
  for (const part of [dot, `${dot}/${group}`]) {
    let stat;
    try { stat = lstatSync(join(homeReal, part)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict("A parent folder is a link; refusing to delete through it.", "unsafe_project_path");
  }
  const target = join(homeReal, dot, group, leaf);
  let stat;
  try { stat = lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (stat.isSymbolicLink()) { unlinkSync(target); return "link-removed"; }
  if (!stat.isDirectory()) throw conflict("The checkout path is not a directory; it was left in place.", "unsafe_project_path");
  const real = realpathSync.native(target);
  if (norm(real) !== norm(join(realpathSync.native(join(homeReal, dot, group)), leaf))) throw conflict("The checkout resolves outside its expected location; it was left in place.", "unsafe_project_path");
  // rmSync never follows symbolic links it meets inside the tree; it unlinks them.
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return "removed";
}

export interface CheckoutReport {
  workspaceId: string;
  path: string;
  kind: CheckoutKind;
  branch: string | null;
  /** managed: Floq will delete it. unmanaged: outside Floq's directories, left untouched. */
  managed: boolean;
  state: "ok" | "missing" | "unreadable" | "unmanaged";
  /** Changed + untracked files that deletion would lose; null when it could not be determined. */
  uncommittedFiles: number | null;
}

export interface ProjectDeleteStatus {
  project: { id: string; name: string };
  sessions: { total: number; live: number };
  notes: number;
  keychains: number;
  checkouts: CheckoutReport[];
  worktrees: number;
  /** Worktrees (and the main checkout) with uncommitted work that will be lost. */
  dirtyWorktrees: number;
  dirtyMainCheckout: boolean;
  unmanagedCheckouts: number;
  unreadableCheckouts: number;
}

export interface ProjectDeleteResult {
  deleted: true;
  sessionsDeleted: number;
  removedCheckouts: number;
  /** Directories that could not be removed (or were intentionally kept); the project record itself is gone. */
  leftovers: Array<{ path: string; reason: string }>;
}
