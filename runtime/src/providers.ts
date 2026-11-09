import { spawnSync } from "node:child_process";
import type { Config, ModelEntry } from "./config.js";
import type { RuntimeProfile } from "./settings.js";
import type { ProviderId, ProviderInfo } from "./types.js";

/**
 * Environment variables that are safe and useful to forward into an agent PTY.
 * Everything else stays on the runtime process so unrelated host secrets never
 * reach an agent session.
 */
const SAFE_ENV_NAMES = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  bin: string;
  /** Args for a brand new conversation. `sessionId` is the Floq session UUID. */
  buildArgs(profile: RuntimeProfile, sessionId: string, model?: string | null): string[];
  /** Args that continue exactly one known conversation, or null if its id is not known. */
  resumeArgs(profile: RuntimeProfile, providerSessionId: string | null, model?: string | null): string[] | null;
  apiKeyEnv: string;
}

const definitions: Record<ProviderId, ProviderDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    // Claude accepts a chosen conversation id, so resume is exact.
    buildArgs: (profile, sessionId, model) => [
      ...(profile.claudeAutoApprove ? ["--dangerously-skip-permissions"] : []),
      ...(model ? ["--model", model] : []),
      "--session-id",
      sessionId,
    ],
    resumeArgs: (profile, id, model) =>
      id ? [...(profile.claudeAutoApprove ? ["--dangerously-skip-permissions"] : []), ...(model ? ["--model", model] : []), "--resume", id] : null,
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    apiKeyEnv: "OPENAI_API_KEY",
    buildArgs: (profile, _sessionId, model) => ["--no-daemon", ...(profile.codexAutoApprove ? ["--dangerously-bypass-approvals-and-sandbox"] : []), ...(model ? ["-m", model] : [])],
    // Codex picks its own uuid; the runtime reads it back from the session-private CODEX_HOME.
    resumeArgs: (profile, id, model) =>
      id ? ["--no-daemon", ...(profile.codexAutoApprove ? ["--dangerously-bypass-approvals-and-sandbox"] : []), ...(model ? ["-m", model] : []), "resume", id] : null,
  },
  // Plain login shell (bash from the image). A "resume" is simply a fresh shell in the same directory.
  shell: {
    id: "shell",
    label: "Shell",
    bin: "bash",
    apiKeyEnv: "",
    buildArgs: () => ["-l"],
    resumeArgs: () => ["-l"],
  },
};

export function getProviderDefinition(id: ProviderId, config: Config): ProviderDefinition {
  const base = definitions[id];
  return { ...base, bin: config.providers[id] };
}

const versionCache = new Map<string, { version: string | null; checkedAt: number }>();
const VERSION_TTL_MS = 60_000;

export function detectVersion(bin: string): { available: boolean; version: string | null } {
  const cached = versionCache.get(bin);
  if (cached && Date.now() - cached.checkedAt < VERSION_TTL_MS) {
    return { available: cached.version !== null, version: cached.version };
  }

  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
  });

  const version =
    result.status === 0
      ? (result.stdout || result.stderr || "").split("\n")[0]?.trim() || "unknown"
      : null;

  versionCache.set(bin, { version, checkedAt: Date.now() });
  return { available: version !== null, version };
}

export function listProviders(config: Config): ProviderInfo[] {
  return (Object.keys(definitions) as ProviderId[]).map((id) => {
    const definition = getProviderDefinition(id, config);
    const detected = detectVersion(definition.bin);
    return {
      id,
      label: definition.label,
      command: definition.bin,
      available: detected.available,
      version: detected.version,
      args: [],
      models:
        id === "shell"
          ? []
          : [{ id: "default", label: "Default", description: "Uses the CLI's default model", default: true }, ...config.models[id]],
    };
  });
}

/** Resolve a requested model id against the provider's list; null = CLI default. Throws on unknown ids. */
export function resolveModel(config: Config, provider: ProviderId, requested: unknown, availableModels?: ModelEntry[]): string | null {
  if (requested === undefined || requested === null || requested === "" || requested === "default") return null;
  if (provider === "shell") return "invalid";
  if (typeof requested !== "string" || !(availableModels ?? config.models[provider]).some((m) => m.id === requested)) return "invalid";
  return requested;
}

/**
 * Claude Code records a "fullscreen boot pending" pid in the shared ~/.claude.json and counts any entry whose
 * pid is gone (or equals its own) as a failed start, then falls back to the classic renderer. Every Floq session
 * runs in its own PID namespace over one shared home, and sessions are also killed by sleep/deploy, so that check
 * misfires. CLAUDE_CODE_NO_FLICKER=1 is the documented override: it forces fullscreen, skips the check and is
 * never recorded. A user's `/tui` relaunch clears it for that process only.
 */
export function forcedSessionEnv(provider: ProviderId, opts: { cacheDisable?: boolean } = {}): Record<string, string> {
  // DISABLE_AUTOUPDATER=1 is Claude Code's documented switch: the managed image's install is read-only for the
  // per-user uid, so self-update could only fail ("Auto-update failed"). Floq ships the CLI version itself.
  // CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 turns on Claude Code's function-hook surface: plugins whose hooks.json lists
  // "modules" (e.g. fast-jev-compaction) are read but never loaded without it. Users cannot set it themselves (CLAUDE.*
  // is a reserved secret name and the env allowlist drops it), so the runtime always provides it.
  // FLOQ_CACHE_DISABLE=1 is a debugging kill switch for Claude's prompt cache; forced here so a vault entry cannot flip it.
  return provider === "claude"
    ? { CLAUDE_CODE_NO_FLICKER: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", ...(opts.cacheDisable ? { DISABLE_PROMPT_CACHING: "1" } : {}) }
    : {};
}

export function buildSessionEnv(
  config: Config,
  provider: ProviderId,
  profile: RuntimeProfile,
  sessionId: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.passHostEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
  } else {
    const allowed = new Set([...SAFE_ENV_NAMES, ...config.sessionEnvAllow]);
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && allowed.has(key)) env[key] = value;
    }
  }

  // Agents sign in with the user's subscription login: the credential broker writes the CLI credential files.

  // The user is the commit author. Without any identity git errors as usual.
  if (profile.gitName) {
    env.GIT_AUTHOR_NAME = profile.gitName;
    env.GIT_COMMITTER_NAME = profile.gitName;
  }
  if (profile.gitEmail) {
    env.GIT_AUTHOR_EMAIL = profile.gitEmail;
    env.GIT_COMMITTER_EMAIL = profile.gitEmail;
  }
  // Read by the system commit-msg hook (empty = add nothing).
  env.FLOQ_GIT_COAUTHOR = profile.gitCoauthor;

  if (profile.githubToken) {
    env.GH_TOKEN = profile.githubToken;
    env.GITHUB_TOKEN = profile.githubToken;
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "credential.https://github.com.helper";
    env.GIT_CONFIG_VALUE_0 =
      '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';
  }

  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.LANG = env.LANG || "C.UTF-8";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  env.FLOQ_SESSION_ID = sessionId;
  env.FLOQ_PROVIDER = provider;
  delete env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
  Object.assign(env, forcedSessionEnv(provider, { cacheDisable: config.cacheDisable }));

  return env;
}
