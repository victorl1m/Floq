import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionEnv, forcedSessionEnv, getProviderDefinition, listProviders, resolveModel } from "../dist/providers.js";
import { agyTokenValid, antigravityPrompt, antigravitySettings, opencodeConfigContent, parseAntigravityConversationId, parseOpencodeSessionId } from "../dist/cliProviders.js";
import { nativeSubagentBlockArgs } from "../dist/nativeSubagentBlock.js";
import { PROVIDER_IDS, RECRUIT_PROVIDERS } from "../dist/types.js";

const cfg = { providers: { claude: "claude", codex: "codex", opencode: "opencode", antigravity: "agy", shell: "bash" }, models: { claude: [], codex: [], opencode: [{ id: "anthropic/claude-opus-5-5", label: "Opus" }], antigravity: [{ id: "gemini-4-argon", label: "Argon" }] }, passHostEnv: false, sessionEnvAllow: [], cacheDisable: false };
const on = { opencodeAutoApprove: true, antigravityAutoApprove: true };
const off = { opencodeAutoApprove: false, antigravityAutoApprove: false };
const profile = { ...off, gitName: null, gitEmail: null, gitCoauthor: "", githubToken: null };

test("ids and recruitable providers include both new CLIs", () => {
  for (const id of ["opencode", "antigravity"]) { assert.ok(PROVIDER_IDS.includes(id)); assert.ok(RECRUIT_PROVIDERS.includes(id)); }
  assert.ok(!RECRUIT_PROVIDERS.includes("shell"));
});

test("opencode buildArgs/resumeArgs", () => {
  const d = getProviderDefinition("opencode", cfg);
  assert.equal(d.bin, "opencode");
  assert.deepEqual(d.buildArgs(off, "sid", null), []);
  assert.deepEqual(d.buildArgs(on, "sid", "anthropic/claude-opus-5-5"), ["--auto", "-m", "anthropic/claude-opus-5-5"]);
  assert.equal(d.resumeArgs(on, null, null), null);
  assert.deepEqual(d.resumeArgs(on, "ses_abc123", "m/x"), ["--auto", "-m", "m/x", "-s", "ses_abc123"]);
  assert.deepEqual(d.promptArgs("hi"), ["--prompt", "hi"]);
});

test("antigravity buildArgs/resumeArgs", () => {
  const d = getProviderDefinition("antigravity", cfg);
  assert.equal(d.bin, "agy");
  assert.deepEqual(d.buildArgs(off, "sid", null), []);
  assert.deepEqual(d.buildArgs(on, "sid", "gemini-4-argon"), ["--dangerously-skip-permissions", "--model", "gemini-4-argon"]);
  assert.equal(d.resumeArgs(on, null, null), null);
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.deepEqual(d.resumeArgs(off, id, null), ["--conversation", id]);
  assert.deepEqual(d.promptArgs("hi"), ["-i", "hi"]);
});

