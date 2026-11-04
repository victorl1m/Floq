/**
 * Pending-deletes registry: soft, reversible deletion with a grace period.
 *
 * Pure (no React, no DOM): timers, clock and storage are injected so it is unit-testable.
 *
 * Lifecycle of an id:  schedule() -> [undoable batch, hidden] -> grace timer fires (or dismiss())
 *                      -> [in flight, still hidden] -> finalize(id) resolves -> gone
 *                                                   -> finalize(id) rejects  -> restored + onFailed
 * undo() during the undoable phase simply forgets the batch: nothing was ever sent to the server.
 *
 * Reload / quit within the grace period: flushAll() (called on `pagehide`) fires `sendOnUnload` for
 * every pending id (keepalive DELETE). Every pending id is also mirrored to storage (sessionStorage,
 * per tab) and stays there until the server confirmed it. A new registry reads that list, keeps the
 * ids hidden at once, and recover() re-sends the DELETE (a 404 counts as success, so the double send
 * after a successful keepalive is harmless). Undo is not possible after a reload.
 */

export interface PendingItem {
  id: string;
  label: string;
  /** "terminal" | "agent" — only used for wording. */
  kind: string;
}

export interface PendingBatch {
  key: string;
  items: PendingItem[];
  /** Epoch ms at which the batch is finalised. */
  deadline: number;
  /** Epoch ms of the last schedule() that touched the batch (merge window anchor). */
  touchedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingDeletesOptions {
  /** Time the user has to undo. Default 8000. */
  graceMs?: number;
  /** A schedule() within this window of the previous one joins its batch. Default 3000. */
  mergeMs?: number;
  /** Really delete one id. Reject to report failure; a "gone already" outcome must resolve. */
  finalize: (id: string) => Promise<void>;
  /** Fire-and-forget delete used while the page is unloading (keepalive request). */
  sendOnUnload?: (id: string) => void;
  /** An item could not be deleted and is visible again. */
  onFailed?: (item: PendingItem, error: unknown) => void;
  /** Items the server confirmed. */
  onFinalized?: (items: PendingItem[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  storage?: StorageLike | null;
  storageKey?: string;
}

export const PENDING_DELETES_STORAGE_KEY = "floq.pendingDeletes";
export const DEFAULT_GRACE_MS = 8000;
export const DEFAULT_MERGE_MS = 3000;

interface PersistedEntry extends PendingItem { deadline: number }

export class PendingDeletes {
  private readonly graceMs: number;
  private readonly mergeMs: number;
  private readonly opts: PendingDeletesOptions;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly batches = new Map<string, { batch: PendingBatch; timer: unknown }>();
  private readonly inflight = new Map<string, PendingItem>();
  private readonly flushed = new Map<string, PendingItem>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private recovered: PendingItem[] = [];

  constructor(opts: PendingDeletesOptions) {
    this.opts = opts;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.mergeMs = opts.mergeMs ?? DEFAULT_MERGE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.storage = opts.storage === undefined ? safeSessionStorage() : opts.storage;
    this.storageKey = opts.storageKey ?? PENDING_DELETES_STORAGE_KEY;
    for (const entry of this.readStorage()) {
      const item = { id: entry.id, label: entry.label, kind: entry.kind };
      this.inflight.set(item.id, item);
      this.recovered.push(item);
    }
  }

  /** Ids that must be hidden everywhere: undoable, in flight, flushed or recovered. */
  pendingIds(): Set<string> {
    const ids = new Set<string>();
    for (const { batch } of this.batches.values()) for (const item of batch.items) ids.add(item.id);
    for (const id of this.inflight.keys()) ids.add(id);
    for (const id of this.flushed.keys()) ids.add(id);
    return ids;
  }

  has(id: string): boolean {
    return this.pendingIds().has(id);
  }

  /** The most recent batch that can still be undone. */
  latest(): PendingBatch | null {
    let last: PendingBatch | null = null;
    for (const { batch } of this.batches.values()) last = batch;
    return last;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Soft-delete items. Returns the batch they joined (new, or merged into the latest one). */
  schedule(items: PendingItem[]): PendingBatch | null {
    const known = this.pendingIds();
    const fresh = items.filter((item, index) => !known.has(item.id) && items.findIndex((other) => other.id === item.id) === index);
    if (fresh.length === 0) return null;
    const now = this.now();
    const latest = this.latest();
    let key: string;
    let batch: PendingBatch;
    if (latest && now - latest.touchedAt <= this.mergeMs) {
      key = latest.key;
      const entry = this.batches.get(key)!;
      this.clearTimer(entry.timer);
      batch = { ...latest, items: [...latest.items, ...fresh], deadline: now + this.graceMs, touchedAt: now };
    } else {
      key = `batch-${++this.seq}`;
      batch = { key, items: fresh, deadline: now + this.graceMs, touchedAt: now };
    }
    const timer = this.setTimer(() => { void this.finalizeBatch(key); }, this.graceMs);
    this.batches.set(key, { batch, timer });
    this.persist();
    this.emit();
    return batch;
  }

  /** Restore a batch (default: the latest). Returns its items; nothing was sent to the server. */
  undo(key?: string): PendingItem[] {
    const target = key ? this.batches.get(key) : this.batches.get(this.latest()?.key ?? "");
    if (!target) return [];
    this.clearTimer(target.timer);
    this.batches.delete(target.batch.key);
    this.persist();
    this.emit();
    return target.batch.items;
  }

  /** Finalise a batch now (toast dismissed by the user). No-op when it was undone or already finalised. */
  dismiss(key: string): Promise<void> {
    return this.finalizeBatch(key);
  }

  /** Page is going away: send every pending delete with keepalive; storage keeps them for recovery. */
  flushAll(): void {
    for (const [key, entry] of [...this.batches]) {
      this.clearTimer(entry.timer);
      this.batches.delete(key);
      for (const item of entry.batch.items) this.flushed.set(item.id, item);
    }
    for (const [id, item] of this.inflight) this.flushed.set(id, item);
    this.persist();
    for (const id of this.flushed.keys()) this.opts.sendOnUnload?.(id);
  }

  /** Re-send deletes that a previous page load left behind. Call once the client is ready. */
  async recover(): Promise<void> {
    const items = this.recovered;
    this.recovered = [];
    if (items.length === 0) return;
    this.emit();
    await this.finalizeItems(items);
  }

  private async finalizeBatch(key: string): Promise<void> {
    const entry = this.batches.get(key);
    if (!entry) return;
    this.clearTimer(entry.timer);
    this.batches.delete(key);
    for (const item of entry.batch.items) this.inflight.set(item.id, item);
    this.persist();
    this.emit();
    await this.finalizeItems(entry.batch.items);
  }

  private async finalizeItems(items: PendingItem[]): Promise<void> {
    const done: PendingItem[] = [];
    await Promise.all(items.map(async (item) => {
      try {
        await this.opts.finalize(item.id);
        done.push(item);
        this.inflight.delete(item.id);
      } catch (error) {
        this.inflight.delete(item.id);
        this.opts.onFailed?.(item, error);
      }
      this.persist();
      this.emit();
    }));
    if (done.length > 0) this.opts.onFinalized?.(done);
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  private persist() {
    if (!this.storage) return;
    const entries = new Map<string, PersistedEntry>();
    for (const { batch } of this.batches.values()) for (const item of batch.items) entries.set(item.id, { ...item, deadline: batch.deadline });
    for (const item of this.inflight.values()) if (!entries.has(item.id)) entries.set(item.id, { ...item, deadline: this.now() });
    for (const item of this.flushed.values()) if (!entries.has(item.id)) entries.set(item.id, { ...item, deadline: this.now() });
    try {
      if (entries.size === 0) this.storage.removeItem(this.storageKey);
      else this.storage.setItem(this.storageKey, JSON.stringify([...entries.values()]));
    } catch {
      /* storage unavailable: recovery is best effort */
    }
  }

  private readStorage(): PersistedEntry[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is PersistedEntry =>
        !!entry && typeof entry.id === "string" && typeof entry.label === "string" && typeof entry.kind === "string");
    } catch {
      return [];
    }
  }
}

function safeSessionStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** "Terminal \"X\" deleted" / "3 terminals deleted" / "3 sessions deleted". */
export function describeBatch(items: PendingItem[]): { title: string; noun: string } {
  const kinds = new Set(items.map((item) => item.kind));
  const single = kinds.size === 1 ? [...kinds][0] : "session";
  const noun = single === "terminal" ? "terminal" : single === "agent" ? "agent" : "session";
  if (items.length === 1) return { title: `${noun[0].toUpperCase()}${noun.slice(1)} "${items[0].label}" deleted`, noun };
  return { title: `${items.length} ${noun}s deleted`, noun };
}
