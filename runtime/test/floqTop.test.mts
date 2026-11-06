import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, parseArgs, renderTop, topRows, topState, type AgentEntry } from "../image/floq-args.mts";
import { createRequire } from "node:module";

// node-pty has no prebuild here: stub it before the orchestrator's import graph loads it.
const requireCjs = createRequire(import.meta.url);
const ptyId = requireCjs.resolve("node-pty");
requireCjs.cache[ptyId] = { id: ptyId, filename: ptyId, loaded: true, children: [], paths: [], exports: { spawn: () => ({ pid: 1 }) } } as any;
const { Orchestrator } = await import("../src/orchestrator.ts");

const now = 1_000_000_000;
const agent = (id: string, name: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({ id, name, provider: "claude", model: null, state: "running", project: { id: "p", name: "proj", same: true }, status: "idle", ...extra });

test("topState maps runtime status and pending counts", () => {
  assert.equal(topState(agent("a", "a", { status: "working" })), "working");
  assert.equal(topState(agent("a", "a", { status: "waiting-for-input" })), "waiting-for-user");
  assert.equal(topState(agent("a", "a", { status: "working", pendingApprovals: 1 })), "waiting-for-user");
  assert.equal(topState(agent("a", "a", { status: "asleep", state: "sleeping" })), "stopped");
  assert.equal(topState(agent("a", "a", { status: "exited", state: "failed" })), "error");
});

test("rows sort waiting first then working then idle, with subagents under their recruiter", () => {
  const rows = topRows([
    agent("1", "idle-lead", { status: "idle" }),
    agent("2", "busy", { status: "working" }),
    agent("3", "asker", { status: "idle", pendingDecisions: 1 }),
    agent("4", "child-of-idle", { status: "working", parentId: "1" }),
  ]);
  assert.deepEqual(rows.map((r) => r.agent.name), ["asker", "busy", "idle-lead", "child-of-idle"]);
  assert.equal(rows.find((r) => r.agent.id === "4")!.depth, 1);
});

test("a cycle in parent ids never drops or loops", () => {
  const rows = topRows([agent("1", "a", { parentId: "2" }), agent("2", "b", { parentId: "1" })]);
  assert.equal(rows.length, 2);
});

test("renderTop: summary counts, width truncation, NO_COLOR", () => {
  const agents = [agent("1", "alpha", { status: "working", startedAt: now - 3_700_000, lastLine: "x".repeat(500) }), agent("2", "beta", { pendingApprovals: 2, pendingDecisions: 1 })];
  const wide = renderTop(agents, { width: 200, color: false, now });
  assert.match(wide[0], /2 agents/);
  assert.match(wide[0], /waiting-for-user 1/);
  assert.match(wide[0], /pending approvals 2 decisions 1/);
  const plain = renderTop(agents, { width: 80, color: false, now });
  for (const l of plain) { assert.ok(l.length <= 80, l.length + ""); assert.ok(!l.includes("\u001b")); }
  assert.match(wide.join("\n"), /\[3 pending\]/);
  assert.ok(renderTop(agents, { width: 80, color: true, now }).some((l) => l.includes("\u001b[")));
  assert.deepEqual(renderTop([], { width: 40, color: false, now }).slice(-1), ["no matching agents"]);
});

test("formatDuration and --once flag parsing", () => {
  assert.equal(formatDuration(5_000), "5s");
  assert.equal(formatDuration(125_000), "2m05s");
  assert.equal(formatDuration(3_700_000), "1h01m");
  assert.equal(parseArgs(["--once", "--interval", "3"]).named.once, true);
});

test("orchestrator.list with detail adds read-only monitor fields, scoped to the caller's user", async () => {
  const row = (id: string, parent: string | null, userId = "u") => ({ id, title: id, provider: "claude", model: null, state: "running", lead: false, role: null, cwd: "workspace/p", git_url: null, project_cwd: "workspace/p", project_id: "p", workspace_id: null, project_name: "p", parent_session_id: parent, user_id: userId });
  const rows = [row("me", null), row("kid", "me"), row("other", null, "v")];
  const pool = { query: async (_s: string, params: unknown[]) => ({ rows: rows.filter((r) => r.user_id === params[0]) }) };
  const live = { isAlive: true, state: "running", lastActivity: 5, startedAtMs: 1, replaySince: () => ({ chunks: [{ data: "hello\r\nworking on it\r\n" }] }) };
  const manager = { findLive: (id: string) => (id === "kid" ? live : undefined), readAgentTurn: () => null, onSessionReady: () => undefined };
  const o = new Orchestrator(pool as never, manager as never, {} as never);
  const plain = await o.list("u", "me");
  assert.equal("status" in plain[0], false);
  const list = await o.list("u", "me", { detail: true, pending: new Map([["kid", { approvals: 1, decisions: 2 }]]) });
  assert.deepEqual(list.map((a) => a.id), ["me", "kid"]);
  const kid = list[1];
  assert.equal(kid.parentId, "me");
  assert.equal(kid.lastLine, "working on it");
  assert.equal(kid.pendingApprovals, 1);
  assert.equal(kid.pendingDecisions, 2);
  assert.equal(kid.lastActivityAt, 5);
  assert.equal(list[0].status, "asleep");
});