test("env: autoupdate off, no claude-only vars, vault-style keys are not dropped by the builder", () => {
  assert.deepEqual(forcedSessionEnv("opencode"), { OPENCODE_DISABLE_AUTOUPDATE: "1" });
  assert.deepEqual(forcedSessionEnv("antigravity"), { AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  for (const p of ["opencode", "antigravity"]) {
    const env = buildSessionEnv(cfg, p, profile, "s1");
    assert.equal(env.FLOQ_PROVIDER, p);
    assert.equal("CLAUDE_CODE_NO_FLICKER" in env, false);
  }
});

test("models resolve per provider and appear in the provider list", () => {
  assert.equal(resolveModel(cfg, "opencode", "anthropic/claude-opus-5-5"), "anthropic/claude-opus-5-5");
  assert.equal(resolveModel(cfg, "opencode", "nope"), "invalid");
  assert.equal(resolveModel(cfg, "antigravity", "default"), null);
  assert.equal(resolveModel(cfg, "antigravity", "gemini-4-argon"), "gemini-4-argon");
  const listed = listProviders({ ...cfg, providers: { ...cfg.providers, opencode: "definitely-not-installed-opencode", antigravity: "definitely-not-installed-agy" } }).filter((p) => p.id === "opencode" || p.id === "antigravity");
  assert.deepEqual(listed.map((p) => [p.id, p.available]), [["opencode", false], ["antigravity", false]]);
  assert.equal(listed[0].models[1].id, "anthropic/claude-opus-5-5");
});

test("native subagents: opencode denies the task tool via config; no CLI flags for either", () => {
  assert.deepEqual(nativeSubagentBlockArgs("opencode"), []);
  assert.deepEqual(nativeSubagentBlockArgs("antigravity"), []);
  const conf = JSON.parse(opencodeConfigContent("/home/agent/.floq/opencode/s/instructions.md"));
  assert.equal(conf.permission.task, "deny");
  assert.equal(conf.autoupdate, false);
  assert.deepEqual(conf.instructions, ["/home/agent/.floq/opencode/s/instructions.md"]);
  assert.equal("instructions" in JSON.parse(opencodeConfigContent(null)), false);
});

test("antigravity settings and first message carry the Floq block", () => {
  assert.equal(antigravitySettings({ hasApiKey: false, trustedWorkspaces: [] }), null);
  assert.deepEqual(JSON.parse(antigravitySettings({ hasApiKey: true, trustedWorkspaces: ["/home/agent/p"] })), { modelProvider: "gemini", trustedWorkspaces: ["/home/agent/p"] });
  assert.equal(antigravityPrompt("", undefined, false), null);
  assert.match(antigravityPrompt("BLOCK", "do it", false), /BLOCK[\s\S]*do it/);
  assert.match(antigravityPrompt("BLOCK", undefined, true), /refreshed on resume[\s\S]*BLOCK/);
});

test("session id discovery parsers", () => {
  const list = JSON.stringify([{ id: "ses_old1", updated: 1 }, { id: "ses_new2", updated: 5 }, { id: "ses_child", parentID: "ses_new2", updated: 9 }, { id: "bad", updated: 99 }]);
  assert.equal(parseOpencodeSessionId(list), "ses_new2");
  assert.equal(parseOpencodeSessionId("not json"), null);
  assert.equal(parseOpencodeSessionId("[]"), null);
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(parseAntigravityConversationId(JSON.stringify({ "/home/agent/p": id }), ["/mnt/x/p", "/home/agent/p"]), id);
  assert.equal(parseAntigravityConversationId(JSON.stringify({ "/home/agent/p": "not-a-uuid" }), ["/home/agent/p"]), null);
  assert.equal(parseAntigravityConversationId("[]", ["/a"]), null);
});

test("antigravity settings: a Google login wins over GEMINI_API_KEY and never sets modelProvider", () => {
  assert.equal(antigravitySettings({ hasApiKey: true, oauth: true, trustedWorkspaces: [] }), null);
  assert.deepEqual(JSON.parse(antigravitySettings({ hasApiKey: true, oauth: true, trustedWorkspaces: ["/w"] })), { trustedWorkspaces: ["/w"] });
  assert.equal(antigravitySettings({ hasApiKey: false, oauth: true, trustedWorkspaces: [] }), null);
  assert.deepEqual(JSON.parse(antigravitySettings({ hasApiKey: true, oauth: false, trustedWorkspaces: [] })), { modelProvider: "gemini" });
});

test("agyTokenValid detects a usable agy token file", () => {
  assert.equal(agyTokenValid(JSON.stringify({ access_token: "ya29.x", refresh_token: "1//r", expiry: "2026-01-01T00:00:00Z" })), true);
  assert.equal(agyTokenValid(JSON.stringify({ token: { refreshToken: "1//r" } })), true);
  assert.equal(agyTokenValid(""), false);
  assert.equal(agyTokenValid("ZW5jb2RlZA=="), true, "opaque non-JSON content is accepted");
  assert.equal(agyTokenValid("[]"), false);
  assert.equal(agyTokenValid("{}"), false);
  assert.equal(agyTokenValid(JSON.stringify({ access_token: "" })), false);
});

test("login validators accept antigravity and still refuse other providers", async () => {
  const { SessionManager } = await import("../dist/manager.js");
  const self = { assertLifecycleOpen() {}, loginTasks: new Map() };
  await assert.rejects(SessionManager.prototype.startLogin.call(self, "u", "shell", {}), /claude, codex or antigravity/);
  await assert.rejects(SessionManager.prototype.startLogin.call(self, "u", "opencode", {}), /claude, codex or antigravity/);
  await assert.rejects(SessionManager.prototype.disconnectProvider.call(self, "u", "shell"), /claude, codex or antigravity/);
  // antigravity passes the validator: it fails later (no shards on the stub), not with invalid_provider.
  await assert.rejects(SessionManager.prototype.startLogin.call({ ...self, startLoginOnce: async () => { throw new Error("reached"); } }, "u", "antigravity", {}), /reached/);
});
