import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, statfs, unlink, lchown } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { DavFolder, DavMount } from "./davMounts.js";
import { HttpError, badRequest } from "./errors.js";
import { HAS_PROC_FD, HIDDEN_NAMES, isWithin, openWithin } from "./workspaceFiles.js";
import { TreeBudget, commitFile, copyDirectory, moveNoReplace, removeTree, writeNewFile, type TreeBudgetOptions } from "./davTree.js";

/*
 * Write policy and threat model (see davTree.ts for the descriptor-pinned walks):
 * - The runtime is root; an agent in the sandbox controls the tree and can swap directories for symlinks in real time.
 *   Recursive COPY/DELETE and the COPY rollback therefore only ever go through /proc/self/fd/<dirfd>/<name>.
 *   Without /proc/self/fd (HAS_PROC_FD false) every write method is refused with 501.
 * - Hidden names: `.git` and `node_modules` (and our own `.dav-*.part` temp files) are refused as the top-level name of
 *   the request target (and of a Destination), and the pinned parent's real path must not pass through them. A recursive
 *   COPY or DELETE of a folder that merely contains them is allowed: the user chose full write access to the workspace.
 *   node_modules is enforced here (openParent) and not in openWithin because openWithin also serves the file browser,
 *   which is allowed to look into node_modules.
 */

/** DELETE and COPY can be switched off here (they then answer 405). */
export const DAV_ALLOW_DELETE_COPY = true;
export const WRITE_METHODS = new Set(["PUT", "MKCOL", "MOVE", "COPY", "DELETE", "PROPPATCH", "LOCK", "UNLOCK"]);
export const DEFAULT_MAX_PUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_XML_BODY = 64 * 1024;
const MAX_LOCKS_PER_USER = 500;
const DEFAULT_LOCK_SECONDS = 600;
const MAX_LOCK_SECONDS = 3600;
const COPY_MAX_ENTRIES = 100_000;
const COPY_MAX_DEPTH = 100;
const GIB = 1024 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_WRITES = 4;
const DEFAULT_MIN_FREE_BYTES = GIB;
const DEFAULT_MIN_FREE_FRACTION = 0.05;

/** macOS Finder litter. It is accepted and thrown away: refusing it makes Finder abort the whole copy, storing it litters the project. */
export const isJunkName = (name: string): boolean => name === ".DS_Store" || name.startsWith("._");

