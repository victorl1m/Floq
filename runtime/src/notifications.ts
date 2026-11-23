import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { badRequest, HttpError } from './errors.js';
import { neutralizeApprovalMarker, foldLookalikes } from './approvalText.js';
import { cleanDecisionText } from './decisions.js';

export const NOTIFICATION_LEVELS = ['info', 'success', 'warning', 'error'] as const;
export const NOTIFICATION_CATEGORIES = ['release', 'build', 'agent', 'cost', 'security', 'message', 'system', 'custom'] as const;
export const NOTIFICATION_ACTION_KINDS = ['url', 'canvas', 'agent', 'settings'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type NotificationAction = { kind: (typeof NOTIFICATION_ACTION_KINDS)[number]; target: string; label: string };
/** What a plugin attached (`ctx.notify`). `route` and `data` stay on the server: see `pluginPrivate`. */
export type NotificationPlugin = {
  id: string; name: string; icon: string | null; kind: 'message'; subtitle: string | null; avatar: string | null; tag: string | null;
  actions: { id: string; label: string; input?: { placeholder: string } }[];
  target: { view: string; params: Record<string, string> } | null;
  /** An audio attachment (a voice note): the island card shows a player. The bytes come from GET /v1/notifications/:id/audio. */
  audio?: NotificationAudio;
};
/** Seconds, and up to 64 bar heights from 0 to 1; either may be unknown (the player then reads them from the file). */
export type NotificationAudio = { duration: number | null; waveform: number[] | null };
export type NotificationPluginPrivate = { route: string | null; data: unknown; audioRoute?: string | null; audioPlayed?: boolean };
/** The largest audio file a notification serves. */
export const PLUGIN_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
export const PLUGIN_AUDIO_WAVEFORM_MAX = 64;
const AUDIO_MIME_RE = /^(?:audio\/[a-z0-9][a-z0-9.+-]{0,40}|application\/ogg)(?:;\s*codecs="?[a-z0-9., -]{1,60}"?)?$/i;
const ROUTE_RE = /^\/[A-Za-z0-9_\-./]{1,200}$/;
const routeOk = (v: unknown): v is string => typeof v === 'string' && ROUTE_RE.test(v) && !v.split('/').some((s) => s === '..' || s === '.');

/**
 * What a plugin's audio route answered: `{ mime, data }` with the file as base64. Only audio leaves through the audio endpoint, whatever
 * the plugin says: another type, an empty or an oversized file is refused.
 */
export function pluginAudioBytes(result: unknown): { mime: string; bytes: Buffer } {
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const mime = typeof r.mime === 'string' ? r.mime.trim() : '';
  if (!AUDIO_MIME_RE.test(mime)) throw new HttpError(415, 'not_audio', 'This attachment is not an audio file.');
  if (typeof r.data !== 'string' || !r.data || r.data.length > Math.ceil(PLUGIN_AUDIO_MAX_BYTES * 4 / 3) + 4) throw new HttpError(r.data ? 413 : 502, r.data ? 'audio_too_large' : 'audio_unavailable', r.data ? 'This audio file is too large to play here.' : 'The audio could not be loaded.');
  const bytes = Buffer.from(r.data, 'base64');
  if (!bytes.length) throw new HttpError(502, 'audio_unavailable', 'The audio could not be loaded.');
  return { mime, bytes };
}
export type Notification = {
  id: string; userId: string; projectId: string | null; sessionId: string | null; sessionName: string | null;
  level: NotificationLevel; category: NotificationCategory; title: string; body: string | null;
  action: NotificationAction | null; createdAt: string; readAt: string | null;
  /** Only on notifications a plugin created. */
  plugin?: NotificationPlugin;
};
export type NotificationFrame =
  | { type: 'notification'; notification: Notification }
  | { type: 'notification-read'; ids: string[] | 'all' }
  | { type: 'notification-cleared'; ids: string[] | 'all' };
export type NotificationInput = {
  title: unknown; body?: unknown; level?: unknown; category?: unknown; action?: unknown;
  projectId?: string | null; sessionId?: string | null; sessionName?: string | null;
};
/** Host-side only (never from an agent or a request body): the plugin part, already bound to the calling plugin's id and name. */
export type PluginNotificationInput = { plugin: { id: string; name: string; icon?: string | null; views: string[] }; note: Record<string, unknown> };
export const PLUGIN_AVATAR_MAX_BYTES = 32 * 1024;
const PLUGIN_RATE_MAX = 120;
const AVATAR_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Validates what a plugin passed to `ctx.notify`. Bad optional parts are dropped or refused (400); nothing here trusts the plugin's text. */
export function cleanPluginNote(input: PluginNotificationInput): { plugin: NotificationPlugin; priv: NotificationPluginPrivate } {
  const n = input.note;
  if (n.kind !== undefined && n.kind !== 'message') throw badRequest('invalid notification kind');
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? cleanDecisionText(v.slice(0, 4000), max) || null : null);
  const avatar = typeof n.avatar === 'string' && n.avatar.length <= Math.ceil(PLUGIN_AVATAR_MAX_BYTES * 4 / 3) + 64 && AVATAR_RE.test(n.avatar) ? n.avatar : null;
  const actions: NotificationPlugin['actions'] = [];
  if (n.actions !== undefined) {
    if (!Array.isArray(n.actions) || n.actions.length > 4) throw badRequest('invalid actions');
    for (const raw of n.actions as Record<string, unknown>[]) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(raw.id) || actions.some((a) => a.id === raw.id)) throw badRequest('invalid action id');
      const label = text(raw.label, LABEL_MAX);
      if (!label) throw badRequest('invalid action label');
      const input = raw.input && typeof raw.input === 'object' ? { placeholder: text((raw.input as Record<string, unknown>).placeholder, 80) ?? '' } : undefined;
      actions.push({ id: raw.id, label, ...(input ? { input } : {}) });
    }
  }
  let route: string | null = null;
  if (actions.length) {
    if (!routeOk(n.actionRoute)) throw badRequest('actionRoute is required with actions');
    route = n.actionRoute;
  }
  let data: unknown = null;
  if (n.data !== undefined && n.data !== null) {
    let json: string;
    try { json = JSON.stringify(n.data); } catch { throw badRequest('invalid data'); }
    if (json === undefined || json.length > 2048) throw badRequest('data too large');
    data = JSON.parse(json);
  }
  let target: NotificationPlugin['target'] = null;
  if (n.target !== undefined && n.target !== null) {
    const t = n.target as Record<string, unknown>;
    if (typeof t !== 'object' || typeof t.view !== 'string' || !input.plugin.views.includes(t.view)) throw badRequest('target view is not one of the plugin\'s views');
    const params: Record<string, string> = {};
    const entries = t.params && typeof t.params === 'object' ? Object.entries(t.params as Record<string, unknown>) : [];
    if (entries.length > 8) throw badRequest('too many target params');
    for (const [k, v] of entries) { if (!/^[A-Za-z0-9_]{1,32}$/.test(k) || typeof v !== 'string' || v.length > 300 || /[\u0000-\u001f\u007f]/.test(v)) throw badRequest('invalid target params'); params[k] = v; }
    target = { view: t.view, params };
  }
  const tag = typeof n.tag === 'string' && n.tag && n.tag.length <= 200 ? n.tag : null;
  // An audio attachment: the plugin names its own POST route that hands over the file ({ mime, data: base64 }); the route stays on the server.
  let audio: NotificationAudio | null = null, audioRoute: string | null = null, audioPlayed = false;
  if (n.audio !== undefined && n.audio !== null) {
    const a = n.audio as Record<string, unknown>;
    if (typeof a !== 'object' || !routeOk(a.route)) throw badRequest('audio.route is required with audio');
    const duration = typeof a.duration === 'number' && Number.isFinite(a.duration) && a.duration > 0 && a.duration <= 86400 ? Math.round(a.duration * 1000) / 1000 : null;
    const waveform = Array.isArray(a.waveform) && a.waveform.length >= 8 && a.waveform.length <= PLUGIN_AUDIO_WAVEFORM_MAX && a.waveform.every((v) => typeof v === 'number' && Number.isFinite(v))
      ? (a.waveform as number[]).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100) : null;
    audio = { duration, waveform }; audioRoute = a.route; audioPlayed = a.played === true;
  }
  return {
    plugin: { id: input.plugin.id, name: cleanDecisionText(input.plugin.name, 60), icon: input.plugin.icon ?? null, kind: 'message', subtitle: text(n.subtitle, 120), avatar, tag, actions, target, ...(audio ? { audio } : {}) },
    priv: { route, data, ...(audio ? { audioRoute, audioPlayed } : {}) },
  };
}
export type NotificationListOptions = { unreadOnly?: boolean; projectId?: string; organizationId?: string | null; limit?: number; before?: string };

