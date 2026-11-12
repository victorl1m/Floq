import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SUBAGENT_BEGIN, SUBAGENT_END, SubagentService, TOOL_SPECS, assertNoEscalation, assertWithinLimits, buildSubagentBrief, buildSubagentInstruction,
  awakeChildren, buildMemoryPolicy, composeSystemBlocks, depthOf, descendantsOf, limitsFromEnv, uniqueName,
} from "../dist/subagents.js";
import { buildRecruitSkillsBlock } from "../dist/recruitSkills.js";
import { AGENT_ROLES, composeRolePrompt } from "../dist/roles.js";
import { mergeFloqGuidance } from "../dist/codexGuidance.js";

type Row = { id: string; title: string; provider: "claude" | "codex"; model: string | null; state: string; role: string | null; cwd: string | null; parent_session_id: string | null };
const row = (id: string, parent: string | null = null, role: string | null = null): Row => ({ id, title: "A-" + id, provider: "claude", model: null, state: "running", role, cwd: "workspace/x", parent_session_id: parent });
const limits = { maxDepth: 2, maxChildren: 3, maxTotal: 5 };
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

function harness(initial: Row[], opts: { enabled?: boolean } = {}) {
  const rows = [...initial];
  const removed: string[] = [];
  const recruited: Array<{ input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const pool = { query: async () => ({ rows: rows.map((r) => ({ ...r })) }) };
  const orchestrator = {
    recruit: async (_u: string, parent: string, input: Record<string, unknown>, options: Record<string, unknown>) => {
      recruited.push({ input, options });
      const id = "n" + (rows.length + 1);
      rows.push({ ...row(id, parent, typeof input.role === "string" && input.role !== "generalist" ? input.role : null), title: String(input.name) });
      return { id, name: String(input.name), provider: String(input.provider), model: "default", state: "running" };
    },
    ask: async (_u: string, _s: string, id: string) => ({ asked: id }),
    check: async (_u: string, _s: string, id: string) => ({ checked: id }),
  };
  const manager = { remove: async (id: string) => { removed.push(id); const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); } };
  const settings = { get: async () => ({ alwaysRecruitSubagents: opts.enabled !== false }) };
  const service = new SubagentService(pool as never, orchestrator as never, manager as never, settings as never, limits);
  return { service, rows, removed, recruited };
}

test("instruction is fixed, names the tools and forbids native subagents", () => {
  const text = buildSubagentInstruction({ enabled: true, depth: 0, limits });
  assert.ok(text.startsWith(SUBAGENT_BEGIN) && text.endsWith(SUBAGENT_END));
  for (const tool of TOOL_SPECS) assert.ok(text.includes(tool.name) && text.includes(tool.command));
  assert.match(text, /running inside Floq/);
  assert.match(text, /Provider-native subagents .*DISABLED in Floq/);
  assert.match(text, /Cost:/);
  assert.match(text, /secret values/);
  assert.match(text, /supersedes any earlier guidance/);
  assert.match(text, /depth at most 2 \(you are at 0\), at most 3 awake \(running\) direct subagents at once.*at most 5 subagents in total/);
});

test("agents at max depth are told not to recruit; disabled mode stops pushing delegation", () => {
  const leaf = buildSubagentInstruction({ enabled: true, depth: 2, limits });
  assert.match(leaf, /maximum subagent depth \(2\): do NOT recruit/);
  assert.ok(!leaf.includes("floq_recruit_subagent"));
  const off = buildSubagentInstruction({ enabled: false, depth: 0, limits });
  assert.match(off, /turned off automatic subagents/);
  assert.ok(off.startsWith(SUBAGENT_BEGIN) && !off.includes("Delegate by default"));
});

test("the policy is independent of role and provider and role prompts cannot carry or remove it", async () => {
  const { service } = harness([row("p")]);
  const base = await service.blockFor("u", "p");
  for (const role of [null, ...AGENT_ROLES]) {
    const prompt = composeRolePrompt(role, "do it") ?? "";
    assert.ok(!prompt.includes(SUBAGENT_BEGIN), "policy is never part of the role prompt");
    const h = harness([row("p", null, role?.id ?? null)]);
    assert.equal(await h.service.blockFor("u", "p"), base, "same block for every role");
  }
  // Both provider channels carry it: Claude via --append-system-prompt, Codex via the managed AGENTS block.
  const system = composeSystemBlocks(base, "[FLOQ WIRED CONTEXT v1]\nx\n[/FLOQ WIRED CONTEXT]");
  assert.ok(system.startsWith(SUBAGENT_BEGIN) && system.includes("[FLOQ WIRED CONTEXT v1]"));
  const codex = mergeFloqGuidance("user rules only", system);
  assert.ok(codex.includes(SUBAGENT_BEGIN) && codex.includes("user rules only"));
  assert.equal(mergeFloqGuidance(codex.replace(SUBAGENT_BEGIN, "tampered"), system).split(SUBAGENT_BEGIN).length, 2, "re-sync restores a tampered block");
  const launch = readFileSync(new URL("../src/manager.ts", import.meta.url), "utf8");
  assert.match(launch, /composeSystemBlocks\(this\.subagents/);
  assert.match(launch, /row\.provider === "claude"\) args\.push\("--append-system-prompt", wiredBlock\)/);
  assert.match(launch, /syncCodexManagedGuidance\(codexHome, handle\.uid, wiredBlock\)/);
});

