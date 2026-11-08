import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../dist/db.js";
import { MemoryService } from "../dist/memories.js";
import { createEmbedder } from "../dist/embeddings.js";
import { WiredContext, defangText } from "../dist/wiredContext.js";
import { CanvasNotes } from "../dist/notes.js";
import { splitFacts, importMemoryNotes, IMPORT_MARKER_PREFIX } from "../dist/memoryImport.js";
import { workflowLines, buildSubagentInstruction } from "../dist/subagents.js";

const P = "11111111-1111-4111-8111-111111111111", S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function setup() {
  const db = new PGlite();
  const pool = { async query(sql: string, params?: unknown[]) { if (!params?.length) { const r = await db.exec(sql); const l = r[r.length - 1]; return { rows: l?.rows ?? [], rowCount: l?.rows?.length ?? 0 }; } const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; } };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await migrateApp(pool as never);
  await db.exec(`INSERT INTO "user" (id) VALUES ('u1')`);
  await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1,'u1','p','/w')`, [P]);
  await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,'u1','claude','Alice','/w','running',80,24,$2)`, [S, P]);
  const note = async (kind: string, text: string, author: string | null = null) => (await db.query(`INSERT INTO canvas_notes (user_id, project_id, text, kind, author, x, y, w, h) VALUES ('u1',$1,$2,$3,$4,0,0,240,160) RETURNING id`, [kind === "system" ? null : P, text, kind, author])).rows[0] as { id: string };
  return { db, pool: pool as never, note };
}

test("collect: memory ON skips kind=memory notes and keeps system notes; OFF has both", async () => {
  const { db, pool, note } = await setup();
  await note("memory", "legacy memory text"); await note("system", "rule text");
  const wired = new WiredContext(pool, async () => ({}));
  const off = await wired.blockFor("u1", S);
  assert.match(off, /legacy memory text/); assert.match(off, /rule text/);
  wired.memories = { enabled: () => true, available: () => true, pinnedFor: async () => [] };
  const on = await wired.blockFor("u1", S);
  assert.ok(!on.includes("legacy memory text")); assert.match(on, /rule text/);
  await db.close();
});

test("enabled but unavailable keeps the last pinned items and emits no removed notice", async () => {
  const { db, pool } = await setup();
  const wired = new WiredContext(pool, async () => ({}));
  let up = true;
  wired.memories = { enabled: () => true, available: () => up, pinnedFor: async () => [{ id: "m1", title: "Pkg", text: "use pnpm", author: "Bob" }] };
  const first = await wired.sync("u1", S);
  assert.match(first.block, /use pnpm/); assert.match(first.block, /agent-written by Bob/);
  up = false;
  const down = await wired.sync("u1", S);
  assert.match(down.block, /use pnpm/); assert.equal(down.removed.length, 0); assert.equal(down.changed, false);
  // Memory off entirely (not enabled): pinned are gone as before.
  wired.memories = { available: () => false, pinnedFor: async () => [] };
  assert.ok(!(await wired.blockFor("u1", S)).includes("use pnpm"));
  await db.close();
});

