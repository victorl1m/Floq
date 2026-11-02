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

export async function switchProjectBranch(run: GitCommand, branch: unknown): Promise<string> {
  if (typeof branch !== "string" || !branch.trim() || branch.length > 250 || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw badRequest("Choose a valid local branch.", "invalid_branch");
  }
  const [branches, currentBranch] = await Promise.all([readBranches(run), readCurrentBranch(run)]);
  if (!branches.includes(branch)) throw badRequest("That local branch is no longer available.", "invalid_branch");
  if (branch === currentBranch) return branch;

  const status = requireSuccess(await run(["status", "--porcelain=v1", "--untracked-files=all"]), "check the working tree");
  if (status.length > 0) throw conflict("Commit or move your uncommitted and untracked changes before switching branches.", "project_worktree_dirty");

  const worktrees = requireSuccess(await run(["worktree", "list", "--porcelain"]), "check other worktrees");
  const occupiedRef = `branch refs/heads/${branch}`;
  if (worktrees.split(/\r?\n/).some((line) => line.trim() === occupiedRef)) {
    throw conflict("That branch is already checked out in another workspace.", "project_branch_in_use");
  }

  const switched = await run(["switch", "--quiet", "--no-recurse-submodules", "--", branch]);
  if (switched.exitCode !== 0) {
    throw conflict("Git could not switch branches. The working tree may have changed; review it and try again.", "project_branch_switch_failed");
  }
  return branch;
}
