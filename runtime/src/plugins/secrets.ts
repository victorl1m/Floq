import type pg from "pg";
import { decryptSecret, deriveKey, encryptSecret } from "../crypto.js";
import { HttpError } from "../errors.js";

/** Owner id of an install-scoped secret: the installation owns it, not the admin who enabled the plugin. */
export const INSTALL_OWNER = "*install*";
export const MAX_PLUGIN_SECRET_BYTES = 8192;
const KEY_INFO = "plugin-secrets/v1";
/** Audit retention: rows older than this are deleted, and no plugin keeps more than the cap (the oldest go first). */
export const AUDIT_RETENTION_DAYS = 90;
export const AUDIT_CAP_PER_PLUGIN = 5000;
/** A `resolve` (a plugin reading its own secret, e.g. on every task-source poll) is audited at most once per key per interval. */
export const RESOLVE_AUDIT_EVERY_MS = 60_000;
const PRUNE_EVERY_WRITES = 200;
const PRUNE_EVERY_MS = 60 * 60_000;

type Pool = Pick<pg.Pool, "query" | "connect">;

export interface PluginSecretStatus { name: string; present: boolean; updatedAt: string | null }

export interface PluginSecretsOptions {
  now?: () => number;
  retentionDays?: number;
  capPerPlugin?: number;
  resolveAuditEveryMs?: number;
}

/** AAD binds a ciphertext to its plugin, owner and name: a row copied anywhere else (or from the vault) fails to decrypt. */
export const pluginSecretAad = (pluginId: string, ownerId: string, name: string) => "plugin-secret:v1:" + pluginId + ":" + ownerId + ":" + name;

/**
 * The plugin-only secret store. It never shares a table, key or API with the vault. Values are write-only toward the outside:
 * `resolve` is for host code (ctx.secrets) only. Audit rows hold plugin, owner, name, action and actor, never a value.
 */
export class PluginSecrets {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly lastResolveAudit = new Map<string, number>();
  private writesSincePrune = 0;
  private lastPrune = 0;
  /** `declared(pluginId)` returns the manifest secret names of a plugin (empty for an unknown one). */
  constructor(private readonly pool: Pool, masterKey: Buffer, private readonly declared: (pluginId: string) => string[], private readonly options: PluginSecretsOptions = {}) {
    this.key = deriveKey(masterKey, KEY_INFO);
    this.now = options.now ?? Date.now;
  }

  /**
   * Deletes audit rows past the retention window, then trims any plugin above the cap (oldest first). Safe to call any time; returns how many
   * rows went. Runs at boot and, in the background, after enough writes or an hour (see `audit`).
   */
  async pruneAudit(): Promise<number> {
    const days = this.options.retentionDays ?? AUDIT_RETENTION_DAYS;
    const cap = this.options.capPerPlugin ?? AUDIT_CAP_PER_PLUGIN;
    let removed = (await this.pool.query("DELETE FROM plugin_secret_audit WHERE at < now() - ($1::int * interval '1 day')", [days])).rowCount ?? 0;
    const over = (await this.pool.query("SELECT plugin_id FROM plugin_secret_audit GROUP BY plugin_id HAVING count(*) > $1", [cap])).rows as { plugin_id: string }[];
    for (const { plugin_id } of over) {
      removed += (await this.pool.query(
        "DELETE FROM plugin_secret_audit WHERE plugin_id = $1 AND id <= (SELECT id FROM plugin_secret_audit WHERE plugin_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)", [plugin_id, cap])).rowCount ?? 0;
    }
    this.lastPrune = this.now();
    this.writesSincePrune = 0;
    return removed;
  }

  private requireDeclared(pluginId: string, name: string): void {
    if (!this.declared(pluginId).includes(name)) throw new HttpError(404, "unknown_secret", "The plugin does not declare a secret named " + JSON.stringify(String(name).slice(0, 64)) + ".");
  }

