import { constants as fsConstants } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DavFolder, DavMounts } from "./davMounts.js";
import { HttpError, badRequest, notFound } from "./errors.js";
import { log } from "./logger.js";
import { HAS_PROC_FD, HIDDEN_NAMES, isWithin, openWithin, parseRange } from "./workspaceFiles.js";
import type { SessionManager } from "./manager.js";
import type { ShardHandle } from "./shard.js";

export const PROPFIND_ENTRY_CAP = 2_000;
const ALLOW = "OPTIONS, GET, HEAD, PROPFIND";
const MAX_BODY = 64 * 1024;

export interface DavEntry {
  /** Percent-encoded absolute href, collections end with "/". */
  href: string;
  name: string;
  dir: boolean;
  size?: number;
  /** Epoch ms. */
  mtime?: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".xml": "application/xml", ".csv": "text/csv", ".ts": "text/plain", ".tsx": "text/plain", ".py": "text/plain", ".sh": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wasm": "application/wasm",
};

export const contentTypeFor = (name: string): string => CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 207 Multi-Status body: DAV:allprop-style properties, empty supportedlock/lockdiscovery, RFC 1123 dates. */
export function propfindXml(entries: DavEntry[]): string {
  const responses = entries.map((entry) => {
    const props = [`<D:displayname>${xml(entry.name)}</D:displayname>`];
    props.push(entry.dir ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>");
    if (!entry.dir) {
      props.push(`<D:getcontentlength>${entry.size ?? 0}</D:getcontentlength>`);
      props.push(`<D:getcontenttype>${xml(contentTypeFor(entry.name))}</D:getcontenttype>`);
      if (entry.mtime !== undefined) props.push(`<D:getetag>"${(entry.size ?? 0).toString(16)}-${Math.floor(entry.mtime).toString(16)}"</D:getetag>`);
    }
    if (entry.mtime !== undefined) props.push(`<D:getlastmodified>${new Date(entry.mtime).toUTCString()}</D:getlastmodified>`);
    props.push("<D:supportedlock/>", "<D:lockdiscovery/>");
    return `<D:response><D:href>${xml(entry.href)}</D:href><D:propstat><D:prop>${props.join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;
}

const hrefOf = (token: string, segments: string[], dir: boolean) => `/dav/${token}${segments.map((s) => `/${encodeURIComponent(s)}`).join("")}${dir ? "/" : ""}`;

export interface DavDeps {
  mounts: DavMounts;
  shards: { awakeHandle(userId: string): ShardHandle | undefined; driver: { hostPath(handle: ShardHandle, rel: string): string } };
  manager: Pick<SessionManager, "withUserShardActivity">;
}

/**
 * Read-only WebDAV for Windows Explorer (WebClient), Finder and gvfs, served anonymously under /dav/<token>/ because the
 * Windows mini-redirector cannot send a bearer header. The token is the capability (see davMounts.ts).
 */
export class WebDav {
  constructor(private readonly deps: DavDeps) {}

  /** Paths this handler owns. "/" is only claimed for OPTIONS/PROPFIND probes, so the rest of the app is untouched. */
  handles(req: IncomingMessage): boolean {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/dav" || path.startsWith("/dav/")) return true;
    return path === "/" && (req.method === "OPTIONS" || req.method === "PROPFIND");
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatch(req, res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) return this.text(res, error.status, error.message);
      const errno = (error as NodeJS.ErrnoException)?.code;
      if (errno === "ENOTCONN" || errno === "ECONNABORTED" || errno === "EIO") return this.text(res, 503, "Workspace not available", { "Retry-After": "30" });
      log.error("dav.unhandled", { error: error instanceof Error ? error.message : String(error) });
      this.text(res, 500, "Internal error");
    }
  }

  private baseHeaders(): Record<string, string> {
    return { DAV: "1, 2", "MS-Author-Via": "DAV", Allow: ALLOW, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  }

  private text(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { ...this.baseHeaders(), "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(message), ...extra }).end(message);
  }

  private multistatus(res: ServerResponse, head: boolean, entries: DavEntry[]): void {
    const body = propfindXml(entries);
    res.writeHead(207, { ...this.baseHeaders(), "Content-Type": 'application/xml; charset="utf-8"', "Content-Length": Buffer.byteLength(body) });
    res.end(head ? undefined : body);
  }

  private async drain(req: IncomingMessage): Promise<void> {
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "payload_too_large", "Request body too large");
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const rawPath = (req.url ?? "").split("?")[0];
    if (method === "OPTIONS") { res.writeHead(200, { ...this.baseHeaders(), "Content-Length": 0 }).end(); return; }
    if (method !== "PROPFIND" && method !== "GET" && method !== "HEAD") {
      // LOCK, PROPPATCH, PUT, MKCOL, DELETE, MOVE, COPY, POST...: this share is read-only.
      return this.text(res, 405, "This share is read-only");
    }
    let segments: string[];
    try { segments = rawPath.split("/").filter((part) => part !== "").map((part) => decodeURIComponent(part)); } catch { throw badRequest("Invalid path"); }
    if (segments.some((part) => part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0"))) throw badRequest("Invalid path");

    const depth = typeof req.headers.depth === "string" ? req.headers.depth.trim().toLowerCase() : "infinity";
    if (method === "PROPFIND") {
      await this.drain(req);
      if (depth !== "0" && depth !== "1") {
        const body = '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>';
        res.writeHead(403, { ...this.baseHeaders(), "Content-Type": 'application/xml; charset="utf-8"', "Content-Length": Buffer.byteLength(body) }).end(body);
        return;
      }
    } else {
      req.resume();
    }
    const head = method === "HEAD";

    // The redirector probes the host root and every ancestor of the share before it will show it.
    if (segments.length === 0 || (segments.length === 1 && segments[0] === "dav")) {
      if (method !== "PROPFIND") return this.text(res, 403, "Not a file");
      const self: DavEntry = segments.length === 0 ? { href: "/", name: "/", dir: true } : { href: "/dav/", name: "dav", dir: true };
      return this.multistatus(res, false, [self]);
    }
    if (segments[0] !== "dav") throw notFound("Not found");
    const mount = this.deps.mounts.resolve(segments[1]);
    if (!mount || !(await this.deps.mounts.sessionLive(mount))) throw notFound("This share is no longer available");
    if (!this.deps.mounts.allow(mount.token)) return this.text(res, 429, "Too many requests", { "Retry-After": "60" });
    const token = mount.token;

    if (segments.length === 2) {
      if (method !== "PROPFIND") return this.text(res, 403, "Not a file");
      const entries: DavEntry[] = [{ href: hrefOf(token, [], true), name: token, dir: true }];
      if (depth === "1") for (const folder of mount.folders) entries.push({ href: hrefOf(token, [folder.name], true), name: folder.name, dir: true });
      return this.multistatus(res, false, entries);
    }

    const wanted = segments[2];
    const folder = mount.folders.find((item) => item.name === wanted) ?? (() => {
      const loose = mount.folders.filter((item) => item.name.toLowerCase() === wanted.toLowerCase());
      return loose.length === 1 ? loose[0] : undefined;
    })();
    if (!folder) throw notFound("Not found");
    const rest = segments.slice(3);
    if (rest.some((part) => HIDDEN_NAMES.has(part))) throw notFound("Not found");

    // The workspace is only served while the user is around and the shard is already unlocked: Explorer polls, and that
    // must neither wake a sleeping shard nor keep it awake once the user has gone.
    if (!this.deps.mounts.isOnline(mount.userId) || !this.deps.shards.awakeHandle(mount.userId)) {
      return this.text(res, 503, "Your workspace is asleep. Open Floq and try again.", { "Retry-After": "60" });
    }
    const op = () => this.serve(mount.userId, token, folder, rest, segments.slice(2), method, depth, head, req, res);
    await this.deps.manager.withUserShardActivity(mount.userId, op);
  }

  private async serve(userId: string, token: string, folder: DavFolder, rest: string[], hrefSegments: string[], method: string, depth: string, head: boolean, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const handle = this.deps.shards.awakeHandle(userId);
    if (!handle) return this.text(res, 503, "Your workspace is asleep. Open Floq and try again.", { "Retry-After": "60" });
    const home = await realpath(handle.mountPath);
    const root = await realpath(this.deps.shards.driver.hostPath(handle, folder.cwd)).catch(() => null);
    if (!root || !isWithin(home, root)) throw notFound("Not found");
    const rootInfo = await lstat(root).catch(() => null);
    if (!rootInfo?.isDirectory()) throw notFound("Not found");
    const real = rest.length ? await realpath(join(root, ...rest)).catch(() => null) : root;
    if (!real) throw notFound("Not found");
    if (!isWithin(root, real)) throw new HttpError(403, "forbidden", "Forbidden");
    // Verify on the descriptor actually used (the path check above is only a fast first filter; see openWithin).
    // Hidden names are also rejected on the resolved path, so a symlink to node_modules is not served.
    if (relative(root, real).split(sep).some((part) => HIDDEN_NAMES.has(part))) throw notFound("Not found");
    const fh = await openWithin(root, real, fsConstants.O_RDONLY);
    let owned = true;
    try {
      const info = await fh.stat();
      const name = hrefSegments[hrefSegments.length - 1];
      if (info.isDirectory()) {
        if (method !== "PROPFIND") return this.text(res, 403, "Not a file");
        const entries: DavEntry[] = [{ href: hrefOf(token, hrefSegments, true), name, dir: true, mtime: info.mtimeMs }];
        if (depth === "1") {
          const base = HAS_PROC_FD ? `/proc/self/fd/${fh.fd}` : real;
          // opendir streams entries, so a huge directory is never materialised: stop at the cap.
          const dir = await opendir(base);
          let scanned = 0;
          try {
          for await (const dirent of dir) {
            if (entries.length > PROPFIND_ENTRY_CAP || ++scanned > PROPFIND_ENTRY_CAP * 25) break;
            const child = dirent.name;
            if (HIDDEN_NAMES.has(child) || child.includes("\0") || child.includes("\\")) continue;
            let stats: { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number } | null = null;
            if (dirent.isSymbolicLink()) {
              // Same rule as the file browser: only links whose target stays inside the workspace, proven on a descriptor.
              const linked = await openWithin(root, join(base, child), fsConstants.O_RDONLY).catch(() => null);
              if (linked) { stats = await linked.stat().catch(() => null); await linked.close().catch(() => {}); }
            } else {
              stats = await lstat(join(base, child)).catch(() => null);
            }
            if (!stats || (!stats.isDirectory() && !stats.isFile())) continue;
            entries.push({ href: hrefOf(token, [...hrefSegments, child], stats.isDirectory()), name: child, dir: stats.isDirectory(), size: stats.size, mtime: stats.mtimeMs });
          }
          } finally {
            await dir.close().catch(() => {});
          }
        }
        return this.multistatus(res, false, entries);
      }
      if (!info.isFile()) throw notFound("Not found");
      if (method === "PROPFIND") return this.multistatus(res, false, [{ href: hrefOf(token, hrefSegments, false), name, dir: false, size: info.size, mtime: info.mtimeMs }]);

      const range = parseRange(typeof req.headers.range === "string" ? req.headers.range : undefined, info.size);
      const common = {
        ...this.baseHeaders(),
        // Never let a served .html render with the runtime's origin: the bytes are data, not a page.
        "Content-Type": "application/octet-stream",
        "Content-Security-Policy": "sandbox",
        "Accept-Ranges": "bytes",
        "Last-Modified": new Date(info.mtimeMs).toUTCString(),
        ETag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
      };
      if (range === "invalid") { res.writeHead(416, { ...common, "Content-Range": `bytes */${info.size}`, "Content-Length": 0 }).end(); return; }
      const length = range ? range.end - range.start + 1 : info.size;
      res.writeHead(range ? 206 : 200, { ...common, "Content-Length": length, ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } : {}) });
      if (head || length === 0) { res.end(); return; }
      owned = false; // the read stream closes the handle
      await pipeline(fh.createReadStream({ start: range?.start ?? 0, end: range?.end ?? info.size - 1 }), res).catch(() => {});
    } finally {
      if (owned) await fh.close().catch(() => {});
    }
  }
}
