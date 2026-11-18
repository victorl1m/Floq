import { constants as fsConstants, existsSync } from "node:fs";
import { downloadContentType } from "./mediaTypes.js";
import { lstat, open, opendir, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { serveTranscode, TranscodeLimiter } from "./transcode.js";
import type { SessionManager } from "./manager.js";
import { badRequest, notFound } from "./errors.js";
import { safeRelative } from "./shard.js";
import type { ShardService } from "./shards.js";
import { createWorkspaceEntry, type CreatedEntry } from "./workspaceWrite.js";

const LIST_LIMIT = 2_000;
const LIST_SCAN_LIMIT = 50_000;
const READ_LIMIT_BYTES = 512 * 1024;
export const HIDDEN_NAMES = new Set([".git", "node_modules"]);
export const ZIP_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 50_000;
export const HAS_PROC_FD = existsSync("/proc/self/fd");

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


/**
 * Open `path` and only then prove, on the descriptor itself, that it lives inside `realRoot` (and outside .git).
 * Checking a path and opening it later is a race: an agent in the sandbox controls the tree and could swap a checked
 * directory for a symlink into another user's mounted shard, which this process (root) would then read.
 * O_NONBLOCK keeps an agent-planted FIFO from hanging the open; callers check the file type on the handle.
 * The final component is opened with O_NOFOLLOW (callers pass already-realpath'd paths): root must never be led through a
 * symlink swapped in after realpath, e.g. to a device with side effects on open. A link there answers 404 (ELOOP).
 * `followLink` is only for listing code that deliberately resolves in-workspace links; the descriptor check below still applies.
 */
export async function openWithin(realRoot: string, path: string, flags = fsConstants.O_RDONLY, followLink = false): Promise<FileHandle> {
  const handle = await open(path, flags | fsConstants.O_NONBLOCK | (followLink ? 0 : fsConstants.O_NOFOLLOW)).catch(() => null);
  if (!handle) throw notFound("That file is no longer available");
  try {
    let actual: string | null = null;
    if (HAS_PROC_FD) actual = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (actual === null) {
      // No /proc (macOS dev hosts): the path must still resolve to the very inode we opened.
      const resolved = await realpath(path).catch(() => null);
      const [opened, current] = await Promise.all([handle.stat(), resolved ? stat(resolved).catch(() => null) : null]);
      if (!resolved || !current || opened.dev !== current.dev || opened.ino !== current.ino) throw badRequest("That path points outside this workspace", "invalid_file_path");
      actual = resolved;
    }
    actual = actual.replace(/ \(deleted\)$/, "");
    if (!isWithin(realRoot, actual) || relative(realRoot, actual).split(sep).includes(".git")) throw badRequest("That path points outside this workspace", "invalid_file_path");
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Content-Disposition for an attachment: sanitised ASCII fallback plus an RFC 5987 filename*. */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim() || "download";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/%/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Parse a single `bytes=` range. null = no/ignored range, "invalid" = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "invalid";
  return { start, end };
}

/** Read-only file browsing scoped to the workspace root of one authenticated Floq session. */
export const transcodeLimiter = new TranscodeLimiter();

export class WorkspaceFiles {
  constructor(private readonly manager: SessionManager, private readonly shards: ShardService) {}

  async list(userId: string, sessionId: string, requested: unknown): Promise<FileListing> {
    const root = await this.root(userId, sessionId);
    const { rel, real } = await resolveInside(root, requested);
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) throw notFound("The project folder is unavailable");
    // Read through a verified descriptor: a swapped directory cannot redirect this root-run listing outside the workspace.
    const dirHandle = await openWithin(realRoot, real, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY).catch(() => null);
    if (!dirHandle) throw notFound("That folder is no longer available");
    const entries: FileEntry[] = [];
    let truncated = false;
    try {
      const info = await dirHandle.stat();
      if (!info.isDirectory()) throw notFound("That folder is no longer available");
      const base = HAS_PROC_FD ? `/proc/self/fd/${dirHandle.fd}` : real;
      const dir = await opendir(base).catch(() => null);
      if (!dir) throw notFound("That folder is no longer available");
      let scanned = 0;
      try {
        for await (const dirent of dir) {
          // Cap both what is shown and what is scanned so a directory with millions of entries cannot stall the runtime.
          if (++scanned > LIST_SCAN_LIMIT || entries.length > LIST_LIMIT) { truncated = true; break; }
          if (HIDDEN_NAMES.has(dirent.name) || dirent.name.includes("\0")) continue;
          let type: FileEntry["type"] | null = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : null;
          if (dirent.isSymbolicLink()) {
            // Only show links that resolve to something inside the workspace, proven on a descriptor.
            const linked = await openWithin(realRoot, join(base, dirent.name), fsConstants.O_RDONLY, true).catch(() => null);
            const targetInfo = linked ? await linked.stat().catch(() => null) : null;
            await linked?.close().catch(() => {});
            type = targetInfo?.isDirectory() ? "dir" : targetInfo?.isFile() ? "file" : null;
          }
          if (!type) continue;
          entries.push({ name: dirent.name, path: rel ? `${rel}/${dirent.name}` : dirent.name, type });
        }
      } finally {
        await dir.close().catch(() => {});
      }
    } finally {
      await dirHandle.close().catch(() => {});
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { path: rel, entries: entries.slice(0, LIST_LIMIT), truncated: truncated || entries.length > LIST_LIMIT };
  }

  async read(userId: string, sessionId: string, requested: unknown): Promise<FileContent> {
    const root = await this.root(userId, sessionId);
    const { rel, real } = await resolveInside(root, requested);
    if (!rel) throw badRequest("Choose a file to read", "invalid_file_path");
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) throw notFound("The project folder is unavailable");
    // Verified, non-blocking open: the type is checked on the handle, never on a path that could be swapped (or a FIFO).
    const handle = await openWithin(realRoot, real, fsConstants.O_RDONLY);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw notFound("That file is no longer available");
      if (info.size > READ_LIMIT_BYTES) return { path: rel, size: info.size, binary: false, tooLarge: true, content: "" };
      const buffer = Buffer.alloc(Math.min(info.size, READ_LIMIT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, bytesRead);
      const binary = data.subarray(0, 8000).includes(0);
      return { path: rel, size: info.size, binary, tooLarge: false, content: binary ? "" : data.toString("utf8") };
    } finally {
      await handle.close();
    }
  }


  /** Create an empty file or folder in a workspace folder, owned by the sandbox user. Same owner scoping as read/list. */
  async create(userId: string, sessionId: string, body: { path?: unknown; name?: unknown; kind?: unknown }): Promise<CreatedEntry> {
    const root = await this.root(userId, sessionId);
    const handle = await this.shards.wake(userId);
    return createWorkspaceEntry(root, body.path, body.name, body.kind, (handle as { uid?: number }).uid);
  }

  /** Owner-scoped check done when a download link is issued: the session must be the user's and the path well formed. */
  async authorizeDownload(userId: string, sessionId: string, requested: unknown): Promise<string> {
    await this.manager.get(sessionId, userId);
    return cleanRelativePath(requested);
  }

  /**
   * Stream a file (with Range) or a directory (as a zip) to `res`. The shard stays awake until the stream ends, and
   * every opened descriptor is re-verified to be inside the workspace root. Throws HttpErrors before headers are sent.
   */
  download(userId: string, sessionId: string, requested: unknown, res: ServerResponse, rangeHeader?: string): Promise<void> {
    return this.manager.withUserShardActivity(userId, () => this.serveDownload(userId, sessionId, requested, res, rangeHeader));
  }

  /** Same auth and path resolution as download(), but the file is converted to fragmented MP4 with ffmpeg while streaming. */
  transcode(userId: string, sessionId: string, requested: unknown, startSeconds: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.manager.withUserShardActivity(userId, async () => {
      const root = await this.root(userId, sessionId);
      const realRoot = await realpath(root);
      const { real } = await resolveInside(root, requested);
      const handle = await this.shards.wake(userId);
      const open = async () => {
        const opened = await openWithin(realRoot, real, fsConstants.O_RDONLY);
        if (!(await opened.stat()).isFile()) { await opened.close().catch(() => {}); throw notFound("That file is no longer available"); }
        return opened;
      };
      await serveTranscode({ userId, open, runAsUid: this.shards.driver.name === "linux" ? (handle as { uid?: number }).uid : undefined, startSeconds, req, res, limiter: transcodeLimiter });
    });
  }

  private async serveDownload(userId: string, sessionId: string, requested: unknown, res: ServerResponse, rangeHeader?: string): Promise<void> {
    const root = await this.root(userId, sessionId);
    const realRoot = await realpath(root);
    const { rel, real } = await resolveInside(root, requested);
    const common = { "Content-Type": downloadContentType(basename(rel)), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
    const handle = await openWithin(realRoot, real, fsConstants.O_RDONLY);
    let closed = false;
    const closeHandle = async () => { if (!closed) { closed = true; await handle.close().catch(() => {}); } };
    try {
      const info = await handle.stat();
      if (info.isFile()) {
        const range = parseRange(rangeHeader, info.size);
        if (range === "invalid") {
          res.writeHead(416, { ...common, "Content-Range": `bytes */${info.size}` }).end();
          return;
        }
        const length = range ? range.end - range.start + 1 : info.size;
        res.writeHead(range ? 206 : 200, {
          ...common,
          "Accept-Ranges": "bytes",
          "Content-Length": length,
          "Content-Disposition": contentDisposition(basename(rel) || "download"),
          ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } : {}),
        });
        if (length === 0) { res.end(); return; }
        // The stream owns the handle from here (autoClose).
        closed = true;
        await pipeline(handle.createReadStream({ start: range?.start ?? 0, end: range?.end ?? info.size - 1 }), res).catch(() => {});
        return;
      }
      if (!info.isDirectory()) throw notFound("That file is no longer available");
      res.writeHead(200, { ...common, "Content-Disposition": contentDisposition(`${basename(rel) || "workspace"}.zip`) });
      await this.zipDirectory(realRoot, real, basename(rel) || "workspace", res);
    } finally {
      await closeHandle();
    }
  }

  private async zipDirectory(realRoot: string, dir: string, topName: string, res: ServerResponse): Promise<void> {
    const zip = new ZipFile();
    let aborted = false;
    let current: Readable | null = null;
    const abort = () => { aborted = true; current?.destroy(); (zip.outputStream as Readable).destroy(); };
    res.once("close", abort);
    const piping = pipeline(zip.outputStream as Readable, res).catch(() => {});
    const budget = { bytes: 0, entries: 0 };
    try {
      await this.zipWalk(realRoot, dir, `${topName}/`, zip, budget, () => aborted, (stream) => { current = stream; });
      if (!aborted) zip.end();
    } catch (error) {
      // Headers are already out: a failed or oversized archive must not look like a complete one.
      aborted = true;
      (zip.outputStream as Readable).destroy();
      res.destroy(error instanceof Error ? error : undefined);
    }
    await piping;
    res.off("close", abort);
  }

  private async zipWalk(realRoot: string, dir: string, prefix: string, zip: ZipFile, budget: { bytes: number; entries: number }, isAborted: () => boolean, track: (stream: Readable | null) => void): Promise<void> {
    const dirHandle = await openWithin(realRoot, dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      // Reading and opening through the verified descriptor means a swapped directory cannot redirect the walk.
      const base = HAS_PROC_FD ? `/proc/self/fd/${dirHandle.fd}` : dir;
      const dirents = (await readdir(base, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      let wrote = false;
      for (const dirent of dirents) {
        if (isAborted()) return;
        const name = dirent.name;
        if (HIDDEN_NAMES.has(name) || name.includes("\0") || name.includes("\\")) continue;
        const child = join(base, name);
        if (dirent.isDirectory()) {
          wrote = true;
          if (++budget.entries > ZIP_MAX_ENTRIES) throw badRequest("This folder is too large to download as a zip", "download_too_large");
          await this.zipWalk(realRoot, child, `${prefix}${name}/`, zip, budget, isAborted, track);
          continue;
        }
        if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
        const handle = await openWithin(realRoot, child, fsConstants.O_RDONLY, true).catch(() => null);
        if (!handle) continue; // vanished, or a link pointing outside the workspace
        let queued = false;
        try {
          const info = await handle.stat();
          if (!info.isFile()) continue; // symlinked directories and special files are skipped (no loops)
          budget.entries += 1;
          budget.bytes += info.size;
          if (budget.entries > ZIP_MAX_ENTRIES || budget.bytes > ZIP_MAX_BYTES) throw badRequest("This folder is too large to download as a zip", "download_too_large");
          // Snapshot the size so a file that grows mid-download cannot exceed the budget.
          if (info.size === 0) { zip.addBuffer(Buffer.alloc(0), `${prefix}${name}`, { mtime: info.mtime }); wrote = true; continue; }
          const stream = handle.createReadStream({ start: 0, end: info.size - 1 });
          queued = true;
          wrote = true;
          track(stream);
          const done = new Promise<void>((resolve, reject) => { stream.once("close", resolve); stream.once("error", reject); });
          zip.addReadStream(stream, `${prefix}${name}`, { mtime: info.mtime, size: info.size });
          await done;
          track(null);
        } finally {
          if (!queued) await handle.close().catch(() => {});
        }
      }
      if (!wrote) zip.addEmptyDirectory(prefix);
    } finally {
      await dirHandle.close().catch(() => {});
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
