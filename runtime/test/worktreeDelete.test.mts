import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { deleteWorktree, inspectWorktree } from "../dist/worktreeDelete.js";
import { SessionManager } from "../dist/manager.js";

const execFile = promisify(execFileCallback);
const NULL = process.platform === "win32" ? "NUL" : "/dev/null";
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL, GIT_TERMINAL_PROMPT: "0" };

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, { cwd, env: ENV });
  return stdout.trim();
}

/** Temp "home" holding a primary checkout (home/repo) with one commit on main, plus helpers. */
async function fixture(t, { remote = false } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `floq-wtdel-${process.pid}-`)));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "Floq Tests"]);
  await git(repo, ["config", "user.email", "floq-test@example.invalid"]);
  writeFileSync(join(repo, "tracked.txt"), "clean\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  if (remote) {
    const bare = join(home, "remote.git");
    mkdirSync(bare);
    await git(bare, ["init", "--bare", "--initial-branch=main"]);
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "origin", "main"]);
    await git(repo, ["remote", "set-head", "origin", "main"]);
  }
  const run = async (cwd, args) => {
    try {
      const { stdout } = await execFile("git", ["-c", `core.hooksPath=${NULL}`, "-c", "core.fsmonitor=false", ...args], { cwd: join(home, cwd), env: ENV });
      return { stdout, exitCode: 0 };
    } catch (error) {
      return { stdout: (error.stdout ?? "") + (error.stderr ?? ""), exitCode: typeof error.code === "number" ? error.code : 1 };
    }
  };
  const addWorktree = async ({ branch, detach = false } = {}) => {
    const id = randomUUID();
    mkdirSync(join(home, ".floq", "worktrees"), { recursive: true });
    const args = ["worktree", "add"];
    if (detach) args.push("--detach");
    else args.push("-b", branch ?? `floq/${id}`);
    args.push("--", join(home, ".floq", "worktrees", id));
    if (detach) args.push("HEAD");
    await git(repo, args);
    const cwd = `.floq/worktrees/${id}`;
    return { id, cwd, abs: join(home, cwd), ctx: { home, projectCwd: "repo", cwd, run } };
  };
  const branches = async () => (await git(repo, ["branch", "--format=%(refname:short)"])).split(/\r?\n/).filter(Boolean).sort();
  return { home, repo, run, addWorktree, branches };
}

test("clean delete removes the worktree and the Floq-created branch, never the default branch", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  const status = await inspectWorktree(w.ctx);
  assert.equal(status.uncommittedFiles, 0);
  assert.equal(status.unsavedCommits, 0);
  assert.equal(status.floqBranch, `floq/${w.id}`);
  assert.equal(status.baseBranch, "main");
  const result = await deleteWorktree(w.ctx, status, false);
  assert.deepEqual(result, { alreadyGone: false, branchDeleted: `floq/${w.id}`, branchNote: null });
  assert.equal(existsSync(w.abs), false);
  assert.deepEqual(await f.branches(), ["main"]);
  assert.ok(existsSync(join(f.repo, "tracked.txt")));
});

test("removal uses the absolute worktree path Git recorded, not one recomputed from the project", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  const calls = [];
  const ctx = { ...w.ctx, run: async (cwd, args) => { calls.push({ cwd, args }); return f.run(cwd, args); } };
  const status = await inspectWorktree(ctx);
  // Floq's sandbox reaches the home through a different mount (/home/agent) than the path Git stored, so a path
  // relative to the project checkout would not match the recorded worktree there.
  assert.equal(isAbsolute(status.removeArg), true);
  assert.equal(realpathSync(status.removeArg), realpathSync(w.abs));
  const result = await deleteWorktree(ctx, status, false);
  assert.equal(result.branchDeleted, `floq/${w.id}`);
  const remove = calls.find((call) => call.args[0] === "worktree" && call.args[1] === "remove");
  assert.ok(remove);
  assert.equal(remove.args.at(-1), status.removeArg);
  assert.equal(existsSync(w.abs), false);
});

test("deletion repairs a mismatched Git backlink before retrying safely", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  // Reproduce the sandbox's validation error; repair and the retry run real Git.
  // This also runs on Windows, where the production bind mounts are unavailable.
  const calls = [];
  let failed = false;
  const ctx = { ...w.ctx, run: async (cwd, args) => {
    let result;
    if (!failed && args[0] === "worktree" && args[1] === "remove") {
      failed = true;
      result = { exitCode: 128, stdout: `fatal: validation failed, cannot remove working tree: '${w.abs}' does not point back to '.git/worktrees/${w.id}'` };
    } else result = await f.run(cwd, args);
    calls.push({ args, result });
    return result;
  } };
  const status = await inspectWorktree(ctx);
  const result = await deleteWorktree(ctx, status, false);
  const removals = calls.filter(({ args }) => args[0] === "worktree" && args[1] === "remove");
  assert.equal(removals.length, 2);
  assert.match(removals[0].result.stdout, /does not point back to/);
  assert.deepEqual(removals[0].args, removals[1].args);
  assert.equal(removals[1].result.exitCode, 0);
  assert.ok(calls.some(({ args }) => args[1] === "repair" && args.at(-1) === status.removeArg));
  assert.equal(result.branchDeleted, `floq/${w.id}`);
  assert.equal(existsSync(w.abs), false);
  assert.ok(existsSync(join(f.repo, "tracked.txt")));
});

