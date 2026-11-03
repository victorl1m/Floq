import type { GitChange } from "@/lib/runtime/git-review";

export type DiffLineKind = "add" | "del" | "ctx" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** Total rendered rows (hunk headers included). */
  rows: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Parse a unified diff (as produced by `git diff`) into hunks with old/new line numbers. */
export function parseDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  let rows = 0;
  for (const raw of patch.split("\n")) {
    const match = HUNK.exec(raw);
    if (match) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldNo = Number(match[1]);
      newNo = Number(match[2]);
      rows++;
      continue;
    }
    if (!current) continue; // file header lines before the first hunk
    if (raw.startsWith("+")) { current.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) }); added++; rows++; }
    else if (raw.startsWith("-")) { current.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) }); removed++; rows++; }
    else if (raw.startsWith("\\")) { current.lines.push({ kind: "note", oldNo: null, newNo: null, text: raw.slice(2) }); rows++; }
    else if (raw.startsWith(" ")) { current.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) }); rows++; }
    // a trailing empty string from split("\n") is ignored
  }
  return { hunks, added, removed, rows };
}

export type ChangeGroup = "modified" | "added" | "deleted" | "renamed" | "untracked";

export const GROUP_ORDER: ChangeGroup[] = ["modified", "added", "deleted", "renamed", "untracked"];
export const GROUP_LABEL: Record<ChangeGroup, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
};
export const GROUP_LETTER: Record<ChangeGroup, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" };

export function changeGroup(change: GitChange): ChangeGroup {
  if (change.untracked) return "untracked";
  if (change.status.includes("D")) return "deleted";
  if (change.status.includes("R")) return "renamed";
  if (change.status.includes("A")) return "added";
  return "modified";
}
