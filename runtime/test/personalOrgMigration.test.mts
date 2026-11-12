import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";

const P1 = "11111111-1111-4111-8111-111111111111", P2 = "22222222-2222-4222-8222-222222222222", P3 = "33333333-3333-4333-8333-333333333333";

test("migrateApp backfills projects and folders into personal orgs, is idempotent, and defaults new rows", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const pool = { async query(sql: string, params?: unknown[]) { if (!params?.length) { const r = await db.exec(sql); const l = r[r.length - 1]; return { rows: l?.rows ?? [], rowCount: l?.rows?.length ?? 0 }; } const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; } };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT)`);
  await db.exec(`INSERT INTO "user" (id) VALUES ('u1'), ('u2'), ('u3')`);

  // Legacy install: app tables exist, collaboration.* does not yet (org block is skipped).
  await migrateApp(pool as never);
  assert.equal((await db.query(`SELECT to_regclass('collaboration.organizations') AS r`)).rows[0].r, null);
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1,'u1','a','/a'), ($2,'u1','b','/b'), ($3,'u2','c','/c')`, [P1, P2, P3]);
  await db.exec(`INSERT INTO user_project_folders (user_id, doc) VALUES ('u1', '{}'::jsonb)`);

  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const name of readdirSync(dir).filter((n) => /^\d+_/.test(n)).sort()) await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));

  await migrateApp(pool as never);
  const snapshot = async () => ({
    projects: (await db.query(`SELECT p.id, p.user_id, o.personal_owner_id FROM floq_projects p JOIN collaboration.organizations o ON o.id = p.organization_id ORDER BY p.id`)).rows,
    folders: (await db.query(`SELECT f.user_id, o.personal_owner_id FROM user_project_folders f JOIN collaboration.organizations o ON o.id = f.organization_id`)).rows,
    orgs: (await db.query(`SELECT id, personal_owner_id, slug FROM collaboration.organizations ORDER BY personal_owner_id`)).rows,
    members: (await db.query(`SELECT user_id, role FROM collaboration.organization_members ORDER BY user_id`)).rows,
  });
  const first = await snapshot();
  assert.deepEqual(first.projects.map((r) => [r.id, r.user_id === r.personal_owner_id]), [[P1, true], [P2, true], [P3, true]]);
  assert.deepEqual(first.folders.map((r) => r.user_id === r.personal_owner_id), [true]);
  assert.deepEqual(first.orgs.map((o) => o.personal_owner_id), ["u1", "u2"], "only users with data get one eagerly");
  assert.deepEqual(first.members, [{ user_id: "u1", role: "owner" }, { user_id: "u2", role: "owner" }]);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM collaboration.organizations WHERE personal_owner_id = 'u1'`)).rows[0].n, 1);

  await migrateApp(pool as never);
  await migrateApp(pool as never);
  assert.deepEqual(await snapshot(), first);

  // Folder primary key is now (user_id, organization_id): one doc per user and org.
  const [{ id: org }] = (await db.query<{ id: string }>(`SELECT id FROM collaboration.organizations WHERE personal_owner_id = 'u1'`)).rows;
  const other = "99999999-9999-4999-8999-999999999999";
  await db.query(`INSERT INTO collaboration.organizations (id, name, slug, created_by) VALUES ($1,'Team','team-x','u1')`, [other]);
  await db.query(`INSERT INTO user_project_folders (user_id, organization_id, doc) VALUES ('u1',$1,'{}'::jsonb)`, [other]);
  await assert.rejects(db.query(`INSERT INTO user_project_folders (user_id, organization_id, doc) VALUES ('u1',$1,'{}'::jsonb)`, [org]));

  // A project inserted without an organization lands in the owner's personal org (creating it for a new user).
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ('44444444-4444-4444-8444-444444444444','u3','d','/d')`);
  const d = (await db.query(`SELECT o.personal_owner_id FROM floq_projects p JOIN collaboration.organizations o ON o.id = p.organization_id WHERE p.user_id = 'u3'`)).rows[0];
  assert.equal(d.personal_owner_id, "u3");
  // An organization that still owns projects cannot be deleted by accident.
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd, organization_id) VALUES ('55555555-5555-4555-8555-555555555555','u1','e','/e',$1)`, [other]);
  await assert.rejects(db.query(`DELETE FROM collaboration.organizations WHERE id = $1`, [other]));
});
