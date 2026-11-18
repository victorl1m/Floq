import type { Config } from "./config.js";
import { validCredential, type CredentialData } from "./credentials.js";
import { conflict, type HttpError } from "./errors.js";
import type { ProviderId } from "./types.js";

export const PROVIDER_NOT_CONNECTED = "provider_not_connected";

/** What the guard needs to know about a user; the manager supplies these (tests pass fakes). */
export interface ProviderGuardDeps {
  config: Pick<Config, "passHostEnv" | "sessionEnvAllow">;
  /** Stored subscription credential (claude / codex); null when logged out or disconnected. */
  credential(userId: string, provider: "claude" | "codex"): Promise<CredentialData | null>;
  /** agy Google-login token present for this user. */
  antigravityLogin(userId: string): Promise<boolean>;
  /** Names of the vault secrets the user exposes as env vars. */
  vaultEnvNames(userId: string): Promise<Set<string>>;
  env?: NodeJS.ProcessEnv;
}

const PROVIDER_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", shell: "Shell" };
const API_KEY_ENV: Partial<Record<ProviderId, string>> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" };

export function providerNotConnected(provider: ProviderId): HttpError {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return conflict(label + " is not connected for this account. Sign in to " + label + " in Settings > Providers, then try again.", PROVIDER_NOT_CONNECTED);
}

/**
 * Whether a session of `provider` would start authenticated for this user.
 * - claude/codex: a valid stored login, or an API key the operator deliberately passes into sessions.
 * - antigravity: a Google login or GEMINI_API_KEY in the vault.
 * - shell: always. opencode: authenticates with any of many provider API keys, so there is no reliable signal and it is not gated.
 */
export async function providerConnected(deps: ProviderGuardDeps, userId: string, provider: ProviderId): Promise<boolean> {
  if (provider === "shell" || provider === "opencode") return true;
  if (provider === "antigravity") {
    if (await deps.antigravityLogin(userId).catch(() => false)) return true;
    return (await deps.vaultEnvNames(userId).catch(() => new Set<string>())).has("GEMINI_API_KEY");
  }
  const credential = await deps.credential(userId, provider).catch(() => null);
  if (credential && validCredential(provider, credential)) return true;
  const key = API_KEY_ENV[provider]!;
  const env = deps.env ?? process.env;
  return Boolean(env[key]) && (deps.config.passHostEnv || deps.config.sessionEnvAllow.includes(key));
}

export async function assertProviderConnected(deps: ProviderGuardDeps, userId: string, provider: ProviderId): Promise<void> {
  if (!(await providerConnected(deps, userId, provider))) throw providerNotConnected(provider);
}
