import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectBranches, switchProjectBranch } from "../dist/projectBranches.js";
import { SessionManager } from "../dist/manager.js";

const execFile = promisify(execFileCallback);

function spawnCommand(file, args, options) {
  const child = spawnChild(file, args, { cwd: options.cwd, env: options.env, windowsHide: true });
  const dataListeners = new Set();
  const exitListeners = new Set();
  child.stdout.on("data", (chunk) => { for (const listener of dataListeners) listener(chunk.toString()); });
  child.stderr.on("data", (chunk) => { for (const listener of dataListeners) listener(chunk.toString()); });
  child.on("close", (exitCode) => { for (const listener of exitListeners) listener({ exitCode: exitCode ?? 1 }); });
  return {
    onData(listener) { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
    onExit(listener) { exitListeners.add(listener); return { dispose: () => exitListeners.delete(listener) }; },
    kill(signal) { child.kill(signal); },
  };
}

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  return stdout;
}

async function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), `floq-branches-${process.pid}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "Floq Tests"]);
  await git(repo, ["config", "user.email", "floq-test@example.invalid"]);
  writeFileSync(join(repo, "tracked.txt"), "clean\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "feature"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = async (args) => {
    try {
      const { stdout } = await execFile("git", ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "core.fsmonitor=false", ...args], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      });
      return { stdout, exitCode: 0 };
    } catch (error) {
      return { stdout: error.stdout ?? "", exitCode: error.code ?? 1 };
    }
  };
  return { root, repo, run };
}

test("lists only local branches and switches clean worktrees", async (t) => {
  const { run } = await makeRepo(t);
  assert.deepEqual(await listProjectBranches(run), { currentBranch: "main", branches: ["feature", "main"] });
  assert.equal(await switchProjectBranch(run, "feature"), "feature");
  assert.deepEqual(await listProjectBranches(run), { currentBranch: "feature", branches: ["feature", "main"] });
});

test("refuses invalid branches and preserves tracked and untracked dirty work", async (t) => {
  const { repo, run } = await makeRepo(t);
  await assert.rejects(switchProjectBranch(run, "missing"), { code: "invalid_branch" });
  writeFileSync(join(repo, "tracked.txt"), "changed\n");
  await assert.rejects(switchProjectBranch(run, "feature"), { code: "project_worktree_dirty" });
  writeFileSync(join(repo, "tracked.txt"), "clean\n");
  writeFileSync(join(repo, "untracked.txt"), "keep me\n");
  await assert.rejects(switchProjectBranch(run, "feature"), { code: "project_worktree_dirty" });
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "main");
});

test("refuses a branch checked out by a second worktree", async (t) => {
  const { root, run, repo } = await makeRepo(t);
  await git(repo, ["worktree", "add", join(root, "other"), "feature"]);
  await assert.rejects(switchProjectBranch(run, "feature"), { code: "project_branch_in_use" });
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "main");
});

test("registered workspace lookup is scoped to project and authenticated owner", async () => {
  const manager = Object.create(SessionManager.prototype);
  manager.pool = { async query(_sql, values) {
    assert.deepEqual(values, ["workspace-other-user", "project-a", "user-a"]);
    return { rows: [] };
  } };
  manager.withShardActivity = (_userId, operation) => operation();
  manager.shards = { async wake() { assert.fail("unauthorized lookup must not wake a shard"); } };
  await assert.rejects(manager.projectBranches("user-a", "project-a", "workspace-other-user"), { status: 404 });
});

test("manager switches only a registered owner's workspace and refreshes its project", async (t) => {
  const { root, repo } = await makeRepo(t);
  const handle = { userId: "user-a", uid: 1000, mountPath: root };
  let persistedBranch = "main";
  const manager = Object.create(SessionManager.prototype);
  manager.projectBranchLocks = new Map();
  manager.pool = { async query(sql, values) {
    if (sql.includes("SELECT w.cwd,p.cwd AS project_cwd")) {
      assert.deepEqual(values, ["workspace-a", "project-a", "user-a"]);
      return { rows: [{ cwd: "repo", project_cwd: "repo" }] };
    }
    if (sql.includes("SELECT id FROM agent_sessions")) return { rows: [] };
    if (sql.includes("UPDATE floq_project_workspaces")) {
      assert.deepEqual(values, ["feature", "Main", "workspace-a", "project-a", "user-a"]);
      persistedBranch = values[0];
      return { rows: [{ id: "workspace-a" }] };
    }
    assert.fail(`Unexpected manager query: ${sql}`);
  } };
  manager.withShardActivity = (_userId, operation) => operation();
  manager.shards = {
    driver: {
      name: "local",
      homePath: () => root,
      spawn: (_handle, spec) => spawnCommand(spec.file, spec.args, { cwd: join(root, spec.cwd), env: spec.env }),
    },
    async wake(userId) { assert.equal(userId, "user-a"); return handle; },
  };
  manager.assertLifecycleOpen = () => {};
  manager.project = async () => ({ id: "project-a", workspaces: [{ id: "workspace-a", branch: persistedBranch }] });
  const result = await manager.switchProjectBranch("user-a", "project-a", "workspace-a", "feature");
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "feature");
  assert.equal(result.workspaces[0].branch, "feature");
});

test("manager refuses branch changes while an agent is active in the project", async (t) => {
  const { root } = await makeRepo(t);
  const handle = { userId: "user-a", uid: 1000, mountPath: root };
  const manager = Object.create(SessionManager.prototype);
  manager.projectBranchLocks = new Map();
  manager.pool = { async query(sql) {
    if (sql.includes("SELECT w.cwd,p.cwd AS project_cwd")) return { rows: [{ cwd: "repo", project_cwd: "repo" }] };
    if (sql.includes("SELECT id FROM agent_sessions")) return { rows: [{ id: "agent-a" }] };
    assert.fail(`Unexpected manager query: ${sql}`);
  } };
  manager.withShardActivity = (_userId, operation) => operation();
  manager.shards = {
    driver: {
      name: "local",
      homePath: () => root,
      spawn: (_handle, spec) => spawnCommand(spec.file, spec.args, { cwd: join(root, spec.cwd), env: spec.env }),
    },
    async wake() { return handle; },
  };
  manager.assertLifecycleOpen = () => {};
  await assert.rejects(manager.switchProjectBranch("user-a", "project-a", "workspace-a", "feature"), { code: "project_agents_active" });
  assert.equal((await git(join(root, "repo"), ["branch", "--show-current"])).trim(), "main");
});
