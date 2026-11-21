import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openHomeDir, removeHomeTree } from "../shard.js";
import type { FsCandidate } from "./plan.js";

/** Bounds for one candidate's inspection; hitting either keeps the candidate (never deletes on a partial view). */
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 10;
const LOCK_NAME = /(^|\.)(lock|pid)$|^\.?lock$|^lockfile$/i;

export interface WalkResult { newestMs: number | null; hasLock: boolean; bytes: number; sameDevice: boolean; isSymlink: boolean; isDirectory: boolean }

const yieldLoop = () => new Promise<void>((done) => setImmediate(done));

/**
 * Inspect one entry without following any link: newest of mtime and ctime anywhere inside (tmpfiles.d ages an entry by its most recent
 * timestamp; ctime catches renames and chmods), whether a lock or pid file lives in it, its size, and whether the whole tree stays on
 * `device`. A nested symlink is counted as a leaf and never entered.
 */
export async function inspectEntry(path: string, device: number, deadline: number): Promise<WalkResult> {
  let top;
  try { top = await lstat(path); } catch { return { newestMs: null, hasLock: false, bytes: 0, sameDevice: true, isSymlink: false, isDirectory: false }; }
  const result: WalkResult = { newestMs: Math.max(top.mtimeMs, top.ctimeMs), hasLock: false, bytes: 0, sameDevice: top.dev === device, isSymlink: top.isSymbolicLink(), isDirectory: top.isDirectory() };
  if (result.isSymlink || !result.sameDevice || !result.isDirectory) { result.bytes = result.isDirectory ? 0 : top.size; if (!result.isDirectory && !result.isSymlink && LOCK_NAME.test(path.split("/").pop() ?? "")) result.hasLock = true; return result; }
  let left = MAX_ENTRIES;
  const visit = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > MAX_DEPTH || Date.now() > deadline) return false;
    let names: string[];
    try { names = await readdir(dir); } catch { return false; }
    for (const name of names) {
      if (--left < 0) return false;
      if (left % 200 === 0) await yieldLoop();
      const child = join(dir, name);
      let st;
      try { st = await lstat(child); } catch { return false; }
      if (st.dev !== device) { result.sameDevice = false; return false; }
      result.newestMs = Math.max(result.newestMs ?? 0, st.mtimeMs, st.ctimeMs);
      if (LOCK_NAME.test(name)) result.hasLock = true;
      if (st.isDirectory()) { if (!(await visit(child, depth + 1))) return false; }
      else result.bytes += st.size;
    }
    return true;
  };
  if (!(await visit(path, 0))) result.newestMs = null;
  return result;
}

export interface ScanContext {
  home: string;
  /** session id -> state, for scratchpads. */
  sessions: Map<string, { live: boolean; lastActiveMs: number }>;
  deadline: number;
  attachmentsEnabled: boolean;
  tmpEnabled: boolean;
  scratchpadsEnabled: boolean;
  buildEnabled?: boolean;
}

const CACHEDIR_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";
/** Newest mtime of a folder and its entries two levels down (cargo touches target/<profile>/.fingerprint on every build). */
async function shallowNewest(path: string): Promise<number> {
  let newest = 0;
  const walk = async (dir: string, depth: number) => {
    let names: string[] = [];
    try { const st = await lstat(dir); newest = Math.max(newest, st.mtimeMs); if (!st.isDirectory() || depth >= 2) return; names = await readdir(dir); } catch { return; }
    for (const n of names.slice(0, 500)) await walk(join(dir, n), depth + 1);
  };
  await walk(path, 0);
  return newest;
}

async function children(home: string, rel: string): Promise<{ names: string[]; device: number; dir: string } | null> {
  let held;
  try { held = openHomeDir(home, join(home, rel)); } catch { return null; }
  if (!held) return null;
  try {
    // stat, not lstat: held.path is a /proc/self/fd link to the pinned directory, and its device is the directory's own.
    const st = await stat(held.path);
    return { names: (await readdir(held.path)).sort(), device: st.dev, dir: join(home, rel) };
  } catch { return null; } finally { held.close(); }
}

