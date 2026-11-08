/**
 * Server-side sidebar folders.
 *
 * The folder layout (folders, names, membership/order, expanded state) lives on the runtime, per user, so it survives
 * clearing site data or reinstalling the app. The UI keeps reading localStorage (`floq.projectFolders.<scope>`,
 * `floq.projectLayout.v1.<scope>`, `floq.projectFolderExpanded.<scope>`): that is now only an offline cache that this
 * engine keeps in step with the server.
 *
 * Pure and dependency free (no React, no DOM) so scripts/dev/test-project-folders-sync.mjs can drive it with fakes.
 */

export interface FoldersDoc {
  folders: Array<{ id: string; name: string }>;
  root: Array<{ kind: "project" | "folder"; id: string }>;
  /** folder id -> project ids in order */
  membership: Record<string, string[]>;
  /** folder id -> expanded (absent = expanded) */
  expanded: Record<string, boolean>;
  children?: Record<string, Array<{ kind: "project" | "folder"; id: string }>>;
}
export interface FoldersState { version: number; doc: FoldersDoc | null }

export const MAX_FOLDERS = 200;
export const MAX_FOLDER_NAME = 80;
const ID = /^[A-Za-z0-9._:-]{1,64}$/;

export const EMPTY_DOC: FoldersDoc = { folders: [], root: [], membership: {}, expanded: {} };

/* ---------- canonical form, equality, normalisation ---------- */

