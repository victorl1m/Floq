import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { SessionManager } from "../dist/manager.js";
import { planCheckouts, removeManagedCheckout } from "../dist/projectDelete.js";

const execFile = promisify(execFileCallback);
const NULL = process.platform === "win32" ? "NUL" : "/dev/null";
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL, GIT_TERMINAL_PROMPT: "0" };
const U1 = "user-1";
const U2 = "user-2";

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFile("git", args, { cwd, env: ENV });
  return stdout.trim();
}

/** A directory symlink that works without privileges on Windows (junction). */
function dirLink(target: string, link: string) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function setup(t: test.TestContext) {
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id) VALUES ('${U1}'), ('${U2}')`);
  const home = realpathSync(mkdtempSync(join(tmpdir(), `floq-projdel-${process.pid}-`)));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), `floq-projdel-outside-${process.pid}-`)));
  writeFileSync(join(outside, "precious.txt"), "do not delete\n");
  t.after(async () => { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); await db.close(); });

  const disposed: string[] = [];
  const handle = { mountPath: home, uid: 0 };
  const manager = Object.create(SessionManager.prototype) as any;
  Object.assign(manager, {
    pool,
    lifecycle: { assertOpen() {} },
    shardActivityCounts: new Map(),
    shardActivities: new Set(),
    projectBranchLocks: new Map(),
    live: new Map(),
    stoppingSessions: new Map(),
    intentionalSleep: new Set(),
    lockTimers: new Map(),
    shuttingDown: false,
    vault: { revokeSession() {} },
    shards: { driver: { name: "local", hostPath: (_h: unknown, rel: string) => resolve(home, rel) }, wake: async () => handle, awakeHandle: () => null },
    cancelLock() {},
    scheduleLock() {},
    runWorkspaceGit: async (_h: unknown, cwd: string, args: string[]) => {
      try {
        const { stdout } = await execFile("git", ["-c", `core.hooksPath=${NULL}`, ...args], { cwd: join(home, cwd), env: ENV });
        return { stdout, exitCode: 0 };
      } catch (error: any) {
        return { stdout: (error.stdout ?? "") + (error.stderr ?? ""), exitCode: typeof error.code === "number" ? error.code : 1 };
      }
    },
  });

  /** Registers a project with a real git checkout at .floq/projects/<id> (optionally a worktree). */
  async function project(userId: string, name: string, options: { worktree?: boolean; cwd?: string; makeRepo?: boolean } = {}) {
    const id = randomUUID();
    const cwd = options.cwd ?? `.floq/projects/${id}`;
    const wsId = randomUUID();
    await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1,$2,$3,$4)`, [id, userId, name, cwd]);
    await db.query(`INSERT INTO floq_project_workspaces (id,user_id,project_id,cwd,name,branch,is_worktree) VALUES ($1,$2,$3,$4,'Main','main',false)`, [wsId, userId, id, cwd]);
    const abs = join(home, cwd);
    if (options.makeRepo !== false) {
      mkdirSync(abs, { recursive: true });
      await git(abs, ["init", "--initial-branch=main"]);
      await git(abs, ["config", "user.name", "T"]);
      await git(abs, ["config", "user.email", "t@example.invalid"]);
      writeFileSync(join(abs, "tracked.txt"), "x\n");
      await git(abs, ["add", "."]);
      await git(abs, ["commit", "-m", "init"]);
    }
    let worktree: { id: string; cwd: string; abs: string } | null = null;
    if (options.worktree) {
      const wid = randomUUID();
      const wcwd = `.floq/worktrees/${wid}`;
      mkdirSync(join(home, ".floq", "worktrees"), { recursive: true });
      await git(abs, ["worktree", "add", "-b", `floq/${wid}`, "--", join(home, wcwd)]);
      await db.query(`INSERT INTO floq_project_workspaces (id,user_id,project_id,cwd,name,branch,is_worktree) VALUES ($1,$2,$3,$4,'Worktree',$5,true)`, [wid, userId, id, wcwd, `floq/${wid}`]);
      worktree = { id: wid, cwd: wcwd, abs: join(home, wcwd) };
    }
    return { id, cwd, abs, wsId, worktree };
  }
  async function session(userId: string, projectId: string | null, workspaceId: string | null, state = "sleeping") {
    const id = randomUUID();
    await db.query(`INSERT INTO agent_sessions (id,user_id,provider,title,cwd,state,cols,rows,project_id,workspace_id) VALUES ($1,$2,'claude','Agent','/w',$3,80,24,$4,$5)`, [id, userId, state, projectId, workspaceId]);
    return id;
  }
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]?.n ?? 0);
  return { db, manager, home, outside, project, session, count, disposed };
}

