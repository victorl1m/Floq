import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { SessionManager } from "../dist/manager.js";

async function setup(t: test.TestContext) {
  const db = new PGlite();
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id) VALUES ('u1'), ('u2')`);
  const project = randomUUID();
  const w1 = randomUUID();
  const w2 = randomUUID();
  await db.query(`INSERT INTO floq_projects(id,user_id,name,cwd) VALUES ($1,'u1','p','/p')`, [project]);
  await db.query(`INSERT INTO floq_project_workspaces(id,user_id,project_id,cwd,name) VALUES ($1,'u1',$3,'/p','Main'),($2,'u1',$3,'/p2','Worktree')`, [w1, w2, project]);
  t.after(() => db.close());
  const manager = Object.create(SessionManager.prototype) as InstanceType<typeof SessionManager>;
  (manager as unknown as { pool: unknown }).pool = pool;
  const state = async () => Object.fromEntries((await db.query(`SELECT id, nav_expanded FROM floq_project_workspaces`)).rows.map((r: any) => [r.id, r.nav_expanded]));
  return { manager, project, w1, w2, state };
}

test("workspace nav state defaults to expanded and persists per workspace", async (t) => {
  const { manager, project, w1, w2, state } = await setup(t);
  assert.deepEqual(await state(), { [w1]: true, [w2]: true });
  assert.deepEqual(await manager.setWorkspaceNavExpanded("u1", project, w1, false), { id: w1, navExpanded: false });
  assert.deepEqual(await state(), { [w1]: false, [w2]: true });
});

test("batch collapse and expand cover every workspace of the project", async (t) => {
  const { manager, project, w1, w2, state } = await setup(t);
  await manager.setProjectNavExpanded("u1", project, false);
  assert.deepEqual(await state(), { [w1]: false, [w2]: false });
  await manager.setProjectNavExpanded("u1", project, true);
  assert.deepEqual(await state(), { [w1]: true, [w2]: true });
});

test("invalid ids, other users and bad values are rejected without changes", async (t) => {
  const { manager, project, w1, w2, state } = await setup(t);
  const rejects = (p: Promise<unknown>, status: number) => assert.rejects(p, (e: any) => e.status === status);
  await rejects(manager.setWorkspaceNavExpanded("u1", "not-a-uuid", w1, false), 404);
  await rejects(manager.setWorkspaceNavExpanded("u1", project, "nope", false), 404);
  await rejects(manager.setWorkspaceNavExpanded("u2", project, w1, false), 404);
  await rejects(manager.setWorkspaceNavExpanded("u1", project, w1, "false"), 400);
  await rejects(manager.setProjectNavExpanded("u2", project, false), 404);
  await rejects(manager.setProjectNavExpanded("u1", "bad", false), 404);
  assert.deepEqual(await state(), { [w1]: true, [w2]: true });
});
