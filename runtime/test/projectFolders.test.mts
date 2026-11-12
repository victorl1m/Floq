import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { ProjectFolders, MAX_FOLDERS, pruneProjectFromFolders } from "../dist/projectFolders.js";

/** Organization ids: one per user, plus a second for u1 (folders are stored per user and organization). */
const O = { u1: "a1111111-1111-4111-8111-111111111111", u2: "a2222222-2222-4222-8222-222222222222", u1b: "a3333333-3333-4333-8333-333333333333" };

async function setup(t: test.TestContext) {
  const db = new PGlite();
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT)`);
  const dir = join(import.meta.dirname, "..", "prisma", "migrations");
  for (const name of readdirSync(dir).filter((n) => /^\d+_/.test(n)).sort()) await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id) VALUES ('u1'), ('u2')`);
  for (const [org, user] of [[O.u1, "u1"], [O.u2, "u2"], [O.u1b, "u1"]]) await db.query(`INSERT INTO collaboration.organizations (id, name, slug, created_by) VALUES ($1,$2,$3,$4)`, [org, "org", org, user]);
  t.after(() => db.close());
  return { db, folders: new ProjectFolders(pool as never), pool };
}

const doc = (extra: Record<string, unknown> = {}) => ({
  folders: [{ id: "f1", name: "Work" }],
  root: [{ kind: "folder", id: "f1" }, { kind: "project", id: "11111111-1111-4111-8111-111111111111" }],
  membership: { f1: ["22222222-2222-4222-8222-222222222222"] },
  expanded: { f1: false },
  ...extra,
});
const rejects = (promise: Promise<unknown>, status: number, code?: string) =>
  assert.rejects(promise, (e: any) => e.status === status && (!code || e.code === code));

test("empty state, first write, and round trip", async (t) => {
  const { folders } = await setup(t);
  assert.deepEqual(await folders.get("u1", O.u1), { version: 0, doc: null, updatedAt: null });
  const saved = await folders.put("u1", O.u1, { version: 0, doc: doc() });
  assert.equal(saved.version, 1);
  const read = await folders.get("u1", O.u1);
  assert.equal(read.version, 1);
  assert.deepEqual(read.doc, doc());
  const next = await folders.put("u1", O.u1, { version: 1, doc: doc({ folders: [{ id: "f1", name: "  Renamed  " }] }) });
  assert.equal(next.version, 2);
  assert.equal(next.doc!.folders[0].name, "Renamed", "names are trimmed");
});

test("a stale or missing base version is a 409 conflict and never overwrites", async (t) => {
  const { folders } = await setup(t);
  await folders.put("u1", O.u1, { version: 0, doc: doc() });
  await folders.put("u1", O.u1, { version: 1, doc: doc({ folders: [{ id: "f1", name: "Device A" }] }) });
  await rejects(folders.put("u1", O.u1, { version: 1, doc: doc({ folders: [{ id: "f1", name: "Device B" }] }) }), 409, "version_conflict");
  await rejects(folders.put("u1", O.u1, { version: 0, doc: doc() }), 409, "version_conflict");
  await rejects(folders.put("u1", O.u1, { version: 99, doc: doc() }), 409, "version_conflict");
  assert.equal((await folders.get("u1", O.u1)).doc!.folders[0].name, "Device A");
  // The retry with the latest version succeeds.
  assert.equal((await folders.put("u1", O.u1, { version: 2, doc: doc({ folders: [{ id: "f1", name: "Device B" }] }) })).version, 3);
});

test("concurrent writers with the same base: exactly one wins", async (t) => {
  const { folders } = await setup(t);
  await folders.put("u1", O.u1, { version: 0, doc: doc() });
  const results = await Promise.allSettled([1, 2, 3].map((n) => folders.put("u1", O.u1, { version: 1, doc: doc({ folders: [{ id: "f1", name: "W" + n }] }) })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await folders.get("u1", O.u1)).version, 2);
});

test("users are isolated", async (t) => {
  const { folders } = await setup(t);
  await folders.put("u1", O.u1, { version: 0, doc: doc() });
  assert.equal((await folders.get("u2", O.u2)).doc, null);
  // u2's first write is independent of u1's version, and does not touch u1.
  await folders.put("u2", O.u2, { version: 0, doc: doc({ folders: [{ id: "f1", name: "Mine" }] }) });
  await rejects(folders.put("u2", O.u2, { version: 1 + 1, doc: doc() }), 409);
  assert.equal((await folders.get("u1", O.u1)).doc!.folders[0].name, "Work");
  assert.equal((await folders.get("u2", O.u2)).doc!.folders[0].name, "Mine");
});

