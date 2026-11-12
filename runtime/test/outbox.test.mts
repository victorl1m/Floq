import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { CrossProjectGuard } from "../src/crossProject.ts";
import { MessageInbox } from "../src/messageDelivery.ts";
import { Approvals } from "../src/approvals.ts";

const U = "user-1";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P1 = "11111111-1111-4111-8111-111111111111";

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
  for (const [id, title] of [[A, "Alpha"], [B, "Beta"]]) await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows) VALUES ($1,$2,'claude',$3,'proj','running',80,24)`, [id, U, title]);
  return { db, pool };
}

function fakeLive() {
  const writes: string[] = [];
  return { writes, live: { isAlive: true, state: "running", lastActivity: 0, id: B, provider: "claude", subscribe: () => () => undefined, write: (d: string) => writes.push(d), replaySince: () => ({ chunks: [{ data: "ready" }] }) } };
}

function makeOrch(pool: unknown, state: { live?: unknown; resumeFails?: boolean; resumed: number }) {
  const manager = {
    findLive: () => state.live,
    readAgentTurn: () => null,
    resume: async () => { state.resumed++; if (state.resumeFails) throw new Error("boom"); },
  };
  const settings = { get: async () => ({ allowCrossProjectAgents: true }), profile: async () => ({}) };
  const links = { record: async () => undefined, upsert: async () => ({ id: "l" }) };
  return new Orchestrator(pool as never, manager as never, settings as never, links as never, new CrossProjectGuard(), new MessageInbox(pool as never), { quietMs: 0, timeoutMs: 500, pollMs: 5 });
}

test("a message to an asleep agent is queued, then typed once when the agent is live and ready", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const state: { live?: unknown; resumeFails?: boolean; resumed: number } = { resumeFails: true, resumed: 0 };
  const orch = makeOrch(pool, state);
  const r = await orch.ask(U, A, B, "please build X", 10, false);
  assert.equal(r.status, "queued");
  assert.equal((await orch.outbox.pending(U, B)).length, 1);
  const { writes, live } = fakeLive();
  state.live = live;
  const d1 = await orch.deliverPending(U, B);
  assert.equal(d1.delivered.length, 1);
  assert.ok(/\[Message from agent Alpha \(session [0-9a-f-]+\)\] please build X/.test(writes.join("")));
  const before = writes.length;
  const d2 = await orch.deliverPending(U, B);
  assert.equal(d2.delivered.length, 0);
  assert.equal(writes.length, before, "no double typing");
  assert.equal((await orch.outbox.pending(U, B)).length, 0);
});

test("ask wakes a sleeping agent, waits for readiness and delivers without a fixed sleep", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const { writes, live } = fakeLive();
  const state: { live?: unknown; resumed: number } = { resumed: 0 };
  const orch = makeOrch(pool, state);
  const manager = (orch as unknown as { manager: { resume: () => Promise<void> } }).manager;
  manager.resume = async () => { state.resumed++; state.live = live; };
  const started = Date.now();
  const r = await orch.ask(U, A, B, "wake up", 10, false);
  assert.equal(r.status, "sent");
  assert.equal(state.resumed, 1);
  assert.ok(Date.now() - started < 3000);
  assert.ok(writes.join("").includes("wake up"));
});

test("a session that never becomes ready keeps the message pending", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const writes: string[] = [];
  const silent = { isAlive: true, state: "running", lastActivity: Date.now(), id: B, provider: "claude", subscribe: () => () => undefined, write: (d: string) => writes.push(d), replaySince: () => ({ chunks: [] }) };
  const state: { live?: unknown; resumed: number } = { resumed: 0 };
  const orch = makeOrch(pool, state);
  (orch as unknown as { manager: { resume: () => Promise<void> } }).manager.resume = async () => { state.live = silent; };
  const r = await orch.ask(U, A, B, "hello?", 10, false);
  assert.equal(r.status, "queued");
  assert.equal(writes.length, 0);
  assert.equal((await orch.outbox.pending(U, B)).length, 1);
});

test("a new orchestrator over the same database redelivers pending rows in order (runtime restart)", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const first = makeOrch(pool, { resumeFails: true, resumed: 0 });
  await first.ask(U, A, B, "one", 10, false);
  await first.ask(U, A, B, "two", 10, false);
  const { writes, live } = fakeLive();
  const second = makeOrch(pool, { live, resumed: 0 });
  const r = await second.deliverPending(U, B);
  assert.equal(r.delivered.length, 2);
  const text = writes.join("");
  assert.ok(text.indexOf("one") >= 0 && text.indexOf("one") < text.indexOf("two"));
  assert.equal((await second.deliverPending(U, B)).delivered.length, 0);
});

test("concurrent deliverPending calls type a row exactly once", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const orch = makeOrch(pool, { resumeFails: true, resumed: 0 });
  await orch.ask(U, A, B, "only once", 10, false);
  const { writes, live } = fakeLive();
  (orch as unknown as { manager: { findLive: () => unknown } }).manager.findLive = () => live;
  await Promise.all([orch.deliverPending(U, B), orch.deliverPending(U, B), orch.deliverPending(U, B)]);
  assert.equal(writes.join("").split("only once").length - 1, 1);
});

test("an approval decision for a dead session stays pending and is typed on resume; verify is unchanged", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const state: { live?: unknown; resumed: number } = { resumed: 0 };
  const orch = makeOrch(pool, state);
  const approvals = new Approvals({ pool: pool as never, deliver: (u, s, text) => orch.deliverApproval(u, s, text), isAlive: () => true });
  const agent = (id: string, name: string) => ({ id, name, provider: "claude" as const, projectId: P1, projectName: "p" });
  const { id } = await approvals.request(U, { requester: agent(A, "Alpha"), target: agent(B, "Beta"), action: "git push origin main" });
  await approvals.resolve(U, id, "allow");
  await new Promise((r) => setTimeout(r, 50));
  const queued = await orch.outbox.pending(U, B);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "approval");
  const { writes, live } = fakeLive();
  state.live = live;
  await orch.deliverPending(U, B);
  assert.ok(writes.join("").includes("[FLOQ APPROVAL " + id), "trusted marker typed, not neutralized");
  assert.equal((await orch.outbox.pending(U, B)).filter((r) => r.kind === "approval").length, 0);
  const v = await approvals.verify(U, B, id, { consume: true });
  assert.equal(v.status, "GRANTED");
  assert.equal(v.valid, true);
  assert.equal((await approvals.verify(U, B, id, { consume: true })).status, "CONSUMED");
  await new Promise((r) => setTimeout(r, 100)); // let fire-and-forget approval persists finish before the db closes
});

test("old rows are expired, not typed: messages after 24h, approvals after 15 minutes", async (t) => {
  const { db, pool } = await setup();
  t.after(() => db.close());
  const orch = makeOrch(pool, { resumeFails: true, resumed: 0 });
  const oldMsg = await orch.outbox.enqueue(U, B, "message", "ancient message");
  const midMsg = await orch.outbox.enqueue(U, B, "message", "two hours old");
  const oldApproval = await orch.outbox.enqueue(U, B, "approval", "[FLOQ APPROVAL stale] old");
  const freshApproval = await orch.outbox.enqueue(U, B, "approval", "[FLOQ APPROVAL fresh] new");
  await db.query("UPDATE agent_outbox SET created_at = now() - interval '25 hours' WHERE id = $1", [oldMsg]);
  await db.query("UPDATE agent_outbox SET created_at = now() - interval '2 hours' WHERE id = $1", [midMsg]);
  await db.query("UPDATE agent_outbox SET created_at = now() - interval '16 minutes' WHERE id = $1", [oldApproval]);
  const { writes, live } = fakeLive();
  (orch as unknown as { manager: { findLive: () => unknown } }).manager.findLive = () => live;
  const r = await orch.deliverPending(U, B);
  const text = writes.join("");
  assert.ok(!text.includes("ancient message") && !text.includes("stale"));
  assert.ok(text.includes("two hours old") && text.includes("fresh"));
  assert.equal(r.delivered.length, 2);
  const rows = (await db.query("SELECT id, expired_at, delivered_at FROM agent_outbox")).rows as Array<{ id: string; expired_at: unknown; delivered_at: unknown }>;
  const by = (id: string) => rows.find((x) => x.id === id)!;
  assert.ok(by(oldMsg).expired_at && !by(oldMsg).delivered_at);
  assert.ok(by(oldApproval).expired_at && !by(oldApproval).delivered_at);
  assert.ok(by(midMsg).delivered_at && by(freshApproval).delivered_at);
  assert.equal((await orch.outbox.pending(U, B)).length, 0);
});