/** Split a request path into decoded segments. Rejects traversal, separators and NUL. */
export function splitDavPath(rawPath: string): string[] {
  let segments: string[];
  try { segments = rawPath.split("/").filter((part) => part !== "").map((part) => decodeURIComponent(part)); } catch { throw badRequest("Invalid path"); }
  if (segments.some((part) => part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0"))) throw badRequest("Invalid path");
  return segments;
}

const forbidden = (message = "Forbidden") => new HttpError(403, "forbidden", message);
const unsupported = () => new HttpError(501, "not_implemented", "Writing is not supported on this host (no /proc/self/fd)");
const conflict = (message: string) => new HttpError(409, "conflict", message);

function validWriteName(name: string): void {
  if (name === "" || /[\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name) > 255 || HIDDEN_NAMES.has(name) || /^\.dav-.*\.part$/.test(name)) throw forbidden("This name is not allowed");
}

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Lock { id: string; prefix: string; path: string; depth: "0" | "infinity"; owner: string; expires: number; userId: string; href: string }

/** In-memory exclusive write locks. They die with the process; clients (Explorer, Finder, Office) only need them to be consistent. */
export class DavLocks {
  private readonly locks = new Map<string, Lock>();
  constructor(private readonly now: () => number = Date.now) {}

  private live(): Lock[] {
    const now = this.now();
    for (const [id, lock] of this.locks) if (lock.expires <= now) this.locks.delete(id);
    return [...this.locks.values()];
  }

  private covering(prefix: string, path: string): Lock[] {
    return this.live().filter((l) => l.prefix === prefix && (l.path === path || (l.depth === "infinity" && (l.path === "" || path.startsWith(l.path + "/")))));
  }

  private beneath(prefix: string, path: string): Lock[] {
    return this.live().filter((l) => l.prefix === prefix && l.path !== path && (path === "" || l.path.startsWith(path + "/")));
  }

  /** True when a lock the caller did not present (via the If header) covers `path`, or, with `tree`, anything below it. */
  blocked(prefix: string, path: string, ifHeader: string, tree: boolean): boolean {
    const found = [...this.covering(prefix, path), ...(tree ? this.beneath(prefix, path) : [])];
    return found.some((l) => !ifHeader.includes(l.id));
  }

  create(lock: Omit<Lock, "id">): Lock {
    if (this.live().filter((l) => l.userId === lock.userId).length >= MAX_LOCKS_PER_USER) throw new HttpError(429, "too_many_requests", "Too many locks");
    const full = { ...lock, id: `opaquelocktoken:${randomUUID()}` };
    this.locks.set(full.id, full);
    return full;
  }

  find(prefix: string, path: string, id: string): Lock | undefined {
    const lock = this.locks.get(id);
    return lock && lock.expires > this.now() && lock.prefix === prefix && lock.path === path ? lock : undefined;
  }

  refresh(lock: Lock, seconds: number): void { lock.expires = this.now() + seconds * 1000; }
  release(id: string): void { this.locks.delete(id); }
  /** Forget locks on a resource that was deleted or moved away. */
  dropTree(prefix: string, path: string): void {
    for (const lock of [...this.covering(prefix, path).filter((l) => l.path === path), ...this.beneath(prefix, path)]) this.locks.delete(lock.id);
  }
}

export function lockXml(lock: Lock, now: number): string {
  const seconds = Math.max(1, Math.round((lock.expires - now) / 1000));
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>${lock.depth}</D:depth>`
    + `<D:owner>${xmlEscape(lock.owner)}</D:owner><D:timeout>Second-${seconds}</D:timeout><D:locktoken><D:href>${lock.id}</D:href></D:locktoken><D:lockroot><D:href>${xmlEscape(lock.href)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
}

export interface Located { root: string; rest: string[]; folder: DavFolder; uid?: number }

export interface WriteContext {
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  mount: DavMount;
  /** Decoded segments after /dav/<token>: [folder, ...rest]. */
  segments: string[];
  located: Located;
  /** Resolve another path of the same mount (the Destination of MOVE/COPY). */
  locate(segments: string[]): Promise<Located>;
  /** Throws (404) when the mount was revoked or its session ended since the request started. */
  assertLive(): Promise<void>;
  headers(): Record<string, string>;
}

interface Parent { base: string; real: string; dev: number; close(): Promise<void> }

/** Open the parent directory and verify, on the descriptor, that it is inside the root: later operations go through /proc/self/fd/N. */
async function openParent(root: string, parentRest: string[]): Promise<Parent> {
  if (!HAS_PROC_FD) throw unsupported();
  const real = parentRest.length ? await realpath(join(root, ...parentRest)).catch(() => null) : root;
  if (!real) throw conflict("The parent folder does not exist");
  if (!isWithin(root, real)) throw forbidden();
  const fh = await openWithin(root, real, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY).catch((error) => {
    if (error instanceof HttpError && error.status === 404) throw conflict("The parent folder does not exist");
    throw forbidden();
  });
  try {
    const info = await fh.stat().catch(() => null);
    if (!info?.isDirectory()) throw conflict("The parent is not a folder");
    // The hidden-name rule is checked on the descriptor actually opened, not on the earlier path (which could have been swapped).
    const actual = (await realpath(`/proc/self/fd/${fh.fd}`).catch(() => null))?.replace(/ \(deleted\)$/, "");
    if (!actual || !isWithin(root, actual) || relative(root, actual).split(sep).some((part) => HIDDEN_NAMES.has(part))) throw forbidden();
    return { base: `/proc/self/fd/${fh.fd}`, real: actual, dev: info.dev, close: () => fh.close().catch(() => {}) };
  } catch (error) {
    await fh.close().catch(() => {});
    throw error;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_XML_BODY) throw new HttpError(413, "payload_too_large", "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function discard(req: IncomingMessage, max: number): Promise<void> {
  let size = 0;
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > max) throw new HttpError(413, "payload_too_large", "Request body too large"); }
}

const ownerOf = async (path: string, uid: number | undefined) => { if (uid !== undefined) await lchown(path, uid, uid); };

function mapFsError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") throw new HttpError(507, "insufficient_storage", "Not enough storage space in your workspace");
  if (code === "EXDEV") throw new HttpError(502, "bad_gateway", "Cannot move between these folders");
  if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR") throw conflict("The destination is in the way");
  if (code === "ENOENT") throw conflict("The path does not exist");
  if (code === "ELOOP") throw forbidden();
  if (code === "EBUSY") throw conflict("The path is busy");
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw forbidden();
  if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "ECONNRESET" || (error as Error)?.name === "AbortError") throw badRequest("Upload was interrupted");
  throw error;
}