/**
 * Retention (applied after every create, in the background, never blocking the sender):
 *  1. keep only the newest KEEP_PER_USER (500) notifications per user;
 *  2. delete notifications that were read more than READ_RETENTION_DAYS (30) days ago.
 * Unread notifications younger than the cap are never pruned by rule 2.
 * Rate limit: at most RATE_MAX creates per user per RATE_WINDOW_MS (a runaway agent cannot flood the center).
 */
export const KEEP_PER_USER = 500;
export const READ_RETENTION_DAYS = 30;
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60000;
const TITLE_MAX = 120, BODY_MAX = 2000, LABEL_MAX = 40, TARGET_MAX = 2000;

/** Multi-line allowed (body): no control characters except \n, no approval look-alikes or forged markers. */
export function cleanNotificationBody(text: string, max: number): string {
  const safe = neutralizeApprovalMarker(foldLookalikes(text)).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return safe.length > max ? safe.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : safe;
}

type Extra = { plugin: NotificationPlugin; priv: NotificationPluginPrivate };
type Row = { id: string; user_id: string; project_id: string | null; session_id: string | null; session_name: string | null; level: string; category: string; title: string; body: string | null; action: NotificationAction | string | null; created_at: Date | string; read_at: Date | string | null; extra?: Extra | string | null };
const iso = (v: Date | string) => new Date(v).toISOString();
const extraOf = (r: Row): Extra | null => (typeof r.extra === 'string' ? JSON.parse(r.extra) as Extra : r.extra ?? null);
const fromRow = (r: Row): Notification => {
  const extra = extraOf(r);
  return {
    id: r.id, userId: r.user_id, projectId: r.project_id, sessionId: r.session_id, sessionName: r.session_name,
    level: r.level as NotificationLevel, category: r.category as NotificationCategory, title: r.title, body: r.body,
    action: typeof r.action === 'string' ? JSON.parse(r.action) as NotificationAction : r.action, createdAt: iso(r.created_at), readAt: r.read_at ? iso(r.read_at) : null,
    ...(extra?.plugin ? { plugin: extra.plugin } : {}),
  };
};

