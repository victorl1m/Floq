/**
 * Sidebar project layout: the order of root entries (projects + folders) and of the projects inside each folder.
 *
 * Folder names live in prefs.ts (`floq.projectFolders.<scope>`); this module owns membership and order and persists
 * it per runtime + account in localStorage (`floq.projectLayout.v1.<scope>`), like every other sidebar preference.
 * Everything here is pure and dependency free except for the small storage/subscription helpers at the bottom.
 */

export interface LayoutEntry { kind: "project" | "folder"; id: string }
export interface ProjectLayout { root: LayoutEntry[]; folders: Record<string, string[]>; children?: Record<string, LayoutEntry[]> }
export type DropEdge = "before" | "after" | "into";

export const EMPTY_LAYOUT: ProjectLayout = { root: [], folders: {} };

const same = (a: LayoutEntry, kind: LayoutEntry["kind"], id: string) => a.kind === kind && a.id === id;

/** Validate untrusted JSON into a layout; anything malformed degrades to "no saved layout". */
export function parseLayout(raw: string | null): ProjectLayout | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; root?: unknown; folders?: unknown; children?: unknown };
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
    const children: Record<string, LayoutEntry[]> = {};
    if (value.children && typeof value.children === "object" && !Array.isArray(value.children)) {
      for (const [parent, entries] of Object.entries(value.children as Record<string, unknown>)) {
        if (Array.isArray(entries)) children[parent] = entries.filter((entry): entry is LayoutEntry => !!entry && typeof entry === "object" && ((entry as LayoutEntry).kind === "project" || (entry as LayoutEntry).kind === "folder") && typeof (entry as LayoutEntry).id === "string");
      }
    }
    return { root, folders, children };
  } catch { return null; }
}

export function serializeLayout(layout: ProjectLayout): string {
  return JSON.stringify({ version: 1, root: layout.root, folders: layout.folders, children: layout.children ?? {} });
}

export function entriesIn(layout: ProjectLayout, folderId: string | null): LayoutEntry[] {
  if (folderId === null) return layout.root;
  if (layout.children?.[folderId]) return layout.children[folderId];
  return (layout.folders[folderId] ?? []).map((id) => ({ kind: "project", id }));
}