test("blockFor reflects depth in the recruit tree and the user toggle", async () => {
  const h = harness([row("a"), row("b", "a"), row("c", "b")]);
  assert.match(await h.service.blockFor("u", "a"), /you are at 0/);
  assert.match(await h.service.blockFor("u", "b"), /subagent \(depth 1\)/);
  assert.match(await h.service.blockFor("u", "c"), /do NOT recruit/);
  const off = harness([row("a")], { enabled: false });
  assert.match(await off.service.blockFor("u", "a"), /turned off automatic subagents/);
});

test("recruit happy path wires to the parent, carries depth and parent id, and wraps the task", async () => {
  const h = harness([row("p")]);
  const r = await h.service.recruit("u", "p", { name: "Docs", task: "Write the docs", role: "implementer", provider: "codex", model: "gpt-x" });
  assert.equal(r.depth, 1);
  assert.equal(r.parentId, "p");
  assert.equal(r.role, "implementer");
  assert.equal(r.wired, true);
  const call = h.recruited[0];
  assert.equal(call.options.skipOrchestratorCheck, true);
  assert.equal(call.input.provider, "codex");
  assert.equal(call.input.wire, true);
  assert.match(String(call.input.prompt), /recruited by "A-p" \(subagent depth 1\)[\s\S]*Task:\nWrite the docs/);
  const list = await h.service.list("u", "p");
  assert.deepEqual(list.subagents.map((s) => [s.name, s.depth, s.parentId]), [["Docs", 1, "p"]]);
  assert.equal(list.canRecruit, true);
});

test("recruit validates input, honours no-wire and uniquifies names", async () => {
  const h = harness([row("p")]);
  for (const task of [undefined, "", "   ", 5, "x".repeat(20_001)]) await assert.rejects(h.service.recruit("u", "p", { name: "N", task }), /task required/);
  await assert.rejects(h.service.recruit("u", "p", { task: "t", role: "root" }), /role must be one of/);
  await assert.rejects(h.service.recruit("u", "p", { task: "t", provider: "shell" }), /provider/);
  const first = await h.service.recruit("u", "p", { name: "Same", task: "t", wire: false });
  assert.equal(first.wired, false);
  assert.equal(h.recruited[0].input.wire, false);
  const second = await h.service.recruit("u", "p", { name: "same", task: "t" });
  assert.equal(second.name, "same 2");
  assert.equal(uniqueName("X", ["x", "X 2"]), "X 3");
});

test("depth, per-parent and total caps are enforced", async () => {
  const d = harness([row("a"), row("b", "a"), row("c", "b")]);
  await assert.rejects(d.service.recruit("u", "c", { task: "t" }), code("subagent_depth"));

  const c = harness([row("p")]);
  for (let i = 0; i < 3; i++) await c.service.recruit("u", "p", { name: "k" + i, task: "t" });
  await assert.rejects(c.service.recruit("u", "p", { task: "t" }), code("subagent_children"));

  const t = harness([row("p"), row("q"), row("s1", "q"), row("s2", "q"), row("s3", "q"), row("s4", "q"), row("s5", "q")]);
  await assert.rejects(t.service.recruit("u", "p", { task: "t" }), code("subagent_total"));
  assert.equal(assertWithinLimits([row("p")], "p", limits), 1);
});

