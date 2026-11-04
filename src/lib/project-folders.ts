/**
 * Sidebar project layout: the order of root entries (projects + folders) and of the projects inside each folder.
 *
 * Folder names live in prefs.ts (`floq.projectFolders.<scope>`); this module owns membership and order and persists
 * it per runtime + account in localStorage (`floq.projectLayout.v1.<scope>`), like every other sidebar preference.
 * Everything here is pure and dependency free except for the small storage/subscription helpers at the bottom.
 */

export interface LayoutEntry { kind: "project" | "folder"; id: string }
export interface ProjectLayout { root: LayoutEntry[]; folders: Record<string, string[]> }
export type DropEdge = "before" | "after" | "into";

export const EMPTY_LAYOUT: ProjectLayout = { root: [], folders: {} };

const same = (a: LayoutEntry, kind: LayoutEntry["kind"], id: string) => a.kind === kind && a.id === id;

/** Validate untrusted JSON into a layout; anything malformed degrades to "no saved layout". */
export function parseLayout(raw: string | null): ProjectLayout | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; root?: unknown; folders?: unknown };
    if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.root)) return null;
    const root: LayoutEntry[] = [];
    for (const entry of value.root as unknown[]) {
      const e = entry as { kind?: unknown; id?: unknown } | null;
      if (e && (e.kind === "project" || e.kind === "folder") && typeof e.id === "string" && e.id) root.push({ kind: e.kind, id: e.id });
    }
    const folders: Record<string, string[]> = {};
    if (value.folders && typeof value.folders === "object" && !Array.isArray(value.folders)) {
      for (const [id, list] of Object.entries(value.folders as Record<string, unknown>)) {
        if (Array.isArray(list)) folders[id] = list.filter((item): item is string => typeof item === "string" && !!item);
      }
    }
    return { root, folders };
  } catch { return null; }
}

export function serializeLayout(layout: ProjectLayout): string {
  return JSON.stringify({ version: 1, root: layout.root, folders: layout.folders });
}

/**
 * Reconcile a saved layout with reality: drop stale ids, drop duplicates (a project lives in at most one place),
 * append unseen folders and projects. `seedFolder` places never-seen projects in their legacy folder, if any.
 */
export function reconcileLayout(saved: ProjectLayout | null, projectIds: readonly string[], folderIds: readonly string[], seedFolder?: (projectId: string) => string | null | undefined): ProjectLayout {
  const projects = new Set(projectIds);
  const folderSet = new Set(folderIds);
  const seenProjects = new Set<string>();
  const seenFolders = new Set<string>();
  const root: LayoutEntry[] = [];
  const folders: Record<string, string[]> = Object.fromEntries(folderIds.map((id) => [id, [] as string[]]));
  for (const entry of saved?.root ?? []) {
    if (entry.kind === "folder" && folderSet.has(entry.id) && !seenFolders.has(entry.id)) { seenFolders.add(entry.id); root.push(entry); }
    else if (entry.kind === "project" && projects.has(entry.id) && !seenProjects.has(entry.id)) { seenProjects.add(entry.id); root.push(entry); }
  }
  for (const folderId of folderIds) {
    for (const id of saved?.folders[folderId] ?? []) {
      if (projects.has(id) && !seenProjects.has(id)) { seenProjects.add(id); folders[folderId].push(id); }
    }
  }
  for (const id of projectIds) {
    if (seenProjects.has(id)) continue;
    seenProjects.add(id);
    const seeded = seedFolder?.(id);
    if (seeded && folderSet.has(seeded)) folders[seeded].push(id);
    else root.push({ kind: "project", id });
  }
  for (const id of folderIds) if (!seenFolders.has(id)) { seenFolders.add(id); root.push({ kind: "folder", id }); }
  return { root, folders };
}

export function containerOf(layout: ProjectLayout, projectId: string): string | null | undefined {
  if (layout.root.some((entry) => same(entry, "project", projectId))) return null;
  for (const [folderId, list] of Object.entries(layout.folders)) if (list.includes(projectId)) return folderId;
  return undefined;
}

function withoutProject(layout: ProjectLayout, projectId: string): ProjectLayout {
  return {
    root: layout.root.filter((entry) => !same(entry, "project", projectId)),
    folders: Object.fromEntries(Object.entries(layout.folders).map(([id, list]) => [id, list.filter((item) => item !== projectId)])),
  };
}

function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const next = list.slice();
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}

/** Move a project to the start/end of a folder (or the root when `folderId` is null). */
export function moveProjectInto(layout: ProjectLayout, projectId: string, folderId: string | null, at: "start" | "end" = "end"): ProjectLayout {
  if (folderId !== null && !(folderId in layout.folders)) return layout;
  const base = withoutProject(layout, projectId);
  if (folderId === null) return { ...base, root: insertAt(base.root, at === "start" ? 0 : base.root.length, { kind: "project", id: projectId }) };
  const list = base.folders[folderId];
  return { ...base, folders: { ...base.folders, [folderId]: insertAt(list, at === "start" ? 0 : list.length, projectId) } };
}

