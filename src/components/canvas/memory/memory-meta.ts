import type { Memory, MemoryType } from "@/lib/runtime/types";

export const MEMORY_TYPES: MemoryType[] = ["fact", "decision", "procedure", "episode"];
export const MAX_TEXT = 4000;

/** Token colour of a memory type (defined for light and dark in index.css). */
export const typeColor = (type: MemoryType): string => `var(--mem-${type})`;

export const titleOf = (m: Pick<Memory, "title" | "text">): string => {
  const t = m.title.trim();
  if (t) return t;
  const first = m.text.trim().split("\n")[0] ?? "";
  return first.length > 90 ? first.slice(0, 89) + "…" : first || "(empty)";
};

export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(m, 1)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Invalidated last, pinned first, then newest. Search results keep the server's relevance order. */
export function sortMemories(list: Memory[], searching: boolean): Memory[] {
  const rank = (m: Memory) => (m.invalidatedAt ? 1 : 0);
  return [...list].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (searching) return 0;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
export function readView(): "list" | "graph" {
  try { return safeStorage()?.getItem("floq.memory.view") === "graph" ? "graph" : "list"; } catch { return "list"; }
}
export function writeView(v: "list" | "graph"): void {
  try { safeStorage()?.setItem("floq.memory.view", v); } catch { /* storage blocked */ }
}