test("delete cascades the project, its sessions, canvas data and links, and removes only its own directories", async (t) => {
  const s = await setup(t);
  const a = await s.project(U1, "Alpha", { worktree: true });
  const b = await s.project(U1, "Beta");
  const sa1 = await s.session(U1, a.id, a.wsId, "running");
  const sa2 = await s.session(U1, a.id, a.worktree!.id);
  const sb = await s.session(U1, b.id, b.wsId);
  let disposed = 0;
  s.manager.live.set(sa1, { isAlive: true, dispose: () => { disposed += 1; } });

  const note = (await s.db.query(`INSERT INTO canvas_notes (user_id, project_id, text, x, y) VALUES ($1,$2,'n',0,0) RETURNING id`, [U1, a.id])).rows[0] as { id: string };
  await s.db.query(`INSERT INTO canvas_notes (user_id, project_id, text, x, y) VALUES ($1,$2,'keep',0,0)`, [U1, b.id]);
  await s.db.query(`INSERT INTO canvas_note_links (note_id, session_id, user_id) VALUES ($1,$2,$3)`, [note.id, sa1, U1]);
  const kc = (await s.db.query(`INSERT INTO keychains (user_id, project_id, name, x, y) VALUES ($1,$2,'kc',0,0) RETURNING id`, [U1, a.id])).rows[0] as { id: string };
  await s.db.query(`INSERT INTO keychain_secrets (keychain_id, user_id, name, value_enc) VALUES ($1,$2,'K','\\x00')`, [kc.id, U1]);
  await s.db.query(`INSERT INTO agent_links (project_id, from_session_id, to_session_id) VALUES ($1,$2,$3)`, [a.id, sa1, sb]); // cross-project link
  await s.db.query(`INSERT INTO agent_wired_memory (session_id,user_id,block,digest) VALUES ($1,$2,'b','d')`, [sa2, U1]);
  await s.db.query(`INSERT INTO agent_approvals (id,user_id,requester_session_id,target_session_id,requester_project_id,target_project_id,action,action_hash,status,expires_at) VALUES ('ap1',$1,$2,$3,$4,$5,'x','h','pending', now() + interval '1 hour')`, [U1, sa1, sb, a.id, b.id]);
  // folder layout that references both projects
  await s.db.query(`INSERT INTO user_project_folders (user_id, version, doc) VALUES ($1, 3, $2::jsonb)`, [U1, JSON.stringify({ folders: [{ id: "f1", name: "F" }], root: [{ kind: "folder", id: "f1" }, { kind: "project", id: b.id }], membership: { f1: [a.id] }, expanded: {} })]);

  const status = await s.manager.projectDeleteStatus(U1, a.id);
  assert.deepEqual({ total: status.sessions.total, live: status.sessions.live, notes: status.notes, keychains: status.keychains, worktrees: status.worktrees }, { total: 2, live: 1, notes: 1, keychains: 1, worktrees: 1 });
  assert.equal(status.dirtyWorktrees, 0);

  const result = await s.manager.deleteProject(U1, a.id);
  assert.equal(result.deleted, true);
  assert.equal(result.sessionsDeleted, 2);
  assert.equal(result.removedCheckouts, 2);
  assert.deepEqual(result.leftovers, []);
  assert.equal(disposed, 1, "live session stopped");
  assert.ok(s.manager.intentionalSleep.has(sa1));
  assert.equal(s.manager.live.has(sa1), false);

  assert.equal(await s.count(`SELECT count(*)::int AS n FROM floq_projects WHERE id=$1`, [a.id]), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM floq_project_workspaces WHERE project_id=$1`, [a.id]), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM agent_sessions WHERE id IN ($1,$2)`, [sa1, sa2]), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM canvas_notes WHERE project_id=$1`, [a.id]), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM canvas_note_links`), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM keychains WHERE project_id=$1`, [a.id]), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM keychain_secrets`), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM agent_links`), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM agent_wired_memory`), 0);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM agent_approvals`), 0);
  // The other project is untouched.
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM floq_projects WHERE id=$1`, [b.id]), 1);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM agent_sessions WHERE id=$1`, [sb]), 1);
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM canvas_notes WHERE project_id=$1`, [b.id]), 1);
  // Folder layout pruned and versioned.
  const folders = (await s.db.query(`SELECT version, doc FROM user_project_folders WHERE user_id=$1`, [U1])).rows[0] as { version: number; doc: { root: Array<{ id: string }>; membership: Record<string, string[]> } };
  assert.equal(folders.version, 4);
  assert.deepEqual(folders.doc.membership.f1, []);
  assert.deepEqual(folders.doc.root.map((e) => e.id), ["f1", b.id]);
  // Disk: A's directories gone, B's intact.
  assert.equal(existsSync(a.abs), false);
  assert.equal(existsSync(a.worktree!.abs), false);
  assert.ok(existsSync(join(b.abs, "tracked.txt")));
  assert.ok(existsSync(join(s.home, ".floq", "projects")));
});

