import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DOWNLOAD_LINK_TTL_MS = 60_000;

export type DownloadAudience = "ws" | "art";

export interface DownloadClaims {
  /** Floq user id. */
  u: string;
  /** Better-auth session id the link was issued under; sign-out revokes it. */
  sid: string;
  /** Floq session id whose workspace is read. */
  s: string;
  /** Workspace-relative path ("" is the workspace root). */
  p: string;
  /** Issued-at and expiry, epoch ms. */
  iat: number;
  exp: number;
  /** Audience: which download route the link is for, so a link cannot be replayed against the other route. */
  k: DownloadAudience;
  /** Single-use id. */
  j: string;
}

const b64 = (buffer: Buffer) => buffer.toString("base64url");

/**
 * Short-lived, path-bound, single-use download links. Issued only from bearer-authenticated endpoints, because a
 * browser or WebView navigation cannot send an Authorization header.
 */
export class DownloadLinks {
  private readonly key: Buffer;
  private readonly used = new Map<string, number>();
  private readonly revokedSessions = new Map<string, number>();
  private readonly revokedUsers = new Map<string, number>();

  constructor(secret: string, private readonly now: () => number = Date.now) {
    this.key = createHmac("sha256", secret).update("floq:download-link:v1").digest();
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.key).update(payload).digest();
  }

  issue(input: { userId: string; authSessionId: string; sessionId: string; path: string; audience: DownloadAudience }): { token: string; expiresAt: number } {
    if (!input.authSessionId) throw new Error("A download link needs an auth session");
    const iat = this.now();
    const claims: DownloadClaims = { u: input.userId, sid: input.authSessionId, s: input.sessionId, p: input.path, k: input.audience, iat, exp: iat + DOWNLOAD_LINK_TTL_MS, j: randomBytes(12).toString("hex") };
    const payload = b64(Buffer.from(JSON.stringify(claims)));
    return { token: `${payload}.${b64(this.sign(payload))}`, expiresAt: claims.exp };
  }

  /** Verify signature, expiry, revocation and single use. Returns null for any failure (no detail leaks). */
  redeem(token: unknown, audience: DownloadAudience): DownloadClaims | null {
    if (typeof token !== "string" || token.length > 2048) return null;
    const dot = token.indexOf(".");
    if (dot < 1 || token.indexOf(".", dot + 1) !== -1) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), "base64url");
    const expected = this.sign(payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: DownloadClaims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DownloadClaims; } catch { return null; }
    if (!claims || typeof claims.u !== "string" || typeof claims.sid !== "string" || typeof claims.s !== "string" || typeof claims.p !== "string" || typeof claims.j !== "string" || claims.k !== audience || typeof claims.exp !== "number" || typeof claims.iat !== "number") return null;
    const now = this.now();
    if (claims.exp <= now) return null;
    const revokedUser = this.revokedUsers.get(claims.u);
    if ((revokedUser !== undefined && claims.iat <= revokedUser) || this.revokedSessions.has(claims.sid)) return null;
    this.sweep(now);
    if (this.used.has(claims.j)) return null;
    this.used.set(claims.j, claims.exp);
    return claims;
  }

  /** Sign-out: kill every link issued under this auth session, and every link of the user issued so far. */
  revokeSession(authSessionId: string): void {
    this.revokedSessions.set(authSessionId, this.now() + DOWNLOAD_LINK_TTL_MS);
  }

  revokeUser(userId: string): void {
    this.revokedUsers.set(userId, this.now());
  }

  private sweep(now: number): void {
    for (const [id, exp] of this.used) if (exp <= now) this.used.delete(id);
    for (const [id, until] of this.revokedSessions) if (until <= now) this.revokedSessions.delete(id);
    for (const [id, at] of this.revokedUsers) if (at + DOWNLOAD_LINK_TTL_MS <= now) this.revokedUsers.delete(id);
  }
}