/** Move a project next to an anchor project or folder (relative to the anchor's own container). */
export function moveProjectRelative(layout: ProjectLayout, projectId: string, anchor: LayoutEntry, edge: "before" | "after"): ProjectLayout {
  if (anchor.kind === "project" && anchor.id === projectId) return layout;
  const base = withoutProject(layout, projectId);
  if (anchor.kind === "folder") {
    const at = base.root.findIndex((entry) => same(entry, "folder", anchor.id));
    if (at < 0) return layout;
    return { ...base, root: insertAt(base.root, edge === "before" ? at : at + 1, { kind: "project", id: projectId }) };
  }
  const rootAt = base.root.findIndex((entry) => same(entry, "project", anchor.id));
  if (rootAt >= 0) return { ...base, root: insertAt(base.root, edge === "before" ? rootAt : rootAt + 1, { kind: "project", id: projectId }) };
  for (const [folderId, list] of Object.entries(base.folders)) {
    const at = list.indexOf(anchor.id);
    if (at >= 0) return { ...base, folders: { ...base.folders, [folderId]: insertAt(list, edge === "before" ? at : at + 1, projectId) } };
  }
  return layout;
}

/** Reorder a folder among the root entries, next to an anchor folder or root-level project. */
export function moveFolderRelative(layout: ProjectLayout, folderId: string, anchor: LayoutEntry, edge: "before" | "after"): ProjectLayout {
  if (anchor.kind === "folder" && anchor.id === folderId) return layout;
  const root = layout.root.filter((entry) => !same(entry, "folder", folderId));
  const at = root.findIndex((entry) => entry.kind === anchor.kind && entry.id === anchor.id);
  if (at < 0 || !layout.root.some((entry) => same(entry, "folder", folderId))) return layout;
  return { ...layout, root: insertAt(root, edge === "before" ? at : at + 1, { kind: "folder", id: folderId }) };
}

export function moveFolderToEnd(layout: ProjectLayout, folderId: string): ProjectLayout {
  if (!layout.root.some((entry) => same(entry, "folder", folderId))) return layout;
  return { ...layout, root: [...layout.root.filter((entry) => !same(entry, "folder", folderId)), { kind: "folder", id: folderId }] };
}

export function addFolder(layout: ProjectLayout, folderId: string): ProjectLayout {
  if (folderId in layout.folders) return layout;
  return { root: [...layout.root, { kind: "folder", id: folderId }], folders: { ...layout.folders, [folderId]: [] } };
}

/** Remove a folder; its projects take the folder's place in the root, in order. */
export function removeFolderFromLayout(layout: ProjectLayout, folderId: string): ProjectLayout {
  const at = layout.root.findIndex((entry) => same(entry, "folder", folderId));
  const members = (layout.folders[folderId] ?? []).map((id): LayoutEntry => ({ kind: "project", id }));
  const { [folderId]: _gone, ...folders } = layout.folders;
  const root = at < 0 ? [...layout.root, ...members] : [...layout.root.slice(0, at), ...members, ...layout.root.slice(at + 1)];
  return { root, folders };
}

export type DragKey = { kind: "project" | "folder"; id: string };
export type DropTarget =
  | { type: "project" | "folder"; id: string; edge: DropEdge }
  | { type: "empty-folder"; id: string }
  | { type: "root-end" };

/** Apply a drag of `active` onto `target`; returns the same layout object when the drop is a no-op or invalid. */
export function applyDrop(layout: ProjectLayout, active: DragKey, target: DropTarget): ProjectLayout {
  if (active.kind === "project") {
    if (target.type === "root-end") return moveProjectInto(layout, active.id, null, "end");
    if (target.type === "empty-folder") return moveProjectInto(layout, active.id, target.id, "end");
    if (target.type === "folder" && target.edge === "into") return moveProjectInto(layout, active.id, target.id, "start");
    if (target.edge === "into") return layout;
    return moveProjectRelative(layout, active.id, { kind: target.type, id: target.id }, target.edge);
  }
  if (target.type === "root-end") return moveFolderToEnd(layout, active.id);
  if (target.type === "empty-folder" || target.edge === "into") return layout;
  if (target.type === "project" && containerOf(layout, target.id) !== null) return layout; // folders only reorder at the root
  return moveFolderRelative(layout, active.id, { kind: target.type, id: target.id }, target.edge);
}

export function layoutsEqual(a: ProjectLayout, b: ProjectLayout): boolean {
  return serializeLayout(a) === serializeLayout(b);
}

/* ---------- storage ---------- */

const EVENT = "floq:project-layout";
export function layoutKey(scope: string): string { return `floq.projectLayout.v1.${encodeURIComponent(scope)}`; }
export function layoutEvent(): string { return EVENT; }

export function readLayoutRaw(scope: string): string | null {
  try { return localStorage.getItem(layoutKey(scope)); } catch { return null; }
}

export function saveLayout(scope: string, layout: ProjectLayout): void {
  try { localStorage.setItem(layoutKey(scope), serializeLayout(layout)); } catch { /* optional when storage is blocked */ }
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* non-browser */ }
}