export interface DavWriterOptions {
  maxPutBytes?: number;
  now?: () => number;
  /** In-flight PUT/COPY/DELETE per user; beyond it requests get 429 (default 4). */
  maxConcurrentWrites?: number;
  /** Free space that writes must leave untouched: the larger of minFreeBytes and minFreeFraction of the filesystem. */
  minFreeBytes?: number;
  minFreeFraction?: number;
  /** Test seam: raw free bytes of the filesystem of `path` (before the reserve is subtracted). */
  freeBytes?: (path: string) => number | Promise<number>;
  /** Test seam: runs right before MOVE publishes the file. */
  beforeMove?: (src: string, dst: string) => Promise<void> | void;
  /** Test seam, forwarded to the tree walks. */
  onEntry?: TreeBudgetOptions["onEntry"];
}

const insufficient = () => new HttpError(507, "insufficient_storage", "Not enough free storage space in your workspace");

export class DavWriter {
  readonly locks: DavLocks;
  private readonly inflight = new Map<string, number>();
  /** Bytes promised to writes that are still running, across all users: the free-space reserve is shared, not per request. */
  private reserved = 0;
  constructor(private readonly options: DavWriterOptions = {}) {
    this.locks = new DavLocks(options.now);
  }

  /** Bytes a write may still use on the filesystem of `path`, keeping the reserve free. Infinity when the filesystem cannot say. */
  private async available(path: string): Promise<number> {
    if (this.options.freeBytes) return Math.max(0, await this.options.freeBytes(path));
    const stats = await statfs(path).catch(() => null);
    if (!stats) return Infinity;
    const total = stats.blocks * stats.bsize;
    const reserve = Math.max(this.options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES, total * (this.options.minFreeFraction ?? DEFAULT_MIN_FREE_FRACTION));
    return Math.max(0, stats.bavail * stats.bsize - reserve);
  }

  /** Snapshot the free room, then let the caller claim bytes against it net of every other in-flight write. Release when done. */
  private async reservation(path: string) {
    const free = await this.available(path);
    let held = 0;
    const self = this;
    return {
      free,
      /** All-or-nothing. */
      claim(bytes: number): boolean {
        if (self.reserved + bytes > free) return false;
        self.reserved += bytes; held += bytes;
        return true;
      },
      /** As much as fits, up to `bytes`. */
      claimUpTo(bytes: number): number {
        const take = Math.max(0, Math.min(bytes, free - self.reserved));
        self.reserved += take; held += take;
        return take;
      },
      release(): void { self.reserved -= held; held = 0; },
    };
  }

  private async slot<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const count = this.inflight.get(userId) ?? 0;
    if (count >= (this.options.maxConcurrentWrites ?? DEFAULT_MAX_CONCURRENT_WRITES)) throw new HttpError(429, "too_many_requests", "Too many writes in progress");
    this.inflight.set(userId, count + 1);
    try { return await work(); } finally {
      const left = (this.inflight.get(userId) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(userId); else this.inflight.set(userId, left);
    }
  }

  private get maxPut() { return this.options.maxPutBytes ?? DEFAULT_MAX_PUT_BYTES; }