export class Notifications {
  private mem: Notification[] = [];
  private subs = new Set<{ userId: string; fn: (frame: NotificationFrame) => void }>();
  private recent = new Map<string, number[]>();
  /** Memory mode only: the server-side part of plugin notifications. */
  private memPriv = new Map<string, NotificationPluginPrivate>();
  constructor(private options: { pool?: Pick<pg.Pool, 'query'>; now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  subscribe(userId: string, fn: (frame: NotificationFrame) => void) { const sub = { userId, fn }; this.subs.add(sub); return () => { this.subs.delete(sub); }; }
  private emit(userId: string, frame: NotificationFrame) { for (const s of this.subs) if (s.userId === userId) { try { s.fn(frame); } catch { /* a broken subscriber never affects the sender */ } } }

  private validate(input: NotificationInput) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 1000) throw badRequest('title required');
    if (input.body !== undefined && input.body !== null && (typeof input.body !== 'string' || input.body.length > 20000)) throw badRequest('invalid body');
    const level = input.level ?? 'info', category = input.category ?? 'custom';
    if (!NOTIFICATION_LEVELS.includes(level as NotificationLevel)) throw badRequest('invalid level');
    if (!NOTIFICATION_CATEGORIES.includes(category as NotificationCategory)) throw badRequest('invalid category');
    let action: NotificationAction | null = null;
    if (input.action !== undefined && input.action !== null) {
      const a = input.action as Record<string, unknown>;
      if (typeof a !== 'object' || !NOTIFICATION_ACTION_KINDS.includes(a.kind as never) || typeof a.target !== 'string' || !a.target.trim() || a.target.length > TARGET_MAX || typeof a.label !== 'string') throw badRequest('invalid action');
      const target = a.target.trim();
      if (a.kind === 'url' && !/^https?:\/\/[^\s]+$/i.test(target)) throw badRequest('action url must be http(s)');
      if (a.kind !== 'url' && /[\u0000-\u001f\u007f\s]/.test(target)) throw badRequest('invalid action target');
      const label = cleanDecisionText(a.label, LABEL_MAX) || (a.kind === 'url' ? 'Open' : 'Go');
      action = { kind: a.kind as NotificationAction['kind'], target, label };
    }
    return {
      level: level as NotificationLevel, category: category as NotificationCategory,
      title: cleanDecisionText(input.title, TITLE_MAX), body: typeof input.body === 'string' && input.body.trim() ? cleanNotificationBody(input.body, BODY_MAX) : null, action,
    };
  }

