import type pg from "pg";
import { badRequest, conflict } from "./errors.js";

/**
 * Sidebar project folders, stored per USER (not per device) so they survive clearing site data or reinstalling the app.
 *
 * One versioned JSON document per user and organization. Writers send the version they last saw; a stale version is rejected with
 * 409 `version_conflict` and the client re-reads, merges and retries (see src/lib/project-folders-sync.ts).
 */

export const MAX_FOLDERS = 200;
export const MAX_FOLDER_NAME = 80;
/** Entries in `root` (folders + ungrouped projects) and in each folder. Generous: a user rarely has more than a few dozen projects. */
export const MAX_ROOT_ENTRIES = 2_000;
export const MAX_FOLDER_MEMBERS = 2_000;
export const MAX_DOC_BYTES = 256 * 1024;

const ID = /^[A-Za-z0-9._:-]{1,64}$/;

export interface FolderDoc {
  folders: Array<{ id: string; name: string }>;
  root: Array<{ kind: "project" | "folder"; id: string }>;
  /** folder id -> project ids, in order. */
  membership: Record<string, string[]>;
  /** folder id -> expanded (default true when absent). */
  expanded: Record<string, boolean>;
  /** Ordered children for nested layouts; omitted by legacy clients. */
  children?: Record<string, Array<{ kind: "project" | "folder"; id: string }>>;
}

export interface FolderState { version: number; doc: FolderDoc | null; updatedAt: string | null }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw badRequest(`${what} must be 1-64 characters of letters, digits and . _ : -`, "invalid_project_folders");
  return value;
}

/** Strict validation: unknown keys are dropped, anything malformed or over a cap is rejected. */
export function validateFolderDoc(value: unknown): FolderDoc {
  if (!isRecord(value)) throw badRequest("doc must be an object", "invalid_project_folders");
  if (!Array.isArray(value.folders) || value.folders.length > MAX_FOLDERS) throw badRequest(`At most ${MAX_FOLDERS} folders are allowed`, "invalid_project_folders");
  const folderIds = new Set<string>();
  const folders = value.folders.map((raw) => {
    if (!isRecord(raw)) throw badRequest("Invalid folder", "invalid_project_folders");
    const folderId = id(raw.id, "Folder id");
    if (folderIds.has(folderId)) throw badRequest("Duplicate folder id", "invalid_project_folders");
    folderIds.add(folderId);
    if (typeof raw.name !== "string") throw badRequest("Folder name must be text", "invalid_project_folders");
    const name = raw.name.trim();
    if (!name || name.length > MAX_FOLDER_NAME) throw badRequest(`Folder names must be 1-${MAX_FOLDER_NAME} characters`, "invalid_project_folders");
    return { id: folderId, name };
  });

  if (!Array.isArray(value.root) || value.root.length > MAX_ROOT_ENTRIES) throw badRequest("root is too long", "invalid_project_folders");
  const root = value.root.map((raw): FolderDoc["root"][number] => {
    if (!isRecord(raw) || (raw.kind !== "project" && raw.kind !== "folder")) throw badRequest("Invalid root entry", "invalid_project_folders");
    const entryId = id(raw.id, "Entry id");
    if (raw.kind === "folder" && !folderIds.has(entryId)) throw badRequest("root references an unknown folder", "invalid_project_folders");
    return { kind: raw.kind, id: entryId };
  });

  const membership: Record<string, string[]> = {};
  if (value.membership !== undefined) {
    if (!isRecord(value.membership)) throw badRequest("membership must be an object", "invalid_project_folders");
    for (const [folderId, list] of Object.entries(value.membership)) {
      if (!folderIds.has(folderId)) throw badRequest("membership references an unknown folder", "invalid_project_folders");
      if (!Array.isArray(list) || list.length > MAX_FOLDER_MEMBERS) throw badRequest("A folder has too many projects", "invalid_project_folders");
      membership[folderId] = list.map((projectId) => id(projectId, "Project id"));
    }
  }

  const expanded: Record<string, boolean> = {};
  if (value.expanded !== undefined) {
    if (!isRecord(value.expanded)) throw badRequest("expanded must be an object", "invalid_project_folders");
    for (const [folderId, open] of Object.entries(value.expanded)) {
      if (!folderIds.has(folderId) || typeof open !== "boolean") throw badRequest("Invalid expanded state", "invalid_project_folders");
      expanded[folderId] = open;
    }
  }
  if (value.children === undefined) return { folders, root, membership, expanded };
  if (!isRecord(value.children)) throw badRequest("children must be an object", "invalid_project_folders");
  const children: NonNullable<FolderDoc["children"]> = {};
  for (const [parent, raw] of Object.entries(value.children)) {
    if (!folderIds.has(parent) || !Array.isArray(raw) || raw.length > MAX_FOLDER_MEMBERS) throw badRequest("Invalid folder children", "invalid_project_folders");
    children[parent] = raw.map((entry) => {
      if (!isRecord(entry) || (entry.kind !== "folder" && entry.kind !== "project")) throw badRequest("Invalid folder child", "invalid_project_folders");
      const childId = id(entry.id, "Entry id");
      if (entry.kind === "folder" && !folderIds.has(childId)) throw badRequest("Unknown child folder", "invalid_project_folders");
      return { kind: entry.kind, id: childId };
    });
  }
  const visitedFolders = new Set<string>();
  const visitedProjects = new Set<string>();
  const visit = (entries: FolderDoc["root"], depth: number): void => {
    for (const entry of entries) {
      if (entry.kind === "project") {
        if (visitedProjects.has(entry.id)) throw badRequest("Duplicate project", "invalid_project_folders");
        visitedProjects.add(entry.id);
      } else {
        if (depth > 8 || visitedFolders.has(entry.id)) throw badRequest("Invalid folder hierarchy", "invalid_project_folders");
        visitedFolders.add(entry.id);
        visit(children[entry.id] ?? [], depth + 1);
      }
    }
  };
  visit(root, 1);
  if (visitedFolders.size !== folders.length) throw badRequest("Unreachable folder", "invalid_project_folders");
  for (const folder of folders) {
    const projects = (children[folder.id] ?? []).filter((entry) => entry.kind === "project").map((entry) => entry.id);
    if (JSON.stringify(projects) !== JSON.stringify(membership[folder.id] ?? [])) throw badRequest("Inconsistent folder membership", "invalid_project_folders");
  }
  return { folders, root, membership, expanded, children };
}

