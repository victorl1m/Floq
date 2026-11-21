import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_MS, DEFAULT_CONFIG, decideBranch, decideFs, decideWorktree, isAllowedFsPath, planCleanup, summarize, type BranchCandidate, type FsCandidate, type StorageSenseReport, type WorktreeCandidate } from "../src/storageSense/plan.js";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ID = "11111111-2222-3333-4444-555555555555";
const old = NOW - 90 * DAY_MS;

const wt = (over: Partial<WorktreeCandidate> = {}): WorktreeCandidate => ({
  category: "worktree", workspaceId: "w", projectId: "p", path: `.floq/worktrees/${ID}`, activeSessions: 0, lastActivityMs: old,
  git: { uncommittedFiles: 0, unmergedPatches: 0, missing: false }, ...over,
});
const br = (over: Partial<BranchCandidate> = {}): BranchCandidate => ({
  category: "branch", projectId: "p", branch: `floq/${ID}`, agentId: ID, sessionExists: false, checkedOutSomewhere: false, lastCommitMs: old, unmergedPatches: 0, ...over,
});
const fsc = (over: Partial<FsCandidate> = {}): FsCandidate => ({
  category: "attachment", path: `.floq/attachments/${ID}`, isSymlink: false, isDirectory: true, sameDevice: true, newestMs: old, hasLock: false, bytes: 10, ...over,
});

test("worktree: clean, merged, idle is removed", () => {
  assert.equal(decideWorktree(wt(), DEFAULT_CONFIG, NOW).action, "remove");
});
test("worktree: uncommitted work is kept and flagged", () => {
  const d = decideWorktree(wt({ git: { uncommittedFiles: 2, unmergedPatches: 0, missing: false } }), DEFAULT_CONFIG, NOW);
  assert.deepEqual([d.action, d.reason, d.attention], ["keep", "unsaved_work", true]);
});
test("worktree: unmerged commits are kept and flagged", () => {
  const d = decideWorktree(wt({ git: { uncommittedFiles: 0, unmergedPatches: 3, missing: false } }), DEFAULT_CONFIG, NOW);
  assert.deepEqual([d.action, d.reason, d.attention], ["keep", "not_merged", true]);
});
test("worktree: a cherry-picked branch (no unmerged patches) counts as merged", () => {
  // `git cherry` reports a cherry-picked commit with '-', so unmergedPatches is 0 even though ancestry differs.
  assert.equal(decideWorktree(wt({ git: { uncommittedFiles: 0, unmergedPatches: 0, missing: false } }), DEFAULT_CONFIG, NOW).action, "remove");
});
test("worktree: live or sleeping agent keeps it, even when old and clean", () => {
  assert.equal(decideWorktree(wt({ activeSessions: 1 }), DEFAULT_CONFIG, NOW).reason, "agent_live");
});
test("worktree: recent activity, unknown git state and unknown base are kept", () => {
  assert.equal(decideWorktree(wt({ lastActivityMs: NOW - DAY_MS }), DEFAULT_CONFIG, NOW).reason, "too_recent");
  assert.equal(decideWorktree(wt({ git: null }), DEFAULT_CONFIG, NOW).reason, "unknown_state");
  assert.equal(decideWorktree(wt({ git: { uncommittedFiles: 0, unmergedPatches: null, missing: false } }), DEFAULT_CONFIG, NOW).reason, "unknown_state");
});
test("worktree: only Floq-managed paths, and 0 days switches the category off", () => {
  assert.equal(decideWorktree(wt({ path: "projects/mine" }), DEFAULT_CONFIG, NOW).reason, "protected_path");
  assert.equal(decideWorktree(wt(), { ...DEFAULT_CONFIG, worktreeDays: 0 }, NOW).reason, "disabled");
});

test("branch: merged orphan is removed; live agent, checked out, unmerged, foreign names are kept", () => {
  assert.equal(decideBranch(br(), DEFAULT_CONFIG, NOW).action, "remove");
  assert.equal(decideBranch(br({ sessionExists: true }), DEFAULT_CONFIG, NOW).reason, "agent_exists");
  assert.equal(decideBranch(br({ checkedOutSomewhere: true }), DEFAULT_CONFIG, NOW).reason, "checked_out");
  assert.equal(decideBranch(br({ unmergedPatches: 1 }), DEFAULT_CONFIG, NOW).attention, true);
  assert.equal(decideBranch(br({ branch: "main" }), DEFAULT_CONFIG, NOW).reason, "protected_path");
  assert.equal(decideBranch(br({ branch: "floq/not-a-uuid" }), DEFAULT_CONFIG, NOW).reason, "protected_path");
});

