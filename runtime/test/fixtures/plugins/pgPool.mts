import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../../../dist/db.js";

const open: PGlite[] = [];
export const closeAll = async () => { await Promise.all(open.splice(0).map((d) => d.close().catch(() => undefined))); };

/** pg.Pool-shaped wrapper over PGlite (single connection; tests run sequentially). */
export async function fakePool() {
  const db = new PGlite();
  open.push(db);
  const run = async (sql: string, params?: unknown[]) => {
    if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
  };
  const pool = { query: run, async connect() { return { query: run, release() {} }; } };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await migrateApp(pool as never);
  await db.exec(`CREATE SCHEMA collaboration; CREATE TABLE collaboration.user_roles (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
  return { db, pool, addUser: (id: string) => db.exec(`INSERT INTO "user" (id, email) VALUES ('${id}', '${id}@x.test')`) };
}
