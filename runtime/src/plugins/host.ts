import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type pg from "pg";
import { HttpError, badRequest, conflict, notFound } from "../errors.js";
import { log } from "../logger.js";
import { VAULT_NAME } from "../mcpConfig.js";
import { INSTALL_OWNER, PluginSecrets } from "./secrets.js";
import { migrateVaultSecrets, type VaultReferences } from "./secretMigration.js";
import { PluginEvents } from "./events.js";
import { TaskSourceRegistry } from "./taskSources.js";
import { buildContext, expandSql, matchRoute, type BuiltContext, type ContextDeps } from "./context.js";
import { ManifestError, parseManifest } from "./manifest.js";
import type { PluginDefinition, PluginManifest, PluginMcpServerDecl, PluginSettingDecl } from "./sdk.js";

export type PluginStatus = "available" | "enabled" | "disabled" | "failed" | "invalid";
export const MAX_START_ATTEMPTS = 3;
/** Written into every skill copy a plugin installs, so removal never touches a skill the user already had under the same name. */
export const PLUGIN_MARKER = ".floq-plugin";
export const WEBHOOK_MAX_BYTES = 256 * 1024;
export const WEBHOOK_RATE_MAX = 60;
export const WEBHOOK_RATE_WINDOW_MS = 60_000;
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

type Pool = Pick<pg.Pool, "query" | "connect">;

/** The host does not know how configs are written: the server hands it the same installer the Skills & MCP page uses. */
export interface PluginMcpPort {
  install(userId: string, body: Record<string, unknown>): Promise<unknown>;
  remove(userId: string, name: string, provider: "claude" | "codex"): Promise<unknown>;
  /** Names of the user's global MCP entries (not plugin-installed) that reference `${vault:NAME}` secrets, or null when the configs cannot be read now. Used by the one-time secret migration. */
  vaultReferences?(userId: string): Promise<{ entry: string; secretNames: string[] }[] | null>;
}
/**
 * `setPluginSkills` lists the folders read-only in the bundled scope. `installSkill` / `removeSkill` put them into (and take them out of)
 * a user's own agent home, which is where agents actually load skills from. Optional so tests can stub only what they need.
 */
export interface PluginSkillsPort {
  setPluginSkills(pluginId: string, root: string | null, names?: string[]): void;
  installSkill?(userId: string, name: string, files: Record<string, string>): Promise<unknown>;
  /** Must only delete a copy this plugin installed (see `PLUGIN_MARKER`). */
  removeSkill?(userId: string, name: string, pluginId: string): Promise<unknown>;
}

/** Text files of a plugin skill folder (`<dir>/skills/<name>/**`), as the package `addSkillPackage` expects. Binary and oversized files are skipped. */
export function readSkillFolder(dir: string, name: string): Record<string, string> {
  const root = join(dir, "skills", name);
  const files: Record<string, string> = {};
  const walk = (rel: string, depth: number) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (Object.keys(files).length >= 100) return;
      const next = rel ? posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) { if (depth < 4) walk(next, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const full = join(root, next);
      if (statSync(full).size > 60 * 1024) continue;
      const text = readFileSync(full, "utf8");
      if (!text.includes("\u0000")) files[next] = text;
    }
  };
  walk("", 0);
  return files;
}

/** Name under which a plugin's MCP server is installed; removal only ever targets names derived this way. */
export const mcpEntryName = (pluginId: string, name: string) => `plugin-${pluginId}-${name}`;

/**
 * Body for `installMcp`. Plugin MCP servers carry no secrets (the manifest validator rejects envSecrets/headerSecrets), so nothing here is a
 * secret reference. Follow-up: a runtime-side plugin MCP gateway will serve secret-bearing capability without values entering the sandbox.
 */
export function mcpInstallBody(pluginId: string, decl: PluginMcpServerDecl): Record<string, unknown> {
  const server: Record<string, unknown> = { type: decl.type };
  if (decl.type === "stdio") { server.command = decl.command; server.args = decl.args ?? []; server.env = { ...(decl.env ?? {}) }; }
  else { server.url = decl.url; server.headers = { ...(decl.headers ?? {}) }; }
  return { scope: "global", providers: "both", name: mcpEntryName(pluginId, decl.name), server };
}

export interface PluginHostOptions {
  plugins: PluginDefinition[];
  /** The runtime master key (config.encryptionKey). The plugin store derives its own subkey; the vault is never touched except by the one-time migration. */
  encryptionKey: Buffer;
  /** "schema": each plugin gets schema plugin_<id>. "prefix": tables in the default schema prefixed plugin_<id>__ (when CREATE SCHEMA is not allowed). */
  storage?: "schema" | "prefix";
  fetchImpl?: ContextDeps["fetchImpl"];
  now?: () => number;
  /** Waits between start attempts (default 1 s, 5 s). Tests pass [0, 0]. */
  retryDelaysMs?: number[];
  /** Minimum time between lazy credential-migration attempts for one user (default 60 s). Tests pass 0. */
  lazyMigrationIntervalMs?: number;
  sink?: ContextDeps["sink"];
}

interface Entry {
  def: PluginDefinition;
  id: string;
  manifest: PluginManifest | null;
  error?: string;
  status: PluginStatus;
  built?: BuiltContext;
  /** Tail of the enable/disable/load chain: lifecycle changes of one plugin never overlap. */
  chain: Promise<unknown>;
  /** Compiled into the runtime, or installed from a package (stored in the database). */
  source: "builtin" | "installed";
  /** UI half of an installed package, served at `/v1/plugins/:id/ui.js`. */
  ui?: { text: string; sha256: string };
}

export interface PublicPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  scope: "user" | "install";
  status: PluginStatus;
  /** Install-wide switch. */
  enabled: boolean;
  /** This user's switch (always true for install scope when enabled). */
  userEnabled: boolean;
  error?: string;
  /** "installed" plugins come from a package and can be updated or uninstalled by an admin. */
  source: "builtin" | "installed";
  /** Present when the plugin ships a UI bundle: the sha256 the app checks before loading it. */
  ui: { sha256: string } | null;
  secrets: { name: string; description?: string; required: boolean; present: boolean }[];
  settings: PluginSettingDecl[];
  contributes: Pick<PluginManifest["contributes"], "views" | "taskSources" | "rightSidebarTabs" | "settingsPanel">;
}

