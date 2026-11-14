import { constants as fsConstants } from "node:fs";
import { lstatSync } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { badRequest, notFound } from "./errors.js";
import type { SessionManager } from "./manager.js";
import { mkdirOwnedSegment, type ShardHandle } from "./shard.js";
import type { ShardService } from "./shards.js";
import { cleanRelativePath, contentDisposition, HAS_PROC_FD, HIDDEN_NAMES, openWithin, parseRange, resolveInside } from "./workspaceFiles.js";

const LIST_LIMIT = 500;
const SCAN_LIMIT = 5_000;
const MAX_DEPTH = 4;
const READ_LIMIT_BYTES = 512 * 1024;
/** Download-link paths for this folder carry this prefix so a link cannot be replayed against the workspace endpoint. */
export const ARTIFACT_LINK_PREFIX = "@artifacts/";

export interface ArtifactEntry { name: string; path: string; size: number; modifiedAt: number }
export interface ArtifactListing { dir: string; entries: ArtifactEntry[]; truncated: boolean }

/** Home-relative folder for a project's shared deliverables, e.g. `Artifacts/<project id>`. */
export function artifactsRel(projectId: string | null | undefined): string {
  const id = typeof projectId === "string" && /^[\w-]{1,80}$/.test(projectId) ? projectId : "default";
  return `Artifacts/${id}`;
}

/** Create `<home>/Artifacts/<project>` owned by the shard uid, refusing symlinked or non-directory parents. Returns the host path. */
export function ensureArtifactsDir(handle: Pick<ShardHandle, "mountPath" | "uid">, projectId: string | null | undefined): string {
  let current = resolve(handle.mountPath);
  for (const part of artifactsRel(projectId).split("/")) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw badRequest("Artifacts storage is unsafe", "unsafe_artifacts_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirOwnedSegment(handle.mountPath, current, handle.uid, 0o755);
    }
  }
  return current;
}

/** System-prompt text telling agents where to save deliverables; overrides the provider's own artifact/scratch conventions. */
export function artifactsGuidance(dir: string, provider: "claude" | "codex" | string = "claude"): string {
  const override = provider === "codex"
    ? `This is where every deliverable goes by default; the user never has to ask for it. /tmp is only for throwaway intermediates (scripts, logs, partial outputs), never the only copy of something the user should see.`
    : `This replaces the claude.ai Artifact tool for deliverables: publishing to claude.ai is disabled in Floq, so write the HTML/Markdown/PDF/etc. file here instead. Your scratchpad directory is only for throwaway intermediates (scripts, logs, partial outputs), never the only copy of something the user should see.`;
  return [
    "## Artifacts folder",
    "",
    `Save files you produce for the user (reports, documents, spreadsheets, pages, images, exports, generated assets) in ${dir} (also in the FLOQ_ARTIFACTS_DIR environment variable) unless the user names another location. Use descriptive file names and tell the user the file name when done. The user sees this folder in the Artifacts tab of the right sidebar. Keep source code and project files in the project checkout.`,
    "",
    override,
  ].join("\n");
}

/** List, read and download the per-project Artifacts folder, authorized through any of the user's sessions. */
export class Artifacts {
  constructor(private readonly manager: SessionManager, private readonly shards: ShardService) {}

  private async root(userId: string, sessionId: string): Promise<{ root: string; dir: string }> {
    const session = await this.manager.get(sessionId, userId);
    const handle = await this.shards.wake(userId);
    const host = ensureArtifactsDir(handle as ShardHandle, session.projectId);
    // The agent can swap ~/Artifacts for a symlink after the lstat walk; the resolved root must be exactly <home>/Artifacts/<id>.
    const home = await realpath((handle as ShardHandle).mountPath).catch(() => null);
    const root = await realpath(host).catch(() => null);
    if (!home || !root || root !== join(home, artifactsRel(session.projectId))) throw notFound();
    if (!(await lstat(root).catch(() => null))?.isDirectory()) throw notFound();
    return { root, dir: this.shards.driver.homePath(handle) + "/" + artifactsRel(session.projectId) };
  }