  private done(c: WriteContext, status: number, extra: Record<string, string | number> = {}, body?: string): void {
    const headers: Record<string, string | number> = { ...c.headers(), "Content-Length": body === undefined ? 0 : Buffer.byteLength(body), ...extra };
    c.res.writeHead(status, headers).end(body);
  }

  private prefix(c: WriteContext, located: Located = c.located): string { return `${c.mount.userId}\0${located.folder.cwd}`; }
  private ifHeader(c: WriteContext): string { return typeof c.req.headers.if === "string" ? c.req.headers.if : ""; }
  private checkLock(c: WriteContext, located: Located, tree: boolean): void {
    if (this.locks.blocked(this.prefix(c, located), located.rest.join("/"), this.ifHeader(c), tree)) throw new HttpError(423, "locked", "The resource is locked");
  }

  async run(c: WriteContext): Promise<void> {
    if (!DAV_ALLOW_DELETE_COPY && (c.method === "DELETE" || c.method === "COPY")) throw new HttpError(405, "method_not_allowed", "This share does not allow that");
    try {
      switch (c.method) {
        case "MKCOL": return await this.mkcol(c);
        case "PUT": return await this.slot(c.mount.userId, () => this.put(c));
        case "DELETE": return await this.slot(c.mount.userId, () => this.remove(c));
        case "MOVE": return await this.moveOrCopy(c, false);
        case "COPY": return await this.slot(c.mount.userId, () => this.moveOrCopy(c, true));
        case "PROPPATCH": return await this.proppatch(c);
        case "LOCK": return await this.lock(c);
        case "UNLOCK": return await this.unlock(c);
      }
    } catch (error) {
      mapFsError(error);
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }

  private async mkcol(c: WriteContext): Promise<void> {
    const { rest, root, uid } = c.located;
    if (rest.length === 0) throw new HttpError(405, "method_not_allowed", "Already exists");
    const body = await readBody(c.req);
    if (body.trim() !== "") throw new HttpError(415, "unsupported_media_type", "MKCOL bodies are not supported");
    const name = rest[rest.length - 1];
    if (isJunkName(name)) return this.done(c, 201);
    validWriteName(name);
    this.checkLock(c, c.located, false);
    const parent = await openParent(root, rest.slice(0, -1));
    try {
      const target = join(parent.base, name);
      await mkdir(target, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new HttpError(405, "method_not_allowed", "Already exists");
        throw error;
      });
      await ownerOf(target, uid);
    } finally { await parent.close(); }
    this.done(c, 201);
  }

  private async put(c: WriteContext): Promise<void> {
    const { rest, root, uid } = c.located;
    if (rest.length === 0) throw new HttpError(405, "method_not_allowed", "This is a folder");
    const name = rest[rest.length - 1];
    c.res.setHeader("Connection", "close"); // any early answer must not leave a big body streaming in; removed on success below
    const length = Number(c.req.headers["content-length"] ?? NaN);
    if (Number.isFinite(length) && length > this.maxPut) throw new HttpError(413, "payload_too_large", "File too large");
    if (isJunkName(name)) { await discard(c.req, this.maxPut); c.res.removeHeader("Connection"); return this.done(c, 201); }
    validWriteName(name);
    this.checkLock(c, c.located, false);
    const parent = await openParent(root, rest.slice(0, -1));
    try {
      const target = join(parent.base, name);
      const info = await lstat(target).catch(() => null);
      if (info?.isDirectory()) throw new HttpError(405, "method_not_allowed", "This is a folder");
      if (info && !info.isFile()) throw forbidden("Not a regular file");
      if (info && c.req.headers["if-none-match"] === "*") throw new HttpError(412, "precondition_failed", "Already exists");
      const reservation = await this.reservation(parent.base);
      try {
        const granted = reservation.claimUpTo(Number.isFinite(length) ? length : this.maxPut);
        if (Number.isFinite(length) && granted < length) throw insufficient();
        const temp = join(parent.base, `.dav-${randomUUID()}.part`);
        await writeNewFile(temp, info ? info.mode & 0o777 : 0o644, uid, c.req, granted, () => (granted < this.maxPut ? insufficient() : new HttpError(413, "payload_too_large", "File too large")));
        // If-None-Match: * must also hold against a creator that raced us between the lstat and now.
        await commitFile(temp, target, !info && c.req.headers["if-none-match"] === "*");
      } finally { reservation.release(); }
      c.res.removeHeader("Connection");
      this.done(c, info ? 204 : 201);
    } finally { await parent.close(); }
  }