  /** One-way: persists, pushes the frame and returns. There is no waiter and no resolve; subscribers and pruning never block it. */
  async create(userId: string, input: NotificationInput): Promise<Notification> { return this.insert(userId, input, null); }

  /**
   * `ctx.notify`: a notification with a plugin part. It has its own rate bucket (a busy inbox never starves agents' notifications) and
   * replaces the plugin's previous notification with the same tag for this user.
   */
  async createFromPlugin(userId: string, input: PluginNotificationInput): Promise<Notification> {
    const extra = cleanPluginNote(input);
    this.validate({ title: input.note.title, body: input.note.body });
    if (extra.plugin.tag) await this.clearPluginTag(userId, extra.plugin.id, extra.plugin.tag);
    return this.insert(userId, { title: input.note.title, body: input.note.body, level: 'info', category: 'message' }, extra);
  }

  /** Removes one plugin's notifications with this tag for this user. */
  async clearPluginTag(userId: string, pluginId: string, tag: string): Promise<{ removed: number }> {
    let ids: string[];
    if (this.options.pool) ids = ((await this.options.pool.query("DELETE FROM agent_notifications WHERE user_id=$1 AND extra->'plugin'->>'id'=$2 AND extra->'plugin'->>'tag'=$3 RETURNING id", [userId, pluginId, tag])).rows as { id: string }[]).map((r) => r.id);
    else {
      ids = this.mem.filter((n) => n.userId === userId && n.plugin?.id === pluginId && n.plugin.tag === tag).map((n) => n.id);
      this.mem = this.mem.filter((n) => !ids.includes(n.id)); for (const id of ids) this.memPriv.delete(id);
    }
    if (ids.length) this.emit(userId, { type: 'notification-cleared', ids });
    return { removed: ids.length };
  }

  /** The plugin, action list and server-side part of one of this user's plugin notifications (for the action endpoint), or null. */
  async pluginTarget(userId: string, id: string): Promise<{ plugin: NotificationPlugin; priv: NotificationPluginPrivate } | null> {
    if (typeof id !== 'string' || !id || id.length > 64) return null;
    if (!this.options.pool) { const n = this.mem.find((x) => x.userId === userId && x.id === id); const priv = this.memPriv.get(id); return n?.plugin && priv ? { plugin: n.plugin, priv } : null; }
    const row = (await this.options.pool.query('SELECT * FROM agent_notifications WHERE user_id=$1 AND id=$2', [userId, id])).rows[0] as Row | undefined;
    const extra = row ? extraOf(row) : null;
    return extra?.plugin ? { plugin: extra.plugin, priv: extra.priv ?? { route: null, data: null } } : null;
  }

  private async insert(userId: string, input: NotificationInput, extra: Extra | null): Promise<Notification> {
    const clean = this.validate(input);
    if (!clean.title) throw badRequest('title required');
    const now = this.now();
    const bucket = extra ? userId + '|plugin:' + extra.plugin.id : userId;
    const recent = (this.recent.get(bucket) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= (extra ? PLUGIN_RATE_MAX : RATE_MAX)) throw new HttpError(429, 'rate_limited', 'Too many notifications');
    recent.push(now); this.recent.set(bucket, recent);
    const n: Notification = { id: randomUUID(), userId, projectId: input.projectId ?? null, sessionId: input.sessionId ?? null, sessionName: input.sessionName ? cleanDecisionText(input.sessionName, 120) : null, ...clean, createdAt: new Date(now).toISOString(), readAt: null, ...(extra ? { plugin: extra.plugin } : {}) };
    const pool = this.options.pool;
    if (pool) await pool.query('INSERT INTO agent_notifications (id,user_id,project_id,session_id,session_name,level,category,title,body,action,created_at,extra) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)', [n.id, userId, n.projectId, n.sessionId, n.sessionName, n.level, n.category, n.title, n.body, n.action ? JSON.stringify(n.action) : null, n.createdAt, extra ? JSON.stringify(extra) : null]);
    else { this.mem.unshift(n); if (extra) this.memPriv.set(n.id, extra.priv); }
    this.emit(userId, { type: 'notification', notification: n });
    void this.prune(userId).catch(() => undefined);
    return n;
  }

