import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionEnv, forcedSessionEnv, getProviderDefinition, resolveModel } from "../dist/providers.js";

const config = { models: { claude: [], codex: [{ id: "gpt-6-old", label: "Old" }] } };

test("accepts a user-discovered Codex model without mutating static config", () => {
  const discovered = [{ id: "gpt-7-future", label: "Future", description: "Available to this user" }];
  assert.equal(resolveModel(config, "codex", "gpt-7-future", discovered), "gpt-7-future");
  assert.deepEqual(config.models.codex, [{ id: "gpt-6-old", label: "Old" }]);
});

test("rejects model ids absent from both the user catalog and static fallback", () => {
  assert.equal(resolveModel(config, "codex", "gpt-arbitrary", [{ id: "gpt-7-future", label: "Future" }]), "invalid");
  assert.equal(resolveModel(config, "codex", "gpt-6-old"), "gpt-6-old");
});

test("accepts a configured Claude model alias and rejects arbitrary recruit model names", () => {
  const claudeConfig = { models: { claude: [{ id: "haiku", label: "Haiku" }], codex: [] } };
  assert.equal(resolveModel(claudeConfig, "claude", "haiku"), "haiku");
  assert.equal(resolveModel(claudeConfig, "claude", "Haiku A"), "invalid");
});

const providerConfig = { providers: { claude: "claude", codex: "codex", shell: "bash" } };
const safeProfile = { codexAutoApprove: false };

test("Codex fresh sessions run without the shared app-server daemon", () => {
  const args = getProviderDefinition("codex", providerConfig).buildArgs(safeProfile, "floq-session", "gpt-6.1-sol");
  assert.deepEqual(args, ["--no-daemon", "-m", "gpt-6.1-sol"]);
});

test("Codex resumed sessions place no-daemon before the resume subcommand", () => {
  const args = getProviderDefinition("codex", providerConfig).resumeArgs(safeProfile, "codex-thread", "gpt-6.1-sol");
  assert.deepEqual(args, ["--no-daemon", "-m", "gpt-6.1-sol", "resume", "codex-thread"]);
});

test("Codex no-daemon args preserve the explicit approval setting", () => {
  const enabled = { codexAutoApprove: true };
  assert.deepEqual(getProviderDefinition("codex", providerConfig).buildArgs(enabled, "session", null), [
    "--no-daemon", "--dangerously-bypass-approvals-and-sandbox",
  ]);
  assert.deepEqual(getProviderDefinition("codex", providerConfig).resumeArgs(enabled, "thread", null), [
    "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "resume", "thread",
  ]);
});

test("Claude sessions pin the fullscreen renderer; Codex and shell sessions do not get it", () => {
  const cfg = { passHostEnv: false, sessionEnvAllow: [] };
  const profile = { gitName: "", gitEmail: "", gitCoauthor: "", githubToken: "" };
  process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
  process.env.CLAUDE_CODE_NO_FLICKER = "0";
  try {
    assert.equal(buildSessionEnv(cfg, "claude", profile, "s1").CLAUDE_CODE_NO_FLICKER, "1");
    assert.equal(buildSessionEnv({ ...cfg, passHostEnv: true }, "claude", profile, "s1").CLAUDE_CODE_NO_FLICKER, "1");
    assert.equal("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" in buildSessionEnv({ ...cfg, passHostEnv: true }, "claude", profile, "s1"), false);
    for (const p of ["codex", "shell"]) assert.equal("CLAUDE_CODE_NO_FLICKER" in buildSessionEnv(cfg, p, profile, "s1"), false);
    assert.deepEqual(forcedSessionEnv("claude"), { CLAUDE_CODE_NO_FLICKER: "1" });
    assert.deepEqual(forcedSessionEnv("codex"), {});
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
  }
});
