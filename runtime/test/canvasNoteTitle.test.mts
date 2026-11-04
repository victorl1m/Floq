import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { CanvasNotes } from "../dist/notes.js";
import { Orchestrator } from "../dist/orchestrator.js";

const U = "u1";
const U2 = "u2";

async function setup() {
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
  await db.exec(`INSERT INTO "user" (id) VALUES ('${U}'), ('${U2}')`);
  return { db, pool };
}

test("user titles: set, trim, clear, limits, ownership", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const notes = new CanvasNotes(pool as never);
  const n = await notes.create(U, "none", { x: 0, y: 0 });
  assert.equal(n.title, null);
  assert.equal(n.agentNoteName, null);

  assert.equal((await notes.patch(U, n.id, { title: "  Plan B  " })).title, "Plan B");
  assert.equal((await notes.list(U, "none"))[0].title, "Plan B");
  assert.equal((await notes.patch(U, n.id, { color: "blue" })).title, "Plan B", "other patches keep the title");
  assert.equal((await notes.patch(U, n.id, { title: "   " })).title, null, "blank clears");
  await notes.patch(U, n.id, { title: "again" });
  assert.equal((await notes.patch(U, n.id, { title: null })).title, null);

  assert.equal((await notes.patch(U, n.id, { title: "x".repeat(80) })).title?.length, 80);
  await assert.rejects(notes.patch(U, n.id, { title: "x".repeat(81) }), /80/);
  await assert.rejects(notes.patch(U, n.id, { title: 5 }), /title/);
  await assert.rejects(notes.patch(U, n.id, { title: "a\nb" }), /control/);
  assert.equal((await notes.patch(U, n.id, { title: "Ünï: ok / free text!" })).title, "Ünï: ok / free text!", "plain notes allow free text");

  await assert.rejects(notes.patch(U2, n.id, { title: "mine now" }), /not found/i);
  assert.equal((await notes.get(U, n.id)).title, "Ünï: ok / free text!");

  const created = await notes.create(U, "none", { x: 1, y: 1, title: "Born titled" });
  assert.equal(created.title, "Born titled");
});

test("renaming a mirrored note renames the agent note and every mirror; conflicts are rejected", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const notes = new CanvasNotes(pool as never);
  const orch = Object.assign(Object.create(Orchestrator.prototype), { pool }) as Orchestrator;
  await orch.noteWrite(U, "alpha", "body A", false);
  await orch.noteWrite(U, "beta", "body B", false);
  const list = await notes.list(U, "none");
  const alpha = list.find((x) => x.title === "alpha")!;
  assert.equal(alpha.agentNoteName, "alpha");

  const renamed = await notes.patch(U, alpha.id, { title: " gamma " });
  assert.equal(renamed.title, "gamma");
  assert.equal(renamed.agentNoteName, "gamma");
  assert.equal((await orch.noteRead(U, "gamma")).content, "body A");
  await assert.rejects(orch.noteRead(U, "alpha"), /not found/i);

  // Edits after the rename still reach the agent note.
  await notes.patch(U, alpha.id, { text: "new body" });
  assert.equal((await orch.noteRead(U, "gamma")).content, "new body");

  await assert.rejects(notes.patch(U, alpha.id, { title: "beta" }), (e: { status?: number; code?: string }) => e.status === 409 && e.code === "duplicate_note");
  assert.equal((await notes.get(U, alpha.id)).title, "gamma", "failed rename changes nothing");
  assert.equal((await orch.noteRead(U, "gamma")).content, "new body");

  await assert.rejects(notes.patch(U, alpha.id, { title: null }), /needs a name/);
  await assert.rejects(notes.patch(U, alpha.id, { title: "bad/name" }), /letters, digits/);
  assert.equal((await notes.patch(U, alpha.id, { title: "gamma" })).title, "gamma", "same name is a no-op");

  // A plain note may reuse a name freely (it is just a label), and deleting a mirrored card still removes the agent note.
  const plain = await notes.create(U, "none", { x: 0, y: 0 });
  assert.equal((await notes.patch(U, plain.id, { title: "beta" })).title, "beta");
  await notes.remove(U, alpha.id);
  await assert.rejects(orch.noteRead(U, "gamma"), /not found/i);
});