  /** Validation errors never echo the value. */
  static validateValue(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "invalid_secret", "value must be a non-empty string");
    if (value.includes("\u0000")) throw new HttpError(400, "invalid_secret", "value must not contain NUL characters");
    if (Buffer.byteLength(value) > MAX_PLUGIN_SECRET_BYTES) throw new HttpError(400, "invalid_secret", "value is too large (max 8 KiB)");
    return value;
  }

  private async audit(pluginId: string, ownerId: string, name: string, action: string, actor: string | null): Promise<void> {
    if (action === "resolve") {
      // Reads are sampled: polling a task source would otherwise write a row per request. set/remove are always recorded.
      const key = pluginId + "\0" + ownerId + "\0" + name;
      const now = this.now();
      const last = this.lastResolveAudit.get(key);
      if (last !== undefined && now - last < (this.options.resolveAuditEveryMs ?? RESOLVE_AUDIT_EVERY_MS)) return;
      if (this.lastResolveAudit.size > 10_000) this.lastResolveAudit.clear();
      this.lastResolveAudit.set(key, now);
    }
    await this.pool.query("INSERT INTO plugin_secret_audit (plugin_id, owner_id, name, action, actor) VALUES ($1,$2,$3,$4,$5)", [pluginId, ownerId, name, action, actor]).catch(() => undefined);
    if (++this.writesSincePrune >= PRUNE_EVERY_WRITES || (this.lastPrune !== 0 && this.now() - this.lastPrune >= PRUNE_EVERY_MS)) void this.pruneAudit().catch(() => undefined);
  }

  /** Presence of every declared name for one owner. */
  async status(pluginId: string, ownerId: string): Promise<PluginSecretStatus[]> {
    const names = this.declared(pluginId);
    if (!names.length) return [];
    const rows = (await this.pool.query("SELECT name, updated_at FROM plugin_secrets WHERE plugin_id = $1 AND owner_id = $2 AND name = ANY($3)", [pluginId, ownerId, names])).rows as { name: string; updated_at: string | Date }[];
    const found = new Map(rows.map((r) => [r.name, new Date(r.updated_at).toISOString()]));
    return names.map((name) => ({ name, present: found.has(name), updatedAt: found.get(name) ?? null }));
  }

  async set(pluginId: string, ownerId: string, name: string, value: string, actor: string | null): Promise<void> {
    this.requireDeclared(pluginId, name);
    PluginSecrets.validateValue(value);
    const enc = encryptSecret(this.key, value, pluginSecretAad(pluginId, ownerId, name));
    await this.pool.query(
      `INSERT INTO plugin_secrets (plugin_id, owner_id, name, value_enc, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (plugin_id, owner_id, name) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [pluginId, ownerId, name, enc, actor]);
    await this.audit(pluginId, ownerId, name, "set", actor);
  }

  /** Idempotent: removing a missing secret succeeds. */
  async remove(pluginId: string, ownerId: string, name: string, actor: string | null): Promise<void> {
    this.requireDeclared(pluginId, name);
    const r = await this.pool.query("DELETE FROM plugin_secrets WHERE plugin_id = $1 AND owner_id = $2 AND name = $3", [pluginId, ownerId, name]);
    if (r.rowCount) await this.audit(pluginId, ownerId, name, "remove", actor);
  }

  /** "Delete data" of a plugin: every owner's secrets and its audit trail. */
  async purgePlugin(pluginId: string): Promise<void> {
    await this.pool.query("DELETE FROM plugin_secrets WHERE plugin_id = $1", [pluginId]);
    await this.pool.query("DELETE FROM plugin_secret_audit WHERE plugin_id = $1", [pluginId]);
    await this.pool.query("DELETE FROM plugin_secret_migrations WHERE plugin_id = $1", [pluginId]);
  }

  /** Host-internal. Returns undefined when unset. A row that does not decrypt (tampered or moved) is treated as an error, never as a value. */
  async resolve(pluginId: string, ownerId: string, name: string): Promise<string | undefined> {
    this.requireDeclared(pluginId, name);
    const row = (await this.pool.query("SELECT value_enc FROM plugin_secrets WHERE plugin_id = $1 AND owner_id = $2 AND name = $3", [pluginId, ownerId, name])).rows[0] as { value_enc: string } | undefined;
    if (!row) return undefined;
    let value: string;
    try { value = decryptSecret(this.key, row.value_enc, pluginSecretAad(pluginId, ownerId, name)); }
    catch { throw new Error("plugin secret " + JSON.stringify(name) + " could not be decrypted"); }
    await this.audit(pluginId, ownerId, name, "resolve", ownerId === INSTALL_OWNER ? null : ownerId);
    return value;
  }

  /** Migration helper: reads without the declared-name check or an audit row. Never exposed through any route. */
  async resolveForMigration(pluginId: string, ownerId: string, name: string): Promise<string | undefined> {
    const row = (await this.pool.query("SELECT value_enc FROM plugin_secrets WHERE plugin_id = $1 AND owner_id = $2 AND name = $3", [pluginId, ownerId, name])).rows[0] as { value_enc: string } | undefined;
    return row ? decryptSecret(this.key, row.value_enc, pluginSecretAad(pluginId, ownerId, name)) : undefined;
  }

  /** Migration helper: stores an already-decrypted value with the plugin key (no declared-name check; the caller iterates the manifest). */
  async insertIfAbsent(client: Pick<pg.PoolClient, "query">, pluginId: string, ownerId: string, name: string, value: string): Promise<boolean> {
    const enc = encryptSecret(this.key, value, pluginSecretAad(pluginId, ownerId, name));
    const r = await client.query("INSERT INTO plugin_secrets (plugin_id, owner_id, name, value_enc) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [pluginId, ownerId, name, enc]);
    return Boolean(r.rowCount);
  }
}
