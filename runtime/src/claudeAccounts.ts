import type pg from "pg";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { CredentialBroker, CredentialData } from "./credentials.js";
import { RefreshFailure, expiryOf, validCredential } from "./credentials.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { log } from "./logger.js";
import type { UsageWindow } from "./usage.js";

/**
 * Several Claude logins per user (docs/design/claude-swap-fallback.md, section 7/8).
 *
 * Invariant: provider_credentials(claude) holds the credential of the ACTIVE slot (user_settings.active_claude_slot), so
 * refresh, syncBack, usage and the sandbox file keep working unchanged. Credentials of the other slots live in
 * claude_accounts.data_enc, encrypted with a per-slot AAD; the active slot's row there only carries metadata. Switching
 * exchanges the two inside one transaction. Inactive credentials never touch the sandbox disk.
 */

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const SLOT = /^(primary|acct_[0-9a-f]{8})$/;
const TICK_MS = 10 * 60_000;
const REFRESH_BEFORE_MS = 60 * 60_000;
const USAGE_CACHE_MS = 60_000;

export interface AccountInfo {
  slot: string;
  label: string;
  plan: string | null;
  active: boolean;
  status: "connected" | "disconnected";
}

interface AccountRow {
  slot: string;
  label: string;
  account_uuid: string | null;
  plan: string | null;
  data_enc: string | null;
  status: string;
  expires_at: Date | null;
  fail_count: number;
  next_attempt_at: Date | null;
}

/** "retry": the profile could not be read just now, so the file must be looked at again later (never dropped). */
export type AdoptResult = "single" | "active" | "reserve" | "unmatched" | "retry";

export interface ClaudeAccountsDeps {
  /** Account uuid of the login behind an access token (a stable identity, not a secret); null when unknown. */
  fetchProfile?: (accessToken: string) => Promise<{ accountUuid: string | null } | null>;
  /** Usage windows of a credential. */
  fetchUsage?: (data: CredentialData) => Promise<UsageWindow[]>;
}

/**
 * Identity of a login: the person AND the organization. One email can hold a personal Max plan and a seat in a Team
 * organization; those are two logins with separate limits, so the account uuid alone would wrongly call them the same.
 */
export function loginIdentity(accountUuid: unknown, organizationUuid: unknown): string | null {
  if (typeof accountUuid !== "string" || !accountUuid) return null;
  return typeof organizationUuid === "string" && organizationUuid ? accountUuid + ":" + organizationUuid : accountUuid;
}

async function defaultProfile(accessToken: string): Promise<{ accountUuid: string | null } | null> {
  try {
    const response = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "floq-runtime" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { account?: { uuid?: unknown }; organization?: { uuid?: unknown } };
    return { accountUuid: loginIdentity(body.account?.uuid, body.organization?.uuid) };
  } catch {
    return null;
  }
}

/** Identities stored before the organization was part of them ("<account>" without ":<org>") are recomputed once. */
const LEGACY_IDENTITY = /^[^:]+$/;
/** After a failed usage read (429 above all), the slot is not asked again for this long; the last known value is served. */
const USAGE_BACKOFF_MS = 5 * 60_000;