function rowToState(row: { version: number; doc: unknown; updated_at: Date | string } | undefined): FolderState {
  if (!row) return { version: 0, doc: null, updatedAt: null };
  return { version: Number(row.version), doc: row.doc as FolderDoc, updatedAt: new Date(row.updated_at).toISOString() };
}

/** Pure: the document without any of `ids`, or null when nothing changed. */
function withoutProjects(doc: FolderDoc, ids: ReadonlySet<string>): FolderDoc | null {
  const root = doc.root.filter((entry) => !(entry.kind === "project" && ids.has(entry.id)));
  const membership = Object.fromEntries(Object.entries(doc.membership ?? {}).map(([folderId, list]) => [folderId, list.filter((item) => !ids.has(item))]));
  const children = doc.children && Object.fromEntries(Object.entries(doc.children).map(([folderId, list]) => [folderId, list.filter((entry) => entry.kind !== "project" || !ids.has(entry.id))]));
  const changed = root.length !== doc.root.length || Object.entries(doc.membership ?? {}).some(([folderId, list]) => list.length !== membership[folderId].length) || Object.entries(doc.children ?? {}).some(([folderId, list]) => list.length !== children![folderId].length);
  return changed ? { ...doc, root, membership, ...(children ? { children } : {}) } : null;
}

/** Remove a deleted project from every stored document of the user (one per organization). `db` may be a pool or a transaction client. */
export async function pruneProjectFromFolders(db: Pick<pg.Pool, "query">, userId: string, projectId: string): Promise<void> {
  const rows = (await db.query("SELECT organization_id, version, doc FROM user_project_folders WHERE user_id=$1 FOR UPDATE", [userId])).rows as Array<{ organization_id: string; version: number; doc: FolderDoc }>;
  for (const current of rows) {
    const next = withoutProjects(current.doc, new Set([projectId]));
    if (!next) continue;
    await db.query("UPDATE user_project_folders SET version=version+1, doc=$2::jsonb, updated_at=now() WHERE user_id=$1 AND organization_id IS NOT DISTINCT FROM $3::uuid", [userId, JSON.stringify(next), current.organization_id]);
  }
}

