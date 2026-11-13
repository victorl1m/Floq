import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { BrowserLinks } from "../dist/browserLinks.js";
import { WiredContext } from "../dist/wiredContext.js";

// Agent <-> Browser node wires: stored per user, one node per agent, shared nodes, wired-context line, cascade with the session.
const U = "u1", OTHER = "u2";
const P1 = "11111111-1111-4111-8111-111111111111";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", S3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  await db.exec(`INSERT INTO "user" (id) VALUES ('${U}'), ('${OTHER}')`);
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1,$2,'p','/w')`, [P1, U]);
  for (const [id, user] of [[S1, U], [S2, U], [S3, OTHER]]) await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,$2,'claude','Agent','/w','running',80,24,$3)`, [id, user, user === U ? P1 : null]);
  return { db, pool };
}

test("link/unlink, shared nodes, one node per agent, ownership and validation", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const links = new BrowserLinks(pool as never);
  const a = await links.link(U, "br-1", S1);
  assert.deepEqual(a, { link: { nodeId: "br-1", sessionId: S1, projectId: P1 }, replacedNode: null });
  await links.link(U, "br-1", S2); // two agents may share a node
  assert.deepEqual((await links.list(U, P1)).map((l) => [l.nodeId, l.sessionId]), [["br-1", S1], ["br-1", S2]]);
  assert.deepEqual(await links.link(U, "br-1", S1), { link: a.link, replacedNode: null }, "idempotent");
  const moved = await links.link(U, "br-2", S1);
  assert.equal(moved.replacedNode, "br-1", "an agent drives one node: linking it elsewhere replaces the earlier wire");
  assert.equal(await links.nodeOf(U, S1), "br-2");
  assert.deepEqual((await links.forUser(U)).map((l) => l.nodeId).sort(), ["br-1", "br-2"]);
  await assert.rejects(() => links.link(U, "br-1", S3), (e: { status?: number }) => e.status === 404, "another user's agent cannot be wired");
  await assert.rejects(() => links.link(OTHER, "br-1", S1), (e: { status?: number }) => e.status === 404);
  await assert.rejects(() => links.link(U, "../x", S1), (e: { status?: number }) => e.status === 400);
  await assert.rejects(() => links.link(U, "br-1", "nope"), (e: { status?: number }) => e.status === 400);
  await links.unlink(U, "br-2", S1);
  assert.equal(await links.nodeOf(U, S1), null);
  assert.deepEqual(await links.removeNode(U, "br-1"), [S2], "closing a node drops its wires and reports who was wired");
  assert.deepEqual(await links.list(U), []);
  await links.link(U, "br-3", S2);
  await db.query(`DELETE FROM agent_sessions WHERE id = $1`, [S2]);
  assert.deepEqual(await links.list(U), [], "wires die with the agent session");
});

test("a linked agent's wired context lists the browser, and loses it when unlinked", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const links = new BrowserLinks(pool as never);
  const store = { get: async () => null, put: async () => undefined, delete: async () => undefined };
  const wired = new WiredContext(pool as never, store as never);
  assert.equal((await wired.sync(U, S1)).block, "");
  await links.link(U, "br-1", S1);
  const on = await wired.sync(U, S1);
  assert.match(on.block, /- browser "Browser" \(node br-1/);
  assert.match(on.block, /floq-browser MCP tools drive THIS page/);
  assert.deepEqual(on.added.map((r) => [r.kind, r.id]), [["browser", "br-1"]]);
  assert.equal((await wired.sync(U, S2)).block, "", "other agents are not told about it");
  await links.unlink(U, "br-1", S1);
  assert.equal((await wired.sync(U, S1)).block, "");
});
