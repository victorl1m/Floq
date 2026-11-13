import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type pg from "pg";
import { parse as parseToml } from "smol-toml";
import type { Config } from "./config.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "./errors.js";
import { DEFAULT_LAUNCHER, MCP_FILE_SCRIPT, addToJsonConfig, describeMcp, specSecretNames, vaultUsage, type VaultLauncher, addToTomlConfig, mcpHelperError, normalizeMcpInput, removeFromJsonConfig, removeFromTomlConfig, sha256, isReservedMcpName, reconcileReservedMcp, type McpProvider, type McpServerSpec, type ReservedMcpState } from "./mcpConfig.js";
import { safeRelative, type ShardHandle } from "./shard.js";
import type { ShardService } from "./shards.js";

export interface SkillInfo { name: string; description: string; source: "home" | "bundled" | "project"; scope: "global" | "project"; provider: "claude" | "codex"; location: string; /** `plugin:<id>` for skills a plugin publishes into the bundled scope. */ origin?: string }
export interface McpServerInfo {
  name: string;
  provider: "claude" | "codex";
  scope: "global" | "project";
  source: "home" | "bundled" | "project";
  transport: "stdio" | "http" | "sse" | "unknown";
  command?: string;
  urlHost?: string;
  /** Shipped with the image (for example context7): it cannot be removed or replaced from the UI or CLI. */
  protected?: boolean;
  /** Env or header values come from the vault. Only the secret names are listed, never values. */
  usesSecrets?: boolean;
  secretNames?: string[];
}
/** What an install will run, for review. Names of env/header entries only, never their values. */
export interface McpReview { name: string; type: "stdio" | "http"; summary: string; envNames: string[]; headerNames: string[]; secrets: Array<{ target: string; secret: string }>; plaintext: string[] }
interface McpTarget { provider: McpProvider; cwd: string; parts: string[]; label: string; json: boolean }
const MAX_ENTRIES = 200;
/** Authoring and import limit for a SKILL.md. */
const MAX_SKILL_BYTES = 32 * 1024;
/** Listing limit: bundled third-party skills (skill-creator is ~33 KB) may be larger than what Floq lets users author or import. */
const MAX_LISTED_SKILL_BYTES = 64 * 1024;
const MAX_SKILL_PACKAGE_FILES = 120;
const MAX_SKILL_PACKAGE_BYTES = 512 * 1024;
const MAX_SKILL_PACKAGE_FILE_BYTES = 64 * 1024;
const MAX_MCP_CONFIG_BYTES = 256 * 1024;
/** Floq's own skills: always installed, never deletable, even when PREINSTALL_SKILLS is off. */
export const PROTECTED_SKILLS: readonly string[] = ["floq-orchestrate", "floq-vault", "floq-app-debug", "floq-setup"];
const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_SKILL_FILE_PART = /^[A-Za-z0-9._ -]{1,100}$/;
type WithUserShardActivity = <T>(userId: string, operation: (handle: ShardHandle) => Promise<T>) => Promise<T>;

// This code is constant; all user content is passed as base64 data. Run it with the
// shard driver's unprivileged sandbox so symlink races cannot turn a host-root write
// into an escape from the user's mounted home.
const INSTALL_SKILL_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
let fd = null;
let activeFile = null;
const createdFiles = [];
const createdDirs = [];
const fail = (code) => { process.stderr.write(code); process.exitCode = 1; };
try {
  const payload = JSON.parse(Buffer.from(process.argv[1] || "", "base64").toString("utf8"));
  if ((payload.provider !== "claude" && payload.provider !== "codex") || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.name) || !Array.isArray(payload.files) || payload.files.length < 1 || payload.files.length > 120 || process.argv.length !== payload.files.length + 2) throw new Error("UNSAFE");
  const root = fs.realpathSync(process.cwd());
  if (root !== path.resolve(process.cwd())) throw new Error("UNSAFE");
  const parentParts = payload.provider === "claude" ? [".claude", "skills"] : [".agents", "skills"];
  let current = root;
  for (const part of parentParts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o755 }); createdDirs.push(current); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(current) !== current) throw new Error("UNSAFE");
  }
  const directory = path.join(current, payload.name);
  fs.mkdirSync(directory, { mode: 0o755 });
  createdDirs.push(directory);
  let totalBytes = 0;
  for (let i = 0; i < payload.files.length; i++) {
    const item = payload.files[i];
    if (!item || typeof item.path !== "string" || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 65536) throw new Error("UNSAFE");
    const parts = item.path.split("/");
    if (!parts.length || parts.some((part) => !/^[A-Za-z0-9._ -]{1,100}$/.test(part) || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("UNSAFE");
    const contents = Buffer.from(process.argv[i + 2], "base64");
    if (contents.length !== item.bytes) throw new Error("UNSAFE");
    totalBytes += contents.length;
    if (totalBytes > 524288) throw new Error("UNSAFE");
    let parent = directory;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      try { fs.mkdirSync(parent, { mode: 0o755 }); createdDirs.push(parent); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(parent) !== parent) throw new Error("UNSAFE");
    }
    activeFile = path.join(parent, parts[parts.length - 1]);
    fd = fs.openSync(activeFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644);
    createdFiles.push(activeFile);
    let offset = 0;
    while (offset < contents.length) offset += fs.writeSync(fd, contents, offset, contents.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null; activeFile = null;
  }
  process.stdout.write("SKILL_CREATED");
} catch (error) {
  if (fd !== null) try { fs.closeSync(fd); } catch {}
  if (activeFile) try { fs.unlinkSync(activeFile); } catch {}
  for (const file of createdFiles.reverse()) try { fs.unlinkSync(file); } catch {}
  for (const directory of createdDirs.reverse()) try { fs.rmdirSync(directory); } catch {}
  fail(error && error.code === "EEXIST" ? "SKILL_EXISTS" : error && error.message === "UNSAFE" ? "SKILL_UNSAFE" : "SKILL_WRITE_FAILED");
}
`;

// Constant script too: removes whole skill directories as the user's unprivileged uid, never following symlinks.
const REMOVE_SKILL_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fail = (code) => { process.stderr.write(code); process.exitCode = 1; };
try {
  const rels = JSON.parse(Buffer.from(process.argv[1] || "", "base64").toString("utf8"));
  if (!Array.isArray(rels) || rels.length > 400) throw new Error("UNSAFE");
  const root = fs.realpathSync(process.cwd());
  for (const rel of rels) {
    if (typeof rel !== "string") throw new Error("UNSAFE");
    const parts = rel.split("/");
    if (parts.length < 3 || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw new Error("UNSAFE");
    let current = root;
    let missing = false;
    for (let i = 0; i < parts.length && !missing; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code === "ENOENT") { missing = true; break; } throw error; }
      if (i === parts.length - 1) {
        if (stat.isSymbolicLink()) { fs.unlinkSync(current); missing = true; }
        else if (!stat.isDirectory()) throw new Error("UNSAFE");
      } else if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("UNSAFE");
    }
    if (!missing) fs.rmSync(current, { recursive: true, force: true });
  }
  process.stdout.write("SKILL_REMOVED");
} catch (error) {
  fail(error && error.message === "UNSAFE" ? "SKILL_UNSAFE" : "SKILL_REMOVE_FAILED");
}
`;

export function parseSkillMetadata(raw: string): { name: string; description: string } | null {
  if (raw.length > MAX_LISTED_SKILL_BYTES) return null;
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const front = match[1];
  const scalar = (key: string) => {
    const m = front.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!m) return "";
    let value = m[1].trim();
    if (value === ">" || value === "|") {
      const rest = front.slice(front.indexOf(m[0]) + m[0].length);
      return rest.match(/^(?:\r?\n[ \t]+.+)+/)?.[0].split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(value === ">" ? " " : "\n") ?? "";
    }
    if (value.startsWith("\"")) {
      try { const parsed: unknown = JSON.parse(value); if (typeof parsed !== "string") return ""; value = parsed; }
      catch { return ""; }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) return "";
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.startsWith("{") || value.startsWith("[")) return "";
    return value;
  };
  const name = scalar("name");
  return name ? { name, description: scalar("description") } : null;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const HAS_PROC_FD = existsSync("/proc/self/fd");