/**
 * Move projects between the user's organizations in the folder layout: they leave the source document (folders
 * included) and are appended to the root of the target document. A target without a stored layout needs nothing
 * (unlisted projects already show at the root). `db` may be a pool or a transaction client.
 */
export async function moveProjectsInFolders(db: Pick<pg.Pool, "query">, userId: string, projectIds: string[], fromOrgId: string, toOrgId: string): Promise<void> {
  if (!projectIds.length || fromOrgId === toOrgId) return;
  const ids = new Set(projectIds);
  const source = (await db.query("SELECT version, doc FROM user_project_folders WHERE user_id=$1 AND organization_id=$2 FOR UPDATE", [userId, fromOrgId])).rows[0] as { doc: FolderDoc } | undefined;
  const pruned = source && withoutProjects(source.doc, ids);
  if (pruned) await db.query("UPDATE user_project_folders SET version=version+1, doc=$2::jsonb, updated_at=now() WHERE user_id=$1 AND organization_id=$3", [userId, JSON.stringify(pruned), fromOrgId]);
  const target = (await db.query("SELECT version, doc FROM user_project_folders WHERE user_id=$1 AND organization_id=$2 FOR UPDATE", [userId, toOrgId])).rows[0] as { doc: FolderDoc } | undefined;
  if (!target) return;
  const present = new Set([...target.doc.root.filter((entry) => entry.kind === "project").map((entry) => entry.id), ...Object.values(target.doc.membership ?? {}).flat(), ...Object.values(target.doc.children ?? {}).flat().filter((entry) => entry.kind === "project").map((entry) => entry.id)]);
  const add = projectIds.filter((id) => !present.has(id));
  if (!add.length) return;
  const doc = { ...target.doc, root: [...target.doc.root, ...add.map((id) => ({ kind: "project" as const, id }))] };
  await db.query("UPDATE user_project_folders SET version=version+1, doc=$2::jsonb, updated_at=now() WHERE user_id=$1 AND organization_id=$3", [userId, JSON.stringify(doc), toOrgId]);
}

export class ProjectFolders {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async get(userId: string, orgId: string): Promise<FolderState> {
    const result = await this.pool.query("SELECT version, doc, updated_at FROM user_project_folders WHERE user_id=$1 AND organization_id=$2", [userId, orgId]);
    return rowToState(result.rows[0] as never);
  }

  /**
   * Replace the document. `baseVersion` is the version the caller last read (0 = "the server has nothing yet").
   * A different current version is a 409 `version_conflict`; the client then fetches, merges and retries.
   */
  async put(userId: string, orgId: string, body: unknown): Promise<FolderState> {
    if (!isRecord(body)) throw badRequest("Request body must be an object", "invalid_project_folders");
    const baseVersion = body.version;
    if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) throw badRequest("version must be a non-negative integer", "invalid_project_folders");
    const doc = validateFolderDoc(body.doc);
    const json = JSON.stringify(doc);
    if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw badRequest("Folder layout is too large", "invalid_project_folders");

    if (baseVersion === 0) {
      const inserted = await this.pool.query(
        "INSERT INTO user_project_folders(user_id, organization_id, version, doc) VALUES($1, $3, 1, $2::jsonb) ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING version, doc, updated_at",
        [userId, json, orgId],
      );
      if (!inserted.rows[0]) throw conflict("Your folders changed on another device.", "version_conflict");
      return rowToState(inserted.rows[0] as never);
    }
    const updated = await this.pool.query(
      "UPDATE user_project_folders SET version=version+1, doc=$3::jsonb, updated_at=now() WHERE user_id=$1 AND version=$2 AND organization_id=$4 RETURNING version, doc, updated_at",
      [userId, baseVersion, json, orgId],
    );
    if (!updated.rows[0]) throw conflict("Your folders changed on another device.", "version_conflict");
    return rowToState(updated.rows[0] as never);
  }
}
