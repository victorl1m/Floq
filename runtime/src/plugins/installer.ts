import type pg from "pg";
import { HttpError, badRequest, conflict } from "../errors.js";
import { log } from "../logger.js";
import { CatalogClient, CatalogError, parseRepoUrl, type CatalogEntry, type RepoRef } from "./catalog.js";
import { PackageError, compareVersions, inspectPackage, parsePackage, sha256Hex } from "./package.js";
import type { PluginHost } from "./host.js";
import { fromPackage, loadDefinition, removeCache, uiMeta, type PackageRow } from "./installed.js";

/** What the admin sees before installing from a repository address: the facts to decide on, and the sha256 that the install must match. */
export interface PackagePreview {
  repo: string; tag: string; id: string; name: string; version: string; description: string; scope: "user" | "install";
  secrets: string[]; network: string[]; contributes: string[]; sha256: string; size: number;
  installedVersion: string | null; builtin: boolean;
}

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
      if (entry.deprecated) throw conflict(entry.deprecated, "deprecated");
      const pkg = parsePackage(await catalog.download(entry), entry, { builtinIds: host.builtinIds() });
      const row: PackageRow = fromPackage(pkg);
      await pool.query(
        "INSERT INTO floq_plugin_packages (id, version, sha256, manifest, runtime, ui, skills, installed_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8)",
        [row.id, row.version, row.sha256, JSON.stringify(row.manifest), row.runtime, row.ui, JSON.stringify(row.skills), adminUserId]);
      try { await host.install(await loadDefinition(row, pluginDir), uiMeta(row.ui, sha256Hex)); }
      catch (error) { await pool.query("DELETE FROM floq_plugin_packages WHERE id = $1", [id]).catch(() => undefined); removeCache(pluginDir, id); throw error; }
    } catch (error) { return fail(error); }
  }

  private async fetchFromRepo(url: unknown) {
    const ref = parseRepoUrl(url);
    if (!ref) throw badRequest("Enter a GitHub repository address like https://github.com/owner/repo.", "invalid_repo_url");
    const { catalog, host } = this.deps;
    const asset = await catalog.latestRelease(ref);
    const pkg = inspectPackage(await catalog.downloadAsset(asset, ref), { builtinIds: host.builtinIds() });
    return { ref, asset, pkg };
  }

  private preview(ref: RepoRef, tag: string, pkg: Awaited<ReturnType<PluginInstaller["fetchFromRepo"]>>["pkg"], installed: string | null): PackagePreview {
    const m = pkg.manifest;
    return {
      repo: `${ref.owner}/${ref.repo}`, tag, id: m.id, name: m.name, version: m.version, description: m.description, scope: m.scope,
      secrets: m.secrets.map((s) => s.name), network: m.network.allow, contributes: Object.entries(m.contributes).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(v))).map(([k]) => k),
      sha256: pkg.sha256, size: pkg.size, installedVersion: installed, builtin: this.deps.host.isBuiltin(m.id),
    };
  }

  /** Downloads and verifies the newest release of a repository without storing or running anything. */
  async inspectRepo(url: unknown): Promise<PackagePreview> {
    try {
      const { ref, asset, pkg } = await this.fetchFromRepo(url);
      return this.preview(ref, asset.tag, pkg, (await this.installedVersions()).get(pkg.manifest.id) ?? null);
    } catch (error) { return fail(error); }
  }

  /**
   * Installs from a repository address. The admin confirmed one exact sha256 in the preview: if the release changed since, nothing is
   * installed. The plugin is left off. The repository is stored, so an update can only come from the same place.
   */
  async installFromRepo(url: unknown, sha256: unknown, adminUserId: string): Promise<string> {
    const { host, pool, pluginDir } = this.deps;
    try {
      const { ref, pkg } = await this.fetchFromRepo(url);
      if (typeof sha256 !== "string" || sha256.toLowerCase() !== pkg.sha256) throw conflict("The release changed since you reviewed it. Review it again.", "release_changed");
      const id = pkg.manifest.id;
      if (host.isBuiltin(id)) throw conflict("This plugin is built into Floq.", "builtin");
      if ((await this.installedVersions()).has(id) || host.isInstalled(id)) throw conflict("This plugin is already installed.", "already_installed");
      const row = fromPackage(pkg);
      await pool.query(
        "INSERT INTO floq_plugin_packages (id, version, sha256, manifest, runtime, ui, skills, installed_by, source_repo) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9)",
        [row.id, row.version, row.sha256, JSON.stringify(row.manifest), row.runtime, row.ui, JSON.stringify(row.skills), adminUserId, `${ref.owner}/${ref.repo}`]);
      try { await host.install(await loadDefinition(row, pluginDir), uiMeta(row.ui, sha256Hex)); }
      catch (error) { await pool.query("DELETE FROM floq_plugin_packages WHERE id = $1", [id]).catch(() => undefined); removeCache(pluginDir, id); throw error; }
      return id;
    } catch (error) { return fail(error); }
  }

  /**
   * Installed plugins with a newer version available: catalog installs from the catalog, repository installs from their repository's newest
   * release. Read-only (the app shows a toast; the admin updates by hand). A source that cannot be reached is skipped, never an error.
   */
  async updates(): Promise<{ updates: { id: string; name: string; installedVersion: string; availableVersion: string; repo: string | null }[]; deprecated: { id: string; message: string }[] }> {
    const installed = await this.installedVersions();
    const sources = await this.sources();
    const names = new Map<string, string>();
    const out: { id: string; name: string; installedVersion: string; availableVersion: string; repo: string | null }[] = [];
    const rows = (await this.deps.pool.query("SELECT id, manifest FROM floq_plugin_packages")).rows as { id: string; manifest: { name?: string } }[];
    for (const r of rows) names.set(r.id, r.manifest?.name ?? r.id);
    let entries: CatalogEntry[] = [];
    if ([...installed.keys()].some((id) => !sources[id])) entries = await this.deps.catalog.list().catch(() => []);
    for (const [id, version] of installed) {
      try {
        if (sources[id]) {
          const { pkg } = await this.fetchFromRepo(`https://github.com/${sources[id]}`);
          if (pkg.manifest.id === id && compareVersions(pkg.manifest.version, version) > 0) out.push({ id, name: names.get(id)!, installedVersion: version, availableVersion: pkg.manifest.version, repo: sources[id] });
        } else {
          const e = entries.find((x) => x.id === id);
          if (e && compareVersions(e.version, version) > 0) out.push({ id, name: names.get(id)!, installedVersion: version, availableVersion: e.version, repo: null });
        }
      } catch { /* unreachable source: no notification */ }
    }
    // Installed catalog plugins the catalog marks as deprecated (Settings > Plugins shows a badge).
    const deprecated = entries.filter((e) => e.deprecated && installed.has(e.id) && !sources[e.id]).map((e) => ({ id: e.id, message: e.deprecated! }));
    return { updates: out, deprecated };
  }

  /** `id -> owner/repo` for plugins installed from a repository address (the others came from the catalog). */
  async sources(): Promise<Record<string, string>> {
    const rows = (await this.deps.pool.query("SELECT id, source_repo FROM floq_plugin_packages WHERE source_repo IS NOT NULL")).rows as { id: string; source_repo: string }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.source_repo]));
  }

  /** Manual update of a plugin installed from a repository: the newest release of the SAME repository, a strictly newer version, the sha256 the admin reviewed. */
  async updateFromRepo(id: string, sha256: unknown): Promise<void> {
    const { host, pool, pluginDir } = this.deps;
    const source = (await this.sources())[id];
    if (!source || !host.isInstalled(id)) throw new HttpError(404, "not_installed", "That plugin was not installed from a repository.");
    try {
      const { pkg } = await this.fetchFromRepo(`https://github.com/${source}`);
      if (typeof sha256 !== "string" || sha256.toLowerCase() !== pkg.sha256) throw conflict("The release changed since you reviewed it. Review it again.", "release_changed");
      if (pkg.manifest.id !== id) throw conflict("The repository now publishes a different plugin id.", "id_changed");
      const current = (await this.installedVersions()).get(id)!;
      const order = compareVersions(pkg.manifest.version, current);
      if (order === 0) throw conflict("Already up to date.", "up_to_date");
      if (order < 0) throw conflict("The release is older than the installed version. Downgrades are not allowed.", "downgrade_refused");
      const row = fromPackage(pkg);
      await host.replace(id, await loadDefinition(row, pluginDir), uiMeta(row.ui, sha256Hex));
      await pool.query(
        "UPDATE floq_plugin_packages SET version=$2, sha256=$3, manifest=$4::jsonb, runtime=$5, ui=$6, skills=$7::jsonb, installed_at=now() WHERE id=$1",
        [id, row.version, row.sha256, JSON.stringify(row.manifest), row.runtime, row.ui, JSON.stringify(row.skills)]);
    } catch (error) { return fail(error); }
  }

  /** Only a strictly newer catalog version is installed. If the new version cannot start, the previous one is restored and keeps running. */
  async update(id: string): Promise<void> {
    const { host, pool, catalog, pluginDir } = this.deps;
    const current = (await this.installedVersions()).get(id);
    if (!current || !host.isInstalled(id)) throw new HttpError(404, "not_installed", "That plugin is not installed.");
    if ((await this.sources())[id]) throw conflict("This plugin was installed from a repository: update it from there.", "repo_install");
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
