import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectTrust, claudeStartupSettings, readClaudeProjectConfig } from "../dist/claudeSettings.js";
import { managedTrustDirectories } from "../dist/codexTrust.js";

test("Claude startup supplies compaction defaults for new and existing settings", () => {
  const original = { env: { PROJECT_FLAG: "keep" }, theme: "dark" };
  const settings = claudeStartupSettings(original, false);
  assert.equal(settings.autoCompactEnabled, true);
  assert.equal(settings.idleCompaction, true);
  assert.deepEqual(settings.env, { PROJECT_FLAG: "keep", CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "150000" });
  assert.deepEqual(original.env, { PROJECT_FLAG: "keep" });
  assert.deepEqual(claudeStartupSettings(settings, false), settings);
});

test("Claude compaction defaults preserve explicit user overrides", () => {
  const original = { autoCompactEnabled: false, idleCompaction: false, env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "250000", DISABLE_AUTO_COMPACT: "1" } };
  const settings = claudeStartupSettings(original, true);
  assert.equal(settings.autoCompactEnabled, false);
  assert.equal(settings.idleCompaction, false);
  assert.deepEqual(settings.env, original.env);
});

test("Claude startup fills the terminal and follows explicit auto-approve without replacing permissions", () => {
  const original = { permissions: { deny: ["Read(.env)"] }, theme: "dark", tui: "default" };
  const enabled = claudeStartupSettings(original, true);
  assert.equal(enabled.tui, "fullscreen");
  assert.equal(enabled.skipDangerousModePermissionPrompt, true);
  assert.deepEqual(enabled.permissions, original.permissions);
  assert.equal(claudeStartupSettings(enabled, false).skipDangerousModePermissionPrompt, false);
  assert.equal(original.tui, "default");
});

test("Claude trusts exact managed checkouts, preserves MCP/login state, and excludes unrelated paths", () => {
  const directories = managedTrustDirectories("/home/agent", "/mnt/floq/24017", ["workspace/project", ".floq/worktrees/child", "../other", "/etc"]);
  assert.deepEqual(directories, ["/home/agent/.floq/worktrees/child", "/home/agent/workspace/project", "/mnt/floq/24017/.floq/worktrees/child", "/mnt/floq/24017/workspace/project"]);
  const original = { mcpServers: { context7: { command: "npx" } }, oauthAccount: { accountUuid: "fixture" }, projects: { "/home/agent/workspace/project": { allowedTools: ["Read"], hasTrustDialogAccepted: false }, "/other": { hasTrustDialogAccepted: false } } };
  const config = claudeProjectTrust(original, directories);
  assert.deepEqual(config.mcpServers, original.mcpServers);
  assert.deepEqual(config.oauthAccount, original.oauthAccount);
  assert.deepEqual(config.projects["/home/agent/workspace/project"], { allowedTools: ["Read"], hasTrustDialogAccepted: true });
  assert.equal(config.projects["/other"].hasTrustDialogAccepted, false);
  assert.equal(original.projects["/home/agent/workspace/project"].hasTrustDialogAccepted, false);
  assert.deepEqual(claudeProjectTrust(config, directories), config);
});

test("Claude trust config reads regular files but rejects symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "floq-claude-config-"));
  try {
    const configPath = join(root, ".claude.json");
    const outsidePath = join(root, "outside.json");
    writeFileSync(outsidePath, JSON.stringify({ projects: { "/outside": { hasTrustDialogAccepted: false } } }));
    assert.deepEqual(readClaudeProjectConfig(configPath), {});
    writeFileSync(configPath, JSON.stringify({ oauthAccount: { accountUuid: "fixture" } }));
    assert.deepEqual(readClaudeProjectConfig(configPath), { oauthAccount: { accountUuid: "fixture" } });
    rmSync(configPath);
    symlinkSync(outsidePath, configPath);
    assert.throws(() => readClaudeProjectConfig(configPath), /symlink|too many levels/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude cache TTL: auto writes no keys, 1h/5m set promptCacheTtl, helper TTL maps to subagentPromptCacheTtl", () => {
  for (const cache of [undefined, {}, { ttl: "auto", helperTtl: "auto" }] as const) {
    const settings = claudeStartupSettings({}, false, cache);
    assert.equal("promptCacheTtl" in settings, false);
    assert.equal("subagentPromptCacheTtl" in settings, false);
  }
  assert.equal(claudeStartupSettings({}, false, { ttl: "1h" }).promptCacheTtl, "1h");
  assert.equal(claudeStartupSettings({}, false, { ttl: "5m" }).promptCacheTtl, "5m");
  const helper = claudeStartupSettings({}, false, { helperTtl: "1h" });
  assert.equal(helper.subagentPromptCacheTtl, "1h");
  assert.equal("promptCacheTtl" in helper, false);
});

test("Claude cache TTL: the user's own setting wins over the Floq default", () => {
  const settings = claudeStartupSettings({ promptCacheTtl: "5m", subagentPromptCacheTtl: "5m" }, false, { ttl: "1h", helperTtl: "1h" });
  assert.equal(settings.promptCacheTtl, "5m");
  assert.equal(settings.subagentPromptCacheTtl, "5m");
});

test("Claude cache TTL: a value Floq wrote is removed when the config returns to auto; a user's value survives", () => {
  const first = claudeStartupSettings({}, false, { ttl: "1h", helperTtl: "1h" });
  assert.equal(first.promptCacheTtl, "1h");
  assert.deepEqual(first.floqManaged, { promptCacheTtl: "1h", subagentPromptCacheTtl: "1h" });
  // Relaunch with the same config: stable, still Floq's.
  assert.deepEqual(claudeStartupSettings(first, false, { ttl: "1h", helperTtl: "1h" }), first);
  // Back to auto: Floq's leftovers go away, marker too.
  const auto = claudeStartupSettings(first, false, { ttl: "auto", helperTtl: "auto" });
  assert.equal("promptCacheTtl" in auto, false);
  assert.equal("subagentPromptCacheTtl" in auto, false);
  assert.equal("floqManaged" in auto, false);
  // Another TTL replaces Floq's value.
  assert.equal(claudeStartupSettings(first, false, { ttl: "5m" }).promptCacheTtl, "5m");
  assert.equal("subagentPromptCacheTtl" in claudeStartupSettings(first, false, { ttl: "5m" }), false);
  // The user changed it to a different value after Floq wrote 1h: never touched, never overwritten.
  const edited = { ...first, promptCacheTtl: "5m" };
  assert.equal(claudeStartupSettings(edited, false, { ttl: "auto" }).promptCacheTtl, "5m");
  assert.equal(claudeStartupSettings(edited, false, { ttl: "1h" }).promptCacheTtl, "5m");
  assert.equal("promptCacheTtl" in (claudeStartupSettings(edited, false, { ttl: "auto" }).floqManaged as object ?? {}), false);
  // A user value equal to the Floq default, set before Floq wrote anything, is not claimed by Floq.
  const own = claudeStartupSettings({ promptCacheTtl: "1h" }, false, { ttl: "1h" });
  assert.equal("floqManaged" in own, false);
  assert.equal(claudeStartupSettings(own, false, { ttl: "auto" }).promptCacheTtl, "1h");
});

test("Claude startup disables transcript cleanup and a user value cannot lower it", () => {
  assert.equal(claudeStartupSettings({}, false).cleanupPeriodDays, 100000);
  assert.equal(claudeStartupSettings({ cleanupPeriodDays: 30 }, false).cleanupPeriodDays, 100000);
  assert.equal(claudeStartupSettings({ cleanupPeriodDays: 1 }, true).cleanupPeriodDays, 100000);
});
