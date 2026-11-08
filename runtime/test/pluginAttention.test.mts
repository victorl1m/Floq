import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import { Approvals, type ApprovalAgent } from "../src/approvals.ts";
import { Decisions } from "../src/decisions.ts";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { makeEcho } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);

const agent: ApprovalAgent = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme API", provider: "claude", projectId: "p1", projectName: "Acme" };
const Q = [{ id: "q", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], multiSelect: false, allowText: true }];
const tick = () => new Promise((r) => setTimeout(r, 20));

async function setup(over: { manifest?: Record<string, unknown>; owner?: string; wire?: boolean } = {}) {
  const f = await fakePool();
  await f.addUser("owner"); await f.addUser("other");
  const { plugin, probe } = makeEcho(undefined, { scope: "install", contributes: { routes: true, migrations: true, attention: true }, ...over.manifest });
  const host = new PluginHost(f.pool as never, { plugins: [plugin], encryptionKey: Buffer.alloc(32, 9), sink: () => undefined });
  await host.load();
  await host.enable("echo", over.owner ?? "owner");
  const approvals = new Approvals({ livenessMs: 5, isAlive: () => true });
  const decisions = new Decisions();
  if (over.wire !== false) host.setAttention({ approvals, decisions });
  const pending: any[] = []; const resolved: any[] = [];
  return { host, ctx: probe.ctx, approvals, decisions, pending, resolved };
}
const decide = (d: Decisions, user = "owner") => d.request(user, { sessionId: "s1", projectId: "p1", sessionName: "Agent", questions: Q });
const approve = (a: Approvals, action: string, user = "owner", requester = agent) => a.request(user, { requester, target: requester, action });

test("flag required: ctx.attention throws without contributes.attention", async () => {
  const s = await setup({ manifest: { contributes: { routes: true, migrations: true } } });
  assert.throws(() => s.ctx.attention.onPending(() => undefined), /contributes\.attention/);
  await assert.rejects(s.ctx.attention.resolveDecision("x", []), /contributes\.attention/);
});

test("onPending replays pending items, then delivers new ones, to the owner only", async () => {
  const s = await setup();
  const d0 = await decide(s.decisions);
  const a0 = await approve(s.approvals, "run tests");
  await decide(s.decisions, "other"); await approve(s.approvals, "run lint", "other");
  s.ctx.attention.onPending((p: any) => s.pending.push(p));
  await tick();
  assert.deepEqual(s.pending.map((p) => [p.kind, p.id]).sort(), [["approval", a0.id], ["decision", d0.id]].sort());
  const dec = s.pending.find((p) => p.kind === "decision");
  assert.equal(dec.userId, "owner"); assert.equal(dec.allowText, true); assert.equal(dec.questions[0].options[1].id, "b"); assert.equal(dec.sessionName, "Agent");
  const d1 = await decide(s.decisions);
  await decide(s.decisions, "other");
  assert.equal(s.pending.length, 3);
  assert.equal(s.pending[2].id, d1.id);
});

test("non-owner users' items never reach the plugin", async () => {
  const s = await setup();
  s.ctx.attention.onPending((p: any) => s.pending.push(p));
  s.ctx.attention.onResolved((e: any) => s.resolved.push(e));
  await tick();
  const d = await decide(s.decisions, "other"); await approve(s.approvals, "other thing", "other");
  await s.decisions.resolve("other", d.id, [{ questionId: "q", optionIds: ["a"], text: "" }]);
  assert.deepEqual(s.pending, []); assert.deepEqual(s.resolved, []);
});

test("plugin-originated approvals are excluded from pending and resolved, and cannot be answered through attention", async () => {
  const s = await setup();
  s.ctx.attention.onPending((p: any) => s.pending.push(p));
  s.ctx.attention.onResolved((e: any) => s.resolved.push(e));
  const asked = s.ctx.approvals; void asked;
  const plug: ApprovalAgent = { id: "plugin:echo", name: "Echo", provider: "claude", projectId: null, projectName: null, kind: "plugin" };
  const r = await s.approvals.request("owner", { requester: plug, target: plug, action: "Send message", waiting: true });
  await tick();
  assert.deepEqual(s.pending, []);
  await assert.rejects(s.ctx.attention.resolveApproval(r.id, "allow"), (e: any) => e.status === 403);
  await s.approvals.resolve("owner", r.id, "deny");
  await tick();
  assert.deepEqual(s.resolved, []);
});

test("resolveDecision binds the install owner, audits via, emits resolved by plugin, and 409s the second answer", async () => {
  const s = await setup();
  s.ctx.attention.onResolved((e: any) => s.resolved.push(e));
  await tick();
  const d = await decide(s.decisions);
  await s.ctx.attention.resolveDecision(d.id, [{ questionId: "q", optionIds: ["b"], text: "" }]);
  assert.deepEqual(s.resolved, [{ kind: "decision", id: d.id, status: "answered", by: "plugin" }]);
  assert.equal((await s.decisions.status("owner", "s1", d.id, 0)).response?.answers[0].optionIds[0], "b");
  await assert.rejects(s.ctx.attention.resolveDecision(d.id, [{ questionId: "q", optionIds: ["a"], text: "" }]), (e: any) => e.status === 409);
  // a decision of another user is not reachable: the user is the owner, never an argument
  const other = await decide(s.decisions, "other");
  await assert.rejects(s.ctx.attention.resolveDecision(other.id, [{ questionId: "q", optionIds: ["a"], text: "" }]), (e: any) => e.status === 404);
  assert.equal(s.decisions.list("other").length, 1);
});

