import { execFileSync } from "node:child_process";
import { existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./logger.js";

/**
 * Operator-trusted Claude Code plugins (FLOQ_CLAUDE_PLUGINS), installed for every user as MANAGED plugins.
 *
 * Why: Floq ships Claude Code managed settings (/etc/claude-code/managed-settings.json, the native-subagent deny).
 * On a machine with managed settings, and for Team and Enterprise organizations, Claude Code seats its built-in
 * `cc-plugin-sec-default` module outermost. It keeps the organization's hooks, prompt content and policy out of reach
 * of plugins a person installs, so a user-installed plugin's `session.compact` hook (for example fast-jev-compaction)
 * is skipped: "cc-plugin-sec-default runs first and sent the event on past it".
 *
 * The documented control is managed `prependPlugins`: managed plugins listed there run first, in order, and the
 * security default sits only where the list puts it. Floq lists the operator's trusted plugins first and then
 * `sec-default@builtin`, so the security default still guards Floq's policy against every other plugin. The plugins
 * are also enabled (managed `enabledPlugins`) for every user of the runtime, not only the one who installed them.
 *
 * Claude Code only seats a managed plugin's hooks module in the managed tier when the plugin is read in place from a
 * LOCAL directory marketplace (a cached copy of a remote one runs in the user tier, behind the security default). So
 * the runtime clones each trusted marketplace into a root-owned folder (CLAUDE_PLUGINS_DIR, read-only to agents),
 * refreshes it on every start, and declares it under managed `extraKnownMarketplaces` as `{source: "directory"}`.
 * Verified against Claude Code 2.1.318: the plugin loads "tier prepend" ahead of cc-plugin-sec-default and its
 * session.compact hook runs on /compact.
 *
 * Only the operator can set this (an environment variable of the runtime); agents cannot change managed settings.
 */

export const SEC_DEFAULT_ID = "sec-default@builtin";
export const DEFAULT_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";
export const DEFAULT_MANAGED_SETTINGS_BASE = "/usr/local/share/floq/claude-managed-settings.base.json";
export const CLAUDE_PLUGINS_DIR = "/usr/local/share/floq/claude-plugins";

export interface TrustedPlugin {
  /** plugin@marketplace */
  id: string;
  marketplace: string;
  /** Where the marketplace repository is cloned from. */
  remote: { url: string; ref?: string };
}

/** What the managed settings declare for one trusted marketplace once it is cloned locally. */
export interface LocalMarketplace { plugin: TrustedPlugin; path: string }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GITHUB = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

/** Parses `plugin@marketplace=owner/repo[#ref]` (or `=https://host/repo.git[#ref]`), comma-separated. Throws on a malformed entry. */
export function parseTrustedPlugins(raw: string | undefined): TrustedPlugin[] {
  if (!raw || !raw.trim()) return [];
  const out: TrustedPlugin[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const id = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const where = eq < 0 ? "" : entry.slice(eq + 1).trim();
    const [plugin, marketplace, extra] = id.split("@");
    if (!plugin || !marketplace || extra !== undefined || !NAME.test(plugin) || !NAME.test(marketplace)) {
      throw new Error(`FLOQ_CLAUDE_PLUGINS: "${entry}" must be plugin@marketplace=owner/repo`);
    }
    if (marketplace === "builtin") throw new Error(`FLOQ_CLAUDE_PLUGINS: "${id}" names a built-in plugin`);
    const hash = where.indexOf("#");
    const repo = hash < 0 ? where : where.slice(0, hash);
    const ref = hash < 0 ? undefined : where.slice(hash + 1);
    if (ref !== undefined && !REF.test(ref)) throw new Error(`FLOQ_CLAUDE_PLUGINS: "${entry}" has an invalid ref after "#"`);
    let url: string;
    if (GITHUB.test(repo)) url = "https://github.com/" + repo + ".git";
    else if (/^https:\/\/[^\s#]+$/i.test(repo)) url = repo;
    else throw new Error(`FLOQ_CLAUDE_PLUGINS: "${entry}" needs a git marketplace source after "=": a GitHub owner/repo or an https clone URL`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, marketplace, remote: ref ? { url, ref } : { url } });
  }
  return out;
}

/** Floq's base managed settings plus the locally cloned trusted plugins. With none, the base is returned unchanged. */
export function buildClaudeManagedSettings(base: Record<string, unknown>, locals: readonly LocalMarketplace[]): Record<string, unknown> {
  if (!locals.length) return base;
  const enabled = { ...((base.enabledPlugins as Record<string, unknown> | undefined) ?? {}) };
  const markets = { ...((base.extraKnownMarketplaces as Record<string, unknown> | undefined) ?? {}) };
  for (const { plugin, path } of locals) {
    enabled[plugin.id] = true;
    const source = { source: "directory", path };
    const known = markets[plugin.marketplace] as { source?: unknown } | undefined;
    if (known && JSON.stringify(known.source) !== JSON.stringify(source)) {
      throw new Error(`FLOQ_CLAUDE_PLUGINS: marketplace "${plugin.marketplace}" is given two different sources`);
    }
    markets[plugin.marketplace] = { source };
  }
  return {
    ...base,
    enabledPlugins: enabled,
    extraKnownMarketplaces: markets,
    // Trusted plugins first (they see every event, session.compact included), then the security default for everything else.
    prependPlugins: [...new Set(locals.map(({ plugin }) => plugin.id)), SEC_DEFAULT_ID],
  };
}

/** Plugins and marketplaces seated by the last sync; read when a Claude session starts (see reconcileUserMarketplaces). */
let active: LocalMarketplace[] = [];
export const activeManagedMarketplaces = (): readonly LocalMarketplace[] => active;

/**
 * Clones (or refreshes) one trusted marketplace into `dir/<marketplace>` as the runtime (root): agents can read it but
 * not change it. Git hooks are disabled for the clone. Checks that its marketplace.json has the expected name and lists
 * the plugin by a relative path (what Claude Code needs to treat it as the organization's). Throws on any problem.
 */
export function cloneMarketplace(plugin: TrustedPlugin, dir: string, git: (args: string[]) => void = runGit): string {
  const path = join(dir, plugin.marketplace);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  if (existsSync(join(path, ".git"))) {
    git(["-C", path, "fetch", "--depth", "1", "origin", plugin.remote.ref ?? "HEAD"]);
    git(["-C", path, "reset", "--hard", "FETCH_HEAD"]);
    git(["-C", path, "clean", "-fdx"]);
  } else {
    rmSync(path, { recursive: true, force: true });
    git(["clone", "--depth", "1", ...(plugin.remote.ref ? ["--branch", plugin.remote.ref] : []), plugin.remote.url, path]);
  }
  const manifestPath = join(path, ".claude-plugin", "marketplace.json");
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("marketplace.json must not be a symlink");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; plugins?: Array<{ name?: unknown; source?: unknown }> };
  if (manifest.name !== plugin.marketplace) throw new Error(`the marketplace is named "${String(manifest.name)}", not "${plugin.marketplace}"`);
  const [pluginName] = plugin.id.split("@");
  const entry = manifest.plugins?.find((item) => item.name === pluginName);
  if (!entry) throw new Error(`the marketplace does not list a plugin named "${pluginName}"`);
  if (typeof entry.source !== "string" || !entry.source.startsWith("./")) throw new Error(`"${pluginName}" must be listed by a relative path ("./…") to run in the managed tier`);
  return path;
}

function runGit(args: string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/root", GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * A user who registered the same marketplace from another source (e.g. `claude plugin marketplace add owner/repo`
 * before the operator trusted it) makes Claude Code ignore the marketplace everywhere ("its source doesn't match its
 * extraKnownMarketplaces entry"), so the managed plugin would not load for them. At each Claude session start the
 * runtime drops that user's conflicting registration; the managed one takes over. Returns the names it removed.
 */
export function reconcileUserMarketplaces(home: string, locals: readonly LocalMarketplace[]): string[] {
  if (!locals.length) return [];
  const removed = new Set<string>();
  const want = new Map(locals.map(({ plugin, path }) => [plugin.marketplace, path]));
  const conflicts = (entry: unknown, name: string): boolean => {
    const source = (entry as { source?: { source?: unknown; path?: unknown } } | undefined)?.source;
    return !!source && !(source.source === "directory" && source.path === want.get(name));
  };
  const edit = (path: string, change: (data: Record<string, unknown>) => boolean) => {
    let data: Record<string, unknown>;
    try {
      if (lstatSync(path).isSymbolicLink()) return;
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch { return; }
    if (!data || typeof data !== "object" || Array.isArray(data) || !change(data)) return;
    const temporary = path + ".floq-" + process.pid;
    writeFileSync(temporary, JSON.stringify(data, null, 2));
    const owner = lstatSync(path);
    try { lchownSync(temporary, owner.uid, owner.gid); } catch { /* best effort */ }
    renameSync(temporary, path);
  };
  edit(join(home, ".claude/plugins/known_marketplaces.json"), (data) => {
    let changed = false;
    for (const name of want.keys()) if (name in data && conflicts(data[name], name)) { delete data[name]; removed.add(name); changed = true; }
    return changed;
  });
  edit(join(home, ".claude/settings.json"), (data) => {
    const markets = data.extraKnownMarketplaces as Record<string, unknown> | undefined;
    if (!markets || typeof markets !== "object") return false;
    let changed = false;
    for (const name of want.keys()) if (name in markets && conflicts(markets[name], name)) { delete markets[name]; removed.add(name); changed = true; }
    return changed;
  });
  return [...removed];
}

/**
 * At startup: rewrite the managed settings file from the image's base copy and FLOQ_CLAUDE_PLUGINS. Never throws:
 * a bad value is logged and the base settings are written, so the native-subagent policy is always in force.
 */
export function syncClaudeManagedSettings(options: { raw: string | undefined; basePath?: string; targetPath?: string; pluginsDir?: string; git?: (args: string[]) => void }): TrustedPlugin[] {
  const basePath = options.basePath ?? DEFAULT_MANAGED_SETTINGS_BASE;
  const targetPath = options.targetPath ?? DEFAULT_MANAGED_SETTINGS_PATH;
  const pluginsDir = options.pluginsDir ?? CLAUDE_PLUGINS_DIR;
  active = [];
  let base: Record<string, unknown>;
  try {
    base = JSON.parse(readFileSync(basePath, "utf8")) as Record<string, unknown>;
  } catch {
    // Older images (or local development) have no base copy: leave the managed settings as they are.
    if (options.raw?.trim()) log.warn("claude.managed_plugins_no_base", { basePath });
    return [];
  }
  let plugins: TrustedPlugin[] = [];
  let locals: LocalMarketplace[] = [];
  let settings = base;
  try {
    plugins = parseTrustedPlugins(options.raw);
    for (const plugin of plugins) {
      try { locals.push({ plugin, path: cloneMarketplace(plugin, pluginsDir, options.git) }); }
      catch (error) { log.error("claude.managed_plugin_unavailable", { plugin: plugin.id, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }); }
    }
    settings = buildClaudeManagedSettings(base, locals);
  } catch (error) {
    log.error("claude.managed_plugins_invalid", { error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    locals = [];
    settings = base;
  }
  plugins = locals.map(({ plugin }) => plugin);
  const temporary = targetPath + ".tmp-" + process.pid;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o644 });
    renameSync(temporary, targetPath);
    active = locals;
    if (plugins.length) log.info("claude.managed_plugins", { plugins: plugins.map((plugin) => plugin.id) });
  } catch (error) {
    rmSync(temporary, { force: true });
    log.warn("claude.managed_settings_write_failed", { targetPath, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    return [];
  }
  return plugins;
}
