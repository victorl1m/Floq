import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fchownSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { UnsafeHomePathError, mkdirOwned, openChildDir, openHomeDir, readHomeFile, removeHomeTree, writeFileOwned, type HomeDir } from "./shard.js";

/**
 * "Last-good" conversation checkpoints (design: Part D). An append-only, incremental copy of each provider transcript kept
 * inside the user's encrypted home (~/.floq/checkpoints/<session-id>/), so a transcript the provider deleted or truncated can be
 * put back. Everything root does here goes through descriptor-pinned helpers and never follows a link out of the home.
 *
 * Layout per session dir:
 *   <pid>.jsonl | <pid>.g<N>.jsonl   transcript copy, generation 0 / N (a new generation starts when the source was rewritten)
 *   <pid>.meta.json                   { v, provider, generation, offset, sha256, sourceRel, updatedAt }
 *   <pid>.snapshot.json | .gN.json    whole-document snapshots (OpenCode export)
 *   <pid>.dir/                        directory mirror (agy conversation dir)
 *   .deleted                          retention marker (ms epoch) written when the agent is gone
 */

export const CHECKPOINT_ROOT_REL = ".floq/checkpoints";
export const CHECKPOINT_MIN_INTERVAL_MS = 60_000;
export const CHECKPOINT_RETENTION_AFTER_DELETE_MS = 7 * 24 * 3600_000;
/** Total bytes kept per provider id may reach this many times the live transcript before old generations are pruned. */
export const CHECKPOINT_CAP_FACTOR = 2;
const CAP_SLACK_BYTES = 1024 * 1024;
const CHUNK = 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DIR_MIRROR_BYTES = 256 * 1024 * 1024;
const MAX_DIR_MIRROR_DEPTH = 8;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const META_VERSION = 1;

export type CheckpointProvider = "claude" | "codex" | "opencode" | "antigravity";
export interface CheckpointHome { home: string; uid: number | null }