test("the primary checkout and non-Floq paths are refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(inspectWorktree({ home: f.home, projectCwd: "repo", cwd: "repo", run: f.run }), { code: "primary_workspace" });
  // A real linked worktree outside .floq/worktrees is not Floq's to delete.
  const elsewhere = join(f.home, "elsewhere");
  await git(f.repo, ["worktree", "add", "-b", "mine", "--", elsewhere]);
  await assert.rejects(inspectWorktree({ home: f.home, projectCwd: "repo", cwd: "elsewhere", run: f.run }), { code: "not_floq_worktree" });
  await assert.rejects(inspectWorktree({ home: f.home, projectCwd: "repo", cwd: "../escape", run: f.run }), { status: 400 });
  assert.ok(existsSync(elsewhere));
  // A plain directory at a Floq-shaped path that Git does not know about.
  const id = randomUUID();
  mkdirSync(join(f.home, ".floq", "worktrees", id), { recursive: true });
  writeFileSync(join(f.home, ".floq", "worktrees", id, "keep.txt"), "precious");
  await assert.rejects(inspectWorktree({ home: f.home, projectCwd: "repo", cwd: `.floq/worktrees/${id}`, run: f.run }), { code: "not_linked_worktree" });
  assert.ok(existsSync(join(f.home, ".floq", "worktrees", id, "keep.txt")));
});

test("symlinked worktree paths and symlinked roots are refused", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  const outside = join(f.home, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "precious");
  const id = randomUUID();
  try { symlinkSync(outside, join(f.home, ".floq", "worktrees", id), "junction"); }
  catch { t.skip("symlinks unavailable"); return; }
  await assert.rejects(inspectWorktree({ ...w.ctx, cwd: `.floq/worktrees/${id}` }), { code: "unsafe_worktree_path" });
  assert.ok(existsSync(join(outside, "keep.txt")));
  // The whole worktrees root replaced by a link.
  const moved = join(f.home, "moved-root");
  const { renameSync } = await import("node:fs");
  renameSync(join(f.home, ".floq", "worktrees"), moved);
  symlinkSync(moved, join(f.home, ".floq", "worktrees"), "junction");
  await assert.rejects(inspectWorktree(w.ctx), { code: "unsafe_worktree_path" });
  assert.ok(existsSync(join(moved, w.id)));
});

test("uncommitted changes are refused, then removed only with force", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  writeFileSync(join(w.abs, "tracked.txt"), "edited\n");
  writeFileSync(join(w.abs, "new.txt"), "untracked\n");
  const status = await inspectWorktree(w.ctx);
  assert.equal(status.uncommittedFiles, 2);
  await assert.rejects(deleteWorktree(w.ctx, status, false), { code: "worktree_has_changes", message: /2 uncommitted files/ });
  assert.ok(existsSync(join(w.abs, "new.txt")));
  assert.ok((await f.branches()).includes(`floq/${w.id}`));
  const result = await deleteWorktree(w.ctx, status, true);
  assert.equal(result.branchDeleted, `floq/${w.id}`);
  assert.equal(existsSync(w.abs), false);
});

test("commits that exist nowhere else are refused, then removed only with force (-D)", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  writeFileSync(join(w.abs, "work.txt"), "work\n");
  await git(w.abs, ["add", "."]);
  await git(w.abs, ["commit", "-m", "wip"]);
  const status = await inspectWorktree(w.ctx);
  assert.equal(status.uncommittedFiles, 0);
  assert.equal(status.commitsNotOnBase, 1);
  assert.equal(status.unpushedCommits, 1);
  assert.equal(status.unsavedCommits, 1);
  await assert.rejects(deleteWorktree(w.ctx, status, false), { code: "worktree_has_changes", message: /1 commit that exist/ });
  assert.ok(existsSync(w.abs));
  const result = await deleteWorktree(w.ctx, status, true);
  assert.equal(result.branchDeleted, `floq/${w.id}`);
  assert.deepEqual(await f.branches(), ["main"]);
});

