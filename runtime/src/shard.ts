import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, type Stats, existsSync, fchmodSync, fchownSync, fstatSync, lchownSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { opendir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { unavailable } from "./errors.js";
import { log } from "./logger.js";
import { spawnPty, type PtyProcess } from "./pty.js";
import { NetnsManager, netnsMode, parseAllowList, wrapLaunch } from "./netns.js";
import { ownHomeAliasArgs } from "./sandboxPaths.js";

const run = promisify(execFile);
/** A broken FUSE mount must fail fast with a JSON error instead of hanging the request. */
const MOUNT_TIMEOUT_MS = 20_000;

/** Entries of a user's persistent /tmp older than this are deleted at wake. */
export const TMP_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Home-relative location of the persistent /tmp. */
const TMP_REL = ".floq/tmp";
const PRUNE_MAX_DEPTH = 6;
const PRUNE_MAX_ENTRIES = 10_000;
const PRUNE_MAX_CHILDREN = 5_000;

/** Newest mtime anywhere under `path` (not following symlinks); null when the bounded walk (depth / entry count) was exceeded. */
function newestMtime(path: string, budget: { left: number }, depth = 0): number | null {
  const stat = lstatSync(path);
  let newest = stat.mtimeMs;
  if (!stat.isDirectory()) return newest;
  if (depth >= PRUNE_MAX_DEPTH) return null;
  for (const name of readdirSync(path)) {
    if (--budget.left < 0) return null;
    const child = newestMtime(join(path, name), budget, depth + 1);
    if (child === null) return null;
    if (child > newest) newest = child;
  }
  return newest;
}

/**
 * Delete direct children of `dir` whose newest mtime anywhere inside is older than maxAgeMs. A bounded walk (depth 6, 10k
 * entries) that hits its limit keeps the entry. Symlinks are unlinked, never followed.
 */
export function pruneOldEntries(dir: string, maxAgeMs: number, now = Date.now()): number {
  let removed = 0;
  for (const name of readdirSync(dir).slice(0, PRUNE_MAX_CHILDREN)) {
    const path = join(dir, name);
    try {
      const newest = newestMtime(path, { left: PRUNE_MAX_ENTRIES });
      if (newest !== null && now - newest > maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* raced with a running process; keep it */
    }
  }
  return removed;
}

/** Async twin of pruneOldEntries for the wake path: streams the directory, caps the children scanned and yields between entries. */
export async function pruneOldEntriesAsync(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let scanned = 0;
  const handle = await opendir(dir);
  try {
    for await (const dirent of handle) {
      if (++scanned > PRUNE_MAX_CHILDREN) break;
      const path = join(dir, dirent.name);
      try {
        const newest = newestMtime(path, { left: PRUNE_MAX_ENTRIES });
        if (newest !== null && now - newest > maxAgeMs) {
          await rm(path, { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* raced with a running process; keep it */
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return removed;
}

/**
 * pruneOldEntriesAsync for a directory inside a user home: the directory is opened by descriptor (no symlinked ancestor), its
 * entries are listed and aged through that descriptor, and each stale entry is removed with removeHomeTree, which pins every
 * directory it descends into. A swapped link can only make root unlink the link itself.
 */
export async function pruneHomeEntriesAsync(home: string, dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  const held = openHomeDir(home, dir);
  if (!held) return 0;
  let removed = 0;
  try {
    const names = readdirSync(held.path).slice(0, PRUNE_MAX_CHILDREN);
    for (const name of names) {
      try {
        const newest = newestMtime(join(held.path, name), { left: PRUNE_MAX_ENTRIES });
        if (newest !== null && now - newest > maxAgeMs && removeHomeTree(home, join(dir, name))) removed++;
      } catch { /* raced with a running process; keep it */ }
      await new Promise<void>((done) => setImmediate(done));
    }
  } finally { held.close(); }
  return removed;
}

/** Path of a user's home as seen from inside the sandbox. */
export const SANDBOX_HOME = "/home/agent";

export interface ShardIdentity {
  userId: string;
  /** Numeric uid/gid allocated to this user; no /etc/passwd entry on the host. */
  uid: number;
}

export interface ShardHandle extends ShardIdentity {
  /** Host path where the user's decrypted home is mounted. */
  mountPath: string;
  /** Path of this user's network namespace (FLOQ_NETNS only); undefined = sandboxes share the host network. */
  netns?: string;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  env: Record<string, string>;
  /** Relative to the user's home. */
  cwd: string;
  cols: number;
  rows: number;
  /** spawnPipe only: give the child a stdin pipe (default: stdin is closed). For runtime-driven daemons such as floq-browserd. */
  stdin?: boolean;
  /** spawnPipe only: a 4th stdio pipe (the child's fd 3), for a binary side channel. bwrap passes it through (user-IP egress relay). */
  extraPipe?: boolean;
}

export interface ShardDriver {
  readonly name: "linux" | "local";
  /** One-time startup work (netns probe). Throws only when the operator required something that is unavailable. */
  init?(): Promise<void>;
  /** Provision (first use) and unlock the user's encrypted home. */
  wake(identity: ShardIdentity, dataKey: Buffer): Promise<ShardHandle>;
  spawn(handle: ShardHandle, spec: SpawnSpec): PtyProcess;
  /** Same sandbox and network namespace as spawn(), but plain pipes (exact bytes, no PTY): for runtime-driven git on agent-controlled repos. */
  spawnPipe(handle: ShardHandle, spec: Omit<SpawnSpec, "cols" | "rows">): ChildProcess;
  /** Lock the home again. Callers guarantee no sandboxed process still uses it. */
  sleep(handle: ShardHandle): Promise<void>;
  /** Host path of a relative path inside the user's home. */
  hostPath(handle: ShardHandle, relative: string): string;
  /** The user home path as the agent process sees it. */
  homePath(handle: ShardHandle): string;
  /** Root-owned folder bound read-only at /etc/claude-code in this user's sandbox (per-user Claude managed settings); null without a sandbox. */
  claudeManagedDir?(handle: ShardHandle): string | null;
}

export function safeRelative(input: string): string {
  const parts = input.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..") || input.startsWith("/") || parts.some((p) => /[\0\\]/.test(p))) {
    throw new Error("path escapes the home directory");
  }
  return parts.join("/");
}

/**
 * gocryptfs (root, allow_other) performs every operation as the calling uid, so anything root creates inside a
 * mounted home is root-owned and unwritable for the user. These helpers hand such paths to the user's uid.
 */
export function ownTree(path: string, uid: number, maxDepth = Infinity): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.uid !== uid || stat.gid !== uid) lchownSync(path, uid, uid);
  if (stat.isDirectory() && maxDepth > 0) for (const entry of readdirSync(path)) ownTree(join(path, entry), uid, maxDepth - 1);
}

/** An ENOENT-shaped error for a pinned parent that does not exist (callers treat it like the fs error they used to get). */
function missingParent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: parent directory does not exist"), { code: "ENOENT" });
}

/**
 * mkdir `name` inside the pinned directory `parent` and return it opened (O_NOFOLLOW|O_DIRECTORY) and handed to `uid`: the
 * mkdir, the open and the fchown all go through the parent's descriptor, so a swapped ancestor cannot redirect root.
 */
function makeOwnedChild(parent: HomeDir, name: string, uid: number | null, mode: number): HomeDir {
  if (!name || name === "." || name === ".." || /[\0/\\]/.test(name)) throw new UnsafeHomePathError("bad path segment");
  const target = join(parent.path, name);
  mkdirSync(target, { mode });
  let fd: number | null = null;
  try {
    fd = openSync(target, DIR_FLAGS);
    if (uid !== null) fchownSync(fd, uid, uid);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmdirSync(target); } catch { /* best effort */ }
    throw error;
  }
  const held = fd;
  return { path: existsSync(PROC_FD) ? `${PROC_FD}/${held}` : target, fd: held, close: () => { try { closeSync(held); } catch { /* already closed */ } } };
}

/**
 * Create one directory under `home` owned by `uid`. The parent is opened by descriptor without following links (UnsafeHomePathError
 * on a symlinked ancestor), and the directory is created, opened and chowned relative to it. Throws ENOENT when the parent is missing.
 */
export function mkdirOwnedSegment(home: string, path: string, uid: number | null, mode = 0o777): void {
  const parent = openHomeDir(home, dirname(path));
  if (!parent) throw missingParent();
  try { makeOwnedChild(parent, basename(path), uid, mode).close(); } finally { parent.close(); }
}

/**
 * mkdir -p inside a mounted home, creating every missing segment owned by the user. Every directory is held open by descriptor
 * (never through a symlink) while the next segment is opened or created, so there is no check-then-use window. A symlink or a
 * non-directory in the way raises UnsafeHomePathError.
 */
export function mkdirOwned(root: string, dir: string, uid: number | null, mode = 0o777): void {
  const rel = relative(root, dir);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")) throw new UnsafeHomePathError("path escapes the home directory");
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length === 0) return; // the home itself: nothing to create (a missing mount is the mounter's concern, as before)
  let current = openHomeDir(root, root);
  if (!current) throw missingParent();
  try {
    for (const part of parts) {
      let next: HomeDir | null;
      try { next = openChildDir(current, part); } catch (error) {
        if (error instanceof UnsafeHomePathError) throw new UnsafeHomePathError("path crosses a symlink in the home directory");
        throw error;
      }
      if (!next) {
        try { next = makeOwnedChild(current, part, uid, mode); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Either a racing creator made it (fine) or something that is not a directory sits there (refused).
          try { next = openChildDir(current, part); } catch { next = null; }
          if (!next) throw new UnsafeHomePathError("path crosses a non-directory in the home directory");
        }
      }
      current.close();
      current = next;
    }
  } finally { current.close(); }
}

/** chmod a directory inside a home through a descriptor opened without following links (a path chmod would follow a swapped link). */
export function chmodHomeDir(home: string, dir: string, mode: number): void {
  const held = openHomeDir(home, dir);
  if (!held) throw missingParent();
  try { fchmodSync(held.fd, mode); } finally { held.close(); }
}

/** lstat a path inside a home with every ancestor pinned; null when it (or an ancestor) does not exist. */
export function lstatHome(home: string, path: string): Stats | null {
  const rel = relative(home, path);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")) throw new UnsafeHomePathError("path escapes the home directory");
  const parent = openHomeDir(home, dirname(path));
  if (!parent) return null;
  try { return lstatSync(join(parent.path, basename(path))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { parent.close(); }
}

/** Delete regular files older than maxAgeMs directly inside a home directory, relative to a pinned descriptor. Returns how many went. */
export function pruneHomeFiles(home: string, dir: string, maxAgeMs: number, now = Date.now()): number {
  const held = openHomeDir(home, dir);
  if (!held) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(held.path)) {
      try {
        const entry = join(held.path, name);
        const info = lstatSync(entry);
        if (info.isFile() && now - info.mtimeMs > maxAgeMs) { unlinkSync(entry); removed++; }
      } catch { /* best effort */ }
    }
  } finally { held.close(); }
  return removed;
}

/**
 * Write a file as root without ever following a planted symlink. With `home`, the destination directory is opened by descriptor
 * (no component may be a link) and everything happens relative to it; `home: null` is only for a `path` that already runs
 * through a pinned descriptor (/proc/self/fd/N/...). A fresh O_EXCL|O_NOFOLLOW temp file (mode set with fchmod on the descriptor,
 * owner with fchown) is renamed over the destination, which replaces a symlink or FIFO there instead of opening it.
 */
export function writeFileOwned(home: string | null, path: string, data: string | Buffer, uid: number | null, mode = 0o600): void {
  const parent = home === null ? null : openHomeDir(home, dirname(path));
  if (home !== null && !parent) throw missingParent();
  const dir = parent ? parent.path : dirname(path);
  const destination = join(dir, basename(path));
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
    try {
      try {
        writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
        fchmodSync(fd, mode);
        if (uid !== null) { try { fchownSync(fd, uid, uid); } catch (error) { if (process.getuid?.() === 0) throw error; /* unprivileged (tests): the file stays ours */ } }
      } finally {
        closeSync(fd);
      }
      renameSync(temp, destination);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  } finally { parent?.close(); }
}

/**
 * Copy a trusted (root-owned) tree into a directory the agent can write, never overwriting and never following anything the agent
 * planted: the destination and every subdirectory are held open by descriptor (opened O_NOFOLLOW, or created and handed to `uid`),
 * files are created O_EXCL|O_NOFOLLOW inside them and chowned on the descriptor, and an existing entry of any kind is left alone
 * (a planted link or FIFO is skipped, not written through). Symlinks in the source are recreated as links, never followed.
 * `filter` sees the source path of each entry and returns false to skip it.
 */
export function copySeedTree(home: string, source: string, destination: string, uid: number | null, filter: (src: string) => boolean = () => true): void {
  const root = openHomeDir(home, destination);
  if (!root) throw new UnsafeHomePathError("seed destination does not exist");
  const walk = (src: string, dir: HomeDir): void => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      if (!filter(from)) continue;
      const target = join(dir.path, entry.name);
      let existing: Stats | null = null;
      try { existing = lstatSync(target); } catch { /* not there yet */ }
      if (entry.isDirectory()) {
        let child: HomeDir | null = null;
        if (existing) {
          if (existing.isSymbolicLink() || !existing.isDirectory()) continue;
          try { child = openChildDir(dir, entry.name); } catch (error) { if (error instanceof UnsafeHomePathError) continue; throw error; }
        } else {
          try { child = makeOwnedChild(dir, entry.name, uid, 0o755); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
        }
        if (!child) continue;
        try { walk(from, child); } finally { child.close(); }
      } else if (entry.isSymbolicLink()) {
        if (existing) continue;
        symlinkSync(readlinkSync(from), target);
        if (uid !== null) { try { lchownSync(target, uid, uid); } catch (error) { if (process.getuid?.() === 0) throw error; } }
      } else if (entry.isFile()) {
        if (existing) continue;
        const mode = statSync(from).mode & 0o777;
        let fd: number;
        try { fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
        try {
          writeSync(fd, readFileSync(from));
          fchmodSync(fd, mode);
          if (uid !== null) { try { fchownSync(fd, uid, uid); } catch (error) { if (process.getuid?.() === 0) throw error; } }
        } finally { closeSync(fd); }
      }
    }
  };
  try { walk(source, root); } finally { root.close(); }
}

/** Thrown by readHomeFile when an agent-planted path is unsafe to read (symlink, FIFO/device, foreign owner, oversize). */
export class UnsafeHomePathError extends Error {}

/**
 * Read a file the agent can write (anything under its home) as root without being steered: every directory segment is
 * opened with O_NOFOLLOW|O_DIRECTORY (chained through /proc/self/fd so a swapped parent cannot redirect), the leaf with
 * O_NOFOLLOW|O_NONBLOCK (a FIFO then opens instantly instead of blocking), and the descriptor itself must be a regular file
 * owned by `uid` (never root or another tenant) no bigger than maxBytes. Returns null when the path does not exist; throws
 * UnsafeHomePathError for a poisoned one. Callers treat both as "nothing there" and must never adopt the content.
 */
export function readHomeFile(home: string, path: string, uid: number | null, maxBytes = 1_048_576): { text: string; mtimeMs: number } | null {
  const rel = relative(home, path);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")) throw new UnsafeHomePathError("path escapes the home directory");
  const parts = rel.split(sep).filter(Boolean);
  const opened: number[] = [];
  const unsafe = (code: string | undefined) => code === "ELOOP" || code === "EMLINK";
  try {
    let base = home;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const target = join(base, parts[i]);
      const flags = last
        ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;
      let fd: number;
      try {
        fd = openSync(target, flags);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        if (unsafe(code)) throw new UnsafeHomePathError("symlink in home path");
        if (code === "ENOTDIR") {
          // O_DIRECTORY|O_NOFOLLOW reports a symlink-to-dir as ELOOP; ENOTDIR means a plain file or other node in the way.
          try { if (lstatSync(target).isSymbolicLink()) throw new UnsafeHomePathError("symlink in home path"); } catch (inner) { if (inner instanceof UnsafeHomePathError) throw inner; }
          return null;
        }
        throw error;
      }
      opened.push(fd);
      if (last) {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new UnsafeHomePathError("not a regular file");
        if (uid !== null && st.uid !== uid) throw new UnsafeHomePathError("file is not owned by the user");
        if (st.size > maxBytes) throw new UnsafeHomePathError("file too large");
        const buffer = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
        let total = 0;
        for (;;) {
          const n = readSync(fd, buffer, total, buffer.length - total, null);
          if (n === 0) break;
          total += n;
          if (total >= buffer.length) throw new UnsafeHomePathError("file too large");
        }
        return { text: buffer.subarray(0, total).toString("utf8"), mtimeMs: st.mtimeMs };
      }
      base = existsSync("/proc/self/fd") ? `/proc/self/fd/${fd}` : target;
    }
    return null;
  } finally {
    for (const fd of opened) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY;
const PROC_FD = "/proc/self/fd";

/** Open one path segment without following a symlink: null when missing, UnsafeHomePathError for a link. */
function openSegment(target: string, flags: number): number | null {
  try {
    return openSync(target, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new UnsafeHomePathError("symlink in home path");
    if (code === "ENOTDIR") {
      try { if (lstatSync(target).isSymbolicLink()) throw new UnsafeHomePathError("symlink in home path"); } catch (inner) { if (inner instanceof UnsafeHomePathError) throw inner; }
      return null;
    }
    throw error;
  }
}

/** A directory inside a user home held open by descriptor: operate on `path` (/proc/self/fd/N) while it is open, then close(). */
export interface HomeDir { path: string; fd: number; close(): void }

/**
 * Open `dir` (inside `home`) so that no component can be a symlink: every segment is opened O_NOFOLLOW|O_DIRECTORY and chained
 * through /proc/self/fd, and the returned `path` addresses the final directory by descriptor, so a parent swapped afterwards
 * cannot redirect root. Null when the directory does not exist; UnsafeHomePathError when a symlink or an escape is met.
 * This is the one confined-open primitive for every root operation on agent-writable home paths.
 */
export function openHomeDir(home: string, dir: string): HomeDir | null {
  const rel = relative(home, dir);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")) throw new UnsafeHomePathError("path escapes the home directory");
  const parts = rel.split(sep).filter(Boolean);
  const proc = existsSync(PROC_FD);
  let fd = openSegment(home, DIR_FLAGS);
  if (fd === null) return null;
  let base = proc ? `${PROC_FD}/${fd}` : home;
  try {
    for (const part of parts) {
      const next = openSegment(join(base, part), DIR_FLAGS);
      if (next === null) { closeSync(fd); return null; }
      closeSync(fd);
      fd = next;
      base = proc ? `${PROC_FD}/${fd}` : join(base, part);
    }
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    throw error;
  }
  const held = fd;
  return { path: base, fd: held, close: () => { try { closeSync(held); } catch { /* already closed */ } } };
}

/** Open a child directory of an open HomeDir (never through a symlink); null when missing. */
export function openChildDir(parent: HomeDir, name: string): HomeDir | null {
  if (!name || name === "." || name === ".." || /[\0/\\]/.test(name)) throw new UnsafeHomePathError("bad path segment");
  const fd = openSegment(join(parent.path, name), DIR_FLAGS);
  if (fd === null) return null;
  const proc = existsSync(PROC_FD);
  return { path: proc ? `${PROC_FD}/${fd}` : join(parent.path, name), fd, close: () => { try { closeSync(fd); } catch { /* already closed */ } } };
}

/**
 * ownTree for agent-writable home paths: every directory is opened by descriptor (never through a symlink) and each entry
 * is lchown'd relative to it, so a directory swapped for a link mid-walk cannot make root chown another tenant's files.
 */
export function ownHomeTree(home: string, path: string, uid: number, maxDepth = Infinity): void {
  const rel = relative(home, path);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")) throw new UnsafeHomePathError("path escapes the home directory");
  const parent = openHomeDir(home, dirname(path));
  if (!parent) return;
  const walk = (dir: HomeDir, name: string, depth: number): void => {
    const target = join(dir.path, name);
    let stat;
    try { stat = lstatSync(target); } catch { return; }
    if (stat.uid !== uid || stat.gid !== uid) lchownSync(target, uid, uid);
    if (!stat.isDirectory() || depth <= 0) return;
    let child: HomeDir | null;
    try { child = openChildDir(dir, name); } catch (error) { if (error instanceof UnsafeHomePathError) return; throw error; }
    if (!child) return;
    try { for (const entry of readdirSync(child.path)) walk(child, entry, depth - 1); } finally { child.close(); }
  };
  try { walk(parent, basename(path), maxDepth); } finally { parent.close(); }
}

/**
 * Remove a tree inside a user home without following a planted link: each directory is pinned by descriptor while its
 * entries are unlinked relative to it (a racing symlink swap can only make root unlink the link itself). A link at the
 * target is unlinked, never followed. Returns false when nothing was there.
 */
export function removeHomeTree(home: string, path: string): boolean {
  const rel = relative(home, path);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")) throw new UnsafeHomePathError("path escapes the home directory");
  const parent = openHomeDir(home, dirname(path));
  if (!parent) return false;
  const purge = (dir: HomeDir): void => {
    for (const name of readdirSync(dir.path)) {
      const entry = join(dir.path, name);
      let stat;
      try { stat = lstatSync(entry); } catch { continue; }
      if (stat.isDirectory()) {
        let child: HomeDir | null = null;
        try { child = openChildDir(dir, name); } catch (error) { if (!(error instanceof UnsafeHomePathError)) throw error; }
        if (child) {
          try { purge(child); } finally { child.close(); }
          rmdirSync(entry);
          continue;
        }
      }
      unlinkSync(entry);
    }
  };
  try {
    const name = basename(path);
    const target = join(parent.path, name);
    let stat;
    try { stat = lstatSync(target); } catch { return false; }
    if (stat.isDirectory()) {
      let child: HomeDir | null = null;
      try { child = openChildDir(parent, name); } catch (error) { if (!(error instanceof UnsafeHomePathError)) throw error; }
      if (child) {
        try { purge(child); } finally { child.close(); }
        rmdirSync(target);
        return true;
      }
    }
    unlinkSync(target);
    return true;
  } finally { parent.close(); }
}

export interface CopyHomeTreeOptions { skipNames?: readonly string[]; maxEntries?: number; maxBytes?: number }

/**
 * Copy a directory tree out of a user home into a root-owned destination, confined: the source is opened via openHomeDir,
 * every subdirectory by descriptor, every file O_NOFOLLOW|O_NONBLOCK and verified a regular file on the descriptor. Symlinks,
 * FIFOs, devices and sockets are skipped, never copied or followed, so nothing outside the home can reach the destination.
 */
export function copyHomeTree(home: string, source: string, destination: string, options: CopyHomeTreeOptions = {}): void {
  const skip = new Set(options.skipNames ?? []);
  const maxEntries = options.maxEntries ?? 50_000;
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const root = openHomeDir(home, source);
  if (!root) throw new UnsafeHomePathError("source directory does not exist");
  let entries = 0;
  let bytes = 0;
  const copyDir = (dir: HomeDir, target: string): void => {
    mkdirSync(target, { mode: 0o755 });
    for (const name of readdirSync(dir.path)) {
      if (skip.has(name)) continue;
      if (++entries > maxEntries) throw new UnsafeHomePathError("too many entries to copy");
      const from = join(dir.path, name);
      const to = join(target, name);
      let stat;
      try { stat = lstatSync(from); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        let child: HomeDir | null = null;
        try { child = openChildDir(dir, name); } catch (error) { if (error instanceof UnsafeHomePathError) continue; throw error; }
        if (!child) continue;
        try { copyDir(child, to); } finally { child.close(); }
      } else if (stat.isFile()) {
        let fd: number | null = null;
        try { fd = openSegment(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY); } catch (error) { if (error instanceof UnsafeHomePathError) continue; throw error; }
        if (fd === null) continue;
        try {
          const info = fstatSync(fd);
          if (!info.isFile()) continue;
          bytes += info.size;
          if (bytes > maxBytes) throw new UnsafeHomePathError("tree too large to copy");
          const out = openSync(to, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, (info.mode & 0o111) ? 0o755 : 0o644);
          try {
            const buffer = Buffer.allocUnsafe(64 * 1024);
            for (;;) {
              const n = readSync(fd, buffer, 0, buffer.length, null);
              if (n === 0) break;
              writeSync(out, buffer, 0, n);
            }
          } finally { closeSync(out); }
        } finally { closeSync(fd); }
      }
    }
  };
  try { copyDir(root, destination); } finally { root.close(); }
}

function isMounted(path: string): boolean {
  try {
    return readFileSync("/proc/self/mounts", "utf8")
      .split("\n")
      .some((line) => line.split(" ")[1] === path);
  } catch {
    return false;
  }
}

/** A FUSE mount whose daemon died keeps its /proc/mounts entry but every access fails with ENOTCONN. */
function isAlive(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === "ENOTCONN" || code === "ECONNABORTED" || code === "EIO");
  }
}

async function lazyUnmount(path: string): Promise<void> {
  try {
    await run("fusermount3", ["-u", "-z", path], { timeout: 10_000 });
  } catch {
    await run("fusermount", ["-u", "-z", path], { timeout: 10_000 }).catch(() => undefined);
  }
}

/**
 * Run gocryptfs without ever giving it a pipe to Node: in daemon mode the forked filesystem process
 * inherits the parent's stdio, and a pipe closed by Node would kill it (EPIPE) right after mounting.
 * Its stderr goes to a private log file instead; we wait for the launcher process to exit.
 */
async function runGocryptfs(args: string[], logFile: string): Promise<void> {
  try {
    if (statSync(logFile).size > 1_000_000) rmSync(logFile, { force: true });
  } catch {
    /* no log yet */
  }
  const fd = openSync(logFile, "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("gocryptfs", args, { stdio: ["ignore", "ignore", fd] });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("gocryptfs timed out"));
      }, MOUNT_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("gocryptfs exited with " + (code ?? signal)));
      });
    });
  } finally {
    closeSync(fd);
  }
}

