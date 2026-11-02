import { constants, fstatSync, lstatSync, openSync, readSync, readdirSync, closeSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const MAX_TITLE_LENGTH = 120;
const MAX_CLAUDE_TREE_ENTRIES = 10_000;
const MAX_TITLE_RECORD_BYTES = 1024 * 1024;
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

function readTail(path: string, maxBytes: number): string | null {
  const opened = safeOpen(path, Number.MAX_SAFE_INTEGER);
  if (!opened) return null;
  try {
    const count = Math.min(opened.size, maxBytes);
    const bytes = Buffer.allocUnsafe(count);
    const read = readSync(opened.fd, bytes, 0, count, opened.size - count);
    return bytes.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
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
  let found: string | null = null;
  while (stack.length) {
    const next = stack.pop()!;
    let entries;
    try { entries = readdirSync(next.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > MAX_CLAUDE_TREE_ENTRIES) return null;
      const candidate = join(next.path, entry.name);
      if (!resolve(candidate).startsWith(confinedRoot)) continue;
      if (entry.isDirectory() && next.depth < 8) stack.push({ path: candidate, depth: next.depth + 1 });
      else if (entry.isFile() && entry.name === id + ".jsonl") {
        if (found) return null;
        found = candidate;
      }
    }
  }
  if (found) {
    if (claudeTranscripts.size >= 1_000) claudeTranscripts.delete(claudeTranscripts.keys().next().value!);
    claudeTranscripts.set(cacheKey, found);
  }
  return found;
}

function titleFromRecordText(text: string, type: "custom-title" | "ai-title"): string | null {
  const field = type === "custom-title" ? "customTitle" : "aiTitle";
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.includes(`"type":"${type}"`) && !line.includes(`"type": "${type}"`)) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (record && typeof record === "object" && "type" in record && record.type === type && field in record) {
        const title = cleanTitle((record as Record<string, unknown>)[field]);
        if (title) return title;
      }
    } catch {
      // Ignore incomplete or malformed CLI records.
    }
  }
  return null;
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
  const text = readTail(transcript, MAX_TITLE_RECORD_BYTES);
  if (!text) return null;
  return titleFromRecordText(text, "custom-title") ?? titleFromRecordText(text, "ai-title");
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
