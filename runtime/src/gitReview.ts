import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { SessionManager } from "./manager.js";
import { HttpError, badRequest, notFound, unavailable } from "./errors.js";
import type { ShardService } from "./shards.js";
import { readHomeFile, UnsafeHomePathError, type ShardHandle } from "./shard.js";
import { GIT_HARDENING_ARGS, GIT_HARDENING_ENV } from "./worktree.js";

const COMMAND_TIMEOUT_MS = 8_000;
const STATUS_LIMIT_BYTES = 1024 * 1024;
const DIFF_LIMIT_BYTES = 200 * 1024;
const CHANGE_LIMIT = 1_000;

export interface GitChange {
  path: string;
  originalPath?: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitChanges {
  repository: string;
  branch: string | null;
  changes: GitChange[];
  truncated: boolean;
}

export interface GitFileDiff {
  path: string;
  patch: string;
  binary: boolean;
  tooLarge: boolean;
}

interface CommandResult { stdout: Buffer; code: number }

/** Read-only inspection of the repository attached to one authenticated Floq session. */
export class GitReview {
  constructor(private readonly manager: SessionManager, private readonly shards: ShardService) {}

  async changes(userId: string, sessionId: string): Promise<GitChanges> {
    const { root, handle } = await this.repository(userId, sessionId);
    const [status, branch] = await Promise.all([
      this.git(root, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], STATUS_LIMIT_BYTES, true, handle),
      this.git(root, ["branch", "--show-current"], 4096, true, handle),
    ]);
    if (status.code !== 0) throw badRequest("This project is not a Git repository", "not_git_repository");
    const parsed = parseStatus(status.stdout.toString("utf8"));
    return {
      repository: root.split(/[\\/]/).filter(Boolean).at(-1) || "Project",
      branch: branch.code === 0 ? branch.stdout.toString("utf8").trim() || null : null,
      changes: parsed.changes.slice(0, CHANGE_LIMIT),
      truncated: parsed.truncated || parsed.changes.length > CHANGE_LIMIT,
    };
  }

  async diff(userId: string, sessionId: string, requestedPath: unknown): Promise<GitFileDiff> {
    if (typeof requestedPath !== "string" || !requestedPath || requestedPath.length > 4096 || requestedPath.includes("\0")) {
      throw badRequest("Choose a changed file to inspect", "invalid_change_path");
    }
    const { root, handle } = await this.repository(userId, sessionId);
    const status = await this.git(root, ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], STATUS_LIMIT_BYTES, true, handle);
    if (status.code !== 0) throw badRequest("This project is not a Git repository", "not_git_repository");
    const change = parseStatus(status.stdout.toString("utf8")).changes.find((item) => item.path === requestedPath);
    if (!change) throw notFound("That file is no longer changed. Refresh the change list.");

    const chunks: Buffer[] = [];
    let tooLarge = false;
    const collect = (result: CommandResult) => {
      const remaining = DIFF_LIMIT_BYTES - chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (result.stdout.length > remaining) {
        chunks.push(result.stdout.subarray(0, Math.max(0, remaining)));
        tooLarge = true;
      } else chunks.push(result.stdout);
    };