export interface HandleInput {
  userId: string;
  method: string;
  pathname: string;
  query: URLSearchParams;
  /** `limit` caps the body in bytes (default: the server's limit). */
  readBody: (limit?: number) => Promise<unknown>;
  requireAdmin: () => Promise<void>;
}
export interface HandleResult { status: number; body: unknown; /** A non-JSON response (the UI bundle). */ raw?: { contentType: string; text: string; headers?: Record<string, string> } }
export interface InternalInput { userId: string; sessionId: string; pluginId: string; path: string; body: unknown; signal?: AbortSignal }
export interface WebhookInput {
  pluginId: string; name: string; token: string; ip: string; query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** Called only after the token checked out; must throw HttpError 413 when the body exceeds `WEBHOOK_MAX_BYTES`. */
  readRaw: () => Promise<Buffer>;
}

const idOf = (id: string) => id.replace(/-/g, "_");
export const pluginSchema = (id: string) => "plugin_" + idOf(id);
export const pluginTablePrefix = (id: string) => "plugin_" + idOf(id) + "__";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PluginHost {
  private readonly log = (level: "warn" | "error", event: string, fields: Record<string, unknown>) => (this.opts.sink ? this.opts.sink(level, event, fields) : log[level](event, fields));
  private readonly entries = new Map<string, Entry>();
  private readonly storage: "schema" | "prefix";
  readonly taskSources: TaskSourceRegistry;
  readonly events = new PluginEvents();
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  readonly secrets: PluginSecrets;
  private mcp?: PluginMcpPort;
  private skills?: PluginSkillsPort;

  setMcp(port: PluginMcpPort): void { this.mcp = port; }
  setSkills(port: PluginSkillsPort): void { this.skills = port; }
  private migrationPort?: Pick<PluginMcpPort, "remove" | "vaultReferences">;
  /** The secret migration runs inside `load()`, before the server (and its `setMcp`) exists: boot code passes this narrower port first. */
  setSecretMigrationPort(port: NonNullable<PluginHost["migrationPort"]>): void { this.migrationPort = port; }
  private readonly lazyRuns = new Map<string, Promise<void>>();
  private readonly lazyLast = new Map<string, number>();
  private readonly lazySettled = new Set<string>();

  /**
   * Retry the credential migration for ONE user when something that needs it happens (listing plugins, the secrets list, enabling a plugin),
   * not only at boot: at boot the user's MCP configs are often unreadable (their workspace is asleep), which leaves the vault copy in place.
   * Single-flight and throttled per user; once nothing is pending the user is skipped until `force` (enabling a plugin can create new work).
   * Never throws and callers never wait on it for correctness (`void host.lazyMigrate(...)`).
   */
  async lazyMigrate(userId: string, force = false): Promise<void> {
    if (!this.migrationPort && !this.mcp) return;
    if (!force && this.lazySettled.has(userId)) return;
    const running = this.lazyRuns.get(userId);
    if (running) return running;
    const now = (this.opts.now ?? Date.now)();
    const last = this.lazyLast.get(userId);
    if (!force && last !== undefined && now - last < (this.opts.lazyMigrationIntervalMs ?? 60_000)) return;
    if (this.lazyLast.size > 10_000) this.lazyLast.clear();
    this.lazyLast.set(userId, now);
    const run = this.migrateSecrets(userId).then((pending) => { if (pending) this.lazySettled.delete(userId); else this.lazySettled.add(userId); }, () => undefined).finally(() => { this.lazyRuns.delete(userId); });
    this.lazyRuns.set(userId, run);
    return run;
  }
  private approvals?: ContextDeps["approvals"] extends (() => infer R) | undefined ? R : never;

  /** Called by the server once it has built Approvals. */
  setApprovals(approvals: NonNullable<typeof this.approvals>): void { this.approvals = approvals; }

  constructor(private readonly pool: Pool, private readonly opts: PluginHostOptions) {
    this.storage = opts.storage ?? "schema";
    this.secrets = new PluginSecrets(pool, opts.encryptionKey, (pluginId) => this.entries.get(pluginId)?.manifest?.secrets.map((x) => x.name) ?? [], { now: opts.now });
    this.taskSources = new TaskSourceRegistry(opts.now);
    for (const def of opts.plugins) this.register(def, "builtin");
  }

  /** Validates a definition and adds it to the registry (an invalid manifest or a duplicate id becomes an `invalid` entry). Does not start it. */
  private register(def: PluginDefinition, source: "builtin" | "installed", ui?: { text: string; sha256: string }): Entry {
    let manifest: PluginManifest | null = null;
    let error: string | undefined;
    let id = "";
    try { manifest = parseManifest(def.manifest); id = manifest.id; } catch (e) {
      error = e instanceof ManifestError ? e.message : "manifest could not be parsed";
      const raw = (def.manifest as { id?: unknown } | null)?.id;
      id = typeof raw === "string" && /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/.test(raw) && !this.entries.has(raw) ? raw : "invalid-" + (this.entries.size + 1);
    }
    if (this.entries.has(id)) { manifest = null; error = "duplicate plugin id"; id = "invalid-" + (this.entries.size + 1); }
    const entry: Entry = { def, id, manifest, error, status: manifest ? "available" : "invalid", chain: Promise.resolve(), source, ui };
    this.entries.set(id, entry);
    if (error) this.log("warn", "plugin.invalid", { plugin: id, error });
    return entry;
  }

  /** Boot: installed packages, before `load()`. A package that failed to load is listed as `invalid` with the reason, and the runtime goes on. */
  addInstalled(def: PluginDefinition, ui?: { text: string; sha256: string }): string { return this.register(def, "installed", ui).id; }
  addBroken(id: string, name: string, error: string): void {
    if (this.entries.has(id)) return;
    this.entries.set(id, { def: { manifest: { id } }, id, manifest: null, error, status: "invalid", chain: Promise.resolve(), source: "installed" });
    this.log("warn", "plugin.invalid", { plugin: id, error });
  }
  isBuiltin(id: string): boolean { return this.entries.get(id)?.source === "builtin"; }
  isInstalled(id: string): boolean { return this.entries.get(id)?.source === "installed"; }
  builtinIds(): string[] { return [...this.entries.values()].filter((e) => e.source === "builtin").map((e) => e.id); }

  /** Validate, register and restart enabled plugins. Never throws because of one plugin. */
  async load(): Promise<void> {
    const rows = await this.pool.query("SELECT id, enabled FROM floq_plugins");
    const enabled = new Set((rows.rows as { id: string; enabled: boolean }[]).filter((r) => r.enabled).map((r) => r.id));
    for (const e of this.entries.values()) await this.loadEntry(e, enabled);
    await this.migrateSecrets();
    await this.secrets.pruneAudit().catch((error) => this.log("error", "plugin.secret_audit_prune_failed", { error: msg(error).slice(0, 200) }));
  }

  /**
   * Move existing plugin credentials out of the vault (everyone at boot, or one user lazily). Never throws: a failure leaves the vault rows and is
   * retried on the next boot or lazy attempt. Resolves true while something is still pending.
   */
  private async migrateSecrets(onlyUser?: string): Promise<boolean> {
    try {
      const plugins = [...this.entries.values()].filter((e) => e.manifest && e.manifest.secrets.length).map((e) => ({ id: e.id, scope: e.manifest!.scope, secrets: e.manifest!.secrets.map((s) => s.name) }));
      if (!plugins.length) return false;
      const port = this.migrationPort ?? this.mcp;
      return await migrateVaultSecrets({
        pool: this.pool, secrets: this.secrets, masterKey: this.opts.encryptionKey, plugins, onlyUser,
        references: async (userId) => (await port?.vaultReferences?.(userId)) ?? null,
        removeMcp: async (userId, entry) => { for (const provider of ["claude", "codex"] as const) await port?.remove(userId, entry, provider).catch(() => undefined); },
        log: (event, fields) => this.log("error", event, fields),
      });
    } catch (error) {
      this.log("error", "plugin.secret_migration_failed", { error: msg(error).slice(0, 200) });
      return true;
    }
  }

  private async loadEntry(e: Entry, enabled: Set<string>): Promise<void> {
    if (!e.manifest) return;
    try {
      await this.pool.query(
        `INSERT INTO floq_plugins (id, version, status) VALUES ($1,$2,'available')
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`, [e.id, e.manifest.version]);
      if (!enabled.has(e.id)) { e.status = "disabled"; return; }
      await this.serialize(e, () => this.activate(e));
    } catch (error) {
      e.status = "failed";
      this.log("error", "plugin.load_failed", { plugin: e.id, error: msg(error) });
      // Boot keeps enabled=true: a transient outage must not switch the plugin off for good. It is retried on the next boot or enable.
      await this.persist(e, true, "failed").catch(() => undefined);
    }
  }

  // ---- installed packages (called by the installer) ----

  /** A freshly installed package: registered and left disabled until an admin turns it on. */
  async install(def: PluginDefinition, ui?: { text: string; sha256: string }): Promise<string> {
    const e = this.register(def, "installed", ui);
    if (!e.manifest) { this.entries.delete(e.id); throw new HttpError(409, "plugin_invalid", e.error ?? "The plugin is invalid."); }
    await this.loadEntry(e, new Set());
    return e.id;
  }

  /**
   * Swaps the code of an installed plugin: stops the old version, registers the new one and, if the plugin was on, starts it (running new
   * migrations). If the new version cannot start, the old definition is restored and started again, and the error is rethrown.
   */
  async replace(id: string, def: PluginDefinition, ui?: { text: string; sha256: string }): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.source !== "installed" || !e.manifest) throw new HttpError(404, "not_installed", "That plugin is not installed.");
    const next = parseManifest(def.manifest);
    if (next.id !== id) throw new HttpError(409, "plugin_invalid", "The new package has a different id.");
    return this.serialize(e, async () => {
      const wasOn = e.status === "enabled";
      const old = { def: e.def, manifest: e.manifest, ui: e.ui, status: e.status };
      if (wasOn) await this.deactivate(e);
      e.def = def; e.manifest = next; e.ui = ui; e.error = undefined; e.status = "disabled";
      try {
        await this.pool.query("UPDATE floq_plugins SET version = $2, updated_at = now() WHERE id = $1", [id, next.version]);
        if (wasOn) await this.activate(e);
      } catch (error) {
        await this.deactivate(e).catch(() => undefined);
        e.def = old.def; e.manifest = old.manifest; e.ui = old.ui; e.status = "disabled";
        await this.pool.query("UPDATE floq_plugins SET version = $2, updated_at = now() WHERE id = $1", [id, old.manifest!.version]).catch(() => undefined);
        if (wasOn) { try { await this.activate(e); } catch { e.status = "failed"; } }
        throw error;
      }
    });
  }

  /** Removes an installed plugin from the registry (after `disable`). Built-ins cannot be removed. */
  async removeDefinition(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.source !== "installed") throw new HttpError(409, "not_installed", "Only installed plugins can be uninstalled.");
    await this.serialize(e, async () => { if (e.status === "enabled") await this.doDisable(e); this.entries.delete(id); });
  }

  /**
   * "Delete data": drops the plugin's schema (or prefixed tables) and its settings, migration ledger and host row. Refused while the
   * plugin is running. The id is validated before it is used in any identifier.
   */
  async purgeData(id: string): Promise<void> {
    if (!/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/.test(id)) throw badRequest("Invalid plugin id", "invalid_id");
    const e = this.entries.get(id);
    if (e?.status === "enabled") throw conflict("Turn the plugin off before deleting its data.", "plugin_running");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (this.storage === "schema") await client.query(`DROP SCHEMA IF EXISTS "${pluginSchema(id)}" CASCADE`);
      else {
        const prefix = pluginTablePrefix(id);
        const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE $1", [prefix.replace(/_/g, "\\_") + "%"]);
        for (const t of tables.rows as { table_name: string }[]) if (t.table_name.startsWith(prefix) && /^[a-z0-9_]+$/.test(t.table_name)) await client.query(`DROP TABLE IF EXISTS "${t.table_name}" CASCADE`);
      }
      await client.query("DELETE FROM plugin_secrets WHERE plugin_id = $1", [id]);
      await client.query("DELETE FROM plugin_secret_audit WHERE plugin_id = $1", [id]);
      await client.query("DELETE FROM plugin_secret_migrations WHERE plugin_id = $1", [id]);
      await client.query("DELETE FROM floq_plugin_user_settings WHERE plugin_id = $1", [id]);
      await client.query("DELETE FROM floq_plugin_migrations WHERE plugin_id = $1", [id]);
      await client.query("DELETE FROM floq_plugins WHERE id = $1", [id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
    this.taskSources.invalidate(id);
  }

  private installer?: { catalog(): Promise<unknown>; install(id: string, adminUserId: string): Promise<unknown>; update(id: string): Promise<unknown>; uninstall(id: string): Promise<unknown>;
    inspectRepo(url: unknown): Promise<unknown>; installFromRepo(url: unknown, sha256: unknown, adminUserId: string): Promise<string>; updateFromRepo(id: string, sha256: unknown): Promise<unknown>; sources(): Promise<Record<string, string>>; updates(): Promise<unknown> };
  setInstaller(installer: NonNullable<PluginHost["installer"]>): void { this.installer = installer; }

  ids(): string[] { return [...this.entries.keys()]; }
  statusOf(id: string): PluginStatus | undefined { return this.entries.get(id)?.status; }

  private serialize<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const run = e.chain.then(fn);
    e.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async enable(id: string, adminUserId: string): Promise<void> {
    const e = this.valid(id);
    return this.serialize(e, async () => {
      if (e.status === "enabled") return;
      try { await this.activate(e); } catch (error) {
        e.status = "failed";
        await this.persist(e, false, "failed");
        throw error;
      }
      await this.persist(e, true, "enabled", e.manifest!.scope === "install" ? adminUserId : undefined);
      // Reinstall for everyone the plugin is on for (user scope: users who switched it on before a disable; install scope: the admin).
      for (const userId of await this.mcpUsers(e)) { await this.syncMcp(e, userId, true); await this.syncSkills(e, userId, true); }
    });
  }

  async disable(id: string): Promise<void> {
    const e = this.valid(id);
    return this.serialize(e, () => this.doDisable(e));
  }

  /** The body of `disable`, for callers that already hold the entry's lifecycle chain. */
  private async doDisable(e: Entry): Promise<void> {
    for (const userId of await this.mcpUsers(e)) { await this.syncMcp(e, userId, false); await this.syncSkills(e, userId, false); }
    await this.deactivate(e);
    e.status = "disabled";
    await this.persist(e, false, "disabled");
  }

  /** Graceful shutdown: calls stop() on every running plugin, in parallel. Never throws. Persisted flags are left as they are, so plugins restart on boot. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].filter((e) => e.built).map((e) => this.serialize(e, () => this.deactivate(e)).catch(() => undefined)));
  }

  // ---- lifecycle internals ----

  private async activate(e: Entry): Promise<void> {
    await this.migrate(e);
    const delays = this.opts.retryDelaysMs ?? [1_000, 5_000];
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      if (attempt > 1) { const wait = delays[attempt - 2] ?? delays[delays.length - 1] ?? 0; if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
      const built = buildContext(e.manifest!, this.contextDeps(e));
      try {
        await e.def.start?.(built.ctx);
        e.built = built;
        e.status = "enabled";
        this.publishSkills(e);
        return;
      } catch (error) {
        built.dispose();
        this.log("error", "plugin.start_failed", { plugin: e.id, attempt, error: built.scrubText(msg(error)) });
      }
    }
    throw new HttpError(500, "plugin_start_failed", `Plugin ${e.id} failed to start ${MAX_START_ATTEMPTS} times`);
  }

  private publishSkills(e: Entry): void {
    const names = e.manifest!.contributes.skills;
    if (this.skills && names.length && e.def.dir) this.skills.setPluginSkills(e.id, join(e.def.dir, "skills"), names);
  }

  /** Copy (on) or delete (off) the plugin's skill folders in one user's agent home, so their agents can load them. Problems are reported, never thrown. */
  private async syncSkills(e: Entry, userId: string, on: boolean): Promise<string[]> {
    const names = e.manifest!.contributes.skills;
    const problems: string[] = [];
    if (!this.skills || !e.def.dir || !names.length) return problems;
    for (const name of names) {
      try {
        if (on) {
          if (this.skills.installSkill) await this.skills.installSkill(userId, name, { ...readSkillFolder(e.def.dir, name), [PLUGIN_MARKER]: JSON.stringify({ pluginId: e.id, version: e.manifest!.version }) });
        } else await this.skills.removeSkill?.(userId, name, e.id);
      } catch (error) {
        const m = error instanceof HttpError ? error.message : "could not be installed";
        problems.push(`skill ${name}: ${m}`);
        this.log("warn", "plugin.skill_sync_failed", { plugin: e.id, skill: name, on, error: m });
      }
    }
    return problems;
  }

  /** Install (on) or remove (off) the plugin's MCP servers for one user. Failures are reported, never thrown: the toggle itself must succeed. */
  private async syncMcp(e: Entry, userId: string, on: boolean): Promise<string[]> {
    const decls = e.manifest!.contributes.mcpServers;
    const problems: string[] = [];
    if (!this.mcp || !decls.length) return problems;
    for (const decl of decls) {
      try {
        if (on) await this.mcp.install(userId, mcpInstallBody(e.id, decl));
        else for (const provider of ["claude", "codex"] as const) await this.mcp.remove(userId, mcpEntryName(e.id, decl.name), provider).catch(() => undefined);
      } catch (error) {
        const m = error instanceof HttpError ? error.message : "could not be installed";
        problems.push(`${decl.name}: ${m}`);
        this.log("warn", "plugin.mcp_sync_failed", { plugin: e.id, server: decl.name, on, error: m });
      }
    }
    return problems;
  }

  /** Users whose MCP entries this plugin owns: everyone who switched it on (user scope) or the enabling admin (install scope). */
  private async mcpUsers(e: Entry): Promise<string[]> {
    if (e.manifest!.scope === "install") {
      const owner = (await this.pool.query("SELECT config_owner FROM floq_plugins WHERE id = $1", [e.id])).rows[0]?.config_owner as string | null | undefined;
      return owner ? [owner] : [];
    }
    return ((await this.pool.query("SELECT user_id FROM floq_plugin_user_settings WHERE plugin_id = $1 AND enabled", [e.id])).rows as { user_id: string }[]).map((r) => r.user_id);
  }

  private async deactivate(e: Entry): Promise<void> {
    try { await e.def.stop?.(); } catch (error) { this.log("error", "plugin.stop_failed", { plugin: e.id, error: e.built?.scrubText(msg(error)) ?? "stop failed" }); }
    e.built?.dispose();
    e.built = undefined;
    this.taskSources.unregisterPlugin(e.id);
    this.skills?.setPluginSkills(e.id, null);
  }

  private contextDeps(e: Entry): ContextDeps {
    return { pool: this.pool, secrets: this.secrets, schema: this.storage === "schema" ? pluginSchema(e.id) : null, tablePrefix: pluginTablePrefix(e.id), fetchImpl: this.opts.fetchImpl, sink: this.opts.sink, taskSources: this.taskSources, events: this.events, approvals: () => this.approvals };
  }

  /** Pending migrations and their ledger rows commit or roll back together. */
  private async migrate(e: Entry): Promise<void> {
    const list = e.def.migrations ?? [];
    if (!e.manifest!.contributes.migrations || !list.length) return;
    const ids = new Set<string>();
    for (const m of list) { if (ids.has(m.id)) throw new Error("duplicate migration id"); ids.add(m.id); }
    const schemaMode = this.storage === "schema";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const applied = new Set(((await client.query("SELECT migration_id FROM floq_plugin_migrations WHERE plugin_id = $1", [e.id])).rows as { migration_id: string }[]).map((r) => r.migration_id));
      const pending = list.filter((m) => !applied.has(m.id));
      if (pending.length && schemaMode) await client.query(`CREATE SCHEMA IF NOT EXISTS "${pluginSchema(e.id)}"`);
      for (const m of pending) {
        if (schemaMode) await client.query(`SET LOCAL search_path TO "${pluginSchema(e.id)}"`);
        await client.query(expandSql(m.sql, pluginTablePrefix(e.id), schemaMode));
        if (schemaMode) await client.query("SET LOCAL search_path TO DEFAULT");
        await client.query("INSERT INTO floq_plugin_migrations (plugin_id, migration_id) VALUES ($1,$2)", [e.id, m.id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async persist(e: Entry, enabled: boolean, status: PluginStatus, configOwner?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO floq_plugins (id, enabled, version, status, config_owner) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, version = EXCLUDED.version, status = EXCLUDED.status,
         config_owner = COALESCE(EXCLUDED.config_owner, floq_plugins.config_owner), updated_at = now()`,
      [e.id, enabled, e.manifest?.version ?? null, status, configOwner ?? null]);
  }

  private valid(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw notFound("Plugin not found");
    if (!e.manifest) throw conflict("Plugin manifest is invalid", "plugin_invalid");
    return e;
  }

  // ---- public views ----

  async list(userId: string): Promise<PublicPlugin[]> {
    void this.lazyMigrate(userId);
    const rows = (await this.pool.query("SELECT id, enabled, config_owner FROM floq_plugins")).rows as { id: string; enabled: boolean; config_owner: string | null }[];
    const state = new Map(rows.map((r) => [r.id, r]));
    const userRows = (await this.pool.query("SELECT plugin_id, enabled FROM floq_plugin_user_settings WHERE user_id = $1", [userId])).rows as { plugin_id: string; enabled: boolean }[];
    const userOn = new Set(userRows.filter((r) => r.enabled).map((r) => r.plugin_id));
    const out: PublicPlugin[] = [];
    for (const e of this.entries.values()) {
      const m = e.manifest;
      if (!m) { out.push({ id: e.id, name: e.id, version: "", description: "", scope: "user", status: "invalid", enabled: false, userEnabled: false, error: e.error, source: e.source, ui: null, secrets: [], settings: [], contributes: { views: [], taskSources: [], rightSidebarTabs: [], settingsPanel: false } }); continue; }
      const on = e.status === "enabled";
      const present = new Set<string>();
      if (m.secrets.length) {
        const r = await this.pool.query("SELECT name FROM plugin_secrets WHERE plugin_id = $1 AND owner_id = $2 AND name = ANY($3)", [e.id, m.scope === "install" ? INSTALL_OWNER : userId, m.secrets.map((s) => s.name)]);
        for (const row of r.rows as { name: string }[]) present.add(row.name);
      }
      out.push({
        id: e.id, name: m.name, version: m.version, description: m.description, icon: m.icon, scope: m.scope, status: e.status,
        // An owner-only plugin is off for everyone but the administrator who set it up: its nav, tabs and sources never show for others.
        source: e.source, ui: e.ui ? { sha256: e.ui.sha256 } : null,
        enabled: on, userEnabled: on && (m.scope === "install" ? m.access !== "owner" || state.get(e.id)?.config_owner === userId : userOn.has(e.id)), error: e.error,
        secrets: m.secrets.map((s) => ({ name: s.name, description: s.description, required: s.required ?? false, present: present.has(s.name) })),
        settings: m.settings,
        contributes: { views: m.contributes.views, taskSources: m.contributes.taskSources, rightSidebarTabs: m.contributes.rightSidebarTabs, settingsPanel: m.contributes.settingsPanel },
      });
    }
    return out;
  }

  private async one(id: string, userId: string): Promise<PublicPlugin> {
    return (await this.list(userId)).find((p) => p.id === id)!;
  }

  // ---- settings ----

  private async readSettings(e: Entry, userId: string): Promise<Record<string, unknown>> {
    if (e.manifest!.scope === "install") return ((await this.pool.query("SELECT config FROM floq_plugins WHERE id = $1", [e.id])).rows[0]?.config as Record<string, unknown>) ?? {};
    const s = ((await this.pool.query("SELECT settings FROM floq_plugin_user_settings WHERE plugin_id = $1 AND user_id = $2", [e.id, userId])).rows[0]?.settings as Record<string, unknown>) ?? {};
    const { __kv: _kv, ...rest } = s;
    return rest;
  }

  private async writeSettings(e: Entry, userId: string, values: Record<string, unknown>): Promise<void> {
    this.taskSources.invalidate(e.id, e.manifest!.scope === "install" ? undefined : userId);
    if (e.manifest!.scope === "install") {
      await this.pool.query("UPDATE floq_plugins SET config = $2::jsonb, updated_at = now() WHERE id = $1", [e.id, JSON.stringify(values)]);
      return;
    }
    await this.pool.query(
      `INSERT INTO floq_plugin_user_settings (plugin_id, user_id, settings) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (plugin_id, user_id) DO UPDATE SET
         settings = $3::jsonb || COALESCE(jsonb_build_object('__kv', floq_plugin_user_settings.settings->'__kv'), '{}'::jsonb), updated_at = now()`,
      [e.id, userId, JSON.stringify(values)]);
  }

  // ---- agent access and webhooks ----

  /** `POST /internal/plugins/<id>/<path>` with an agent session token. The plugin must be active for the session's user. */
  async handleInternal(i: InternalInput): Promise<unknown> {
    const e = this.entries.get(i.pluginId);
    if (!e?.manifest || e.status !== "enabled" || !e.built || !e.manifest.contributes.internalRoutes) throw new HttpError(404, "plugin_disabled", "Plugin is not available");
    await this.requireActiveFor(e, i.userId);
    const hit = matchRoute(e.built.internalRoutes, "POST", "/" + i.path.replace(/^\/+/, ""));
    if (!hit) throw notFound("Route not found");
    return this.runHandler(e, () => hit.entry.handler({ userId: i.userId, sessionId: i.sessionId, params: hit.params, query: {}, body: i.body, signal: i.signal }));
  }

  /** Plugins an agent may call for this user, with their internal route patterns. */
  async listInternal(userId: string): Promise<{ id: string; name: string; description: string; routes: string[] }[]> {
    const out: { id: string; name: string; description: string; routes: string[] }[] = [];
    for (const e of this.entries.values()) {
      if (!e.manifest || e.status !== "enabled" || !e.built || !e.manifest.contributes.internalRoutes) continue;
      if (e.manifest.scope === "user" && !(await this.userOn(e.id, userId))) continue;
      if (e.manifest.access === "owner" && userId !== (await this.ownerOf(e.id))) continue;
      out.push({ id: e.id, name: e.manifest.name, description: e.manifest.description, routes: e.built.internalRoutes.map((r) => "/" + r.segments.join("/")) });
    }
    return out;
  }

  /** Admin: creates or replaces the install token. Only its hash is stored; the token is shown once. */
  async rotateWebhookToken(id: string): Promise<{ token: string; hooks: string[] }> {
    const e = this.valid(id);
    if (!e.manifest!.contributes.webhooks.length) throw badRequest("This plugin has no webhooks", "no_webhooks");
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      `INSERT INTO floq_plugins (id, version, webhook_token_hash) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET webhook_token_hash = EXCLUDED.webhook_token_hash, updated_at = now()`, [id, e.manifest!.version, sha256Hex(token)]);
    return { token, hooks: e.manifest!.contributes.webhooks };
  }

  /**
   * Unauthenticated entry point. Unknown plugin, disabled plugin, undeclared hook and wrong token all answer the same 404, and the
   * token is compared as equal-length digests in constant time. Nothing the caller sent is echoed back.
   */
  async handleWebhook(i: WebhookInput): Promise<unknown> {
    const now = (this.opts.now ?? Date.now)();
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
    const key = i.ip + "|" + i.pluginId;
    const hit = this.hits.get(key) ?? { count: 0, resetAt: now + WEBHOOK_RATE_WINDOW_MS };
    hit.count += 1; this.hits.set(key, hit);
    if (hit.count > WEBHOOK_RATE_MAX) throw new HttpError(429, "rate_limited", "Too many requests");
    const nope = () => new HttpError(404, "not_found", "Not found");
    const e = this.entries.get(i.pluginId);
    const stored = e?.manifest ? ((await this.pool.query("SELECT webhook_token_hash FROM floq_plugins WHERE id = $1", [i.pluginId])).rows[0]?.webhook_token_hash as string | null | undefined) : undefined;
    const a = Buffer.from(sha256Hex(i.token)), b = Buffer.from(stored ?? "0".repeat(64));
    const tokenOk = a.length === b.length && timingSafeEqual(a, b) && Boolean(stored);
    const hook = e?.built?.webhooks.get(i.name);
    if (!e || e.status !== "enabled" || !hook || !tokenOk) throw nope();
    const rawBody = await i.readRaw();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(i.headers)) if (typeof v === "string") headers[k.toLowerCase()] = v; else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
    const req = { rawBody, headers, query: Object.fromEntries(i.query), json: () => JSON.parse(rawBody.toString("utf8")) as unknown };
    return this.runHandler(e, async () => {
      if (hook.verify && !(await hook.verify(req))) throw new HttpError(401, "invalid_signature", "Signature check failed");
      return hook.handler(req);
    });
  }

  private async ownerOf(pluginId: string): Promise<string | null> {
    return ((await this.pool.query("SELECT config_owner FROM floq_plugins WHERE id = $1", [pluginId])).rows[0]?.config_owner as string | null | undefined) ?? null;
  }

  private async userOn(pluginId: string, userId: string): Promise<boolean> {
    const r = await this.pool.query("SELECT enabled FROM floq_plugin_user_settings WHERE plugin_id = $1 AND user_id = $2", [pluginId, userId]);
    return Boolean(r.rows[0]?.enabled);
  }

  private async requireActiveFor(e: Entry, userId: string): Promise<void> {
    if (e.manifest!.scope === "user" && !(await this.userOn(e.id, userId))) throw new HttpError(404, "plugin_disabled", "Plugin is disabled");
    if (e.manifest!.access === "owner" && userId !== (await this.ownerOf(e.id))) throw new HttpError(404, "plugin_disabled", "Plugin is disabled");
  }

  /** Runs plugin code; the result and any plugin-authored error text are scrubbed of the plugin's revealed secrets. */
  private async runHandler(e: Entry, fn: () => Promise<unknown> | unknown): Promise<unknown> {
    const built = e.built!;
    try {
      return built.scrub((await fn()) ?? {});
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, error.code, built.scrubText(error.message));
      this.log("error", "plugin.route_failed", { plugin: e.id, error: built.scrubText(msg(error)) });
      throw new HttpError(500, "plugin_error", "Plugin request failed");
    }
  }

  // ---- HTTP dispatch ----

  private async handleTaskSources(i: HandleInput): Promise<HandleResult> {
    if (i.method.toUpperCase() !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
    const rest = i.pathname.slice("/v1/task-sources".length).split("/").filter(Boolean);
    const active = (await this.list(i.userId)).filter((p) => p.status === "enabled" && p.enabled && p.userEnabled);
    if (rest.length === 0) {
      return { status: 200, body: { sources: active.flatMap((p) => p.contributes.taskSources.map((s) => ({
        pluginId: p.id, sourceId: s.id, label: s.label, view: s.view, icon: p.icon,
        missingSecrets: p.secrets.filter((x) => x.required && !x.present).map((x) => x.name),
      }))) } };
    }
    const [pluginId, sourceId, kind, externalId] = rest;
    const plugin = active.find((p) => p.id === pluginId);
    if (!plugin || !plugin.contributes.taskSources.some((s) => s.id === sourceId)) throw new HttpError(404, "source_not_found", "Task source not found");
    if (plugin.secrets.some((x) => x.required && !x.present)) throw new HttpError(409, "not_configured", "This source needs its secrets before it can load.");
    // Provider code is plugin code: errors, results and log lines are scrubbed of the secrets this plugin revealed (a token in a query string
    // can come back inside an error message, a `url` or a field). Scrubbing happens on the way out, so the per-user cache stays raw.
    const built = this.entries.get(pluginId)?.built;
    const scrubText = (t: string) => built?.scrubText(t) ?? t;
    const scrub = <T,>(v: T): T => (built ? (built.scrub(v) as T) : v);
    const onError = (error: unknown) => this.log("error", "plugin.task_source_failed", { plugin: pluginId, source: sourceId, error: scrubText(msg(error)) });
    try {
      if (kind === "items" && rest.length === 3) {
        const query = i.query.get("query")?.slice(0, 200) || undefined;
        const cursor = i.query.get("cursor")?.slice(0, 500) || undefined;
        return { status: 200, body: scrub(await this.taskSources.items(i.userId, pluginId, sourceId, { query, cursor }, onError)) };
      }
      if (kind === "items" && rest.length === 4) {
        let id: string;
        try { id = decodeURIComponent(externalId); } catch { throw badRequest("The item id is not valid", "invalid_id"); }
        return { status: 200, body: scrub({ item: await this.taskSources.item(i.userId, pluginId, sourceId, id, onError) }) };
      }
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, error.code, scrubText(error.message));
      throw error;
    }
    throw notFound();
  }

  /** Returns null when the path is not a plugin path. Errors are thrown as HttpError for the server's handler. */
  async handle(i: HandleInput): Promise<HandleResult | null> {
    if (i.pathname === "/v1/task-sources" || i.pathname.startsWith("/v1/task-sources/")) return this.handleTaskSources(i);
    if (i.pathname !== "/v1/plugins" && !i.pathname.startsWith("/v1/plugins/")) return null;
    const rest = i.pathname.slice("/v1/plugins".length).split("/").filter(Boolean);
    const method = i.method.toUpperCase();
    if (rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
      return { status: 200, body: { plugins: await this.list(i.userId) } };
    }
    const id = rest[0];
    const sub = rest[1];
    // ---- install / update / uninstall / delete data (admin only; an agent has no route to any of this) ----
    const installer = () => { if (!this.installer) throw new HttpError(503, "installer_unavailable", "Plugin installation is not available."); return this.installer; };
    const confirmed = (given: unknown) => { if (given !== id) throw badRequest("Type the plugin id to confirm.", "confirmation_required"); };
    if (id === "catalog" && rest.length === 1 && method === "GET") { await i.requireAdmin(); return { status: 200, body: await installer().catalog() }; }
    // From a GitHub repository address (any owner): preview first (nothing stored), then install with the sha256 that was reviewed.
    if (id === "sources" && rest.length === 1 && method === "GET") { await i.requireAdmin(); return { status: 200, body: { sources: await installer().sources() } }; }
    if (id === "updates" && rest.length === 1 && method === "GET") { await i.requireAdmin(); return { status: 200, body: await installer().updates() }; }
    // One-time notices about credentials moved out of the vault: names only, never values. Install-wide items go to administrators.
    if (id === "secret-migrations" && (rest.length === 1 || (rest.length === 2 && sub === "dismiss"))) {
      const admin = await i.requireAdmin().then(() => true, () => false);
      const owners = admin ? [i.userId, INSTALL_OWNER] : [i.userId];
      if (rest.length === 1 && method === "GET") {
        const r = await this.pool.query("SELECT plugin_id, name, moved_at, kept_in_vault FROM plugin_secret_migrations WHERE owner_id = ANY($1) AND dismissed_at IS NULL ORDER BY moved_at, plugin_id, name", [owners]);
        return { status: 200, body: { items: (r.rows as { plugin_id: string; name: string; moved_at: string | Date; kept_in_vault: boolean }[]).map((x) => ({
          pluginId: x.plugin_id, pluginName: this.entries.get(x.plugin_id)?.manifest?.name ?? x.plugin_id, name: x.name, movedAt: new Date(x.moved_at).toISOString(), keptInVault: x.kept_in_vault })) } };
      }
      if (rest.length === 2 && method === "POST") {
        await this.pool.query("UPDATE plugin_secret_migrations SET dismissed_at = now() WHERE owner_id = ANY($1) AND dismissed_at IS NULL", [owners]);
        return { status: 204, body: null };
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed");
    }
    if (id === "inspect-url" && rest.length === 1 && method === "POST") {
      await i.requireAdmin();
      return { status: 200, body: { preview: await installer().inspectRepo(((await i.readBody()) as { url?: unknown } | undefined)?.url) } };
    }
    if (id === "install-url" && rest.length === 1 && method === "POST") {
      await i.requireAdmin();
      const b = (await i.readBody()) as { url?: unknown; sha256?: unknown; confirm?: unknown } | undefined;
      const preview = (await installer().inspectRepo(b?.url)) as { id: string };
      if (typeof b?.confirm !== "string" || b.confirm !== preview.id) throw badRequest("Type the plugin id to confirm.", "confirmation_required");
      const pid = await installer().installFromRepo(b?.url, b?.sha256, i.userId);
      return { status: 200, body: { plugin: await this.one(pid, i.userId) } };
    }
    if (id === "install" && rest.length === 1 && method === "POST") {
      await i.requireAdmin();
      const b = (await i.readBody()) as { id?: unknown; confirm?: unknown } | undefined;
      const pid = typeof b?.id === "string" ? b.id : "";
      if (b?.confirm !== pid || !pid) throw badRequest("Type the plugin id to confirm.", "confirmation_required");
      await installer().install(pid, i.userId);
      return { status: 200, body: { plugin: await this.one(pid, i.userId) } };
    }
    if (sub === "purge" && rest.length === 2 && method === "POST") {
      await i.requireAdmin();
      confirmed(((await i.readBody()) as { confirm?: unknown } | undefined)?.confirm);
      await this.purgeData(id);
      return { status: 200, body: { purged: true } };
    }
    if (!this.entries.has(id)) throw notFound("Plugin not found");
    if (rest.length === 1 && method === "DELETE") {
      await i.requireAdmin();
      confirmed(i.query.get("confirm"));
      await installer().uninstall(id);
      return { status: 200, body: { uninstalled: true } };
    }
    if (sub === "update" && rest.length === 2 && method === "POST") {
      await i.requireAdmin();
      if ((await installer().sources())[id]) await installer().updateFromRepo(id, ((await i.readBody()) as { sha256?: unknown } | undefined)?.sha256);
      else await installer().update(id);
      return { status: 200, body: { plugin: await this.one(id, i.userId) } };
    }
    if (sub === "ui.js" && rest.length === 2 && method === "GET") {
      const e = this.valid(id);
      const info = await this.one(id, i.userId);
      if (!e.ui || !info.enabled || !info.userEnabled) throw new HttpError(404, "plugin_disabled", "Plugin is not available");
      return { status: 200, body: null, raw: { contentType: "text/javascript; charset=utf-8", text: e.ui.text, headers: { "X-Floq-Plugin-Sha256": e.ui.sha256, "Cache-Control": "no-store" } } };
    }
    if ((sub === "enable" || sub === "disable") && rest.length === 2 && method === "POST") {
      await i.requireAdmin();
      if (sub === "enable") { await this.enable(id, i.userId); void this.lazyMigrate(i.userId, true); } else await this.disable(id);
      return { status: 200, body: { plugin: await this.one(id, i.userId) } };
    }
    if (sub === "webhook-token" && rest.length === 2 && (method === "POST" || method === "GET")) {
      await i.requireAdmin();
      if (method === "POST") return { status: 200, body: await this.rotateWebhookToken(id) };
      const e = this.valid(id);
      const row = (await this.pool.query("SELECT webhook_token_hash FROM floq_plugins WHERE id = $1", [id])).rows[0];
      return { status: 200, body: { configured: Boolean(row?.webhook_token_hash), hooks: e.manifest!.contributes.webhooks } };
    }
    if (sub === "user" && rest.length === 2 && method === "PUT") {
      const e = this.valid(id);
      if (e.manifest!.scope !== "user") throw badRequest("This plugin is enabled for the whole install", "plugin_not_user_scoped");
      const body = (await i.readBody()) as { enabled?: unknown };
      if (typeof body?.enabled !== "boolean") throw badRequest("enabled must be a boolean", "invalid_enabled");
      if (body.enabled && e.status !== "enabled") throw new HttpError(404, "plugin_disabled", "Plugin is disabled");
      await this.pool.query(
        `INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ($1,$2,$3)
         ON CONFLICT (plugin_id, user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [id, i.userId, body.enabled]);
      this.taskSources.invalidate(id, i.userId);
      if (body.enabled) void this.lazyMigrate(i.userId, true); // the user just became a migration source for this plugin
      const mcpProblems = [...(await this.syncMcp(e, i.userId, body.enabled)), ...(await this.syncSkills(e, i.userId, body.enabled))];
      return { status: 200, body: { plugin: await this.one(id, i.userId), ...(mcpProblems.length ? { mcpProblems } : {}) } };
    }
    if (sub === "settings" && rest.length === 2 && (method === "GET" || method === "PUT")) {
      const e = this.valid(id);
      // Install-scope config is admin configuration (URLs, secret names): admins only, for reading as well as writing.
      if (e.manifest!.scope === "install") await i.requireAdmin();
      if (method === "GET") return { status: 200, body: { settings: await this.readSettings(e, i.userId) } };
      const values = validateSettings(e.manifest!.settings, ((await i.readBody()) as { settings?: unknown })?.settings);
      await this.writeSettings(e, i.userId, values);
      return { status: 200, body: { settings: values } };
    }
    // ---- credentials: write-only. No route returns a value; bodies are small and never logged. ----
    if (sub === "secrets" && (rest.length === 2 || rest.length === 3)) {
      const e = this.valid(id);
      const install = e.manifest!.scope === "install";
      const owner = install ? INSTALL_OWNER : i.userId;
      if (rest.length === 2) {
        if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
        void this.lazyMigrate(i.userId);
        const editable = !install || (await i.requireAdmin().then(() => true, () => false));
        const status = new Map((await this.secrets.status(id, owner)).map((x) => [x.name, x]));
        return { status: 200, body: { secrets: e.manifest!.secrets.map((d) => ({
          name: d.name, description: d.description ?? "", required: d.required ?? false, present: status.get(d.name)?.present ?? false,
          updatedAt: status.get(d.name)?.updatedAt ?? null, scope: e.manifest!.scope, editable })) } };
      }
      if (method !== "PUT" && method !== "DELETE") throw new HttpError(405, "method_not_allowed", "Method not allowed");
      let name: string;
      try { name = decodeURIComponent(rest[2]); } catch { throw badRequest("Invalid secret name", "invalid_secret"); }
      if (!e.manifest!.secrets.some((d) => d.name === name)) throw new HttpError(404, "unknown_secret", "The plugin does not declare a secret named " + JSON.stringify(name.slice(0, 64)) + ".");
      if (install) await i.requireAdmin();
      if (method === "DELETE") await this.secrets.remove(id, owner, name, i.userId);
      else {
        const body = (await i.readBody(16 * 1024)) as { value?: unknown } | undefined;
        await this.secrets.set(id, owner, name, PluginSecrets.validateValue(body?.value) , i.userId);
      }
      this.taskSources.invalidate(id, install ? undefined : i.userId);
      return { status: 204, body: null };
    }
    if (sub === "api") {
      const e = this.valid(id);
      if (e.status !== "enabled" || !e.built) throw new HttpError(404, "plugin_disabled", "Plugin is disabled");
      await this.requireActiveFor(e, i.userId);
      const hit = matchRoute(e.built.routes, method, "/" + rest.slice(2).join("/"));
      if (!hit) throw notFound("Route not found");
      const body = method === "POST" || method === "PUT" ? await i.readBody() : undefined;
      const result = await this.runHandler(e, () => hit.entry.handler({ userId: i.userId, params: hit.params, query: Object.fromEntries(i.query), body }));
      return { status: 200, body: result };
    }
    throw notFound();
  }
}

/** Full-replacement validation. Error messages name keys only, never values. */
export function validateSettings(decls: PluginSettingDecl[], input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw badRequest("settings must be an object", "invalid_settings");
  const raw = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) if (!decls.some((d) => d.key === k)) throw badRequest("settings has an unknown key", "invalid_settings");
  for (const d of decls) {
    const v = raw[d.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) { if (d.required) throw badRequest(`setting ${d.key} is required`, "invalid_settings"); continue; }
    const bad = (why: string) => badRequest(`setting ${d.key} ${why}`, "invalid_settings");
    switch (d.type) {
      case "text": if (typeof v !== "string" || v.length > 2000) throw bad("must be text up to 2000 characters"); out[d.key] = v; break;
      case "url": {
        if (typeof v !== "string" || v.length > 2000) throw bad("must be a URL");
        let u: URL; try { u = new URL(v); } catch { throw bad("must be a valid URL"); }
        if (u.protocol !== "https:" && u.protocol !== "http:") throw bad("must be an http(s) URL");
        out[d.key] = v; break;
      }
      case "number": if (typeof v !== "number" || !Number.isFinite(v)) throw bad("must be a number"); out[d.key] = v; break;
      case "boolean": if (typeof v !== "boolean") throw bad("must be true or false"); out[d.key] = v; break;
      case "select": if (typeof v !== "string" || !d.options?.some((o) => o.value === v)) throw bad("must be one of the allowed options"); out[d.key] = v; break;
      case "secretRef": if (typeof v !== "string" || !VAULT_NAME.test(v)) throw bad("must be a secret name"); out[d.key] = v; break;
    }
  }
  return out;
}
