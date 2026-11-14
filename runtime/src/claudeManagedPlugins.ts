import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { log } from "./logger.js";
import { copyHomeTree, openHomeDir, readHomeFile, SANDBOX_HOME, writeFileOwned } from "./shard.js";

/**
 * Claude Code plugins a user installs (`/plugin`, `claude plugin install`) get the same hooks as on a plain machine.
 *
 * Why: Floq ships Claude Code managed settings (/etc/claude-code/managed-settings.json, the native-subagent deny).
 * On a machine with managed settings, and for Team and Enterprise organizations, Claude Code seats its built-in
 * `cc-plugin-sec-default` module outermost and passes protected events (`session.compact`, prompt content, ...) on
 * past every plugin a person installed: "fast-jev-compaction: its session.compact hook was skipped". Only a plugin
 * that counts as the organization's own (a MANAGED plugin) runs hooks on those events.
 *
 * So at every Claude session start the runtime gives the user's sandbox its OWN managed settings (a root-owned folder
 * bound read-only at /etc/claude-code): Floq's base policy, plus every plugin the user enabled, as managed plugins
 * listed in `prependPlugins` ahead of `sec-default@builtin` (which keeps its seat right after them, for everything
 * else). Claude Code only seats a managed plugin when it is read in place from a LOCAL directory marketplace, so the
 * runtime keeps a root-owned snapshot of each such marketplace next to those settings (cloned from the source the user
 * added it from, refreshed at most hourly) and points the user's own registration of that marketplace at it (a
 * registration from another source would make Claude Code ignore the marketplace).
 *
 * Nothing to configure: install, enable or disable a plugin the normal way; it applies from the next session start.
 * Trade-off: any plugin the user (or one of their agents) enables now runs ahead of Floq's managed hooks, like on an
 * unmanaged machine. Verified with Claude Code 2.1.318.
 */

export const SEC_DEFAULT_ID = "sec-default@builtin";
/** Where the user's managed folder appears inside the sandbox. */
export const SANDBOX_MANAGED_DIR = "/etc/claude-code";
export const MANAGED_FILE = "managed-settings.json";
const REFRESH_MS = 60 * 60_000;

export interface MarketplaceRemote { url: string; ref?: string }
export interface PromotedPlugin { id: string; marketplace: string; /** marketplace folder as the agent sees it */ path: string }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GITHUB = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** Floq's base managed settings plus the promoted plugins. With none, the base is returned unchanged. */
export function buildClaudeManagedSettings(base: Record<string, unknown>, plugins: readonly PromotedPlugin[], options: { claudeAiConnectors?: boolean } = {}): Record<string, unknown> {
  // Connectors are on by default (Claude Code loads them natively): only "off" writes anything, as a managed key the agent cannot undo.
  const withConnectors = options.claudeAiConnectors === false ? { ...base, disableClaudeAiConnectors: true } : base;
  if (!plugins.length) return withConnectors;
  base = withConnectors;
  const enabled = { ...((base.enabledPlugins as Record<string, unknown> | undefined) ?? {}) };
  const markets = { ...((base.extraKnownMarketplaces as Record<string, unknown> | undefined) ?? {}) };
  for (const plugin of plugins) {
    enabled[plugin.id] = true;
    markets[plugin.marketplace] = { source: { source: "directory", path: plugin.path } };
  }
  return {
    ...base,
    enabledPlugins: enabled,
    extraKnownMarketplaces: markets,
    // The user's plugins first (they see every event, session.compact included), then the security default for everything else.
    prependPlugins: [...new Set(plugins.map((plugin) => plugin.id)), SEC_DEFAULT_ID],
  };
}

