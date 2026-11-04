import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { CanvasNotes } from "../dist/notes.js";
import { Orchestrator } from "../dist/orchestrator.js";

// `floq note write` must surface on the project canvas: mirrored, wired to the writer, unplaced until the UI places it.
const U = "u1";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  await db.exec(`INSERT INTO "user" (id) VALUES ('${U}')`);
  return { db, pool };
}

test("floq note write appears on the writer's project canvas, wired, unplaced; edits and deletes stay in sync", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  for (const id of [P1, P2]) await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1, $2, $3, $4)`, [id, U, "proj", "/w/" + id]);
  await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,$2,'claude','Agent','/w','running',80,24,$3)`, [S1, U, P1]);

  const notes = new CanvasNotes(pool as never);
  const orch = Object.assign(Object.create(Orchestrator.prototype), { pool }) as Orchestrator;

  // A note written before this feature existed (no mirror): adopted by the first project canvas that is opened.
  await orch.noteWrite(U, "old-note", "legacy body", false);
  const first = await notes.list(U, P2);
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "old-note");
  assert.equal(first[0].placed, false);
  assert.equal(first[0].text, "legacy body");
  assert.deepEqual((await notes.list(U, P1)).map((n) => n.title), [], "an adopted note is not duplicated onto other canvases");

  // The agent creates one.
  await orch.noteWrite(U, "coupa-api-wrapper", "line 1\nline 2", false);
  const mirrored = await notes.mirrorAgentNote(U, S1, "coupa-api-wrapper");
  assert.ok(mirrored);
  assert.equal(mirrored.title, "coupa-api-wrapper");
  assert.equal(mirrored.projectId, P1);
  assert.deepEqual(mirrored.linkedSessionIds, [S1]);
  assert.equal(mirrored.placed, false);
  assert.equal((await notes.list(U, P1)).length, 1);

  // Append through floq refreshes the same card (no duplicate).
  await orch.noteWrite(U, "coupa-api-wrapper", "line 3", true);
  await notes.mirrorAgentNote(U, S1, "coupa-api-wrapper");
  const after = await notes.list(U, P1);
  assert.equal(after.length, 1);
  assert.equal(after[0].text, "line 1\nline 2\nline 3");

  // Placing persists; editing on the canvas flows back to `floq note read`.
  const placed = await notes.patch(U, after[0].id, { x: 40, y: 60 });
  assert.equal(placed.placed, true);
  await notes.patch(U, after[0].id, { text: "edited on canvas" });
  assert.deepEqual((await orch.noteRead(U, "coupa-api-wrapper")).content, "edited on canvas");

  // Deleting the card removes the note; undo (create with the title) restores both.
  await notes.remove(U, after[0].id);
  await assert.rejects(orch.noteRead(U, "coupa-api-wrapper"));
  const restored = await notes.create(U, P1, { x: 40, y: 60, text: "edited on canvas", agentNoteName: "coupa-api-wrapper" });
  assert.equal(restored.title, "coupa-api-wrapper");
  assert.equal((await orch.noteRead(U, "coupa-api-wrapper")).content, "edited on canvas");
});
