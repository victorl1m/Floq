import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type pg from "pg";
import { notFound, unauthorized } from "./errors.js";

export const DAV_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_MOUNTS_PER_USER = 10;
/** A user counts as online if their app made an authenticated request this recently (DAV polling alone never counts). */
export const ONLINE_WINDOW_MS = 15 * 60 * 1000;
export const SESSION_CHECK_MS = 30_000;
export const RATE_LIMIT_PER_MINUTE = 3_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DavFolder { name: string; cwd: string }
export interface DavMount {
  /** 32 lowercase hex characters: UNC paths are case-insensitive and MAX_PATH is tight. */
  token: string;
  userId: string;
  authSessionId: string;
  projectId: string;
  folders: DavFolder[];
  expiresAt: number;
}

/** Collection name for a workspace folder: one safe path segment. */
export function folderLabel(cwd: string, fallback: string): string {
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").trim().replace(/^\.+$/, "");
  return (clean(basename(cwd)) || clean(fallback) || "workspace").slice(0, 80);
}

/** WebDAV locations of a mount as seen through `baseUrl` (how the caller reaches the runtime). */
export function mountLocations(baseUrl: string, token: string): { davUrl: string; uncPath: string } {
  const url = new URL(baseUrl);
  const secure = url.protocol === "https:";
  const defaultPort = secure ? "443" : "80";
  const port = url.port || defaultPort;
  const host = url.hostname.includes(":") && !url.hostname.startsWith("[") ? `[${url.hostname}]` : url.hostname;
  const davUrl = `${secure ? "https" : "http"}://${host}${url.port && url.port !== defaultPort ? `:${url.port}` : ""}/dav/${token}/`;
  // Windows WebClient syntax: \\host@SSL@port\DavWWWRoot\path (or \\host@port\... for plain http). The port is always explicit: without it Windows tries SMB first and sends NTLM credentials.
  const uncPath = `\\\\${url.hostname}${secure ? "@SSL" : ""}@${port}\\DavWWWRoot\\dav\\${token}\\`;
  return { davUrl, uncPath };
}

/**
 * Read-only WebDAV mounts of a project's workspace folders. A mount is an in-memory capability: it dies with the process,
 * after 8 hours, on Eject, and on sign-out of the auth session it was created under.
 */
export class DavMounts {
  private readonly mounts = new Map<string, DavMount>();
  private readonly lastSeen = new Map<string, number>();
  private readonly liveCache = new Map<string, { live: boolean; at: number }>();
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly pool: Pick<pg.Pool, "query">, private readonly now: () => number = Date.now) {}

  async create(userId: string, authSessionId: string, projectId: string): Promise<DavMount> {
    if (!authSessionId) throw unauthorized();
    if (!UUID.test(projectId)) throw notFound("Project not found");
    // Owner check first: a project of another user is indistinguishable from a missing one.
    const owned = await this.pool.query("SELECT 1 FROM floq_projects WHERE id=$1 AND user_id=$2", [projectId, userId]);
    if (owned.rowCount === 0) throw notFound("Project not found");
    const rows = (await this.pool.query("SELECT cwd,name FROM floq_project_workspaces WHERE project_id=$1 AND user_id=$2 AND available IS NOT FALSE ORDER BY created_at", [projectId, userId])).rows as Array<{ cwd: string; name: string }>;
    if (rows.length === 0) throw notFound("This project has no folders to share");
    const used = new Set<string>();
    const folders = rows.map((row) => {
      const base = folderLabel(row.cwd, row.name);
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      used.add(name.toLowerCase());
      return { name, cwd: row.cwd };
    });
    this.sweep();
    const mine = [...this.mounts.values()].filter((mount) => mount.userId === userId).sort((a, b) => a.expiresAt - b.expiresAt);
    while (mine.length >= MAX_MOUNTS_PER_USER) this.mounts.delete(mine.shift()!.token);
    const mount: DavMount = { token: randomBytes(16).toString("hex"), userId, authSessionId, projectId, folders, expiresAt: this.now() + DAV_TTL_MS };
    this.mounts.set(mount.token, mount);
    this.touch(userId);
    return mount;
  }

  resolve(token: string): DavMount | null {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const mount = this.mounts.get(token);
    if (!mount) return null;
    if (mount.expiresAt <= this.now()) { this.mounts.delete(token); return null; }
    return mount;
  }

  /** Eject: remove one mount (by token) or every mount of a project. Returns how many were removed. */
  revoke(userId: string, projectId: string, token?: string): number {
    let removed = 0;
    for (const mount of [...this.mounts.values()]) {
      if (mount.userId !== userId || mount.projectId !== projectId || (token !== undefined && mount.token !== token)) continue;
      this.mounts.delete(mount.token);
      removed++;
    }
    return removed;
  }

  revokeSession(authSessionId: string): void {
    if (!authSessionId) return;
    for (const mount of [...this.mounts.values()]) if (mount.authSessionId === authSessionId) this.mounts.delete(mount.token);
  }

  revokeUser(userId: string): void {
    for (const mount of [...this.mounts.values()]) if (mount.userId === userId) this.mounts.delete(mount.token);
    this.lastSeen.delete(userId);
  }

  touch(userId: string): void {
    this.lastSeen.set(userId, this.now());
  }

  isOnline(userId: string): boolean {
    const seen = this.lastSeen.get(userId);
    return seen !== undefined && this.now() - seen <= ONLINE_WINDOW_MS;
  }

  /**
   * The better-auth session the mount was created under must still exist and be unexpired (checked at most every 30s per
   * session, fail closed). This also covers sign-out from another device or a server-side session purge.
   */
  async sessionLive(mount: DavMount): Promise<boolean> {
    const cached = this.liveCache.get(mount.authSessionId);
    const now = this.now();
    if (cached && now - cached.at < SESSION_CHECK_MS) return cached.live;
    let live = false;
    try {
      const result = await this.pool.query('SELECT 1 FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt" > now()', [mount.authSessionId, mount.userId]);
      live = (result.rowCount ?? 0) > 0;
    } catch {
      live = false;
    }
    this.liveCache.set(mount.authSessionId, { live, at: now });
    if (!live) this.revokeSession(mount.authSessionId);
    return live;
  }

  /** Fixed-window limiter per token. */
  allow(token: string): boolean {
    const now = this.now();
    const hit = this.hits.get(token);
    if (!hit || hit.resetAt <= now) { this.hits.set(token, { count: 1, resetAt: now + 60_000 }); return true; }
    hit.count += 1;
    return hit.count <= RATE_LIMIT_PER_MINUTE;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, mount] of this.mounts) if (mount.expiresAt <= now) { this.mounts.delete(token); this.hits.delete(token); }
    for (const [token, hit] of this.hits) if (hit.resetAt <= now && !this.mounts.has(token)) this.hits.delete(token);
    for (const [sid, entry] of this.liveCache) if (now - entry.at > SESSION_CHECK_MS) this.liveCache.delete(sid);
    for (const [user, seen] of this.lastSeen) if (now - seen > ONLINE_WINDOW_MS) this.lastSeen.delete(user);
  }
}
