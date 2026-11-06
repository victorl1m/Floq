import { badRequest, conflict } from "./errors.js";

export interface GitCommandResult {
  stdout: string;
  exitCode: number;
}

export type GitCommand = (args: string[]) => Promise<GitCommandResult>;

export interface ProjectBranches {
  currentBranch: string | null;
  branches: string[];
}

function requireSuccess(result: GitCommandResult, description: string): string {
  if (result.exitCode !== 0) throw badRequest(`Could not ${description} for this project.`, "git_branch_failed");
  return result.stdout;
}

async function readBranches(run: GitCommand): Promise<string[]> {
  const stdout = requireSuccess(await run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]), "list local branches");
  return [...new Set(stdout.split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function readCurrentBranch(run: GitCommand): Promise<string | null> {
  const result = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) throw badRequest("Could not read the current project branch.", "git_branch_failed");
  return result.stdout.trim() || null;
}

export async function listProjectBranches(run: GitCommand): Promise<ProjectBranches> {
  const [branches, currentBranch] = await Promise.all([readBranches(run), readCurrentBranch(run)]);
  return { currentBranch, branches };
}

/**
 * Side-effect-free pre-flight: throws the same error `switchProjectBranch` would for what is knowable without side effects
 * (invalid branch, branch held by another worktree) without touching the checkout. Local-change conflicts are left to git. Returns whether a checkout is needed (false = already on it).
 */
export async function checkProjectBranchSwitch(run: GitCommand, branch: unknown): Promise<{ branch: string; needsSwitch: boolean }> {
  if (typeof branch !== "string" || !branch.trim() || branch.length > 250 || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw badRequest("Choose a valid local branch.", "invalid_branch");
  }
  const [branches, currentBranch] = await Promise.all([readBranches(run), readCurrentBranch(run)]);
  if (!branches.includes(branch)) throw badRequest("That local branch is no longer available.", "invalid_branch");
  if (branch === currentBranch) return { branch, needsSwitch: false };

  // No clean-tree requirement: uncommitted and untracked changes travel with the user, exactly like plain `git switch`.
  // A real conflict is detected by git itself when the switch runs (atomic: a refused switch changes nothing).
  const worktrees = requireSuccess(await run(["worktree", "list", "--porcelain"]), "check other worktrees");
  const occupiedRef = `branch refs/heads/${branch}`;
  if (worktrees.split(/\r?\n/).some((line) => line.trim() === occupiedRef)) {
    throw conflict("That branch is already checked out in another workspace.", "project_branch_in_use");
  }

  return { branch, needsSwitch: true };
}

/** File names git lists (tab-indented) when it refuses a switch because local files would be overwritten. */
export function conflictingFiles(output: string, cap = 8): { files: string[]; more: number } {
  const all = output.split(/\r?\n/).filter((line) => /^\t\S/.test(line)).map((line) => line.trim().replace(/[\u0000-\u001f\u007f]/g, ""));
  const unique = [...new Set(all)];
  return { files: unique.slice(0, cap), more: Math.max(0, unique.length - cap) };
}

export async function switchProjectBranch(run: GitCommand, branch: unknown): Promise<string> {
  const checked = await checkProjectBranchSwitch(run, branch);
  if (!checked.needsSwitch) return checked.branch;
  // Never --force / --discard-changes / stash: git refuses atomically if local work would be lost.
  const switched = await run(["switch", "--quiet", "--no-recurse-submodules", "--", checked.branch]);
  if (switched.exitCode !== 0) {
    const { files, more } = conflictingFiles(switched.stdout);
    if (files.length > 0) {
      const list = files.join(", ") + (more > 0 ? ` and ${more} more` : "");
      throw conflict(`Git refused to switch to ${checked.branch} because it would overwrite your local changes in: ${list}. Commit or stash those files, then try again. Nothing was changed.`, "project_branch_switch_conflict");
    }
    throw conflict("Git could not switch branches. Nothing was changed; review the working tree and try again.", "project_branch_switch_failed");
  }
  return checked.branch;
}
