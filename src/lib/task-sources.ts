// Pure helpers for task-source tabs. Relative imports only so scripts/dev/test-task-sources.mjs runs without a bundler.
import type { TaskSourceInfo } from "./runtime/types";

export interface SourcePrefs { open: string[]; active: string }
export const EMPTY_SOURCE_PREFS: SourcePrefs = { open: [], active: "" };

/** Stable tab id of a source. */
export const sourceTabId = (s: Pick<TaskSourceInfo, "pluginId" | "sourceId">) => `${s.pluginId}/${s.sourceId}`;

export function readSourcePrefs(key: string): SourcePrefs {
  if (!key) return EMPTY_SOURCE_PREFS;
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "null") as { version?: number; open?: unknown; active?: unknown } | null;
    if (p?.version !== 1) return EMPTY_SOURCE_PREFS;
    const open = Array.isArray(p.open) ? [...new Set(p.open.filter((id): id is string => typeof id === "string"))] : [];
    return { open, active: typeof p.active === "string" ? p.active : "" };
  } catch { return EMPTY_SOURCE_PREFS; }
}

export function writeSourcePrefs(key: string, prefs: SourcePrefs): void {
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify({ version: 1, ...prefs })); } catch { /* optional preference */ }
}

/** Restored tabs are validated against what `GET /v1/task-sources` returns now: a disabled or removed source drops out, an empty set stays empty. */
export function reconcileSourcePrefs(prefs: SourcePrefs, available: Pick<TaskSourceInfo, "pluginId" | "sourceId">[]): SourcePrefs {
  const ids = new Set(available.map(sourceTabId));
  const open = prefs.open.filter((id) => ids.has(id));
  return { open, active: open.includes(prefs.active) ? prefs.active : "" };
}

export interface SourceGroup { title: string; source: TaskSourceInfo }

/**
 * One group per source. External items are never searched or listed here: a search query only filters which source entries show,
 * so native board search results stay boards-only.
 */
export function sourceGroups(sources: TaskSourceInfo[], query: string): SourceGroup[] {
  const q = query.trim().toLocaleLowerCase();
  return sources.filter((s) => !q || s.label.toLocaleLowerCase().includes(q)).map((s) => ({ title: s.label, source: s }));
}

export const openSource = (prefs: SourcePrefs, id: string): SourcePrefs => ({ open: prefs.open.includes(id) ? prefs.open : [...prefs.open, id], active: id });

/** Closing the active source tab clears the active source; the caller falls back to the board that was active. */
export function closeSource(prefs: SourcePrefs, id: string): SourcePrefs {
  return { open: prefs.open.filter((x) => x !== id), active: prefs.active === id ? "" : prefs.active };
}
