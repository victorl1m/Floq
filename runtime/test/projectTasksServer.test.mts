import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";

// node-pty has no prebuild here: stub it before the server's import graph loads it.
const requireCjs = createRequire(import.meta.url);
const ptyId = requireCjs.resolve("node-pty");
requireCjs.cache[ptyId] = { id: ptyId, filename: ptyId, loaded: true, children: [], paths: [], exports: { spawn: () => ({ pid: 1 }) } };
const { createRuntimeServer } = await import("../dist/server.js");
const { Vault } = await import("../dist/vault.js");
const { Orchestrator } = await import("../dist/orchestrator.js");
const { ProjectTasks } = await import("../dist/projectTasks.js");
const { Automations } = await import("../dist/automations.js");

const key = Buffer.alloc(32, 9);
const P = "11111111-1111-4111-8111-111111111111";
const T = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_TOKEN = "user-session-token";
const SESSIONS = [{ id: "s-a", user_id: "owner", title: "Lead", provider: "claude", model: null, state: "running", lead: true, role: null, cwd: "x", git_url: null, project_cwd: "x", project_id: P, project_name: "X", workspace_id: null }];

async function freePort() {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function harness(t) {
  const calls = [];
  const rec = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === "function" ? result(...args) : result; };
  const pool = { query: async (sql) => (/FROM agent_sessions/.test(sql) ? { rows: SESSIONS } : { rows: [{ id: "org-1", role: "owner", personal_org_id: "org-1" }] }), connect: async () => { throw new Error("unused"); } };
  const projectTasks = new ProjectTasks(pool);
  Object.assign(projectTasks, {
    list: rec("list", { tasks: [], settings: {} }),
    create: rec("create", (u, p, input, who) => ({ id: T, ...input, createdBy: (who ?? { actor: "user" }).actor })),
    update: rec("update", (u, p, id, patch) => ({ id, ...patch })),
    remove: rec("remove", undefined),
    events: rec("events", []),
    comment: rec("comment", []),
    get: rec("get", { id: T }),
    putSettings: rec("putSettings", (u, p, input) => input),
    getSettings: rec("getSettings", { autoAgent: false, agentSessionId: null }),
    agentContext: async (u, sessionId) => ({ projectId: P, actor: "agent:" + sessionId, sessionId }),
  });
  const automations = new Automations(pool, projectTasks);
  Object.assign(automations, {
    list: rec("alist", []), create: rec("acreate", (u, p, b) => ({ id: "auto", ...b })), update: rec("aupdate", {}), remove: rec("aremove", undefined), runNow: rec("arun", { task: { id: T } }),
  });
  const manager = { activeCount: 0, requireProject: async () => undefined, getLive: () => ({ isAlive: true, provider: "claude" }), findLive: () => ({ isAlive: true, provider: "claude", replaySince: () => ({ chunks: [] }), write() {} }) };
  const vault = new Vault(pool, { encryptionKey: key });
  const orchestrator = new Orchestrator(pool, manager, {});
  const auth = { handler() {}, api: { getSession: async ({ headers }) => (headers.get("authorization") === "Bearer " + USER_TOKEN ? { user: { id: "owner" } } : null) } };
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y" };
  const server = createRuntimeServer({ config, manager, auth, settings: { async profile() { return {}; } }, github: {}, vault, orchestrator, pool, credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {}, projectTasks, automations });
  await server.listen();
  t.after(async () => { await server.close(); });
  const agentToken = vault.issueToken("owner", "s-a");
  const v1 = async (token, method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : {} };
  };
  const agent = async (path, body = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/internal/${path}`, { method: "POST", headers: { Authorization: "Bearer " + agentToken, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: JSON.parse(await r.text()) };
  };
  return { v1, agent, calls };
}

test("task REST routes need the user session and reach the service with the right arguments", async (t) => {
  const { v1, calls } = await harness(t);
  assert.equal((await v1("", "GET", "/v1/tasks")).status, 401);
  assert.equal((await v1("garbage", "GET", "/v1/tasks")).status, 401);
  assert.equal((await v1(USER_TOKEN, "GET", `/v1/tasks?projectId=${P}&status=todo`)).status, 200);
  assert.deepEqual(calls.at(-1).slice(0, 3), ["list", "owner", { projectId: P, status: "todo", organizationId: undefined }]);
  assert.equal((await v1(USER_TOKEN, "GET", "/v1/tasks")).status, 200);
  assert.equal(calls.at(-1)[2].organizationId, "org-1");
  const created = await v1(USER_TOKEN, "POST", `/v1/projects/${P}/tasks`, { title: "Pay", priority: "high" });
  assert.equal(created.status, 200);
  assert.equal(created.json.task.createdBy, "user");
  assert.equal((await v1(USER_TOKEN, "PATCH", `/v1/projects/${P}/tasks/${T}`, { status: "done" })).json.task.status, "done");
  assert.equal((await v1(USER_TOKEN, "DELETE", `/v1/projects/${P}/tasks/${T}`)).status, 200);
  assert.equal((await v1(USER_TOKEN, "GET", `/v1/projects/${P}/tasks/${T}/events`)).status, 200);
  assert.equal((await v1(USER_TOKEN, "POST", `/v1/projects/${P}/tasks/${T}/events`, { text: "hi" })).status, 200);
  assert.equal(calls.at(-1)[4], "hi");
  const settings = await v1(USER_TOKEN, "PUT", `/v1/projects/${P}/task-settings`, { autoAgent: true, agentSessionId: null });
  assert.deepEqual(settings.json.settings, { autoAgent: true, agentSessionId: null });
});

test("automation REST routes", async (t) => {
  const { v1, calls } = await harness(t);
  assert.equal((await v1("", "GET", "/v1/automations")).status, 401);
  assert.equal((await v1(USER_TOKEN, "GET", `/v1/automations?projectId=${P}`)).status, 200);
  const sched = { kind: "recurring", freq: "daily", time: "09:00", timezone: "UTC", startDate: "2026-01-01" };
  assert.equal((await v1(USER_TOKEN, "POST", `/v1/projects/${P}/automations`, { title: "A", instructions: "x", enabled: true, schedule: sched })).json.automation.title, "A");
  assert.equal((await v1(USER_TOKEN, "PATCH", `/v1/projects/${P}/automations/auto`, { enabled: false })).status, 200);
  assert.equal((await v1(USER_TOKEN, "DELETE", `/v1/projects/${P}/automations/auto`)).status, 200);
  assert.equal((await v1(USER_TOKEN, "POST", `/v1/projects/${P}/automations/auto/run`)).json.task.id, T);
  assert.ok(calls.some((c) => c[0] === "arun"));
  const preview = await v1(USER_TOKEN, "POST", "/v1/automations/preview", { schedule: { ...sched, startDate: "2030-01-01" } });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.upcoming.length, 5);
  // validation errors: 400 with the field name
  const bad = await v1(USER_TOKEN, "POST", "/v1/automations/preview", { schedule: { ...sched, time: "99:99" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.details.field, "schedule.time");
  const past = await v1(USER_TOKEN, "POST", "/v1/automations/preview", { schedule: { kind: "once", at: "2020-01-01T00:00:00Z" } });
  assert.equal(past.status, 400);
  assert.equal(past.json.error.details.field, "schedule.at");
});

test("agent task endpoints are scoped to the caller's project and record the agent as actor", async (t) => {
  const { agent, calls } = await harness(t);
  assert.equal((await agent("tasks/list", { status: "todo", mine: true })).status, 200);
  assert.deepEqual(calls.at(-1).slice(0, 3), ["list", "owner", { projectId: P, status: "todo", assigneeSessionId: "s-a" }]);
  const created = await agent("tasks/create", { title: "Follow up", runAt: "2026-07-19T09:00:00Z" });
  assert.equal(created.json.task.createdBy, "agent:s-a");
  assert.equal(calls.at(-1)[2], P, "created in the caller's project, never one it names");
  await agent("tasks/done", { id: T, comment: "all done" });
  assert.deepEqual(calls.at(-1)[4], { status: "done", comment: "all done" });
  assert.equal(calls.at(-1)[1], "owner");
  await agent("tasks/update", { id: T, status: "blocked", comment: "waiting" });
  assert.equal(calls.at(-1)[4].status, "blocked");
  assert.equal(calls.at(-1)[5].actor, "agent:s-a");
  assert.equal((await agent("tasks/comment", { id: T, text: "note" })).status, 200);
  assert.equal((await agent("tasks/show", { id: T })).status, 200);
  // agents have no way to touch automations or settings
  assert.equal((await agent("automations/create", {})).status, 404);
  assert.equal((await agent("tasks/settings", { autoAgent: true })).status, 404);
});
