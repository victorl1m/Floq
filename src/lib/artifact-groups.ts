import { dayLabel } from "./notifications.ts";

export interface ArtifactLike { name: string; path: string; size: number; modifiedAt: number }
export interface ArtifactDayGroup<T extends ArtifactLike> { key: string; label: string; entries: T[] }

/** Local midnight of the entry's day: a stable group key (the "Today"/"Yesterday" label changes at midnight, the key does not). */
export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return String(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
};

/** Every whitespace-separated word of the query must occur in the path (case-insensitive); an empty query matches all. */
export function matchesQuery(entry: ArtifactLike, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = entry.path.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** Filter by the query, sort newest first, and group by local calendar day. */
export function groupArtifacts<T extends ArtifactLike>(entries: readonly T[], query = "", now = new Date()): ArtifactDayGroup<T>[] {
  const sorted = entries.filter((entry) => matchesQuery(entry, query)).sort((a, b) => b.modifiedAt - a.modifiedAt);
  const groups: ArtifactDayGroup<T>[] = [];
  for (const entry of sorted) {
    const key = dayKey(entry.modifiedAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, label: dayLabel(new Date(entry.modifiedAt).toISOString(), now), entries: [entry] });
  }
  return groups;
}
