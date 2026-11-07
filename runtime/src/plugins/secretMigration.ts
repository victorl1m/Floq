import type pg from "pg";
import { decryptSecret } from "../crypto.js";
import { INSTALL_OWNER, type PluginSecrets } from "./secrets.js";

type Pool = Pick<pg.Pool, "query" | "connect">;

/** The user's global MCP entries that reference `${vault:NAME}` secrets, or null when their configs cannot be read now. */
export type VaultReferences = (userId: string) => Promise<{ entry: string; secretNames: string[] }[] | null>;

export interface MigrationPlugin { id: string; scope: "user" | "install"; secrets: string[] }

export interface MigrationInput {
  pool: Pool;
  secrets: PluginSecrets;
  /** The runtime master key: the vault rows were encrypted with it directly (AAD `userId:vault:NAME`). */
  masterKey: Buffer;
  plugins: MigrationPlugin[];
  /** Restrict the run to one user's credentials (the lazy retry when that user's configs become readable). Omitted at boot: everyone. */
  onlyUser?: string;
  references: VaultReferences;
  /** Removes one MCP entry (both providers) from the user's global configs. Failures are ignored by the caller. */
  removeMcp?: (userId: string, entry: string) => Promise<unknown>;
  /** Logs `plugin.secret_migration_failed` style events: plugin id and secret name only, never a value. */
  log: (event: string, fields: Record<string, unknown>) => void;
}

const vaultAad = (userId: string, name: string) => userId + ":vault:" + name;

interface Item { plugin: MigrationPlugin; source: string; target: string; name: string }

/**
 * Moves plugin credentials out of the vault into the plugin store, once per (plugin, owner, name) (ledger: plugin_secret_migrations).
 * The vault row is deleted only when no other plugin still has to migrate the same name for that user and no non-plugin MCP entry
 * references `${vault:NAME}`; otherwise it is kept and the ledger says so. A failure rolls the user's transaction back (both rows stay)
 * and is retried on the next boot (or lazily, see `onlyUser`). Old `plugin-<id>-*` MCP entries that used vault wrappers for a moved secret are removed.
 * Returns true while something is still pending (a failed user, or a vault copy kept because the configs were unreadable or reference it):
 * the caller keeps retrying lazily until it returns false.
 */