/** Drop empties, bad ids and over-cap data so what we compare and send is always valid for the server. */
export function normalizeDoc(doc: FoldersDoc): FoldersDoc {
  const seenFolders = new Set<string>();
  const folders: FoldersDoc["folders"] = [];
  for (const folder of doc.folders ?? []) {
    const name = typeof folder?.name === "string" ? folder.name.trim().slice(0, MAX_FOLDER_NAME) : "";
    if (!folder || typeof folder.id !== "string" || !ID.test(folder.id) || !name || seenFolders.has(folder.id) || folders.length >= MAX_FOLDERS) continue;
    seenFolders.add(folder.id);
    folders.push({ id: folder.id, name });
  }
  if (doc.children && typeof doc.children === "object") {
    const seenFolders = new Set<string>();
    const seenProjects = new Set<string>();
    const children: NonNullable<FoldersDoc["children"]> = {};
    const membership: Record<string, string[]> = {};
    const walk = (entries: FoldersDoc["root"], depth: number): FoldersDoc["root"] => {
      const result: FoldersDoc["root"] = [];
      for (const entry of entries) {
        if (!entry || typeof entry.id !== "string") continue;
        if (entry.kind === "project" && ID.test(entry.id) && !seenProjects.has(entry.id)) {
          seenProjects.add(entry.id); result.push({ kind: "project", id: entry.id });
        } else if (entry.kind === "folder" && depth <= 8 && folders.some((folder) => folder.id === entry.id) && !seenFolders.has(entry.id)) {
          seenFolders.add(entry.id); result.push({ kind: "folder", id: entry.id });
          const raw = doc.children?.[entry.id];
          children[entry.id] = walk(Array.isArray(raw) ? raw : (doc.membership?.[entry.id] ?? []).map((id) => ({ kind: "project" as const, id })), depth + 1);
          const projects = children[entry.id].filter((child) => child.kind === "project").map((child) => child.id);
          if (projects.length) membership[entry.id] = projects;
        }
      }
      return result;
    };
    const root = walk(Array.isArray(doc.root) ? doc.root : [], 1);
    for (const folder of folders) if (!seenFolders.has(folder.id)) root.push(...walk([{ kind: "folder", id: folder.id }], 1));
    const expanded: Record<string, boolean> = {};
    for (const folder of folders) if (typeof doc.expanded?.[folder.id] === "boolean") expanded[folder.id] = doc.expanded[folder.id];
    return { folders, root, membership, expanded, children };
  }
  const seenProjects = new Set<string>();
  const seenRootFolders = new Set<string>();
  const root: FoldersDoc["root"] = [];
  for (const entry of doc.root ?? []) {
    if (!entry || typeof entry.id !== "string") continue;
    if (entry.kind === "folder" && seenFolders.has(entry.id) && !seenRootFolders.has(entry.id)) { seenRootFolders.add(entry.id); root.push({ kind: "folder", id: entry.id }); }
    else if (entry.kind === "project" && ID.test(entry.id) && !seenProjects.has(entry.id)) { seenProjects.add(entry.id); root.push({ kind: "project", id: entry.id }); }
  }
  for (const folder of folders) if (!seenRootFolders.has(folder.id)) { seenRootFolders.add(folder.id); root.push({ kind: "folder", id: folder.id }); }
  const membership: Record<string, string[]> = {};
  for (const folder of folders) {
    const list: string[] = [];
    for (const id of doc.membership?.[folder.id] ?? []) {
      if (typeof id !== "string" || !ID.test(id) || seenProjects.has(id)) continue;
      seenProjects.add(id);
      list.push(id);
    }
    if (list.length) membership[folder.id] = list;
  }
  const expanded: Record<string, boolean> = {};
  for (const folder of folders) if (typeof doc.expanded?.[folder.id] === "boolean") expanded[folder.id] = doc.expanded[folder.id];
  return { folders, root, membership, expanded };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

/** Stable JSON of the normalised document. Two docs with the same meaning have the same canon. */
export function canon(doc: FoldersDoc | null): string {
  const n = normalizeDoc(doc ?? EMPTY_DOC);
  return JSON.stringify({ folders: n.folders, root: n.root, membership: sortedRecord(n.membership), expanded: sortedRecord(n.expanded), ...(n.children ? { children: sortedRecord(n.children) } : {}) });
}
export const docsEqual = (a: FoldersDoc | null, b: FoldersDoc | null) => canon(a) === canon(b);
export const isEmptyDoc = (doc: FoldersDoc | null) => !doc || (normalizeDoc(doc).folders.length === 0 && normalizeDoc(doc).root.length === 0);

const layoutCanon = (doc: FoldersDoc) => { const n = normalizeDoc(doc); return JSON.stringify({ r: n.root, m: sortedRecord(n.membership), c: n.children ? sortedRecord(n.children) : undefined }); };

/**
 * Three-way merge of the last synced document (`base`), this device's current one (`local`) and the server's (`remote`).
 *  - folders: start from the server's, then apply what THIS device changed since `base` (added, removed, renamed).
 *  - layout (order + membership): if this device did not touch it, take the server's; otherwise this device's wins
 *    (last write wins: the user's latest action is what they expect to see).
 *  - expanded: the server's, overlaid with the keys this device changed.
 * With no base (never synced) everything local counts as "added by this device", so folders are unioned.
 */
export function mergeDocs(base: FoldersDoc | null, local: FoldersDoc, remote: FoldersDoc): FoldersDoc {
  const b = normalizeDoc(base ?? EMPTY_DOC);
  const l = normalizeDoc(local);
  const r = normalizeDoc(remote);
  const baseById = new Map(b.folders.map((f) => [f.id, f]));
  const localById = new Map(l.folders.map((f) => [f.id, f]));
  const folders = r.folders.map((f) => ({ ...f })).filter((f) => !(baseById.has(f.id) && !localById.has(f.id)));
  for (const f of folders) {
    const was = baseById.get(f.id);
    const now = localById.get(f.id);
    if (was && now && now.name !== was.name) f.name = now.name;
  }
  const present = new Set(folders.map((f) => f.id));
  for (const f of l.folders) if (!baseById.has(f.id) && !present.has(f.id)) { folders.push({ ...f }); present.add(f.id); }

  const localTouchedLayout = layoutCanon(l) !== layoutCanon(b);
  const layoutSource = localTouchedLayout ? l : r;
  let root = layoutSource.root;
  let children = layoutSource.children;
  if (localTouchedLayout && r.children) {
    children = Object.fromEntries(folders.map((folder) => [folder.id, (l.children?.[folder.id] ?? (l.membership[folder.id] ?? []).map((id) => ({ kind: "project" as const, id }))).slice()]));
    root = [...l.root];
    const baseEntries = new Set([...b.root, ...Object.values(b.children ?? {}).flat(), ...Object.values(b.membership).flat().map((id) => ({ kind: "project" as const, id }))].map((entry) => `${entry.kind}:${entry.id}`));
    const localEntries = new Set([...root, ...Object.values(children).flat()].map((entry) => `${entry.kind}:${entry.id}`));
    const addNew = (entries: FoldersDoc["root"], target: FoldersDoc["root"]) => {
      for (const entry of entries) {
        const key = `${entry.kind}:${entry.id}`;
        if (!baseEntries.has(key) && !localEntries.has(key) && (entry.kind !== "folder" || present.has(entry.id))) {
          target.push(entry); localEntries.add(key);
        }
        if (entry.kind === "folder" && present.has(entry.id)) addNew(r.children?.[entry.id] ?? [], children![entry.id]);
      }
    };
    addNew(r.root, root);
  }
  const expanded: Record<string, boolean> = { ...r.expanded };
  for (const [id, open] of Object.entries(l.expanded)) if (b.expanded[id] !== open) expanded[id] = open;
  return normalizeDoc({ folders, root, membership: layoutSource.membership, expanded, children });
}

/* ---------- engine ---------- */

export interface SyncMeta {
  /** Server version this device last saw (0 = server had nothing). */
  version: number;
  /** The document at that version: the base for three-way merges. */
  base: FoldersDoc | null;
  /** Local edits not yet acknowledged by the server (survives reloads, so an offline edit is pushed later). */
  dirty: boolean;
}

export interface SyncDeps {
  api: {
    get(): Promise<FoldersState>;
    put(version: number, doc: FoldersDoc, options?: { keepalive?: boolean }): Promise<FoldersState>;
  };
  local: { read(): FoldersDoc; write(doc: FoldersDoc): void };
  meta: { load(): SyncMeta | null; save(meta: SyncMeta): void };
  timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** Called with the document this device is about to overwrite with the server's, when it had never synced before. */
  backup?: (doc: FoldersDoc) => void;
  /** After 3 consecutive failed saves (once per streak). */
  onRepeatedFailure?: (error: unknown) => void;
  /** Local state was replaced by the server's (another device changed it). */
  onRemoteApplied?: () => void;
  debounceMs?: number;
}

const isConflict = (error: unknown) => (error as { status?: number; code?: string } | null)?.status === 409;
export const BACKOFF_MS = (failures: number) => Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1));