const MAX_DEPTH = 8;
function parentOf(layout: ProjectLayout, kind: LayoutEntry["kind"], id: string): string | null | undefined {
  const find = (parent: string | null, entries: LayoutEntry[]): string | null | undefined => {
    for (const entry of entries) {
      if (entry.kind === kind && entry.id === id) return parent;
      if (entry.kind === "folder") { const result = find(entry.id, entriesIn(layout, entry.id)); if (result !== undefined) return result; }
    }
    return undefined;
  };
  return find(null, layout.root);
}
function withoutEntry(layout: ProjectLayout, kind: LayoutEntry["kind"], id: string): ProjectLayout {
  const root = layout.root.filter((entry) => !same(entry, kind, id));
  const children = Object.fromEntries(Object.entries(layout.children ?? {}).map(([parent, entries]) => [parent, entries.filter((entry) => !same(entry, kind, id))]));
  const folders = Object.fromEntries(Object.entries(layout.folders).map(([parent, projects]) => [parent, projects.filter((project) => !(kind === "project" && project === id))]));
  return { root, folders, children };
}
function insertEntry(layout: ProjectLayout, parent: string | null, entry: LayoutEntry, at: "start" | "end" = "end"): ProjectLayout {
  if (parent === null) return { ...layout, root: insertAt(layout.root, at === "start" ? 0 : layout.root.length, entry) };
  const children = { ...(layout.children ?? {}) };
  const list = entriesIn(layout, parent);
  children[parent] = insertAt(list, at === "start" ? 0 : list.length, entry);
  const folders = { ...layout.folders };
  folders[parent] = children[parent].filter((item) => item.kind === "project").map((item) => item.id);
  return { ...layout, children, folders };
}
function folderDepth(layout: ProjectLayout, id: string): number {
  let depth = 1, parent = parentOf(layout, "folder", id);
  while (parent) { depth++; parent = parentOf(layout, "folder", parent); }
  return depth;
}
function subtreeHeight(layout: ProjectLayout, id: string): number {
  const nested = entriesIn(layout, id).filter((entry) => entry.kind === "folder");
  return nested.length ? 1 + Math.max(...nested.map((entry) => subtreeHeight(layout, entry.id))) : 1;
}
function descendantOf(layout: ProjectLayout, candidate: string, ancestor: string): boolean {
  return entriesIn(layout, ancestor).some((entry) => entry.kind === "folder" && (entry.id === candidate || descendantOf(layout, candidate, entry.id)));
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
  const children: Record<string, LayoutEntry[]> = Object.fromEntries(folderIds.map((id) => [id, [] as LayoutEntry[]]));
  const visit = (parent: string | null, entries: readonly LayoutEntry[]) => {
    const out = parent === null ? root : children[parent];
    for (const entry of entries) {
      if (entry.kind === "folder") {
        if (!folderSet.has(entry.id) || seenFolders.has(entry.id)) continue;
        seenFolders.add(entry.id); out.push(entry);
        visit(entry.id, entriesIn(saved!, entry.id));
      } else if (projects.has(entry.id) && !seenProjects.has(entry.id)) {
        seenProjects.add(entry.id); out.push(entry);
      }
    }
  };
  if (saved) {
    // Preserve root order while reserving root projects ahead of stale legacy membership.
    const rootProjects = new Set(saved.root.filter((entry) => entry.kind === "project").map((entry) => entry.id));
    for (const entry of saved.root) {
      if (entry.kind === "project" && projects.has(entry.id) && !seenProjects.has(entry.id)) { seenProjects.add(entry.id); root.push(entry); }
      if (entry.kind === "folder" && folderSet.has(entry.id) && !seenFolders.has(entry.id)) { seenFolders.add(entry.id); root.push(entry); }
    }
    for (const entry of root.filter((entry) => entry.kind === "folder")) visit(entry.id, entriesIn(saved, entry.id).filter((child) => child.kind === "folder" || !rootProjects.has(child.id)));
  }
  // Legacy membership entries seed folders that do not yet have an ordered children list.
  for (const folderId of folderIds) for (const id of saved?.folders[folderId] ?? []) {
    if (projects.has(id) && !seenProjects.has(id)) { seenProjects.add(id); children[folderId].push({ kind: "project", id }); }
  }
  for (const id of projectIds) {
    if (seenProjects.has(id)) continue;
    seenProjects.add(id);
    const seeded = seedFolder?.(id);
    if (seeded && folderSet.has(seeded)) children[seeded].push({ kind: "project", id });
    else root.push({ kind: "project", id });
  }
  for (const id of folderIds) if (!seenFolders.has(id)) { seenFolders.add(id); root.push({ kind: "folder", id }); }
  const folders = Object.fromEntries(folderIds.map((id) => [id, children[id].filter((entry) => entry.kind === "project").map((entry) => entry.id)]));
  return { root, folders, children };
}

export function containerOf(layout: ProjectLayout, projectId: string): string | null | undefined {
  return parentOf(layout, "project", projectId);
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
  const base = withoutEntry(layout, "project", projectId);
  return insertEntry(base, folderId, { kind: "project", id: projectId }, at);
}

export function moveFolderInto(layout: ProjectLayout, folderId: string, parentId: string | null, at: "start" | "end" = "end"): ProjectLayout {
  if (folderId === parentId || (parentId !== null && (!(parentId in layout.folders) || descendantOf(layout, parentId, folderId)))) return layout;
  const destinationDepth = parentId === null ? 0 : folderDepth(layout, parentId);
  if (destinationDepth + subtreeHeight(layout, folderId) > MAX_DEPTH) return layout;
  const base = withoutEntry(layout, "folder", folderId);
  return insertEntry(base, parentId, { kind: "folder", id: folderId }, at);
}