test("another user's project is not found and nothing is removed", async (t) => {
  const s = await setup(t);
  const a = await s.project(U1, "Alpha");
  await assert.rejects(s.manager.deleteProject(U2, a.id), (e: any) => e.status === 404);
  await assert.rejects(s.manager.projectDeleteStatus(U2, a.id), (e: any) => e.status === 404);
  await assert.rejects(s.manager.deleteProject(U1, "not-a-uuid"), (e: any) => e.status === 404);
  await assert.rejects(s.manager.deleteProject(U1, randomUUID()), (e: any) => e.status === 404);
  assert.ok(existsSync(join(a.abs, "tracked.txt")));
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM floq_projects WHERE id=$1`, [a.id]), 1);
});

test("a symlink planted at the project path is unlinked, never followed outside the volume", async (t) => {
  const s = await setup(t);
  const a = await s.project(U1, "Alpha", { makeRepo: false });
  mkdirSync(join(s.home, ".floq", "projects"), { recursive: true });
  dirLink(s.outside, a.abs);
  const result = await s.manager.deleteProject(U1, a.id);
  assert.equal(result.deleted, true);
  assert.ok(existsSync(join(s.outside, "precious.txt")), "target of the link is untouched");
  assert.equal(existsSync(a.abs), false, "the link itself is gone");
});

test("a symlinked .floq/projects parent refuses to delete through it", async (t) => {
  const s = await setup(t);
  const a = await s.project(U1, "Alpha", { makeRepo: false });
  mkdirSync(join(s.outside, a.id));
  writeFileSync(join(s.outside, a.id, "precious.txt"), "keep\n");
  mkdirSync(join(s.home, ".floq"), { recursive: true });
  dirLink(s.outside, join(s.home, ".floq", "projects"));
  const result = await s.manager.deleteProject(U1, a.id);
  assert.equal(result.removedCheckouts, 0);
  assert.equal(result.leftovers.length, 1);
  assert.ok(existsSync(join(s.outside, a.id, "precious.txt")));
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM floq_projects WHERE id=$1`, [a.id]), 0, "database state is still removed");
});

test("symlinks inside a checkout are unlinked, not followed", async (t) => {
  const s = await setup(t);
  const a = await s.project(U1, "Alpha");
  dirLink(s.outside, join(a.abs, "escape"));
  await s.manager.deleteProject(U1, a.id);
  assert.equal(existsSync(a.abs), false);
  assert.ok(existsSync(join(s.outside, "precious.txt")));
});

test("checkouts outside Floq's managed directories are never deleted", async (t) => {
  const s = await setup(t);
  mkdirSync(join(s.home, "my-own-repo"));
  writeFileSync(join(s.home, "my-own-repo", "file.txt"), "mine\n");
  const a = await s.project(U1, "Legacy", { cwd: "my-own-repo", makeRepo: false });
  const status = await s.manager.projectDeleteStatus(U1, a.id);
  assert.equal(status.unmanagedCheckouts, 1);
  const result = await s.manager.deleteProject(U1, a.id);
  assert.deepEqual(result.leftovers.map((l: { path: string }) => l.path), ["my-own-repo"]);
  assert.ok(existsSync(join(s.home, "my-own-repo", "file.txt")));
});