test("resolveDecision passes resolvedVia to the stored row", async () => {
  const s = await setup();
  const queries: any[] = [];
  const decisions = new Decisions({ pool: { query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rowCount: 1, rows: [] }; } } as never });
  s.host.setAttention({ approvals: s.approvals, decisions });
  const d = await decide(decisions);
  await s.ctx.attention.resolveDecision(d.id, [{ questionId: "q", optionIds: ["a"], text: "" }]);
  const upd = queries.find((q) => /UPDATE agent_decisions/.test(q.sql));
  assert.match(upd.sql, /resolvedVia/); assert.ok(upd.params.includes("plugin:echo"));
});

test("resolveApproval: deny and allow of a reversible action work, resolved by plugin, audited", async () => {
  const s = await setup();
  s.ctx.attention.onResolved((e: any) => s.resolved.push(e));
  await tick();
  const a = await approve(s.approvals, "run the unit tests");
  const b = await approve(s.approvals, "run the linter");
  await s.ctx.attention.resolveApproval(a.id, "allow");
  await s.ctx.attention.resolveApproval(b.id, "deny");
  assert.deepEqual(s.resolved.map((e) => [e.id, e.status, e.by]), [[a.id, "granted", "plugin"], [b.id, "denied", "plugin"]]);
  await assert.rejects(s.ctx.attention.resolveApproval(a.id, "deny"), (e: any) => e.status === 409);
});

test("resolveApproval audit: resolvedVia is persisted in meta", async () => {
  const s = await setup();
  const rows: any[] = [];
  const approvals = new Approvals({ livenessMs: 5, pool: { query: async (_sql: string, params: unknown[]) => { rows.push(params); return { rows: [], rowCount: 0 }; } } as never });
  s.host.setAttention({ approvals, decisions: s.decisions });
  const a = await approve(approvals, "run the unit tests");
  await s.ctx.attention.resolveApproval(a.id, "deny");
  await tick();
  const last = rows[rows.length - 1];
  assert.equal(JSON.parse(last[10]).resolvedVia, "plugin:echo");
});

test("a plugin can never allow an irreversible approval, but may deny it; the app still can allow", async () => {
  const s = await setup();
  const a = await approve(s.approvals, "git push origin main");
  assert.equal(s.approvals.list("owner")[0].irreversible, true);
  await assert.rejects(s.ctx.attention.resolveApproval(a.id, "allow"), (e: any) => e.status === 403 && e.code === "irreversible_requires_app");
  assert.equal(s.approvals.list("owner").length, 1); // still pending
  await s.ctx.attention.resolveApproval(a.id, "deny");
  const b = await approve(s.approvals, "deploy to production");
  assert.equal((await s.approvals.resolve("owner", b.id, "allow")).status, "granted");
});

test("onResolved reports an answer given in the app as by:app, and the unsubscribe function stops events", async () => {
  const s = await setup();
  const off = s.ctx.attention.onResolved((e: any) => s.resolved.push(e));
  s.ctx.attention.onPending((p: any) => s.pending.push(p));
  await tick();
  const d = await decide(s.decisions);
  const a = await approve(s.approvals, "git push origin main");
  await s.decisions.resolve("owner", d.id, [{ questionId: "q", optionIds: ["a"], text: "" }]);
  await s.approvals.resolve("owner", a.id, "allow");
  assert.deepEqual(s.resolved.map((e) => [e.kind, e.by]), [["decision", "app"], ["approval", "app"]]);
  off();
  const d2 = await decide(s.decisions);
  await s.decisions.resolve("owner", d2.id, [{ questionId: "q", optionIds: ["a"], text: "" }]);
  assert.equal(s.resolved.length, 2);
});

test("stopping the plugin cancels subscriptions", async () => {
  const s = await setup();
  s.ctx.attention.onPending((p: any) => s.pending.push(p));
  await tick();
  await s.host.disable("echo");
  await decide(s.decisions);
  assert.deepEqual(s.pending, []);
});

test("user-scoped plugins cannot use attention", async () => {
  const s = await setup({ manifest: { scope: "user" } });
  assert.throws(() => s.ctx.attention.onPending(() => undefined), /install-scoped/);
});

test("F8: an app answer that lands while a plugin resolve is in flight is reported by:app (the plugin call gets 409)", async () => {
  const s = await setup();
  s.ctx.attention.onResolved((e: any) => s.resolved.push(e));
  await tick();
  const d = await decide(s.decisions);
  const a = await approve(s.approvals, "run tests");
  // Hold the plugin's calls open so the app answer lands first, while they are in flight.
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const dres = s.decisions.resolve.bind(s.decisions); const ares = s.approvals.resolve.bind(s.approvals);
  (s.decisions as any).resolve = async (...args: any[]) => { if (args[3]?.via) await gate; return (dres as any)(...args); };
  (s.approvals as any).resolve = async (...args: any[]) => { if (args[3]?.via) await gate; return (ares as any)(...args); };
  const pd = s.ctx.attention.resolveDecision(d.id, [{ questionId: "q", optionIds: ["a"], text: "" }]).catch((e: any) => e);
  const pa = s.ctx.attention.resolveApproval(a.id, "deny").catch((e: any) => e);
  await tick();
  await dres("owner", d.id, [{ questionId: "q", optionIds: ["b"], text: "" }]);
  await ares("owner", a.id, "allow");
  release();
  const [er, ar] = await Promise.all([pd, pa]);
  assert.equal(er.status, 409); assert.equal(ar.status, 409);
  assert.deepEqual(s.resolved.map((e) => [e.kind, e.by]).sort(), [["approval", "app"], ["decision", "app"]]);
});