/** Where a registered marketplace can be cloned from: GitHub and https git sources only. */
export function remoteOf(entry: unknown): MarketplaceRemote | null {
  const source = (entry as { source?: Record<string, unknown> } | undefined)?.source;
  if (!source || typeof source !== "object") return null;
  const ref = typeof source.ref === "string" && REF.test(source.ref) ? source.ref : undefined;
  let url: string | null = null;
  if (source.source === "github" && typeof source.repo === "string" && GITHUB.test(source.repo)) url = "https://github.com/" + source.repo + ".git";
  else if (source.source === "git" && typeof source.url === "string" && /^https:\/\/[^\s#]+$/i.test(source.url)) url = source.url;
  if (!url) return null;
  return ref ? { url, ref } : { url };
}

function runGit(args: string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/root", GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Clones or refreshes a marketplace into `path` (as the runtime: read-only to agents). Git hooks are disabled. */
export function cloneMarketplace(remote: MarketplaceRemote, path: string, git: (args: string[]) => void = runGit): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  if (existsSync(join(path, ".git"))) {
    git(["-C", path, "fetch", "--depth", "1", "origin", remote.ref ?? "HEAD"]);
    git(["-C", path, "reset", "--hard", "FETCH_HEAD"]);
    git(["-C", path, "clean", "-fdx"]);
  } else {
    rmSync(path, { recursive: true, force: true });
    git(["clone", "--depth", "1", ...(remote.ref ? ["--branch", remote.ref] : []), remote.url, path]);
  }
}

/** Plugins the marketplace at `path` lists by a relative path (what Claude Code requires to seat it as managed). */
export function relativePlugins(path: string, marketplace: string): Set<string> {
  const manifestPath = join(path, ".claude-plugin", "marketplace.json");
  if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("marketplace.json must not be a symlink");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; plugins?: Array<{ name?: unknown; source?: unknown }> };
  if (manifest.name !== marketplace) throw new Error(`the marketplace is named "${String(manifest.name)}", not "${marketplace}"`);
  return new Set((manifest.plugins ?? []).filter((p) => typeof p.name === "string" && typeof p.source === "string" && p.source.startsWith("./")).map((p) => p.name as string));
}

/** A JSON object from the user's home, read confined (no symlinked component, regular file owned by the user); null otherwise. */
function readJson(home: string, path: string, uid: number | null): Record<string, unknown> | null {
  try {
    const file = readHomeFile(home, path, uid);
    if (!file) return null;
    const value = JSON.parse(file.text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}

/** Atomic rewrite that keeps the file's mode and hands it to the user, confined to the home (no symlink is followed, none is replaced through). */
function writeJsonKeepOwner(home: string, path: string, data: unknown, uid: number | null): void {
  const dir = openHomeDir(home, dirname(path));
  if (!dir) throw new Error("directory is missing");
  try {
    const target = join(dir.path, basename(path));
    const existing = lstatSync(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("refusing to rewrite a non-regular file");
    writeFileOwned(null, target, JSON.stringify(data, null, 2), uid ?? existing.uid, existing.mode & 0o777);
  } finally { dir.close(); }
}

export interface PromoteOptions {
  /** The user's home on the host. */
  home: string;
  /** The user's uid: files read from the home must belong to it, and rewritten ones are handed back to it. */
  uid?: number;
  /** Root-owned folder bound at /etc/claude-code in this user's sandbox. */
  managedDir: string;
  /** Floq's base managed settings (the image's /etc/claude-code/managed-settings.json). */
  base: Record<string, unknown>;
  /** The managed folder as the agent sees it (default /etc/claude-code). */
  sandboxDir?: string;
  git?: (args: string[]) => void;
  now?: () => number;
  /** The user's claude.ai connectors toggle (default on). Off writes `disableClaudeAiConnectors: true` into the managed settings. */
  claudeAiConnectors?: boolean;
}

/**
 * Writes the user's managed settings (base + their enabled plugins as managed, ahead of sec-default) and keeps the
 * marketplace snapshots current. Never throws for one plugin: a plugin that cannot be promoted stays a normal
 * user plugin. Returns the promoted plugins.
 */
export function promoteUserPlugins(options: PromoteOptions): PromotedPlugin[] {
  const { home, managedDir, base } = options;
  const sandboxDir = options.sandboxDir ?? SANDBOX_MANAGED_DIR;
  const now = options.now ?? Date.now;
  const pluginsDir = join(managedDir, "plugins");
  const originsDir = join(managedDir, "origins");
  for (const dir of [managedDir, pluginsDir, originsDir]) mkdirSync(dir, { recursive: true, mode: 0o755 });

  const settingsPath = join(home, ".claude", "settings.json");
  const knownPath = join(home, ".claude", "plugins", "known_marketplaces.json");
  const uid = options.uid ?? null;
  const settings = readJson(home, settingsPath, uid) ?? {};
  const known = readJson(home, knownPath, uid) ?? {};
  const enabled = Object.entries((settings.enabledPlugins as Record<string, unknown> | undefined) ?? {})
    .filter(([id, on]) => on === true && /^[^@]+@[^@]+$/.test(id))
    .map(([id]) => id);

  const promoted: PromotedPlugin[] = [];
  const done = new Map<string, Set<string> | null>();
  let knownChanged = false;
  let settingsChanged = false;
  for (const id of enabled) {
    const marketplace = id.split("@")[1];
    if (!NAME.test(marketplace) || marketplace === "builtin") continue;
    if (!done.has(marketplace)) done.set(marketplace, prepareMarketplace(marketplace));
    const listed = done.get(marketplace);
    if (listed?.has(id.split("@")[0])) promoted.push({ id, marketplace, path: sandboxDir + "/plugins/" + marketplace });
  }

  function prepareMarketplace(marketplace: string): Set<string> | null {
    const snapshot = join(pluginsDir, marketplace);
    const originFile = join(originsDir, marketplace + ".json");
    const sandboxPath = sandboxDir + "/plugins/" + marketplace;
    try {
      const entry = known[marketplace] as { source?: { source?: unknown; path?: unknown } } | undefined;
      const ours = entry?.source?.source === "directory" && entry.source.path === sandboxPath;
      const remote = ours ? remoteOf(readJson(managedDir, originFile, null)) : remoteOf(entry);
      if (!entry || (!ours && !remote)) {
        // A local folder in the user's home: snapshot it as is (no remote to refresh from).
        const localPath = typeof entry?.source?.path === "string" && entry.source.source === "directory" ? hostPathInHome(home, entry.source.path) : null;
        if (!localPath) return null;
        rmSync(snapshot, { recursive: true, force: true });
        // Confined copy: a symlinked component, or a symlink inside the tree, is never followed or copied (it would pull files from outside the home into the snapshot).
        copyHomeTree(home, localPath, snapshot, { skipNames: [".git"] });
      } else if (remote) {
        const refreshedAt = statSync(originFile, { throwIfNoEntry: false })?.mtimeMs;
        const stale = !existsSync(join(snapshot, ".git")) || refreshedAt === undefined || now() - refreshedAt > REFRESH_MS;
        if (stale) {
          try {
            cloneMarketplace(remote, snapshot, options.git);
            writeFileSync(originFile, JSON.stringify({ source: remote.ref ? { source: "git", url: remote.url, ref: remote.ref } : { source: "git", url: remote.url } }), { mode: 0o644 });
            const t = new Date(now()); utimesSync(originFile, t, t);
          } catch (error) {
            if (!existsSync(join(snapshot, ".git"))) throw error;
            log.warn("claude.plugin_snapshot_refresh_failed", { marketplace, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
          }
        }
      }
      const listed = relativePlugins(snapshot, marketplace);
      // Point the user's registration at the snapshot (Claude Code ignores a marketplace whose registered source differs from managed).
      if (!ours && entry) {
        known[marketplace] = { ...entry, source: { source: "directory", path: sandboxPath }, installLocation: sandboxPath };
        knownChanged = true;
      }
      const markets = settings.extraKnownMarketplaces as Record<string, unknown> | undefined;
      if (markets && marketplace in markets) {
        markets[marketplace] = { source: { source: "directory", path: sandboxPath } };
        settingsChanged = true;
      }
      return listed;
    } catch (error) {
      log.warn("claude.plugin_not_promoted", { marketplace, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      return null;
    }
  }

  if (knownChanged && existsSync(knownPath)) writeJsonKeepOwner(home, knownPath, known, options.uid ?? null);
  if (settingsChanged && existsSync(settingsPath)) writeJsonKeepOwner(home, settingsPath, settings, options.uid ?? null);

  const managed = buildClaudeManagedSettings(base, promoted, { claudeAiConnectors: options.claudeAiConnectors });
  const target = join(managedDir, MANAGED_FILE);
  const temporary = target + ".tmp-" + process.pid;
  writeFileSync(temporary, JSON.stringify(managed, null, 2) + "\n", { mode: 0o644 });
  renameSync(temporary, target);
  return promoted;
}

/** A `directory` marketplace path as Claude Code recorded it (sandbox view) -> the host path, only inside the home. */
function hostPathInHome(home: string, recorded: string): string | null {
  const sandboxHome = SANDBOX_HOME;
  const rel = recorded.startsWith(sandboxHome + "/") ? recorded.slice(sandboxHome.length + 1) : null;
  if (!rel) return null;
  const host = join(home, rel);
  const outside = relative(home, host);
  return outside === ".." || outside.startsWith(".." + sep) || outside.startsWith("/") ? null : host;
}
