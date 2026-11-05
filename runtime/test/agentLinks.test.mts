import test from "node:test";
import assert from "node:assert/strict";
import { AgentLinks, EventHub, authorizeManualLink, makePreview, mergeLink, type AgentMessageEvent } from "../src/links.ts";

const make = () => ({ id: "l1", projectId: "p1", fromSessionId: "a", toSessionId: "b" });
const NOW = "2026-01-01T00:00:00.000Z";

test("preview is single line, trimmed, ANSI free and capped at 200 chars", () => {
  assert.equal(makePreview("  hello\n\n  world\t!\u001b[31m "), "hello world !");
  const long = makePreview("x".repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
  assert.equal(makePreview(null), "");
});

test("link upsert: new link takes the kind, messages bump count, existing kind is kept", () => {
  const created = mergeLink(null, "message", "message", NOW, make);
  assert.deepEqual([created.kind, created.messageCount, created.lastMessageAt], ["message", 1, NOW]);
  const recruit = mergeLink(null, "recruit", "none", NOW, make);
  assert.deepEqual([recruit.kind, recruit.messageCount, recruit.lastMessageAt], ["recruit", 0, null]);
  const after = mergeLink(recruit, "message", "message", "later", make);
  assert.deepEqual([after.kind, after.messageCount, after.lastMessageAt], ["recruit", 1, "later"]);
  const reply = mergeLink(after, "message", "reply", "later2", make);
  assert.deepEqual([reply.messageCount, reply.lastMessageAt], [1, "later2"]);
  const wire = mergeLink(reply, "manual", "none", "never", make);
  assert.deepEqual([wire.kind, wire.messageCount, wire.lastMessageAt], ["recruit", 1, "later2"]);
});

const ev = (n: number, projectId = "p1"): AgentMessageEvent => ({ type: "agent-message", linkId: "l", fromSessionId: "a", toSessionId: "b", projectId, kind: "ask", preview: String(n), at: NOW });

test("event hub keeps a per-project ring buffer, scoped per user", () => {
  const hub = new EventHub(5);
  for (let i = 0; i < 8; i++) hub.publish("u1", ev(i));
  hub.publish("u2", ev(99));
  hub.publish("u1", ev(1000, "p2"));
  assert.deepEqual(hub.recent("u1", "p1", 50).map((e) => e.preview), ["4", "5", "6", "7"]); // cap 5 kept, one belongs to u2
  assert.deepEqual(hub.recent("u1", "p1", 2).map((e) => e.preview), ["6", "7"]);
  assert.deepEqual(hub.recent("u2", "p1").map((e) => e.preview), ["99"]);
  assert.deepEqual(hub.recent("u3", "p1"), []);
  assert.deepEqual(hub.recent("u1", "p2").map((e) => e.preview), ["1000"]);
});

test("event hub streams only to the owning user and unsubscribes", () => {
  const hub = new EventHub();
  const mine: string[] = [];
  const other: string[] = [];
  const off = hub.subscribe("u1", (e) => mine.push(e.preview));
  hub.subscribe("u2", (e) => other.push(e.preview));
  hub.publish("u1", ev(1));
  off();
  hub.publish("u1", ev(2));
  assert.deepEqual(mine, ["1"]);
  assert.deepEqual(other, []);
});

test("manual links require both sessions owned by the caller, distinct, in one project", () => {
  const s = (id: string, user_id: string, project_id: string | null) => ({ id, user_id, project_id });
  assert.doesNotThrow(() => authorizeManualLink("u1", s("a", "u1", "p"), s("b", "u1", "p")));
  assert.throws(() => authorizeManualLink("u1", s("a", "u1", "p"), s("a", "u1", "p")), /itself/);
  assert.throws(() => authorizeManualLink("u1", s("a", "u1", "p"), s("b", "u2", "p")), /not found/i);
  assert.throws(() => authorizeManualLink("u1", s("a", "u1", "p"), undefined), /not found/i);
  assert.throws(() => authorizeManualLink("u1", s("a", "u1", "p"), s("b", "u1", "q")), /different projects/);
  assert.throws(() => authorizeManualLink("u1", s("a", "u1", null), s("b", "u1", "p")), /different projects/);
});

test("recruit upsert creates the recruiter-to-child recruit edge and removes a stale reverse manual edge", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("SELECT id, user_id, project_id FROM agent_sessions")) return { rows: [{ id: "parent", user_id: "u1", project_id: "p1" }] };
      if (sql.includes("SELECT id, project_id, from_session_id, to_session_id, kind, created_at")) return { rows: [{ id: "l1", project_id: "p1", from_session_id: "parent", to_session_id: "child", kind: "recruit", created_at: NOW, last_message_at: null, message_count: 3 }] };
      return { rows: [] };
  };
  const pool = { connect: async () => ({ query, release: () => undefined }) };
  const service = new AgentLinks(pool as never);
  const result = await service.upsert("parent", "child", "recruit", "none");

  assert.deepEqual([result.fromSessionId, result.toSessionId, result.kind], ["parent", "child", "recruit"]);
  assert.equal(result.messageCount, 3);
  const insert = calls.find((call) => call.sql.includes("INSERT INTO agent_links"));
  assert.deepEqual(insert?.values?.slice(1, 3), ["parent", "child"]);
  assert.match(insert?.sql ?? "", /kind = 'recruit'/);
  assert.ok(calls.some((call) => /message_count = f\.message_count \+ r\.message_count/.test(call.sql)));
  assert.ok(calls.some((call) => /DELETE FROM agent_links/.test(call.sql)));
  assert.ok(calls.some((call) => call.sql === "BEGIN"));
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
});

test("recruit backfill removes a reverse edge and checks only for the canonical parent-to-child edge", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return { rows: [] }; };
  const pool = { connect: async () => ({ query, release: () => undefined }) };
  await new AgentLinks(pool as never).backfill("u1");

  const reorient = calls.find((call) => call.sql.includes("UPDATE agent_links l SET from_session_id = c.parent_session_id"));
  assert.match(reorient?.sql ?? "", /NOT EXISTS[\s\S]*f\.from_session_id = c\.parent_session_id AND f\.to_session_id = c\.id/);
  assert.deepEqual(reorient?.values, ["u1"]);
  assert.ok(calls.some((call) => /message_count = f\.message_count \+ r\.message_count/.test(call.sql)));
  assert.ok(calls.some((call) => /DELETE FROM agent_links l USING agent_sessions c/.test(call.sql)));
  const insert = calls.find((call) => call.sql.includes("INSERT INTO agent_links"));
  assert.match(insert?.sql ?? "", /ON CONFLICT \(from_session_id, to_session_id\) DO UPDATE SET kind = 'recruit'/);
  assert.ok(calls.some((call) => call.sql === "BEGIN"));
  assert.ok(calls.some((call) => call.sql === "COMMIT"));
});