  async list(userId: string, sessionId: string): Promise<ArtifactListing> {
    const { root, dir } = await this.root(userId, sessionId);
    const entries: ArtifactEntry[] = [];
    let scanned = 0;
    let truncated = false;
    const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
      const dirHandle = await openWithin(root, abs, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY).catch(() => null);
      if (!dirHandle) return;
      try {
        const base = HAS_PROC_FD ? `/proc/self/fd/${dirHandle.fd}` : abs;
        const handle = await opendir(base).catch(() => null);
        if (!handle) return;
        try {
          for await (const dirent of handle) {
            if (++scanned > SCAN_LIMIT) { truncated = true; return; }
            const name = dirent.name;
            if (HIDDEN_NAMES.has(name) || name.startsWith(".") || name.includes("\0")) continue;
            const childRel = rel ? `${rel}/${name}` : name;
            if (dirent.isDirectory()) { if (depth < MAX_DEPTH) await walk(join(abs, name), childRel, depth + 1); continue; }
            if (!dirent.isFile()) continue; // symlinks are never listed
            const file = await openWithin(root, join(base, name)).catch(() => null);
            const info = file ? await file.stat().catch(() => null) : null;
            await file?.close().catch(() => {});
            if (info?.isFile()) entries.push({ name, path: childRel, size: info.size, modifiedAt: Math.round(info.mtimeMs) });
          }
        } finally { await handle.close().catch(() => {}); }
      } finally { await dirHandle.close().catch(() => {}); }
    };
    await walk(root, "", 0);
    entries.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
    return { dir, entries: entries.slice(0, LIST_LIMIT), truncated: truncated || entries.length > LIST_LIMIT };
  }

  async read(userId: string, sessionId: string, requested: unknown) {
    const { root } = await this.root(userId, sessionId);
    const { rel, real } = await resolveInside(root, requested);
    if (!rel) throw badRequest("Choose a file to read", "invalid_file_path");
    const handle = await openWithin(root, real);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw notFound("That file is no longer available");
      if (info.size > READ_LIMIT_BYTES) return { path: rel, size: info.size, binary: false, tooLarge: true, content: "" };
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, bytesRead);
      const binary = data.subarray(0, 8000).includes(0);
      return { path: rel, size: info.size, binary, tooLarge: false, content: binary ? "" : data.toString("utf8") };
    } finally { await handle.close(); }
  }

  /** Owner-scoped check at link issue time; returns the claim path. */
  async authorizeDownload(userId: string, sessionId: string, requested: unknown): Promise<string> {
    await this.manager.get(sessionId, userId);
    const rel = cleanRelativePath(requested);
    if (!rel) throw badRequest("Choose a file to download", "invalid_file_path");
    return ARTIFACT_LINK_PREFIX + rel;
  }

  download(userId: string, sessionId: string, claimPath: string, res: ServerResponse, rangeHeader?: string): Promise<void> {
    if (!claimPath.startsWith(ARTIFACT_LINK_PREFIX)) throw notFound();
    return this.manager.withUserShardActivity(userId, () => this.serve(userId, sessionId, claimPath.slice(ARTIFACT_LINK_PREFIX.length), res, rangeHeader));
  }

  private async serve(userId: string, sessionId: string, requested: string, res: ServerResponse, rangeHeader?: string): Promise<void> {
    const { root } = await this.root(userId, sessionId);
    const { rel, real } = await resolveInside(root, requested);
    const common = { "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
    const handle = await openWithin(root, real);
    let closed = false;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw notFound("That file is no longer available");
      const range = parseRange(rangeHeader, info.size);
      if (range === "invalid") { res.writeHead(416, { ...common, "Content-Range": `bytes */${info.size}` }).end(); return; }
      const length = range ? range.end - range.start + 1 : info.size;
      res.writeHead(range ? 206 : 200, { ...common, "Accept-Ranges": "bytes", "Content-Length": length, "Content-Disposition": contentDisposition(basename(rel) || "download"), ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } : {}) });
      if (length === 0) { res.end(); return; }
      closed = true;
      await pipeline(handle.createReadStream({ start: range?.start ?? 0, end: range?.end ?? info.size - 1 }), res).catch(() => {});
    } finally { if (!closed) await handle.close().catch(() => {}); }
  }
}

