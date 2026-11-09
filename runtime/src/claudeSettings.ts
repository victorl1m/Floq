import type { CacheTtl } from "./config.js";
import { constants, fstatSync, lstatSync, openSync, readSync, closeSync } from "node:fs";

export interface ClaudeCacheOptions {
  ttl?: CacheTtl;
  helperTtl?: CacheTtl;
}

const CACHE_KEYS = ["promptCacheTtl", "subagentPromptCacheTtl"] as const;

/**
 * Keep startup consent aligned with the user's explicit Floq auto-approve choice.
 *
 * Cache TTLs are Claude Code (2.1.x) internal setting keys, written only when not `auto`. This file is read back and
 * rewritten on every launch, so what Floq wrote would look like the user's own choice next time. `floqManaged`
 * records the values Floq wrote: a key that still equals its recorded value is Floq's, and is removed or replaced when
 * the config changes (back to `auto`, or another TTL). A key with any other value was set by the user and is never
 * touched; it also takes precedence over the Floq default.
 */
export function claudeStartupSettings(settings: Record<string, unknown>, autoApprove: boolean, cache: ClaudeCacheOptions = {}): Record<string, unknown> {
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
  const previous = settings.floqManaged && typeof settings.floqManaged === "object" && !Array.isArray(settings.floqManaged) ? settings.floqManaged as Record<string, unknown> : {};
  const wanted: Record<(typeof CACHE_KEYS)[number], CacheTtl | undefined> = { promptCacheTtl: cache.ttl, subagentPromptCacheTtl: cache.helperTtl };
  const base: Record<string, unknown> = { ...settings };
  const managed: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  for (const key of CACHE_KEYS) {
    const want = wanted[key] && wanted[key] !== "auto" ? wanted[key] : undefined;
    const written = typeof previous[key] === "string" ? previous[key] : undefined;
    if (written !== undefined && base[key] === written) {
      if (want === written) { managed[key] = written; continue; } // unchanged: still Floq's
      delete base[key]; // Floq's leftover from an earlier config
    }
    if (want && base[key] === undefined) { defaults[key] = want; managed[key] = want; }
  }
  delete base.floqManaged;
  return {
    autoCompactEnabled: true,
    idleCompaction: true,
    ...defaults,
    ...base,
    ...(Object.keys(managed).length ? { floqManaged: managed } : {}),
    env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "150000", ...env },
    tui: "fullscreen",
    skipDangerousModePermissionPrompt: autoApprove,
  };
}

const MAX_CLAUDE_CONFIG_BYTES = 8 * 1024 * 1024;

/** Read Claude's mutable home config without following a user-created symlink. */
export function readClaudeProjectConfig(path: string): Record<string, unknown> {
  let fd: number;
  try {
    // O_NOFOLLOW closes the lstat/open race on platforms that support it. lstat
    // also gives a clear rejection on platforms where the flag is unavailable.
    if (lstatSync(path).isSymbolicLink()) throw new Error("Claude configuration must not be a symlink");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("Claude configuration must be a regular file");
    if (info.size > MAX_CLAUDE_CONFIG_BYTES) throw new Error("Claude configuration is too large");
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_CLAUDE_CONFIG_BYTES) throw new Error("Claude configuration is too large");
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Claude configuration");
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/** Trust only the exact managed checkouts selected for this launch. */
export function claudeProjectTrust(config: Record<string, unknown>, directories: string[]): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const projects = isRecord(config.projects) ? { ...config.projects } : {};
  for (const directory of directories) {
    projects[directory] = {
      ...(isRecord(projects[directory]) ? projects[directory] : {}),
      hasTrustDialogAccepted: true,
    };
  }
  return { ...config, projects };
}