export class FolderSync {
  private meta: SyncMeta;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private applying = false;
  private disposed = false;
  private failures = 0;
  private reported = false;

  private readonly deps: SyncDeps;

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.meta = deps.meta.load() ?? { version: 0, base: null, dirty: false };
  }

  get state(): SyncMeta { return this.meta; }

  private save(meta: SyncMeta) { this.meta = meta; this.deps.meta.save(meta); }
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }
  private writeLocal(doc: FoldersDoc) {
    this.applying = true;
    try { this.deps.local.write(doc); } finally { this.applying = false; }
  }

  /** First load, window focus and the 60 s poll: fetch the server's document and reconcile with this device. */
  pull(): Promise<void> {
    return this.run(() => this.pullNow());
  }

  /** Call whenever the local cache changed. Ignores our own writes and no-op changes. */
  notifyLocalChange(): void {
    if (this.applying || this.disposed) return;
    const local = this.deps.local.read();
    if (!this.meta.dirty && docsEqual(local, this.meta.base) && (this.meta.base !== null || isEmptyDoc(local))) return;
    if (!this.meta.dirty) this.save({ ...this.meta, dirty: true });
    this.schedule(this.deps.debounceMs ?? 500);
  }

  private schedule(ms: number) {
    if (this.disposed) return;
    if (this.timer !== null) this.deps.timers.clear(this.timer);
    this.timer = this.deps.timers.set(() => { this.timer = null; void this.run(() => this.pushNow()).catch(() => undefined); }, ms);
  }

  /** Push pending edits now. With `keepalive` the request survives the page closing; no response handling then. */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.timer !== null) { this.deps.timers.clear(this.timer); this.timer = null; }
    if (options.keepalive) {
      if (!this.meta.dirty) return Promise.resolve();
      const local = normalizeDoc(this.deps.local.read());
      void this.deps.api.put(this.meta.version, local, { keepalive: true }).catch(() => undefined);
      return Promise.resolve();
    }
    return this.run(() => this.pushNow());
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.timers.clear(this.timer);
    if (this.retryTimer !== null) this.deps.timers.clear(this.retryTimer);
    this.timer = this.retryTimer = null;
  }

  private async pullNow(): Promise<void> {
    if (this.disposed) return;
    const server = await this.deps.api.get();
    if (this.disposed) return;
    const local = this.deps.local.read();
    if (!server.doc) {
      // The server has nothing for this user. Migrate whatever this device has (once), idempotently.
      if (isEmptyDoc(local)) { this.save({ version: 0, base: null, dirty: false }); return; }
      this.save({ version: 0, base: this.meta.base, dirty: true });
      await this.pushNow();
      return;
    }
    const remote = normalizeDoc(server.doc);
    const neverSynced = this.meta.base === null && this.meta.version === 0;
    if (this.meta.dirty) {
      const merged = mergeDocs(this.meta.base, local, remote);
      if (!docsEqual(merged, local)) this.writeLocal(merged);
      this.save({ version: server.version, base: remote, dirty: !docsEqual(merged, remote) });
      if (this.meta.dirty) await this.pushNow();
      return;
    }
    if (!docsEqual(local, remote)) {
      if (neverSynced && !isEmptyDoc(local)) this.deps.backup?.(local);
      this.writeLocal(remote);
      this.deps.onRemoteApplied?.();
    }
    this.save({ version: server.version, base: remote, dirty: false });
  }

  private async pushNow(): Promise<void> {
    if (this.disposed) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this.meta.dirty) return;
      const doc = normalizeDoc(this.deps.local.read());
      if (this.meta.base && docsEqual(doc, this.meta.base) && this.meta.version > 0) { this.save({ ...this.meta, dirty: false }); return; }
      try {
        const saved = await this.deps.api.put(this.meta.version, doc);
        this.failures = 0; this.reported = false;
        if (this.retryTimer !== null) { this.deps.timers.clear(this.retryTimer); this.retryTimer = null; }
        const stored = normalizeDoc(saved.doc ?? doc);
        // Edits made while the request was in flight are still pending.
        const stillDirty = !docsEqual(this.deps.local.read(), stored);
        this.save({ version: Number.isInteger(saved.version) ? saved.version : this.meta.version + 1, base: stored, dirty: stillDirty });
        if (stillDirty) this.schedule(this.deps.debounceMs ?? 500);
        return;
      } catch (error) {
        if (isConflict(error)) {
          const server = await this.deps.api.get();
          const remote = normalizeDoc(server.doc ?? EMPTY_DOC);
          const merged = mergeDocs(this.meta.base, this.deps.local.read(), remote);
          if (!docsEqual(merged, this.deps.local.read())) this.writeLocal(merged);
          this.save({ version: server.version, base: remote, dirty: !docsEqual(merged, remote) });
          continue;
        }
        this.failures += 1;
        if (this.failures >= 3 && !this.reported) { this.reported = true; this.deps.onRepeatedFailure?.(error); }
        if (!this.disposed) {
          if (this.retryTimer !== null) this.deps.timers.clear(this.retryTimer);
          this.retryTimer = this.deps.timers.set(() => { this.retryTimer = null; void this.run(() => this.pushNow()).catch(() => undefined); }, BACKOFF_MS(this.failures));
        }
        return;
      }
    }
  }
}
