import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { HttpError } from "../src/errors.ts";

const requireCjs = createRequire(import.meta.url);
const ptyId = requireCjs.resolve("node-pty");
requireCjs.cache[ptyId] = { id: ptyId, filename: ptyId, loaded: true, children: [], paths: [], exports: { spawn: () => ({ pid: 1 }) } };
const { Orchestrator } = await import("../src/orchestrator.ts");

const TARGET = "33333333-3333-4333-8333-333333333333";
const row = { id: TARGET, title: "Lead", provider: "claude", model: null, state: "running", lead: true, role: null, cwd: "x", git_url: null, project_cwd: "x", project_id: "p", project_name: "X", workspace_id: null };

function build({ live, connected = true, resumeThrows = null }) {
  const typed = [];
  const outboxRows = new Map();
  const state = { live, resumed: 0 };
  const pool = { query: async (sql) => (/FROM agent_sessions/.test(sql) ? { rows: [row] } : { rows: [] }) };
  const mkLive = () => ({ isAlive: true, provider: "claude", write: (d) => typed.push(d), replaySince: () => ({ chunks: [{ data: "ready" }] }), lastActivity: 0 });
  const manager = {
    findLive: () => state.live,
    assertProviderConnected: async () => { if (!connected) throw new HttpError(409, "provider_not_connected", "Claude Code is not connected"); },
    resume: async () => { state.resumed++; if (resumeThrows) throw resumeThrows; state.live = mkLive(); },
  };
  const outbox = {
    async enqueue(userId, to, kind, text) { const id = String(outboxRows.size + 1); outboxRows.set(id, { userId, to, kind, text, delivered: false }); return id; },
    async pending(userId, sessionId) { return [...outboxRows].filter(([, r]) => r.to === sessionId && !r.delivered).map(([id, r]) => ({ id, userId, toSessionId: sessionId, kind: r.kind, text: r.text, attempts: 0, ageMs: 0 })); },
    async expire() {}, async attempt() {},
    async markDelivered(id) { outboxRows.get(id).delivered = true; return true; },
    async isDelivered(id) { return outboxRows.get(id)?.delivered ?? false; },
  };
  const stored = [];
  const inbox = { async store(userId, from, to, body) { stored.push(body); return { id: "0123456789abcdef", chars: body.length, sha256: "x" }; } };
  const orchestrator = new Orchestrator(pool, manager, { async profile() { return {}; } }, undefined, undefined, inbox, { quietMs: 0, timeoutMs: 200, pollMs: 5 }, outbox);
  return { orchestrator, typed, outboxRows, state, stored, mkLive };
}
const from = { id: "task-1", title: "Floq tasks" };

test("deliverSystem types into a live agent and reports delivered", async () => {
  const h = build({});
  h.state.live = h.mkLive();
  assert.equal(await h.orchestrator.deliverSystem("u", TARGET, from, "Task abc: do it"), "delivered");
  assert.ok(h.typed.join("").includes("[Message from Floq tasks] Task abc: do it"));
  assert.equal(h.state.resumed, 0);
});

test("deliverSystem wakes a sleeping agent, then delivers", async () => {
  const h = build({ live: undefined });
  assert.equal(await h.orchestrator.deliverSystem("u", TARGET, from, "Task abc: do it"), "delivered");
  assert.equal(h.state.resumed, 1);
});

test("deliverSystem refuses (queues nothing) when the provider is not connected", async () => {
  const h = build({ live: undefined, connected: false });
  await assert.rejects(h.orchestrator.deliverSystem("u", TARGET, from, "x"), (e) => e.code === "provider_not_connected");
  assert.equal(h.outboxRows.size, 0);
  assert.equal(h.state.resumed, 0);
});

test("deliverSystem keeps the message queued when the wake fails for another reason", async () => {
  const h = build({ live: undefined, resumeThrows: new Error("shard unavailable") });
  assert.equal(await h.orchestrator.deliverSystem("u", TARGET, from, "x"), "queued");
  assert.equal(h.outboxRows.size, 1);
});

test("deliverSystem moves long bodies to the inbox and types a preview", async () => {
  const h = build({});
  h.state.live = h.mkLive();
  const long = "word ".repeat(600);
  assert.equal(await h.orchestrator.deliverSystem("u", TARGET, from, long), "delivered");
  assert.equal(h.stored.length, 1);
  assert.ok(h.typed.join("").includes("floq inbox read 0123456789abcdef"));
});
