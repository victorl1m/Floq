export type BranchTag = { branch: string; resume?: boolean };

/**
 * A workspace's checked-out branch changed outside the canvas switcher (an agent ran `git checkout -b` / `git switch -c`,
 * or any other checkout). Its ground sessions follow the new branch: tags of the old branch (or no tag) move to `to`.
 * Sessions tagged with some other branch stay where they are, so switching back still shows that branch's own agents.
 * Pure: returns the same object when nothing changes. Nothing is slept or restarted, and ids never duplicate (map keys).
 */
export function followBranchChange(
  tags: Record<string, BranchTag>,
  groundSessionIds: string[],
  from: string,
  to: string,
): Record<string, BranchTag> {
  if (from === to) return tags;
  let next = tags;
  for (const id of groundSessionIds) {
    const tag = tags[id];
    if (tag && tag.branch !== from) continue;
    if (tag?.branch === to) continue;
    if (next === tags) next = { ...tags };
    next[id] = { branch: to };
  }
  return next;
}