export class ClaudeAccounts {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly usageCache = new Map<string, { at: number; windows: UsageWindow[] | null; backoffUntil: number }>();
  private timer: NodeJS.Timeout | undefined;
  /** Called before a switch (outside the per-user chain): adopt any credential the CLI rotated in the sandbox file, so a rotated refresh token is not lost. */
  beforeSwitch?: (userId: string) => Promise<void>;
  /** The extra accounts were forgotten (Claude disconnected): clear dependent fallback state. */
  onReset?: (userId: string) => void;
  /** Called with the active credential after a switch so the sandbox file is rewritten. */
  onActiveChanged: (userId: string, data: CredentialData, slot: string) => void = () => undefined;
  fetchProfile: NonNullable<ClaudeAccountsDeps["fetchProfile"]>;
  fetchUsage?: ClaudeAccountsDeps["fetchUsage"];

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    private readonly credentials: CredentialBroker,
    deps: ClaudeAccountsDeps = {},
  ) {
    this.fetchProfile = deps.fetchProfile ?? defaultProfile;
    this.fetchUsage = deps.fetchUsage;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** AAD: unchanged for the active/primary row in provider_credentials; per slot here so a row cannot be moved to another slot. */
  private aad(userId: string, slot: string): string {
    return `${userId}:claude_oauth:${slot}`;
  }

  /** Serialize account changes per user (in-process chain; the transaction takes a Postgres advisory lock for other instances). */
  private serial<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chains.set(userId, next);
    void next.finally(() => { if (this.chains.get(userId) === next) this.chains.delete(userId); }).catch(() => undefined);
    return next;
  }

  private async transaction<T>(userId: string, task: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["claude_accounts:" + userId]);
      const result = await task(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async activeSlot(userId: string): Promise<string> {
    const row = (await this.pool.query("SELECT active_claude_slot FROM user_settings WHERE user_id = $1", [userId])).rows[0];
    return typeof row?.active_claude_slot === "string" && SLOT.test(row.active_claude_slot) ? row.active_claude_slot : "primary";
  }

  /** When the active slot last changed (ms epoch); null when it never did. */
  async activeSince(userId: string): Promise<number | null> {
    const row = (await this.pool.query("SELECT active_claude_since FROM user_settings WHERE user_id = $1", [userId])).rows[0];
    return row?.active_claude_since ? new Date(row.active_claude_since).getTime() : null;
  }

  /** Make sure the active login has a metadata row (accounts connected before this feature exist only in provider_credentials). */
  private async ensureActiveMeta(userId: string): Promise<void> {
    const slot = await this.activeSlot(userId);
    const have = (await this.pool.query("SELECT 1 FROM claude_accounts WHERE user_id = $1 AND slot = $2", [userId, slot])).rows[0];
    if (have) return;
    const cred = (await this.pool.query("SELECT plan FROM provider_credentials WHERE user_id = $1 AND provider = 'claude' AND status = 'connected'", [userId])).rows[0];
    if (!cred) return;
    await this.pool.query(
      "INSERT INTO claude_accounts (user_id, slot, label, plan) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, slot) DO NOTHING",
      [userId, slot, slot === "primary" ? "Primary" : "Account", cred.plan ?? null],
    );
  }

  private async rows(userId: string): Promise<AccountRow[]> {
    return (await this.pool.query("SELECT slot, label, account_uuid, plan, data_enc, status, expires_at, fail_count, next_attempt_at FROM claude_accounts WHERE user_id = $1 ORDER BY COALESCE(position, -1), (slot = 'primary') DESC, created_at", [userId])).rows as AccountRow[];
  }

  /**
   * Set the order of the accounts. The first one is the login agents use; the others are the fallback chain, in order.
   * `slots` must name every account exactly once. Moving another account to the top switches to it.
   */
  async reorder(userId: string, slots: unknown): Promise<{ switched: boolean }> {
    await this.ensureActiveMeta(userId);
    const rows = await this.rows(userId);
    if (!Array.isArray(slots) || slots.length !== rows.length || new Set(slots).size !== slots.length || !slots.every((s) => typeof s === "string" && rows.some((r) => r.slot === s))) {
      throw badRequest("slots must list every Claude account exactly once", "invalid_order");
    }
    const order = slots as string[];
    await this.serial(userId, () => this.transaction(userId, async (db) => {
      for (const [index, slot] of order.entries()) await db.query("UPDATE claude_accounts SET position = $3 WHERE user_id = $1 AND slot = $2", [userId, slot, index]);
    }));
    const first = order[0]!;
    if (first === (await this.activeSlot(userId))) return { switched: false };
    const top = rows.find((r) => r.slot === first);
    // A first account that needs a new sign-in cannot be used: the order is kept, the current login stays in use.
    if (!top || top.status !== "connected") return { switched: false };
    return { switched: (await this.switchTo(userId, first)).changed };
  }

  async list(userId: string): Promise<AccountInfo[]> {
    await this.ensureActiveMeta(userId);
    const active = await this.activeSlot(userId);
    return (await this.rows(userId)).map((r) => ({ slot: r.slot, label: r.label, plan: r.plan, active: r.slot === active, status: r.status === "connected" ? "connected" : "disconnected" }));
  }

  /** Slots that could take over right now (connected, with a stored credential, not the active one), in the order given first. */
  async reserveSlots(userId: string, order: string[] = []): Promise<AccountInfo[]> {
    const all = (await this.list(userId)).filter((a) => !a.active && a.status === "connected");
    const rank = (slot: string) => { const i = order.indexOf(slot); return i < 0 ? 1000 : i; };
    return all.sort((a, b) => rank(a.slot) - rank(b.slot));
  }

  private async uuidOf(userId: string, row: AccountRow, active: string): Promise<string | null> {
    if (row.account_uuid && !LEGACY_IDENTITY.test(row.account_uuid)) return row.account_uuid;
    const legacy = row.account_uuid;
    const resolved = await this.resolveIdentity(userId, row, active);
    // The profile could not be read: a legacy value still identifies the person (better than nothing for attribution).
    return resolved ?? legacy;
  }

  private async resolveIdentity(userId: string, row: AccountRow, active: string): Promise<string | null> {
    const data = row.slot === active ? await this.credentials.get(userId, "claude") : this.decryptRow(userId, row);
    if (!data || typeof data.accessToken !== "string") return null;
    const uuid = (await this.fetchProfile(data.accessToken))?.accountUuid ?? null;
    if (uuid) await this.pool.query("UPDATE claude_accounts SET account_uuid = $3 WHERE user_id = $1 AND slot = $2", [userId, row.slot, uuid]);
    return uuid;
  }

  /** Null for no stored credential or a row that cannot be decrypted (logged once per call, never thrown: a corrupt row is "sign in again", not a 500). */
  private decryptRow(userId: string, row: AccountRow): CredentialData | null {
    if (!row.data_enc) return null;
    try {
      return JSON.parse(decryptSecret(this.config.encryptionKey, row.data_enc, this.aad(userId, row.slot))) as CredentialData;
    } catch {
      log.warn("claude_accounts.unreadable", { userId, slot: row.slot });
      return null;
    }
  }

  /** Connect another login as a reserve slot. The active credential is not touched. Refuses a login that is already connected. */
  add(userId: string, data: CredentialData, labelInput?: unknown): Promise<AccountInfo> {
    return this.serial(userId, async () => {
      if (!validCredential("claude", data)) throw badRequest("Not a valid Claude login", "invalid_code");
      await this.ensureActiveMeta(userId);
      const uuid = (await this.fetchProfile(String(data.accessToken)))?.accountUuid ?? null;
      if (!uuid) throw badRequest("Could not identify this Claude account. Try again.", "account_unknown");
      const active = await this.activeSlot(userId);
      const rows = await this.rows(userId);
      const plan = typeof data.subscriptionType === "string" ? data.subscriptionType : null;
      const expires = expiryOf("claude", data);
      for (const row of rows) {
        if ((await this.uuidOf(userId, row, active)) !== uuid) continue;
        // The same login again: a new sign-in for it (renews an expired or "sign in again" account), never an error.
        if (row.slot === active) {
          await this.credentials.save(userId, "claude", data);
          await this.pool.query("UPDATE claude_accounts SET account_uuid = $3, plan = COALESCE($4, plan), status = 'connected', fail_count = 0, next_attempt_at = NULL WHERE user_id = $1 AND slot = $2", [userId, row.slot, uuid, plan]);
          this.onActiveChanged(userId, data, row.slot);
        } else {
          await this.pool.query(
            "UPDATE claude_accounts SET account_uuid = $3, plan = COALESCE($4, plan), data_enc = $5, expires_at = $6, status = 'connected', fail_count = 0, next_attempt_at = NULL WHERE user_id = $1 AND slot = $2",
            [userId, row.slot, uuid, plan, encryptSecret(this.config.encryptionKey, JSON.stringify(data), this.aad(userId, row.slot)), expires ? new Date(expires) : null],
          );
        }
        this.usageCache.delete(userId + ":" + row.slot);
        log.info("claude_accounts.renewed", { userId, slot: row.slot });
        return { slot: row.slot, label: row.label, plan: plan ?? row.plan, active: row.slot === active, status: "connected" as const };
      }
      if (rows.length >= 8) throw badRequest("At most 8 Claude accounts can be connected", "too_many_accounts");
      const slot = "acct_" + randomBytes(4).toString("hex");
      const label = this.cleanLabel(labelInput) ?? "Account " + (rows.length + 1);
      await this.pool.query(
        "INSERT INTO claude_accounts (user_id, slot, label, account_uuid, plan, data_enc, expires_at, position) VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(position), COUNT(*) - 1) + 1 FROM claude_accounts WHERE user_id = $1))",
        [userId, slot, label, uuid, plan, encryptSecret(this.config.encryptionKey, JSON.stringify(data), this.aad(userId, slot)), expires ? new Date(expires) : null],
      );
      log.info("claude_accounts.added", { userId, slot });
      return { slot, label, plan, active: false, status: "connected" as const };
    });
  }

  private cleanLabel(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const label = value.trim().replace(/\s+/g, " ");
    if (!label) return null;
    if ([...label].length > 40 || /[\u0000-\u001f\u007f<>]/.test(label)) throw badRequest("Label must be 40 characters or fewer, without control characters");
    return label;
  }

  async rename(userId: string, slot: string, label: unknown): Promise<void> {
    const clean = this.cleanLabel(label);
    if (!clean) throw badRequest("label is required");
    if (!SLOT.test(slot)) throw notFound("Account not found");
    const done = await this.pool.query("UPDATE claude_accounts SET label = $3 WHERE user_id = $1 AND slot = $2", [userId, slot, clean]);
    if (!done.rowCount) throw notFound("Account not found");
  }

  /**
   * Make `slot` the active login: its credential becomes provider_credentials(claude) and the previous active credential
   * moves to its own slot row, in one transaction (nothing is lost on a crash). Idempotent when it is already active.
   */
  async switchTo(userId: string, slot: string): Promise<{ from: string; to: string; changed: boolean }> {
    // A credential the CLI rotated in the sandbox file is adopted first (outside the chain: adopting may need it).
    if (SLOT.test(slot) && this.beforeSwitch) await this.beforeSwitch(userId).catch((error) => log.warn("claude_accounts.pre_switch_sync_failed", { userId, reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
    return this.serial(userId, async () => {
      if (!SLOT.test(slot)) throw notFound("Account not found");
      await this.ensureActiveMeta(userId);
      const from = await this.activeSlot(userId);
      if (from === slot) return { from, to: slot, changed: false };
      let row = (await this.rows(userId)).find((r) => r.slot === slot);
      if (!row || row.status !== "connected" || !row.data_enc) throw notFound("Account not found or not connected");
      let target = this.decryptRow(userId, row);
      if (!target) {
        await this.pool.query("UPDATE claude_accounts SET status = 'disconnected' WHERE user_id = $1 AND slot = $2", [userId, slot]);
        throw conflict("That Claude account needs to be signed in again", "account_signin_required");
      }
      // A reserve access token may have expired: renew it before it becomes the active one, so a dead login never replaces a working one.
      // The rotated refresh token is persisted right away (compare-and-set on the stored ciphertext), before anything else can fail.
      if ((expiryOf("claude", target) ?? 0) - Date.now() < 5 * 60_000) {
        try {
          const fresh = await this.credentials.refreshData("claude", target);
          const expires = expiryOf("claude", fresh);
          const saved = await this.pool.query(
            "UPDATE claude_accounts SET data_enc = $3, expires_at = $4 WHERE user_id = $1 AND slot = $2 AND data_enc = $5",
            [userId, slot, encryptSecret(this.config.encryptionKey, JSON.stringify(fresh), this.aad(userId, slot)), expires ? new Date(expires) : null, row.data_enc],
          );
          if (!saved.rowCount) throw conflict("That Claude account changed while switching; try again", "account_changed");
          target = fresh;
        } catch (error) {
          if (error instanceof RefreshFailure && error.permanent) await this.pool.query("UPDATE claude_accounts SET status = 'disconnected' WHERE user_id = $1 AND slot = $2", [userId, slot]);
          if (error instanceof RefreshFailure) throw conflict("That Claude account needs to be signed in again", "account_signin_required");
          throw error;
        }
      }
      let activated: CredentialData = target;
      await this.transaction(userId, async (db) => {
        // The same lock the credential broker takes for a refresh: no refresh runs between reading and replacing the active credential.
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["cred:" + userId + ":claude"]);
        const current = await this.credentials.get(userId, "claude", db);
        if (!current) throw conflict("Claude is not connected", "not_connected");
        const expires = expiryOf("claude", current);
        await db.query("UPDATE claude_accounts SET data_enc = $3, expires_at = $4 WHERE user_id = $1 AND slot = $2", [userId, from, encryptSecret(this.config.encryptionKey, JSON.stringify(current), this.aad(userId, from)), expires ? new Date(expires) : null]);
        await this.credentials.save(userId, "claude", activated, db);
        await db.query("UPDATE claude_accounts SET data_enc = NULL, expires_at = NULL, fail_count = 0, next_attempt_at = NULL WHERE user_id = $1 AND slot = $2", [userId, slot]);
        await db.query("INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
        await db.query("UPDATE user_settings SET active_claude_slot = $2, active_claude_since = now() WHERE user_id = $1", [userId, slot]);
      });
      this.usageCache.delete(userId + ":" + from);
      this.usageCache.delete(userId + ":" + slot);
      log.info("claude_accounts.switched", { userId, from, to: slot });
      this.onActiveChanged(userId, activated, slot);
      return { from, to: slot, changed: true };
    });
  }

  /**
   * Disconnect one login, whichever it is. The one in use is first replaced by the next connected account in the order.
   * Returns "last" without changing anything when it is the only account: the caller signs Claude out entirely.
   */
  async remove(userId: string, slot: string): Promise<"removed" | "last"> {
    if (!SLOT.test(slot)) throw notFound("Account not found");
    await this.ensureActiveMeta(userId);
    const rows = await this.rows(userId);
    if (!rows.some((r) => r.slot === slot)) throw notFound("Account not found");
    if (rows.length <= 1) return "last";
    if ((await this.activeSlot(userId)) === slot) {
      const next = rows.find((r) => r.slot !== slot && r.status === "connected" && r.data_enc);
      if (!next) throw conflict("No other connected account can take over. Sign in to another account first, or sign Claude out.", "no_other_account");
      await this.switchTo(userId, next.slot);
    }
    await this.serial(userId, async () => {
      const done = await this.pool.query("DELETE FROM claude_accounts WHERE user_id = $1 AND slot = $2", [userId, slot]);
      if (!done.rowCount) throw notFound("Account not found");
    });
    this.usageCache.delete(userId + ":" + slot);
    log.info("claude_accounts.removed", { userId, slot });
    return "removed";
  }

  /** The normal Claude disconnect removed the active login: forget every extra slot too, back to a single-account state. */
  async reset(userId: string): Promise<void> {
    await this.transaction(userId, async (db) => {
      await db.query("DELETE FROM claude_accounts WHERE user_id = $1", [userId]);
      await db.query("UPDATE user_settings SET active_claude_slot = 'primary', active_claude_since = NULL, claude_account_return = NULL WHERE user_id = $1", [userId]);
    });
    this.onReset?.(userId);
  }

  /**
   * syncBack attribution: a CLI rewrote the credentials file. With extra accounts, only adopt it into the slot whose profile
   * account uuid matches (a late refresh of account A written after the file switched to B must not overwrite B).
   * "single": one account only, the caller keeps the old behaviour. "active": adopt into provider_credentials.
   * "reserve": stored in that slot's row here. "unmatched": nothing is adopted.
   */
  async adoptAttributed(userId: string, data: CredentialData): Promise<AdoptResult> {
    if (!validCredential("claude", data)) return "unmatched";
    const rows = await this.rows(userId);
    if (rows.length <= 1) return "single";
    const active = await this.activeSlot(userId);
    // The same refresh token as the stored active login (an access-token-only refresh): no profile call needed.
    const storedActive = await this.credentials.get(userId, "claude");
    if (storedActive && typeof storedActive.refreshToken === "string" && storedActive.refreshToken === data.refreshToken) return "active";
    const profile = await this.fetchProfile(String(data.accessToken));
    if (!profile?.accountUuid) {
      // Never drop a rotated refresh token because the profile endpoint is down: the caller looks at the file again later.
      log.warn("credentials.adopt_deferred", { userId, reason: "profile_unavailable" });
      return "retry";
    }
    const activeRow = rows.find((r) => r.slot === active);
    if (activeRow && (await this.uuidOf(userId, activeRow, active)) === profile.accountUuid) return "active";
    for (const row of rows) {
      if (row.slot === active || (await this.uuidOf(userId, row, active)) !== profile.accountUuid) continue;
      return this.serial(userId, async () => {
        // The account became the active one in the meantime: its credential belongs in provider_credentials.
        if ((await this.activeSlot(userId)) === row.slot) return "active" as const;
        const stored = (await this.rows(userId)).find((r) => r.slot === row.slot);
        const current = stored ? this.decryptRow(userId, stored) : null;
        if (!stored || !current || (expiryOf("claude", data) ?? 0) <= (expiryOf("claude", current) ?? 0)) return "reserve" as const;
        const expires = expiryOf("claude", data);
        await this.pool.query("UPDATE claude_accounts SET data_enc = $3, expires_at = $4 WHERE user_id = $1 AND slot = $2", [userId, row.slot, encryptSecret(this.config.encryptionKey, JSON.stringify(data), this.aad(userId, row.slot)), expires ? new Date(expires) : null]);
        log.info("credentials.adopted_reserve", { userId, slot: row.slot });
        return "reserve" as const;
      });
    }
    log.warn("credentials.adopt_unmatched", { userId, reason: "no_slot_for_account" });
    return "unmatched";
  }

  /** Usage windows of one slot (cached for a minute), or null when unknown. */
  async usageOf(userId: string, slot: string): Promise<UsageWindow[] | null> {
    if (!this.fetchUsage || !SLOT.test(slot)) return null;
    const key = userId + ":" + slot;
    const hit = this.usageCache.get(key);
    if (hit && (Date.now() - hit.at < USAGE_CACHE_MS || Date.now() < hit.backoffUntil)) return hit.windows;
    const active = await this.activeSlot(userId);
    let data: CredentialData | null;
    if (slot === active) data = await this.credentials.get(userId, "claude");
    else {
      const row = (await this.rows(userId)).find((r) => r.slot === slot);
      data = row && row.status === "connected" ? this.decryptRow(userId, row) : null;
    }
    if (!data) return null;
    try {
      const windows = await this.fetchUsage(data);
      this.usageCache.set(key, { at: Date.now(), windows, backoffUntil: 0 });
      return windows;
    } catch (error) {
      // Serve the last known value and stop asking for a while: hammering a 429 only extends the rate limit.
      const last = hit?.windows ?? null;
      this.usageCache.set(key, { at: hit?.at ?? 0, windows: last, backoffUntil: Date.now() + USAGE_BACKOFF_MS });
      log.warn("claude_accounts.usage_failed", { userId, slot, reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
      return last;
    }
  }

  /** Keep reserve logins alive: refresh the ones close to expiry (an unused refresh token would otherwise lapse). */
  async tick(): Promise<void> {
    const due = (await this.pool.query(
      "SELECT user_id, slot FROM claude_accounts WHERE data_enc IS NOT NULL AND status = 'connected' AND expires_at IS NOT NULL AND expires_at < $1 AND (next_attempt_at IS NULL OR next_attempt_at <= now())",
      [new Date(Date.now() + REFRESH_BEFORE_MS)],
    )).rows as Array<{ user_id: string; slot: string }>;
    for (const { user_id: userId, slot } of due) {
      await this.serial(userId, async () => {
        const row = (await this.rows(userId)).find((r) => r.slot === slot);
        const data = row ? this.decryptRow(userId, row) : null;
        if (!row || !data) return;
        try {
          const fresh = await this.credentials.refreshData("claude", data);
          const expires = expiryOf("claude", fresh);
          await this.pool.query("UPDATE claude_accounts SET data_enc = $3, expires_at = $4, fail_count = 0, next_attempt_at = NULL WHERE user_id = $1 AND slot = $2 AND data_enc IS NOT NULL", [userId, slot, encryptSecret(this.config.encryptionKey, JSON.stringify(fresh), this.aad(userId, slot)), expires ? new Date(expires) : null]);
        } catch (error) {
          const permanent = error instanceof RefreshFailure && error.permanent;
          const attempts = Number(row.fail_count) + 1;
          await this.pool.query("UPDATE claude_accounts SET status = $3, fail_count = $4, next_attempt_at = $5 WHERE user_id = $1 AND slot = $2", [userId, slot, permanent ? "disconnected" : "connected", attempts, new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** (attempts - 1)))]);
          log.warn("claude_accounts.refresh_failed", { userId, slot, permanent });
        }
      }).catch(() => undefined);
    }
  }
}
