import type pg from "pg";
import type { Config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { badRequest } from "./errors.js";
import { parseUsageFallback, readUsageFallback, type UsageFallback } from "./fallback.js";

/** Hard bounds for the user-configurable subagent limits (defaults live in subagents.ts DEFAULT_LIMITS). */
export const SUBAGENT_CHILDREN_RANGE = { min: 1, max: 32 } as const;
export const SUBAGENT_TOTAL_RANGE = { min: 1, max: 200 } as const;
const DEFAULT_CHILDREN = 6;
const DEFAULT_TOTAL = 24;

/** Operator ceilings for the user's saved subagent limits. Users may raise their limits only up to these. */
export interface SubagentCeilings { maxChildren: number; maxTotal: number }

function ceilEnv(raw: string | undefined, range: { min: number; max: number }): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : range.max;
}

/** FLOQ_SUBAGENT_CEIL_CHILDREN (1-32) and FLOQ_SUBAGENT_CEIL_TOTAL (1-200); default is the full range. Invalid values fall back to it. */
export function subagentCeilingsFromEnv(env: Record<string, string | undefined> = process.env): SubagentCeilings {
  return { maxChildren: ceilEnv(env.FLOQ_SUBAGENT_CEIL_CHILDREN, SUBAGENT_CHILDREN_RANGE), maxTotal: ceilEnv(env.FLOQ_SUBAGENT_CEIL_TOTAL, SUBAGENT_TOTAL_RANGE) };
}

function limitValue(value: unknown, field: string, range: { min: number; max: number }): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw badRequest(`${field} must be a whole number from ${range.min} to ${range.max}, or null for the default`);
  }
  return value;
}

export interface PublicSettings {
  claudeAutoApprove: boolean;
  codexAutoApprove: boolean;
  gitName: string | null;
  gitEmail: string | null;
  /** Add the Floq "Co-authored-by" trailer to commits made in sessions. */
  gitCoauthor: boolean;
  /** False when the server disabled the co-author feature (FLOQ_GIT_COAUTHOR is empty). */
  gitCoauthorAvailable: boolean;
  /** Fixed Floq policy tells every agent to delegate via subagents (default on). Off = recruit only when asked. */
  alwaysRecruitSubagents: boolean;
  /** Agents may discover and message agents of the user's other projects (default on). */
  allowCrossProjectAgents: boolean;
  /** Max direct subagents per agent; null = default (6). */
  subagentMaxChildren: number | null;
  /** Max subagents in total; null = default (24). */
  subagentMaxTotal: number | null;
  /** Operator ceilings the two limits above are clamped to (Settings shows them as the effective maximum). */
  subagentCeilings: SubagentCeilings;
  /** The user has answered the one-time "auto-approve runs commands without prompts" confirmation. */
  autoApproveAcknowledged: boolean;
  /** What happens when a Claude agent hits its plan usage limit (default: lower model only). */
  usageFallback: UsageFallback;
  github: { login: string; connectedAt: string } | null;
}

export interface SettingsPatch {
  claudeAutoApprove?: boolean;
  codexAutoApprove?: boolean;
  gitName?: string | null;
  gitEmail?: string | null;
  gitCoauthor?: boolean;
  alwaysRecruitSubagents?: boolean;
  allowCrossProjectAgents?: boolean;
  /** Whole number 1-32, or null to reset to the default. */
  subagentMaxChildren?: number | null;
  /** Whole number 1-200, or null to reset to the default. Must be >= the children limit. */
  subagentMaxTotal?: number | null;
  /** Only `true` is accepted: the acknowledgement cannot be withdrawn. */
  autoApproveAcknowledged?: boolean;
  /** The whole chain; null resets to the defaults. */
  usageFallback?: UsageFallback | null;
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
    private readonly subagentCeilings: SubagentCeilings = subagentCeilingsFromEnv(),
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
      alwaysRecruitSubagents: row?.always_recruit_subagents ?? true,
      allowCrossProjectAgents: row?.allow_cross_project_agents ?? true,
      subagentMaxChildren: row?.subagent_max_children ?? null,
      subagentMaxTotal: row?.subagent_max_total ?? null,
      subagentCeilings: this.subagentCeilings,
      autoApproveAcknowledged: Boolean(row?.auto_approve_ack_at),
      usageFallback: readUsageFallback(row?.usage_fallback),
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
    if (patch.alwaysRecruitSubagents !== undefined) {
      if (typeof patch.alwaysRecruitSubagents !== "boolean") throw badRequest("alwaysRecruitSubagents must be boolean");
      push("always_recruit_subagents", patch.alwaysRecruitSubagents);
    }
    if (patch.allowCrossProjectAgents !== undefined) {
      if (typeof patch.allowCrossProjectAgents !== "boolean") throw badRequest("allowCrossProjectAgents must be boolean");
      push("allow_cross_project_agents", patch.allowCrossProjectAgents);
    }
    if (patch.subagentMaxChildren !== undefined || patch.subagentMaxTotal !== undefined) {
      const current = await this.get(userId);
      const ceil = this.subagentCeilings;
      const children = patch.subagentMaxChildren !== undefined ? limitValue(patch.subagentMaxChildren, "subagentMaxChildren", { min: SUBAGENT_CHILDREN_RANGE.min, max: Math.min(SUBAGENT_CHILDREN_RANGE.max, ceil.maxChildren) }) : current.subagentMaxChildren;
      const total = patch.subagentMaxTotal !== undefined ? limitValue(patch.subagentMaxTotal, "subagentMaxTotal", { min: SUBAGENT_TOTAL_RANGE.min, max: Math.min(SUBAGENT_TOTAL_RANGE.max, ceil.maxTotal) }) : current.subagentMaxTotal;
      // Compare effective values: an unset limit is the default, itself clamped by the operator ceiling.
      const effChildren = Math.min(children ?? DEFAULT_CHILDREN, ceil.maxChildren);
      const effTotal = Math.min(total ?? DEFAULT_TOTAL, ceil.maxTotal);
      if (effChildren > effTotal) throw badRequest("Active agents at once cannot exceed total agents");
      if (patch.subagentMaxChildren !== undefined) push("subagent_max_children", children);
      if (patch.subagentMaxTotal !== undefined) push("subagent_max_total", total);
    }
    if (patch.autoApproveAcknowledged !== undefined) {
      if (patch.autoApproveAcknowledged !== true) throw badRequest("autoApproveAcknowledged can only be set to true");
      sets.push("auto_approve_ack_at = COALESCE(auto_approve_ack_at, now())");
    }
    if (patch.usageFallback !== undefined) push("usage_fallback", patch.usageFallback === null ? null : JSON.stringify(parseUsageFallback(patch.usageFallback)));
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

  /** The user's fallback chain (defaults when unset). */
  async usageFallback(userId: string): Promise<UsageFallback> {
    const row = (await this.pool.query("SELECT usage_fallback FROM user_settings WHERE user_id = $1", [userId])).rows[0];
    return readUsageFallback(row?.usage_fallback);
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
