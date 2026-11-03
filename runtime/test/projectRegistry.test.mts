import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "../dist/manager.js";

function fakeManager(home) {
  const projects = [];
  const workspaces = [];
  const queries = [];
  const pool = {
    async query(sql, values = []) {
      queries.push(sql);
      if (sql.includes("SELECT id FROM floq_projects WHERE user_id=$1 AND normalized_git_url=$2")) {
        const row = projects.find((p) => p.user_id === values[0] && p.normalized_git_url === values[1]);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (sql.includes("SELECT * FROM floq_projects WHERE user_id=$1 ORDER BY created_at DESC")) {
        return { rows: projects.filter((p) => p.user_id === values[0]) };
      }
      if (sql.includes("FROM floq_project_workspaces w LEFT JOIN")) {
        return { rows: workspaces.filter((w) => w.user_id === values[0]).map((w) => ({ ...w, session_ids: w.session_ids ?? [] })) };
      }
      if (sql.startsWith("UPDATE floq_project_workspaces AS w SET branch=")) {
        const row = workspaces.find((w) => w.id === values[1] && w.user_id === values[2]);
        if (row) {
          row.branch = values[0];
          row.available = true;
          row.name = values[0] === null ? "Detached HEAD" : row.cwd === projects.find((p) => p.id === row.project_id)?.cwd ? "Main" : "Worktree";
        }
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE floq_project_workspaces SET available=FALSE")) {
        const row = workspaces.find((w) => w.id === values[0] && w.user_id === values[1]);
        if (row) row.available = false;
        return { rows: [] };
      }
      throw new Error("Unexpected fake query: " + sql);
    },
    async connect() {
      return {
        async query(sql, values = []) {
          queries.push(sql);
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
          if (sql.startsWith("INSERT INTO floq_projects")) {
            const duplicate = projects.some((p) => p.user_id === values[1] && p.normalized_git_url === values[4]);
            if (duplicate) return { rows: [] };
            projects.push({ id: values[0], user_id: values[1], name: values[2], git_url: values[3], normalized_git_url: values[4], cwd: values[5], created_at: new Date() });
            return { rows: [{ id: values[0] }] };
          }
          if (sql.includes("SELECT id FROM floq_projects") && sql.includes("FOR UPDATE")) {
            const row = projects.find((p) => p.user_id === values[0] && p.normalized_git_url === values[1]);
            return { rows: row ? [{ id: row.id }] : [] };
          }
          if (sql.startsWith("INSERT INTO floq_project_workspaces")) {
            workspaces.push({ id: values[0], user_id: values[1], project_id: values[2], cwd: values[3], name: "Main", branch: values[4], is_worktree: false, created_at: new Date() });
            return { rows: [] };
          }
          throw new Error("Unexpected fake transaction query: " + sql);
        },
        release() {},
      };
    },
  };
  const handle = { mountPath: home, uid: 0 };
  const manager = Object.create(SessionManager.prototype);
  Object.assign(manager, {
    pool,
    projectCreates: new Map(),
    lifecycle: { assertOpen() {} },
    shardActivityCounts: new Map(),
    shardActivities: new Set(),
    live: new Map(),
    stoppingSessions: new Map(),
    intentionalSleep: new Set(),
    lockTimers: new Map(),
    shuttingDown: false,
    shards: { driver: { name: "local", hostPath: (_handle, rel) => resolve(home, rel) }, wake: async () => handle, awakeHandle: () => null },
    cancelLock() {},
    scheduleLock() {},
    clone: async (_url, destination) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      mkdirSync(destination);
      mkdirSync(join(destination, ".git"));
      writeFileSync(join(destination, ".git", "HEAD"), "ref: refs/heads/main\n");
    },
  });
  return { manager, projects, workspaces, queries };
}