/** One path segment: safe on every filesystem, never "." / "..", never a separator or NUL. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function validSegment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value) && !value.includes("..");
}
function segment(value: string, what: string): string {
  if (!validSegment(value)) throw new UnsafeHomePathError(`bad ${what}`);
  return value;
}

interface Meta { v: number; provider: string; generation: number; offset: number; sha256: string; sourceRel: string; updatedAt: number }

const dataName = (pid: string, generation: number, ext = "jsonl") => (generation === 0 ? `${pid}.${ext}` : `${pid}.g${generation}.${ext}`);
const metaName = (pid: string) => `${pid}.meta.json`;

function sessionDir(home: string, sessionId: string): string {
  return join(home, CHECKPOINT_ROOT_REL, segment(sessionId, "session id"));
}

function ensureDir(target: CheckpointHome, dir: string): void {
  mkdirOwned(target.home, dir, target.uid, 0o700);
}

function insideHome(home: string, path: string): string {
  const rel = relative(home, path);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("/")) throw new UnsafeHomePathError("path escapes the home directory");
  return rel;
}

interface Opened { fd: number; stat: Stats; close(): void }

/** Open a regular file inside `home` read-only: ancestors pinned by descriptor, leaf O_NOFOLLOW, owner must be `uid`. Null when missing. */
function openConfined(home: string, path: string, uid: number | null): Opened | null {
  insideHome(home, path);
  const parent = openHomeDir(home, dirname(path));
  if (!parent) return null;
  try {
    let fd: number;
    try { fd = openSync(join(parent.path, basename(path)), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      if (code === "ELOOP" || code === "EMLINK") throw new UnsafeHomePathError("symlink in home path");
      throw error;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || (uid !== null && stat.uid !== uid) || stat.size > MAX_SOURCE_BYTES) {
      closeSync(fd);
      throw new UnsafeHomePathError("not a regular file owned by the user");
    }
    return { fd, stat, close: () => { try { closeSync(fd); } catch { /* already closed */ } } };
  } finally { parent.close(); }
}

/** Open child directory `name` of a pinned dir, creating it (mode 0700, owned by `uid`) when missing. Never follows a link. */
function openOrMakeChild(parent: HomeDir, name: string, uid: number | null): HomeDir | null {
  let child = openChildDir(parent, name);
  if (child) return child;
  try { mkdirSync(join(parent.path, name), { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  child = openChildDir(parent, name);
  if (child && uid !== null) { try { fchownSync(child.fd, uid, uid); } catch (error) { if (process.getuid?.() === 0) { child.close(); throw error; } } }
  return child;
}

const tick = () => new Promise<void>((done) => setImmediate(done));

/** Stream `length` bytes from `fd` starting at `position` into `onChunk`, yielding to the event loop between megabytes. */
async function streamRange(fd: number, position: number, length: number, onChunk: (chunk: Buffer) => void): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(length, 1)));
  let done = 0;
  while (done < length) {
    const want = Math.min(buffer.length, length - done);
    const got = readSync(fd, buffer, 0, want, position + done);
    if (got <= 0) throw Object.assign(new Error("source shrank while copying"), { code: "ESHRUNK" });
    onChunk(buffer.subarray(0, got));
    done += got;
    if (done % (8 * CHUNK) < got) await tick();
  }
}

function readMeta(target: CheckpointHome, dir: string, pid: string): Meta | null {
  let file;
  try { file = readHomeFile(target.home, join(dir, metaName(pid)), target.uid, 64 * 1024); } catch { return null; }
  if (!file) return null;
  try {
    const m = JSON.parse(file.text) as Partial<Meta>;
    if (m.v !== META_VERSION || !Number.isSafeInteger(m.generation) || !Number.isSafeInteger(m.offset) || typeof m.sha256 !== "string" || typeof m.sourceRel !== "string") return null;
    if ((m.generation as number) < 0 || (m.offset as number) < 0) return null;
    return m as Meta;
  } catch { return null; }
}

function writeMeta(target: CheckpointHome, dir: string, pid: string, meta: Meta): void {
  writeFileOwned(target.home, join(dir, metaName(pid)), JSON.stringify(meta), target.uid, 0o600);
}

export interface CheckpointResult { status: "copied" | "unchanged" | "new-generation" | "skipped"; bytes: number; generation: number; reason?: string }

export interface CheckpointRequest extends CheckpointHome {
  sessionId: string;
  provider: CheckpointProvider;
  providerSessionId: string;
  /** Host path of the provider transcript (must be inside `home`). */
  sourcePath: string;
  now?: number;
}

/**
 * Append the new complete lines of one transcript to its checkpoint. A source shorter than the recorded offset, or whose first
 * `offset` bytes no longer hash to the recorded sha256, was rewritten (compaction, rotation, truncation): that starts a new
 * generation file and leaves every earlier one untouched.
 */
export async function checkpointTranscript(req: CheckpointRequest): Promise<CheckpointResult> {
  const pid = segment(req.providerSessionId, "provider session id");
  const dir = sessionDir(req.home, req.sessionId);
  const sourceRel = insideHome(req.home, req.sourcePath);
  const source = openConfined(req.home, req.sourcePath, req.uid);
  if (!source) return { status: "skipped", bytes: 0, generation: 0, reason: "no source" };
  try {
    ensureDir(req, dir);
    let meta = readMeta(req, dir, pid);
    let generation = meta?.generation ?? 0;
    let offset = meta?.offset ?? 0;
    const hasher = createHash("sha256");
    let rewrote = false;
    if (meta && offset > 0) {
      // Our own copy shorter than the committed offset cannot be extended consistently either: start a new generation.
      if (source.stat.size < offset || checkpointSize(req.home, join(dir, dataName(pid, generation))) < offset) rewrote = true;
      else {
        const check = createHash("sha256");
        try { await streamRange(source.fd, 0, offset, (c) => { check.update(c); hasher.update(c); }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESHRUNK") throw error;
          rewrote = true;
        }
        if (!rewrote && check.digest("hex") !== meta.sha256) rewrote = true;
      }
    }
    const pinned = openHomeDir(req.home, dir);
    if (!pinned) return { status: "skipped", bytes: 0, generation, reason: "checkpoint dir vanished" };
    try {
      if (rewrote) { generation = (meta as Meta).generation + 1; offset = 0; }
      const hash = rewrote ? createHash("sha256") : hasher;
      const size = source.stat.size;
      const start = offset;
      // Only whole lines: find the last newline in what is new.
      let end = size;
      if (size > start) end = await lastNewlineEnd(source.fd, start, size);
      if (end <= start && !rewrote) return { status: "unchanged", bytes: 0, generation };
      const name = dataName(pid, generation);
      const fd = openSync(join(pinned.path, name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
      let wrote = 0;
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new UnsafeHomePathError("checkpoint is not a regular file");
        if (st.size > start) ftruncateSync(fd, start); // bytes appended by an interrupted run that never reached the meta file
        fchmodSync(fd, 0o600);
        if (req.uid !== null) { try { fchownSync(fd, req.uid, req.uid); } catch (error) { if (process.getuid?.() === 0) throw error; } }
        await streamRange(source.fd, start, end - start, (chunk) => { writeSync(fd, chunk); hash.update(chunk); wrote += chunk.length; });
      } finally { try { closeSync(fd); } catch { /* closed above */ } }
      const next: Meta = { v: META_VERSION, provider: req.provider, generation, offset: end, sha256: hash.digest("hex"), sourceRel, updatedAt: req.now ?? Date.now() };
      writeMeta(req, dir, pid, next);
      meta = next;
      enforceCap(req, dir, pid, generation, size);
      return { status: rewrote ? "new-generation" : "copied", bytes: wrote, generation };
    } finally { pinned.close(); }
  } finally { source.close(); }
}

function checkpointSize(home: string, path: string): number {
  const opened = (() => { try { return openConfined(home, path, null); } catch { return null; } })();
  if (!opened) return 0;
  try { return opened.stat.size; } finally { opened.close(); }
}

/** Offset just past the last "\n" in [start, size); `start` when there is none (an unfinished line is left for the next run). */
async function lastNewlineEnd(fd: number, start: number, size: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - start));
  let upper = size;
  while (upper > start) {
    const from = Math.max(start, upper - buffer.length);
    const got = readSync(fd, buffer, 0, upper - from, from);
    if (got <= 0) return start;
    const idx = buffer.subarray(0, got).lastIndexOf(0x0a);
    if (idx >= 0) return from + idx + 1;
    upper = from;
    await tick();
  }
  return start;
}

/** Keep the checkpoint bytes for one provider id under ~2x the live transcript: drop the oldest generations, never the newest. */
function enforceCap(target: CheckpointHome, dir: string, pid: string, newest: number, liveSize: number): void {
  const cap = liveSize * CHECKPOINT_CAP_FACTOR + CAP_SLACK_BYTES;
  const files: Array<{ generation: number; name: string; size: number }> = [];
  const held = openHomeDir(target.home, dir);
  if (!held) return;
  try {
    for (const name of readdirSync(held.path)) {
      const m = new RegExp("^" + pid.replace(/[.]/g, "\\.") + "(?:\\.g(\\d+))?\\.jsonl$").exec(name);
      if (!m) continue;
      try { const st = lstatSync(join(held.path, name)); if (st.isFile()) files.push({ generation: m[1] ? Number(m[1]) : 0, name, size: st.size }); } catch { /* raced */ }
    }
    files.sort((a, b) => a.generation - b.generation);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= cap || f.generation >= newest) break;
      try { rmSync(join(held.path, f.name)); total -= f.size; } catch { /* best effort */ }
    }
  } finally { held.close(); }
}