  private async remove(c: WriteContext): Promise<void> {
    const { rest, root } = c.located;
    if (rest.length === 0) throw forbidden("A shared folder cannot be deleted here");
    c.req.resume();
    const name = rest[rest.length - 1];
    if (isJunkName(name)) return this.done(c, 204);
    validWriteName(name);
    this.checkLock(c, c.located, true);
    const parent = await openParent(root, rest.slice(0, -1));
    try {
      const target = join(parent.base, name);
      const info = await lstat(target).catch(() => null);
      if (!info) throw new HttpError(404, "not_found", "Not found");
      // Directories are removed through pinned descriptors (a swap for a link mid-delete is never followed); unlink removes a link itself.
      if (info.isDirectory()) await removeTree(target, parent.dev, new TreeBudget({ maxEntries: COPY_MAX_ENTRIES, maxDepth: COPY_MAX_DEPTH, guard: () => c.assertLive(), onEntry: this.options.onEntry }));
      else await unlink(target);
      this.locks.dropTree(this.prefix(c), rest.join("/"));
    } finally { await parent.close(); }
    this.done(c, 204);
  }

  private async moveOrCopy(c: WriteContext, copy: boolean): Promise<void> {
    const { rest, root } = c.located;
    c.req.resume();
    if (rest.length === 0) throw forbidden("A shared folder cannot be moved or copied here");
    const destination = this.parseDestination(c);
    const dest = await c.locate(destination);
    if (dest.rest.length === 0) throw forbidden("Cannot replace a shared folder");
    const srcName = rest[rest.length - 1];
    const dstName = dest.rest[dest.rest.length - 1];
    if (isJunkName(srcName) || isJunkName(dstName)) return this.done(c, 201);
    validWriteName(srcName); validWriteName(dstName);
    const overwrite = String(c.req.headers.overwrite ?? "T").trim().toUpperCase() !== "F";
    if (!copy) this.checkLock(c, c.located, true);
    this.checkLock(c, dest, false);
    const src = await openParent(root, rest.slice(0, -1));
    try {
      const dst = await openParent(dest.root, dest.rest.slice(0, -1));
      try {
        const srcPath = join(src.base, srcName);
        const dstPath = join(dst.base, dstName);
        const srcInfo = await lstat(srcPath).catch(() => null);
        if (!srcInfo) throw new HttpError(404, "not_found", "Not found");
        if (!srcInfo.isDirectory() && !srcInfo.isFile() && !srcInfo.isSymbolicLink()) throw forbidden();
        const srcReal = join(src.real, srcName);
        const dstReal = join(dst.real, dstName);
        if (isWithin(srcReal, dstReal)) throw forbidden("Cannot copy or move a folder into itself");
        const dstInfo = await lstat(dstPath).catch(() => null);
        if (dstInfo) {
          if (dstInfo.dev === srcInfo.dev && dstInfo.ino === srcInfo.ino) throw forbidden("Source and destination are the same");
          if (!overwrite || dstInfo.isDirectory() || dstInfo.isSymbolicLink() || srcInfo.isDirectory()) throw new HttpError(412, "precondition_failed", "The destination exists");
        }
        if (copy) {
          if (srcInfo.isSymbolicLink()) throw forbidden("Links cannot be copied");
          const depth = String(c.req.headers.depth ?? "infinity").trim().toLowerCase();
          await this.copyNode(c, srcPath, dstPath, srcInfo.isDirectory(), srcInfo.mode & 0o777, dest.uid, c.located.uid, !overwrite, depth === "0", dst);
        } else {
          await this.options.beforeMove?.(srcPath, dstPath);
          // Overwrite:F on a file must be exclusive against a creator that raced the lstat above.
          if (!overwrite && !srcInfo.isDirectory()) await moveNoReplace(srcPath, dstPath);
          else await rename(srcPath, dstPath);
          this.locks.dropTree(this.prefix(c), rest.join("/"));
        }
        this.done(c, dstInfo ? 204 : 201);
      } finally { await dst.close(); }
    } finally { await src.close(); }
  }

