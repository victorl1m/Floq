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
    assert.deepEqual(forcedSessionEnv("claude"), { CLAUDE_CODE_NO_FLICKER: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" });
    assert.equal(forcedSessionEnv("claude", { codeMode: false }).CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, undefined, "FLOQ_CLAUDE_CODE_MODE=0 turns it off");
    assert.equal(buildSessionEnv(cfg, "claude", profile, "s1").CLAUDE_CODE_ENABLE_FUNCTION_HOOKS, "1");
    for (const p of ["codex", "shell"]) assert.equal("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS" in buildSessionEnv(cfg, p, profile, "s1"), false);
    assert.deepEqual(forcedSessionEnv("codex"), {});
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
  }
});

test("FLOQ_CACHE_DISABLE puts DISABLE_PROMPT_CACHING=1 on Claude only; default env has no prompt-caching key", () => {
  const cfg = { passHostEnv: false, sessionEnvAllow: [], cacheDisable: false };
  const profile = { gitName: "", gitEmail: "", gitCoauthor: "", githubToken: "" };
  const cachingKeys = (env: Record<string, string>) => Object.keys(env).filter((k) => k.includes("PROMPT_CACHING"));
  process.env.ENABLE_PROMPT_CACHING_1H = "1";
  try {
    assert.deepEqual(cachingKeys(buildSessionEnv(cfg, "claude", profile, "s1")), [], "host ENABLE_PROMPT_CACHING_1H is dropped");
    assert.deepEqual(cachingKeys(forcedSessionEnv("claude")), []);
    const on = { ...cfg, cacheDisable: true };
    assert.equal(buildSessionEnv(on, "claude", profile, "s1").DISABLE_PROMPT_CACHING, "1");
    assert.equal(forcedSessionEnv("claude", { cacheDisable: true }).DISABLE_PROMPT_CACHING, "1");
    for (const p of ["codex", "shell"]) {
      assert.deepEqual(cachingKeys(buildSessionEnv(on, p, profile, "s1")), []);
      assert.deepEqual(forcedSessionEnv(p, { cacheDisable: true }), {});
    }
  } finally {
    delete process.env.ENABLE_PROMPT_CACHING_1H;
  }
});

test("the forced env applied after the vault overrides a vault DISABLE_PROMPT_CACHING value", () => {
  const afterVault = { DISABLE_PROMPT_CACHING: "0", OTHER: "keep" };
  Object.assign(afterVault, forcedSessionEnv("claude", { cacheDisable: true }));
  assert.equal(afterVault.DISABLE_PROMPT_CACHING, "1");
  assert.equal(afterVault.OTHER, "keep");
  // Switch off: the vault value is not ours to touch.
  const off = { DISABLE_PROMPT_CACHING: "0" };
  Object.assign(off, forcedSessionEnv("claude", { cacheDisable: false }));
  assert.equal(off.DISABLE_PROMPT_CACHING, "0");
});

test("withUserBin puts ~/.local/bin first exactly once", async () => {
  const { withUserBin } = await import("../dist/providers.js");
  assert.equal(withUserBin("/home/agent", "/usr/local/bin:/usr/bin"), "/home/agent/.local/bin:/usr/local/bin:/usr/bin");
  assert.equal(withUserBin("/home/agent/", "/usr/bin:/home/agent/.local/bin"), "/home/agent/.local/bin:/usr/bin");
  assert.equal(withUserBin("/home/agent", undefined), "/home/agent/.local/bin");
});

test("mkcertEnv keeps the CA in the user's home and limits trust to the NSS store", async () => {
  const { mkcertEnv } = await import("../dist/providers.js");
  assert.deepEqual(mkcertEnv("/home/agent"), { CAROOT: "/home/agent/.local/share/mkcert", TRUST_STORES: "nss" });
  assert.equal(mkcertEnv("/home/agent/").CAROOT, "/home/agent/.local/share/mkcert");
});

test("image ships a sha256-pinned mkcert, certutil and an empty NSS db seed", async () => {
  const { readFileSync } = await import("node:fs");
  const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /libnss3-tools/);
  assert.match(docker, /MKCERT_VERSION=1\.4\.4/);
  assert.match(docker, /MKCERT_SHA256_AMD64=[0-9a-f]{64}/);
  assert.match(docker, /MKCERT_SHA256_ARM64=[0-9a-f]{64}/);
  assert.match(docker, /sha256sum -c/);
  const skel = readFileSync(new URL("../image/build-skel.sh", import.meta.url), "utf8");
  assert.match(skel, /certutil -N -d "sql:[^"]*" --empty-password/);
  assert.match(skel, /\.pki\/nssdb/);
});