test("dirty worktrees and the main checkout are detected before deletion", async (t) => {
  const s = await setup(t);
  const a = await s.project(U1, "Alpha", { worktree: true });
  writeFileSync(join(a.worktree!.abs, "tracked.txt"), "changed\n");
  writeFileSync(join(a.worktree!.abs, "new.txt"), "untracked\n");
  writeFileSync(join(a.abs, "scratch.txt"), "untracked\n");
  const status = await s.manager.projectDeleteStatus(U1, a.id);
  assert.equal(status.worktrees, 1);
  assert.equal(status.dirtyWorktrees, 1);
  assert.equal(status.dirtyMainCheckout, true);
  const wt = status.checkouts.find((c: { kind: string }) => c.kind === "worktree");
  assert.equal(wt.uncommittedFiles, 2);
  assert.equal(status.checkouts.find((c: { kind: string }) => c.kind === "project").uncommittedFiles, 1);
  // Status is read-only.
  assert.ok(existsSync(a.abs));
  assert.equal(await s.count(`SELECT count(*)::int AS n FROM floq_projects WHERE id=$1`, [a.id]), 1);
});

test("a non-Git managed project reports its files as deletable content without invoking Git", async (t) => {
  const s = await setup(t);
  const project = await s.project(U1, "Notes", { makeRepo: false });
  mkdirSync(project.abs, { recursive: true });
  mkdirSync(join(project.abs, "nested"));
  writeFileSync(join(project.abs, "readme.txt"), "keep track of this\n");
  writeFileSync(join(project.abs, "nested", "draft.md"), "draft\n");
  let gitCalls = 0;
  const originalGit = s.manager.runWorkspaceGit;
  s.manager.runWorkspaceGit = async (...args: unknown[]) => { gitCalls++; return originalGit(...args as [unknown, string, string[]]); };

  const status = await s.manager.projectDeleteStatus(U1, project.id);
  const main = status.checkouts.find((checkout: { kind: string }) => checkout.kind === "project");
  assert.equal(gitCalls, 0);
  assert.equal(main.state, "ok");
  assert.equal(main.uncommittedFiles, 2);
  assert.equal(status.dirtyMainCheckout, true);
  assert.equal(status.unreadableCheckouts, 0);
  assert.equal(existsSync(join(project.abs, "readme.txt")), true, "the status check is read-only");
});

test("a symlinked managed project parent is not scanned as plain project content", async (t) => {
  const s = await setup(t);
  const project = await s.project(U1, "Outside", { makeRepo: false });
  mkdirSync(join(s.outside, project.id), { recursive: true });
  writeFileSync(join(s.outside, project.id, "private.txt"), "outside data\n");
  mkdirSync(join(s.home, ".floq"), { recursive: true });
  dirLink(s.outside, join(s.home, ".floq", "projects"));

  const status = await s.manager.projectDeleteStatus(U1, project.id);
  const main = status.checkouts.find((checkout: { kind: string }) => checkout.kind === "project");
  assert.equal(main.state, "unreadable");
  assert.equal(main.uncommittedFiles, null);
  assert.equal(status.dirtyMainCheckout, false);
  assert.equal(readFileSync(join(s.outside, project.id, "private.txt"), "utf8"), "outside data\n");
});

test("planCheckouts and removeManagedCheckout enforce the managed patterns", () => {
  const id = randomUUID();
  const plan = planCheckouts(id, [
    { id: "1", cwd: `.floq/projects/${id}`, isWorktree: false },
    { id: "2", cwd: `.floq/projects/${randomUUID()}`, isWorktree: false },
    { id: "3", cwd: `.floq/worktrees/${randomUUID()}`, isWorktree: true },
    { id: "4", cwd: `.floq/worktrees/../../etc`, isWorktree: true },
    { id: "5", cwd: `repos/mine`, isWorktree: false },
  ]);
  assert.deepEqual(plan.map((p) => p.managed), [true, false, true, false, false]);
  const home = mkdtempSync(join(tmpdir(), "floq-projdel-pure-"));
  try {
    assert.throws(() => removeManagedCheckout(home, "../etc", "project"), /unsafe|invalid|managed/i);
    assert.throws(() => removeManagedCheckout(home, "repos/mine", "project"), /not managed/);
    assert.throws(() => removeManagedCheckout(home, `.floq/worktrees/${randomUUID()}`, "project"), /not managed/);
    assert.equal(removeManagedCheckout(home, `.floq/projects/${randomUUID()}`, "project"), "missing");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
