import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProjectBranchSwitch, listProjectBranches, switchProjectBranch } from "../dist/projectBranches.js";
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
      return { stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`, exitCode: error.code ?? 1 };
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

test("refuses invalid branches", async (t) => {
  const { run } = await makeRepo(t);
  await assert.rejects(switchProjectBranch(run, "missing"), { code: "invalid_branch" });
});

test("a dirty tree switches and the changes travel with the user", async (t) => {
  const { repo, run } = await makeRepo(t);
  writeFileSync(join(repo, "tracked.txt"), "changed\n");
  writeFileSync(join(repo, "untracked.txt"), "keep me\n");
  assert.equal(await switchProjectBranch(run, "feature"), "feature");
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "feature");
  assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "changed\n");
  assert.equal(readFileSync(join(repo, "untracked.txt"), "utf8"), "keep me\n");
});

test("a conflicting change is refused by git with file names and leaves the tree untouched", async (t) => {
  const { repo, run } = await makeRepo(t);
  await git(repo, ["switch", "feature"]);
  writeFileSync(join(repo, "tracked.txt"), "feature version\n");
  await git(repo, ["commit", "-am", "feature change"]);
  await git(repo, ["switch", "main"]);
  writeFileSync(join(repo, "tracked.txt"), "local work\n");
  await assert.rejects(switchProjectBranch(run, "feature"), (error) => error.code === "project_branch_switch_conflict" && /tracked\.txt/.test(error.message));
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "main");
  assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "local work\n");
});

test("an untracked file that would be overwritten is refused by git and kept", async (t) => {
  const { repo, run } = await makeRepo(t);
  await git(repo, ["switch", "feature"]);
  writeFileSync(join(repo, "new.txt"), "from feature\n");
  await git(repo, ["add", "new.txt"]);
  await git(repo, ["commit", "-m", "add new"]);
  await git(repo, ["switch", "main"]);
  writeFileSync(join(repo, "new.txt"), "mine\n");
  await assert.rejects(switchProjectBranch(run, "feature"), (error) => error.code === "project_branch_switch_conflict" && /new\.txt/.test(error.message));
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "main");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "mine\n");
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

function managerFor(root, queries) {
  const handle = { userId: "user-a", uid: 1000, mountPath: root };
  const manager = Object.create(SessionManager.prototype);
  manager.projectBranchLocks = new Map();
  manager.pool = { async query(sql, values) {
    queries.push(sql);
    if (sql.includes("SELECT w.cwd,p.cwd AS project_cwd")) return { rows: [{ cwd: "repo", project_cwd: "repo" }] };
    if (sql.includes("UPDATE floq_project_workspaces")) return { rows: [{ id: "workspace-a" }] };
    assert.fail(`Unexpected manager query: ${sql}`);
  } };
  manager.withShardActivity = (_userId, operation) => operation();
  manager.shards = {
    driver: { name: "local", homePath: () => root, spawn: (_h, spec) => spawnCommand(spec.file, spec.args, { cwd: join(root, spec.cwd), env: spec.env }) },
    async wake() { return handle; },
  };
  manager.assertLifecycleOpen = () => {};
  manager.project = async () => ({ id: "project-a", workspaces: [] });
  return manager;
}

test("manager switches with live agents without touching sessions", async (t) => {
  const { root, repo } = await makeRepo(t);
  const queries = [];
  const manager = managerFor(root, queries);
  await manager.switchProjectBranch("user-a", "project-a", "workspace-a", "feature");
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "feature");
  assert.ok(!queries.some((sql) => sql.includes("agent_sessions")), "must not consult or modify sessions");
});

test("dry-run pre-flight only checks what is knowable and changes nothing", async (t) => {
  const { root, repo } = await makeRepo(t);
  const queries = [];
  const manager = managerFor(root, queries);
  assert.deepEqual(await manager.checkProjectBranchSwitch("user-a", "project-a", "workspace-a", "feature"), { ok: true, needsSwitch: true });
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "main");
  await assert.rejects(manager.checkProjectBranchSwitch("user-a", "project-a", "workspace-a", "missing"), { code: "invalid_branch" });
  writeFileSync(join(repo, "tracked.txt"), "changed\n");
  assert.deepEqual(await manager.checkProjectBranchSwitch("user-a", "project-a", "workspace-a", "feature"), { ok: true, needsSwitch: true });
  assert.equal((await git(repo, ["branch", "--show-current"])).trim(), "main");
  assert.ok(!queries.some((sql) => sql.includes("agent_sessions") || sql.includes("UPDATE")), "no session or workspace writes");
  assert.deepEqual(await checkProjectBranchSwitch(async (args) => ({ stdout: args[0] === "for-each-ref" ? "main\n" : "main\n", exitCode: 0 }), "main"), { branch: "main", needsSwitch: false });
});