/** Whole-document snapshot (OpenCode `opencode export <ses_id>`): a new generation file only when the content changed. */
export function checkpointSnapshot(req: CheckpointHome & { sessionId: string; provider: CheckpointProvider; providerSessionId: string; content: string | Buffer; now?: number }): CheckpointResult {
  const pid = segment(req.providerSessionId, "provider session id");
  const bytes = typeof req.content === "string" ? Buffer.from(req.content) : req.content;
  if (bytes.length === 0 || bytes.length > MAX_SNAPSHOT_BYTES) return { status: "skipped", bytes: 0, generation: 0, reason: "empty or oversized" };
  const dir = sessionDir(req.home, req.sessionId);
  ensureDir(req, dir);
  const meta = readMeta(req, dir, pid);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (meta && meta.sha256 === digest) return { status: "unchanged", bytes: 0, generation: meta.generation };
  const generation = meta ? meta.generation + 1 : 0;
  writeFileOwned(req.home, join(dir, dataName(pid, generation, "snapshot.json")), bytes, req.uid, 0o600);
  writeMeta(req, dir, pid, { v: META_VERSION, provider: req.provider, generation, offset: bytes.length, sha256: digest, sourceRel: "", updatedAt: req.now ?? Date.now() });
  return { status: meta ? "new-generation" : "copied", bytes: bytes.length, generation };
}

