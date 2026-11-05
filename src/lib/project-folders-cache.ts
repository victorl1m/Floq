import { useCallback, useSyncExternalStore } from "react";
import { layoutEvent, parseLayout, readLayoutRaw, saveLayout, type ProjectLayout } from "./project-folders";
import { loadCanonicalProjectMeta, loadProjectFolders, saveProjectFolders } from "./prefs";
import { loadUserPreferences } from "./user-preferences";
import { normalizeDoc, type FoldersDoc, type SyncMeta } from "./project-folders-sync";

/**
 * The browser-side half of the server-backed folders: localStorage is only an offline cache, keyed by
 * `<runtime url>:<user id>` (see projectScope) so two accounts on one device never see each other's layout.
 */

const expandedKey = (scope: string) => `floq.projectFolderExpanded.${encodeURIComponent(scope)}`;
const metaKey = (scope: string) => `floq.projectFoldersSync.v1.${encodeURIComponent(scope)}`;
const backupKey = (scope: string) => `floq.projectFolders.backup.${encodeURIComponent(scope)}`;
/** Fired to ask the sync engine to re-fetch now (e.g. after the server pruned a deleted project). */
export const FOLDERS_PULL_EVENT = "floq:project-folders-pull";

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* optional when storage is blocked */ }
}

/* ---------- expanded state ---------- */

function parseExpanded(raw: string | null): Record<string, boolean> | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { return {}; }
}

export function loadFolderExpanded(scope: string): Record<string, boolean> {
  return parseExpanded(readStorage(expandedKey(scope))) ?? {};
}

export function saveFolderExpanded(scope: string, expanded: Record<string, boolean>): void {
  writeStorage(expandedKey(scope), JSON.stringify(expanded));
  try { window.dispatchEvent(new Event(layoutEvent())); } catch { /* non-browser */ }
}

export function setFolderExpanded(scope: string, folderId: string, open: boolean): void {
  saveFolderExpanded(scope, { ...loadFolderExpanded(scope), [folderId]: open });
}

const EMPTY_EXPANDED: Record<string, boolean> = {};
const expandedSnapshots = new Map<string, { raw: string | null; value: Record<string, boolean> }>();

export function useFolderExpanded(scope: string): Record<string, boolean> {
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener(layoutEvent(), callback);
    window.addEventListener("storage", callback);
    return () => { window.removeEventListener(layoutEvent(), callback); window.removeEventListener("storage", callback); };
  }, []);
  const snapshot = useCallback(() => {
    const raw = readStorage(expandedKey(scope));
    const cached = expandedSnapshots.get(scope);
    if (cached && cached.raw === raw) return cached.value;
    const value = parseExpanded(raw) ?? EMPTY_EXPANDED;
    expandedSnapshots.set(scope, { raw, value });
    return value;
  }, [scope]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY_EXPANDED);
}

/* ---------- document <-> cache ---------- */

/**
 * Assemble the document from the cache. Layouts saved before this feature may not exist yet (the sidebar only saved
 * after a drag), so fall back to the legacy per-project folder assignment and the old "folder expanded" preference:
 * that is what gets migrated to the server the first time.
 */
export function readLocalDoc(scope: string, baseUrl: string | null, userId: string | null): FoldersDoc {
  const folders = loadProjectFolders(scope);
  const known = new Set(folders.map((folder) => folder.id));
  const saved = parseLayout(readLayoutRaw(scope));
  let root: FoldersDoc["root"];
  let membership: Record<string, string[]>;
  if (saved) {
    root = saved.root;
    membership = saved.folders;
  } else {
    root = [];
    membership = {};
    for (const meta of loadCanonicalProjectMeta(scope)) {
      if (meta.folderId && known.has(meta.folderId)) (membership[meta.folderId] ??= []).push(meta.projectId);
    }
  }
  const storedExpanded = parseExpanded(readStorage(expandedKey(scope)));
  const expanded = storedExpanded ?? Object.fromEntries(Object.entries(loadUserPreferences(baseUrl, userId).folderNavExpanded ?? {}).filter(([id]) => known.has(id)));
  return normalizeDoc({ folders, root, membership, expanded, children: saved?.children });
}

export function writeLocalDoc(scope: string, doc: FoldersDoc): void {
  const normalized = normalizeDoc(doc);
  saveProjectFolders(scope, normalized.folders);
  const layout: ProjectLayout = { root: normalized.root, folders: Object.fromEntries(normalized.folders.map((folder) => [folder.id, normalized.membership[folder.id] ?? []])), ...(normalized.children ? { children: normalized.children } : {}) };
  saveLayout(scope, layout);
  saveFolderExpanded(scope, normalized.expanded);
}

/* ---------- sync metadata + backup ---------- */

export function loadSyncMeta(scope: string): SyncMeta | null {
  const raw = readStorage(metaKey(scope));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SyncMeta>;
    if (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 0) return null;
    return { version: value.version, base: value.base ? normalizeDoc(value.base) : null, dirty: value.dirty === true };
  } catch { return null; }
}

export function saveSyncMeta(scope: string, meta: SyncMeta): void {
  writeStorage(metaKey(scope), JSON.stringify(meta));
}

/** Keep the pre-sync device layout: written before it is replaced by the server's copy. */
export function backupLocalDoc(scope: string, doc: FoldersDoc): void {
  writeStorage(backupKey(scope), JSON.stringify({ savedAt: new Date().toISOString(), doc }));
}
