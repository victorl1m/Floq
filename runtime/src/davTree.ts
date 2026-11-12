import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readlink, rename, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./errors.js";

/**
 * Descriptor-pinned tree walks for WebDAV writes.
 *
 * The runtime is root and an agent in the sandbox can swap any directory below the request target for a symlink at any
 * moment. Walking `join(path, name)` strings re-resolves every intermediate component, so a swap would make root read,
 * create or delete files anywhere on the host (including other tenants' mounted homes). Everything here therefore goes
 * through `/proc/self/fd/<dirfd>/<name>`: the directory is pinned by an open descriptor, the final component is opened
 * with O_NOFOLLOW (a swapped-in link fails with ELOOP/ENOTDIR instead of being followed), and the type of an entry is
 * decided with fstat on the opened handle, never with lstat on a path. No fs.rm({recursive}) and no path joins remain.
 */

export const fdPath = (fd: number, name?: string): string => (name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`);

const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY | fsConstants.O_NONBLOCK;
const ANY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
/** Opening these means "the entry is not what we expected any more / not copyable": links, FIFOs, sockets, vanished entries. */
const SKIPPABLE = new Set(["ENOENT", "ELOOP", "ENOTDIR", "ENXIO", "EOPNOTSUPP"]);

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const tooLarge = (message: string) => new HttpError(413, "payload_too_large", message);

export interface TreeBudgetOptions {
  maxEntries?: number;
  maxDepth?: number;
  /** Total bytes a copy may write. */
  maxBytes?: number;
  /** Shared-reserve claim made for every file before it is written; return false when the bytes are not available (answered with byteError). */
  claim?: (bytes: number) => boolean;
  /** Only regular files owned by this uid are copied (the sandbox user): root-owned files and hard links to host files are skipped. Unset = no check. */
  sourceUid?: number;
  /** Cap on the entries a rollback visits (default ROLLBACK_MAX_ENTRIES). */
  rollbackMaxEntries?: number;
  /** Error raised when maxBytes is exceeded (413 for the cap, 507 when the cap comes from free space). */
  byteError?: () => HttpError;
  /** Called per entry (mount revocation); may throw to abort. */
  guard?: () => Promise<void> | void;
  /** Test seam: called with the real path of the directory being walked and the entry name, right before the entry is opened. */
  onEntry?: (dirPath: string, name: string) => Promise<void> | void;
}

/** A rollback is never aborted by revocation, but it is bounded: an agent can keep adding files to the partial copy. The rest is the agent's own. */
export const ROLLBACK_MAX_ENTRIES = 200_000;

export class TreeBudget {
  entries = 0;
  bytes = 0;
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
  constructor(private readonly options: TreeBudgetOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100_000;
    this.maxDepth = options.maxDepth ?? 100;
    this.maxBytes = options.maxBytes ?? Infinity;
  }
  byteError(): HttpError { return this.options.byteError?.() ?? tooLarge("Folder is too large to copy"); }
  remaining(): number { return this.maxBytes - this.bytes; }
  claim(bytes: number): void { if (this.options.claim && !this.options.claim(bytes)) throw this.byteError(); }
  get sourceUid(): number | undefined { return this.options.sourceUid; }
  get rollbackMaxEntries(): number { return this.options.rollbackMaxEntries ?? ROLLBACK_MAX_ENTRIES; }
  async tick(dirFd: number, name: string): Promise<void> {
    if (++this.entries > this.maxEntries) throw tooLarge("Folder has too many entries");
    await this.options.guard?.();
    if (this.options.onEntry) await this.options.onEntry(await readlink(fdPath(dirFd)), name);
  }
  depth(depth: number): void { if (depth > this.maxDepth) throw tooLarge("Folder is nested too deeply"); }
}

/** Stream `source` into a fresh file at `path` (exclusive, never following a symlink), owned by the sandbox user. Returns the bytes written. */
export async function writeNewFile(path: string, mode: number, uid: number | undefined, source: NodeJS.ReadableStream, limit: number, over: () => HttpError = () => tooLarge("File too large")): Promise<number> {
  const fh = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  let written = 0;
  try {
    if (uid !== undefined) await fh.chown(uid, uid);
    const counter = new Transform({ transform(chunk: Buffer, _enc, done) { written += chunk.length; done(written > limit ? over() : null, chunk); } });
    await pipeline(source, counter, fh.createWriteStream());
    return written;
  } catch (error) {
    await fh.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}

/**
 * Publish `temp` as `target`. With `exclusive` a racing creator is never clobbered: link() fails with EEXIST (answered as
 * 412 by the caller) and the temp file is removed. Filesystems without hard links fall back to rename (check-then-act).
 */
export async function commitFile(temp: string, target: string, exclusive: boolean): Promise<void> {
  if (!exclusive) { await rename0(temp, target); return; }
  try {
    await link(temp, target);
  } catch (error) {
    const code = errno(error);
    if (code === "EEXIST") { await unlink(temp).catch(() => {}); throw new HttpError(412, "precondition_failed", "The destination exists"); }
    if (code === "EPERM" || code === "ENOSYS" || code === "EOPNOTSUPP" || code === "EMLINK") {
      if (await lstat(target).then(() => true, () => false)) { await unlink(temp).catch(() => {}); throw new HttpError(412, "precondition_failed", "The destination exists"); }
      await rename0(temp, target);
      return;
    }
    await unlink(temp).catch(() => {});
    throw error;
  }
  await unlink(temp).catch(() => {});
}

/**
 * MOVE with Overwrite:F: publish `src` as `dst` without clobbering a creator that raced the caller's lstat (rename would).
 * link + unlink fails with EEXIST (412); filesystems without hard links fall back to check-then-rename.
 */
export async function moveNoReplace(src: string, dst: string): Promise<void> {
  try {
    await link(src, dst);
  } catch (error) {
    const code = errno(error);
    if (code === "EEXIST") throw new HttpError(412, "precondition_failed", "The destination exists");
    if (code === "EPERM" || code === "ENOSYS" || code === "EOPNOTSUPP" || code === "EMLINK") {
      if (await lstat(dst).then(() => true, () => false)) throw new HttpError(412, "precondition_failed", "The destination exists");
      await rename(src, dst);
      return;
    }
    throw error;
  }
  // Only remove the name we linked: if the source was swapped meanwhile, leave the newcomer alone.
  const [a, b] = await Promise.all([lstat(src).catch(() => null), lstat(dst).catch(() => null)]);
  if (a && b && a.dev === b.dev && a.ino === b.ino) await unlink(src).catch((error) => { if (errno(error) !== "ENOENT") throw error; });
}

async function rename0(temp: string, target: string): Promise<void> {
  try { await rename(temp, target); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

async function listSome(fd: number, max: number): Promise<string[]> {
  const dir = await opendir(fdPath(fd));
  const names: string[] = [];
  try { for await (const entry of dir) { names.push(entry.name); if (names.length >= max) break; } } finally { await dir.close().catch(() => {}); }
  return names;
}

/** Delete everything inside `dir` (a pinned directory handle). A link met on the way is unlinked, never followed. */
export async function rmChildren(dir: FileHandle, dev: number, depth: number, budget: TreeBudget): Promise<void> {
  budget.depth(depth);
  for (;;) {
    const names = await listSome(dir.fd, 1024);
    if (names.length === 0) return;
    for (const name of names) {
      await budget.tick(dir.fd, name);
      const path = fdPath(dir.fd, name);
      let child: FileHandle | null = null;
      try {
        child = await open(path, DIR_FLAGS);
      } catch (error) {
        const code = errno(error);
        if (code === "ENOENT") continue;
        if (code !== "ENOTDIR" && code !== "ELOOP") throw error;
      }
      if (!child) { await unlink(path).catch((error) => { if (errno(error) !== "ENOENT") throw error; }); continue; }
      try {
        const info = await child.stat();
        if (!info.isDirectory()) throw new HttpError(403, "forbidden", "Forbidden");
        if (info.dev !== dev) throw new HttpError(403, "forbidden", "Folder crosses into another filesystem");
        await rmChildren(child, dev, depth + 1, budget);
      } finally { await child.close().catch(() => {}); }
      await rmdir(path);
    }
  }
}

/** Remove the directory at `path` (inside a pinned parent) and everything below it. */
export async function removeTree(path: string, parentDev: number, budget: TreeBudget): Promise<void> {
  const dir = await open(path, DIR_FLAGS);
  try {
    const info = await dir.stat();
    if (!info.isDirectory()) throw new HttpError(403, "forbidden", "Forbidden");
    if (info.dev !== parentDev) throw new HttpError(403, "forbidden", "Folder crosses into another filesystem");
    await rmChildren(dir, info.dev, 0, budget);
  } finally { await dir.close().catch(() => {}); }
  await rmdir(path);
}

interface Cycle { dev: number; ino: number }

async function copyChildren(src: FileHandle, dst: FileHandle, srcDev: number, dstDev: number, depth: number, budget: TreeBudget, uid: number | undefined, cycle: Cycle): Promise<void> {
  budget.depth(depth);
  const listing = await opendir(fdPath(src.fd));
  try {
    for await (const entry of listing) {
      const name = entry.name;
      if (/^\.dav-.*\.part$/.test(name)) continue; // another upload's temp file
      await budget.tick(src.fd, name);
      let input: FileHandle;
      try { input = await open(fdPath(src.fd, name), ANY_FLAGS); } catch (error) {
        if (SKIPPABLE.has(errno(error) ?? "")) continue; // links, sockets and FIFOs are never copied
        throw error;
      }
      try {
        const info = await input.stat();
        if (info.isDirectory()) {
          if (info.dev !== srcDev) continue; // one filesystem only
          if (info.dev === cycle.dev && info.ino === cycle.ino) continue; // the copy itself, reached through the source
          const path = fdPath(dst.fd, name);
          await mkdir(path, { mode: (info.mode & 0o777) | 0o700 });
          const out = await open(path, DIR_FLAGS);
          try {
            const outInfo = await out.stat();
            if (!outInfo.isDirectory() || outInfo.dev !== dstDev) throw new HttpError(403, "forbidden", "Forbidden");
            if (uid !== undefined) await out.chown(uid, uid);
            await copyChildren(input, out, srcDev, dstDev, depth + 1, budget, uid, cycle);
          } finally { await out.close().catch(() => {}); }
        } else if (info.isFile()) {
          if (budget.sourceUid !== undefined && info.uid !== budget.sourceUid) continue; // not the sandbox user's file: never handed to the agent
          if (info.size > budget.remaining()) throw budget.byteError();
          budget.claim(info.size);
          budget.bytes += await writeNewFile(fdPath(dst.fd, name), info.mode & 0o777, uid, input.createReadStream({ autoClose: false }), Math.min(budget.remaining(), info.size), () => budget.byteError());
        }
      } finally { await input.close().catch(() => {}); }
    }
  } finally { await listing.close().catch(() => {}); }
}

/**
 * Copy the directory at `srcPath` to a new directory `dstPath` (both inside pinned parents). On any failure the partial
 * copy is removed through the descriptor of the directory this call created, so a swap in the destination cannot redirect the rollback.
 */
export async function copyDirectory(srcPath: string, dstPath: string, uid: number | undefined, shallow: boolean, budget: TreeBudget): Promise<void> {
  const input = await open(srcPath, DIR_FLAGS);
  try {
    const info = await input.stat();
    if (!info.isDirectory()) throw new HttpError(403, "forbidden", "Forbidden");
    await mkdir(dstPath, { mode: (info.mode & 0o777) | 0o700 });
    let out: FileHandle;
    try { out = await open(dstPath, DIR_FLAGS); } catch (error) { await rmdir(dstPath).catch(() => {}); throw error; }
    try {
      const outInfo = await out.stat();
      try {
        if (!outInfo.isDirectory()) throw new HttpError(403, "forbidden", "Forbidden");
        if (uid !== undefined) await out.chown(uid, uid);
        if (!shallow) await copyChildren(input, out, info.dev, outInfo.dev, 0, budget, uid, { dev: outInfo.dev, ino: outInfo.ino });
      } catch (error) {
        // Rollback: never aborted by revocation (no guard), always by descriptor, bounded by rollbackMaxEntries.
        await rmChildren(out, outInfo.dev, 0, new TreeBudget({ maxEntries: budget.rollbackMaxEntries })).catch(() => {});
        const now = await lstat(dstPath).catch(() => null);
        if (now && now.dev === outInfo.dev && now.ino === outInfo.ino) await rmdir(dstPath).catch(() => {});
        throw error;
      }
    } finally { await out.close().catch(() => {}); }
  } finally { await input.close().catch(() => {}); }
}