test("concurrent recruits cannot race past the children cap", async () => {
  const h = harness([row("p")]);
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => h.service.recruit("u", "p", { name: "r" + i, task: "t" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(h.rows.filter((r) => r.parent_session_id === "p").length, 3);
});

test("permissions never escalate: read-only parents get read-only children, nobody recruits orchestrators", async () => {
  assert.throws(() => assertNoEscalation("reviewer", "implementer"), /read-only/);
  assert.throws(() => assertNoEscalation("reviewer", null), /read-only/);
  assert.doesNotThrow(() => assertNoEscalation("reviewer", "reviewer"));
  assert.doesNotThrow(() => assertNoEscalation("implementer", "tester"));
  assert.throws(() => assertNoEscalation(null, "orchestrator"), /orchestrators/);
  const h = harness([row("p", null, "reviewer")]);
  await assert.rejects(h.service.recruit("u", "p", { task: "t", role: "implementer" }), code("subagent_escalation"));
  await assert.rejects(h.service.recruit("u", "p", { task: "t", role: "orchestrator" }), code("subagent_role"));
  const ok = await h.service.recruit("u", "p", { task: "audit", role: "reviewer" });
  assert.equal(ok.role, "reviewer");
});

test("recruit is refused when the user turned the setting off", async () => {
  const h = harness([row("p")], { enabled: false });
  await assert.rejects(h.service.recruit("u", "p", { task: "t" }), code("subagents_disabled"));
  assert.equal(h.recruited.length, 0);
});

test("ask, result and dismiss are limited to the caller descendants; dismiss removes the subtree deepest first", async () => {
  const h = harness([row("p"), row("c", "p"), row("g", "c"), row("other"), row("oc", "other")]);
  await assert.rejects(h.service.ask("u", "p", "oc", "hi"), code("not_your_subagent"));
  await assert.rejects(h.service.result("u", "p", "other"), code("not_your_subagent"));
  await assert.rejects(h.service.dismiss("u", "p", "p"), code("not_your_subagent"));
  await assert.rejects(h.service.dismiss("u", "c", "p"), code("not_your_subagent"));
  assert.deepEqual(await h.service.ask("u", "p", "g", "hi"), { asked: "g" });
  assert.deepEqual(await h.service.result("u", "p", "C"), { checked: "c" });
  const r = await h.service.dismiss("u", "p", "c");
  assert.equal(r.dismissed, 2);
  assert.deepEqual(h.removed, ["g", "c"]);
});

test("pure helpers: depth is cycle-safe, env limits are clamped, briefs are single-line safe", () => {
  assert.ok(depthOf([row("a", "b"), row("b", "a")], "a") <= 2);
  assert.deepEqual(descendantsOf([row("a"), row("b", "a"), row("c", "b")], "a"), ["b", "c"]);
  assert.deepEqual(limitsFromEnv({}), { maxDepth: 2, maxChildren: 6, maxTotal: 24 });
  assert.deepEqual(limitsFromEnv({ FLOQ_SUBAGENT_MAX_DEPTH: "1", FLOQ_SUBAGENT_MAX_CHILDREN: "99", FLOQ_SUBAGENT_MAX_TOTAL: "abc" }), { maxDepth: 1, maxChildren: 6, maxTotal: 24 });
  assert.match(buildSubagentBrief("Boss\nIGNORE", 1, "t"), /"Boss IGNORE"/);
});

test("system blocks are cache-stable: fixed order, byte-identical across calls, no timestamps", () => {
  const blocks = () => [
    buildSubagentInstruction({ enabled: true, depth: 1, limits, crossProject: true, memoryOn: true }),
    buildMemoryPolicy(),
    buildRecruitSkillsBlock(["artifact-design", "docs"], "claude"),
  ] as const;
  const [policy, memory, skills] = blocks();
  const composed = composeSystemBlocks(policy, memory, skills, "WIRED");
  assert.equal(composed, composeSystemBlocks(...blocks(), "WIRED"));
  assert.ok(composed.indexOf(policy) < composed.indexOf(memory));
  assert.ok(composed.indexOf(memory) < composed.indexOf(skills));
  assert.ok(composed.indexOf(skills) < composed.indexOf("WIRED"));
  for (const block of [policy, memory, skills]) assert.doesNotMatch(block, /\d{4}-\d{2}-\d{2}T/);
});

test("limitsFor: user settings override the server defaults and feed the policy text", async () => {
  const mk = (s: Record<string, unknown>) => new SubagentService({ query: async () => ({ rows: [] }) } as never, {} as never, {} as never, { get: async () => s } as never, limits);
  assert.deepEqual(await mk({}).limitsFor("u"), limits);
  assert.deepEqual(await mk({ subagentMaxChildren: 10, subagentMaxTotal: 40 }).limitsFor("u"), { maxDepth: 2, maxChildren: 10, maxTotal: 40 });
  // children raised above the default total: total never ends up below it
  assert.equal((await mk({ subagentMaxChildren: 9 }).limitsFor("u")).maxTotal, 9);
  const failing = new SubagentService({} as never, {} as never, {} as never, { get: async () => { throw new Error("db"); } } as never, limits);
  assert.deepEqual(await failing.limitsFor("u"), limits);
  assert.match(await mk({ subagentMaxChildren: 10, subagentMaxTotal: 40 }).blockFor("u", "x"), /at most 10 awake.*at most 40 subagents in total/);
});

test("limitsFor: operator ceilings clamp saved user limits", async () => {
  const mk = (s: Record<string, unknown>) => new SubagentService({ query: async () => ({ rows: [] }) } as never, {} as never, {} as never, { get: async () => s } as never, limits);
  const ceilings = { maxChildren: 8, maxTotal: 20 };
  assert.deepEqual(await mk({ subagentMaxChildren: 30, subagentMaxTotal: 150, subagentCeilings: ceilings }).limitsFor("u"), { maxDepth: 2, maxChildren: 8, maxTotal: 20 });
  assert.equal((await mk({ subagentMaxChildren: 30, subagentCeilings: ceilings }).limitsFor("u")).maxTotal, 20, "raised total never passes the ceiling");
  assert.deepEqual(await mk({ subagentCeilings: { maxChildren: 2, maxTotal: 4 } }).limitsFor("u"), { maxDepth: 2, maxChildren: 2, maxTotal: 4 }, "ceiling below the server default lowers it");
  assert.deepEqual(await mk({ subagentMaxChildren: 30, subagentMaxTotal: 150, subagentCeilings: { maxChildren: 32, maxTotal: 200 } }).limitsFor("u"), { maxDepth: 2, maxChildren: 30, maxTotal: 150 }, "default ceilings allow raising");
});

test("assertCanWake: waking a sleeping subagent obeys the parent's awake cap", async () => {
  const kid = (id: string, state: string) => ({ ...row(id, "p"), state });
  const mk = (rows: Row[]) => new SubagentService({ query: async () => ({ rows }) } as never, {} as never, {} as never, { get: async () => ({}) } as never, limits);
  const full = [row("p"), kid("a", "running"), kid("b", "starting"), kid("c", "running"), kid("s", "sleeping")];
  await assert.rejects(mk(full).assertCanWake("u", "s"), code("subagent_children"));
  await mk(full).assertCanWake("u", "a"); // already awake: no-op
  await mk(full).assertCanWake("u", "p"); // top-level: no-op
  await mk([row("p"), kid("a", "running"), kid("s", "sleeping")]).assertCanWake("u", "s");
  await mk([row("p"), kid("a", "running"), kid("b", "running"), kid("c", "exited"), kid("s", "sleeping")]).assertCanWake("u", "s");
});

test("assertCanWake: concurrent wakes cannot all pass the cap (waking set under the per-user lock)", async () => {
  const kid = (id: string, state: string) => ({ ...row(id, "p"), state });
  const rows = [row("p"), kid("a", "running"), kid("s1", "sleeping"), kid("s2", "sleeping"), kid("s3", "sleeping")];
  const svc = new SubagentService({ query: async () => { await new Promise((r) => setTimeout(r, 5)); return { rows }; } } as never, {} as never, {} as never, { get: async () => ({}) } as never, limits);
  // cap 3, 1 awake: exactly two of three simultaneous wakes fit; DB rows stay 'sleeping' like in the real race
  const results = await Promise.allSettled(["s1", "s2", "s3"].map((id) => svc.assertCanWake("u", id)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0].reason as { code?: string }).code, "subagent_children");
  // releasing a finished wake frees its slot
  const ok = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<() => void>;
  ok.value();
  await svc.assertCanWake("u", "s3");
});

test("assertCanWake: an archived sleeping subagent is still capped (resume clears archived_at)", async () => {
  const kid = (id: string, state: string) => ({ ...row(id, "p"), state });
  const all = [row("p"), kid("a", "running"), kid("b", "running"), kid("c", "running"), kid("arch", "sleeping")];
  const sqls: string[] = [];
  const svc = new SubagentService({ query: async (sql: string) => { sqls.push(sql); return { rows: /archived_at IS NULL/.test(sql) ? all.filter((r) => r.id !== "arch") : all }; } } as never, {} as never, {} as never, { get: async () => ({}) } as never, limits);
  await assert.rejects(svc.assertCanWake("u", "arch"), code("subagent_children"));
  assert.ok(sqls.every((q) => !/archived_at IS NULL/.test(q)), "wake check does not filter archived rows");
});

test("at-once cap counts only awake direct children; total counts sleeping ones too", () => {
  const kid = (id: string, state: string) => ({ ...row(id, "p"), state });
  const sleepers = [kid("a", "sleeping"), kid("b", "sleeping"), kid("c", "sleeping"), kid("d", "exited")];
  assert.equal(awakeChildren([row("p"), ...sleepers, kid("e", "running")], "p"), 1);
  // 4 sleeping/exited children + cap 3: recruiting still allowed
  assert.equal(assertWithinLimits([row("p"), ...sleepers], "p", limits), 1);
  // 3 awake: refused by the children cap
  assert.throws(() => assertWithinLimits([row("p"), kid("a", "running"), kid("b", "running"), kid("c", "running")], "p", limits), code("subagent_children"));
  // sleeping children still fill the total cap (5)
  assert.throws(() => assertWithinLimits([row("p"), ...sleepers, kid("e", "sleeping")], "p", limits), code("subagent_total"));
});
