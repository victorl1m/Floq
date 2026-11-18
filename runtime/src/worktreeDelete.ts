import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { badRequest, conflict } from "./errors.js";
import type { GitCommandResult } from "./projectBranches.js";
import { safeRelative } from "./shard.js";

/** Runs Git with `cwd` (relative to the user's home) as its working directory, in the user's sandbox. */
export type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>;

export interface WorktreeContext {
  /** Host path of the user's mounted home. */
  home: string;
  /** Project (primary checkout) path, relative to home. */
  projectCwd: string;
  /** Worktree path, relative to home, as stored in floq_project_workspaces. */
  cwd: string;
  run: RunGit;
}

export interface WorktreeStatus {
  path: string;
  /** Branch currently checked out in the worktree, if any. */
  branch: string | null;
  /** The local `floq/<id>` branch that deleting this worktree would also delete (null if absent or not safe to delete). */
  floqBranch: string | null;
  /** Default branch used as the base for commit counts. */
  baseBranch: string | null;
  /** The worktree directory is already gone from disk. */
  missing: boolean;
  uncommittedFiles: number;
  commitsNotOnBase: number;
  /** This worktree's own commits (not on the base branch) that no remote-tracking branch contains. */
  unpushedCommits: number;
  /** Commits reachable from no other local or remote branch: they would be lost by deleting this worktree's branch. */
  unsavedCommits: number;
}

export interface WorktreeInspection extends WorktreeStatus {
  id: string;
  /** Path to pass to `git worktree remove`: the absolute path Git recorded for the worktree. */
  removeArg: string;
  linked: boolean;
  /** Branch names the deletion must never touch. */
  protectedBranches: string[];
}

export interface WorktreeDeleteResult {
  alreadyGone: boolean;
  branchDeleted: string | null;
  branchNote: string | null;
}

