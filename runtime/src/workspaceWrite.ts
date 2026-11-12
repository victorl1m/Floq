import { constants as fsConstants } from "node:fs";
import { lchown, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./errors.js";
import { HAS_PROC_FD, HIDDEN_NAMES, openWithin, resolveInside } from "./workspaceFiles.js";

export const MAX_ENTRY_NAME_BYTES = 255;

/** One path segment for a new file or folder. Rejects separators, dot names, control characters, repository internals and over-long names. */
export function validateEntryName(input: unknown): string {
  if (typeof input !== "string") throw badRequest("Enter a name", "invalid_name");
  const name = input;
  if (name.trim() === "") throw badRequest("Enter a name", "invalid_name");
  if (name === "." || name === "..") throw badRequest("That name is not allowed", "invalid_name");
  if (name.includes("/") || name.includes("\\")) throw badRequest("A name cannot contain / or \\", "invalid_name");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw badRequest("That name has invalid characters", "invalid_name");
  if (Buffer.byteLength(name) > MAX_ENTRY_NAME_BYTES) throw badRequest("That name is too long", "invalid_name");
  if (HIDDEN_NAMES.has(name)) throw badRequest("That name is not allowed", "invalid_name");
  return name;
}

export interface CreatedEntry { path: string; type: "file" | "dir" }

/**
 * Create an empty file or a folder named `name` inside the workspace folder `parent` (workspace-relative).
 * The parent is opened by descriptor and proven inside `root`, then the entry is created through /proc/self/fd so a swapped
 * directory cannot redirect this (root-run) process. Creation is exclusive and never follows a symlink; `uid` (the sandbox
 * user) becomes the owner, like files an agent writes.
 */
export async function createWorkspaceEntry(root: string, parent: unknown, rawName: unknown, kind: unknown, uid?: number): Promise<CreatedEntry> {
  if (kind !== "file" && kind !== "dir") throw badRequest("Choose file or folder", "invalid_kind");
  const name = validateEntryName(rawName);
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) throw notFound("The project folder is unavailable");
  const { rel, real } = await resolveInside(root, parent);
  if (relative(realRoot, real).split(sep).some((part) => HIDDEN_NAMES.has(part))) throw forbidden("This folder is not available");
  const dir = await openWithin(realRoot, real, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY).catch((error) => {
    if (error instanceof HttpError && error.status === 400) throw error;
    throw notFound("That folder is no longer available");
  });
  try {
    if (!(await dir.stat()).isDirectory()) throw badRequest("The parent is not a folder", "invalid_file_path");
    const target = join(HAS_PROC_FD ? `/proc/self/fd/${dir.fd}` : real, name);
    try {
      if (kind === "dir") {
        await mkdir(target, { mode: 0o755 });
        if (uid !== undefined) await lchown(target, uid, uid).catch(async (error) => { await rmdir(target).catch(() => {}); throw error; });
      } else {
        const fh = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
        try {
          if (uid !== undefined) await fh.chown(uid, uid);
        } catch (error) {
          await fh.close().catch(() => {});
          await unlink(target).catch(() => {});
          throw error;
        }
        await fh.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") throw conflict("A file or folder with that name already exists", "already_exists");
      if (code === "ENAMETOOLONG") throw badRequest("That name is too long", "invalid_name");
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw forbidden("You cannot create items here");
      if (code === "ENOSPC" || code === "EDQUOT") throw new HttpError(507, "insufficient_storage", "Not enough storage space in your workspace");
      throw error;
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return { path: rel ? `${rel}/${name}` : name, type: kind };
}
