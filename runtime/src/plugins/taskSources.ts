import { HttpError } from "../errors.js";

export type StatusCategory = "todo" | "doing" | "done";

/** Normalized external ticket. Plugins return anything; the host validates and clamps it to this shape. */
export interface ExternalTask {
  sourceId: string;
  externalId: string;
  title: string;
  status: string;
  statusCategory: StatusCategory;
  assignee?: string;
  priority?: string;
  url: string;
  updatedAt: string;
  fields: { label: string; value: string }[];
}

export interface TaskListPage { items: ExternalTask[]; nextCursor?: string }
export interface TaskSourceProvider {
  list(userId: string, opts: { query?: string; cursor?: string }): Promise<{ items: unknown[]; nextCursor?: string }>;
  get(userId: string, externalId: string): Promise<unknown | null>;
}

const clamp = (v: unknown, max: number): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
const CATEGORIES: StatusCategory[] = ["todo", "doing", "done"];

/** Returns null when the item is unusable (no id, title or http(s) url). */
export function normalizeTask(raw: unknown, sourceId: string): ExternalTask | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const externalId = clamp(r.externalId, 200).trim();
  const title = clamp(r.title, 300).trim();
  let url = "";
  try { const u = new URL(String(r.url ?? "")); if (u.protocol === "https:" || u.protocol === "http:") url = u.toString(); } catch { /* dropped below */ }
  if (!externalId || !title || !url) return null;
  const t = Date.parse(String(r.updatedAt ?? ""));
  const fields = (Array.isArray(r.fields) ? r.fields : []).slice(0, 20).flatMap((f) => {
    const o = f as { label?: unknown; value?: unknown } | null;
    const label = clamp(o?.label, 80), value = clamp(o?.value, 1000);
    return label ? [{ label, value }] : [];
  });
  const out: ExternalTask = {
    sourceId, externalId, title, status: clamp(r.status, 100), statusCategory: CATEGORIES.includes(r.statusCategory as StatusCategory) ? (r.statusCategory as StatusCategory) : "todo",
    url, updatedAt: new Date(Number.isFinite(t) ? t : 0).toISOString(), fields,
  };
  const assignee = clamp(r.assignee, 120); if (assignee) out.assignee = assignee;
  const priority = clamp(r.priority, 60); if (priority) out.priority = priority;
  return out;
}

interface Registered { pluginId: string; id: string; provider: TaskSourceProvider }
interface CacheEntry { at: number; value: unknown }
export const TASK_CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

export class TaskSourceRegistry {
  private readonly sources = new Map<string, Registered>();
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  register(pluginId: string, id: string, provider: TaskSourceProvider): void { this.sources.set(pluginId + "/" + id, { pluginId, id, provider }); }

  unregisterPlugin(pluginId: string): void {
    for (const [k, s] of this.sources) if (s.pluginId === pluginId) this.sources.delete(k);
    this.invalidate(pluginId);
  }

  has(pluginId: string, id: string): boolean { return this.sources.has(pluginId + "/" + id); }

  /** Drops cached pages of a plugin, optionally of one user only. Call after settings change. */
  invalidate(pluginId: string, userId?: string): void {
    for (const k of this.cache.keys()) {
      const [u, p] = k.split("\u0001");
      if (p === pluginId && (userId === undefined || u === userId)) this.cache.delete(k);
    }
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    const t = this.now();
    if (hit && t - hit.at < TASK_CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: t, value });
    if (this.cache.size > CACHE_MAX) for (const k of this.cache.keys()) { if (this.cache.size <= CACHE_MAX) break; this.cache.delete(k); }
    return value;
  }

  private provider(pluginId: string, id: string): Registered {
    const s = this.sources.get(pluginId + "/" + id);
    if (!s) throw new HttpError(404, "source_not_found", "Task source not found");
    return s;
  }

  async items(userId: string, pluginId: string, id: string, opts: { query?: string; cursor?: string }, onError: (e: unknown) => void): Promise<TaskListPage> {
    const s = this.provider(pluginId, id);
    const sourceId = `${pluginId}/${id}`;
    const key = [userId, pluginId, id, "list", opts.query ?? "", opts.cursor ?? ""].join("\u0001");
    try {
      return await this.cached(key, async () => {
        const page = await s.provider.list(userId, opts);
        const items = (Array.isArray(page?.items) ? page.items : []).slice(0, 200).map((i) => normalizeTask(i, sourceId)).filter((i): i is ExternalTask => i !== null);
        const nextCursor = clamp(page?.nextCursor, 500) || undefined;
        return nextCursor ? { items, nextCursor } : { items };
      });
    } catch (error) { throw this.mapError(error, onError); }
  }

  async item(userId: string, pluginId: string, id: string, externalId: string, onError: (e: unknown) => void): Promise<ExternalTask> {
    const s = this.provider(pluginId, id);
    const key = [userId, pluginId, id, "get", externalId].join("\u0001");
    try {
      const task = await this.cached(key, async () => normalizeTask(await s.provider.get(userId, externalId), `${pluginId}/${id}`));
      if (!task) throw new HttpError(404, "item_not_found", "Item not found");
      return task;
    } catch (error) { throw this.mapError(error, onError); }
  }

  /** Never forwards upstream text: provider errors become 502 `source_unavailable`. `not_configured` and our own 404s pass through. */
  private mapError(error: unknown, onError: (e: unknown) => void): HttpError {
    if (error instanceof HttpError && (error.code === "not_configured" || error.code === "item_not_found")) return error;
    onError(error);
    return new HttpError(502, "source_unavailable", "The task source is unavailable. Try again later.");
  }
}