const ID_PATTERN = /^\.floq\/worktrees\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function norm(path: string): string {
  let value: string;
  try { value = realpathSync.native(path); } catch { value = resolve(path); }
  value = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

interface Entry { path: string; head: string | null; branch: string | null; }

export function parseWorktrees(stdout: string): Entry[] {
  const entries: Entry[] = [];
  let current: Entry | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = /^[0-9a-f]{40,64}$/i.test(line.slice(5)) && !/^0+$/.test(line.slice(5)) ? line.slice(5) : null;
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

async function must(run: RunGit, cwd: string, args: string[], what: string): Promise<string> {
  const result = await run(cwd, args);
  if (result.exitCode !== 0) throw badRequest(`Could not ${what}.`, "git_worktree_failed");
  return result.stdout;
}

async function count(run: RunGit, cwd: string, args: string[], what: string): Promise<number> {
  const out = (await must(run, cwd, ["rev-list", "--count", ...args], what)).trim().split(/\r?\n/).at(-1) ?? "";
  if (!/^\d+$/.test(out)) throw badRequest(`Could not ${what}.`, "git_worktree_failed");
  return Number(out);
}

async function branchExists(run: RunGit, cwd: string, name: string): Promise<boolean> {
  return (await run(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).exitCode === 0;
}

export async function defaultBranch(run: RunGit, projectCwd: string): Promise<{ base: string | null; protectedNames: string[] }> {
  const protectedNames = new Set<string>();
  let base: string | null = null;
  const remoteHead = await run(projectCwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead.exitCode === 0) {
    const name = remoteHead.stdout.trim().replace(/^origin\//, "");
    if (name && await branchExists(run, projectCwd, name)) { base = name; protectedNames.add(name); }
  }
  const current = await run(projectCwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const currentName = current.exitCode === 0 ? current.stdout.trim() : "";
  if (currentName) { protectedNames.add(currentName); base ??= currentName; }
  for (const name of ["main", "master", "trunk", "develop"]) {
    if (await branchExists(run, projectCwd, name)) { protectedNames.add(name); base ??= name; }
  }
  return { base, protectedNames: [...protectedNames] };
}

/** Commits on `tip` that no other local branch or remote-tracking branch contains. */
async function uniqueCommits(run: RunGit, cwd: string, tip: string, excludeBranch: string | null): Promise<number> {
  const args = [tip, "--not"];
  if (excludeBranch) args.push(`--exclude=${excludeBranch}`);
  args.push("--branches", "--remotes");
  return count(run, cwd, args, "count unsaved commits");
}

/**
 * Read-only: verifies from Git that the target is a Floq-created linked worktree of this project and measures
 * what deleting it would lose. Throws for anything that must never be deleted (primary, foreign path, symlink).
 */
export async function inspectWorktree(ctx: WorktreeContext): Promise<WorktreeInspection> {
  let cwd: string;
  let projectCwd: string;
  try {
    cwd = safeRelative(ctx.cwd);
    projectCwd = safeRelative(ctx.projectCwd);
  } catch {
    throw badRequest("Workspace path is invalid.", "invalid_project_workspace");
  }
  if (cwd === projectCwd) throw conflict("The primary checkout cannot be deleted.", "primary_workspace");
  const match = ID_PATTERN.exec(cwd);
  if (!match) throw conflict("Only worktrees created by Floq under .floq/worktrees can be deleted.", "not_floq_worktree");
  const id = match[1];

  let home: string;
  try { home = realpathSync.native(ctx.home); }
  catch { throw badRequest("Your workspace is unavailable.", "invalid_project_workspace"); }
  // .floq and .floq/worktrees must be real directories (a symlink there could redirect the delete).
  for (const part of [".floq", ".floq/worktrees"]) {
    try {
      const stat = lstatSync(join(home, part));
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict("The worktree root is not a plain directory.", "unsafe_worktree_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const target = join(home, ".floq", "worktrees", id);
  let missing = false;
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw conflict("The worktree path is a link or not a directory; refusing to delete it.", "unsafe_worktree_path");
    if (norm(target) !== norm(join(home, ".floq", "worktrees", id))) throw conflict("The worktree path resolves outside its expected location.", "unsafe_worktree_path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    missing = true;
  }

  const listed = parseWorktrees(await must(ctx.run, projectCwd, ["worktree", "list", "--porcelain"], "list this project's worktrees"));
  const wanted = norm(target);
  const index = listed.findIndex((entry) => norm(entry.path) === wanted);
  if (index === 0) throw conflict("The primary checkout cannot be deleted.", "primary_workspace");
  if (index < 0 && !missing) throw conflict("This directory is not a linked worktree of this project; refusing to delete it.", "not_linked_worktree");
  const entry = index > 0 ? listed[index] : null;

  const floqName = `floq/${id}`;
  const floqExists = await branchExists(ctx.run, projectCwd, floqName);
  const { base, protectedNames } = await defaultBranch(ctx.run, projectCwd);
  const branch = entry?.branch ?? null;

  let uncommittedFiles = 0;
  if (!missing) {
    const status = await must(ctx.run, cwd, ["status", "--porcelain=v1", "--untracked-files=all"], "check the worktree for uncommitted changes");
    uncommittedFiles = status.split(/\r?\n/).filter((line) => /^[ MADRCUT?!]{2} \S/.test(line)).length;
  }

  // Tips whose commits could be lost: whatever the worktree has checked out, and the Floq branch we may delete.
  const tips: Array<{ ref: string; exclude: string | null }> = [];
  if (branch) tips.push({ ref: `refs/heads/${branch}`, exclude: branch });
  else if (entry?.head) tips.push({ ref: entry.head, exclude: null });
  if (floqExists && branch !== floqName) tips.push({ ref: `refs/heads/${floqName}`, exclude: floqName });
  let commitsNotOnBase = 0;
  let unpushedCommits = 0;
  let unsavedCommits = 0;
  for (const tip of tips) {
    if (base) commitsNotOnBase += await count(ctx.run, projectCwd, [`refs/heads/${base}..${tip.ref}`], "count commits not on the base branch");
    unpushedCommits += await count(ctx.run, projectCwd, base ? [tip.ref, "--not", `refs/heads/${base}`, "--remotes"] : [tip.ref, "--not", "--remotes"], "count unpushed commits");
    unsavedCommits += await uniqueCommits(ctx.run, projectCwd, tip.ref, tip.exclude);
  }

  const candidate = floqExists && !protectedNames.includes(floqName) ? floqName : null;
  // Git stores the worktree's own absolute path in its metadata. Recomputing it relative to the primary checkout
  // breaks whenever Git sees the home through a different path than the one recorded (Floq's sandbox bind-mounts
  // the home at /home/agent while the metadata holds the host path); `git worktree remove` then reports
  // "fatal: '<path>' is not a working tree". Pass the recorded path instead.
  const recorded = entry ? (isAbsolute(entry.path) ? entry.path : resolve(join(home, projectCwd), entry.path)) : target;
  return {
    id,
    path: cwd,
    branch,
    floqBranch: candidate,
    baseBranch: base,
    missing,
    uncommittedFiles,
    commitsNotOnBase,
    unpushedCommits,
    unsavedCommits,
    removeArg: recorded,
    linked: entry !== null,
    protectedBranches: protectedNames,
  };
}

export function assertCanDelete(status: WorktreeStatus, force: boolean): void {
  if (force || (status.uncommittedFiles === 0 && status.unsavedCommits === 0)) return;
  const parts: string[] = [];
  if (status.uncommittedFiles) parts.push(`${status.uncommittedFiles} uncommitted ${status.uncommittedFiles === 1 ? "file" : "files"}`);
  if (status.unsavedCommits) parts.push(`${status.unsavedCommits} ${status.unsavedCommits === 1 ? "commit" : "commits"} that exist nowhere else`);
  throw conflict(`This worktree has ${parts.join(" and ")}. Deleting it would lose that work.`, "worktree_has_changes");
}

/** Removes the worktree with Git, then its Floq-created local branch. Never touches remotes or other branches. */
export async function deleteWorktree(ctx: WorktreeContext, inspection: WorktreeInspection, force: boolean): Promise<WorktreeDeleteResult> {
  assertCanDelete(inspection, force);
  const projectCwd = safeRelative(ctx.projectCwd);
  if (inspection.missing) {
    // The directory is already gone, so there is no working tree for `git worktree remove` to validate; drop the
    // stale admin entry so the branch below is no longer considered checked out. Prune only touches worktrees whose
    // directory has disappeared, never existing ones.
    await ctx.run(projectCwd, ["worktree", "prune"]);
  } else if (inspection.linked) {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push("--", inspection.removeArg);
    let removed = await ctx.run(projectCwd, args);
    // Bind mounts can leave the worktree's .git file pointing at the same repository
    // through a different absolute path. Git status works, but remove requires the
    // backlink to match exactly. Let Git repair this verified worktree, then retry
    // with the original safety flags (never force deletion to bypass validation).
    if (removed.exitCode !== 0 && /validation failed, cannot remove working tree:[\s\S]*does not point back to/i.test(removed.stdout)) {
      const repaired = await ctx.run(projectCwd, ["worktree", "repair", "--", inspection.removeArg]);
      if (repaired.exitCode === 0) removed = await ctx.run(projectCwd, args);
    }
    if (removed.exitCode !== 0) {
      throw conflict("Git could not remove the worktree: " + removed.stdout.replace(/\s+/g, " ").trim().slice(0, 300), "worktree_remove_failed");
    }
  }

  // The worktree is gone; from here on report problems instead of failing the whole delete.
  let branchDeleted: string | null = null;
  let branchNote: string | null = null;
  const name = inspection.floqBranch;
  if (!name) {
    branchNote = inspection.branch && inspection.branch !== `floq/${inspection.id}` ? `Branch ${inspection.branch} was not created by Floq and was kept.` : null;
  } else {
    try {
      const listed = parseWorktrees((await ctx.run(projectCwd, ["worktree", "list", "--porcelain"])).stdout);
      const checkedOut = listed.some((entry) => entry.branch === name);
      if (checkedOut) branchNote = `Branch ${name} is checked out in another worktree and was kept.`;
      else if (inspection.protectedBranches.includes(name)) branchNote = `Branch ${name} is a protected branch and was kept.`;
      else if (!await branchExists(ctx.run, projectCwd, name)) branchNote = null;
      else {
        const result = await ctx.run(projectCwd, ["branch", force ? "-D" : "-d", "--", name]);
        if (result.exitCode === 0) branchDeleted = name;
        else branchNote = `Branch ${name} was kept because Git declined to delete it: ` + result.stdout.replace(/\s+/g, " ").trim().slice(0, 200);
      }
    } catch (error) {
      branchNote = `Branch ${name} could not be checked and was kept: ` + (error instanceof Error ? error.message : "unknown error").slice(0, 200);
    }
  }
  return { alreadyGone: inspection.missing, branchDeleted, branchNote };
}
