import assert from "node:assert/strict";
import test from "node:test";
import { Orchestrator } from "../src/orchestrator.ts";
import { AgentOutbox } from "../src/messageDelivery.ts";

const OA = "aaaaaaaa-0000-4000-8000-000000000001", OB = "bbbbbbbb-0000-4000-8000-000000000002";
const row = (id: string, title: string, projectId: string | null, org: string | null, cwd: string) => ({
  id, title, provider: "claude", model: null, state: "running", lead: false, role: null, cwd, git_url: null, project_cwd: cwd,
  project_id: projectId, workspace_id: null, project_name: projectId ? cwd : null, org_id: org, user_id: "u1",
});
const S1 = "11111111-1111-1111-1111-111111111111", S2 = "11111111-1111-1111-1111-222222222222", S3 = "22222222-2222-2222-2222-222222222222", SCRATCH = "33333333-3333-3333-3333-333333333333";
const ROWS = [
  row(S1, "Alpha One", "p1", OA, "alpha"),
  row(S2, "Alpha Two", "p1", OA, "alpha"),
  row(S3, "Beta Dev", "p2", OB, "beta"),
  row(SCRATCH, "Scratch", null, null, "home"),
];

class MemoryOutbox extends AgentOutbox {
  rows = new Map<string, { userId: string; toSessionId: string; kind: "message" | "approval"; text: string; delivered: boolean; at: number }>();
  constructor() { super({ query: async () => ({ rows: [] }) } as never); }
  async enqueue(userId: string, toSessionId: string, kind: "message" | "approval", text: string) { const id = String(this.rows.size + 1).padStart(6, "0"); this.rows.set(id, { userId, toSessionId, kind, text, delivered: false, at: Date.now() }); return id; }
  async pending() { return []; }
  async expire() {}
  async attempt() {}
  async markDelivered(id: string) { const r = this.rows.get(id); if (!r || r.delivered) return false; r.delivered = true; return true; }
  async isDelivered(id: string) { return this.rows.get(id)?.delivered ?? false; }
}

function harness(allowCross = true, personal: string | null = OA, rows: typeof ROWS = ROWS) {
  const typed: string[] = [];
  const pool = { query: async (sql: string, params: unknown[]) => (/collaboration\.organizations/.test(sql) ? { rows: personal ? [{ personal_org_id: personal }] : [] } : { rows: rows.filter((r) => r.user_id === params[0]) }) };
  const live = { isAlive: true, state: "running", lastActivity: 0, id: S3, subscribe: () => () => undefined, write: (data: string) => { if (data.length > 1) typed.push(data); }, replaySince: () => ({ chunks: [] }) };
  const manager = { findLive: () => live, readAgentTurn: () => null, resume: async () => undefined };
  const settings = { get: async () => ({ allowCrossProjectAgents: allowCross }), profile: async () => ({}) };
  const links = { record: async () => undefined, upsert: async () => ({ id: "link1" }) };
  const orchestrator = new Orchestrator(pool as never, manager as never, settings as never, links as never, undefined, undefined, undefined, undefined, new MemoryOutbox());
  return { orchestrator, typed };
}

const refused = (promise: Promise<unknown>, text?: RegExp) =>
  assert.rejects(promise, (e: { status?: number; code?: string; message?: string }) => e.status === 403 && e.code === "cross_org_disabled" && (!text || text.test(e.message ?? "")));

test("list hides agents of other organizations even with cross-project on; scratch agents count as personal", async () => {
  const { orchestrator } = harness(true);
  assert.deepEqual((await orchestrator.list("u1", S1)).map((a) => a.id).sort(), [S1, S2, SCRATCH].sort());
  assert.deepEqual((await orchestrator.list("u1", S3)).map((a) => a.id), [S3], "the only agent of its org");
  assert.deepEqual((await orchestrator.list("u1", SCRATCH)).map((a) => a.id).sort(), [S1, S2, SCRATCH].sort());
});

test("ask and approval targets across organizations are refused with cross_org_disabled", async () => {
  const { orchestrator, typed } = harness(true);
  await refused(orchestrator.ask("u1", S1, "Beta Dev", "hello", 10, false), /"Beta Dev" is in a different organization/);
  await refused(orchestrator.ask("u1", S3, S1, "hello", 10, false));
  await refused(orchestrator.approvalParties("u1", S1, "Beta Dev"));
  assert.equal(typed.length, 0, "nothing was typed into the other org's terminal");
});

test("same org across projects is still governed by the cross-project setting", async () => {
  const on = harness(true);
  const sent = await on.orchestrator.ask("u1", SCRATCH, "Alpha One", "hi", 10, false);
  assert.ok(["sent", "queued"].includes(sent.status), "delivered or queued, not refused");
  const off = harness(false);
  await assert.rejects(off.orchestrator.ask("u1", SCRATCH, "Alpha One", "hi", 10, false), (e: { code?: string }) => e.code === "cross_project_disabled");
  await assert.rejects(off.orchestrator.ask("u1", S1, "Beta Dev", "x", 10, false), (e: { code?: string }) => e.code === "cross_org_disabled", "the org boundary is checked first");
});

const D1 = "44444444-4444-4444-4444-444444444444", D2 = "55555555-5555-5555-5555-555555555555";
const DUP_ROWS = [...ROWS, row(D1, "Twin", "p1", OA, "alpha"), row(D2, "Twin", "p2", OB, "beta")];

test("name resolution ignores agents of other organizations; ids of other organizations are 403", async () => {
  const { orchestrator } = harness(true, OA, DUP_ROWS);
  // same name in two orgs: no ambiguity 409 and never the other org's agent
  const sent = await orchestrator.ask("u1", S1, "Twin", "hi", 10, false);
  assert.ok(["sent", "queued"].includes(sent.status));
  assert.equal(sent.id, D1);
  // a name that only exists in another org is simply not found
  await refused(orchestrator.ask("u1", S1, "Beta Dev", "x", 10, false));
  await refused(orchestrator.ask("u1", S1, D2, "x", 10, false));
});

test("assertProjectInCallerOrg: own project and same-org pass, other org 403, foreign or unknown project 404", async () => {
  const pool = { query: async (_sql: string, params: unknown[]) => ({ rows: params[0] === "pOther" ? [{ org: OB }] : params[0] === "pSame" ? [{ org: OA }] : [] }) };
  const orchestrator = new Orchestrator(pool as never, {} as never, {} as never, {} as never);
  const me = { projectId: "pMine", orgId: OA };
  await orchestrator.assertProjectInCallerOrg("u1", me, "pMine");
  await orchestrator.assertProjectInCallerOrg("u1", me, "pSame");
  await assert.rejects(orchestrator.assertProjectInCallerOrg("u1", me, "pOther"), (e: { status?: number; code?: string }) => e.status === 403 && e.code === "cross_org_disabled");
  await assert.rejects(orchestrator.assertProjectInCallerOrg("u1", me, "nope"), (e: { status?: number }) => e.status === 404);
});
