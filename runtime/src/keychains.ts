import type pg from "pg";
import type { Config } from "./config.js";
import { HttpError, badRequest, conflict, notFound, tooMany } from "./errors.js";
import { log } from "./logger.js";
import { NOTE_COLORS, NOTE_MAX_SIZE, NOTE_MAX_COORD, NOTE_MIN_SIZE, finite, type NoteColor } from "./notes.js";
import { openSecret, redactSecrets, sealSecret, validateSecretName, validateSecretValue } from "./secrets.js";

/**
 * Keychains: named wallets of secrets that live on the canvas and reach only the agents linked to them.
 * The existing user-level vault (vault.ts) stays global and untouched; keychain values use the same AES-256-GCM
 * primitive and FLOQ_ENCRYPTION_KEY (see secrets.ts), but need their own table because the vault is a flat
 * per-user name -> value store (unique on user+name), which cannot hold the same name in two wallets.
 */

export const MAX_KEYCHAIN_SECRETS = 100;
export const MAX_KEYCHAINS_PER_PROJECT = 50;
export const KEYCHAIN_NAME_MAX = 60;

export interface Keychain {
  id: string;
  projectId: string | null;
  projectName?: string | null;
  name: string;
  color: NoteColor;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Names only, never values. */
  secretNames: string[];
  /** Per-secret provenance and use: who created it (an agent's session id, null = the user) and when an agent last pulled it. */
  secrets: KeychainSecretInfo[];
  linkedSessionIds: string[];
  linkedCount: number;
  createdAt: string;
  updatedAt: string;
  /** Only on mutation results: true when a live session is affected (its process env changes on next start). */
  appliesOnNextStart?: boolean;
}

export interface KeychainSecretInfo { name: string; createdBy: string | null; lastUsedAt: string | null; lastUsedBy: string | null; uses: number }

export interface KeychainFields { name?: string; color?: NoteColor; x?: number; y?: number; w?: number; h?: number }

export function parseKeychainFields(body: unknown, needPosition: boolean): KeychainFields {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("JSON object body required", "invalid_keychain");
  const b = body as Record<string, unknown>;
  const out: KeychainFields = {};
  if (b.name !== undefined || needPosition) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > KEYCHAIN_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw badRequest("name must be 1-" + KEYCHAIN_NAME_MAX + " printable characters", "invalid_keychain");
    out.name = name;
  }
  if (b.color !== undefined) {
    if (typeof b.color !== "string" || !(NOTE_COLORS as readonly string[]).includes(b.color)) throw badRequest("color must be one of " + NOTE_COLORS.join(", "), "invalid_keychain");
    out.color = b.color as NoteColor;
  }
  for (const key of ["x", "y"] as const) {
    if (b[key] !== undefined) out[key] = finite(key, b[key], -NOTE_MAX_COORD, NOTE_MAX_COORD);
    else if (needPosition) throw badRequest(key + " is required", "invalid_keychain");
  }
  for (const key of ["w", "h"] as const) if (b[key] !== undefined) out[key] = finite(key, b[key], NOTE_MIN_SIZE, NOTE_MAX_SIZE);
  return out;
}

/** Later-created keychain wins on duplicate names. `layers` must be ordered oldest keychain first. */
export function mergeKeychainLayers(layers: Array<Record<string, string>>): Record<string, string> {
  return Object.assign({}, ...layers) as Record<string, string>;
}

const UUID = /^[0-9a-f-]{36}$/i;
const SELECT = `SELECT k.id, k.project_id, k.name, k.color, k.x, k.y, k.w, k.h, k.created_at, k.updated_at,
    COALESCE(p.display_name, p.name) AS project_name,
    COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM keychain_secrets s WHERE s.keychain_id = k.id), '{}') AS secret_names,
    COALESCE((SELECT json_agg(json_build_object('name', s.name, 'createdBy', s.created_by, 'lastUsedAt', s.last_used_at, 'lastUsedBy', s.last_used_by, 'uses', s.use_count) ORDER BY s.name) FROM keychain_secrets s WHERE s.keychain_id = k.id), '[]'::json) AS secret_info,
    COALESCE((SELECT array_agg(l.session_id::text ORDER BY l.created_at) FROM keychain_links l WHERE l.keychain_id = k.id), '{}') AS linked
  FROM keychains k LEFT JOIN floq_projects p ON p.id = k.project_id`;

