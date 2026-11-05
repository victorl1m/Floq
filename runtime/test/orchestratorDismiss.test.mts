import assert from "node:assert/strict";
import test from "node:test";
import { Orchestrator } from "../src/orchestrator.ts";

// lead L recruited orchestrator O; O recruited R, R recruited G; S is an unrelated agent of the same project;
// X lives in another project.
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const ids = { L: "aaaaaaaa-0000-4000-8000-000000000001", O: "aaaaaaaa-0000-4000-8000-000000000002", R: "aaaaaaaa-0000-4000-8000-000000000003", G: "aaaaaaaa-0000-4000-8000-000000000004", S: "aaaaaaaa-0000-4000-8000-000000000005", X: "aaaaaaaa-0000-4000-8000-000000000006" };
const row = (id: string, title: string, lead: boolean, parent: string | null, project = P) => ({
  id, title, provider: "claude", model: null, state: "running", lead, role: null, cwd: project === P ? "workspace/p" : "workspace/q", git_url: null,
  project_cwd: project === P ? "workspace/p" : "workspace/q", project_id: project, workspace_id: null, project_name: "p", parent_session_id: parent, user_id: "u",
});
const ROWS = [
  row(ids.L, "Lead", true, null),
  row(ids.O, "Orchestrator", false, ids.L),
  row(ids.R, "Reviewer", false, ids.O),
  row(ids.G, "Grandchild", false, ids.R),
  row(ids.S, "Sibling", false, ids.L),
  row(ids.X, "Elsewhere", false, ids.O, Q),
];

function harness() {
  const removed: string[] = [];
  const pool = { query: async (_sql: string, params: unknown[]) => ({ rows: ROWS.filter((r) => r.user_id === params[0] && !removed.includes(r.id)) }) };
  const manager = { remove: async (id: string) => { removed.push(id); }, findLive: () => undefined, onSessionReady: () => undefined };
  const orchestrator = new Orchestrator(pool as never, manager as never, {} as never);
  return { orchestrator, removed };
}
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

test("a non-lead orchestrator dismisses the agents it recruited, directly or through its recruits", async () => {
  const h = harness();
  assert.deepEqual(await h.orchestrator.dismiss("u", ids.O, ids.G), { ok: true });
  assert.deepEqual(h.removed, [ids.G]);
});

test("dismissing a recruit also removes that recruit's own recruits, deepest first", async () => {
  const h = harness();
  assert.deepEqual(await h.orchestrator.dismiss("u", ids.O, ids.R), { ok: true });
  assert.deepEqual(h.removed, [ids.G, ids.R]);
});

test("a non-lead orchestrator cannot dismiss agents it did not recruit, itself, or another project's agents", async () => {
  const h = harness();
  await assert.rejects(h.orchestrator.dismiss("u", ids.O, ids.S), code("not_recruiter"));
  await assert.rejects(h.orchestrator.dismiss("u", ids.O, ids.L), code("not_recruiter"));
  await assert.rejects(h.orchestrator.dismiss("u", ids.R, ids.O), code("not_recruiter"));
  await assert.rejects(h.orchestrator.dismiss("u", ids.O, ids.O), (e: { status?: number }) => e.status === 400);
  await assert.rejects(h.orchestrator.dismiss("u", ids.O, ids.X), code("other_project"));
  assert.deepEqual(h.removed, []);
});

test("a lead still dismisses any agent of its project", async () => {
  const h = harness();
  assert.deepEqual(await h.orchestrator.dismiss("u", ids.L, ids.S), { ok: true });
  assert.deepEqual(await h.orchestrator.dismiss("u", ids.L, ids.G), { ok: true });
  assert.deepEqual(h.removed, [ids.S, ids.G]);
});
