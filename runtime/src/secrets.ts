import type { Config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { badRequest } from "./errors.js";

/**
 * Shared secret helpers for keychains (keychains.ts): validation, AES-256-GCM sealing via the runtime primitive (crypto.ts,
 * key = FLOQ_ENCRYPTION_KEY, AAD = user:keychain:<scopeId>:name), env merging and redaction.
 */

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_SECRETS_PER_SESSION = 50;
/** Values shorter than this are not redacted from previews: they would mangle ordinary text. */
export const MIN_REDACT_CHARS = 4;

/**
 * Names that would change how the runtime, the CLIs or the shell behave, or that the platform itself injects
 * (see providers.ts SAFE_ENV_NAMES, buildSessionEnv and forcedSessionEnv, and manager.launch).
 */
const RESERVED = new RegExp(
  "^(?:" +
    [
      "PATH", "HOME", "SHELL", "USER", "LOGNAME", "LANG", "LC_.*", "TZ", "TMPDIR", "TEMP", "TMP", "TERM", "COLORTERM", "PWD", "OLDPWD", "SHLVL", "_",
      "XDG_.*", "LD_.*", "DYLD_.*", "NODE_.*", "GIT_.*", "GH_.*", "GITHUB_TOKEN", "SSL_CERT_.*", "HTTPS?_PROXY", "NO_PROXY",
      "FLOQ_.*", "ANTHROPIC_.*", "CLAUDE.*", "CODEX.*", "OPENAI_.*", "DISABLE_AUTOUPDATER", "BETTER_AUTH_.*", "DATABASE_URL",
    ].join("|") +
    ")$",
  "i",
);

export function isReservedSecretName(name: string): boolean {
  return RESERVED.test(name);
}

export function validateSecretName(name: unknown): string {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) throw badRequest("Name must match A-Z, 0-9, _ (max 64) and not start with a digit", "invalid_secret_name");
  if (isReservedSecretName(name)) throw badRequest(name + " is a reserved name", "reserved_secret_name");
  return name;
}

export function validateSecretValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw badRequest("value is required", "invalid_secret_value");
  if (value.includes("\0")) throw badRequest("value must not contain NUL bytes", "invalid_secret_value");
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw badRequest("value too large (max 16 KB)", "invalid_secret_value");
  return value;
}

export function secretAad(userId: string, scopeId: string, name: string): string {
  return userId + ":keychain:" + scopeId + ":" + name;
}

function requireKey(config: Pick<Config, "encryptionKey">): Buffer {
  const key = config.encryptionKey;
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Secrets are unavailable: no 32-byte encryption key is configured");
  return key;
}

/** Encrypt to the bytea payload (utf8 of crypto.ts `v1.iv.tag.data`). Fails closed without a key. */
export function sealSecret(config: Pick<Config, "encryptionKey">, userId: string, scopeId: string, name: string, value: string): Buffer {
  return Buffer.from(encryptSecret(requireKey(config), value, secretAad(userId, scopeId, name)), "utf8");
}

export function openSecret(config: Pick<Config, "encryptionKey">, userId: string, scopeId: string, name: string, payload: Buffer): string {
  return decryptSecret(requireKey(config), payload.toString("utf8"), secretAad(userId, scopeId, name));
}

/** Add secrets to a process env after the base env. Reserved names are never written, whatever the DB holds. */
export function mergeSecretEnv(env: Record<string, string>, secrets: Record<string, string>): Record<string, string> {
  for (const [name, value] of Object.entries(secrets)) {
    if (!SECRET_NAME.test(name) || isReservedSecretName(name)) continue;
    env[name] = value;
  }
  return env;
}

/** Exact-match redaction of secret values, longest first. Best effort: transformed values (base64, split) are not caught. */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  if (!text) return text;
  const entries = Object.entries(secrets).filter(([, v]) => v.length >= MIN_REDACT_CHARS).sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of entries) if (out.includes(value)) out = out.split(value).join("[secret:" + name + "]");
  return out;
}