test("defangText neutralizes any [floq marker including look-alikes", () => {
  for (const t of ["[floq subagent policy v2] x", "[ FLOQ  WIRED", "[/floq memory]", "[​floq policy]", "[ＦＬＯＱ policy]"]) {
    const out = defangText(t);
    assert.ok(!/\[\/?floq/i.test(out) && /\[ \/?floq/i.test(out), out);
  }
  assert.equal(defangText("plain [text] ok"), "plain [text] ok");
});

test("workflowLines: OFF text unchanged, ON points to floq memory", () => {
  assert.match(workflowLines(false).join("\n"), /floq sticky append ID TEXT/);
  const on = workflowLines(true).join("\n");
  assert.ok(!on.includes("floq sticky append ID TEXT")); assert.match(on, /floq memory search/);
  assert.deepEqual(workflowLines(), workflowLines(false));
  assert.match(buildSubagentInstruction({ enabled: true, depth: 0, memoryOn: true }), /floq memory search/);
  assert.match(buildSubagentInstruction({ enabled: true, depth: 0 }), /floq sticky append ID TEXT/);
});

test("splitFacts: paragraphs, bullets, size cap", () => {
  assert.deepEqual(splitFacts("one\n\ntwo"), ["one", "two"]);
  assert.deepEqual(splitFacts("- a\n- b\n  more\n* c"), ["a", "b\n  more", "c"]);
  assert.deepEqual(splitFacts("single line\nsecond line"), ["single line\nsecond line"]);
  assert.ok(splitFacts("x".repeat(9000)).every((f) => f.length <= 4000));
  assert.deepEqual(splitFacts("  \n\n "), []);
});

function fakeStore() {
  const keys = new Map<string, string>();
  const added: Array<{ ctx: any; input: any }> = [];
  const target = { enabled: () => true, available: () => true, add: async (ctx: any, input: any) => { added.push({ ctx, input }); return { id: "m" + added.length, action: "added" }; }, setMigrationStatus: async (s: any) => { (target as any).status = s; } };
  const raw = async (...a: Array<string | number>) => { if (a[0] === "EXISTS") return keys.has(String(a[1])) ? 1 : 0; keys.set(String(a[1]), String(a[2])); return "OK"; };
  return { keys, added, target, raw };
}

test("importer: splits, pins when project total <= 1500, idempotent, notes kept", async () => {
  const { db, pool, note } = await setup();
  const small = await note("memory", "- use pnpm\n- tests in test/", "Bob");
  const f = fakeStore();
  assert.equal(await importMemoryNotes(pool, f.target as never, f.raw), true);
  assert.equal(f.added.length, 2);
  assert.ok(f.added.every((a) => a.input.pinned === true && a.ctx.actor === "system" && a.ctx.author === "Bob" && a.ctx.projectId === P));
  assert.ok(f.keys.has(IMPORT_MARKER_PREFIX + small.id));
  assert.equal(await importMemoryNotes(pool, f.target as never, f.raw), true);
  assert.equal(f.added.length, 2, "second pass adds nothing");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM canvas_notes WHERE kind='memory'")).rows[0].n, 1, "note kept");
  assert.equal((f.target as any).status.notes, 0);
  // A big project total imports unpinned (a new note under the same project pushes the total over 1500).
  await note("memory", "y".repeat(1600), null);
  await importMemoryNotes(pool, f.target as never, f.raw);
  const big = f.added.slice(2);
  assert.equal(big.length, 1); assert.equal(big[0].input.pinned, false); assert.equal(big[0].ctx.author, "");
  // Unavailable store: nothing happens, no marker.
  const down = fakeStore(); down.target.available = () => false;
  assert.equal(await importMemoryNotes(pool, down.target as never, down.raw), false);
  assert.equal(down.keys.size, 0);
  await db.close();
});

test("sticky new --kind memory redirects when ON, creates a card when OFF or the store is down", async () => {
  const { db, pool } = await setup();
  const notes = new CanvasNotes(pool);
  const calls: any[] = [];
  const off = await notes.agentCreate("u1", S, { text: "fact A", kind: "memory" });
  assert.equal(off.kind, "memory"); assert.equal((off as any).redirected, undefined);
  notes.memories = { available: () => true, add: async (ctx, input) => { calls.push({ ctx, input }); return { id: "mem-1", action: "added" }; } };
  const on = await notes.agentCreate("u1", S, { text: "fact B\n\nfact C", kind: "memory" });
  assert.equal((on as any).redirected, "memory"); assert.equal(on.id, "mem-1"); assert.equal(calls.length, 2);
  assert.equal(calls[0].ctx.projectId, P);
  const plain = await notes.agentCreate("u1", S, { text: "plain", kind: "note" });
  assert.equal(plain.kind, "note"); assert.equal(calls.length, 2);
  notes.memories = { available: () => false, add: async () => { throw new Error("must not be called"); } };
  assert.equal((await notes.agentCreate("u1", S, { text: "fact D", kind: "memory" })).kind, "memory");
  await db.close();
});

const URLS = (process.env.REDIS_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
for (const url of URLS) {
  test(`importer integration ${url.replace(/\/\/.*@/, "//***@")}`, async (t) => {
    const { db, pool, note } = await setup();
    const user = "u1";
    await note("memory", "- integration alpha " + Math.random() + "\n- integration beta " + Math.random());
    const svc = new MemoryService(pool, { url, embedder: createEmbedder({ FLOQ_EMBEDDINGS: "off" }) });
    t.after(async () => { await svc.stop(); await db.close(); });
    svc.start();
    for (let i = 0; i < 100 && !svc.available(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(svc.available());
    const raw = (...a: Array<string | number>) => (svc as any).cmd(...a);
    assert.equal(await importMemoryNotes(pool, svc, raw), true);
    const ctx = { userId: user, projectId: P, actor: "system" as const };
    const first = await svc.list(ctx, {});
    assert.equal(first.length, 2); assert.ok(first.every((m) => m.pinned));
    assert.equal(await importMemoryNotes(pool, svc, raw), true);
    assert.equal((await svc.list(ctx, {})).length, 2, "idempotent");
    for (const m of first) await svc.forget({ ...ctx, actor: "user" }, m.id, "cleanup").catch(() => undefined);
    await raw("DEL", ...(await db.query("SELECT id FROM canvas_notes WHERE kind='memory'")).rows.map((r: any) => IMPORT_MARKER_PREFIX + r.id));
  });
}