export async function migrateVaultSecrets(input: MigrationInput): Promise<boolean> {
  const { pool, plugins } = input;
  let failed = false;
  const items: Item[] = [];
  const done = new Set(((await pool.query("SELECT plugin_id, owner_id, name FROM plugin_secret_migrations")).rows as { plugin_id: string; owner_id: string; name: string }[]).map((r) => `${r.plugin_id}\0${r.owner_id}\0${r.name}`));

  for (const plugin of plugins) {
    let sources: string[] = [];
    if (plugin.scope === "install") {
      const owner = (await pool.query("SELECT config_owner FROM floq_plugins WHERE id = $1", [plugin.id])).rows[0]?.config_owner as string | null | undefined;
      if (owner) sources = [owner];
    } else {
      const set = new Set<string>(((await pool.query("SELECT user_id FROM floq_plugin_user_settings WHERE plugin_id = $1", [plugin.id])).rows as { user_id: string }[]).map((r) => r.user_id));
      try { for (const r of (await pool.query("SELECT DISTINCT user_id FROM vault_audit WHERE session_id = $1", ["plugin:" + plugin.id])).rows as { user_id: string }[]) set.add(r.user_id); } catch { /* table absent */ }
      sources = [...set];
    }
    for (const source of sources) for (const name of plugin.secrets) {
      if (input.onlyUser && source !== input.onlyUser) continue;
      const target = plugin.scope === "install" ? INSTALL_OWNER : source;
      if (!done.has(`${plugin.id}\0${target}\0${name}`)) items.push({ plugin, source, target, name });
    }
  }

  const refCache = new Map<string, Awaited<ReturnType<VaultReferences>>>();
  const refs = async (userId: string) => {
    if (!refCache.has(userId)) refCache.set(userId, await input.references(userId).catch(() => null));
    return refCache.get(userId)!;
  };
  const byUser = new Map<string, Item[]>();
  for (const it of items) byUser.set(it.source, [...(byUser.get(it.source) ?? []), it]);

  for (const [userId, list] of byUser) {
    const movedPlugins = new Map<string, Set<string>>();
    const client = await pool.connect();
    let current: Item | undefined;
    try {
      await client.query("BEGIN");
      const byName = new Map<string, Item[]>();
      for (const it of list) byName.set(it.name, [...(byName.get(it.name) ?? []), it]);
      const toDelete: string[] = [];
      for (const [name, group] of byName) {
        const row = (await client.query("SELECT value_enc FROM vault_secrets WHERE user_id = $1 AND name = $2", [userId, name])).rows[0] as { value_enc: string } | undefined;
        if (!row) continue; // nothing in the vault for this user: nothing to move (and no ledger row)
        current = group[0];
        const value = decryptSecret(input.masterKey, row.value_enc, vaultAad(userId, name));
        const references = await refs(userId);
        const referenced = references === null || references.some((x) => !x.entry.startsWith("plugin-") && x.secretNames.includes(name));
        for (const it of group) {
          current = it;
          await input.secrets.insertIfAbsent(client, it.plugin.id, it.target, name, value);
          await client.query("INSERT INTO plugin_secret_migrations (plugin_id, owner_id, name, kept_in_vault) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [it.plugin.id, it.target, name, referenced]);
          movedPlugins.set(it.plugin.id, (movedPlugins.get(it.plugin.id) ?? new Set()).add(name));
        }
        if (!referenced) toDelete.push(name);
      }
      for (const name of toDelete) await client.query("DELETE FROM vault_secrets WHERE user_id = $1 AND name = $2", [userId, name]);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      failed = true;
      input.log("plugin.secret_migration_failed", { plugin: current?.plugin.id, secret: current?.name });
      movedPlugins.clear();
    } finally {
      client.release();
    }
    // Old vault-wrapper entries of a moved secret: the secret no longer exists in the vault for them.
    if (input.removeMcp && movedPlugins.size) {
      const references = await refs(userId);
      for (const x of references ?? []) {
        for (const [pluginId, names] of movedPlugins) {
          if (x.entry.startsWith("plugin-" + pluginId + "-") && x.secretNames.some((n) => names.has(n))) await input.removeMcp(userId, x.entry).catch(() => undefined);
        }
      }
    }
  }

  const stillKept = await retryKept(input, refs);
  return failed || stillKept > 0;
}

/**
 * A kept copy is removed once the user's MCP configs can be read and no longer reference it, but only if the vault value still equals the
 * moved one. Returns how many kept copies (in scope) are still waiting.
 */
async function retryKept(input: MigrationInput, refs: (userId: string) => Promise<Awaited<ReturnType<VaultReferences>>>): Promise<number> {
  const { pool } = input;
  let waiting = 0;
  const kept = (await pool.query("SELECT plugin_id, owner_id, name FROM plugin_secret_migrations WHERE kept_in_vault")).rows as { plugin_id: string; owner_id: string; name: string }[];
  for (const k of kept) {
    try {
      const user = k.owner_id === INSTALL_OWNER ? (await pool.query("SELECT config_owner FROM floq_plugins WHERE id = $1", [k.plugin_id])).rows[0]?.config_owner as string | null | undefined : k.owner_id;
      if (!user || (input.onlyUser && user !== input.onlyUser)) continue;
      const row = (await pool.query("SELECT value_enc FROM vault_secrets WHERE user_id = $1 AND name = $2", [user, k.name])).rows[0] as { value_enc: string } | undefined;
      if (row) {
        const references = await refs(user);
        if (references === null || references.some((x) => !x.entry.startsWith("plugin-") && x.secretNames.includes(k.name))) { waiting++; continue; }
        const moved = await input.secrets.resolveForMigration(k.plugin_id, k.owner_id, k.name);
        if (moved === undefined || moved !== decryptSecret(input.masterKey, row.value_enc, vaultAad(user, k.name))) { waiting++; continue; }
        await pool.query("DELETE FROM vault_secrets WHERE user_id = $1 AND name = $2", [user, k.name]);
      }
      await pool.query("UPDATE plugin_secret_migrations SET kept_in_vault = FALSE WHERE plugin_id = $1 AND owner_id = $2 AND name = $3", [k.plugin_id, k.owner_id, k.name]);
    } catch {
      waiting++;
      input.log("plugin.secret_migration_failed", { plugin: k.plugin_id, secret: k.name });
    }
  }
  return waiting;
}
