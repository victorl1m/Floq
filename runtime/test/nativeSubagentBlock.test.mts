import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BLOCK_HOOK_PATH, QUESTION_HOOK_PATH, claudeBlockSettings, nativeSubagentBlockArgs, parseVersion } from "../src/nativeSubagentBlock.ts";
import { buildSubagentInstruction } from "../src/subagents.ts";

const hook = (payload: string) => spawnSync(process.execPath, ["--import", "tsx", new URL("../image/floq-block-native-subagent.mts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], { input: payload, encoding: "utf8" });

test("claude args deny Agent and Task and carry the hook settings", () => {
  const args = nativeSubagentBlockArgs("claude", { hookExists: () => true, version: "2.1.100 (Claude Code)" });
  assert.deepEqual(args.slice(0, 2), ["--disallowedTools", "Agent,Task"]);
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.deepEqual(settings, claudeBlockSettings());
  assert.deepEqual(settings.permissions.deny, ["Agent", "Task"]);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Agent|Task");
  assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(BLOCK_HOOK_PATH));
});

test("codex args disable multi-agent via config overrides", () => {
  assert.deepEqual(nativeSubagentBlockArgs("codex"), ["-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false"]);
  assert.deepEqual(nativeSubagentBlockArgs("shell"), []);
});

test("unsupported CLI version or missing hook degrades to the deny flag with a warning, never throws", () => {
  const warnings: string[] = [];
  const old = nativeSubagentBlockArgs("claude", { version: "1.0.20", hookExists: () => true, warn: (m) => warnings.push(m) });
  assert.deepEqual(old, ["--disallowedTools", "Agent,Task"]);
  const missing = nativeSubagentBlockArgs("claude", { hookExists: () => false, warn: (m) => warnings.push(m) });
  assert.deepEqual(missing, ["--disallowedTools", "Agent,Task"]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(parseVersion("garbage"), null);
});

test("hook blocks Agent/Task payloads with the recruit message and allows other tools", () => {
  for (const name of ["Agent", "Task"]) {
    const r = hook(JSON.stringify({ tool_name: name, tool_input: { subagent_type: "Explore" } }));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Native subagents are disabled in Floq[\s\S]*floq subagent recruit/);
  }
  for (const payload of [JSON.stringify({ tool_name: "Bash", tool_input: {} }), JSON.stringify({ tool_name: "TaskStop" }), "not json", ""]) assert.equal(hook(payload).status, 0);
});

test("launch applies the block on start and resume for every claude/codex session, independent of the recruit setting", () => {
  const src = readFileSync(new URL("../src/manager.ts", import.meta.url), "utf8");
  // One call site after args are built from either buildArgs or resumeArgs, not gated on this.subagents or the setting.
  assert.match(src, /const args = resumeArgs \?\? definition\.buildArgs[\s\S]*nativeSubagentBlockArgs\("codex"\)[\s\S]*nativeSubagentBlockArgs\("claude"/);
  for (const enabled of [true, false]) assert.match(buildSubagentInstruction({ enabled, depth: 0 }), /disabled in Floq/i);
  const managed = JSON.parse(readFileSync(new URL("../image/claude-managed-settings.json", import.meta.url), "utf8"));
  assert.deepEqual(managed.permissions.deny, ["Agent", "Task"]);
});

test("question hook composes with subagent blocking but is enabled only for verified Claude versions", () => {
  const settings = claudeBlockSettings(BLOCK_HOOK_PATH, QUESTION_HOOK_PATH) as any;
  assert.deepEqual(settings.hooks.PreToolUse.map((entry:any) => entry.matcher), ["Agent|Task", "AskUserQuestion"]);
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].timeout, 300);
  const args = nativeSubagentBlockArgs("claude", { hookExists: () => true, version: "2.1.318" });
  assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).hooks.PreToolUse.length, 2);
  const old = nativeSubagentBlockArgs("claude", { hookExists: () => true, version: "2.1.100" });
  assert.equal(JSON.parse(old[old.indexOf("--settings") + 1]).hooks.PreToolUse.length, 1);
});
