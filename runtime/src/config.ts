import { parseEmbeddingsMode } from "./embeddings.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULTS = {
  host: "0.0.0.0",
  port: 8787,
  workspaceRoot: "/workspaces",
  maxSessions: 256,
  outputBufferBytes: 4 * 1024 * 1024,
  maxBodyBytes: 64 * 1024,
  maxUploadBytes: 8 * 1024 * 1024 * 1024,
  defaultCols: 120,
  defaultRows: 32,
  idleTimeoutMs: 0,
  maxLifetimeMs: 0,
  allowedOrigins: ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"],
} as const;

export interface ModelEntry {
  id: string;
  label: string;
  description?: string;
}

/** "id:label,id:label" (label optional). Falls back to the defaults when unset or empty. */
function parseModels(value: string | undefined, defaults: ModelEntry[]): ModelEntry[] {
  const entries = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [id, ...label] = item.split(":");
      return { id: id.trim(), label: label.join(":").trim() || id.trim() };
    })
    .filter((entry) => /^[\w.\-[\]]{1,64}$/.test(entry.id));
  return entries.length > 0 ? entries : defaults;
}

// Static fallback catalog for selectable CLI models. Override with FLOQ_*_MODELS when deploying newer CLI builds.
const CLAUDE_MODELS: ModelEntry[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
  { id: "opusplan", label: "Opus Plan" },
];
const CODEX_MODELS: ModelEntry[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
  { id: "gpt-6-luna", label: "GPT-6 Luna" },
  { id: "gpt-6-sol", label: "GPT-6 Sol" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
];

// OpenCode ids are provider/model (models.dev); the provider key (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...) decides which work.
const OPENCODE_MODELS: ModelEntry[] = [
  { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "google/gemini-4-argon", label: "Gemini 4 Argon" },
  { id: "openrouter/anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 (OpenRouter)" },
  { id: "opencode/big-pickle", label: "Big Pickle (free)" },
];
// Antigravity --model takes the CLI's own label/id (gemini API-key auth).
const ANTIGRAVITY_MODELS: ModelEntry[] = [
  { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen" },
  { id: "gemini-4-argon", label: "Gemini 4 Argon" },
  { id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash" },
];

export interface ProviderBinConfig {
  claude: string;
  codex: string;
  opencode: string;
  antigravity: string;
  shell: string;
}

export type CacheTtl = "auto" | "5m" | "1h";

export interface Config {
  version: string;
  host: string;
  port: number;
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  /** 32-byte key used to encrypt user credentials at rest. */
  encryptionKey: Buffer;
  allowSignup: boolean;
  bootstrapAdminEmail: string | null;
  githubClientId: string | null;
  allowedOrigins: string[];
  /** Where encrypted user homes (ciphertext), mounts and metadata live. */
  shardRoot: string;
  /** Where decrypted homes are mounted. Must be under /mnt (see LinuxShardDriver). */
  mountRoot: string;
  shardDriver: "auto" | "linux" | "local";
  /** Agent memory (Redis). Null = feature off. The URL may carry a password: never log it, use redactRedisUrl(). */
  redisUrl: string | null;
  /** local (default) | openai | off: how memories are embedded for vector search. */
  embeddings: "local" | "openai" | "off";
  /** Preinstalled skills/MCP skeleton copied into each new user home. */
  skelDir: string;
  /** Seed and list third-party bundled skills (PREINSTALL_SKILLS). Floq's own skills are always kept. */
  preinstallSkills: boolean;
  /** Grace period after a user's last terminal sleeps before their home is locked. */
  shardLockDelayMs: number;
  workspaceRoot: string;
  maxSessions: number;
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  outputBufferBytes: number;
  maxBodyBytes: number;
  /** Per-file cap for streamed terminal attachments. */
  maxUploadBytes: number;
  passHostEnv: boolean;
  sessionEnvAllow: string[];
  providers: ProviderBinConfig;
  /** Co-author identity added to commits made in sessions ("" disables it for everyone). */
  gitCoauthor: string;
  /** Selectable models per provider (the "default" entry is added by /v1/info). */
  models: { claude: ModelEntry[]; codex: ModelEntry[]; opencode: ModelEntry[]; antigravity: ModelEntry[] };
  /** A non-empty operator-supplied catalog intentionally replaces runtime discovery. */
  codexModelsOverridden: boolean;
  /** OAuth endpoints and public client ids used to refresh subscription logins (extracted from the installed CLIs). */
  oauth: Record<"claude" | "codex", { tokenUrl: string; clientId: string }>;
  /**
   * Claude Code prompt-cache TTL for the main conversation (`promptCacheTtl`). `auto` writes nothing, so the CLI
   * picks (1h on a subscription within its limits, 5m otherwise). Forcing `1h` doubles the write cost on extra usage.
   */
  cacheTtl: CacheTtl;
  /** TTL for helper calls outside the main conversation (`subagentPromptCacheTtl`); `auto` writes nothing. */
  cacheHelperTtl: CacheTtl;
  /** Debug kill switch: sets DISABLE_PROMPT_CACHING=1 for Claude sessions. */
  cacheDisable: boolean;
  /** CLAUDE_CODE_EXPERIMENTAL_CODE_MODE for Claude sessions (default on; FLOQ_CLAUDE_CODE_MODE=0 turns it off). */
  claudeCodeMode: boolean;
  defaultCols: number;
  defaultRows: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Agent browser (docs/design/agent-browser.md §A.7). */
  browser: {
    /** FLOQ_AGENT_BROWSER=on|off; unset = auto (on when the pinned Chromium is installed). */
    mode: "on" | "off" | "auto";
    /** FLOQ_BROWSER_IDLE_MS: stop the daemon after this long with no agent connection and no viewer (default 10 min, 0 = never). */
    idleMs: number;
    /** FLOQ_BROWSER_MEM_MB: prlimit address-space cap for the daemon (default 0 = off; see the design notes on Chromium's address-space use). */
    memMb: number;
    /** FLOQ_BROWSER_ALLOW_PRIVATE=1: let web content reach loopback and private ranges when there is no per-user netns. */
    allowPrivate: boolean;
    /** FLOQ_BROWSER_SANDBOX: required = Chromium must start with its own sandbox or the browser fails; auto = fall back to --no-sandbox with a loud warning (default). */
    sandbox: "required" | "auto";
    /** Where the image keeps the pinned Chromium and VERSION.json (PLAYWRIGHT_BROWSERS_PATH, default /opt/floq/browsers). */
    browsersDir: string;
  };
}

function readInt(raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function readBool(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** FLOQ_CACHE_TTL / FLOQ_CACHE_HELPER_TTL: `5m` or `1h`; anything else (including unset) is `auto`. */
export function parseCacheTtl(raw: string | undefined): CacheTtl {
  const value = raw?.trim().toLowerCase();
  return value === "5m" || value === "1h" ? value : "auto";
}

function readList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseEncryptionKey(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("FLOQ_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64). Generate: openssl rand -hex 32");
  }
  return key;
}

function resolveWorkspaceRoot(raw: string): string {
  const absolute = resolve(raw);
  if (!existsSync(absolute)) {
    // The runtime creates this lazily, but surface a clear failure early.
    process.stderr.write(`[floq-runtime] workspace root does not exist yet: ${absolute}\n`);
  }
  return absolute;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authSecret = required(env, "BETTER_AUTH_SECRET");
  if (authSecret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");

  const authUrl = required(env, "BETTER_AUTH_URL").replace(/\/+$/, "");
  const allowedOrigins = readList(env.FLOQ_ALLOWED_ORIGINS, [...DEFAULTS.allowedOrigins]);
  if (allowedOrigins.includes("*")) {
    throw new Error("FLOQ_ALLOWED_ORIGINS must list explicit origins; '*' is not allowed");
  }

  const adminEmail = env.FLOQ_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();

  return {
    version: env.FLOQ_RUNTIME_VERSION?.trim() || "0.2.0",
    host: env.FLOQ_HOST?.trim() || DEFAULTS.host,
    port: readInt(env.FLOQ_PORT, DEFAULTS.port, 1, 65535),
    databaseUrl: required(env, "DATABASE_URL"),
    authSecret,
    authUrl,
    encryptionKey: parseEncryptionKey(required(env, "FLOQ_ENCRYPTION_KEY")),
    allowSignup: readBool(env.FLOQ_ALLOW_SIGNUP, false),
    bootstrapAdminEmail: adminEmail || null,
    // Default: the GitHub CLI's public OAuth client id (device flow enabled). Tokens appear as "GitHub CLI" in the
    // user's authorized apps. Set GITHUB_CLIENT_ID to use your own OAuth App instead.
    githubClientId: env.GITHUB_CLIENT_ID?.trim() || "178c6fc778ccc68e1d6a",
    allowedOrigins,
    shardRoot: resolve(env.FLOQ_SHARD_ROOT?.trim() || "/var/lib/floq/shards"),
    mountRoot: resolve(env.FLOQ_MOUNT_ROOT?.trim() || "/mnt/floq"),
    shardDriver: (["auto", "linux", "local"].includes(env.FLOQ_SHARD_DRIVER ?? "")
      ? env.FLOQ_SHARD_DRIVER
      : "auto") as Config["shardDriver"],
    preinstallSkills: readBool(env.PREINSTALL_SKILLS, false),
    redisUrl: env.FLOQ_REDIS_URL?.trim() || null,
    embeddings: parseEmbeddingsMode(env.FLOQ_EMBEDDINGS),
    skelDir: resolve(env.FLOQ_SKEL_DIR?.trim() || "/usr/local/share/floq/skel"),
    shardLockDelayMs: readInt(env.FLOQ_SHARD_LOCK_DELAY_MS, 30_000, 0),
    workspaceRoot: resolveWorkspaceRoot(env.FLOQ_WORKSPACE_ROOT?.trim() || DEFAULTS.workspaceRoot),
    maxSessions: readInt(env.FLOQ_MAX_SESSIONS, DEFAULTS.maxSessions, 1, 256),
    idleTimeoutMs: readInt(env.FLOQ_SESSION_IDLE_TIMEOUT_MS, DEFAULTS.idleTimeoutMs, 0),
    maxLifetimeMs: readInt(env.FLOQ_SESSION_MAX_LIFETIME_MS, DEFAULTS.maxLifetimeMs, 0),
    outputBufferBytes: readInt(
      env.FLOQ_OUTPUT_BUFFER_BYTES,
      DEFAULTS.outputBufferBytes,
      64 * 1024,
      256 * 1024 * 1024,
    ),
    maxBodyBytes: readInt(env.FLOQ_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes, 1024, 8 * 1024 * 1024),
    maxUploadBytes: readInt(env.FLOQ_MAX_UPLOAD_BYTES, DEFAULTS.maxUploadBytes, 1, 1024 ** 4),
    passHostEnv: readBool(env.FLOQ_PASS_ENV, false),
    sessionEnvAllow: readList(env.FLOQ_SESSION_ENV_ALLOW, []),
    providers: {
      claude: env.FLOQ_CLAUDE_BIN?.trim() || "claude",
      codex: env.FLOQ_CODEX_BIN?.trim() || "codex",
      opencode: env.FLOQ_OPENCODE_BIN?.trim() || "opencode",
      antigravity: env.FLOQ_ANTIGRAVITY_BIN?.trim() || "agy",
      shell: env.FLOQ_SHELL_BIN?.trim() || "bash",
    },
    models: {
      claude: parseModels(env.FLOQ_CLAUDE_MODELS, CLAUDE_MODELS),
      codex: parseModels(env.FLOQ_CODEX_MODELS, CODEX_MODELS),
      opencode: parseModels(env.FLOQ_OPENCODE_MODELS, OPENCODE_MODELS),
      antigravity: parseModels(env.FLOQ_ANTIGRAVITY_MODELS, ANTIGRAVITY_MODELS),
    },
    codexModelsOverridden: Boolean(env.FLOQ_CODEX_MODELS?.trim()),
    gitCoauthor: env.FLOQ_GIT_COAUTHOR === undefined ? "floqless <floq@flowless.app>" : env.FLOQ_GIT_COAUTHOR.trim(),
    oauth: {
      claude: {
        tokenUrl: env.FLOQ_CLAUDE_OAUTH_TOKEN_URL?.trim() || "https://platform.claude.com/v1/oauth/token",
        clientId: env.FLOQ_CLAUDE_OAUTH_CLIENT_ID?.trim() || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      },
      codex: {
        tokenUrl: env.FLOQ_CODEX_OAUTH_TOKEN_URL?.trim() || "https://auth.openai.com/oauth/token",
        clientId: env.FLOQ_CODEX_OAUTH_CLIENT_ID?.trim() || "app_EMoamEEZ73f0CkXaXp7hrann",
      },
    },
    cacheTtl: parseCacheTtl(env.FLOQ_CACHE_TTL),
    cacheHelperTtl: parseCacheTtl(env.FLOQ_CACHE_HELPER_TTL),
    cacheDisable: readBool(env.FLOQ_CACHE_DISABLE, false),
    claudeCodeMode: readBool(env.FLOQ_CLAUDE_CODE_MODE, true),
    defaultCols: readInt(env.FLOQ_DEFAULT_COLS, DEFAULTS.defaultCols, 20, 500),
    defaultRows: readInt(env.FLOQ_DEFAULT_ROWS, DEFAULTS.defaultRows, 5, 200),
    logLevel: (env.FLOQ_LOG_LEVEL?.trim() as Config["logLevel"]) || "info",
    browser: {
      mode: ((v) => (["1", "true", "yes", "on"].includes(v) ? "on" : ["0", "false", "no", "off"].includes(v) ? "off" : "auto"))((env.FLOQ_AGENT_BROWSER ?? "").trim().toLowerCase()),
      idleMs: readInt(env.FLOQ_BROWSER_IDLE_MS, 10 * 60_000, 0),
      memMb: readInt(env.FLOQ_BROWSER_MEM_MB, 0, 0, 1024 * 1024),
      allowPrivate: readBool(env.FLOQ_BROWSER_ALLOW_PRIVATE, false),
      sandbox: (env.FLOQ_BROWSER_SANDBOX ?? "").trim().toLowerCase() === "required" ? "required" : "auto",
      browsersDir: resolve(env.PLAYWRIGHT_BROWSERS_PATH?.trim() || "/opt/floq/browsers"),
    },
  };
}