/**
 * Proves, on an already-open descriptor, that it lives inside `root`. Path checks (lstat/realpath) before an open are a
 * race: the sandboxed agent controls the tree and can swap a checked intermediate directory for a symlink between the
 * check and the open. The kernel's view of the descriptor cannot be raced.
 */
function descriptorWithin(fd: number, root: string, path: string): boolean {
  let actual: string | null = null;
  if (HAS_PROC_FD) { try { actual = realpathSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, ""); } catch { return false; } }
  if (actual === null) {
    // No /proc (dev hosts): the path must still resolve to the very inode that was opened.
    try {
      const resolved = realpathSync(path);
      const opened = fstatSync(fd);
      const current = statSync(resolved);
      if (opened.dev !== current.dev || opened.ino !== current.ino) return false;
      actual = resolved;
    } catch { return false; }
  }
  return within(root, actual);
}

/** Opens `path` read-only without following a final symlink, then verifies the descriptor stays inside `root`. */
function openVerified(root: string, path: string, flags: number): number {
  const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  if (!descriptorWithin(fd, realpathSync(root), path)) { closeSync(fd); throw new Error("UNSAFE"); }
  return fd;
}

/** Lists a directory through a verified descriptor, so a swapped intermediate directory cannot redirect the listing. */
function readDirVerified(root: string, dir: string): Dirent[] {
  const fd = openVerified(root, dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { return readdirSync(HAS_PROC_FD ? `/proc/self/fd/${fd}` : dir, { withFileTypes: true }); }
  finally { closeSync(fd); }
}

function readBoundedRegularFile(path: string, maxBytes: number, root?: string): string | null {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    fd = root ? openVerified(root, path, constants.O_RDONLY) : openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) return null;
    return buffer.subarray(0, total).toString("utf8");
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function scanSkills(base: string, trustedRoot: string, source: SkillInfo["source"], provider: SkillInfo["provider"], location: string, scope: SkillInfo["scope"] = "global"): SkillInfo[] {
  try {
    const allowed = realpathSync(trustedRoot);
    const root = realpathSync(base);
    if (!within(allowed, root) || !lstatSync(base).isDirectory()) return [];
    const entries = readDirVerified(allowed, root).map((d) => d.name).slice(0, MAX_ENTRIES);
    const found: SkillInfo[] = [];
    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        const actualDir = realpathSync(dir);
        if (!within(root, actualDir) || !within(allowed, actualDir) || !lstatSync(dir).isDirectory()) continue;
        const path = join(dir, "SKILL.md");
        const actualFile = realpathSync(path);
        if (!within(root, actualFile) || !within(allowed, actualFile) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_LISTED_SKILL_BYTES) continue;
        const raw = readBoundedRegularFile(actualFile, MAX_LISTED_SKILL_BYTES, allowed);
        if (raw === null) continue;
        const info = parseSkillMetadata(raw);
        if (info) found.push({ ...info, source, scope, provider, location: `${location}/${entry}` });
      } catch { /* Ignore symlinks, unreadable entries, and malformed files. */ }
    }
    return found;
  } catch { return []; }
}

function scanCodexHomes(base: string, trustedRoot: string): SkillInfo[] {
  try {
    const allowed = realpathSync(trustedRoot);
    const root = realpathSync(base);
    if (!within(allowed, root) || !lstatSync(base).isDirectory()) return [];
    return readdirSync(root).slice(0, MAX_ENTRIES).flatMap((session) => {
      const dir = join(root, session);
      try {
        const actual = realpathSync(dir);
        if (!within(root, actual) || !within(allowed, actual) || !lstatSync(dir).isDirectory()) return [];
        return scanSkills(join(dir, "skills"), allowed, "home", "codex", `.floq/codex/${session}/skills`);
      } catch { return []; }
    });
  } catch { return []; }
}

export interface SkillFileEntry { path: string; size: number }
const MAX_VIEW_FILE_BYTES = 256 * 1024;
const MAX_VIEW_FILES = 200;
const MAX_VIEW_DEPTH = 5;

function safeViewParts(path: string): string[] {
  if (!path || path.length > 400 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) throw badRequest("Unsafe skill file path", "invalid_skill_path");
  const parts = path.split("/");
  if (parts.length > MAX_VIEW_DEPTH + 1 || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw badRequest("Unsafe skill file path", "invalid_skill_path");
  return parts;
}

/** Walks `parts` below `root` and rejects any symlink or non-directory on the way. Returns the canonical directory. */
function walkRealDirectory(root: string, parts: string[]): string {
  let current = realpathSync(root);
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) throw notFound("Skill folder is unavailable");
  }
  return current;
}

/**
 * Read-only view of one skill folder. `location` is a discovered skill location relative to `trustedRoot`.
 * Without `path` it lists regular files; with `path` it returns one UTF-8 text file. Never follows symlinks.
 */
