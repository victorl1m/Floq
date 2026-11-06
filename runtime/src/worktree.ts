import { execFile as execFileCallback } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { badRequest, conflict } from "./errors.js";
import { mkdirOwnedSegment } from "./shard.js";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * Git is launched outside the sandbox on repositories the agent controls. `filter.<name>.clean/smudge/process` drivers cannot
 * be disabled by name, so every source of attributes that would select one is neutralised instead: system and global
 * attribute files, and (git >= 2.40) the worktree/index .gitattributes via an empty attribute tree. info/attributes inside
 * .git is the one source git offers no switch for.
 */
export const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const GIT_HARDENING_ENV: Record<string, string> = { GIT_ATTR_NOSYSTEM: "1", GIT_ATTR_SOURCE: GIT_EMPTY_TREE, GIT_TERMINAL_PROMPT: "0" };
export const GIT_HARDENING_ARGS = ["-c", "core.attributesFile=" + NULL_DEVICE, "-c", "protocol.ext.allow=never", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + NULL_DEVICE];

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

async function git(args: string[], cwd: string, runAsUser?: (args: string[]) => Promise<string>): Promise<string> {
  const command = [...GIT_HARDENING_ARGS, "-C", cwd, ...args];
  if (runAsUser) return runAsUser(command);
  try {
    const result = await execFile("git", command, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "", HOME: process.platform === "win32" ? process.env.TEMP ?? "C:\\Temp" : "/tmp", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEVICE, ...GIT_HARDENING_ENV },
    });
    return result.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    throw new Error("git worktree operation failed: " + message);
  }
}

export interface WorktreeRequest {
  home: string;
  source: string;
  target: string;
  branch: string;
  uid?: number;
  /** Execute Git as the shard owner in production; tests and local mode use Git directly. */
  runAsUser?: (args: string[]) => Promise<string>;
}

/** Create a sibling worktree without changing the source working tree or replacing an existing path. */
export async function createWorktree(request: WorktreeRequest): Promise<{ cwd: string; repo: string }> {
  let home: string;
  let source: string;
  try {
    home = realpathSync(request.home);
    source = realpathSync(request.source);
  } catch {
    throw badRequest("Isolation requires an existing project directory", "isolation_not_repo");
  }
  if (!inside(home, source)) throw badRequest("Project directory is outside this user's workspace", "isolation_outside_workspace");
  const repo = await git(["rev-parse", "--show-toplevel"], source, request.runAsUser).catch(() => {
    throw badRequest("Isolation requires a Git repository", "isolation_not_repo");
  });
  const repoPath = realpathSync(repo);
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath, request.runAsUser)
    .then((path) => realpathSync(path))
    .catch(() => { throw badRequest("Git repository metadata is unavailable", "isolation_invalid_repo"); });
  if (!inside(home, repoPath) || !inside(home, common)) {
    throw badRequest("Git repository metadata must stay inside this user's workspace", "isolation_outside_workspace");
  }

  const requestedTarget = resolve(request.target);
  if (!inside(home, requestedTarget)) throw badRequest("Worktree destination is outside this user's workspace", "isolation_outside_workspace");
  const parentRel = relative(home, resolve(requestedTarget, ".."));
  let current = home;
  for (const part of parentRel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw badRequest("Worktree destination parent must be a real directory", "isolation_invalid_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Created and chowned through an O_NOFOLLOW descriptor proven to be inside the home (a swapped parent cannot redirect root).
      mkdirOwnedSegment(home, current, request.uid ?? process.getuid?.() ?? 0);
    }
  }
  let targetParent: string;
  try {
    targetParent = realpathSync(resolve(request.target, ".."));
  } catch {
    throw badRequest("Worktree destination parent is unavailable", "isolation_invalid_path");
  }
  const target = resolve(targetParent, request.target.split(/[\\/]/).at(-1) ?? "");
  if (!inside(home, targetParent) || !inside(home, target)) {
    throw badRequest("Worktree destination is outside this user's workspace", "isolation_outside_workspace");
  }
  try {
    lstatSync(target);
    throw conflict("Worktree destination already exists", "worktree_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!/^floq\/[0-9a-f-]{36}$/i.test(request.branch)) throw badRequest("Invalid isolated worktree branch", "invalid_worktree_branch");

  try {
    await git(["worktree", "add", "-b", request.branch, "--", target, "HEAD"], repoPath, request.runAsUser);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : "Could not create isolated worktree", "worktree_create_failed");
  }
  let actual: string;
  try {
    actual = realpathSync(target);
  } catch {
    throw badRequest("Git did not create the requested worktree", "worktree_create_failed");
  }
  if (actual !== target || !inside(home, actual)) throw badRequest("Git created a worktree outside the user's workspace", "isolation_outside_workspace");
  const subdir = relative(repoPath, source);
  return { cwd: [relative(home, actual), subdir].filter(Boolean).join("/"), repo: relative(home, repoPath) };
}