/** Move a project next to an anchor project or folder (relative to the anchor's own container). */
export function moveProjectRelative(layout: ProjectLayout, projectId: string, anchor: LayoutEntry, edge: "before" | "after"): ProjectLayout {
  if (anchor.kind === "project" && anchor.id === projectId) return layout;
  const base = withoutProject(layout, projectId);
  const parent = parentOf(base, anchor.kind, anchor.id);
  if (parent === undefined) return layout;
  const list = entriesIn(base, parent);
  const index = list.findIndex((entry) => same(entry, anchor.kind, anchor.id));
  if (index < 0) return layout;
  const children = { ...(base.children ?? {}) };
  const updated: LayoutEntry[] = insertAt(list, edge === "before" ? index : index + 1, { kind: "project", id: projectId });
  if (parent === null) return { ...base, root: updated };
  children[parent] = updated;
  return { ...base, children, folders: { ...base.folders, [parent]: updated.filter((entry) => entry.kind === "project").map((entry) => entry.id) } };
}

/** Reorder a folder among the root entries, next to an anchor folder or root-level project. */
export function moveFolderRelative(layout: ProjectLayout, folderId: string, anchor: LayoutEntry, edge: "before" | "after"): ProjectLayout {
  if (anchor.kind === "folder" && anchor.id === folderId) return layout;
  const parent = parentOf(layout, anchor.kind, anchor.id);
  if (parent === undefined) return layout;
  const base = withoutEntry(layout, "folder", folderId);
  const list = entriesIn(base, parent);
  const at = list.findIndex((entry) => same(entry, anchor.kind, anchor.id));
  if (at < 0) return layout;
  const children = { ...(base.children ?? {}) };
  const updated: LayoutEntry[] = insertAt(list, edge === "before" ? at : at + 1, { kind: "folder", id: folderId });
  if (parent === null) return { ...base, root: updated };
  children[parent] = updated;
  return { ...base, children };
}

export function moveFolderToEnd(layout: ProjectLayout, folderId: string): ProjectLayout {
  const parent = parentOf(layout, "folder", folderId);
  if (parent === undefined) return layout;
  return moveFolderInto(layout, folderId, parent, "end");
}

export function addFolder(layout: ProjectLayout, folderId: string): ProjectLayout {
  if (folderId in layout.folders) return layout;
  return { root: [...layout.root, { kind: "folder", id: folderId }], folders: { ...layout.folders, [folderId]: [] } };
}

/** Remove a folder; its projects take the folder's place in the root, in order. */
export function removeFolderFromLayout(layout: ProjectLayout, folderId: string): ProjectLayout {
  const parent = parentOf(layout, "folder", folderId);
  if (parent === undefined) return layout;
  const siblings = entriesIn(layout, parent);
  const at = siblings.findIndex((entry) => same(entry, "folder", folderId));
  const promoted = entriesIn(layout, folderId);
  const parentEntries = [...siblings.slice(0, at), ...promoted, ...siblings.slice(at + 1)];
  const { [folderId]: _goneChildren, ...oldChildren } = layout.children ?? {};
  const { [folderId]: _goneFolders, ...folders } = layout.folders;
  const children = { ...oldChildren };
  if (parent === null) return { root: parentEntries, folders, children };
  children[parent] = parentEntries;
  folders[parent] = parentEntries.filter((entry) => entry.kind === "project").map((entry) => entry.id);
  return { ...layout, folders, children };
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
  if (target.type === "empty-folder") return moveFolderInto(layout, active.id, target.id);
  if (target.type === "folder" && target.edge === "into") return moveFolderInto(layout, active.id, target.id, "start");
  if (target.edge === "into") return layout;
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
