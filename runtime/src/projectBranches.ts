import { badRequest, conflict } from "./errors.js";

export interface GitCommandResult {
  stdout: string;
  exitCode: number;
}

export type GitCommand = (args: string[]) => Promise<GitCommandResult>;

export interface ProjectBranches {
  currentBranch: string | null;
  /** Local branches plus branches that exist only on a remote (by their short name, e.g. "feat/x"), sorted. */
  branches: string[];
  /** The subset of `branches` that exists only on a remote: switching to one creates a local branch tracking it. */
  remoteOnly: string[];
  /** Set when a fetch was asked for and failed (offline, no access): the list then shows what was already known. */
  fetchError?: string;
}

/** Floq's own agent worktree branches (floq/<uuid>): always checked out in an agent's worktree, never switch targets. */
const AGENT_BRANCH = /^floq\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireSuccess(result: GitCommandResult, description: string): string {
  if (result.exitCode !== 0) throw badRequest(`Could not ${description} for this project.`, "git_branch_failed");
  return result.stdout;
}

const lines = (stdout: string) => [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];

async function readBranches(run: GitCommand): Promise<string[]> {
  const stdout = requireSuccess(await run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]), "list local branches");
  return lines(stdout).sort((a, b) => a.localeCompare(b));
}

/**
 * Remote-tracking branches as short name -> full remote ref ("feat/x" -> "origin/feat/x"). "origin" wins when a branch is on
 * several remotes. Symbolic refs (origin/HEAD) are skipped.
 */
async function readRemoteBranches(run: GitCommand): Promise<Map<string, string>> {
  const result = await run(["for-each-ref", "--format=%(refname:lstrip=2)%09%(symref)", "refs/remotes"]);
  const map = new Map<string, string>();
  if (result.exitCode !== 0) return map;
  for (const line of lines(result.stdout)) {
    const [ref, symref] = line.split("\t");
    if (!ref || symref) continue;
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) continue;
    const remote = ref.slice(0, slash), name = ref.slice(slash + 1);
    if (name === "HEAD") continue;
    if (!map.has(name) || remote === "origin") map.set(name, ref);
  }
  return map;
}

async function readAllBranches(run: GitCommand): Promise<{ branches: string[]; remoteOnly: Map<string, string> }> {
  const [local, remote] = await Promise.all([readBranches(run), readRemoteBranches(run)]);
  const remoteOnly = new Map([...remote].filter(([name]) => !local.includes(name) && !AGENT_BRANCH.test(name)));
  const branches = [...local.filter((name) => !AGENT_BRANCH.test(name)), ...remoteOnly.keys()].sort((a, b) => a.localeCompare(b));
  return { branches, remoteOnly };
}

async function readCurrentBranch(run: GitCommand): Promise<string | null> {
  const result = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) throw badRequest("Could not read the current project branch.", "git_branch_failed");
  return result.stdout.trim() || null;
}

/**
 * Branches to offer in the switcher. With `fetch`, first updates remote-tracking branches from every remote (best effort:
 * no tags, prune deleted ones; a failure only sets `fetchError`, the list still shows what was already known).
 */
export async function listProjectBranches(run: GitCommand, options: { fetch?: boolean } = {}): Promise<ProjectBranches> {
  let fetchError: string | undefined;
  if (options.fetch) {
    try {
      const fetched = await run(["fetch", "--all", "--prune", "--no-tags", "--quiet"]);
      if (fetched.exitCode !== 0) fetchError = "Could not fetch from the remote (offline or no access). Showing the branches already known.";
    } catch {
      fetchError = "Fetching from the remote took too long. Showing the branches already known.";
    }
  }
  const [{ branches, remoteOnly }, currentBranch] = await Promise.all([readAllBranches(run), readCurrentBranch(run)]);
  return { currentBranch, branches, remoteOnly: [...remoteOnly.keys()], ...(fetchError ? { fetchError } : {}) };
}

/**
 * Side-effect-free pre-flight: throws the same error `switchProjectBranch` would for what is knowable without side effects
 * (invalid branch, branch held by another worktree) without touching the checkout. Local-change conflicts are left to git. Returns whether a checkout is needed (false = already on it).
 */
export async function checkProjectBranchSwitch(run: GitCommand, branch: unknown): Promise<{ branch: string; needsSwitch: boolean; trackRemote?: string }> {
  if (typeof branch !== "string" || !branch.trim() || branch.startsWith("-") || branch.length > 250 || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw badRequest("Choose a valid branch.", "invalid_branch");
  }
  const [branches, currentBranch, remote] = await Promise.all([readBranches(run), readCurrentBranch(run), readRemoteBranches(run)]);
  if (!branches.includes(branch)) {
    // Only on a remote: the switch creates a local branch that tracks it (nothing can hold it in another worktree yet).
    const trackRemote = remote.get(branch);
    if (!trackRemote || AGENT_BRANCH.test(branch)) throw badRequest("That branch is no longer available.", "invalid_branch");
    return { branch, needsSwitch: true, trackRemote };
  }
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
  const switched = checked.trackRemote
    ? await run(["switch", "--quiet", "--no-recurse-submodules", "--create", checked.branch, "--track", checked.trackRemote])
    : await run(["switch", "--quiet", "--no-recurse-submodules", "--", checked.branch]);
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
