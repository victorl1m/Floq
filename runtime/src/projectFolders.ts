import type pg from "pg";
import { badRequest, conflict } from "./errors.js";

/**
 * Sidebar project folders, stored per USER (not per device) so they survive clearing site data or reinstalling the app.
 *
 * One versioned JSON document per user. Writers send the version they last saw; a stale version is rejected with
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
  return { folders, root, membership, expanded };
}

function rowToState(row: { version: number; doc: unknown; updated_at: Date | string } | undefined): FolderState {
  if (!row) return { version: 0, doc: null, updatedAt: null };
  return { version: Number(row.version), doc: row.doc as FolderDoc, updatedAt: new Date(row.updated_at).toISOString() };
}

/** Remove a deleted project from a stored document. `db` may be a pool or a transaction client. */
export async function pruneProjectFromFolders(db: Pick<pg.Pool, "query">, userId: string, projectId: string): Promise<void> {
  const current = (await db.query("SELECT version, doc FROM user_project_folders WHERE user_id=$1 FOR UPDATE", [userId])).rows[0] as { version: number; doc: FolderDoc } | undefined;
  if (!current) return;
  const doc = current.doc;
  const root = doc.root.filter((entry) => !(entry.kind === "project" && entry.id === projectId));
  const membership = Object.fromEntries(Object.entries(doc.membership ?? {}).map(([folderId, list]) => [folderId, list.filter((item) => item !== projectId)]));
  const changed = root.length !== doc.root.length || Object.entries(doc.membership ?? {}).some(([folderId, list]) => list.length !== membership[folderId].length);
  if (!changed) return;
  await db.query("UPDATE user_project_folders SET version=version+1, doc=$2::jsonb, updated_at=now() WHERE user_id=$1", [userId, JSON.stringify({ ...doc, root, membership })]);
}

export class ProjectFolders {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async get(userId: string): Promise<FolderState> {
    const result = await this.pool.query("SELECT version, doc, updated_at FROM user_project_folders WHERE user_id=$1", [userId]);
    return rowToState(result.rows[0] as never);
  }

  /**
   * Replace the document. `baseVersion` is the version the caller last read (0 = "the server has nothing yet").
   * A different current version is a 409 `version_conflict`; the client then fetches, merges and retries.
   */
  async put(userId: string, body: unknown): Promise<FolderState> {
    if (!isRecord(body)) throw badRequest("Request body must be an object", "invalid_project_folders");
    const baseVersion = body.version;
    if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) throw badRequest("version must be a non-negative integer", "invalid_project_folders");
    const doc = validateFolderDoc(body.doc);
    const json = JSON.stringify(doc);
    if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw badRequest("Folder layout is too large", "invalid_project_folders");

    if (baseVersion === 0) {
      const inserted = await this.pool.query(
        "INSERT INTO user_project_folders(user_id, version, doc) VALUES($1, 1, $2::jsonb) ON CONFLICT (user_id) DO NOTHING RETURNING version, doc, updated_at",
        [userId, json],
      );
      if (!inserted.rows[0]) throw conflict("Your folders changed on another device.", "version_conflict");
      return rowToState(inserted.rows[0] as never);
    }
    const updated = await this.pool.query(
      "UPDATE user_project_folders SET version=version+1, doc=$3::jsonb, updated_at=now() WHERE user_id=$1 AND version=$2 RETURNING version, doc, updated_at",
      [userId, baseVersion, json],
    );
    if (!updated.rows[0]) throw conflict("Your folders changed on another device.", "version_conflict");
    return rowToState(updated.rows[0] as never);
  }
}
