import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { badRequest, conflict, notFound, tooMany, unauthorized } from "./errors.js";
import { log } from "./logger.js";

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRETS = 100;
const MAX_VALUE_BYTES = 16 * 1024;
/** Names that would change how the runtime or the agents behave if injected as env vars. */
const RESERVED = /^(PATH|HOME|SHELL|USER|LOGNAME|LANG|LC_.*|TERM|COLORTERM|TZ|TMPDIR|PWD|OLDPWD|LD_.*|NODE_.*|GIT_.*|GH_TOKEN|GITHUB_TOKEN|CODEX_HOME|OPENCODE_(DB|CONFIG.*|PERMISSION|DISABLE_.*|AUTH_CONTENT)|AGY_.*|ANTIGRAVITY_.*|ANTHROPIC_.*|ENABLE_CLAUDEAI_MCP_SERVERS|CLAUDE_CODE_I_ACCEPT_CROSS_ORG_DATA_RISK|OPENAI_.*|FLOQ_.*|BETTER_AUTH_.*|DATABASE_URL|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;

export type Exposure = "tool" | "env";

export interface SecretInfo {
  name: string;
  description: string;
  expose: Exposure;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface PutSecret {
  value?: string;
  description?: string;
  expose?: Exposure;
}

export interface PatchSecret {
  name?: unknown;
  description?: unknown;
  value?: unknown;
  expose?: unknown;
}

interface TokenScope {
  userId: string;
  sessionId: string;
  hits: number[];
}

/**
 * Per-user secret vault. Values are encrypted at rest and write-only over the public API:
 * they only leave the runtime through (a) env injection for secrets the user marked `env`, or
 * (b) the in-sandbox `floq-vault` CLI, which authenticates with a per-session token.
 */
export class Vault {
  private readonly tokens = new Map<string, TokenScope>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {}

  private aad(userId: string, name: string): string {
    return userId + ":vault:" + name;
  }

  async list(userId: string): Promise<SecretInfo[]> {
    const result = await this.pool.query(
      "SELECT name, description, expose, created_at, updated_at, last_used_at FROM vault_secrets WHERE user_id = $1 ORDER BY name",
      [userId],
    );
    return result.rows.map((r) => ({
      name: r.name,
      description: r.description,
      expose: r.expose,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    }));
  }

  async put(userId: string, name: string, input: PutSecret): Promise<SecretInfo[]> {
    if (!NAME.test(name)) throw badRequest("Name must look like MY_SECRET (A-Z, 0-9, _; max 64)", "invalid_name");
    if (RESERVED.test(name)) throw badRequest(name + " is a reserved name", "reserved_name");
    const expose = input.expose ?? "tool";
    if (expose !== "tool" && expose !== "env") throw badRequest("expose must be 'tool' or 'env'");
    const description = (input.description ?? "").trim().slice(0, 300);
    if (/[\0]/.test(description)) throw badRequest("description is invalid");

    const existing = await this.pool.query("SELECT 1 FROM vault_secrets WHERE user_id = $1 AND name = $2", [userId, name]);
    if (!existing.rowCount) {
      if (typeof input.value !== "string" || input.value.length === 0) throw badRequest("value is required");
      const count = await this.pool.query("SELECT count(*)::int AS n FROM vault_secrets WHERE user_id = $1", [userId]);
      if (count.rows[0].n >= MAX_SECRETS) throw tooMany("Secret limit reached (" + MAX_SECRETS + ")");
    }
    if (input.value !== undefined) {
      if (typeof input.value !== "string" || input.value.length === 0) throw badRequest("value must be a non-empty string");
      if (Buffer.byteLength(input.value) > MAX_VALUE_BYTES) throw badRequest("value too large (max 16 KB)");
      await this.pool.query(
        `INSERT INTO vault_secrets (user_id, name, description, expose, value_enc) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, name) DO UPDATE SET description = $3, expose = $4, value_enc = $5, updated_at = now()`,
        [userId, name, description, expose, encryptSecret(this.config.encryptionKey, input.value, this.aad(userId, name))],
      );
    } else {
      await this.pool.query(
        "UPDATE vault_secrets SET description = $3, expose = $4, updated_at = now() WHERE user_id = $1 AND name = $2",
        [userId, name, description, expose],
      );
    }
    await this.audit(userId, null, name, "put");
    return this.list(userId);
  }

  /**
   * Create-only variant used by the in-sandbox `floq secrets add`: never updates, exposure is always "tool"
   * (the agent can use the value through `floq-vault run` but never read it). A duplicate name is a conflict.
   * The value is only ever encrypted; it is not logged, audited or returned.
   */
  async create(userId: string, sessionId: string | null, input: { name?: unknown; value?: unknown; description?: unknown }): Promise<SecretInfo[]> {
    const name = this.validateName(input.name);
    const description = input.description === undefined ? "" : this.validateDescription(input.description);
    if (typeof input.value !== "string" || input.value.length === 0) throw badRequest("value is required", "invalid_secret");
    if (Buffer.byteLength(input.value) > MAX_VALUE_BYTES) throw badRequest("value too large (max 16 KB)", "invalid_secret");
    const count = await this.pool.query("SELECT count(*)::int AS n FROM vault_secrets WHERE user_id = $1", [userId]);
    if (count.rows[0].n >= MAX_SECRETS) throw tooMany("Secret limit reached (" + MAX_SECRETS + ")");
    try {
      await this.pool.query(
        "INSERT INTO vault_secrets (user_id, name, description, expose, value_enc) VALUES ($1,$2,$3,'tool',$4)",
        [userId, name, description, encryptSecret(this.config.encryptionKey, input.value, this.aad(userId, name))],
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === "23505") throw conflict("A secret named " + name + " already exists. Agents cannot change existing secrets; the owner can edit it in Floq > Vault.", "secret_exists");
      throw error;
    }
    await this.audit(userId, sessionId, name, "create");
    return this.list(userId);
  }

  async patch(userId: string, originalName: string, input: PatchSecret): Promise<SecretInfo[]> {
    this.validateName(originalName);
    const requestedName = input.name === undefined ? originalName : this.validateName(input.name);
    if (input.name === undefined && input.description === undefined && input.value === undefined && input.expose === undefined) {
      throw badRequest("No secret changes supplied", "invalid_secret");
    }
    const client = await this.pool.connect();
    let auditName = originalName;
    let renamed = false;
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT name,description,expose,value_enc FROM vault_secrets WHERE user_id=$1 AND name=$2 FOR UPDATE",
        [userId, originalName],
      );
      const old = found.rows[0] as { name: string; description: string; expose: Exposure; value_enc: string } | undefined;
      if (!old) throw notFound("Secret not found");

      const name = requestedName;
      const description = input.description === undefined ? old.description : this.validateDescription(input.description);
      const expose = input.expose === undefined ? old.expose : this.validateExposure(input.expose);
      let valueEnc = old.value_enc;
      if (input.value !== undefined) {
        if (typeof input.value !== "string" || input.value.length === 0) throw badRequest("value must be a non-empty string");
        if (Buffer.byteLength(input.value) > MAX_VALUE_BYTES) throw badRequest("value too large (max 16 KB)");
        valueEnc = encryptSecret(this.config.encryptionKey, input.value, this.aad(userId, name));
      } else if (name !== originalName) {
        const value = decryptSecret(this.config.encryptionKey, old.value_enc, this.aad(userId, originalName));
        valueEnc = encryptSecret(this.config.encryptionKey, value, this.aad(userId, name));
      }

      try {
        await client.query(
          "UPDATE vault_secrets SET name=$3,description=$4,expose=$5,value_enc=$6,updated_at=now() WHERE user_id=$1 AND name=$2",
          [userId, originalName, name, description, expose, valueEnc],
        );
      } catch (error) {
        if ((error as { code?: unknown }).code === "23505") throw conflict("A secret with this name already exists", "secret_exists");
        throw error;
      }
      await client.query("COMMIT");
      auditName = name;
      renamed = name !== originalName;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await this.audit(userId, null, originalName, renamed ? "rename" : "update");
    if (renamed) await this.audit(userId, null, auditName, "rename");
    return this.list(userId);
  }

  async remove(userId: string, name: string): Promise<void> {
    const result = await this.pool.query("DELETE FROM vault_secrets WHERE user_id = $1 AND name = $2", [userId, name]);
    if (!result.rowCount) throw notFound("Secret not found");
    await this.audit(userId, null, name, "delete");
  }

  /** Decrypt secrets for injection or CLI use. */
  async reveal(userId: string, names: string[] | null, only: Exposure | null, sessionId: string | null): Promise<Record<string, string>> {
    const params: unknown[] = [userId];
    let where = "user_id = $1";
    if (only) {
      params.push(only);
      where += " AND expose = $" + params.length;
    }
    if (names) {
      params.push(names);
      where += " AND name = ANY($" + params.length + ")";
    }
    const result = await this.pool.query("SELECT name, value_enc FROM vault_secrets WHERE " + where, params);
    const out: Record<string, string> = {};
    for (const row of result.rows) {
      // Secrets saved before a name became reserved must not reach the agent as env (they could override CLI behaviour).
      if (only === "env" && RESERVED.test(row.name)) continue;
      out[row.name] = decryptSecret(this.config.encryptionKey, row.value_enc, this.aad(userId, row.name));
    }
    const used = Object.keys(out);
    if (used.length > 0) {
      await this.pool.query("UPDATE vault_secrets SET last_used_at = now() WHERE user_id = $1 AND name = ANY($2)", [userId, used]);
      await Promise.all(used.map((name) => this.audit(userId, sessionId, name, "reveal")));
    }
    return out;
  }

  /**
   * Server-side `floq-vault run`: the command is launched by the runtime (in the caller's sandbox) with the secrets already in its
   * environment, and only redacted, size-capped output goes back. The cleartext never travels to the agent process.
   */
  async run(
    userId: string,
    sessionId: string,
    names: string[] | null,
    launch: (secrets: Record<string, string>) => ChildProcess,
    limits: { maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
    const secrets = await this.reveal(userId, names, null, sessionId);
    if (names) {
      const missing = names.filter((n) => !(n in secrets));
      if (missing.length) throw notFound("Secret " + missing.join(", ") + " was not found");
    }
    const maxBytes = limits.maxBytes ?? 4 * 1024 * 1024;
    const child = launch(secrets);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (size >= maxBytes) { truncated = true; return; }
      const room = maxBytes - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      size += part.length;
      sink.push(part);
    };
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));
    const timer = setTimeout(() => child.kill("SIGKILL"), limits.timeoutMs ?? 10 * 60_000);
    const code = await new Promise<number>((resolve) => {
      child.on("error", (e) => { err.push(Buffer.from("floq-vault: " + e.message + "\n")); resolve(127); });
      child.on("close", (c, signal) => resolve(c ?? (signal ? 1 : 0)));
    }).finally(() => clearTimeout(timer));
    return { code, stdout: scrubSecrets(Buffer.concat(out).toString("utf8"), secrets), stderr: scrubSecrets(Buffer.concat(err).toString("utf8"), secrets), truncated };
  }

  private async audit(userId: string, sessionId: string | null, name: string, action: string): Promise<void> {
    // Never log values, only which secret was touched.
    await this.pool
      .query("INSERT INTO vault_audit (user_id, session_id, secret_name, action) VALUES ($1,$2,$3,$4)", [userId, sessionId, name, action])
      .catch((error) => log.warn("vault.audit_failed", { error: String(error) }));
  }

  private validateName(value: unknown): string {
    if (typeof value !== "string" || !NAME.test(value)) throw badRequest("Name must look like MY_SECRET (A-Z, 0-9, _; max 64)", "invalid_name");
    if (RESERVED.test(value)) throw badRequest(value + " is a reserved name", "reserved_name");
    return value;
  }

  private validateDescription(value: unknown): string {
    if (typeof value !== "string" || value.length > 300 || /[\0]/.test(value)) throw badRequest("description must be at most 300 characters", "invalid_description");
    return value.trim();
  }

  private validateExposure(value: unknown): Exposure {
    if (value !== "tool" && value !== "env") throw badRequest("expose must be 'tool' or 'env'");
    return value;
  }

  /** Short-lived credential an agent process uses to reach its own user's vault, nothing else. */
  issueToken(userId: string, sessionId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, { userId, sessionId, hits: [] });
    return token;
  }

  revokeSession(sessionId: string): void {
    for (const [token, scope] of this.tokens) if (scope.sessionId === sessionId) this.tokens.delete(token);
  }

  authenticate(header: string | undefined): TokenScope {
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const scope = token ? this.tokens.get(token) : undefined;
    if (!scope) throw unauthorized("Invalid vault token");
    const now = Date.now();
    scope.hits = scope.hits.filter((t) => now - t < 60_000);
    if (scope.hits.length >= 60) throw tooMany("Vault rate limit exceeded");
    scope.hits.push(now);
    return scope;
  }
}

/** Replaces every secret value (4+ chars, longest first) with [REDACTED]. */
export function scrubSecrets(text: string, secrets: Record<string, string>): string {
  for (const value of Object.values(secrets).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(value).join("[REDACTED]");
  return text;
}