/** Mirror a provider conversation directory (agy) into <pid>.dir/ (regular files only; links are never followed or recreated). */
export function checkpointDirectory(req: CheckpointHome & { sessionId: string; provider: CheckpointProvider; providerSessionId: string; sourceDir: string; now?: number }): CheckpointResult {
  const pid = segment(req.providerSessionId, "provider session id");
  const sourceRel = insideHome(req.home, req.sourceDir);
  const dir = sessionDir(req.home, req.sessionId);
  const mirror = join(dir, `${pid}.dir`);
  ensureDir(req, mirror);
  const src = openHomeDir(req.home, req.sourceDir);
  if (!src) return { status: "skipped", bytes: 0, generation: 0, reason: "no source" };
  const dst = openHomeDir(req.home, mirror);
  if (!dst) { src.close(); return { status: "skipped", bytes: 0, generation: 0, reason: "mirror vanished" }; }
  let copied = 0;
  let budget = MAX_DIR_MIRROR_BYTES;
  const walk = (from: HomeDir, to: HomeDir, depth: number): void => {
    for (const entry of readdirSync(from.path, { withFileTypes: true })) {
      if (!validSegment(entry.name)) continue;
      if (entry.isDirectory()) {
        if (depth >= MAX_DIR_MIRROR_DEPTH) continue;
        let a: HomeDir | null = null; let b: HomeDir | null = null;
        try {
          a = openChildDir(from, entry.name);
          if (!a) continue;
          b = openOrMakeChild(to, entry.name, req.uid);
          if (b) walk(a, b, depth + 1);
        } catch (error) { if (!(error instanceof UnsafeHomePathError)) throw error; } finally { a?.close(); b?.close(); }
      } else if (entry.isFile()) {
        const sourceFile = join(from.path, entry.name);
        let st: Stats;
        try { st = lstatSync(sourceFile); } catch { continue; }
        if (!st.isFile() || (req.uid !== null && st.uid !== req.uid) || st.size > budget) continue;
        let existing: Stats | null = null;
        try { existing = lstatSync(join(to.path, entry.name)); } catch { /* new */ }
        if (existing?.isFile() && existing.size === st.size && existing.mtimeMs >= st.mtimeMs) continue;
        let fd: number | null = null;
        try {
          fd = openSync(sourceFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
          const fst = fstatSync(fd);
          if (!fst.isFile()) continue;
          const buffer = Buffer.alloc(fst.size);
          let got = 0;
          while (got < fst.size) { const n = readSync(fd, buffer, got, fst.size - got, got); if (n <= 0) break; got += n; }
          writeFileOwned(null, join(to.path, entry.name), buffer.subarray(0, got), req.uid, 0o600);
          budget -= got; copied += got;
        } catch { /* unreadable file: skip, the next run retries */ } finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
      }
    }
  };
  try { walk(src, dst, 0); } finally { src.close(); dst.close(); }
  const meta: Meta = { v: META_VERSION, provider: req.provider, generation: 0, offset: copied, sha256: "", sourceRel, updatedAt: req.now ?? Date.now() };
  writeMeta(req, dir, pid, meta);
  return { status: copied > 0 ? "copied" : "unchanged", bytes: copied, generation: 0 };
}

export interface RestoreOptions {
  /** Owner uid of the restored file (defaults to the home's `uid`). */
  uid?: number | null;
}

/**
 * Put the latest checkpoint of one provider conversation back where the provider expects it (the path the transcript had when it was
 * checkpointed). Only acts when the live file is missing or shorter than the checkpoint; never replaces a longer or equal live file.
 * Returns true when a file was restored, false otherwise (no checkpoint, live file already as long, unsafe path, any error).
 */
export function restoreFromCheckpoint(home: string | CheckpointHome, sessionId: string, provider: CheckpointProvider | string, providerSessionId: string, options: RestoreOptions = {}): boolean {
  const target: CheckpointHome = typeof home === "string" ? { home, uid: options.uid ?? null } : { home: home.home, uid: options.uid ?? home.uid };
  try {
    const pid = segment(providerSessionId, "provider session id");
    const dir = sessionDir(target.home, sessionId);
    const meta = readMeta(target, dir, pid);
    if (!meta || meta.provider !== provider) return false;
    if (provider === "antigravity") return restoreDirectory(target, dir, pid, meta);
    if (provider === "opencode") return false; // an export is a document to re-import, not a file the CLI reads back; the lead decides how to feed it
    if (provider !== "claude" && provider !== "codex") return false;
    const rel = meta.sourceRel;
    if (!rel || rel.startsWith("/") || rel.split("/").some((p) => !p || p === "." || p === ".." || /[\0\\]/.test(p))) return false;
    const destination = join(target.home, rel);
    insideHome(target.home, destination);
    const checkpointFile = join(dir, dataName(pid, meta.generation));
    const live = lstatHomeSafe(target.home, destination);
    if (live === "unsafe") return false;
    if (live && live.isFile() && live.size >= meta.offset) return false;
    if (live && !live.isFile()) return false;
    const source = openConfined(target.home, checkpointFile, target.uid);
    if (!source) return false;
    try {
      if (source.stat.size < meta.offset) return false; // the copy itself is damaged: do not restore a prefix of unknown shape
      mkdirOwned(target.home, dirname(destination), target.uid, 0o700);
      const parent = openHomeDir(target.home, dirname(destination));
      if (!parent) return false;
      try {
        const temp = join(parent.path, `.${basename(destination)}.${process.pid}.${Date.now().toString(36)}.restore`);
        const out = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try {
          const buffer = Buffer.allocUnsafe(CHUNK);
          let position = 0;
          while (position < meta.offset) {
            const n = readSync(source.fd, buffer, 0, Math.min(buffer.length, meta.offset - position), position);
            if (n <= 0) throw new Error("checkpoint shorter than recorded");
            writeSync(out, buffer, 0, n);
            position += n;
          }
          fchmodSync(out, 0o600);
          if (target.uid !== null) { try { fchownSync(out, target.uid, target.uid); } catch (error) { if (process.getuid?.() === 0) throw error; } }
        } catch (error) { closeSync(out); rmSync(temp, { force: true }); throw error; }
        closeSync(out);
        // Re-check right before the swap: a live transcript that grew meanwhile wins.
        const again = lstatHomeSafe(target.home, destination);
        if (again === "unsafe" || (again && again.isFile() && again.size >= meta.offset)) { rmSync(temp, { force: true }); return false; }
        renameSync(temp, join(parent.path, basename(destination)));
        return true;
      } finally { parent.close(); }
    } finally { source.close(); }
  } catch { return false; }
}

/**
 * Head and tail text of the latest checkpoint copy of a Claude/Codex conversation (for the "Start fresh with summary" handoff).
 * Reads only the recorded `offset` bytes; null when there is no usable checkpoint. Partial lines at either cut are dropped.
 */
export function readCheckpointText(target: CheckpointHome, sessionId: string, provider: CheckpointProvider | string, providerSessionId: string, headBytes = 256 * 1024, tailBytes = 1024 * 1024): { head: string; tail: string } | null {
  try {
    if (provider !== "claude" && provider !== "codex") return null;
    const pid = segment(providerSessionId, "provider session id");
    const dir = sessionDir(target.home, sessionId);
    const meta = readMeta(target, dir, pid);
    if (!meta || meta.provider !== provider || meta.offset <= 0) return null;
    const source = openConfined(target.home, join(dir, dataName(pid, meta.generation)), target.uid);
    if (!source) return null;
    try {
      const size = Math.min(source.stat.size, meta.offset);
      const read = (len: number, at: number): string => {
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) { const n = readSync(source.fd, buf, got, len - got, at + got); if (n <= 0) break; got += n; }
        return buf.subarray(0, got).toString("utf8");
      };
      let head = read(Math.min(size, headBytes), 0);
      if (size > headBytes) head = head.slice(0, head.lastIndexOf("\n") + 1);
      const tailLen = Math.min(size, tailBytes);
      let tail = read(tailLen, size - tailLen);
      if (size > tailLen) tail = tail.slice(tail.indexOf("\n") + 1);
      return { head, tail };
    } finally { source.close(); }
  } catch { return null; }
}