  /** See the retention note above. */
  async prune(userId: string): Promise<void> {
    const cutoff = new Date(this.now() - READ_RETENTION_DAYS * 86400000).toISOString();
    const pool = this.options.pool;
    if (!pool) {
      const mine = this.mem.filter((n) => n.userId === userId && !(n.readAt && n.readAt < cutoff)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, KEEP_PER_USER);
      const keep = new Set(mine.map((n) => n.id));
      this.mem = this.mem.filter((n) => n.userId !== userId || keep.has(n.id));
      return;
    }
    await pool.query('DELETE FROM agent_notifications WHERE user_id=$1 AND read_at IS NOT NULL AND read_at < $2', [userId, cutoff]);
    await pool.query('DELETE FROM agent_notifications WHERE user_id=$1 AND id NOT IN (SELECT id FROM agent_notifications WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2)', [userId, KEEP_PER_USER]);
  }

  /** Newest first. `organizationId` hides notifications of projects outside that organization (project-less ones always show). */
  async list(userId: string, opts: NotificationListOptions = {}): Promise<Notification[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)));
    const pool = this.options.pool;
    if (!pool) {
      return this.mem.filter((n) => n.userId === userId && (!opts.unreadOnly || !n.readAt) && (!opts.projectId || n.projectId === opts.projectId) && (!opts.before || n.createdAt < opts.before))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, limit);
    }
    const where = ['n.user_id=$1']; const params: unknown[] = [userId];
    if (opts.unreadOnly) where.push('n.read_at IS NULL');
    if (opts.projectId) { params.push(opts.projectId); where.push(`n.project_id=$${params.length}`); }
    if (opts.before) { params.push(opts.before); where.push(`n.created_at < $${params.length}`); }
    if (opts.organizationId) { params.push(opts.organizationId); where.push(`(n.project_id IS NULL OR p.organization_id=$${params.length})`); }
    params.push(limit);
    const r = await pool.query(`SELECT n.* FROM agent_notifications n LEFT JOIN floq_projects p ON p.id=n.project_id WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC, n.id DESC LIMIT $${params.length}`, params);
    return (r.rows as Row[]).map(fromRow);
  }

  private ids(raw: unknown): string[] | 'all' {
    if (raw === 'all') return 'all';
    if (!Array.isArray(raw) || raw.length > 500 || raw.some((x) => typeof x !== 'string' || !x || x.length > 64)) throw badRequest("ids must be an array of ids or 'all'");
    return raw as string[];
  }
  async markRead(userId: string, raw: unknown): Promise<{ updated: number }> {
    const ids = this.ids(raw); const at = new Date(this.now()).toISOString(); let updated = 0;
    if (this.options.pool) updated = (await this.options.pool.query(`UPDATE agent_notifications SET read_at=$2 WHERE user_id=$1 AND read_at IS NULL${ids === 'all' ? '' : ' AND id = ANY($3::text[])'}`, ids === 'all' ? [userId, at] : [userId, at, ids])).rowCount ?? 0;
    else for (const n of this.mem) if (n.userId === userId && !n.readAt && (ids === 'all' || ids.includes(n.id))) { n.readAt = at; updated++; }
    this.emit(userId, { type: 'notification-read', ids });
    return { updated };
  }
  async clear(userId: string, raw: unknown): Promise<{ removed: number }> {
    const ids = this.ids(raw); let removed = 0;
    if (this.options.pool) removed = (await this.options.pool.query(`DELETE FROM agent_notifications WHERE user_id=$1${ids === 'all' ? '' : ' AND id = ANY($2::text[])'}`, ids === 'all' ? [userId] : [userId, ids])).rowCount ?? 0;
    else { const before = this.mem.length; this.mem = this.mem.filter((n) => n.userId !== userId || (ids !== 'all' && !ids.includes(n.id))); removed = before - this.mem.length; }
    this.emit(userId, { type: 'notification-cleared', ids });
    return { removed };
  }
}