test("pushed commits are not at risk; the branch is kept if Git will not delete it safely", async (t) => {
  const f = await fixture(t, { remote: true });
  const w = await f.addWorktree();
  writeFileSync(join(w.abs, "work.txt"), "work\n");
  await git(w.abs, ["add", "."]);
  await git(w.abs, ["commit", "-m", "wip"]);
  await git(w.abs, ["push", "origin", `floq/${w.id}`]);
  const status = await inspectWorktree(w.ctx);
  assert.equal(status.unsavedCommits, 0);
  assert.equal(status.unpushedCommits, 0);
  assert.equal(status.commitsNotOnBase, 1);
  const result = await deleteWorktree(w.ctx, status, false);
  assert.equal(existsSync(w.abs), false);
  // `git branch -d` refuses (not merged into HEAD); the local branch is kept, never force-deleted, and the remote is untouched.
  assert.equal(result.branchDeleted, null);
  assert.match(result.branchNote, /kept/);
  assert.ok((await f.branches()).includes(`floq/${w.id}`));
  assert.match(await git(f.repo, ["ls-remote", "--heads", "origin"]), new RegExp(`floq/${w.id}`));
});

test("a worktree already removed from disk is cleaned up from Git metadata", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  rmSync(w.abs, { recursive: true, force: true });
  const status = await inspectWorktree(w.ctx);
  assert.equal(status.missing, true);
  const result = await deleteWorktree(w.ctx, status, false);
  assert.equal(result.alreadyGone, true);
  assert.equal(result.branchDeleted, `floq/${w.id}`);
  assert.doesNotMatch(await git(f.repo, ["worktree", "list", "--porcelain"]), new RegExp(w.id));
  // Gone from disk and unknown to Git: nothing to do, no error.
  const again = await inspectWorktree(w.ctx);
  assert.equal(again.missing, true);
  assert.deepEqual(await deleteWorktree(w.ctx, again, false), { alreadyGone: true, branchDeleted: null, branchNote: null });
});

test("a detached worktree deletes no branch, and a protected branch named like Floq's is kept", async (t) => {
  const f = await fixture(t);
  const detached = await f.addWorktree({ detach: true });
  const status = await inspectWorktree(detached.ctx);
  assert.equal(status.branch, null);
  assert.equal(status.floqBranch, null);
  await deleteWorktree(detached.ctx, status, false);
  assert.deepEqual(await f.branches(), ["main"]);

  // The primary checkout itself is on floq/<id> (a name collision): that branch is checked out elsewhere and must stay.
  const id = randomUUID();
  await git(f.repo, ["switch", "-c", `floq/${id}`]);
  await git(f.repo, ["worktree", "add", "--detach", "--", join(f.home, ".floq", "worktrees", id)]);
  const ctx = { home: f.home, projectCwd: "repo", cwd: `.floq/worktrees/${id}`, run: f.run };
  const collision = await inspectWorktree(ctx);
  assert.equal(collision.floqBranch, null);
  await deleteWorktree(ctx, collision, true);
  assert.ok((await f.branches()).includes(`floq/${id}`));
});

test("a user-created branch checked out in the worktree is kept", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree({ branch: "feature/mine" });
  const status = await inspectWorktree(w.ctx);
  assert.equal(status.floqBranch, null);
  const result = await deleteWorktree(w.ctx, status, false);
  assert.equal(result.branchDeleted, null);
  assert.match(result.branchNote, /feature\/mine was not created by Floq/);
  assert.equal(existsSync(w.abs), false);
  assert.deepEqual(await f.branches(), ["feature/mine", "main"]);
});

function managerFor(f, { rows, sessions = [], updates = [], live = new Map() }) {
  const manager = Object.create(SessionManager.prototype);
  manager.projectBranchLocks = new Map();
  manager.live = live;
  manager.pool = { async query(sql, values) {
    if (sql.includes("SELECT w.cwd,w.is_worktree")) return { rows: rows.filter((r) => r.user === values[2] && r.id === values[0] && r.project === values[1]) };
    if (sql.includes("FROM agent_sessions WHERE user_id=$1 AND workspace_id=$2")) return { rows: sessions };
    if (sql.startsWith("UPDATE floq_project_workspaces SET available=FALSE")) { updates.push(values); return { rows: [] }; }
    assert.fail(`Unexpected manager query: ${sql}`);
  } };
  manager.withShardActivity = (_userId, operation) => operation();
  manager.shards = {
    driver: {
      name: "local",
      homePath: () => f.home,
      spawn: (_handle, spec) => {
        const child = spawnChild(spec.file, spec.args, { cwd: join(f.home, spec.cwd), env: spec.env, windowsHide: true });
        const data = new Set(); const exit = new Set();
        child.stdout.on("data", (c) => { for (const l of data) l(c.toString()); });
        child.stderr.on("data", (c) => { for (const l of data) l(c.toString()); });
        child.on("close", (code) => { for (const l of exit) l({ exitCode: code ?? 1 }); });
        return { onData: (l) => { data.add(l); return { dispose: () => data.delete(l) }; }, onExit: (l) => { exit.add(l); return { dispose: () => exit.delete(l) }; }, kill: (s) => child.kill(s) };
      },
    },
    async wake() { return { userId: "user-a", uid: 1000, mountPath: f.home }; },
  };
  manager.assertLifecycleOpen = () => {};
  return manager;
}

