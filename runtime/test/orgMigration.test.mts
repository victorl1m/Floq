import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { OrganizationsService } from "../dist/organizations.js";
import { SessionManager } from "../dist/manager.js";

async function setup(t: test.TestContext) {
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" BOOLEAN DEFAULT false)`);
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const name of readdirSync(dir).filter((n) => /^\d+_/.test(n)).sort()) await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id, name, email) VALUES ('u-a','a','a@x.io'), ('u-b','b','b@x.io')`);
  t.after(() => db.close());
  return { db, pool };
}

const legacySlug = (uid: string) => "personal-" + createHash("md5").update(uid).digest("hex").slice(0, 8);

test("a team org squatting the old personal-<hash> slug cannot break personal org creation, the trigger or the backfill", async (t) => {
  const { db, pool } = await setup(t);
  await db.query(`INSERT INTO collaboration.organizations (id, name, slug, created_by) VALUES (gen_random_uuid(), 'Squat', $1, 'u-b')`, [legacySlug("u-a")]);
  const service = new OrganizationsService(pool as never);
  const orgs = await service.list("u-a");
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].personal, true);
  // trigger path: a project inserted without an organization lands in the personal org
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES (gen_random_uuid(), 'u-a', 'p', '/p')`);
  assert.equal((await db.query<{ organization_id: string }>(`SELECT organization_id FROM floq_projects`)).rows[0].organization_id, orgs[0].id);
  // trigger creates the personal org on demand for a user that has none yet
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES (gen_random_uuid(), 'u-b', 'q', '/q')`);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM collaboration.organizations WHERE personal_owner_id = 'u-b' AND slug IS NULL`)).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM collaboration.organization_members WHERE user_id = 'u-b' AND role = 'owner'`)).rows[0].n, 1);
});

test("the backfill survives a squatted slug, rewrites old personal slugs to NULL and is idempotent", async (t) => {
  const { db, pool } = await setup(t);
  // simulate the pre-migration state
  await db.exec(`DROP TRIGGER floq_projects_default_org ON floq_projects; DROP TRIGGER user_project_folders_default_org ON user_project_folders;
    ALTER TABLE floq_projects ALTER COLUMN organization_id DROP NOT NULL;`);
  await db.query(`INSERT INTO collaboration.organizations (id, name, slug, created_by) VALUES (gen_random_uuid(), 'Squat', $1, 'u-b')`, [legacySlug("u-a")]);
  await db.query(`INSERT INTO collaboration.organizations (id, name, slug, created_by, personal_owner_id) VALUES (gen_random_uuid(), 'Personal', $1, 'u-b', 'u-b')`, [legacySlug("u-b")]);
  await db.exec(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES (gen_random_uuid(), 'u-a', 'p', '/p'), (gen_random_uuid(), 'u-b', 'q', '/q')`);
  await migrateApp(pool as never);
  await migrateApp(pool as never);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM floq_projects WHERE organization_id IS NULL`)).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM collaboration.organizations WHERE personal_owner_id IS NOT NULL AND slug IS NOT NULL`)).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('floq_projects_default_org','user_project_folders_default_org')`)).rows[0].n, 2, "triggers exist exactly once");
});

test("a folder doc inserted without an organization (older runtime) lands in the personal org", async (t) => {
  const { db } = await setup(t);
  await db.query(`INSERT INTO user_project_folders (user_id, doc) VALUES ('u-a', '{}'::jsonb)`);
  const row = (await db.query<{ organization_id: string }>(`SELECT f.organization_id FROM user_project_folders f JOIN collaboration.organizations o ON o.id = f.organization_id WHERE o.personal_owner_id = 'u-a'`)).rows;
  assert.equal(row.length, 1);
});

test("project create coalescing is keyed by organization (two orgs importing one URL are not merged)", async () => {
  const manager = Object.create(SessionManager.prototype) as any;
  const calls: string[] = [];
  Object.assign(manager, {
    projectCreates: new Map(),
    withShardActivity: async (_u: string, fn: () => Promise<unknown>) => { calls.push("run"); await new Promise((r) => setTimeout(r, 20)); return fn(); },
    pool: { query: async () => ({ rows: [{ id: "x", organization_id: "org-1" }] }) },
    throwInOtherOrg: async (id: string, org: string) => { throw Object.assign(new Error("other"), { code: "project_in_other_org", id, org }); },
    project: async () => ({ id: "x" }),
  });
  const url = "https://github.com/o/r.git";
  const a = manager.createProject("u", {}, url, undefined, "org-1");
  const b = manager.createProject("u", {}, url, undefined, "org-2");
  const [ra, rb] = await Promise.allSettled([a, b]);
  assert.equal(ra.status, "fulfilled");
  assert.equal(rb.status, "rejected", "the second org gets the 409, not org-1's project");
  assert.equal(calls.length, 2);
});
