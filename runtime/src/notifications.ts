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
export type Notification = {
  id: string; userId: string; projectId: string | null; sessionId: string | null; sessionName: string | null;
  level: NotificationLevel; category: NotificationCategory; title: string; body: string | null;
  action: NotificationAction | null; createdAt: string; readAt: string | null;
};
export type NotificationFrame =
  | { type: 'notification'; notification: Notification }
  | { type: 'notification-read'; ids: string[] | 'all' }
  | { type: 'notification-cleared'; ids: string[] | 'all' };
export type NotificationInput = {
  title: unknown; body?: unknown; level?: unknown; category?: unknown; action?: unknown;
  projectId?: string | null; sessionId?: string | null; sessionName?: string | null;
};
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

type Row = { id: string; user_id: string; project_id: string | null; session_id: string | null; session_name: string | null; level: string; category: string; title: string; body: string | null; action: NotificationAction | string | null; created_at: Date | string; read_at: Date | string | null };
const iso = (v: Date | string) => new Date(v).toISOString();
const fromRow = (r: Row): Notification => ({
  id: r.id, userId: r.user_id, projectId: r.project_id, sessionId: r.session_id, sessionName: r.session_name,
  level: r.level as NotificationLevel, category: r.category as NotificationCategory, title: r.title, body: r.body,
  action: typeof r.action === 'string' ? JSON.parse(r.action) as NotificationAction : r.action, createdAt: iso(r.created_at), readAt: r.read_at ? iso(r.read_at) : null,
});

export class Notifications {
  private mem: Notification[] = [];
  private subs = new Set<{ userId: string; fn: (frame: NotificationFrame) => void }>();
  private recent = new Map<string, number[]>();
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
  async create(userId: string, input: NotificationInput): Promise<Notification> {
    const clean = this.validate(input);
    if (!clean.title) throw badRequest('title required');
    const now = this.now();
    const recent = (this.recent.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX) throw new HttpError(429, 'rate_limited', 'Too many notifications');
    recent.push(now); this.recent.set(userId, recent);
    const n: Notification = { id: randomUUID(), userId, projectId: input.projectId ?? null, sessionId: input.sessionId ?? null, sessionName: input.sessionName ? cleanDecisionText(input.sessionName, 120) : null, ...clean, createdAt: new Date(now).toISOString(), readAt: null };
    const pool = this.options.pool;
    if (pool) await pool.query('INSERT INTO agent_notifications (id,user_id,project_id,session_id,session_name,level,category,title,body,action,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)', [n.id, userId, n.projectId, n.sessionId, n.sessionName, n.level, n.category, n.title, n.body, n.action ? JSON.stringify(n.action) : null, n.createdAt]);
    else this.mem.unshift(n);
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