test("validation: shape, ids, names and caps", async (t) => {
  const { folders } = await setup(t);
  const bad = (d: unknown, v: unknown = 0) => rejects(folders.put("u1", O.u1, { version: v, doc: d }), 400, "invalid_project_folders");
  await bad(null);
  await bad("x");
  await bad({ ...doc(), folders: "no" });
  await bad(doc({ folders: [{ id: "f1", name: "" }] }));
  await bad(doc({ folders: [{ id: "f1", name: "   " }] }));
  await bad(doc({ folders: [{ id: "f1", name: "x".repeat(81) }] }));
  await bad(doc({ folders: [{ id: "bad id!", name: "ok" }], root: [] , membership: {}, expanded: {} }));
  await bad(doc({ folders: [{ id: "f1", name: "a" }, { id: "f1", name: "b" }] }));
  await bad(doc({ root: [{ kind: "folder", id: "ghost" }] }));
  await bad(doc({ root: [{ kind: "nope", id: "x" }] }));
  await bad(doc({ membership: { ghost: ["p"] } }));
  await bad(doc({ membership: { f1: [123] } }));
  await bad(doc({ expanded: { f1: "yes" } }));
  await bad(doc(), -1);
  await bad(doc(), 1.5);
  await bad(doc(), "1");
  const many = Array.from({ length: MAX_FOLDERS + 1 }, (_, i) => ({ id: "f" + i, name: "n" }));
  await bad({ folders: many, root: [], membership: {}, expanded: {} });
  // Exactly at the caps is fine; names of 80 characters are fine.
  const ok = Array.from({ length: MAX_FOLDERS }, (_, i) => ({ id: "f" + i, name: "x".repeat(80) }));
  assert.equal((await folders.put("u1", O.u1, { version: 0, doc: { folders: ok, root: ok.map((f) => ({ kind: "folder", id: f.id })), membership: {}, expanded: {} } })).version, 1);
  assert.equal((await folders.get("u1", O.u1)).doc!.folders.length, MAX_FOLDERS);
});

test("unknown keys are dropped; the stored document is canonical", async (t) => {
  const { folders } = await setup(t);
  const saved = await folders.put("u1", O.u1, { version: 0, doc: { ...doc(), evil: { big: "x" }, folders: [{ id: "f1", name: "W", extra: true }] } });
  assert.deepEqual(Object.keys(saved.doc!).sort(), ["expanded", "folders", "membership", "root"]);
  assert.deepEqual(saved.doc!.folders[0], { id: "f1", name: "W" });
});

test("pruning a deleted project bumps the version only when something changed", async (t) => {
  const { folders, pool } = await setup(t);
  const gone = "22222222-2222-4222-8222-222222222222";
  await folders.put("u1", O.u1, { version: 0, doc: doc() });
  await pruneProjectFromFolders(pool as never, "u1", "99999999-9999-4999-8999-999999999999");
  assert.equal((await folders.get("u1", O.u1)).version, 1);
  await pruneProjectFromFolders(pool as never, "u1", gone);
  const after = await folders.get("u1", O.u1);
  assert.equal(after.version, 2);
  assert.deepEqual(after.doc!.membership.f1, []);
  await pruneProjectFromFolders(pool as never, "u2", gone); // no document: no-op
});

test("layouts are separate per organization; moving projects rewrites both documents", async (t) => {
  const { folders, pool } = await setup(t);
  const P = "11111111-1111-4111-8111-111111111111", Q = "33333333-3333-4333-8333-333333333333";
  await folders.put("u1", O.u1, { version: 0, doc: doc() });
  assert.equal((await folders.get("u1", O.u1b)).doc, null, "another org of the same user has its own (empty) layout");
  await folders.put("u1", O.u1b, { version: 0, doc: { folders: [], root: [{ kind: "project", id: Q }], membership: {}, expanded: {} } });
  assert.equal((await folders.get("u1", O.u1)).version, 1);

  const { moveProjectsInFolders } = await import("../dist/projectFolders.js");
  await moveProjectsInFolders(pool as never, "u1", [P], O.u1, O.u1b);
  const source = (await folders.get("u1", O.u1)).doc!;
  assert.ok(!source.root.some((e) => e.id === P), "left the source root");
  const target = (await folders.get("u1", O.u1b)).doc!;
  assert.deepEqual(target.root.map((e) => e.id), [Q, P], "appended to the target root");
  await moveProjectsInFolders(pool as never, "u1", [P], O.u1, O.u1b);
  assert.deepEqual((await folders.get("u1", O.u1b)).doc!.root.map((e) => e.id), [Q, P], "idempotent");
  // a deleted project is pruned from every layout
  await pruneProjectFromFolders(pool as never, "u1", P);
  assert.deepEqual((await folders.get("u1", O.u1b)).doc!.root.map((e) => e.id), [Q]);
});
