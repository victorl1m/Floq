import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { WiredContext } from "../dist/wiredContext.js";

const A = "ua";
const B = "ub";
const SB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("user A cannot overwrite or create wired memory for user B's session", async (t) => {
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
  await db.exec(`INSERT INTO "user" (id) VALUES ('${A}'), ('${B}')`);
  for (const [s, u] of [[SA, A], [SB, B]]) await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows) VALUES ($1,$2,'claude','Agent','/w','running',80,24)`, [s, u]);

  const wired = new WiredContext(pool as never);
  const record = { block: "victim block", digest: "d1", items: [], updatedAt: new Date().toISOString() };
  await wired.store.put(SB, B, record);
  // A tries to overwrite B's existing row with a forged record.
  await wired.store.put(SB, A, { ...record, block: "ATTACKER", digest: "d2" });
  const row = await db.query(`SELECT user_id, block FROM agent_wired_memory WHERE session_id = $1`, [SB]);
  assert.deepEqual(row.rows, [{ user_id: B, block: "victim block" }]);
  assert.equal(await wired.store.get(SB, A), null, "A cannot read B's record");
  await wired.store.delete(SB, A);
  assert.equal((await db.query(`SELECT 1 FROM agent_wired_memory WHERE session_id = $1`, [SB])).rows.length, 1, "A cannot delete B's record");

  // A cannot plant a row for B's session when none exists yet (would block B's own later write).
  await db.query(`DELETE FROM agent_wired_memory WHERE session_id = $1`, [SB]);
  await wired.store.put(SB, A, { ...record, block: "ATTACKER" });
  assert.equal((await db.query(`SELECT 1 FROM agent_wired_memory WHERE session_id = $1`, [SB])).rows.length, 0);
  // The owner still works.
  await wired.store.put(SB, B, record);
  assert.equal((await wired.store.get(SB, B))?.block, "victim block");
});