test("fs: symlink is never followed or removed", () => {
  assert.equal(decideFs(fsc({ isSymlink: true }), DEFAULT_CONFIG, NOW).reason, "symlink");
});
test("fs: other device, incomplete walk, lock file and recent use are kept", () => {
  assert.equal(decideFs(fsc({ sameDevice: false }), DEFAULT_CONFIG, NOW).reason, "other_device");
  assert.equal(decideFs(fsc({ newestMs: null }), DEFAULT_CONFIG, NOW).reason, "walk_incomplete");
  assert.equal(decideFs(fsc({ hasLock: true }), DEFAULT_CONFIG, NOW).reason, "lock_file");
  assert.equal(decideFs(fsc({ newestMs: NOW - 1000 }), DEFAULT_CONFIG, NOW).reason, "too_recent");
});
test("fs: scratchpad of a live session is kept, of an ended or missing session removed", () => {
  const path = `.floq/tmp/claude-1000/-home-agent-proj/${ID}`;
  const base = { category: "scratchpad" as const, path };
  assert.equal(decideFs(fsc({ ...base, session: { state: "live", lastActiveMs: old } }), DEFAULT_CONFIG, NOW).reason, "agent_live");
  assert.equal(decideFs(fsc({ ...base, session: { state: "ended", lastActiveMs: old } }), DEFAULT_CONFIG, NOW).action, "remove");
  assert.equal(decideFs(fsc({ ...base, session: { state: "missing", lastActiveMs: null } }), DEFAULT_CONFIG, NOW).action, "remove");
  // A session that ended yesterday keeps its scratchpad even when the files are old.
  assert.equal(decideFs(fsc({ ...base, session: { state: "ended", lastActiveMs: NOW - DAY_MS } }), DEFAULT_CONFIG, NOW).reason, "too_recent");
});
test("fs: never-touch locations are refused whatever the facts say", () => {
  for (const path of ["Artifacts/report.md", ".floq/checkpoints/abc", ".claude/projects/x", ".floq/projects/p", ".floq/worktrees/" + ID, ".floq/attachments", ".floq/tmp/../checkpoints/x", ".floq/attachments/" + ID + "/../x", ".floq/tmp/.hidden", ".floq/tmp/claude-1000", "/etc/passwd"]) {
    for (const category of ["attachment", "tmp", "scratchpad"] as const) {
      assert.equal(isAllowedFsPath(category, path), false, `${category} ${path}`);
      assert.equal(decideFs(fsc({ category, path }), DEFAULT_CONFIG, NOW).action, "keep");
    }
  }
  assert.equal(isAllowedFsPath("tmp", ".floq/tmp/pip-cache"), true);
  assert.equal(isAllowedFsPath("attachment", `.floq/attachments/${ID}`), true);
});

test("planCleanup maps every candidate and summarize only speaks for real runs", () => {
  const plan = planCleanup([wt(), br({ unmergedPatches: 2 }), fsc()], DEFAULT_CONFIG, NOW);
  assert.deepEqual(plan.map((d) => d.action), ["remove", "keep", "remove"]);
  const report = { dryRun: false, freedBytes: 2048, counts: { removed: 2, kept: 1, failed: 0, attention: 1 } } as StorageSenseReport;
  const s = summarize(report)!;
  assert.equal(s.level, "warning");
  assert.match(s.body, /Removed 2 items \(2\.0 KB freed\)/);
  assert.equal(summarize({ ...report, dryRun: true }), null);
  assert.equal(summarize({ ...report, counts: { removed: 0, kept: 5, failed: 0, attention: 0 } }), null);
});

test("build output: only CACHEDIR.TAG folders in projects/workspaces, judged by their top-level times; big ended scratchpads are judged by session age", async () => {
  const { decideFs, DEFAULT_CONFIG, DAY_MS } = await import("../dist/storageSense/plan.js");
  const now = 100 * DAY_MS;
  const base = { isSymlink: false, isDirectory: true, sameDevice: true, newestMs: null, hasLock: false, bytes: 9e9 };
  const old = { ...base, category: "build", path: ".floq/projects/p1/src-tauri/target", cacheTag: true, topMs: now - 20 * DAY_MS };
  assert.equal(decideFs(old, DEFAULT_CONFIG, now).action, "remove");
  assert.equal(decideFs({ ...old, topMs: now - 2 * DAY_MS }, DEFAULT_CONFIG, now).action, "keep");
  assert.equal(decideFs({ ...old, cacheTag: false }, DEFAULT_CONFIG, now).action, "keep");
  assert.equal(decideFs({ ...old, path: "Artifacts/x/target" }, DEFAULT_CONFIG, now).action, "keep");
  const pad = { ...base, category: "scratchpad", path: ".floq/tmp/claude-20000/p/0b3da341-0000-4000-8000-000000000000", topMs: now - 30 * DAY_MS };
  assert.equal(decideFs({ ...pad, session: { state: "ended", lastActiveMs: now - 30 * DAY_MS } }, DEFAULT_CONFIG, now).action, "remove");
  assert.equal(decideFs({ ...pad, session: { state: "live", lastActiveMs: now } }, DEFAULT_CONFIG, now).action, "keep");
  assert.equal(decideFs({ ...pad, category: "tmp", path: ".floq/tmp/x" }, DEFAULT_CONFIG, now).action, "keep"); // other categories still need a full walk
});
