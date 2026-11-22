import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { log } from "../logger.js";
import { parseManifest } from "./manifest.js";
import { PackageError, type PluginPackage } from "./package.js";
import type { PluginDefinition } from "./sdk.js";
import type { PluginHost } from "./host.js";

export const DEFAULT_PLUGIN_DIR = "/var/lib/floq/plugins";
export const pluginDirFromEnv = () => process.env.FLOQ_PLUGIN_DIR || DEFAULT_PLUGIN_DIR;

export interface PackageRow {
  id: string; version: string; sha256: string; manifest: unknown; runtime: string; ui: string | null; skills: Record<string, Record<string, string>>;
}

/** Cache directory of one verified package: a new sha256 gets a new path, so an update never overwrites code Node already imported. */
export const packageDir = (pluginDir: string, id: string, sha256: string) => join(pluginDir, id, sha256);

/**
 * Writes the verified package to `<pluginDir>/<id>/<sha256>/` (runtime.mjs mode 0600, skills as folders) and returns the directory.
 * The id and sha256 come from a parsed manifest and a hex digest, so the path cannot escape `pluginDir`.
 */
export function materialize(row: PackageRow, pluginDir: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(row.id) || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new PackageError("invalid package identity");
  const dir = packageDir(pluginDir, row.id, row.sha256);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "runtime.mjs");
  writeFileSync(file, row.runtime, { mode: 0o600 });
  chmodSync(file, 0o600);
  for (const [skill, files] of Object.entries(row.skills ?? {})) {
    for (const [rel, text] of Object.entries(files)) {
      const target = join(dir, "skills", skill, ...rel.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, text, { mode: 0o600 });
    }
  }
  return dir;
}

export function removeCache(pluginDir: string, id: string): void {
  if (/^[a-z][a-z0-9-]{1,31}$/.test(id)) rmSync(join(pluginDir, id), { recursive: true, force: true });
}

const isFn = (v: unknown) => v === undefined || typeof v === "function";

/** Imports the materialised runtime and turns its default export into a definition. The manifest always comes from the verified package. */
export async function loadDefinition(row: PackageRow, pluginDir: string): Promise<PluginDefinition> {
  const dir = materialize(row, pluginDir);
  const manifest = parseManifest(row.manifest);
  const mod = (await import(pathToFileURL(join(dir, "runtime.mjs")).href)) as { default?: Partial<PluginDefinition> };
  const def = mod.default;
  if (!def || typeof def !== "object") throw new PackageError("the runtime has no default export");
  if (!isFn(def.start) || !isFn(def.stop)) throw new PackageError("start and stop must be functions");
  if (def.migrations !== undefined && (!Array.isArray(def.migrations) || def.migrations.some((m) => !m || typeof m.id !== "string" || typeof m.sql !== "string"))) throw new PackageError("migrations must be a list of { id, sql }");
  return { manifest, migrations: def.migrations, start: def.start, stop: def.stop, dir };
}

export const rowToPackage = (r: Record<string, unknown>): PackageRow => ({ id: String(r.id), version: String(r.version), sha256: String(r.sha256), manifest: r.manifest, runtime: String(r.runtime), ui: typeof r.ui === "string" ? r.ui : null, skills: (r.skills ?? {}) as PackageRow["skills"] });

export const fromPackage = (p: PluginPackage): PackageRow => ({ id: p.manifest.id, version: p.manifest.version, sha256: p.sha256, manifest: p.manifest, runtime: p.runtime, ui: p.ui, skills: p.skills });

/** UI bundle checksum shown to the app (sha256 of the exact text the runtime serves). */
export const uiMeta = (ui: string | null, sha: (t: string) => string) => (ui ? { text: ui, sha256: sha(ui) } : undefined);

/**
 * Boot: registers every installed package with the host. A package whose code is missing, broken or does not match its manifest
 * becomes an `invalid` entry with the reason; the runtime and the other plugins carry on.
 */
export async function loadInstalledPackages(pool: Pick<pg.Pool, "query">, host: PluginHost, pluginDir: string, sha: (t: string) => string): Promise<{ loaded: string[]; broken: string[]; superseded?: string[] }> {
  const rows = (await pool.query("SELECT id, version, sha256, manifest, runtime, ui, skills FROM floq_plugin_packages ORDER BY id")).rows as Record<string, unknown>[];
  const loaded: string[] = [], broken: string[] = [], superseded: string[] = [];
  for (const r of rows) {
    const row = rowToPackage(r);
    // A catalog plugin that became part of Floq (WhatsApp, id "waha"): the built-in takes over under the same id, so the plugin's schema,
    // settings, credentials, webhook tokens, migration ledger and on/off state (all keyed by the id) are adopted in place. The package and its
    // cached code are removed and never imported, so the deprecated plugin and the built-in can never both consume the same webhooks.
    if (host.isBuiltin(row.id)) {
      try {
        await pool.query("DELETE FROM floq_plugin_packages WHERE id = $1", [row.id]);
        removeCache(pluginDir, row.id);
        superseded.push(row.id);
        log.info("plugin.package_superseded", { plugin: row.id, version: row.version });
      } catch (error) { log.warn("plugin.package_supersede_failed", { plugin: row.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }); }
      continue;
    }
    try {
      host.addInstalled(await loadDefinition(row, pluginDir), uiMeta(row.ui, sha));
      loaded.push(row.id);
    } catch (error) {
      broken.push(row.id);
      host.addBroken(row.id, row.id, error instanceof PackageError ? error.message : "The package could not be loaded.");
      log.warn("plugin.package_load_failed", { plugin: row.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }
  return superseded.length ? { loaded, broken, superseded } : { loaded, broken };
}
