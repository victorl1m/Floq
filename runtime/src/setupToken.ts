import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";

type Queryable = Pick<pg.Pool, "query">;

function hashToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

/**
 * One-time setup token for claiming the FLOQ_BOOTSTRAP_ADMIN_EMAIL account. Knowing the email alone is not enough:
 * the operator reads the token from the runtime logs. Only a SHA-256 hash is stored (the token is 192 random bits,
 * so a fast hash is sufficient) and the row is marked used once the account is created.
 */
export class SetupToken {
  constructor(private pool: Queryable) {}

  /**
   * At start, when the bootstrap email has no account yet, issue a fresh token (replacing any earlier unused one) and
   * return it so the caller can print it once. Returns null when nothing is claimable.
   */
  async issueIfNeeded(bootstrapEmail: string | null | undefined): Promise<string | null> {
    if (!bootstrapEmail) return null;
    const existing = await this.pool.query('SELECT 1 FROM "user" WHERE lower(email) = $1 LIMIT 1', [bootstrapEmail.toLowerCase()]);
    if (existing.rowCount) return null;
    const token = randomBytes(24).toString("base64url");
    await this.pool.query(
      `INSERT INTO setup_token (id, token_hash, created_at, used_at) VALUES (TRUE, $1, now(), NULL)
       ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), used_at = NULL`,
      [hashToken(token)],
    );
    return token;
  }

  /** True when the token matches the current unused one. Never reveals why it failed. */
  async verify(token: unknown): Promise<boolean> {
    if (typeof token !== "string" || !token.trim() || token.length > 256) return false;
    const row = await this.pool.query("SELECT token_hash FROM setup_token WHERE id = TRUE AND used_at IS NULL");
    const stored = row.rows[0]?.token_hash;
    if (typeof stored !== "string") return false;
    const a = Buffer.from(stored);
    const b = Buffer.from(hashToken(token));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Invalidate the token. Returns false if it was already used (or never issued). */
  async markUsed(): Promise<boolean> {
    const result = await this.pool.query("UPDATE setup_token SET used_at = now() WHERE id = TRUE AND used_at IS NULL");
    return (result.rowCount ?? 0) > 0;
  }
}