test("repository import clones before returning a persistent selectable project and deduplicates concurrent requests", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    mkdirSync(join(home, ".floq", "projects"), { recursive: true });
    const { manager, projects, workspaces } = fakeManager(home);
    let clones = 0;
    const originalClone = manager.clone;
    manager.clone = async (...args) => { clones++; return originalClone(...args); };
    const [first, concurrent] = await Promise.all([
      manager.createProject("user-a", {}, "https://example.test/organization/repo.git"),
      manager.createProject("user-a", {}, "https://example.test/organization/repo.git"),
    ]);
    assert.equal(clones, 1);
    assert.equal(first.id, concurrent.id);
    assert.equal(projects.length, 1);
    assert.equal(workspaces.length, 1);
    assert.equal(first.workspaces[0].branch, "main");
    assert.equal(first.workspaces[0].cwd, first.cwd);
    assert.equal(readFileSync(join(home, first.cwd, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/main");

    const duplicate = await manager.createProject("user-a", {}, "https://EXAMPLE.test/organization/repo");
    assert.equal(duplicate.id, first.id);
    assert.equal(clones, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("repository identity and visibility stay scoped to the authenticated user", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    mkdirSync(join(home, ".floq", "projects"), { recursive: true });
    const { manager } = fakeManager(home);
    const a = await manager.createProject("user-a", {}, "https://example.test/organization/repo.git");
    const b = await manager.createProject("user-b", {}, "https://example.test/organization/repo.git");
    assert.notEqual(a.id, b.id);
    assert.equal((await manager.listProjects("user-a")).length, 1);
    assert.equal((await manager.listProjects("user-b")).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("repository URLs with embedded HTTPS credentials are rejected before clone", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    mkdirSync(join(home, ".floq", "projects"), { recursive: true });
    const { manager } = fakeManager(home);
    await assert.rejects(manager.createProject("user-a", {}, "https://token@example.test/organization/repo.git"), { code: "invalid_git_url" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listing projects refreshes changed branches and detached HEADs for an awake shard", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    const { manager, projects, workspaces, queries } = fakeManager(home);
    const projectId = "00000000-0000-4000-8000-000000000001";
    projects.push({ id: projectId, user_id: "user-a", name: "repo", cwd: "workspace/repo", created_at: new Date() });
    const entries = [
      { id: "00000000-0000-4000-8000-000000000002", cwd: "workspace/repo", head: "ref: refs/heads/feature/fix\n", branch: "old", name: "Main", is_worktree: false },
      { id: "00000000-0000-4000-8000-000000000003", cwd: "workspace/other", head: `${"a".repeat(40)}\n`, branch: "old", name: "Worktree", is_worktree: true },
    ];
    for (const entry of entries) {
      mkdirSync(join(home, entry.cwd, ".git"), { recursive: true });
      writeFileSync(join(home, entry.cwd, ".git", "HEAD"), entry.head);
      workspaces.push({ id: entry.id, user_id: "user-a", project_id: projectId, cwd: entry.cwd, name: entry.name, branch: entry.branch, is_worktree: entry.is_worktree, created_at: new Date() });
    }
    manager.shards.awakeHandle = () => ({ mountPath: home, uid: 0 });

    const listed = await manager.listProjects("user-a");

    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].workspaces.map(({ name, branch }) => ({ name, branch })), [
      { name: "Main", branch: "feature/fix" },
      { name: "Detached HEAD", branch: null },
    ]);
    const branchUpdates = queries.filter((sql) => sql.startsWith("UPDATE floq_project_workspaces AS w SET branch="));
    assert.equal(branchUpdates.length, 2);
    assert.match(branchUpdates[0], /branch=\$1::text/);
    assert.match(branchUpdates[0], /WHEN \$1::text IS NULL/);
    assert.deepEqual(workspaces.map(({ name, branch }) => ({ name, branch })), listed[0].workspaces.map(({ name, branch }) => ({ name, branch })));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listing an awake shard omits removed worktrees without deleting workspace or session history", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    const { manager, projects, workspaces, queries } = fakeManager(home);
    const projectId = "00000000-0000-4000-8000-000000000011";
    projects.push({ id: projectId, user_id: "user-a", name: "repo", cwd: "workspace/repo", created_at: new Date() });
    workspaces.push(
      { id: "00000000-0000-4000-8000-000000000012", user_id: "user-a", project_id: projectId, cwd: "workspace/repo", name: "Main", branch: "main", is_worktree: false, session_ids: [] },
      { id: "00000000-0000-4000-8000-000000000013", user_id: "user-a", project_id: projectId, cwd: ".floq/worktrees/removed", name: "Worktree", branch: "floq/removed", is_worktree: true, session_ids: ["old-agent-session"] },
    );
    // A partially unavailable primary checkout remains in the inventory; only isolated
    // worktree rows are eligible for omission.
    manager.shards.awakeHandle = () => ({ mountPath: home, uid: 0 });

    const first = await manager.listProjects("user-a");
    const second = await manager.listProjects("user-a");

    assert.deepEqual(first[0].workspaces.map((w) => w.id), ["00000000-0000-4000-8000-000000000012"]);
    assert.deepEqual(second[0].workspaces.map((w) => w.id), ["00000000-0000-4000-8000-000000000012"]);
    assert.equal(workspaces.length, 2, "the stale workspace row remains available for recovery");
    assert.deepEqual(workspaces[1].session_ids, ["old-agent-session"], "session history is untouched");
    assert.equal(workspaces[1].available, false, "confirmed stale worktrees are durably marked unavailable");
    assert.equal(queries.some((sql) => sql.startsWith("DELETE FROM agent_sessions")), false);
    assert.equal(queries.some((sql) => sql.startsWith("DELETE FROM floq_project_workspaces")), false);
    manager.shards.awakeHandle = () => undefined;
    const afterLock = await manager.listProjects("user-a");
    assert.deepEqual(afterLock[0].workspaces.map((w) => w.id), ["00000000-0000-4000-8000-000000000012"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listing a sleeping shard retains worktrees that may be hidden by its locked mount", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    const { manager, projects, workspaces, queries } = fakeManager(home);
    const projectId = "00000000-0000-4000-8000-000000000021";
    projects.push({ id: projectId, user_id: "user-a", name: "repo", cwd: "workspace/repo", created_at: new Date() });
    workspaces.push({ id: "00000000-0000-4000-8000-000000000022", user_id: "user-a", project_id: projectId, cwd: ".floq/worktrees/possibly-locked", name: "Worktree", branch: "feature", is_worktree: true, session_ids: [] });
    manager.shards.awakeHandle = () => undefined;

    const listed = await manager.listProjects("user-a");

    assert.deepEqual(listed[0].workspaces.map((w) => w.id), ["00000000-0000-4000-8000-000000000022"]);
    assert.equal(queries.some((sql) => sql.startsWith("DELETE FROM floq_project_workspaces")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listing an awake shard restores a worktree after its registered checkout reappears", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    const { manager, projects, workspaces } = fakeManager(home);
    const projectId = "00000000-0000-4000-8000-000000000031";
    const workspaceId = "00000000-0000-4000-8000-000000000032";
    projects.push({ id: projectId, user_id: "user-a", name: "repo", cwd: "workspace/repo", created_at: new Date() });
    workspaces.push({ id: workspaceId, user_id: "user-a", project_id: projectId, cwd: ".floq/worktrees/restored", name: "Worktree", branch: "old", is_worktree: true, available: false, created_at: new Date() });
    manager.shards.awakeHandle = () => ({ mountPath: home, uid: 0 });
    assert.deepEqual((await manager.listProjects("user-a"))[0].workspaces, []);

    mkdirSync(join(home, ".floq", "worktrees", "restored", ".git"), { recursive: true });
    writeFileSync(join(home, ".floq", "worktrees", "restored", ".git", "HEAD"), "ref: refs/heads/feature/restored\n");
    const restored = await manager.listProjects("user-a");

    assert.deepEqual(restored[0].workspaces.map((w) => [w.id, w.branch]), [[workspaceId, "feature/restored"]]);
    assert.equal(workspaces[0].available, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a response failure after commit preserves the checkout and retry returns it without recloning", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    mkdirSync(join(home, ".floq", "projects"), { recursive: true });
    const { manager, projects } = fakeManager(home);
    let clones = 0;
    let failResponse = true;
    const originalClone = manager.clone;
    const originalProject = manager.project;
    manager.clone = async (...args) => { clones++; return originalClone(...args); };
    manager.project = async (...args) => {
      if (failResponse) { failResponse = false; throw new Error("simulated project response failure"); }
      return originalProject.apply(manager, args);
    };

    await assert.rejects(manager.createProject("user-a", {}, "https://example.test/organization/repo.git"), /simulated project response failure/);
    assert.equal(projects.length, 1, "database commit remains durable after response load fails");
    const cwd = projects[0].cwd;
    assert.equal(readFileSync(join(home, cwd, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/main");

    const retry = await manager.createProject("user-a", {}, "https://example.test/organization/repo.git");
    assert.equal(retry.id, projects[0].id);
    assert.equal(clones, 1, "retry reuses the committed checkout");
    assert.equal(readFileSync(join(home, cwd, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/main");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a symlinked project storage parent is rejected before clone", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  const outside = mkdtempSync(join(tmpdir(), "floq-projects-outside-"));
  try {
    symlinkSync(outside, join(home, ".floq"), "junction");
    const { manager } = fakeManager(home);
    let clones = 0;
    const originalClone = manager.clone;
    manager.clone = async (...args) => { clones++; return originalClone(...args); };
    await assert.rejects(manager.createProject("user-a", {}, "https://example.test/organization/repo.git"), { code: "unsafe_project_path" });
    assert.equal(clones, 0, "the unsafe parent is rejected before invoking clone");
    assert.deepEqual((await import("node:fs")).readdirSync(outside), [], "no project data is written outside the shard");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("project clone holds a real shard activity until completion and schedules locking afterward", async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-projects-"));
  try {
    mkdirSync(join(home, ".floq", "projects"), { recursive: true });
    const { manager } = fakeManager(home);
    let clones = 0;
    let releaseClone;
    const cloneGate = new Promise((resolvePromise) => { releaseClone = resolvePromise; });
    manager.config = { shardLockDelayMs: 5 };
    manager.cancelLock = SessionManager.prototype.cancelLock;
    manager.scheduleLock = SessionManager.prototype.scheduleLock;
    manager.shards.sleep = async () => { clones++; };
    manager.clone = async (_url, destination) => {
      await cloneGate;
      mkdirSync(destination);
      mkdirSync(join(destination, ".git"));
      writeFileSync(join(destination, ".git", "HEAD"), "ref: refs/heads/main\n");
    };

    const creating = manager.createProject("user-a", {}, "https://example.test/organization/repo.git");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.equal(clones, 0, "real idle lock timer does not sleep the shard during clone");
    assert.equal(manager.shardActivityCounts.get("user-a"), 1);
    releaseClone();
    await creating;
    assert.equal(manager.shardActivityCounts.has("user-a"), false, "activity is released after registration and response load");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.equal(clones, 1, "real lock timer runs after the clone operation completes");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
