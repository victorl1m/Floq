import type { Icon } from "@tabler/icons-react";
import { IconBulb, IconGitFork, IconListCheck, IconTimeline } from "@tabler/icons-react";
import { compareDesc, relativeTime } from "@/lib/memory-dates";
import type { Memory, MemoryType } from "@/lib/runtime/types";

export { relativeTime };

export const MEMORY_TYPES: MemoryType[] = ["fact", "decision", "procedure", "episode"];
export const MAX_TEXT = 4000;

/** Fill colour of a memory type: the Floq palette (src/lib/robot-avatar.ts), defined for light and dark in index.css. */
export const typeColor = (type: MemoryType): string => `var(--mem-${type})`;
/** Text-safe variant of the type colour (AA on cards in both themes). */
export const typeInk = (type: MemoryType): string => `var(--mem-${type}-ink)`;

export const TYPE_META: Record<MemoryType, { label: string; plural: string; icon: Icon; hint: string }> = {
  fact: { label: "Fact", plural: "Facts", icon: IconBulb, hint: "Something true about the project" },
  decision: { label: "Decision", plural: "Decisions", icon: IconGitFork, hint: "A choice and why it was made" },
  procedure: { label: "Procedure", plural: "Procedures", icon: IconListCheck, hint: "Steps that work" },
  episode: { label: "Episode", plural: "Episodes", icon: IconTimeline, hint: "Something that happened" },
};

export const titleOf = (m: Pick<Memory, "title" | "text">): string => {
  const t = (m.title ?? "").trim();
  if (t) return t;
  const first = (m.text ?? "").trim().split("\n")[0] ?? "";
  return first.length > 90 ? first.slice(0, 89) + "…" : first || "(empty)";
};

/** Text after the title line (the title is shown separately); falls back to the whole text. */
export const bodyOf = (m: Pick<Memory, "title" | "text">): string => {
  const text = m.text ?? "";
  return (m.title ?? "").trim() ? text : text.split("\n").slice(1).join(" ").trim() || text;
};

export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Invalidated last, pinned first, then newest. Search results keep the server's relevance order. Invalid dates sort last. */
export function sortMemories(list: Memory[], searching: boolean): Memory[] {
  const rank = (m: Memory) => (m.invalidatedAt ? 1 : 0);
  return [...list].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (searching) return 0;
    return compareDesc(a.updatedAt, b.updatedAt);
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