export function readSkillFolder(trustedRoot: string, location: string, path?: string):
  { files: SkillFileEntry[] } | { path: string; size: number; content: string } {
  let dir: string;
  try { dir = walkRealDirectory(trustedRoot, safeViewParts(location)); }
  catch (error) { throw error instanceof HttpError ? error : notFound("Skill folder is unavailable"); }
  if (path === undefined) {
    const files: SkillFileEntry[] = [];
    const walk = (current: string, prefix: string, depth: number) => {
      for (const entry of readDirVerified(trustedRoot, current).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= MAX_VIEW_FILES) return;
        if (entry.isSymbolicLink() || /[\u0000-\u001f\u007f\\:]/.test(entry.name)) continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) { if (depth < MAX_VIEW_DEPTH) walk(full, `${prefix}${entry.name}/`, depth + 1); }
        else if (entry.isFile()) files.push({ path: `${prefix}${entry.name}`, size: lstatSync(full).size });
      }
    };
    try { walk(dir, "", 0); } catch { throw notFound("Skill folder is unavailable"); }
    return { files };
  }
  const parts = safeViewParts(path);
  let fd: number | undefined;
  try {
    const parent = walkRealDirectory(dir, parts.slice(0, -1));
    const file = join(parent, parts[parts.length - 1]);
    if (lstatSync(file).isSymbolicLink()) throw notFound("File is unavailable");
    fd = openVerified(trustedRoot, file, constants.O_RDONLY);
    const stat = fstatSync(fd);
    if (!stat.isFile() || realpathSync(file) !== file) throw notFound("File is unavailable");
    if (stat.size > MAX_VIEW_FILE_BYTES) throw new HttpError(413, "file_too_large", "File is too large to preview");
    const buffer = Buffer.allocUnsafe(MAX_VIEW_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_VIEW_FILE_BYTES) throw new HttpError(413, "file_too_large", "File is too large to preview");
    const bytes = buffer.subarray(0, total);
    if (bytes.includes(0)) throw new HttpError(415, "binary_file", "Binary files cannot be previewed");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new HttpError(415, "binary_file", "Binary files cannot be previewed"); }
    return { path, size: total, content };
  } catch (error) { throw error instanceof HttpError ? error : notFound("File is unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Skills the user deleted, as `provider:directory` keys. Honoured by seeding and by the bundled listing. */
export async function loadRemovedSkills(pool: Pick<pg.Pool, "query">, userId: string): Promise<Set<string>> {
  const result = await pool.query("SELECT provider, name FROM skill_removals WHERE user_id = $1", [userId]);
  return new Set((result.rows as Array<{ provider: string; name: string }>).map((row) => `${row.provider}:${row.name}`));
}

export function mergeSkillSources(bundled: SkillInfo[], home: SkillInfo[]): SkillInfo[] {
  const unique = new Map<string, SkillInfo>();
  for (const skill of [...bundled, ...home]) unique.set(`${skill.provider}:${skill.name.toLowerCase()}`, skill);
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Location prefix of plugin-published skills: `plugin:<id>/<folder>`. */
export const PLUGIN_SKILL_PREFIX = "plugin:";

export class SkillsService {
  /** Skill folders plugins publish into the bundled scope: pluginId -> directory holding the skill folders, and the folders to expose. */
  private readonly pluginSkillRoots = new Map<string, { root: string; names: string[] }>();

  /** Publishes (or, with `root: null`, withdraws) a plugin's skill folders. Listed read-only with source "bundled" and origin `plugin:<id>`. */
  setPluginSkills(pluginId: string, root: string | null, names: string[] = []): void {
    if (root === null || !names.length) this.pluginSkillRoots.delete(pluginId);
    else this.pluginSkillRoots.set(pluginId, { root, names });
  }

  private scanPluginSkills(provider?: "claude" | "codex"): SkillInfo[] {
    const out: SkillInfo[] = [];
    for (const [id, { root, names }] of this.pluginSkillRoots) {
      for (const p of ["claude", "codex"] as const) {
        if (provider && provider !== p) continue;
        for (const skill of scanSkills(root, root, "bundled", p, PLUGIN_SKILL_PREFIX + id)) {
          if (names.includes(basename(skill.location))) out.push({ ...skill, origin: PLUGIN_SKILL_PREFIX + id });
        }
      }
    }
    return out;
  }

  private pluginSkillRoot(location: string): { root: string; folder: string } | null {
    const m = /^plugin:([a-z][a-z0-9-]*)\/([A-Za-z0-9._-]{1,100})$/.exec(location);
    const entry = m ? this.pluginSkillRoots.get(m[1]) : undefined;
    return m && entry && entry.names.includes(m[2]) ? { root: entry.root, folder: m[2] } : null;
  }

  /** How MCP configs launch floq-vault; tests and local verification can point this at a script. */
  vaultLauncher: VaultLauncher = DEFAULT_LAUNCHER;
  constructor(
    private readonly config: Config,
    private readonly shards: ShardService,
    private readonly pool: pg.Pool,
    private readonly withShardActivity: WithUserShardActivity,
  ) {}
  /** Skills found in the user's mounted home. Per-session Codex homes come first so the stable locations win the merge. */
  private scanHome(handle: ShardHandle, provider?: "claude" | "codex"): SkillInfo[] {
    const root = realpathSync(handle.mountPath);
    const host = (path: string) => this.shards.driver.hostPath(handle, path);
    return [
      ...(provider === "claude" ? [] : scanCodexHomes(host(".floq/codex"), root)),
      ...(provider === "codex" ? [] : scanSkills(host(".claude/skills"), root, "home", "claude", ".claude/skills")),
      ...(provider === "claude" ? [] : scanSkills(host(".codex/skills"), root, "home", "codex", ".codex/skills")),
      ...(provider === "claude" ? [] : scanSkills(host(".agents/skills"), root, "home", "codex", ".agents/skills")),
    ];
  }

  /** Skills in the read-only image bundle. Without `raw`, PREINSTALL_SKILLS off leaves only the protected Floq skills. */
  private scanBundle(provider?: "claude" | "codex", raw = false): SkillInfo[] {
    try {
      const bundleRoot = realpathSync(this.config.skelDir);
      const found = [
        ...(provider === "codex" ? [] : scanSkills(join(bundleRoot, ".claude", "skills"), bundleRoot, "bundled", "claude", ".claude/skills")),
        ...(provider === "claude" ? [] : scanSkills(join(bundleRoot, ".codex", "skills"), bundleRoot, "bundled", "codex", ".codex/skills")),
      ];
      return raw || this.config.preinstallSkills ? found : found.filter((skill) => PROTECTED_SKILLS.includes(basename(skill.location)));
    } catch { return []; /* Bundled skills may not be installed in development or minimal deployments. */ }
  }

  async list(userId: string): Promise<{ skills: SkillInfo[]; homeScanned: boolean }> {
    const handle = this.shards.awakeHandle(userId);
    const homeSkills = handle ? this.scanHome(handle) : [];
    const bundled = this.scanBundle();
    const removed = bundled.length ? await loadRemovedSkills(this.pool, userId) : new Set<string>();
    return {
      skills: mergeSkillSources([...bundled.filter((skill) => !removed.has(`${skill.provider}:${basename(skill.location)}`)), ...this.scanPluginSkills()], homeSkills),
      homeScanned: Boolean(handle),
    };
  }

  async listProject(userId: string, projectId: string, provider?: "claude" | "codex"): Promise<{ skills: SkillInfo[] }> {
    return this.withShardActivity(userId, async (handle) => {
      const root = await this.projectRoot(userId, projectId, handle);
      const providers = provider ? [provider] : ["claude", "codex"] as const;
      const skills = providers.flatMap((id) => id === "claude"
        ? scanSkills(join(root, ".claude", "skills"), root, "project", "claude", ".claude/skills", "project")
        : scanSkills(join(root, ".agents", "skills"), root, "project", "codex", ".agents/skills", "project"));
      return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }

  /** Read-only file list or single text file of a discovered skill, scoped to the caller's own home, project, or the bundle. */
  async readSkillFiles(userId: string, input: { scope?: unknown; projectId?: unknown; provider?: unknown; source?: unknown; location?: unknown; path?: unknown }):
    Promise<{ files: SkillFileEntry[] } | { path: string; size: number; content: string }> {
    const { provider, location } = input;
    if (provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex");
    if (typeof location !== "string") throw badRequest("location is required");
    if (input.path !== undefined && typeof input.path !== "string") throw badRequest("path must be text");
    const path = input.path as string | undefined;
    if (input.scope === "project") {
      if (typeof input.projectId !== "string") throw badRequest("projectId is required");
      const projectId = input.projectId;
      return this.withShardActivity(userId, async (handle) => {
        const root = await this.projectRoot(userId, projectId, handle);
        const base = provider === "claude" ? ".claude/skills" : ".agents/skills";
        const known = scanSkills(join(root, base), root, "project", provider, base, "project");
        if (!known.some((skill) => skill.location === location)) throw notFound("Skill not found");
        return readSkillFolder(root, location, path);
      });
    }
    if (input.scope !== "global") throw badRequest("scope must be global or project");
    if (input.source !== "home" && input.source !== "bundled") throw badRequest("source must be home or bundled");
    const match = (skill: SkillInfo) => skill.provider === provider && skill.location === location;
    const pluginSkill = this.pluginSkillRoot(location);
    if (pluginSkill && this.scanPluginSkills(provider).some(match)) return readSkillFolder(realpathSync(pluginSkill.root), pluginSkill.folder, path);
    const readBundle = async (): Promise<ReturnType<typeof readSkillFolder> | null> => {
      if (!this.scanBundle(provider).some(match)) return null;
      if ((await loadRemovedSkills(this.pool, userId)).has(`${provider}:${basename(location)}`)) return null;
      return readSkillFolder(realpathSync(this.config.skelDir), location, path);
    };
    // Mounts the shard for the whole read, so a sleeping home never turns into "Skill not found".
    const readHome = async (): Promise<ReturnType<typeof readSkillFolder> | null> => {
      try {
        return await this.withShardActivity(userId, async (handle) => {
          if (!this.scanHome(handle, provider).some(match)) return null;
          return readSkillFolder(realpathSync(handle.mountPath), location, path);
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "shard_unavailable", "Your home could not be unlocked right now. Try again in a moment.");
      }
    };
    // The requested source goes first; the other is used only when its own scan confirms the same location.
    let shardError: HttpError | undefined;
    for (const source of input.source === "bundled" ? ["bundled", "home"] as const : ["home", "bundled"] as const) {
      try {
        const result = source === "bundled" ? await readBundle() : await readHome();
        if (result) return result;
      } catch (error) {
        if (error instanceof HttpError && error.code === "shard_unavailable") shardError = error;
        else throw error;
      }
    }
    throw shardError ?? notFound("Skill not found");
  }

  /**
   * Removes a skill for this user only. Home copies (all roots, including per-session Codex homes) are deleted from the
   * mounted home; a skill that also ships in the image bundle is recorded so seeding and listing never restore it.
   * The shared bundle itself is never touched. Floq's own skills are refused.
   */
  async deleteSkill(userId: string, input: { provider?: unknown; location?: unknown }): Promise<{ removed: number; hidden: boolean }> {
    const { provider, location } = input;
    if (provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex");
    if (typeof location !== "string") throw badRequest("location is required");
    if (location.startsWith(PLUGIN_SKILL_PREFIX)) throw new HttpError(403, "skill_protected", "Skills published by a plugin are removed by disabling the plugin");
    const name = safeViewParts(location).at(-1) as string;
    if (!SAFE_SKILL_FILE_PART.test(name)) throw badRequest("Unsafe skill name", "invalid_skill_path");
    if (PROTECTED_SKILLS.includes(name.toLowerCase())) throw new HttpError(403, "skill_protected", "Floq skills cannot be deleted");
    try {
      return await this.withShardActivity(userId, async (handle) => {
        const copies = this.scanHome(handle, provider).filter((skill) => basename(skill.location) === name);
        const bundled = this.scanBundle(provider, true).filter((skill) => basename(skill.location) === name);
        const confirmed = [...copies, ...bundled];
        if (!confirmed.some((skill) => skill.location === location)) throw notFound("Skill not found");
        if (confirmed.some((skill) => PROTECTED_SKILLS.includes(skill.name.toLowerCase()))) throw new HttpError(403, "skill_protected", "Floq skills cannot be deleted");
        if (bundled.length) {
          await this.pool.query("INSERT INTO skill_removals (user_id, provider, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [userId, provider, name]);
        }
        if (copies.length) await this.removeHomeCopies(handle, copies.map((skill) => skill.location));
        return { removed: copies.length, hidden: bundled.length > 0 };
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "shard_unavailable", "Your home could not be unlocked right now. Try again in a moment.");
    }
  }

  private async removeHomeCopies(handle: ShardHandle, locations: string[]): Promise<void> {
    const { exitCode, output } = await this.runInSandbox(handle, ".", REMOVE_SKILL_SCRIPT, [Buffer.from(JSON.stringify(locations), "utf8").toString("base64")], "skill_remove_timeout");
    if (exitCode === 0 && output.includes("SKILL_REMOVED")) return;
    if (output.includes("SKILL_UNSAFE")) throw badRequest("Skill path contains an unsafe entry", "invalid_skill");
    throw badRequest("Could not safely remove skill", "skill_remove_failed");
  }

  /** SKILL.md for a skill authored from name, description and instructions (the same rules for the app and `floq skills create`). */
  private buildSkillManifest(input: { name?: unknown; description?: unknown; instructions?: unknown }): { name: string; raw: string } {
    if (typeof input.name !== "string" || input.name.length > 64 || !SAFE_SKILL_NAME.test(input.name)) throw badRequest("name must be a lowercase skill slug (letters, digits, hyphens)", "invalid_skill");
    if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500 || /[\u0000-\u001f\u007f]/.test(input.description)) throw badRequest("description must be 1-500 printable characters", "invalid_skill");
    if (input.instructions !== undefined && typeof input.instructions !== "string") throw badRequest("instructions must be text", "invalid_skill");
    const instructions = typeof input.instructions === "string" ? input.instructions : "";
    if (instructions.includes("\u0000") || Buffer.byteLength(instructions, "utf8") > 28 * 1024) throw badRequest("instructions must be at most 28 KiB", "invalid_skill");
    const description = input.description.trim();
    const raw = `---\nname: ${input.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions.trim()}\n`;
    if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_BYTES) throw badRequest("generated SKILL.md exceeds 32 KiB", "invalid_skill");
    return { name: input.name, raw };
  }

  async addProjectSkill(userId: string, projectId: string, input: { provider?: unknown; name?: unknown; description?: unknown; instructions?: unknown }): Promise<{ skill: SkillInfo }> {
    if (input.provider !== "claude" && input.provider !== "codex") throw badRequest("provider must be claude or codex", "invalid_skill");
    const { raw } = this.buildSkillManifest(input);
    return this.addProjectSkillPackage(userId, projectId, { provider: input.provider, files: { "SKILL.md": raw } });
  }

  async addProjectSkillPackage(userId: string, projectId: string, input: { provider?: unknown; files?: unknown }): Promise<{ skill: SkillInfo }> {
    return this.addSkillPackage(userId, { scope: "project", projectId, provider: input.provider, files: input.files });
  }

  /**
   * `floq skills create`: authors a skill from instructions (a SKILL.md is generated) or from a whole package of text files.
   * Same validation, limits and sandboxed write as the app; global or project scope; refuses duplicates and Floq's protected skills.
   */
  async createSkill(userId: string, input: { scope?: unknown; projectId?: unknown; provider?: unknown; name?: unknown; description?: unknown; instructions?: unknown; files?: unknown; dryRun?: unknown }): Promise<{ skill: SkillInfo; files: Array<{ path: string; size: number }>; dryRun?: true }> {
    if (typeof input.name !== "string" || !SAFE_SKILL_NAME.test(input.name) || input.name.length > 64) throw badRequest("name must be a lowercase skill slug (letters, digits, hyphens)", "invalid_skill");
    const files = input.files !== undefined ? input.files : { "SKILL.md": this.buildSkillManifest(input).raw };
    return this.addSkillPackage(userId, { scope: input.scope === "global" ? "global" : "project", projectId: input.projectId, provider: input.provider, files, expectName: input.name, dryRun: input.dryRun === true });
  }

  /** Shared by the app (project), catalog imports and `floq skills create|add` (global or project). */
  async addSkillPackage(userId: string, input: { scope: "global" | "project"; projectId?: unknown; provider?: unknown; files?: unknown; expectName?: string; dryRun?: boolean }): Promise<{ skill: SkillInfo; files: Array<{ path: string; size: number }>; dryRun?: true }> {
    if (input.provider !== "claude" && input.provider !== "codex") throw badRequest("provider must be claude or codex", "invalid_skill");
    const provider = input.provider;
    if (!input.files || typeof input.files !== "object" || Array.isArray(input.files)) throw badRequest("Skill package must contain files", "invalid_skill_package");
    const entries = Object.entries(input.files as Record<string, unknown>);
    if (entries.length < 1 || entries.length > MAX_SKILL_PACKAGE_FILES) throw badRequest("Skill packages must contain 1-" + MAX_SKILL_PACKAGE_FILES + " files", "invalid_skill_package");
    const files: Array<{ path: string; contents: string }> = [];
    let totalBytes = 0;
    for (const [path, value] of entries) {
      if (!path || path.length > 240 || path.startsWith("/") || path.includes("\\") || path.includes(":") || /[\u0000-\u001f\u007f]/.test(path)) {
        throw badRequest("Skill package contains an unsafe file path", "invalid_skill_package");
      }
      const parts = path.split("/");
      if (parts.some((part) => !SAFE_SKILL_FILE_PART.test(part) || part === "." || part === ".." || /[. ]$/.test(part))) {
        throw badRequest("Skill package contains an unsafe file path", "invalid_skill_package");
      }
      if (typeof value !== "string") throw badRequest("Skill package files must be text", "invalid_skill_package");
      const size = Buffer.byteLength(value, "utf8");
      if (size > MAX_SKILL_PACKAGE_FILE_BYTES || value.includes("\u0000")) throw badRequest("Skill package files must be at most 64 KiB and contain no NUL bytes", "invalid_skill_package");
      totalBytes += size;
      if (totalBytes > MAX_SKILL_PACKAGE_BYTES) throw badRequest("Skill package must be at most 512 KiB", "invalid_skill_package");
      files.push({ path, contents: value });
    }
    const manifest = files.find((file) => file.path === "SKILL.md");
    if (!manifest || Buffer.byteLength(manifest.contents, "utf8") > MAX_SKILL_BYTES) throw badRequest("Skill package needs a SKILL.md file no larger than 32 KiB", "invalid_skill_package");
    const metadata = parseSkillMetadata(manifest.contents);
    if (!metadata || !SAFE_SKILL_NAME.test(metadata.name) || !metadata.description.trim() || metadata.description.length > 500 || /[\u0000-\u001f\u007f]/.test(metadata.description)) {
      throw badRequest("Skill package SKILL.md metadata is invalid", "invalid_skill_package");
    }
    if (input.expectName !== undefined && metadata.name !== input.expectName) throw badRequest("The name in SKILL.md (" + metadata.name + ") must match the skill name " + input.expectName, "invalid_skill_package");
    // Floq's own skills cannot be created, replaced or shadowed from a package, in any scope.
    if (PROTECTED_SKILLS.includes(metadata.name.toLowerCase())) throw new HttpError(403, "skill_protected", "Floq's own skills cannot be created or replaced");
    const summary = files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.contents, "utf8") }));
    return this.withShardActivity(userId, async (handle) => {
      const global = input.scope === "global";
      if (!global && typeof input.projectId !== "string") throw badRequest("projectId is required for a project skill", "invalid_skill");
      const root = global ? realpathSync(handle.mountPath) : await this.projectRoot(userId, input.projectId as string, handle);
      const location = (provider === "claude" ? ".claude/skills/" : ".agents/skills/") + metadata.name;
      try { lstatSync(join(root, location)); throw conflict("A skill with this name already exists", "skill_exists"); }
      catch (error) { if (error instanceof HttpError) throw error; }
      const skill: SkillInfo = { name: metadata.name, description: metadata.description, source: global ? "home" : "project", scope: input.scope, provider, location };
      if (input.dryRun === true) return { skill, files: summary, dryRun: true as const };
      await this.installProjectSkill(handle, root, { provider, name: metadata.name, files });
      // Deliberately recreating a skill the user once deleted must not stay hidden by the old removal record.
      if (global) await this.pool.query("DELETE FROM skill_removals WHERE user_id = $1 AND provider = $2 AND name = $3", [userId, provider, metadata.name]).catch(() => undefined);
      return { skill, files: summary };
    });
  }

  async listMcp(userId: string, scope: "global" | "project", projectId?: string, provider?: "claude" | "codex"): Promise<{ servers: McpServerInfo[]; homeScanned: boolean; malformedConfigs: number }> {
    if (scope === "project") {
      if (!projectId) throw badRequest("projectId is required for project MCP scope");
      return this.withShardActivity(userId, async (handle) => {
        const root = await this.projectRoot(userId, projectId, handle);
        return this.scanMcp(root, "project", [".mcp.json", ".codex/config.toml"], provider, false);
      });
    }
    const bundle = this.scanBundledMcp(provider);
    const protectedNames = new Set(bundle.servers.map((server) => `${server.provider}:${server.name.toLowerCase()}`));
    const mark = (servers: McpServerInfo[]) => servers.map((server) => protectedNames.has(`${server.provider}:${server.name.toLowerCase()}`) ? { ...server, protected: true } : server);
    const handle = this.shards.awakeHandle(userId);
    if (!handle) return { servers: mark(this.mergeMcp([], bundle.servers)), homeScanned: false, malformedConfigs: bundle.malformedConfigs };
    const home = this.scanGlobalMcp(handle.mountPath, provider);
    return { servers: mark(this.mergeMcp(home.servers, bundle.servers)), homeScanned: true, malformedConfigs: home.malformedConfigs + bundle.malformedConfigs };
  }

  // ---- MCP install / remove (shared by the UI routes and the in-sandbox `floq mcp` command) ----

  /** Config files for the chosen providers: Claude ~/.claude.json or project .mcp.json, Codex ~/.codex/config.toml or project .codex/config.toml. */
  private async mcpTargets(userId: string, handle: ShardHandle, scope: "global" | "project", projectId: unknown, providers: McpProvider[]): Promise<McpTarget[]> {
    let cwd = ".";
    if (scope === "project") {
      if (typeof projectId !== "string" || !projectId) throw badRequest("projectId is required for project scope", "invalid_mcp");
      const root = await this.projectRoot(userId, projectId, handle);
      const home = realpathSync(handle.mountPath);
      if (!within(home, root) || realpathSync(root) !== root) throw badRequest("Project checkout path is unsafe", "invalid_project");
      cwd = safeRelative(relative(home, root).split(sep).join("/"));
    }
    return providers.map((provider) => provider === "claude"
      ? { provider, cwd, parts: scope === "global" ? [".claude.json"] : [".mcp.json"], label: scope === "global" ? "The Claude config (~/.claude.json)" : "The project's .mcp.json", json: true }
      : { provider, cwd, parts: [".codex", "config.toml"], label: scope === "global" ? "The Codex config (~/.codex/config.toml)" : "The project's .codex/config.toml", json: false });
  }

  /**
   * Read-merge-write of one config file inside the unprivileged sandbox. `transform` gets the current text (null when the
   * file does not exist) and returns the new text, or null for "nothing to change". The write is refused and retried if
   * the file changed in between. Returns whether the file changed.
   */
  private async editMcpFile(handle: ShardHandle, target: { cwd: string; parts: string[] }, transform: (raw: string | null) => string | null, dryRun = false): Promise<boolean> {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = await this.runInSandbox(handle, target.cwd, MCP_FILE_SCRIPT, [encode({ op: "read", parts: target.parts })], "mcp_read_timeout", 600_000);
      let raw: string | null = null;
      let expect = "absent";
      if (!(read.exitCode === 0 && read.output.includes("MCP_ABSENT"))) {
        const match = /MCP_FILE:([0-9a-f]{64}):([A-Za-z0-9+/=]*)/.exec(read.output);
        if (read.exitCode !== 0 || !match) throw mcpHelperError(read.output);
        expect = match[1];
        const bytes = Buffer.from(match[2], "base64");
        try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw badRequest("That MCP config is not valid UTF-8 text, so Floq did not change it.", "mcp_config_malformed"); }
        if (sha256(bytes) !== expect) throw mcpHelperError("");
      }
      const next = transform(raw);
      if (next === null || next === raw) return false;
      if (dryRun) return true;
      const body = Buffer.from(next, "utf8");
      const chunks: string[] = [];
      for (let offset = 0; offset < body.length; offset += 48 * 1024) chunks.push(body.subarray(offset, offset + 48 * 1024).toString("base64"));
      const write = await this.runInSandbox(handle, target.cwd, MCP_FILE_SCRIPT, [encode({ op: "write", parts: target.parts, expect, bytes: body.length, chunks: chunks.length }), ...chunks], "mcp_write_timeout");
      if (write.exitCode === 0 && write.output.includes("MCP_WRITTEN")) return true;
      if (write.output.includes("MCP_CHANGED")) continue;
      throw mcpHelperError(write.output);
    }
    throw conflict("The MCP config kept changing while Floq updated it. Try again.", "mcp_config_busy");
  }

  private mcpScope(input: { scope?: unknown }): "global" | "project" {
    if (input.scope !== "global" && input.scope !== "project") throw badRequest("scope must be global or project", "invalid_mcp");
    return input.scope;
  }

  /**
   * Installs one MCP server into the chosen provider config(s). Refuses (changing nothing) on a duplicate name, a name
   * that is bundled with the image, or a malformed existing file. Responses carry only the redacted list entry, never env or header values.
   */
  async addMcp(userId: string, input: { scope?: unknown; projectId?: unknown; providers?: unknown; server?: unknown; config?: unknown; name?: unknown; dryRun?: unknown; knownSecrets?: unknown; allowPlaintext?: unknown }): Promise<{ servers: McpServerInfo[]; restartRequired: true; installed: McpReview; dryRun?: true }> {
    const scope = this.mcpScope(input);
    const rawProviders = input.providers === "both" ? ["claude", "codex"] : input.providers === "claude" || input.providers === "codex" ? [input.providers] : input.providers;
    if (!Array.isArray(rawProviders) || rawProviders.length < 1 || rawProviders.length > 2 || rawProviders.some((p) => p !== "claude" && p !== "codex") || new Set(rawProviders).size !== rawProviders.length) throw badRequest("providers must be claude, codex or both", "invalid_mcp");
    const providers = rawProviders as McpProvider[];
    const spec = normalizeMcpInput(input.server ?? input.config, input.name);
    if (isReservedMcpName(spec.name)) throw forbidden(spec.name + " is managed by Floq. Turn the browser on in Settings > Agents > Browser instead.");
    const secretNames = specSecretNames(spec);
    const installed: McpReview = {
      name: spec.name, type: spec.type, summary: describeMcp(spec),
      envNames: [...Object.keys(spec.env), ...Object.keys(spec.envSecrets)], headerNames: [...Object.keys(spec.headers), ...Object.keys(spec.headerSecrets)],
      secrets: [...Object.entries(spec.envSecrets).map(([target, secret]) => ({ target, secret })), ...Object.entries(spec.headerSecrets).flatMap(([target, template]) => [...template.matchAll(/\{\{([A-Z][A-Z0-9_]{0,63})\}\}/g)].map((m) => ({ target, secret: m[1] })))],
      plaintext: [...Object.keys(spec.env), ...Object.keys(spec.headers)],
    };
    if (spec.plaintextSensitive.length && input.allowPlaintext !== true) throw badRequest("These look like secrets and would be stored as plain text in the config: " + spec.plaintextSensitive.join(", ") + ". Reference a vault secret as ${vault:NAME} instead, or allow plain text explicitly.", "mcp_plaintext_secret");
    if (secretNames.length) {
      const known = new Set(Array.isArray(input.knownSecrets) ? input.knownSecrets : []);
      const missing = secretNames.filter((name) => !known.has(name));
      if (missing.length) throw badRequest("Vault secret " + missing.join(", ") + " does not exist. Create it first (Secrets page, or floq secrets add).", "mcp_secret_missing");
      if (spec.type === "http" && providers.includes("codex")) throw badRequest("Codex cannot read vault secrets for HTTP headers: its header helper runs without Floq's session credentials. Install this server for Claude Code only, or keep the header as plain text.", "mcp_secret_unsupported");
    }
    if (input.dryRun === true) return { servers: [], restartRequired: true, installed, dryRun: true };
    try {
      return await this.withShardActivity(userId, async (handle) => {
        const targets = await this.mcpTargets(userId, handle, scope, input.projectId, providers);
        if (scope === "global") {
          const bundled = new Set(this.scanBundledMcp().servers.map((server) => `${server.provider}:${server.name.toLowerCase()}`));
          for (const target of targets) if (bundled.has(`${target.provider}:${spec.name.toLowerCase()}`)) throw conflict(spec.name + " is bundled with Floq for " + target.provider + " and cannot be replaced", "mcp_protected");
        }
        const transformFor = (target: McpTarget) => (raw: string | null) => target.json ? addToJsonConfig(raw, spec, target.label, this.vaultLauncher) : addToTomlConfig(raw, spec, target.label, this.vaultLauncher);
        for (const target of targets) await this.editMcpFile(handle, target, transformFor(target), true);
        const done: McpTarget[] = [];
        try {
          for (const target of targets) { await this.editMcpFile(handle, target, transformFor(target)); done.push(target); }
        } catch (error) {
          for (const target of done.reverse()) await this.editMcpFile(handle, target, (raw) => target.json ? removeFromJsonConfig(raw, spec.name, target.label) : removeFromTomlConfig(raw, spec.name, target.label)).catch(() => undefined);
          throw error;
        }
        const source = scope === "global" ? "home" : "project";
        return { servers: targets.map((target) => ({ ...sanitizeMcp(spec.name, target.provider, scope, source, spec.type, spec.command, spec.url), ...(secretNames.length ? { usesSecrets: true, secretNames } : {}) })), restartRequired: true as const, installed };
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "shard_unavailable", "Your home could not be unlocked right now. Try again in a moment.");
    }
  }

  /**
   * Floq's own global MCP entry (the agent browser): present in both providers' configs when `desired`, absent otherwise. Idempotent;
   * an entry the user edited by hand is reported ("edited") and left alone. Works through the same sandboxed read-merge-write helper.
   */
  async syncReservedMcp(userId: string, spec: McpServerSpec, desired: boolean): Promise<{ claude: ReservedMcpState; codex: ReservedMcpState }> {
    try {
      return await this.withShardActivity(userId, async (handle) => {
        const out: Record<McpProvider, ReservedMcpState> = { claude: "unchanged", codex: "unchanged" };
        for (const target of await this.mcpTargets(userId, handle, "global", undefined, ["claude", "codex"])) {
          await this.editMcpFile(handle, target, (raw) => {
            const r = reconcileReservedMcp(raw, target.json ? "json" : "toml", spec, desired, target.label);
            out[target.provider] = r.state;
            return r.next;
          });
        }
        return out;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "shard_unavailable", "Your home could not be unlocked right now. Try again in a moment.");
    }
  }

  /**
   * Removes exactly one named entry from one provider's config for this scope; everything else in the file is kept.
   * For global Codex it also removes that same name from this user's per-session Codex homes, where copies are made.
   * Servers bundled with the image (for example context7) are refused.
   */
  async removeMcp(userId: string, input: { scope?: unknown; projectId?: unknown; provider?: unknown; name?: unknown }): Promise<{ removed: number; restartRequired: true }> {
    const scope = this.mcpScope(input);
    if (input.provider !== "claude" && input.provider !== "codex") throw badRequest("provider must be claude or codex", "invalid_mcp");
    const provider = input.provider;
    if (typeof input.name !== "string" || !input.name || input.name.length > 120 || /[\u0000-\u001f\u007f]/.test(input.name)) throw badRequest("name is invalid", "invalid_mcp");
    const name = input.name;
    if (isReservedMcpName(name)) throw forbidden(name + " is managed by Floq. Turn the browser off in Settings > Agents > Browser to remove it.");
    try {
      return await this.withShardActivity(userId, async (handle) => {
        if (scope === "global" && this.scanBundledMcp(provider).servers.some((server) => server.name.toLowerCase() === name.toLowerCase())) throw forbidden(name + " is bundled with Floq and cannot be removed");
        const [main] = await this.mcpTargets(userId, handle, scope, input.projectId, [provider]);
        const targets: McpTarget[] = [main];
        if (scope === "global" && provider === "codex") {
          const root = realpathSync(handle.mountPath);
          try {
            for (const entry of readdirSync(this.shards.driver.hostPath(handle, ".floq/codex")).slice(0, MAX_ENTRIES)) {
              if (!/^[A-Za-z0-9._-]{1,100}$/.test(entry) || entry === "." || entry === "..") continue;
              const raw = SkillsService.readSafeConfig(join(root, ".floq", "codex", entry, "config.toml"), root);
              if (raw !== null && parseCodexMcpToml(raw, "global", "home").servers.some((server) => server.name === name)) targets.push({ provider, cwd: ".", parts: [".floq", "codex", entry, "config.toml"], label: "A Codex session config", json: false });
              if (targets.length > 51) break;
            }
          } catch { /* no per-session Codex homes */ }
        }
        let removed = 0;
        for (const [index, target] of targets.entries()) {
          try {
            if (await this.editMcpFile(handle, target, (raw) => target.json ? removeFromJsonConfig(raw, name, target.label) : removeFromTomlConfig(raw, name, target.label))) removed += 1;
          } catch (error) { if (index === 0) throw error; /* a broken session copy must not block removing the real entry */ }
        }
        if (!removed) throw notFound("MCP server not found");
        return { removed, restartRequired: true as const };
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "shard_unavailable", "Your home could not be unlocked right now. Try again in a moment.");
    }
  }

  /** Removes a global skill by name through the same protected deleteSkill path as the UI. */
  async removeSkillByName(userId: string, name: unknown, provider?: unknown): Promise<{ removed: number; hidden: boolean; matched: number }> {
    if (typeof name !== "string" || !name || name.length > 100) throw badRequest("skill name is required", "invalid_skill");
    if (provider !== undefined && provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex");
    const { skills } = await this.list(userId);
    // Plugin-published entries are managed by the plugin (disabling it withdraws them); only real copies in the home or bundle are removed here.
    const matches = skills.filter((skill) => !skill.location.startsWith(PLUGIN_SKILL_PREFIX) && (skill.name === name || basename(skill.location) === name) && (!provider || skill.provider === provider));
    if (!matches.length) throw notFound("No global skill named " + name);
    let removed = 0;
    let hidden = false;
    for (const skill of matches) { const result = await this.deleteSkill(userId, { provider: skill.provider, location: skill.location }); removed += result.removed; hidden ||= result.hidden; }
    return { removed, hidden, matched: matches.length };
  }

  private async projectRoot(userId: string, projectId: string, handle: ShardHandle): Promise<string> {
    const result = await this.pool.query("SELECT cwd FROM floq_projects WHERE id=$1 AND user_id=$2", [projectId, userId]);
    const row = result.rows[0] as { cwd?: unknown } | undefined;
    if (!row || typeof row.cwd !== "string") throw notFound("Project not found");
    let relativePath: string;
    try { relativePath = safeRelative(row.cwd); }
    catch { throw badRequest("Project checkout path is invalid", "invalid_project"); }
    const home = realpathSync(handle.mountPath);
    let current = home;
    try {
      for (const part of relativePath.split("/").filter(Boolean)) {
        current = join(current, part);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe checkout path");
      }
      const actual = realpathSync(current);
      if (!within(home, actual) || actual !== resolve(current)) throw new Error("checkout escaped home");
      return actual;
    } catch {
      throw notFound("Project checkout is unavailable");
    }
  }

  private installProjectSkill(handle: ShardHandle, projectRoot: string, payload: { provider: "claude" | "codex"; name: string; files: Array<{ path: string; contents: string }> }): Promise<void> {
    const home = realpathSync(handle.mountPath);
    if (!within(home, projectRoot) || realpathSync(projectRoot) !== projectRoot) throw badRequest("Project checkout path is unsafe", "invalid_project");
    const cwd = safeRelative(relative(home, projectRoot).split(sep).join("/")) || ".";
    const metadata = {
      provider: payload.provider,
      name: payload.name,
      files: payload.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.contents, "utf8") })),
    };
    return this.runInSandbox(handle, cwd, INSTALL_SKILL_SCRIPT, [Buffer.from(JSON.stringify(metadata), "utf8").toString("base64"), ...payload.files.map((file) => Buffer.from(file.contents, "utf8").toString("base64"))], "skill_write_timeout").then(({ exitCode, output }) => {
      if (exitCode === 0 && output.includes("SKILL_CREATED")) return;
      if (output.includes("SKILL_EXISTS")) throw conflict("A skill with this name already exists", "skill_exists");
      if (output.includes("SKILL_UNSAFE")) throw badRequest("Skill path contains an unsafe entry", "invalid_skill");
      throw badRequest("Could not safely create project skill", "skill_write_failed");
    });
  }

  /** Runs one of the constant scripts above as the user's unprivileged uid and collects bounded output. */
  private runInSandbox(handle: ShardHandle, cwd: string, script: string, args: string[], timeoutCode: string, maxOutput = 8_192): Promise<{ exitCode: number | undefined; output: string }> {
    const child = this.shards.driver.spawn(handle, {
      file: process.execPath,
      args: ["-e", script, ...args],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: this.shards.driver.homePath(handle),
        TERM: "dumb",
      },
      cwd,
      cols: 120,
      rows: 24,
    });
    return new Promise((resolveRun, rejectRun) => {
      let output = "";
      let settled = false;
      const finish = (exitCode?: number, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        data.dispose();
        exit.dispose();
        if (error) rejectRun(error);
        else resolveRun({ exitCode, output });
      };
      const data = child.onData((chunk) => {
        output += chunk;
        if (output.length > maxOutput) {
          child.kill("SIGKILL");
          finish(undefined, badRequest("Skill helper returned too much output", "skill_write_failed"));
        }
      });
      const exit = child.onExit(({ exitCode }) => finish(exitCode));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(undefined, conflict("Skill operation timed out", timeoutCode));
      }, 15_000);
      timer.unref();
    });
  }

  private scanGlobalMcp(home: string, provider?: "claude" | "codex"): { servers: McpServerInfo[]; malformedConfigs: number } {
    const results: McpServerInfo[] = [];
    let malformedConfigs = 0;
    const root = realpathSync(home);
    if (!provider || provider === "claude") {
      const one = this.readJsonMcp(join(root, ".claude.json"), root, "claude", "global", "home");
      results.push(...one.servers); malformedConfigs += Number(one.malformed);
    }
    if (!provider || provider === "codex") {
      const one = this.readTomlMcp(join(root, ".codex", "config.toml"), root, "global", "home");
      results.push(...one.servers); malformedConfigs += Number(one.malformed);
      const codexHomes = join(root, ".floq", "codex");
      try {
        if (lstatSync(codexHomes).isDirectory() && !lstatSync(codexHomes).isSymbolicLink()) for (const entry of readdirSync(codexHomes).slice(0, MAX_ENTRIES)) {
          const privateHome = join(codexHomes, entry);
          try {
            if (lstatSync(privateHome).isSymbolicLink() || !lstatSync(privateHome).isDirectory() || !within(root, realpathSync(privateHome))) continue;
            const one = this.readTomlMcp(join(privateHome, "config.toml"), root, "global", "home");
            results.push(...one.servers); malformedConfigs += Number(one.malformed);
          } catch { /* ignore unsafe/missing per-session configs */ }
        }
      } catch { /* no private Codex homes */ }
    }
    return { servers: this.mergeMcp(results, []), malformedConfigs };
  }

  private scanBundledMcp(provider?: "claude" | "codex"): { servers: McpServerInfo[]; malformedConfigs: number } {
    let root: string;
    try { root = realpathSync(this.config.skelDir); }
    catch { return { servers: [], malformedConfigs: 0 }; }
    const results: McpServerInfo[] = [];
    let malformedConfigs = 0;
    if (!provider || provider === "claude") {
      const one = this.readJsonMcp(join(root, ".claude.json"), root, "claude", "global", "bundled");
      results.push(...one.servers); malformedConfigs += Number(one.malformed);
    }
    if (!provider || provider === "codex") {
      const one = this.readTomlMcp(join(root, ".codex", "config.toml"), root, "global", "bundled");
      results.push(...one.servers); malformedConfigs += Number(one.malformed);
    }
    return { servers: this.mergeMcp(results, []), malformedConfigs };
  }

  private scanMcp(root: string, scope: "project", files: string[], provider?: "claude" | "codex", homeScanned = true): { servers: McpServerInfo[]; homeScanned: boolean; malformedConfigs: number } {
    const results: McpServerInfo[] = [];
    let malformedConfigs = 0;
    for (const file of files) {
      if (file === ".mcp.json" && (!provider || provider === "claude")) {
        const one = this.readJsonMcp(join(root, file), root, "claude", scope, "project");
        results.push(...one.servers); malformedConfigs += Number(one.malformed);
      } else if (file === ".codex/config.toml" && (!provider || provider === "codex")) {
        const one = this.readTomlMcp(join(root, file), root, scope, "project");
        results.push(...one.servers); malformedConfigs += Number(one.malformed);
      }
    }
    return { servers: this.mergeMcp(results, []), homeScanned, malformedConfigs };
  }

  private readJsonMcp(path: string, trustedRoot: string, provider: "claude", scope: "global" | "project", source: McpServerInfo["source"]): { servers: McpServerInfo[]; malformed: boolean } {
    const raw = SkillsService.readSafeConfig(path, trustedRoot);
    if (raw === null) return { servers: [], malformed: false };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !("mcpServers" in parsed)) return { servers: [], malformed: false };
      const entries = (parsed as { mcpServers?: unknown }).mcpServers;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { servers: [], malformed: true };
      const servers: McpServerInfo[] = [];
      for (const [name, value] of Object.entries(entries).slice(0, MAX_ENTRIES)) {
        if (!name.trim() || name.length > 120 || !value || typeof value !== "object" || Array.isArray(value)) continue;
        const config = value as Record<string, unknown>;
        servers.push(sanitizeMcp(name, provider, scope, source, config.type, config.command, config.url, { args: config.args, headersHelper: config.headersHelper }));
      }
      return { servers, malformed: false };
    } catch { return { servers: [], malformed: true }; }
  }

  private readTomlMcp(path: string, trustedRoot: string, scope: "global" | "project", source: McpServerInfo["source"]): { servers: McpServerInfo[]; malformed: boolean } {
    const raw = SkillsService.readSafeConfig(path, trustedRoot);
    if (raw === null) return { servers: [], malformed: false };
    return parseCodexMcpToml(raw, scope, source);
  }

  static readSafeConfig(path: string, trustedRoot: string): string | null {
    try {
      const root = realpathSync(trustedRoot);
      const absolute = resolve(path);
      if (!within(root, absolute)) return null;
      const parts = relative(root, absolute).split(sep).filter(Boolean);
      if (!parts.length) return null;
      let current = root;
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) return null;
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MCP_CONFIG_BYTES || realpathSync(absolute) !== absolute) return null;
      const fd = openVerified(root, absolute, constants.O_RDONLY);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size > MAX_MCP_CONFIG_BYTES) return null;
        const buffer = Buffer.allocUnsafe(MAX_MCP_CONFIG_BYTES + 1);
        let total = 0;
        while (total < buffer.length) {
          const count = readSync(fd, buffer, total, buffer.length - total, total);
          if (count === 0) break;
          total += count;
        }
        if (total > MAX_MCP_CONFIG_BYTES) return null;
        return buffer.subarray(0, total).toString("utf8");
      } finally { closeSync(fd); }
    } catch { return null; }
  }

  private mergeMcp(primary: McpServerInfo[], fallback: McpServerInfo[]): McpServerInfo[] {
    const unique = new Map<string, McpServerInfo>();
    for (const server of [...fallback, ...primary]) unique.set(`${server.provider}:${server.name.toLowerCase()}`, server);
    return [...unique.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }
}

