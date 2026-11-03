import { useSyncExternalStore } from "react";
import type { GitChanges } from "@/lib/runtime/git-review";
import { changeGroup, type ChangeGroup } from "./diff-parse";

/** Per-workspace git changes shared by the Changes and Files tabs, so the tree reuses what Changes already fetched. */
const store = new Map<string, GitChanges>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, GitChanges> = new Map();

export function publishGitChanges(targetId: string, changes: GitChanges | null) {
  if (changes) store.set(targetId, changes); else store.delete(targetId);
  snapshot = new Map(store);
  listeners.forEach((listener) => listener());
}

export function hasGitChanges(targetId: string) {
  return store.has(targetId);
}

export function useGitChanges(): ReadonlyMap<string, GitChanges> {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}

export interface TreeStatus { files: Map<string, ChangeGroup>; dirs: Set<string> }

/** Per-path status for one workspace: changed files and every ancestor folder containing a change. */
export function buildTreeStatus(changes: GitChanges | undefined): TreeStatus {
  const files = new Map<string, ChangeGroup>();
  const dirs = new Set<string>();
  for (const change of changes?.changes ?? []) {
    files.set(change.path, changeGroup(change));
    let index = change.path.lastIndexOf("/");
    while (index > 0) { dirs.add(change.path.slice(0, index)); index = change.path.lastIndexOf("/", index - 1); }
  }
  return { files, dirs };
}

export const STATUS_NAME_TONE: Record<ChangeGroup, string> = {
  modified: "text-amber-700 dark:text-amber-300",
  added: "text-emerald-700 dark:text-emerald-300",
  untracked: "text-emerald-700 dark:text-emerald-300",
  deleted: "text-red-600 line-through dark:text-red-400",
  renamed: "text-sky-700 dark:text-sky-300",
};
export const STATUS_BADGE_TONE: Record<ChangeGroup, string> = {
  modified: "text-amber-600 dark:text-amber-400",
  added: "text-emerald-600 dark:text-emerald-400",
  untracked: "text-emerald-600 dark:text-emerald-400",
  deleted: "text-red-600 dark:text-red-400",
  renamed: "text-sky-600 dark:text-sky-400",
};
