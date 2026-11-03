import { constants, fstatSync, lstatSync, openSync, readSync, readdirSync, closeSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const MAX_TITLE_LENGTH = 120;
const MAX_CLAUDE_TREE_ENTRIES = 10_000;
const TITLE_CHUNK_BYTES = 1024 * 1024;
const MAX_TITLE_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_TITLE_LINE_BYTES = 8 * 1024 * 1024;
const MAX_CODEX_INDEX_BYTES = 256 * 1024;
const MAX_CODEX_INDEX_LINES = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claudeTranscripts = new Map<string, string>();

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
  return title || null;
}

function safeOpen(path: string, maxBytes: number): { fd: number; size: number } | null {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      closeSync(fd);
      fd = undefined;
      return null;
    }
    return { fd, size: stat.size };
  } catch {
    if (fd !== undefined) closeSync(fd);
    return null;
  }
}

function isSafeDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function findClaudeTranscript(home: string, id: string): string | null {
  const claudeDir = join(home, ".claude");
  const root = join(claudeDir, "projects");
  if (!isSafeDirectory(home) || !isSafeDirectory(claudeDir) || !isSafeDirectory(root)) return null;
  const confinedRoot = resolve(home) + sep;
  const cacheKey = resolve(home) + ":" + id;
  const cached = claudeTranscripts.get(cacheKey);
  if (cached) {
    try {
      if (realpathSync(cached).startsWith(realpathSync(root) + sep) && !lstatSync(cached).isSymbolicLink()) return cached;
    } catch { claudeTranscripts.delete(cacheKey); }
  }
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  const matches: string[] = [];
  walk: while (stack.length) {
    const next = stack.pop()!;
    let entries;
    try { entries = readdirSync(next.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      // Budget exhausted: use what was found so far rather than giving up on the title entirely.
      if (++visited > MAX_CLAUDE_TREE_ENTRIES) break walk;
      const candidate = join(next.path, entry.name);
      if (!resolve(candidate).startsWith(confinedRoot)) continue;
      if (entry.isDirectory() && next.depth < 8) stack.push({ path: candidate, depth: next.depth + 1 });
      else if (entry.isFile() && entry.name === id + ".jsonl") matches.push(candidate);
    }
  }
  if (!matches.length) return null;
  // Several project folders can hold the same uuid (resumed or moved worktrees); the most recently written one is live.
  let found = matches[0]!;
  if (matches.length > 1) {
    let newest = -1;
    for (const candidate of matches) {
      try {
        const stat = lstatSync(candidate);
        if (stat.isSymbolicLink()) continue;
        if (stat.mtimeMs > newest) { newest = stat.mtimeMs; found = candidate; }
      } catch { /* vanished */ }
    }
  } else {
    if (claudeTranscripts.size >= 1_000) claudeTranscripts.delete(claudeTranscripts.keys().next().value!);
    claudeTranscripts.set(cacheKey, found);
  }
  return found;
}

interface TitleScan { custom: string | null; ai: string | null; summary: string | null }
const TITLE_TYPE = /"type"\s*:\s*"(custom-title|ai-title|summary)"/;
const TITLE_FIELD = { "custom-title": "customTitle", "ai-title": "aiTitle", summary: "summary" } as const;

function scanLine(line: string, into: TitleScan): void {
  const match = TITLE_TYPE.exec(line);
  if (!match) return;
  const type = match[1] as keyof typeof TITLE_FIELD;
  const slot = type === "custom-title" ? "custom" : type === "ai-title" ? "ai" : "summary";
  if (into[slot]) return; // scanning newest-first: the first hit wins
  try {
    const record: unknown = JSON.parse(line);
    if (record && typeof record === "object" && (record as Record<string, unknown>).type === type) {
      into[slot] = cleanTitle((record as Record<string, unknown>)[TITLE_FIELD[type]]);
    }
  } catch {
    // Ignore incomplete or malformed CLI records.
  }
}

/** Scan [start,end) newest-first in bounded chunks. Lines cut by the range start are dropped unless `aligned`. */
function scanRange(fd: number, start: number, end: number, aligned: boolean, into: TitleScan): void {
  let pos = end;
  let carry: Buffer = Buffer.alloc(0);
  while (pos > start && !into.custom) {
    const count = Math.min(TITLE_CHUNK_BYTES, pos - start);
    const chunk = Buffer.allocUnsafe(count);
    const read = readSync(fd, chunk, 0, count, pos - count);
    if (read <= 0) return;
    pos -= count;
    let buf = Buffer.concat([chunk.subarray(0, read), carry]);
    const atStart = pos <= start;
    const firstNewline = buf.indexOf(0x0a);
    if (atStart && aligned) carry = Buffer.alloc(0);
    else if (firstNewline === -1) { carry = buf.length > MAX_TITLE_LINE_BYTES ? Buffer.alloc(0) : buf; continue; }
    else { carry = buf.subarray(0, firstNewline); buf = buf.subarray(firstNewline + 1); }
    if (carry.length > MAX_TITLE_LINE_BYTES) carry = Buffer.alloc(0);
    for (const line of buf.toString("utf8").split(/\r?\n/).reverse()) scanLine(line, into);
  }
}

const claudeTitleCache = new Map<string, { size: number; scan: TitleScan }>();

function scanTranscript(transcript: string): TitleScan | null {
  const opened = safeOpen(transcript, Number.MAX_SAFE_INTEGER);
  if (!opened) return null;
  try {
    const key = resolve(transcript);
    const cached = claudeTitleCache.get(key);
    if (cached && cached.size === opened.size) return cached.scan;
    const merged: TitleScan = { custom: null, ai: null, summary: null };
    const grown = cached && cached.size < opened.size;
    // Only bytes appended since the last scan need reading; a rewritten (smaller) file is rescanned.
    const from = grown ? cached.size : Math.max(0, opened.size - MAX_TITLE_SCAN_BYTES);
    scanRange(opened.fd, from, opened.size, from === 0 || grown === true, merged);
    if (grown) {
      for (const slot of ["custom", "ai", "summary"] as const) merged[slot] ??= cached.scan[slot];
    } else if (from > 0 && !merged.custom) {
      // Very large transcript: the title can also sit in the first part of the file.
      const head: TitleScan = { custom: null, ai: null, summary: null };
      scanRange(opened.fd, 0, Math.min(from, TITLE_CHUNK_BYTES), true, head);
      for (const slot of ["custom", "ai", "summary"] as const) merged[slot] ??= head[slot];
    }
    if (claudeTitleCache.size >= 1_000) claudeTitleCache.delete(claudeTitleCache.keys().next().value!);
    // Only resume incrementally from a clean line boundary; a half-written last record is rescanned next time.
    const last = Buffer.alloc(1);
    const endsClean = opened.size > 0 && readSync(opened.fd, last, 0, 1, opened.size - 1) === 1 && last[0] === 0x0a;
    if (endsClean) claudeTitleCache.set(key, { size: opened.size, scan: merged });
    else claudeTitleCache.delete(key);
    return merged;
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

/** Read only native title records for the exact Claude session UUID. */
export function readClaudeNativeTitle(home: string, id: string): string | null {
  if (!UUID.test(id)) return null;
  const root = join(home, ".claude", "projects");
  const transcript = findClaudeTranscript(home, id);
  if (!transcript) return null;
  try {
    if (!realpathSync(transcript).startsWith(realpathSync(root) + sep)) return null;
  } catch { return null; }
  const customTitleFile = join(resolve(transcript, ".."), id, "custom-title.json");
  try {
    const realRoot = realpathSync(root) + sep;
    const titleDir = resolve(transcript, "..", id);
    if (!isSafeDirectory(titleDir) || !realpathSync(titleDir).startsWith(realRoot)) throw new Error("unsafe title directory");
    const opened = safeOpen(customTitleFile, 16 * 1024);
    if (opened) {
      try {
        const bytes = Buffer.allocUnsafe(opened.size);
        const read = readSync(opened.fd, bytes, 0, opened.size, 0);
        const value: unknown = JSON.parse(bytes.subarray(0, read).toString("utf8"));
        if (value && typeof value === "object" && "customTitle" in value) {
          const title = cleanTitle(value.customTitle);
          if (title) return title;
        }
      } catch {
        // The title sidecar is optional; try transcript records next.
      } finally { closeSync(opened.fd); }
    }
  } catch { /* optional sidecar is missing or outside the checked projects tree */ }
  const scan = scanTranscript(transcript);
  if (!scan) return null;
  // `summary` records are the legacy (pre ai-title) Claude Code format; lowest priority.
  return scan.custom ?? scan.ai ?? scan.summary;
}

function safeDirectoryWithin(root: string, target: string): boolean {
  try {
    if (!isSafeDirectory(root)) return false;
    const realRoot = realpathSync(root);
    // The shard home itself is the trust boundary. If that path is redirected,
    // a path that appears beneath it could actually point outside the shard.
    if (realRoot !== resolve(root)) return false;
    const absoluteTarget = resolve(target);
    const pathFromRoot = relative(realRoot, absoluteTarget);
    if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(".." + sep)) return false;
    let current = realRoot;
    for (const part of pathFromRoot.split(sep)) {
      current = join(current, part);
      if (!isSafeDirectory(current) || realpathSync(current) !== current) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Read the Codex CLI's native title index entry without opening rollout prompts. */
export function readCodexNativeTitle(shardHome: string, codexHome: string, id: string): string | null {
  if (!UUID.test(id)) return null;
  if (!safeDirectoryWithin(shardHome, codexHome)) return null;
  const path = join(codexHome, "session_index.jsonl");
  const opened = safeOpen(path, Number.MAX_SAFE_INTEGER);
  if (!opened) return null;
  try {
    const size = Math.min(opened.size, MAX_CODEX_INDEX_BYTES);
    const bytes = Buffer.allocUnsafe(size);
    const count = readSync(opened.fd, bytes, 0, size, opened.size - size);
    const lines = bytes.subarray(0, count).toString("utf8").split(/\r?\n/).slice(-MAX_CODEX_INDEX_LINES).reverse();
    for (const line of lines) {
      if (!line.includes(id)) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (record && typeof record === "object" && "id" in record && record.id === id && "thread_name" in record) {
          const title = cleanTitle(record.thread_name);
          if (title) return title;
        }
      } catch {
        // Ignore malformed index entries.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}
