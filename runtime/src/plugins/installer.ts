import type pg from "pg";
import { HttpError, badRequest, conflict } from "../errors.js";
import { log } from "../logger.js";
import { CatalogClient, CatalogError, type CatalogEntry } from "./catalog.js";
import { PackageError, compareVersions, parsePackage, sha256Hex } from "./package.js";
import type { PluginHost } from "./host.js";
import { fromPackage, loadDefinition, removeCache, uiMeta, type PackageRow } from "./installed.js";

export interface CatalogItem extends CatalogEntry {
  /** Built into this runtime: shown, but cannot be installed or removed. */
  builtin: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
}

const fail = (error: unknown): never => {
  if (error instanceof HttpError) throw error;
  if (error instanceof CatalogError) throw new HttpError(502, "catalog_unavailable", error.message);
  if (error instanceof PackageError) throw new HttpError(422, "invalid_package", error.message);
  log.error("plugin.install_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
  throw new HttpError(500, "install_failed", "The plugin could not be installed.");
};

/**
 * Install, update and uninstall of packages from the catalog. Admin-only (the host routes enforce it) and reachable from no agent path.
 * Everything is verified (https and host pinning, sha256, manifest) before any code is written to disk or imported.
 */
export class PluginInstaller {
  constructor(private readonly deps: { pool: Pick<pg.Pool, "query" | "connect">; host: PluginHost; catalog: CatalogClient; pluginDir: string }) {}

  private async installedVersions(): Promise<Map<string, string>> {
    const rows = (await this.deps.pool.query("SELECT id, version FROM floq_plugin_packages")).rows as { id: string; version: string }[];
    return new Map(rows.map((r) => [r.id, r.version]));
  }

  async catalog(): Promise<{ plugins: CatalogItem[] }> {
    let entries: CatalogEntry[];
    try { entries = await this.deps.catalog.list(); } catch (error) { return fail(error); }
    const installed = await this.installedVersions();
    return { plugins: entries.map((e) => {
      const v = installed.get(e.id) ?? null;
      return { ...e, builtin: this.deps.host.isBuiltin(e.id), installedVersion: v, updateAvailable: v !== null && compareVersions(e.version, v) > 0 };
    }) };
  }

  private async entry(id: string): Promise<CatalogEntry> {
    let entries: CatalogEntry[];
    try { entries = await this.deps.catalog.list(); } catch (error) { return fail(error); }
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new HttpError(404, "not_in_catalog", "That plugin is not in the catalog.");
    return entry;
  }

  /** Download, verify, store and load. The plugin is left off: an admin turns it on (and configures it) afterwards. */
  async install(id: string, adminUserId: string): Promise<void> {
    const { host, pool, catalog, pluginDir } = this.deps;
    if (host.isBuiltin(id)) throw conflict("This plugin is built into Floq.", "builtin");
    if ((await this.installedVersions()).has(id) || host.isInstalled(id)) throw conflict("This plugin is already installed.", "already_installed");
    try {
      const entry = await this.entry(id);
      const pkg = parsePackage(await catalog.download(entry), entry, { builtinIds: host.builtinIds() });
      const row: PackageRow = fromPackage(pkg);
      await pool.query(
        "INSERT INTO floq_plugin_packages (id, version, sha256, manifest, runtime, ui, skills, installed_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8)",
        [row.id, row.version, row.sha256, JSON.stringify(row.manifest), row.runtime, row.ui, JSON.stringify(row.skills), adminUserId]);
      try { await host.install(await loadDefinition(row, pluginDir), uiMeta(row.ui, sha256Hex)); }
      catch (error) { await pool.query("DELETE FROM floq_plugin_packages WHERE id = $1", [id]).catch(() => undefined); removeCache(pluginDir, id); throw error; }
    } catch (error) { return fail(error); }
  }

  /** Only a strictly newer catalog version is installed. If the new version cannot start, the previous one is restored and keeps running. */
  async update(id: string): Promise<void> {
    const { host, pool, catalog, pluginDir } = this.deps;
    const current = (await this.installedVersions()).get(id);
    if (!current || !host.isInstalled(id)) throw new HttpError(404, "not_installed", "That plugin is not installed.");
    try {
      const entry = await this.entry(id);
      const order = compareVersions(entry.version, current);
      if (order === 0) throw conflict("Already up to date.", "up_to_date");
      if (order < 0) throw conflict("The catalog has an older version. Downgrades are not allowed.", "downgrade_refused");
      const pkg = parsePackage(await catalog.download(entry), entry, { builtinIds: host.builtinIds() });
      const row = fromPackage(pkg);
      await host.replace(id, await loadDefinition(row, pluginDir), uiMeta(row.ui, sha256Hex));
      await pool.query(
        "UPDATE floq_plugin_packages SET version=$2, sha256=$3, manifest=$4::jsonb, runtime=$5, ui=$6, skills=$7::jsonb, installed_at=now() WHERE id=$1",
        [id, row.version, row.sha256, JSON.stringify(row.manifest), row.runtime, row.ui, JSON.stringify(row.skills)]);
    } catch (error) { return fail(error); }
  }

  /** Turns the plugin off (removing its MCP servers and skill copies), then deletes the package and its cache. Data is kept. */
  async uninstall(id: string): Promise<void> {
    const { host, pool, pluginDir } = this.deps;
    if (host.isBuiltin(id)) throw conflict("Built-in plugins cannot be uninstalled.", "builtin");
    if (!host.isInstalled(id)) throw new HttpError(404, "not_installed", "That plugin is not installed.");
    try {
      await host.removeDefinition(id);
      await pool.query("DELETE FROM floq_plugin_packages WHERE id = $1", [id]);
      removeCache(pluginDir, id);
    } catch (error) { return fail(error); }
  }
}

export { badRequest };
