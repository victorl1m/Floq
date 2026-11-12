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

/**
 * Decides whether the canvas must retag sessions after the ground workspace's branch was observed.
 * `last` is the previously observed {workspaceId, branch}. Returns {from,to} only for an EXTERNAL checkout
 * (an agent ran `git checkout -b`, etc.): never on first sight, for another workspace, unchanged branch, or
 * while/after the switcher itself switched (it records the target in `last` so this returns null).
 */
export function branchChangeToFollow(input: {
  last: { workspaceId: string; branch: string } | null;
  workspaceId: string;
  currentBranch: string;
  switching: boolean;
}): { from: string; to: string } | null {
  const { last, workspaceId, currentBranch, switching } = input;
  if (!last || last.workspaceId !== workspaceId || last.branch === currentBranch || switching) return null;
  return { from: last.branch, to: currentBranch };
}

/** The runtime is deployed separately from the app: only a runtime that advertises this has the read-only dryRun pre-flight and lets git decide. */
export const BRANCH_SWITCH_V2 = "branch-switch-v2";

/** Capability present => new flow; absent/undefined/unknown info (older runtime) => legacy flow. */
export function supportsBranchSwitchV2(info: { server?: { capabilities?: string[] } } | null | undefined): boolean {
  const caps = info?.server?.capabilities;
  return Array.isArray(caps) && caps.includes(BRANCH_SWITCH_V2);
}

export const OUTDATED_RUNTIME_MESSAGE = "Your Floq runtime is outdated. Update/redeploy it to switch branches without sleeping agents and with local changes.";

/** Refusals only an older runtime gives (it required sleeping agents and a clean tree). */
export function isOutdatedRuntimeBranchError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "project_agents_active" || code === "project_worktree_dirty";
}

/**
 * Sessions the canvas hides because they are tagged with another branch. Branch names compare case-insensitively
 * ("Main" vs "main"). A lead and a running session are never hidden, and the canvas is never emptied by this
 * filter: when every session would be hidden, all of them show.
 */
export function hiddenByBranch<S extends { id: string; lead?: boolean; state?: string }>(
  sessions: S[],
  currentBranch: string,
  tags: Record<string, BranchTag>,
  inGround: (session: S) => boolean,
): Set<string> {
  const hidden = new Set<string>();
  const current = currentBranch.trim().toLowerCase();
  for (const session of sessions) {
    if (!inGround(session) || session.lead || session.state === "running") continue;
    const tag = tags[session.id];
    if (tag && tag.branch.trim().toLowerCase() !== current) hidden.add(session.id);
  }
  return hidden.size >= sessions.length ? new Set() : hidden;
}