function lstatHomeSafe(home: string, path: string): Stats | null | "unsafe" {
  const parent = (() => { try { return openHomeDir(home, dirname(path)); } catch { return "unsafe" as const; } })();
  if (parent === "unsafe") return "unsafe";
  if (!parent) return null;
  try {
    const st = lstatSync(join(parent.path, basename(path)));
    return st.isSymbolicLink() ? "unsafe" : st;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unsafe";
  } finally { parent.close(); }
}

function restoreDirectory(target: CheckpointHome, dir: string, pid: string, meta: Meta): boolean {
  const rel = meta.sourceRel;
  if (!rel || rel.startsWith("/") || rel.split("/").some((p) => !p || p === "." || p === ".." || /[\0\\]/.test(p))) return false;
  const destination = join(target.home, rel);
  insideHome(target.home, destination);
  const mirror = openHomeDir(target.home, join(dir, `${pid}.dir`));
  if (!mirror) return false;
  let restored = 0;
  try {
    mkdirOwned(target.home, destination, target.uid, 0o700);
    const dst = openHomeDir(target.home, destination);
    if (!dst) return false;
    const walk = (from: HomeDir, to: HomeDir, depth: number): void => {
      for (const entry of readdirSync(from.path, { withFileTypes: true })) {
        if (!validSegment(entry.name)) continue;
        if (entry.isDirectory()) {
          if (depth >= MAX_DIR_MIRROR_DEPTH) continue;
          let a: HomeDir | null = null; let b: HomeDir | null = null;
          try {
            a = openChildDir(from, entry.name);
            if (!a) continue;
            b = openOrMakeChild(to, entry.name, target.uid);
            if (b) walk(a, b, depth + 1);
          } catch (error) { if (!(error instanceof UnsafeHomePathError)) throw error; } finally { a?.close(); b?.close(); }
        } else if (entry.isFile()) {
          let existing: Stats | null = null;
          try { existing = lstatSync(join(to.path, entry.name)); } catch { /* missing */ }
          const sourceStat = lstatSync(join(from.path, entry.name));
          if (existing && (!existing.isFile() || existing.size >= sourceStat.size)) continue; // never replace a live file that is as long
          const fd = openSync(join(from.path, entry.name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
          try {
            const buffer = Buffer.alloc(fstatSync(fd).size);
            let got = 0;
            while (got < buffer.length) { const n = readSync(fd, buffer, got, buffer.length - got, got); if (n <= 0) break; got += n; }
            writeFileOwned(null, join(to.path, entry.name), buffer.subarray(0, got), target.uid, 0o600);
            restored++;
          } finally { closeSync(fd); }
        }
      }
    };
    try { walk(mirror, dst, 0); } finally { dst.close(); }
  } catch { return false; } finally { mirror.close(); }
  return restored > 0;
}

/**
 * Retention sweep. A checkpoint dir whose agent no longer exists gets a `.deleted` marker the first time it is seen and is removed
 * once the marker is older than 7 days. A dir whose agent exists again loses its marker. Returns how many session dirs were removed.
 */
export function sweepCheckpoints(target: CheckpointHome, existingSessionIds: ReadonlySet<string>, now = Date.now()): number {
  const rootPath = join(target.home, CHECKPOINT_ROOT_REL);
  let root: HomeDir | null;
  try { root = openHomeDir(target.home, rootPath); } catch { return 0; }
  if (!root) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(root.path)) {
      if (!validSegment(name)) continue;
      const dir = join(rootPath, name);
      const marker = join(dir, ".deleted");
      if (existingSessionIds.has(name)) { try { rmSync(join(root.path, name, ".deleted"), { force: true }); } catch { /* best effort */ } continue; }
      let stamp: number | null = null;
      try {
        const file = readHomeFile(target.home, marker, target.uid, 64);
        if (file) { const n = Number(file.text.trim()); if (Number.isFinite(n)) stamp = n; }
      } catch { /* unreadable marker: treat as missing */ }
      if (stamp === null) {
        try { writeFileOwned(target.home, marker, String(now), target.uid, 0o600); } catch { /* retry next sweep */ }
        continue;
      }
      if (now - stamp >= CHECKPOINT_RETENTION_AFTER_DELETE_MS) {
        try { if (removeHomeTree(target.home, dir)) { rmSync(join(root.path, name), { recursive: false, force: true }); removed++; } } catch { /* retry next sweep */ }
      }
    }
  } finally { root.close(); }
  return removed;
}