function sanitizeMcp(name: string, provider: McpServerInfo["provider"], scope: McpServerInfo["scope"], source: McpServerInfo["source"], type: unknown, command: unknown, rawUrl: unknown, extra?: { args?: unknown; headersHelper?: unknown }): McpServerInfo {
  const safeName = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  const url = typeof rawUrl === "string" ? safeUrl(rawUrl) : null;
  const transport: McpServerInfo["transport"] = type === "sse" ? "sse" : type === "http" || url ? "http" : typeof command === "string" ? "stdio" : "unknown";
    const sanitized: McpServerInfo = { name: safeName, provider, scope, source, transport };
  // Servers installed with vault secrets are wrapped in floq-vault; show the real command and which secrets (names only) they use.
  const usage = vaultUsage(command, extra?.args, extra?.headersHelper);
  if (usage) { sanitized.usesSecrets = true; sanitized.secretNames = usage.secretNames; if (usage.command) command = usage.command; }
  if (transport === "stdio" && typeof command === "string") {
    const commandName = basename(command.replace(/\\/g, "/")).slice(0, 80);
    if (/^[\w.+-]{1,80}$/.test(commandName)) sanitized.command = commandName;
  }
  if ((transport === "http" || transport === "sse") && url) sanitized.urlHost = url;
  return sanitized;
}

function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.slice(0, 253) || null;
  } catch { return null; }
}

/** Parse standard TOML; never expose args/env or raw parse errors. */
export function parseCodexMcpToml(raw: string, scope: "global" | "project", source: McpServerInfo["source"]): { servers: McpServerInfo[]; malformed: boolean } {
  if (Buffer.byteLength(raw, "utf8") > MAX_MCP_CONFIG_BYTES) return { servers: [], malformed: true };
  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    const entries = parsed.mcp_servers;
    if (entries === undefined) return { servers: [], malformed: false };
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { servers: [], malformed: true };
    const servers: McpServerInfo[] = [];
    let malformed = false;
    for (const [name, value] of Object.entries(entries as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
      if (!name.trim() || name.length > 120 || !value || typeof value !== "object" || Array.isArray(value)) { malformed = true; continue; }
      const config = value as Record<string, unknown>;
      for (const key of ["type", "command", "url"]) if (config[key] !== undefined && typeof config[key] !== "string") malformed = true;
      servers.push(sanitizeMcp(name, "codex", scope, source, config.type, config.command, config.url, { args: config.args, headersHelper: config.http_headers_helper }));
    }
    return { servers, malformed };
  } catch { return { servers: [], malformed: true }; }
}
