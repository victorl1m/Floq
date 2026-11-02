import type pg from "pg";
import type { Config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { badRequest } from "./errors.js";

export interface PublicSettings {
  claudeAutoApprove: boolean;
  codexAutoApprove: boolean;
  gitName: string | null;
  gitEmail: string | null;
  /** Add the Floq "Co-authored-by" trailer to commits made in sessions. */
  gitCoauthor: boolean;
  /** False when the server disabled the co-author feature (FLOQ_GIT_COAUTHOR is empty). */
  gitCoauthorAvailable: boolean;
  github: { login: string; connectedAt: string } | null;
}

export interface SettingsPatch {
  claudeAutoApprove?: boolean;
  codexAutoApprove?: boolean;
  gitName?: string | null;
  gitEmail?: string | null;
  gitCoauthor?: boolean;
}

/** Decrypted values used to launch one user's agent session. */
export interface RuntimeProfile {
  claudeAutoApprove: boolean;
  codexAutoApprove: boolean;
  /** Commit identity: the user's settings, else their GitHub identity, else their Floq account. */
  gitName: string | null;
  gitEmail: string | null;
  /** The co-author identity to add to commits ("" when disabled by the server or the user). */
  gitCoauthor: string;
  githubToken: string | null;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function cleanText(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max || /[\r\n\0]/.test(trimmed)) throw badRequest(`${field} is invalid`);
  return trimmed || null;
}

export class SettingsStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
  ) {}

  private aad(userId: string, field: string): string {
    return `${userId}:${field}`;
  }

  async get(userId: string): Promise<PublicSettings> {
    const [settings, github] = await Promise.all([
      this.pool.query("SELECT * FROM user_settings WHERE user_id = $1", [userId]),
      this.pool.query("SELECT login, created_at FROM github_credentials WHERE user_id = $1", [userId]),
    ]);
    const row = settings.rows[0];
    const gh = github.rows[0];
    return {
      claudeAutoApprove: row?.claude_auto_approve ?? true,
      codexAutoApprove: row?.codex_auto_approve ?? true,
      gitName: row?.git_name ?? null,
      gitEmail: row?.git_email ?? null,
      gitCoauthor: row?.git_coauthor ?? true,
      gitCoauthorAvailable: Boolean(this.config.gitCoauthor),
      github: gh ? { login: gh.login, connectedAt: new Date(gh.created_at).toISOString() } : null,
    };
  }

  async update(userId: string, patch: SettingsPatch): Promise<PublicSettings> {
    const sets: string[] = [];
    const values: unknown[] = [userId];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.claudeAutoApprove !== undefined) {
      if (typeof patch.claudeAutoApprove !== "boolean") throw badRequest("claudeAutoApprove must be boolean");
      push("claude_auto_approve", patch.claudeAutoApprove);
    }
    if (patch.codexAutoApprove !== undefined) {
      if (typeof patch.codexAutoApprove !== "boolean") throw badRequest("codexAutoApprove must be boolean");
      push("codex_auto_approve", patch.codexAutoApprove);
    }
    if (patch.gitCoauthor !== undefined) {
      if (typeof patch.gitCoauthor !== "boolean") throw badRequest("gitCoauthor must be boolean");
      push("git_coauthor", patch.gitCoauthor);
    }
    if (patch.gitName !== undefined) push("git_name", cleanText(patch.gitName, "gitName", 100));
    if (patch.gitEmail !== undefined) {
      const email = cleanText(patch.gitEmail, "gitEmail", 200);
      if (email && !EMAIL.test(email)) throw badRequest("gitEmail is invalid");
      push("git_email", email);
    }

    if (sets.length > 0) {
      sets.push("updated_at = now()");
      await this.pool.query(
        `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await this.pool.query(`UPDATE user_settings SET ${sets.join(", ")} WHERE user_id = $1`, values);
    }
    return this.get(userId);
  }

  async profile(userId: string): Promise<RuntimeProfile> {
    const [settings, github, account] = await Promise.all([
      this.pool.query("SELECT * FROM user_settings WHERE user_id = $1", [userId]),
      this.pool.query("SELECT token_enc, login, gh_id, gh_name FROM github_credentials WHERE user_id = $1", [userId]),
      this.pool.query('SELECT name, email FROM "user" WHERE id = $1', [userId]),
    ]);
    const row = settings.rows[0];
    const gh = github.rows[0];
    const me = account.rows[0];
    const key = this.config.encryptionKey;
    const ghIdentity = gh?.gh_id
      ? { name: gh.gh_name || gh.login, email: `${gh.gh_id}+${gh.login}@users.noreply.github.com` }
      : null;
    return {
      claudeAutoApprove: row?.claude_auto_approve ?? true,
      codexAutoApprove: row?.codex_auto_approve ?? true,
      gitName: row?.git_name ?? ghIdentity?.name ?? me?.name ?? null,
      gitEmail: row?.git_email ?? ghIdentity?.email ?? me?.email ?? null,
      gitCoauthor: (row?.git_coauthor ?? true) ? this.config.gitCoauthor : "",
      githubToken: gh ? decryptSecret(key, gh.token_enc, this.aad(userId, "github")) : null,
    };
  }

  /** GitHub token and login for API calls, or null when not connected. */
  async githubAuth(userId: string): Promise<{ token: string; login: string } | null> {
    const row = (await this.pool.query("SELECT token_enc, login FROM github_credentials WHERE user_id = $1", [userId])).rows[0];
    if (!row) return null;
    return { token: decryptSecret(this.config.encryptionKey, row.token_enc, this.aad(userId, "github")), login: row.login };
  }

  async saveGithub(userId: string, login: string, token: string, scope: string, ghId: number | null = null, ghName: string | null = null): Promise<void> {
    await this.pool.query(
      `INSERT INTO github_credentials (user_id, login, token_enc, scope, gh_id, gh_name) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET login = $2, token_enc = $3, scope = $4, gh_id = $5, gh_name = $6, created_at = now()`,
      [userId, login, encryptSecret(this.config.encryptionKey, token, this.aad(userId, "github")), scope, ghId, ghName],
    );
  }

  async removeGithub(userId: string): Promise<void> {
    await this.pool.query("DELETE FROM github_credentials WHERE user_id = $1", [userId]);
  }
}