/** Newest Codex rollout transcript under a session's CODEX_HOME sessions tree (host path), found without following any link. */
export function findCodexRolloutPath(home: string, sessionsDir: string, uid: number | null): string | null {
  const ROLLOUT = /^rollout-.*\.jsonl$/;
  let best: { path: string; mtimeMs: number } | null = null;
  const walk = (dir: HomeDir, rel: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(dir.path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth >= 6) continue;
        let child: HomeDir | null = null;
        try { child = openChildDir(dir, entry.name); } catch { continue; }
        if (!child) continue;
        try { walk(child, join(rel, entry.name), depth + 1); } finally { child.close(); }
      } else if (entry.isFile() && ROLLOUT.test(entry.name)) {
        try {
          const st = lstatSync(join(dir.path, entry.name));
          if (!st.isFile() || (uid !== null && st.uid !== uid)) continue;
          if (!best || st.mtimeMs > best.mtimeMs) best = { path: join(rel, entry.name), mtimeMs: st.mtimeMs };
        } catch { /* raced */ }
      }
    }
  };
  let root: HomeDir | null;
  try { root = openHomeDir(home, sessionsDir); } catch { return null; }
  if (!root) return null;
  try { walk(root, sessionsDir, 0); } finally { root.close(); }
  return best ? (best as { path: string }).path : null;
}

