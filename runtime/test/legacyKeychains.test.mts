import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { WiredContext } from "../dist/wiredContext.js";
import { CanvasNotes } from "../dist/notes.js";

// The keychain feature is gone, but its rows (and wired-memory records that mention them) may still sit in an existing database.
// Everything that loads a canvas must keep working and must never surface them.
const P = "11111111-1111-4111-8111-111111111111", S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", KC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function setup() {
  const db = new PGlite();
  const pool = { async query(sql: string, params?: unknown[]) { if (!params?.length) { const r = await db.exec(sql); const l = r[r.length - 1]; return { rows: l?.rows ?? [], rowCount: l?.rows?.length ?? 0 }; } const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; } };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id) VALUES ('u1')`);
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1,'u1','p','/w')`, [P]);
  await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,'u1','claude','Alice','/w','running',80,24,$2)`, [S, P]);
  const note = (await db.query(`INSERT INTO canvas_notes (user_id, project_id, text, x, y, w, h) VALUES ('u1',$1,'plan A',0,0,240,160) RETURNING id`, [P])).rows[0] as { id: string };
  await db.query(`INSERT INTO canvas_note_links (note_id, session_id, user_id) VALUES ($1,$2,'u1')`, [note.id, S]);
  // Legacy keychain rows: a node, a sealed secret and a wire to the agent.
  await db.query(`INSERT INTO keychains (id, user_id, project_id, name, x, y) VALUES ($1,'u1',$2,'Prod',0,0)`, [KC, P]);
  await db.query(`INSERT INTO keychain_secrets (keychain_id, user_id, name, value_enc) VALUES ($1,'u1','API_KEY','\\x00')`, [KC]);
  await db.query(`INSERT INTO keychain_links (keychain_id, session_id, user_id) VALUES ($1,$2,'u1')`, [KC, S]);
  return { db, pool: pool as never, note };
}

test("a canvas with legacy keychain rows and wires loads cleanly and never surfaces them", async () => {
  const { db, pool, note } = await setup();
  const notes = await new CanvasNotes(pool).list("u1", P);
  assert.deepEqual(notes.map((n) => n.id), [note.id]);
  const wired = new WiredContext(pool);
  const items = await wired.collect("u1", S);
  assert.deepEqual(items.map((i) => i.kind), ["note"]);
  const sync = await wired.sync("u1", S);
  assert.match(sync.block, /plan A/);
  assert.doesNotMatch(sync.block, /keychain|API_KEY|Prod/i);
  await db.close();
});

test("a wired-memory record saved before the removal does not announce a removed keychain", async () => {
  const { db, pool, note } = await setup();
  const wired = new WiredContext(pool);
  const legacy = [{ kind: "keychain", id: KC, title: "Prod" }, { kind: "note", id: note.id, title: "plan A" }];
  await db.query(`INSERT INTO agent_wired_memory (session_id, user_id, block, digest, items) VALUES ($1,'u1','stale','stale',$2::jsonb)`, [S, JSON.stringify(legacy)]);
  const sync = await wired.sync("u1", S);
  assert.deepEqual(sync.removed, []);
  assert.deepEqual(sync.added, []);
  await db.close();
});