    if (change.untracked) {
      // Do not follow an untracked symlink: it could target data outside this user's encrypted home.
      const filePath = resolve(root, change.path);
      const fileRelative = relative(root, filePath);
      if (fileRelative.startsWith("..") || isAbsolute(fileRelative)) throw badRequest("Invalid changed file path", "invalid_change_path");
      const resolvedFile = await realpath(filePath).catch(() => null);
      if (!resolvedFile || !isWithin(root, resolvedFile)) throw badRequest("Changed file points outside this project", "invalid_change_path");
      const info = await lstat(filePath).catch(() => null);
      if (!info || !info.isFile()) throw notFound("That file is no longer available. Refresh the change list.");
      if (info.size > DIFF_LIMIT_BYTES) {
        return { path: change.path, patch: "", binary: false, tooLarge: true };
      }
      const untracked = await this.git(root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", process.platform === "win32" ? "NUL" : "/dev/null", change.path], DIFF_LIMIT_BYTES, true, handle);
      if (untracked.code > 1) throw badRequest("Could not read this changed file", "git_diff_failed");
      collect(untracked);
    } else {
      const paths = [...new Set([change.path, ...(change.originalPath ? [change.originalPath] : [])])];
      const args = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...paths];
      const [unstaged, staged] = await Promise.all([
        this.git(root, args, DIFF_LIMIT_BYTES, false, handle),
        this.git(root, ["--literal-pathspecs", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...paths], DIFF_LIMIT_BYTES, false, handle),
      ]);
      if (unstaged.code !== 0 || staged.code !== 0) throw badRequest("Could not read this changed file", "git_diff_failed");
      collect(staged);
      collect(unstaged);
    }
    const patch = Buffer.concat(chunks).toString("utf8");
    return {
      path: change.path,
      patch: tooLarge ? patch + "\n[Diff shortened to keep the response small.]" : patch,
      binary: patch.includes("Binary files ") || patch.includes("GIT binary patch"),
      tooLarge,
    };
  }

  private async repository(userId: string, sessionId: string): Promise<{ root: string; handle: ShardHandle }> {
    // manager.get performs the owner-scoped lookup and deliberately returns no host paths.
    const session = await this.manager.get(sessionId, userId);
    const handle = await this.shards.wake(userId);
    const home = await realpath(handle.mountPath);
    const sessionRoot = await realpath(this.shards.driver.hostPath(handle, session.cwd)).catch(() => null);
    if (!sessionRoot || !isWithin(home, sessionRoot)) throw notFound("The project folder is unavailable");
    const stat = await lstat(sessionRoot).catch(() => null);
    if (!stat?.isDirectory()) throw notFound("The project folder is unavailable");
    const top = await this.git(sessionRoot, ["rev-parse", "--show-toplevel"], 16 * 1024, true, handle);
    if (top.code !== 0) throw badRequest("This project is not a Git repository", "not_git_repository");
    const root = await realpath(top.stdout.toString("utf8").trim()).catch(() => null);
    if (!root || !isWithin(home, root)) throw notFound("The project folder is unavailable");
    const [gitDir, commonDir] = await Promise.all([
      this.git(root, ["rev-parse", "--absolute-git-dir"], 16 * 1024, true, handle),
      this.git(root, ["rev-parse", "--git-common-dir"], 16 * 1024, true, handle),
    ]);
    if (gitDir.code !== 0 || commonDir.code !== 0) throw badRequest("This project is not a Git repository", "not_git_repository");
    for (const output of [gitDir, commonDir]) {
      const gitPath = await realpath(resolve(root, output.stdout.toString("utf8").trim())).catch(() => null);
      if (!gitPath || !isWithin(home, gitPath)) throw badRequest("This Git workspace points outside your project", "invalid_git_workspace");
    }
    const objectsOutput = await this.git(root, ["rev-parse", "--git-path", "objects"], 16 * 1024, true, handle);
    if (objectsOutput.code !== 0) throw badRequest("This project is not a Git repository", "not_git_repository");
    const objects = await realpath(resolve(root, objectsOutput.stdout.toString("utf8").trim())).catch(() => null);
    if (!objects || !isWithin(home, objects)) throw badRequest("This Git workspace points outside your project", "invalid_git_workspace");
    const alternatesFile = resolve(objects, "info", "alternates");
    const alternatesPath = await realpath(alternatesFile).catch(() => null);
    if (alternatesPath) {
      if (!isWithin(home, alternatesPath)) throw badRequest("This Git workspace points outside your project", "invalid_git_workspace");
      // Read by descriptor (no link, never a FIFO that would hang the request) and only if it still lives inside the home.
      let alternates = "";
      try { alternates = readHomeFile(home, alternatesPath, null, 64 * 1024)?.text ?? ""; } catch (error) {
        if (error instanceof UnsafeHomePathError) throw badRequest("This Git workspace points outside your project", "invalid_git_workspace");
        throw error;
      }
      for (const alternate of alternates.split(/\r?\n/).filter(Boolean)) {
        const alternatePath = await realpath(resolve(objects, alternate)).catch(() => null);
        if (!alternatePath || !isWithin(home, alternatePath)) throw badRequest("This Git workspace points outside your project", "invalid_git_workspace");
      }
    }
    return { root, handle };
  }

  private git(root: string, args: string[], maxBytes: number, allowFailure: boolean, handle: ShardHandle): Promise<CommandResult> {
    return new Promise((resolveResult, reject) => {
      const gitArgs = ["--no-pager", "-C", root, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...GIT_HARDENING_ARGS, ...args];
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpdir(),
        TMPDIR: tmpdir(),
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        ...GIT_HARDENING_ENV,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_PAGER: "cat",
        PAGER: "cat",
      };
      // Agent-controlled .git/config and info/attributes can name filter drivers, so git runs in the agent's own sandbox
      // (bwrap + per-user netns), never on the host. The home is also bound at its host path there, so `-C root` resolves.
      const child = this.shards.driver.spawnPipe(handle, { file: "git", args: gitArgs, env, cwd: "." });
      child.stderr?.resume();
      const stdout: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          child.kill("SIGKILL");
          finishError(new HttpError(413, "git_output_too_large", "This project has too much changed-file output to inspect at once."));
          return;
        }
        stdout.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finishError(error.code === "ENOENT" ? unavailable("Git is temporarily unavailable.", "git_unavailable") : unavailable("Git could not inspect this project.", "git_unavailable"));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = { stdout: Buffer.concat(stdout), code: code ?? 1 };
        if (!allowFailure && result.code !== 0 && result.code !== 1) {
          reject(badRequest("Git could not inspect this project", "git_review_failed"));
          return;
        }
        resolveResult(result);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finishError(new HttpError(408, "git_timeout", "Git took too long to inspect this project. Try again."));
      }, COMMAND_TIMEOUT_MS);
    });
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function parseStatus(raw: string): { changes: GitChange[]; truncated: boolean } {
  const tokens = raw.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4 || token[2] !== " ") continue;
    const xy = token.slice(0, 2);
    const path = token.slice(3);
    const rename = xy.includes("R") || xy.includes("C");
    const originalPath = rename ? tokens[++index] : undefined;
    changes.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      status: xy,
      staged: xy[0] !== " " && xy[0] !== "?",
      unstaged: xy[1] !== " ",
      untracked: xy === "??",
    });
  }
  return { changes, truncated: raw.length >= STATUS_LIMIT_BYTES };
}