/**
 * Debounced scheduler: at most one run per `intervalMs` per key, never two at once for a key, with one trailing run so the last
 * turn of a burst is still captured. `flush` ignores the interval (used when a session sleeps).
 */
export class CheckpointScheduler {
  private readonly last = new Map<string, number>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly run: (key: string) => Promise<void>,
    private readonly options: { intervalMs?: number; now?: () => number; onError?: (key: string, error: unknown) => void } = {},
  ) {}

  private get interval(): number { return this.options.intervalMs ?? CHECKPOINT_MIN_INTERVAL_MS; }
  private now(): number { return (this.options.now ?? Date.now)(); }

  /** A turn ended: run now if the interval has passed, otherwise schedule one trailing run. Returns true when a run started now. */
  notify(key: string): boolean {
    const wait = (this.last.get(key) ?? -Infinity) + this.interval - this.now();
    if (this.running.has(key)) { this.arm(key, Math.max(wait, 1000)); return false; }
    if (wait > 0) { this.arm(key, wait); return false; }
    void this.start(key);
    return true;
  }

  /** Run now regardless of the interval and wait for it (waits for a run already in flight first). */
  async flush(key: string): Promise<void> {
    this.disarm(key);
    const inflight = this.running.get(key);
    if (inflight) await inflight.catch(() => undefined);
    await this.start(key);
  }

  forget(key: string): void {
    this.disarm(key);
    this.last.delete(key);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private arm(key: string, ms: number): void {
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => { this.timers.delete(key); this.notify(key); }, ms);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private disarm(key: string): void {
    const t = this.timers.get(key);
    if (t) { clearTimeout(t); this.timers.delete(key); }
  }

  private start(key: string): Promise<void> {
    this.last.set(key, this.now());
    const task = this.run(key).catch((error) => { this.options.onError?.(key, error); }).finally(() => { if (this.running.get(key) === task) this.running.delete(key); });
    this.running.set(key, task);
    return task;
  }
}