/** Production driver: gocryptfs-encrypted home per user, bubblewrap sandbox, privileges dropped to a per-user uid. */
export class LinuxShardDriver implements ShardDriver {
  readonly name = "linux" as const;
  private readonly cipherRoot: string;
  private readonly mountRoot: string;
  private readonly metaRoot: string;

  constructor(config: Config, private readonly netns: NetnsManager | null = null) {
    this.cipherRoot = join(config.shardRoot, "cipher");
    // Ciphertext and metadata live on the shards volume; only the plaintext mountpoints live under /mnt.
    // Ubuntu >= 25.04 hosts confine /usr/bin/fusermount3 with an AppArmor profile that only allows FUSE
    // mountpoints under $HOME, /mnt, /media, /tmp and /run/user, so a mountpoint on the volume is denied.
    this.mountRoot = config.mountRoot;
    this.metaRoot = join(config.shardRoot, "meta");
    for (const dir of [this.cipherRoot, this.metaRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.mountRoot, { recursive: true, mode: 0o711 });
    this.cleanDeadMounts();
  }

  async init(): Promise<void> {
    if (this.netns) await this.netns.init();
  }

  /** Lazily unmount leftovers whose gocryptfs daemon is gone (e.g. after a crash). */
  private cleanDeadMounts(): void {
    let lines: string[] = [];
    try {
      lines = readFileSync("/proc/self/mounts", "utf8").split("\n");
    } catch {
      return;
    }
    for (const line of lines) {
      const mountPoint = line.split(" ")[1];
      if (mountPoint?.startsWith(this.mountRoot + "/") && !isAlive(mountPoint)) {
        void lazyUnmount(mountPoint).then(() => log.warn("shard.dead_mount_cleaned", { mountPoint }));
      }
    }
  }

  async wake(identity: ShardIdentity, dataKey: Buffer): Promise<ShardHandle> {
    const { userId, uid } = identity;
    const cipher = join(this.cipherRoot, String(uid));
    const mountPath = join(this.mountRoot, String(uid));
    mkdirSync(cipher, { recursive: true, mode: 0o700 });
    mkdirSync(mountPath, { recursive: true, mode: 0o700 });

    // Minimal passwd/group so git, ssh and node resolve the uid inside the sandbox.
    const passwd = join(this.metaRoot, uid + ".passwd");
    writeFileSync(
      passwd,
      "root:x:0:0:root:/root:/usr/sbin/nologin\nagent:x:" + uid + ":" + uid + "::" + SANDBOX_HOME + ":/bin/bash\n",
      { mode: 0o644 },
    );
    writeFileSync(join(this.metaRoot, uid + ".group"), "root:x:0:\nagent:x:" + uid + ":\n", { mode: 0o644 });

    // The ciphertext must belong to the user's uid: gocryptfs acts as the caller, and a root-owned ciphertext
    // tree makes every write by the user fail with EACCES. Migrates trees created before this was enforced.
    const confPath = join(cipher, "gocryptfs.conf");
    if (existsSync(confPath) && (statSync(cipher).uid !== uid || statSync(confPath).uid !== uid)) {
      ownTree(cipher, uid);
      log.info("shard.ownership_fixed", { userId, uid });
    }

    let mounted = isMounted(mountPath);
    if (mounted && !isAlive(mountPath)) {
      log.warn("shard.dead_mount", { userId, uid });
      await lazyUnmount(mountPath);
      mounted = false;
    }
    const gocryptfsLog = join(this.metaRoot, uid + ".gocryptfs.log");
    if (!mounted) {
      const passfile = join("/dev/shm", "floq-" + randomBytes(8).toString("hex"));
      writeFileSync(passfile, dataKey.toString("hex"), { mode: 0o600 });
      try {
        if (!existsSync(join(cipher, "gocryptfs.conf"))) {
          await runGocryptfs(["-init", "-q", "-passfile", passfile, "-scryptn", "12", cipher], gocryptfsLog);
          ownTree(cipher, uid);
          log.info("shard.provisioned", { userId, uid });
        }
        await runGocryptfs([
          "-q",
          "-passfile",
          passfile,
          "-allow_other",
          "-nosyslog",
          cipher,
          mountPath,
        ], gocryptfsLog);
        if (!isAlive(mountPath)) throw new Error("mount is not responding");
      } catch (error) {
        const detail = error instanceof Error ? error.message.split("\n").slice(0, 3).join(" | ") : String(error);
        log.error("shard.mount_failed", { userId, uid, error: detail });
        throw unavailable("Your encrypted workspace could not be mounted right now. Try again shortly.");
      } finally {
        rmSync(passfile, { force: true });
      }
      log.info("shard.wake", { userId, uid });
    }
    const handle: ShardHandle = { userId, uid, mountPath };
    this.prepareTmp(handle);
    // Only with FLOQ_NETNS (and a successful startup probe): the user's persistent network namespace.
    if (this.netns?.isEnabled) {
      try {
        handle.netns = await this.netns.ensure(uid);
      } catch (error) {
        log.error("shard.netns_failed", { userId, uid, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        throw unavailable("Your sandbox network could not be set up right now. Try again shortly.");
      }
    }
    return handle;
  }

  /**
   * Host directory bound at /tmp in this user's sandbox: <home>/.floq/tmp, inside the encrypted home, so scratch data is only
   * readable while the home is unlocked. Only this user's directory is ever bound, so no one sees another user's /tmp.
   */
  tmpPath(handle: ShardHandle): string {
    return join(handle.mountPath, TMP_REL);
  }

  /**
   * Create the user's /tmp (sticky 1777, owned by their uid) and prune entries unused for TMP_MAX_AGE_MS. Called when the home
   * is (re)mounted; a shard is only locked with no live session, so no session of this user is running during the prune.
   */
  private prepareTmp(handle: ShardHandle): Promise<number | void> {
    const dir = this.tmpPath(handle);
    try {
      mkdirOwned(handle.mountPath, dir, handle.uid);
      chmodHomeDir(handle.mountPath, dir, 0o1777);
      return pruneHomeEntriesAsync(handle.mountPath, dir, TMP_MAX_AGE_MS).catch((error) => log.warn("shard.tmp_prune_failed", { uid: handle.uid, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
    } catch (error) {
      log.warn("shard.tmp_prepare_failed", { uid: handle.uid, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      return Promise.resolve();
    }
  }

  hostPath(handle: ShardHandle, relative: string): string {
    return join(handle.mountPath, safeRelative(relative));
  }

  homePath(): string {
    return SANDBOX_HOME;
  }

  claudeManagedDir(handle: ShardHandle): string {
    return join(this.metaRoot, handle.uid + ".claude-code");
  }

  spawn(handle: ShardHandle, spec: SpawnSpec): PtyProcess {
    const launch = this.sandboxLaunch(handle, spec);
    return spawnPty(launch.file, launch.args, {
      name: "xterm-256color",
      cols: spec.cols,
      rows: spec.rows,
      cwd: "/",
      env: { ...spec.env, HOME: SANDBOX_HOME, USER: "agent", LOGNAME: "agent" },
    });
  }

  spawnPipe(handle: ShardHandle, spec: Omit<SpawnSpec, "cols" | "rows">): ChildProcess {
    const launch = this.sandboxLaunch(handle, spec);
    return spawn(launch.file, launch.args, {
      cwd: "/",
      stdio: spec.extraPipe ? [spec.stdin ? "pipe" : "ignore", "pipe", "pipe", "pipe"] : [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...spec.env, HOME: SANDBOX_HOME, USER: "agent", LOGNAME: "agent" },
      windowsHide: true,
    });
  }

  private sandboxLaunch(handle: ShardHandle, spec: Omit<SpawnSpec, "cols" | "rows">): { file: string; args: string[] } {
    const { uid } = handle;
    const home = handle.mountPath;
    // Never silently run offline or in the host network: a namespace whose pasta was given up on fails the launch.
    if (handle.netns && this.netns && !this.netns.isHealthy(uid)) {
      throw unavailable("Your sandbox network is unavailable (its network helper failed). Restart your workspace and try again.");
    }
    mkdirOwned(handle.mountPath, this.hostPath(handle, spec.cwd), uid);

    const args = [
      "--die-with-parent",
      // No --new-session: it would drop the PTY's controlling terminal (no job control, Ctrl+C/Z do not reach
      // the foreground job). Its purpose, blocking TIOCSTI injection into the parent terminal, is moot here:
      // the parent terminal is this session's own node-pty slave, and the host kernel has
      // dev.tty.legacy_tiocsti = 0 (TIOCSTI disabled).
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--ro-bind", "/usr", "/usr",
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
    ];
    if (existsSync("/lib64")) args.push("--symlink", "usr/lib64", "/lib64");
    // bwrap creates the parent directories of binds as 0700 root, which the per-user uid cannot read
    // (resolv.conf, ssl config): create them 0755 explicitly, before anything is bound into them.
    args.push("--perms", "0755", "--dir", "/etc", "--perms", "0755", "--dir", "/home");
    for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/ca-certificates", "/etc/alternatives", "/etc/nsswitch.conf", "/etc/gitconfig", "/etc/localtime"]) {
      if (handle.netns && path === "/etc/resolv.conf") args.push("--ro-bind", this.netns!.resolvConfPath(uid), path);
      else if (existsSync(path)) args.push("--ro-bind", path, path);
    }
    // Agent browser: the pinned Chromium + Playwright MCP live in /opt/floq (read-only, world-readable, root-owned), and fontconfig needs /etc/fonts
    // (without it pages render as tofu). Both read-only: no other user's data is exposed.
    if (existsSync("/opt/floq")) args.push("--perms", "0755", "--dir", "/opt", "--ro-bind", "/opt/floq", "/opt/floq");
    if (existsSync("/etc/fonts")) args.push("--ro-bind", "/etc/fonts", "/etc/fonts");
    // apt's sources/keys and the image's dpkg database, read-only: /usr/local/bin/apt (image/floq-apt) runs apt rootless
    // with its lists, cache and unpacked packages in the user's home, resolving against the packages the image has.
    if (existsSync("/etc/apt")) args.push("--ro-bind", "/etc/apt", "/etc/apt");
    if (existsSync("/var/lib/dpkg")) args.push("--perms", "0755", "--dir", "/var", "--perms", "0755", "--dir", "/var/lib", "--ro-bind", "/var/lib/dpkg", "/var/lib/dpkg");
    // Claude Code managed settings: this user's own copy (base policy + their plugins, see claudeManagedPlugins.ts) when
    // the launch wrote one, else the image's.
    const managed = this.claudeManagedDir(handle);
    if (existsSync(join(managed, "managed-settings.json"))) args.push("--ro-bind", managed, "/etc/claude-code");
    else if (existsSync("/etc/claude-code")) args.push("--ro-bind", "/etc/claude-code", "/etc/claude-code");
    args.push(
      "--ro-bind", join(this.metaRoot, uid + ".passwd"), "/etc/passwd",
      "--ro-bind", join(this.metaRoot, uid + ".group"), "/etc/group",
      "--proc", "/proc",
      "--dev", "/dev",
      // Persistent, per-user /tmp inside the encrypted home (scratchpads, task output and venvs survive restarts; wake()
      // prunes entries unused for 7 days). The directory is 1777 and owned by the user's uid, like a real /tmp.
      "--bind", this.tmpPath(handle), "/tmp",
      "--tmpfs", "/run",
      "--bind", home, SANDBOX_HOME,
      // Git linked-worktree metadata stores absolute paths. Bind only this user's shard at that same path;
      // the new sandbox still contains no parent shard roots or other users' homes.
      ...ownHomeAliasArgs(home, this.mountRoot),
      "--chdir", SANDBOX_HOME + "/" + safeRelative(spec.cwd),
      "--",
      "setpriv",
      "--reuid=" + uid,
      "--regid=" + uid,
      "--clear-groups",
      "--inh-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      spec.file,
      ...spec.args,
    );

    // Not /usr/bin/bwrap: Ubuntu >= 24.04 hosts attach the AppArmor profile "bwrap" to that path (even inside
    // containers) and run everything under it as "unpriv_bwrap", which denies CAP_SETUID/SETGID/CHOWN, so
    // setpriv could never drop to the per-user uid. The image ships an identical copy at /usr/local/bin/floq-bwrap.
    // With a per-user netns the launch is wrapped in `nsenter --net=<path> --`; without one this is the identity.
    return wrapLaunch(process.env.FLOQ_BWRAP_BIN?.trim() || "floq-bwrap", args, handle.netns);
  }

  async sleep(handle: ShardHandle): Promise<void> {
    try {
      if (!isMounted(handle.mountPath)) return;
      if (!isAlive(handle.mountPath)) await lazyUnmount(handle.mountPath);
      else {
        try {
          await run("fusermount3", ["-u", handle.mountPath]);
        } catch {
          await run("fusermount", ["-u", handle.mountPath]);
        }
      }
      log.info("shard.sleep", { userId: handle.userId, uid: handle.uid });
    } finally {
      // The namespace lives exactly as long as the awake shard (callers guarantee no sandboxed process is left):
      // removed on every path, including the early return and a failing unmount.
      if (handle.netns && this.netns) await this.netns.remove(handle.uid).catch((error) => log.warn("shard.netns_remove_failed", { uid: handle.uid, error: String(error).slice(0, 160) }));
    }
  }
}

/** Development driver (Windows/macOS or FLOQ_SHARD_DRIVER=local): no isolation or encryption. */
export class LocalShardDriver implements ShardDriver {
  readonly name = "local" as const;

  constructor(private readonly config: Config) {}

  async wake(identity: ShardIdentity): Promise<ShardHandle> {
    const mountPath = join(this.config.shardRoot, "local", identity.userId);
    mkdirSync(mountPath, { recursive: true });
    return { ...identity, mountPath };
  }

  hostPath(handle: ShardHandle, relative: string): string {
    return join(handle.mountPath, safeRelative(relative));
  }

  homePath(handle: ShardHandle): string {
    return handle.mountPath;
  }

  claudeManagedDir(): null {
    return null;
  }

  spawnPipe(handle: ShardHandle, spec: Omit<SpawnSpec, "cols" | "rows">): ChildProcess {
    const cwd = this.hostPath(handle, spec.cwd);
    mkdirSync(cwd, { recursive: true });
    return spawn(spec.file, spec.args, { cwd, stdio: spec.extraPipe ? [spec.stdin ? "pipe" : "ignore", "pipe", "pipe", "pipe"] : [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"], env: spec.env, windowsHide: true });
  }

  spawn(handle: ShardHandle, spec: SpawnSpec): PtyProcess {
    const cwd = this.hostPath(handle, spec.cwd);
    mkdirSync(cwd, { recursive: true });
    return spawnPty(spec.file, spec.args, {
      name: "xterm-256color",
      cols: spec.cols,
      rows: spec.rows,
      cwd,
      env: spec.env,
    });
  }

  async sleep(): Promise<void> {}
}

export function createShardDriver(config: Config): ShardDriver {
  const mode = config.shardDriver === "auto" ? (process.platform === "linux" ? "linux" : "local") : config.shardDriver;
  if (mode === "linux") {
    if (process.platform !== "linux") throw new Error("FLOQ_SHARD_DRIVER=linux requires a Linux host");
    // Flag off (default): no NetnsManager is even constructed.
    const mode = netnsMode();
    const netns = mode === "off" ? null : new NetnsManager({
      mode,
      runtimePort: config.port,
      allow: parseAllowList(process.env.FLOQ_NETNS_ALLOW),
      metaDir: join(config.shardRoot, "meta"),
    });
    return new LinuxShardDriver(config, netns);
  }
  log.warn("shard.local_driver", { message: "Running without per-user isolation or encryption (development only)" });
  return new LocalShardDriver(config);
}
