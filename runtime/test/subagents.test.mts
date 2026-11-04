import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SUBAGENT_BEGIN, SUBAGENT_END, SubagentService, TOOL_SPECS, assertNoEscalation, assertWithinLimits, buildSubagentBrief, buildSubagentInstruction,
  composeSystemBlocks, depthOf, descendantsOf, limitsFromEnv, uniqueName,
} from "../dist/subagents.js";
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
  assert.match(text, /depth at most 2 \(you are at 0\), at most 3 direct subagents, at most 5 subagents in total/);
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
