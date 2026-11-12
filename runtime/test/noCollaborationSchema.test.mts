import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../src/db.ts";
import { pruneProjectFromFolders } from "../src/projectFolders.ts";

// Installs/tests without the collaboration schema (no Prisma deploy) must still run every org-aware project query.
test("migrateApp without collaboration.* keeps a nullable organization_id so org-aware queries work", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await migrateApp(pool as never);
  await migrateApp(pool as never); // idempotent
  assert.equal((await db.query(`SELECT to_regclass('collaboration.organizations') AS r`)).rows[0]!.r, null);
  await db.exec(`INSERT INTO "user" (id) VALUES ('u1')`);
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ('11111111-1111-4111-8111-111111111111','u1','P','/p')`);
  const rows = (await pool.query("SELECT p.name, p.organization_id AS org_id FROM agent_sessions s RIGHT JOIN floq_projects p ON p.id = s.project_id WHERE p.user_id = $1", ["u1"])).rows;
  assert.equal(rows[0]!.org_id, null);
  await db.query(`INSERT INTO user_project_folders (user_id, version, doc) VALUES ('u1', 1, $1::jsonb)`, [JSON.stringify({ root: [{ kind: "project", id: "11111111-1111-4111-8111-111111111111" }], folders: [], membership: {} })]);
  await pruneProjectFromFolders(pool as never, "u1", "11111111-1111-4111-8111-111111111111");
  const doc = (await db.query(`SELECT version, doc FROM user_project_folders WHERE user_id='u1'`)).rows[0] as { version: number; doc: { root: unknown[] } };
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.doc.root, []);
});