function toKeychain(r: Record<string, unknown>): Keychain {
  const linked = (r.linked as string[]) ?? [];
  return {
    id: r.id as string,
    projectId: (r.project_id as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    name: r.name as string,
    color: r.color as NoteColor,
    x: Number(r.x),
    y: Number(r.y),
    w: Number(r.w),
    h: Number(r.h),
    secretNames: (r.secret_names as string[]) ?? [],
    secrets: (((r.secret_info as Array<Record<string, unknown>> | undefined) ?? []).map((s) => ({
      name: String(s.name),
      createdBy: (s.createdBy as string | null) ?? null,
      lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt as string).toISOString() : null,
      lastUsedBy: (s.lastUsedBy as string | null) ?? null,
      uses: Number(s.uses ?? 0),
    }))),
    linkedSessionIds: linked,
    linkedCount: linked.length,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

interface SessionRow { id: string; project_id: string | null }

export class Keychains {
  constructor(private readonly pool: pg.Pool, private readonly config: Pick<Config, "encryptionKey">) {}

  private async projectScope(userId: string, projectId: string): Promise<string | null> {
    if (projectId === "none") return null;
    if (!UUID.test(projectId)) throw notFound("Project not found");
    if (!(await this.pool.query("SELECT 1 FROM floq_projects WHERE id = $1 AND user_id = $2", [projectId, userId])).rowCount) throw notFound("Project not found");
    return projectId;
  }

  async get(userId: string, id: string): Promise<Keychain> {
    if (!UUID.test(id)) throw notFound("Keychain not found");
    const r = await this.pool.query(`${SELECT} WHERE k.id = $1 AND k.user_id = $2`, [id, userId]);
    if (!r.rows[0]) throw notFound("Keychain not found");
    return toKeychain(r.rows[0]);
  }

  /** All of the user's keychains across projects (Secrets screen). */
  async listAll(userId: string): Promise<Keychain[]> {
    return (await this.pool.query(`${SELECT} WHERE k.user_id = $1 ORDER BY k.created_at`, [userId])).rows.map(toKeychain);
  }

  async list(userId: string, projectId: string): Promise<Keychain[]> {
    const project = await this.projectScope(userId, projectId);
    return (await this.pool.query(`${SELECT} WHERE k.user_id = $1 AND k.project_id IS NOT DISTINCT FROM $2::uuid ORDER BY k.created_at`, [userId, project])).rows.map(toKeychain);
  }

  async create(userId: string, projectId: string, body: unknown): Promise<Keychain> {
    const f = parseKeychainFields(body, true);
    const project = await this.projectScope(userId, projectId);
    const n = await this.pool.query("SELECT count(*)::int AS n FROM keychains WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2::uuid", [userId, project]);
    if (n.rows[0].n >= MAX_KEYCHAINS_PER_PROJECT) throw tooMany("Keychain limit reached (" + MAX_KEYCHAINS_PER_PROJECT + ")");
    const r = await this.pool.query(
      "INSERT INTO keychains (user_id, project_id, name, color, x, y, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [userId, project, f.name, f.color ?? "yellow", f.x, f.y, f.w ?? 240, f.h ?? 160],
    );
    return this.get(userId, r.rows[0].id);
  }

  async patch(userId: string, id: string, body: unknown): Promise<Keychain> {
    const f = parseKeychainFields(body, false);
    const sets: string[] = [];
    const values: unknown[] = [id, userId];
    for (const key of ["name", "color", "x", "y", "w", "h"] as const) {
      if (f[key] === undefined) continue;
      values.push(f[key]);
      sets.push(key + " = $" + values.length);
    }
    if (sets.length) {
      const r = await this.pool.query(`UPDATE keychains SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`, values);
      if (!r.rowCount) throw notFound("Keychain not found");
    }
    return this.get(userId, id);
  }

  /** Returns the sessions that were linked, so the caller can refresh their files. */
  async remove(userId: string, id: string): Promise<string[]> {
    const kc = await this.get(userId, id);
    await this.pool.query("DELETE FROM keychains WHERE id = $1 AND user_id = $2", [id, userId]); // secrets + links cascade
    log.info("keychain.delete", { userId, keychainId: id });
    return kc.linkedSessionIds;
  }

  async putSecret(userId: string, id: string, nameValue: unknown, valueValue: unknown, createdBy: string | null = null): Promise<Keychain> {
    const name = validateSecretName(nameValue);
    const value = validateSecretValue(valueValue);
    const enc = sealSecret(this.config, userId, id, name, value); // fail closed before touching the DB
    const kc = await this.get(userId, id);
    if (!kc.secretNames.includes(name) && kc.secretNames.length >= MAX_KEYCHAIN_SECRETS) throw tooMany("Secret limit reached (" + MAX_KEYCHAIN_SECRETS + " per keychain)");
    await this.pool.query(
      `INSERT INTO keychain_secrets (keychain_id, user_id, name, value_enc, created_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (keychain_id, name) DO UPDATE SET value_enc = $4, updated_at = now()`,
      [id, userId, name, enc, createdBy],
    );
    await this.pool.query("UPDATE keychains SET updated_at = now() WHERE id = $1", [id]);
    log.info("secret.set", { userId, keychainId: id, name });
    return this.get(userId, id);
  }

  async removeSecret(userId: string, id: string, nameValue: unknown): Promise<Keychain> {
    const name = typeof nameValue === "string" ? nameValue : "";
    await this.get(userId, id);
    const r = await this.pool.query("DELETE FROM keychain_secrets WHERE keychain_id = $1 AND user_id = $2 AND name = $3", [id, userId, name]);
    if (!r.rowCount) throw notFound("Secret not found");
    await this.pool.query("UPDATE keychains SET updated_at = now() WHERE id = $1", [id]);
    log.info("secret.delete", { userId, keychainId: id, name });
    return this.get(userId, id);
  }

  /**
   * `floq secrets add`: a lead agent stores a secret in a KEYCHAIN, never in the global vault. The target is the named
   * keychain (it must be linked to the agent; an unknown name creates a new keychain linked to it), else the agent's only
   * linked keychain, else a new "<agent> keychain". Create-only: an existing name is never overwritten.
   */
  async agentAddSecret(userId: string, caller: { id: string; name: string; projectId: string | null }, body: { name?: unknown; value?: unknown; keychain?: unknown }): Promise<{ keychain: { id: string; name: string }; created: boolean; secretNames: string[] }> {
    const name = validateSecretName(body.name);
    validateSecretValue(body.value);
    const ref = typeof body.keychain === "string" ? body.keychain.trim() : "";
    if (body.keychain !== undefined && typeof body.keychain !== "string") throw badRequest("keychain must be a name", "invalid_keychain");
    const scope = caller.projectId ?? "none";
    const inProject = await this.list(userId, scope);
    const linked = inProject.filter((k) => k.linkedSessionIds.includes(caller.id));
    let target: Keychain | undefined;
    let createdName: string | undefined;
    if (ref) {
      target = inProject.find((k) => k.id === ref) ?? inProject.find((k) => k.name.toLowerCase() === ref.toLowerCase());
      if (target && !linked.some((k) => k.id === target!.id)) throw new HttpError(403, "keychain_not_linked", 'Keychain "' + target.name + '" is not linked to this agent. Ask the user to link it on the canvas, or use another name to create a new keychain.');
      if (!target) createdName = ref;
    } else if (linked.length === 1) target = linked[0];
    else if (linked.length === 0) createdName = (caller.name + " keychain").slice(0, KEYCHAIN_NAME_MAX);
    else throw badRequest("Several keychains are linked to this agent (" + linked.map((k) => k.name).join(", ") + "). Pass --keychain NAME.", "keychain_required");
    let created = false;
    if (!target) {
      // Off to the left of the canvas content; Re-layout stacks keychains tidily.
      target = await this.create(userId, scope, { name: createdName, x: -480 - 300 * inProject.length, y: 0 });
      // The caller is already a verified agent session of this user in this project (toolkitCaller), so link it directly.
      await this.pool.query("INSERT INTO keychain_links (keychain_id, session_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [target.id, caller.id, userId]);
      log.info("keychain.link", { userId, keychainId: target.id, sessionId: caller.id });
      target = await this.get(userId, target.id);
      created = true;
    }
    if (target.secretNames.includes(name)) throw conflict('A secret named ' + name + ' already exists in keychain "' + target.name + '". Agents cannot change or delete it; ask the user.', "secret_exists");
    const updated = await this.putSecret(userId, target.id, name, body.value, caller.id);
    return { keychain: { id: updated.id, name: updated.name }, created, secretNames: updated.secretNames };
  }

  /** Idempotent. The session must be the user's and in the keychain's project. */
  async link(userId: string, id: string, sessionIdValue: unknown): Promise<Keychain> {
    if (typeof sessionIdValue !== "string" || !UUID.test(sessionIdValue)) throw badRequest("sessionId required", "invalid_link");
    const kc = await this.get(userId, id);
    const s = (await this.pool.query("SELECT id, project_id FROM agent_sessions WHERE id = $1 AND user_id = $2", [sessionIdValue, userId])).rows[0] as SessionRow | undefined;
    if (!s) throw notFound("Session not found");
    if ((s.project_id ?? null) !== kc.projectId) throw new HttpError(403, "other_project", "The agent is in a different project than this keychain");
    await this.pool.query("INSERT INTO keychain_links (keychain_id, session_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, sessionIdValue, userId]);
    log.info("keychain.link", { userId, keychainId: id, sessionId: sessionIdValue });
    return this.get(userId, id);
  }

  async unlink(userId: string, id: string, sessionId: string): Promise<Keychain> {
    await this.get(userId, id);
    if (UUID.test(sessionId)) {
      await this.pool.query("DELETE FROM keychain_links WHERE keychain_id = $1 AND session_id = $2 AND user_id = $3", [id, sessionId, userId]);
      log.info("keychain.unlink", { userId, keychainId: id, sessionId });
    }
    return this.get(userId, id);
  }

  /** Names (never values) of the secrets an agent can pull, with the keychain each lives in. */
  async pullableNames(userId: string, sessionId: string): Promise<Array<{ keychain: string; name: string }>> {
    const r = await this.pool.query(
      `SELECT k.name AS keychain, s.name FROM keychain_links l
       JOIN keychains k ON k.id = l.keychain_id AND k.user_id = $1
       JOIN keychain_secrets s ON s.keychain_id = k.id
       WHERE l.session_id = $2 AND l.user_id = $1 ORDER BY k.created_at, s.name`,
      [userId, sessionId],
    );
    return r.rows.map((row) => ({ keychain: row.keychain as string, name: row.name as string }));
  }

  /**
   * `floq secret get NAME`: an agent pulls one secret from a keychain linked to it. Nothing is injected into agents any
   * more, so every use goes through here and is recorded (counter, last user, and a row in keychain_secret_uses) for the
   * user to see on the keychain. A later-created keychain wins on duplicate names unless `keychain` narrows it.
   */
  async pull(userId: string, sessionId: string, nameValue: unknown, keychainValue?: unknown): Promise<{ value: string; keychain: { id: string; name: string } } | null> {
    const name = validateSecretName(nameValue);
    const ref = typeof keychainValue === "string" ? keychainValue.trim().toLowerCase() : "";
    const r = await this.pool.query(
      `SELECT k.id, k.name AS keychain_name, s.value_enc FROM keychain_links l
       JOIN keychains k ON k.id = l.keychain_id AND k.user_id = $1
       JOIN keychain_secrets s ON s.keychain_id = k.id AND s.name = $3
       WHERE l.session_id = $2 AND l.user_id = $1 ORDER BY k.created_at DESC`,
      [userId, sessionId, name],
    );
    const row = r.rows.find((x) => !ref || String(x.id).toLowerCase() === ref || String(x.keychain_name).toLowerCase() === ref);
    if (!row) return null;
    const value = openSecret(this.config, userId, row.id as string, name, row.value_enc as Buffer);
    await this.pool.query("UPDATE keychain_secrets SET last_used_at = now(), last_used_by = $4, use_count = use_count + 1 WHERE keychain_id = $1 AND user_id = $2 AND name = $3", [row.id, userId, name, sessionId]);
    await this.pool.query("INSERT INTO keychain_secret_uses (keychain_id, user_id, name, session_id) VALUES ($1,$2,$3,$4)", [row.id, userId, name, sessionId]);
    await this.pool.query("UPDATE keychains SET updated_at = now() WHERE id = $1", [row.id]);
    log.info("secret.pull", { userId, keychainId: row.id, sessionId, name });
    return { value, keychain: { id: row.id as string, name: row.keychain_name as string } };
  }

  /** Decrypted secrets of every keychain linked to a session (used to redact their values from text; never handed to agents); a later-created keychain wins on duplicate names. */
  async resolve(userId: string, sessionId: string): Promise<Record<string, string>> {
    const r = await this.pool.query(
      `SELECT s.keychain_id, s.name, s.value_enc FROM keychain_links l
       JOIN keychains k ON k.id = l.keychain_id AND k.user_id = $1
       JOIN keychain_secrets s ON s.keychain_id = k.id
       WHERE l.session_id = $2 AND l.user_id = $1 ORDER BY k.created_at, s.name`,
      [userId, sessionId],
    );
    const layers: Array<Record<string, string>> = [];
    const index = new Map<string, number>();
    for (const row of r.rows) {
      let i = index.get(row.keychain_id);
      if (i === undefined) { i = layers.length; index.set(row.keychain_id, i); layers.push({}); }
      try { layers[i][row.name] = openSecret(this.config, userId, row.keychain_id, row.name, row.value_enc); }
      catch { log.warn("secret.decrypt_failed", { userId, keychainId: row.keychain_id, name: row.name }); }
    }
    return mergeKeychainLayers(layers);
  }

  /** Redact secret values of the given sessions from runtime-generated text. Never throws; fails closed (masks the whole text) on error. */
  async redact(userId: string, sessionIds: string[], text: string): Promise<string> {
    if (!text) return text;
    try {
      const any = await this.pool.query("SELECT 1 FROM keychain_links WHERE user_id = $1 AND session_id = ANY($2::uuid[]) LIMIT 1", [userId, sessionIds]);
      if (!any.rowCount) return text;
      let out = text;
      for (const id of new Set(sessionIds)) out = redactSecrets(out, await this.resolve(userId, id));
      return out;
    } catch {
      // Fail closed: if we cannot tell what to mask, show none of the text.
      return "[redacted: secret scrubbing unavailable]";
    }
  }
}