  private parseDestination(c: WriteContext): string[] {
    const header = c.req.headers.destination;
    if (typeof header !== "string" || header === "") throw badRequest("Missing Destination");
    let url: URL;
    try { url = new URL(header, "http://placeholder.invalid"); } catch { throw badRequest("Invalid Destination"); }
    const norm = (host: string) => host.toLowerCase().replace(/:(80|443)$/, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(header)) {
      if (!c.req.headers.host || norm(url.host) !== norm(c.req.headers.host)) throw new HttpError(502, "bad_gateway", "Destination is on another server");
    }
    const segments = splitDavPath(url.pathname);
    if (segments[0] !== "dav" || segments[1] !== c.mount.token || segments.length < 3) throw forbidden("Destination is outside this share");
    return segments.slice(2);
  }

  private async copyNode(c: WriteContext, src: string, dst: string, dir: boolean, mode: number, uid: number | undefined, sourceUid: number | undefined, exclusive: boolean, shallow: boolean, parent: Parent): Promise<void> {
    const reservation = await this.reservation(parent.base);
    const over = () => insufficient();
    try {
      if (!dir) {
        const input = await open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        try {
          const info = await input.stat();
          if (!info.isFile()) throw forbidden();
          if (sourceUid !== undefined && info.uid !== sourceUid) throw forbidden("This file is not owned by the workspace user");
          if (!reservation.claim(info.size)) throw over();
          const temp = join(parent.base, `.dav-${randomUUID()}.part`);
          await writeNewFile(temp, mode, uid, input.createReadStream({ autoClose: false }), info.size, over);
          await commitFile(temp, dst, exclusive);
        } finally { await input.close().catch(() => {}); }
        return;
      }
      const budget = new TreeBudget({ maxEntries: COPY_MAX_ENTRIES, maxDepth: COPY_MAX_DEPTH, maxBytes: reservation.free, claim: (n) => reservation.claim(n), sourceUid, byteError: over, guard: () => c.assertLive(), onEntry: this.options.onEntry });
      await copyDirectory(src, dst, uid, shallow, budget);
    } finally { reservation.release(); }
  }

