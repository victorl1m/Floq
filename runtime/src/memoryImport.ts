import type pg from "pg";
import { log } from "./logger.js";
import { MEMORY_MAX_TEXT, type MemoryCtx, type MemoryInput, type MigrationStatus } from "./memories.js";

/**
 * First-enable importer: canvas notes of kind `memory` become agent memories (Redis). Idempotent: one Redis marker per
 * note (memmig:notes:v1:<noteId>, set only after every fact of the note was stored; MemoryService.add also dedupes by
 * content). Notes are never deleted or altered, so turning memory off again brings them back into the prompt.
 * A pass re-scans unmarked notes, so legacy cards created while Redis was unreachable are picked up at the next start.
 */

export const IMPORT_MARKER_PREFIX = "memmig:notes:v1:";
/** Pin a project's imported facts only when all its memory notes together are this small (keeps "always seen" cheap). */
export const IMPORT_PIN_MAX_CHARS = 1500;

export interface ImportTarget {
  enabled(): boolean;
  available(): boolean;
  add(ctx: MemoryCtx, input: MemoryInput): Promise<{ id: string; action: string }>;
  /** Persisted (Redis) migration summary, exposed by /v1/memory/status. */
  setMigrationStatus?(s: MigrationStatus): Promise<void>;
  getMigrationStatus?(): MigrationStatus | null;
}
export type RawCommand = (...args: Array<string | number>) => Promise<unknown>;

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** One fact per blank-line paragraph; a paragraph with two or more bullets becomes one fact per bullet. Each fact <= MEMORY_MAX_TEXT. */
export function splitFacts(text: string): string[] {
  const facts: string[] = [];
  const push = (raw: string) => {
    let t = raw.trim();
    while (t.length > MEMORY_MAX_TEXT) {
      let cut = t.lastIndexOf("\n", MEMORY_MAX_TEXT);
      if (cut < MEMORY_MAX_TEXT / 2) cut = MEMORY_MAX_TEXT;
      facts.push(t.slice(0, cut).trim());
      t = t.slice(cut).trim();
    }
    if (t) facts.push(t);
  };
  for (const para of text.replace(/\r\n?/g, "\n").replace(/\0/g, "").split(/\n\s*\n/)) {
    const lines = para.split("\n");
    if (lines.filter((l) => BULLET.test(l)).length < 2) { push(para); continue; }
    let cur: string[] = [];
    for (const line of lines) {
      if (BULLET.test(line) && cur.length) { push(cur.join("\n")); cur = []; }
      cur.push(BULLET.test(line) ? line.replace(BULLET, "") : line);
    }
    push(cur.join("\n"));
  }
  return facts;
}

interface NoteRow { id: string; user_id: string; project_id: string | null; text: string; author: string | null }

/** One pass. Returns false when the store went away mid-way (retry later), true when every unmarked note was handled. */
export async function importMemoryNotes(pool: pg.Pool, memories: ImportTarget, raw: RawCommand): Promise<boolean> {
  if (!memories.enabled() || !memories.available()) return false;
  const rows = (await pool.query("SELECT id, user_id, project_id, text, author FROM canvas_notes WHERE kind = 'memory' ORDER BY user_id, created_at")).rows as NoteRow[];
  const totals = new Map<string, number>();
  for (const n of rows) { const k = n.user_id + "|" + (n.project_id ?? ""); totals.set(k, (totals.get(k) ?? 0) + String(n.text ?? "").trim().length); }
  let notes = 0, added = 0, pinned = 0, failed = 0;
  for (const n of rows) {
    const text = String(n.text ?? "").trim();
    try {
      if (await raw("EXISTS", IMPORT_MARKER_PREFIX + n.id) === 1) continue;
      const pin = (totals.get(n.user_id + "|" + (n.project_id ?? "")) ?? 0) <= IMPORT_PIN_MAX_CHARS;
      const ctx: MemoryCtx = { userId: n.user_id, projectId: n.project_id, sessionId: null, actor: "system", author: n.author ?? "" };
      for (const fact of splitFacts(text)) {
        const r = await memories.add(ctx, { text: fact, type: "fact", scope: "project", pinned: pin });
        if (r.action === "added") { added++; if (pin) pinned++; }
      }
      await raw("SET", IMPORT_MARKER_PREFIX + n.id, new Date().toISOString());
      notes++;
    } catch (error) {
      if (!memories.available()) return false; // store went away: no marker was written, the next pass redoes this note
      failed++;
      log.warn("memory.import_note_failed", { noteId: n.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }
  const prev = memories.getMigrationStatus?.();
  try { await memories.setMigrationStatus?.({ done: true, notes: (prev?.notes ?? 0) + notes, added: (prev?.added ?? 0) + added, pinned: (prev?.pinned ?? 0) + pinned, at: new Date().toISOString() }); }
  catch { /* status is informational */ }
  if (notes || failed) log.info("memory.import_summary", { notes, added, pinned, failed, scanned: rows.length });
  return true;
}

/** Startup hook: runs the importer once the store is ready, retrying until a pass completes. Returns a stop function. */
export function startMemoryImport(pool: pg.Pool, memories: ImportTarget, raw: RawCommand, intervalMs = 3000): () => void {
  if (!memories.enabled()) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    let ok = false;
    try { ok = await importMemoryNotes(pool, memories, raw); }
    catch (error) { log.warn("memory.import_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }); }
    if (!ok && !stopped) { timer = setTimeout(() => void tick(), intervalMs); timer.unref?.(); }
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
