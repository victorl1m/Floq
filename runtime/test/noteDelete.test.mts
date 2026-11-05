import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { CanvasNotes } from "../dist/notes.js";
import { Orchestrator } from "../dist/orchestrator.js";

// `floq note delete` / `floq sticky delete`: agents remove notes of their own user; system notes stay the user's.
const U = "u1";
const U2 = "u2";
const P1 = "11111111-1111-4111-8111-111111111111";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1,$2,'p','/w')`, [P1, U]);
  await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,$2,'claude','Agent','/w','running',80,24,$3)`, [S1, U, P1]);
  await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,$2,'claude','Other','/w','running',80,24,NULL)`, [S2, U2]);
  const notes = new CanvasNotes(pool as never);
  const orch = Object.assign(Object.create(Orchestrator.prototype), { pool }) as Orchestrator;
  return { db, pool, notes, orch };
}

test("note delete removes the shared note and its card; other users and missing names fail", async (t) => {
  const { db, notes, orch } = await setup();
  t.after(() => db.close());
  await orch.noteWrite(U, "plan", "body", false);
  await orch.noteWrite(U2, "plan", "theirs", false);
  const card = await notes.mirrorAgentNote(U, S1, "plan");
  assert.ok(card);
  const r = await notes.agentNoteDelete(U, "plan");
  assert.deepEqual(r.sessionIds, [S1]);
  assert.equal((await notes.list(U, P1)).length, 0);
  await assert.rejects(orch.noteRead(U, "plan"), /not found/i);
  assert.equal((await orch.noteRead(U2, "plan")).content, "theirs", "another user's note is untouched");
  await assert.rejects(notes.agentNoteDelete(U, "plan"), (e: any) => e.status === 404 && /No shared note named plan/.test(e.message));
  await assert.rejects(notes.agentNoteDelete(U, "bad/name"), (e: any) => e.status === 400);
});

test("sticky delete: memory and linked notes go, system is refused, unseen/other-user notes are 404", async (t) => {
  const { db, notes } = await setup();
  t.after(() => db.close());
  const memory = await notes.agentCreate(U, S1, { kind: "memory", text: "m" });
  const plain = await notes.agentCreate(U, S1, { text: "n" });
  const system = await notes.agentCreate(U, S1, { kind: "system", text: "rules" });
  await assert.rejects(notes.agentDelete(U, S1, system.id), (e: any) => e.status === 403 && e.code === "system_note_readonly");
  assert.equal((await notes.get(U, system.id)).text, "rules");
  const m = await notes.agentDelete(U, S1, memory.id);
  assert.equal(m.note.kind, "memory");
  await assert.rejects(notes.get(U, memory.id), (e: any) => e.status === 404);
  await notes.agentDelete(U, S1, plain.id);
  assert.equal((await notes.list(U, P1)).filter((n) => n.kind !== "system").length, 0);
  // Another user's note, and a same-user note this agent is not linked to, both look missing.
  const theirs = await notes.agentCreate(U2, S2, { text: "secret" });
  await assert.rejects(notes.agentDelete(U, S1, theirs.id), (e: any) => e.status === 404);
  const hidden = await notes.create(U, P1, { text: "unlinked", x: 0, y: 0, w: 240, h: 160 }, "user");
  await assert.rejects(notes.agentDelete(U, S1, hidden.id), (e: any) => e.status === 404);
  assert.equal((await notes.get(U, hidden.id)).text, "unlinked");
});