async function candidate(category: FsCandidate["category"], home: string, rel: string, device: number, deadline: number, session?: FsCandidate["session"]): Promise<FsCandidate> {
  const w = await inspectEntry(join(home, rel), device, deadline);
  let topMs: number | undefined;
  try { topMs = (await lstat(join(home, rel))).mtimeMs; } catch { /* gone */ }
  return { category, path: rel, isSymlink: w.isSymlink, isDirectory: w.isDirectory, sameDevice: w.sameDevice, newestMs: w.newestMs, hasLock: w.hasLock, bytes: w.bytes, session, topMs };
}

/** Everything under the persistent /tmp, attachments and agent scratchpads that could be cleaned, as plain facts. */
export async function scanFs(ctx: ScanContext): Promise<FsCandidate[]> {
  const out: FsCandidate[] = [];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ctx.attachmentsEnabled) {
    const root = await children(ctx.home, ".floq/attachments");
    for (const name of root?.names ?? []) {
      if (Date.now() > ctx.deadline) break;
      if (UUID.test(name)) out.push(await candidate("attachment", ctx.home, `.floq/attachments/${name}`, root!.device, ctx.deadline));
    }
  }
  const tmp = await children(ctx.home, ".floq/tmp");
  if (tmp) {
    for (const name of tmp.names) {
      if (Date.now() > ctx.deadline) break;
      if (/^claude-\d+$/.test(name)) {
        if (!ctx.scratchpadsEnabled) continue;
        const projects = await children(ctx.home, `.floq/tmp/${name}`);
        for (const project of projects?.names ?? []) {
          const sessions = await children(ctx.home, `.floq/tmp/${name}/${project}`);
          for (const id of sessions?.names ?? []) {
            if (Date.now() > ctx.deadline) break;
            if (!UUID.test(id)) continue;
            const known = ctx.sessions.get(id.toLowerCase());
            const session: FsCandidate["session"] = known ? { state: known.live ? "live" : "ended", lastActiveMs: known.lastActiveMs } : { state: "missing", lastActiveMs: null };
            out.push(await candidate("scratchpad", ctx.home, `.floq/tmp/${name}/${project}/${id}`, tmp.device, ctx.deadline, session));
          }
        }
      } else if (ctx.tmpEnabled && !name.startsWith(".")) {
        out.push(await candidate("tmp", ctx.home, `.floq/tmp/${name}`, tmp.device, ctx.deadline));
      }
    }
  }
  if (ctx.buildEnabled) {
    // Build folders marked with a CACHEDIR.TAG (Rust target/, and other tools that follow the convention), up to 3 levels into each
    // project checkout and workspace. Only the folder holding the tag is a candidate.
    for (const base of [".floq/projects", "workspace"]) {
      const roots = await children(ctx.home, base);
      for (const project of roots?.names ?? []) {
        const queue: { rel: string; depth: number }[] = [{ rel: `${base}/${project}`, depth: 0 }];
        while (queue.length && Date.now() <= ctx.deadline) {
          const { rel, depth } = queue.shift()!;
          const dir = await children(ctx.home, rel);
          if (!dir) continue;
          if (depth > 0 && dir.names.includes("CACHEDIR.TAG")) {
            let tagged = false;
            try { tagged = (await readFile(join(ctx.home, rel, "CACHEDIR.TAG"), "utf8")).startsWith(CACHEDIR_SIGNATURE); } catch { /* unreadable */ }
            if (tagged) {
              const c = await candidate("build", ctx.home, rel, roots!.device, Math.min(ctx.deadline, Date.now() + 2_000));
              c.cacheTag = true;
              c.newestMs = c.newestMs ?? null;
              c.topMs = await shallowNewest(join(ctx.home, rel));
              out.push(c);
              continue;
            }
          }
          if (depth >= 3) continue;
          for (const name of dir.names) if (!name.startsWith(".") && name !== "node_modules") {
            try { if ((await lstat(join(ctx.home, rel, name))).isDirectory()) queue.push({ rel: `${rel}/${name}`, depth: depth + 1 }); } catch { /* gone */ }
          }
        }
      }
    }
  }
  return out;
}

/** Remove one verified entry through descriptor-pinned unlinks; a swapped link can only make this unlink the link itself. */
export function removeFsEntry(home: string, rel: string): boolean {
  return removeHomeTree(home, join(home, rel));
}
