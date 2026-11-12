import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { OrganizationsService } from "../dist/organizations.js";
import { ProjectFolders } from "../dist/projectFolders.js";

const A = "u-owner", B = "u-member";
const P1 = "a0000000-0000-4000-8000-000000000001", P2 = "a0000000-0000-4000-8000-000000000002", P3 = "a0000000-0000-4000-8000-000000000003", P4 = "a0000000-0000-4000-8000-000000000004";

async function setup(t: test.TestContext) {
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  let tail: Promise<void> = Promise.resolve();
  const pool = { query, async connect() { let release!: () => void; const prev = tail; tail = new Promise<void>((r) => { release = r; }); await prev; return { query, release }; } };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" BOOLEAN DEFAULT true)`);
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const name of readdirSync(dir).filter((n) => /^\d+_/.test(n)).sort()) await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id, name, email) VALUES ('${A}','owner','owner@x.io'), ('${B}','member','member@x.io')`);
  t.after(() => db.close());
  const service = new OrganizationsService(pool as never);
  const folders = new ProjectFolders(pool as never);
  const org = await service.create(A, { name: "Acme" });
  const invite = await service.invite(A, org.id, { email: "member@x.io", role: "member" });
  await service.acceptByToken(B, invite.token);
  const personalA = await service.ensurePersonal(A), personalB = await service.ensurePersonal(B);
  const proj = (id: string, user: string, orgId: string) => db.query(`INSERT INTO floq_projects (id, user_id, name, cwd, organization_id) VALUES ($1,$2,'p',$3,$4)`, [id, user, "/" + id, orgId]);
  const orgOf = async (id: string) => String((await db.query<{ organization_id: string }>(`SELECT organization_id FROM floq_projects WHERE id=$1`, [id])).rows[0].organization_id);
  const layout = (...ids: string[]) => ({ folders: [{ id: "f1", name: "Work" }], root: [{ kind: "folder", id: "f1" }], membership: { f1: ids }, expanded: {}, children: { f1: ids.map((id) => ({ kind: "project", id })) } });
  return { db, service, folders, org, personalA, personalB, proj, orgOf, layout };
}

test("deleting an organization returns every member's projects to their personal org and moves folder entries", async (t) => {
  const { service, folders, org, personalA, personalB, proj, orgOf, layout, db } = await setup(t);
  await proj(P1, A, org.id); await proj(P2, A, personalA); await proj(P3, B, org.id);
  await folders.put(A, org.id, { version: 0, doc: layout(P1) });
  await folders.put(A, personalA, { version: 0, doc: { folders: [], root: [{ kind: "project", id: P2 }], membership: {}, expanded: {} } });
  await service.remove(A, org.id, "Acme");
  assert.equal(await orgOf(P1), personalA);
  assert.equal(await orgOf(P2), personalA);
  assert.equal(await orgOf(P3), personalB, "a member's project goes to the member's own personal org");
  assert.equal((await db.query(`SELECT 1 FROM collaboration.organizations WHERE id=$1`, [org.id])).rows.length, 0);
  const personalLayout = (await folders.get(A, personalA)).doc!;
  assert.deepEqual(personalLayout.root.map((e) => e.id), [P2, P1], "the moved project lands in the personal root");
  assert.equal((await db.query(`SELECT 1 FROM user_project_folders WHERE organization_id=$1`, [org.id])).rows.length, 0);
});

test("leaving or being removed returns only that user's projects", async (t) => {
  const { service, org, personalA, personalB, proj, orgOf } = await setup(t);
  await proj(P1, A, org.id); await proj(P3, B, org.id); await proj(P4, B, org.id);
  await service.removeMember(A, org.id, B);
  assert.equal(await orgOf(P3), personalB);
  assert.equal(await orgOf(P4), personalB);
  assert.equal(await orgOf(P1), org.id, "the owner's project stays");
  // a member who leaves on their own
  const again = await service.invite(A, org.id, { email: "member@x.io", role: "member" });
  await service.acceptByToken(B, again.token);
  await proj("a0000000-0000-4000-8000-000000000005", B, org.id);
  await service.leave(B, org.id);
  assert.equal(await orgOf("a0000000-0000-4000-8000-000000000005"), personalB);
  assert.notEqual(personalA, personalB);
});