test("manager: foreign users get 404, primary workspaces are refused, nothing is touched", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  const rows = [
    { id: "ws-wt", project: "proj", user: "user-a", cwd: w.cwd, is_worktree: true, project_cwd: "repo" },
    { id: "ws-main", project: "proj", user: "user-a", cwd: "repo", is_worktree: false, project_cwd: "repo" },
  ];
  const manager = managerFor(f, { rows });
  await assert.rejects(manager.deleteWorktree("user-b", "proj", "ws-wt", false), { status: 404 });
  await assert.rejects(manager.worktreeDeleteStatus("user-b", "proj", "ws-wt"), { status: 404 });
  await assert.rejects(manager.deleteWorktree("user-a", "other-project", "ws-wt", false), { status: 404 });
  await assert.rejects(manager.deleteWorktree("user-a", "proj", "ws-main", true), { code: "primary_workspace" });
  assert.ok(existsSync(w.abs));
});

test("manager: a live session blocks deletion by name; sleeping ones do not, and the row is marked unavailable", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  const rows = [{ id: "ws-wt", project: "proj", user: "user-a", cwd: w.cwd, is_worktree: true, project_cwd: "repo" }];
  const updates = [];
  const running = [{ id: "s1", title: "Builder", state: "running" }, { id: "s2", title: "Old", state: "sleeping" }];
  await assert.rejects(managerFor(f, { rows, sessions: running, updates }).deleteWorktree("user-a", "proj", "ws-wt", true), { code: "worktree_agents_active", message: /"Builder"/ });
  // Live in memory even if the stored state says sleeping.
  const liveMap = new Map([["s2", { isAlive: true }]]);
  await assert.rejects(managerFor(f, { rows, sessions: [running[1]], updates, live: liveMap }).deleteWorktree("user-a", "proj", "ws-wt", false), { code: "worktree_agents_active" });
  assert.ok(existsSync(w.abs));
  assert.equal(updates.length, 0);

  const idle = [{ id: "s2", title: "Old", state: "sleeping" }, { id: "s3", title: "Done", state: "exited" }];
  const manager = managerFor(f, { rows, sessions: idle, updates });
  const status = await manager.worktreeDeleteStatus("user-a", "proj", "ws-wt");
  assert.equal(status.sessions.idle, 2);
  assert.equal(status.sessions.live.length, 0);
  assert.equal(status.floqBranch, `floq/${w.id}`);
  assert.equal("removeArg" in status, false);
  const result = await manager.deleteWorktree("user-a", "proj", "ws-wt", false);
  assert.equal(result.idleSessions, 2);
  assert.equal(result.branchDeleted, `floq/${w.id}`);
  assert.deepEqual(updates, [["ws-wt", "proj", "user-a"]]);
  assert.equal(existsSync(w.abs), false);
});

test("manager: server-side recheck refuses dirty state even if the dialog was stale", async (t) => {
  const f = await fixture(t);
  const w = await f.addWorktree();
  const rows = [{ id: "ws-wt", project: "proj", user: "user-a", cwd: w.cwd, is_worktree: true, project_cwd: "repo" }];
  const updates = [];
  const manager = managerFor(f, { rows, updates });
  assert.equal((await manager.worktreeDeleteStatus("user-a", "proj", "ws-wt")).uncommittedFiles, 0);
  writeFileSync(join(w.abs, "late.txt"), "written after the dialog opened\n");
  await assert.rejects(manager.deleteWorktree("user-a", "proj", "ws-wt", false), { code: "worktree_has_changes" });
  assert.ok(existsSync(join(w.abs, "late.txt")));
  assert.equal(updates.length, 0);
  await manager.deleteWorktree("user-a", "proj", "ws-wt", true);
  assert.equal(existsSync(w.abs), false);
  assert.equal(updates.length, 1);
});

test("resuming a session whose worktree was deleted is refused with a clear message", async () => {
  const manager = Object.create(SessionManager.prototype);
  manager.live = new Map();
  manager.assertLifecycleOpen = () => {};
  manager.row = async () => ({ id: "s1", workspace_id: "ws-gone" });
  manager.pool = { async query(sql, values) {
    assert.match(sql, /is_worktree=TRUE AND available=FALSE/);
    assert.deepEqual(values, ["ws-gone", "user-a"]);
    return { rows: [{ "?column?": 1 }] };
  } };
  await assert.rejects(manager.resumeOnce("user-a", {}, "s1"), { status: 409, code: "worktree_deleted" });
});