  private async proppatch(c: WriteContext): Promise<void> {
    const { rest, root } = c.located;
    const body = await readBody(c.req);
    const name = rest[rest.length - 1];
    if (rest.length && !isJunkName(name)) {
      validWriteName(name);
      this.checkLock(c, c.located, false);
      const parent = await openParent(root, rest.slice(0, -1)).catch(() => { throw new HttpError(404, "not_found", "Not found"); });
      try { if (!(await lstat(join(parent.base, name)).catch(() => null))) throw new HttpError(404, "not_found", "Not found"); } finally { await parent.close(); }
    }
    // Properties are accepted but not stored (Windows sets Win32 timestamps after every copy): echo each one back as set.
    const namespaces = new Map<string, string>();
    const rootTag = /<(?:[\w.-]+:)?propertyupdate\b([^>]*)>/i.exec(body);
    for (const m of (rootTag?.[1] ?? "").matchAll(/xmlns(?::([\w.-]+))?="([^"]*)"/g)) namespaces.set(m[1] ?? "", m[2]);
    const props: string[] = [];
    let level = 0; let inProp = -1;
    for (const m of body.matchAll(/<(\/?)([\w.-]+(?::[\w.-]+)?)([^>]*?)(\/?)>/g)) {
      const [, closing, tag, attrs, selfClosing] = m;
      const local = tag.includes(":") ? tag.split(":")[1] : tag;
      if (closing) { level--; if (inProp === level && local === "prop") inProp = -1; continue; }
      if (inProp >= 0 && level === inProp + 1) {
        const declared = [...attrs.matchAll(/xmlns(?::[\w.-]+)?="[^"]*"/g)].map((a) => a[0]).join(" ");
        props.push(`<${tag}${declared ? " " + declared : ""}/>`);
      }
      if (local === "prop" && inProp < 0) inProp = level;
      if (!selfClosing) level++;
    }
    const decl = [...namespaces].filter(([k]) => k !== "").map(([k, v]) => ` xmlns:${k}="${xmlEscape(v)}"`).join("");
    const href = `/dav/${c.mount.token}${c.segments.map((s) => `/${encodeURIComponent(s)}`).join("")}`;
    const out = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:"${decl}><D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${props.join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    this.done(c, 207, { "Content-Type": 'application/xml; charset="utf-8"' }, out);
  }

  private async lock(c: WriteContext): Promise<void> {
    const { rest, root, uid } = c.located;
    const body = await readBody(c.req);
    const prefix = this.prefix(c);
    const path = rest.join("/");
    const timeout = Math.min(MAX_LOCK_SECONDS, Math.max(1, Number(/Second-(\d+)/i.exec(String(c.req.headers.timeout ?? ""))?.[1] ?? DEFAULT_LOCK_SECONDS)));
    const href = `/dav/${c.mount.token}${c.segments.map((s) => `/${encodeURIComponent(s)}`).join("")}`;
    const now = this.options.now ?? Date.now;
    if (body.trim() === "") {
      // Refresh: the If header names the lock.
      const id = /opaquelocktoken:[0-9a-f-]{36}/i.exec(this.ifHeader(c))?.[0];
      const existing = id ? this.locks.find(prefix, path, id) : undefined;
      if (!existing) throw new HttpError(412, "precondition_failed", "No such lock");
      this.locks.refresh(existing, timeout);
      return this.done(c, 200, { "Content-Type": 'application/xml; charset="utf-8"', "Lock-Token": `<${existing.id}>` }, lockXml(existing, now()));
    }
    if (rest.length && /<(?:[\w.-]+:)?shared\b/i.test(body)) throw new HttpError(409, "conflict", "Only exclusive locks are supported");
    if (this.locks.blocked(prefix, path, "", true)) throw new HttpError(423, "locked", "The resource is locked");
    let created = false;
    if (rest.length) {
      const name = rest[rest.length - 1];
      validWriteName(name);
      const parent = await openParent(root, rest.slice(0, -1));
      try {
        const target = join(parent.base, name);
        const info = await lstat(target).catch(() => null);
        if (info && !info.isFile() && !info.isDirectory()) throw forbidden();
        // Locking an unmapped URL creates an empty file (RFC 4918 lock-null); Office and Explorer rely on it.
        if (!info && !isJunkName(name)) {
          const fh = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
          try { if (uid !== undefined) await fh.chown(uid, uid); } finally { await fh.close().catch(() => {}); }
          created = true;
        }
      } finally { await parent.close(); }
    }
    const depthHeader = String(c.req.headers.depth ?? "infinity").trim().toLowerCase();
    const owner = (/<(?:[\w.-]+:)?owner\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?owner>/i.exec(body)?.[1] ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 256);
    const lock = this.locks.create({ prefix, path, depth: depthHeader === "0" ? "0" : "infinity", owner, expires: now() + timeout * 1000, userId: c.mount.userId, href });
    this.done(c, created ? 201 : 200, { "Content-Type": 'application/xml; charset="utf-8"', "Lock-Token": `<${lock.id}>` }, lockXml(lock, now()));
  }

  private async unlock(c: WriteContext): Promise<void> {
    c.req.resume();
    const id = /<(opaquelocktoken:[0-9a-f-]{36})>/i.exec(String(c.req.headers["lock-token"] ?? ""))?.[1];
    if (!id) throw badRequest("Missing Lock-Token");
    const lock = this.locks.find(this.prefix(c), c.located.rest.join("/"), id);
    if (!lock) throw conflict("This resource is not locked with that token");
    this.locks.release(id);
    this.done(c, 204);
  }
}
