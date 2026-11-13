import type pg from "pg";
import type { Config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { log } from "./logger.js";
import { CLAUDE_SCOPES } from "./claudeOauth.js";

export type OAuthProvider = "claude" | "codex";

/**
 * Canonical shape per provider, exactly what the CLI keeps on disk:
 * - claude: the `claudeAiOauth` object of ~/.claude/.credentials.json (accessToken, refreshToken, expiresAt ms, scopes, subscriptionType, ...)
 * - codex: the whole ~/.codex/auth.json ({tokens:{id_token,access_token,refresh_token,account_id}, last_refresh, ...})
 */
export type CredentialData = Record<string, unknown>;

export interface CredentialStatus {
  connected: boolean;
  detail: string | null;
  expiresAt: string | null;
  plan: string | null;
}

const CLAUDE_REFRESH_BEFORE_MS = 30 * 60_000;
const CODEX_REFRESH_BEFORE_MS = 60 * 60_000;
const CODEX_MAX_AGE_MS = 7 * 24 * 3600_000;
const LOOP_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const SIGN_IN_AGAIN = "Sign in again";

function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Expiry (ms epoch) of a credential, or null if unknown. */
export function expiryOf(provider: OAuthProvider, data: CredentialData): number | null {
  if (provider === "claude") return typeof data.expiresAt === "number" ? data.expiresAt : null;
  const exp = jwtClaims((data.tokens as Record<string, unknown> | undefined)?.access_token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

export function refreshTokenOf(provider: OAuthProvider, data: CredentialData): string | null {
  const value = provider === "claude" ? data.refreshToken : (data.tokens as Record<string, unknown> | undefined)?.refresh_token;
  return typeof value === "string" && value ? value : null;
}

function planOf(provider: OAuthProvider, data: CredentialData): string | null {
  if (provider === "claude") return typeof data.subscriptionType === "string" ? data.subscriptionType : null;
  const auth = jwtClaims((data.tokens as Record<string, unknown> | undefined)?.id_token)?.["https://api.openai.com/auth"] as
    | Record<string, unknown>
    | undefined;
  return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null;
}

/** True when the credential has what a CLI needs to run (and to be refreshed). */
export function validCredential(provider: OAuthProvider, data: unknown): data is CredentialData {
  if (!data || typeof data !== "object") return false;
  const d = data as CredentialData;
  if (provider === "claude") return typeof d.accessToken === "string" && typeof d.refreshToken === "string";
  const tokens = d.tokens as Record<string, unknown> | undefined;
  return typeof tokens?.access_token === "string" && typeof tokens?.refresh_token === "string";
}

export class RefreshFailure extends Error {
  constructor(
    readonly permanent: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Owns the OAuth credentials of every user's Claude / Codex subscription login. The CLIs never refresh
 * on their own against a stale copy: the server refreshes before expiry (one refresh at a time per user
 * and provider, in-process and across instances via a Postgres advisory lock), persists the rotated
 * refresh token, and hands the fresh credential to live sessions through `onChange`.
 */
export class CredentialBroker {
  private readonly inflight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  /** Called after the stored credential changed (refresh or adoption) so live sessions get new files. */
  onChange: (userId: string, provider: OAuthProvider, data: CredentialData) => void = () => undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), LOOP_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private aad(userId: string, provider: OAuthProvider): string {
    return `${userId}:${provider}_oauth`;
  }

  async get(userId: string, provider: OAuthProvider, db: { query: pg.Pool["query"] } = this.pool): Promise<CredentialData | null> {
    const row = (await db.query("SELECT data_enc, status FROM provider_credentials WHERE user_id = $1 AND provider = $2", [userId, provider])).rows[0];
    if (!row?.data_enc || row.status !== "connected") return null;
    return JSON.parse(decryptSecret(this.config.encryptionKey, row.data_enc, this.aad(userId, provider))) as CredentialData;
  }

  async save(userId: string, provider: OAuthProvider, data: CredentialData, db: { query: pg.Pool["query"] } = this.pool): Promise<void> {
    const enc = encryptSecret(this.config.encryptionKey, JSON.stringify(data), this.aad(userId, provider));
    const expires = expiryOf(provider, data);
    await db.query(
      `INSERT INTO provider_credentials (user_id, provider, data_enc, expires_at, status, detail, fail_count, next_attempt_at, plan, updated_at)
       VALUES ($1,$2,$3,$4,'connected',NULL,0,NULL,$5, now())
       ON CONFLICT (user_id, provider) DO UPDATE SET data_enc = $3, expires_at = $4, status = 'connected', detail = NULL,
         fail_count = 0, next_attempt_at = NULL, plan = $5, updated_at = now()`,
      [userId, provider, enc, expires ? new Date(expires) : null, planOf(provider, data)],
    );
  }

  async remove(userId: string, provider: OAuthProvider): Promise<void> {
    await this.pool.query("DELETE FROM provider_credentials WHERE user_id = $1 AND provider = $2", [userId, provider]);
  }

  async status(userId: string): Promise<Record<OAuthProvider, CredentialStatus>> {
    const rows = (await this.pool.query("SELECT provider, status, detail, expires_at, plan FROM provider_credentials WHERE user_id = $1", [userId])).rows;
    const one = (id: OAuthProvider): CredentialStatus => {
      const row = rows.find((r) => r.provider === id);
      if (!row) return { connected: false, detail: null, expiresAt: null, plan: null };
      const connected = row.status === "connected";
      return {
        connected,
        detail: connected ? row.detail ?? null : row.detail ?? SIGN_IN_AGAIN,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        plan: row.plan ?? null,
      };
    };
    return { claude: one("claude"), codex: one("codex") };
  }

  /**
   * A CLI rotated the credential on its own: adopt it under the same lock so the server never refreshes
   * with a rotated-out refresh token. Only adopts when its refresh token differs and it is not older.
   */
  async adopt(userId: string, provider: OAuthProvider, data: CredentialData): Promise<boolean> {
    if (!validCredential(provider, data)) return false;
    return this.locked(userId, provider, async () => {
      const current = await this.get(userId, provider);
      if (current && refreshTokenOf(provider, current) === refreshTokenOf(provider, data)) {
        // Same refresh token: take it only if its access token is newer (the CLI refreshed within the same grant).
        if ((expiryOf(provider, data) ?? 0) <= (expiryOf(provider, current) ?? 0)) return false;
      } else if (current && (expiryOf(provider, data) ?? 0) < (expiryOf(provider, current) ?? 0)) {
        return false;
      }
      await this.save(userId, provider, data);
      log.info("credentials.adopted", { userId, provider });
      return true;
    });
  }

  /** Exchange the refresh token of a credential that is NOT the stored one (a reserve Claude account). Throws RefreshFailure; persists nothing. */
  refreshData(provider: OAuthProvider, data: CredentialData): Promise<CredentialData> {
    const refreshToken = refreshTokenOf(provider, data);
    if (!refreshToken) return Promise.reject(new RefreshFailure(true, "no refresh token"));
    return this.exchange(provider, data, refreshToken);
  }

  /** Refresh now if the credential is close to expiry (or `force`). Never throws. */
  async refresh(userId: string, provider: OAuthProvider, force = false): Promise<void> {
    const key = userId + ":" + provider;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const run = this.refreshLocked(userId, provider, force)
      .catch((error) => log.error("credentials.refresh_error", { userId, provider, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** In-process mutex (inflight) plus a transaction-scoped Postgres advisory lock. */
  private async locked<T>(userId: string, provider: OAuthProvider, task: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["cred:" + userId + ":" + provider]);
      const result = await task();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshLocked(userId: string, provider: OAuthProvider, force: boolean): Promise<void> {
    let fresh: CredentialData | null = null;
    await this.locked(userId, provider, async () => {
      const row = (await this.pool.query("SELECT status, next_attempt_at, fail_count FROM provider_credentials WHERE user_id = $1 AND provider = $2", [userId, provider])).rows[0];
      if (!row || row.status !== "connected") return;
      if (!force && row.next_attempt_at && new Date(row.next_attempt_at).getTime() > Date.now()) return;
      const data = await this.get(userId, provider); // re-read under the lock: a CLI/another instance may have rotated it
      if (!data || !this.due(provider, data, force)) return;
      const refreshToken = refreshTokenOf(provider, data);
      if (!refreshToken) return this.fail(userId, provider, true, "no refresh token", row.fail_count);
      try {
        fresh = await this.exchange(provider, data, refreshToken);
        await this.save(userId, provider, fresh); // the NEW refresh token is persisted before anything else can use it
        log.info("credentials.refreshed", { userId, provider });
      } catch (error) {
        const failure = error instanceof RefreshFailure ? error : new RefreshFailure(false, error instanceof Error ? error.message : String(error));
        await this.fail(userId, provider, failure.permanent, failure.message, row.fail_count);
      }
    });
    if (fresh) this.onChange(userId, provider, fresh);
  }

  private due(provider: OAuthProvider, data: CredentialData, force: boolean): boolean {
    if (force) return true;
    const exp = expiryOf(provider, data);
    if (provider === "claude") return exp === null || exp - Date.now() < CLAUDE_REFRESH_BEFORE_MS;
    const last = typeof data.last_refresh === "string" ? Date.parse(data.last_refresh) : NaN;
    return exp === null || exp - Date.now() < CODEX_REFRESH_BEFORE_MS || (Number.isFinite(last) && Date.now() - last > CODEX_MAX_AGE_MS);
  }

  private async fail(userId: string, provider: OAuthProvider, permanent: boolean, message: string, previous: number): Promise<void> {
    if (permanent) {
      await this.pool.query("UPDATE provider_credentials SET status = 'disconnected', detail = $3, updated_at = now() WHERE user_id = $1 AND provider = $2", [userId, provider, SIGN_IN_AGAIN]);
      log.warn("credentials.disconnected", { userId, provider, reason: message });
      return;
    }
    const attempts = Number(previous) + 1;
    const delay = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (attempts - 1));
    await this.pool.query(
      "UPDATE provider_credentials SET fail_count = $3, next_attempt_at = $4, detail = 'Refresh failing, retrying' WHERE user_id = $1 AND provider = $2",
      [userId, provider, attempts, new Date(Date.now() + delay)],
    );
    log.warn("credentials.refresh_failed", { userId, provider, attempts, retryInMs: delay, reason: message });
  }

  private async exchange(provider: OAuthProvider, data: CredentialData, refreshToken: string): Promise<CredentialData> {
    const oauth = this.config.oauth[provider];
    const body =
      provider === "claude"
        ? {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: oauth.clientId,
            scope: (Array.isArray(data.scopes) && data.scopes.length ? (data.scopes as string[]) : CLAUDE_SCOPES).join(" "),
          }
        : { client_id: oauth.clientId, grant_type: "refresh_token", refresh_token: refreshToken, scope: "openid profile email" };
    let response: Response;
    try {
      response = await fetch(oauth.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "floq-runtime" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new RefreshFailure(false, "network: " + (error instanceof Error ? error.message : String(error)));
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = String((payload.error as Record<string, unknown> | undefined)?.code ?? payload.error ?? "");
      const permanent = /invalid_grant|refresh_token_expired|refresh_token_reused|refresh_token_invalidated/.test(code);
      throw new RefreshFailure(permanent, `HTTP ${response.status} ${code}`.trim());
    }
    if (typeof payload.access_token !== "string") throw new RefreshFailure(false, "response without access_token");
    const newRefresh = typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : refreshToken;
    if (provider === "claude") {
      const expiresIn = Number(payload.expires_in) || 3600;
      return {
        ...data,
        accessToken: payload.access_token,
        refreshToken: newRefresh,
        expiresAt: Date.now() + expiresIn * 1000,
        ...(typeof payload.scope === "string" && payload.scope ? { scopes: payload.scope.split(" ") } : {}),
      };
    }
    const tokens = { ...((data.tokens as Record<string, unknown>) ?? {}) };
    tokens.access_token = payload.access_token;
    tokens.refresh_token = newRefresh;
    if (typeof payload.id_token === "string") tokens.id_token = payload.id_token;
    return { ...data, tokens, last_refresh: new Date().toISOString() };
  }

  private async tick(): Promise<void> {
    try {
      const rows = (await this.pool.query("SELECT user_id, provider FROM provider_credentials WHERE status = 'connected' AND (next_attempt_at IS NULL OR next_attempt_at <= now())")).rows;
      for (const row of rows) {
        await this.refresh(row.user_id, row.provider as OAuthProvider);
      }
    } catch (error) {
      log.error("credentials.tick_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
