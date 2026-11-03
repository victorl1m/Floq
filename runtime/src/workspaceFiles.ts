import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { SessionManager } from "./manager.js";
import { badRequest, notFound } from "./errors.js";
import { safeRelative } from "./shard.js";
import type { ShardService } from "./shards.js";

const LIST_LIMIT = 2_000;
const READ_LIMIT_BYTES = 512 * 1024;
const HIDDEN_NAMES = new Set([".git", "node_modules"]);

export interface FileEntry {
  name: string;
  /** Path relative to the workspace root, "/"-separated. */
  path: string;
  type: "dir" | "file";
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content: string;
}

export function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Normalise a client-supplied workspace-relative path. Rejects traversal, absolute and backslash paths, NUL and repository internals. */
export function cleanRelativePath(input: unknown): string {
  if (input === null || input === undefined || input === "") return "";
  if (typeof input !== "string" || input.length > 4096) throw badRequest("Invalid file path", "invalid_file_path");
  let rel: string;
  try { rel = safeRelative(input); } catch { throw badRequest("Invalid file path", "invalid_file_path"); }
  if (rel.split("/").includes(".git")) throw badRequest("This folder is not available", "invalid_file_path");
  return rel;
}

/**
 * Resolve a workspace-relative path to a real path that is guaranteed to stay inside the real workspace root,
 * following symlinks. Throws if it does not exist or if a symlink escapes the root.
 */
export async function resolveInside(root: string, input: unknown): Promise<{ rel: string; real: string }> {
  const rel = cleanRelativePath(input);
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) throw notFound("The project folder is unavailable");
  const real = await realpath(join(realRoot, rel)).catch(() => null);
  if (!real) throw notFound("That file is no longer available");
  if (!isWithin(realRoot, real)) throw badRequest("That path points outside this workspace", "invalid_file_path");
  return { rel, real };
}

/** Read-only file browsing scoped to the workspace root of one authenticated Floq session. */
export class WorkspaceFiles {
  constructor(private readonly manager: SessionManager, private readonly shards: ShardService) {}

  async list(userId: string, sessionId: string, requested: unknown): Promise<FileListing> {
    const root = await this.root(userId, sessionId);
    const { rel, real } = await resolveInside(root, requested);
    const info = await stat(real).catch(() => null);
    if (!info?.isDirectory()) throw notFound("That folder is no longer available");
    const dirents = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (!dirents) throw notFound("That folder is no longer available");
    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      if (HIDDEN_NAMES.has(dirent.name) || dirent.name.includes("\0")) continue;
      let type: FileEntry["type"] | null = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : null;
      if (dirent.isSymbolicLink()) {
        // Only show links that resolve to something inside the workspace.
        const target = await realpath(join(real, dirent.name)).catch(() => null);
        const targetInfo = target && isWithin(await realpath(root), target) ? await stat(target).catch(() => null) : null;
        type = targetInfo?.isDirectory() ? "dir" : targetInfo?.isFile() ? "file" : null;
      }
      if (!type) continue;
      entries.push({ name: dirent.name, path: rel ? `${rel}/${dirent.name}` : dirent.name, type });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: rel, entries: entries.slice(0, LIST_LIMIT), truncated: entries.length > LIST_LIMIT };
  }

  async read(userId: string, sessionId: string, requested: unknown): Promise<FileContent> {
    const root = await this.root(userId, sessionId);
    const { rel, real } = await resolveInside(root, requested);
    if (!rel) throw badRequest("Choose a file to read", "invalid_file_path");
    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) throw notFound("That file is no longer available");
    if (info.size > READ_LIMIT_BYTES) return { path: rel, size: info.size, binary: false, tooLarge: true, content: "" };
    const handle = await open(real, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, READ_LIMIT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, bytesRead);
      const binary = data.subarray(0, 8000).includes(0);
      return { path: rel, size: info.size, binary, tooLarge: false, content: binary ? "" : data.toString("utf8") };
    } finally {
      await handle.close();
    }
  }

  private async root(userId: string, sessionId: string): Promise<string> {
    // manager.get performs the owner-scoped lookup and deliberately returns no host paths.
    const session = await this.manager.get(sessionId, userId);
    const handle = await this.shards.wake(userId);
    const home = await realpath(handle.mountPath);
    const root = await realpath(this.shards.driver.hostPath(handle, session.cwd)).catch(() => null);
    if (!root || !isWithin(home, root)) throw notFound("The project folder is unavailable");
    const info = await lstat(root).catch(() => null);
    if (!info?.isDirectory()) throw notFound("The project folder is unavailable");
    return root;
  }
}
