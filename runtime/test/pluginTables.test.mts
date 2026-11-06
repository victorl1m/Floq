import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";

test("plugin host tables are created idempotently and keyed as designed", async () => {
  const db = new PGlite();
  const pool = { async query(sql: string) { const r = await db.exec(sql); const l = r[r.length - 1]; return { rows: l?.rows ?? [], rowCount: l?.rows?.length ?? 0 }; } };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await migrateApp(pool as never);
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id) VALUES ('u1')`);
  await db.exec(`INSERT INTO floq_plugins (id) VALUES ('movidesk')`);
  await db.exec(`INSERT INTO floq_plugin_user_settings (plugin_id, user_id) VALUES ('movidesk','u1')`);
  await assert.rejects(db.exec(`INSERT INTO floq_plugin_user_settings (plugin_id, user_id) VALUES ('movidesk','u1')`));
  await db.exec(`INSERT INTO floq_plugin_migrations (plugin_id, migration_id) VALUES ('movidesk','001')`);
  await assert.rejects(db.exec(`INSERT INTO floq_plugin_migrations (plugin_id, migration_id) VALUES ('movidesk','001')`));
  const r = await db.query<{ enabled: boolean; status: string }>(`SELECT enabled, status FROM floq_plugins WHERE id='movidesk'`);
  assert.deepEqual(r.rows[0], { enabled: false, status: "available" });
  await db.exec(`DELETE FROM "user" WHERE id='u1'`);
  assert.equal((await db.query(`SELECT 1 FROM floq_plugin_user_settings`)).rows.length, 0);
  await db.close();
});
