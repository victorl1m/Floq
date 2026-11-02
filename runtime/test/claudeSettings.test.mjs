import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectTrust, claudeStartupSettings, readClaudeProjectConfig } from "../dist/claudeSettings.js";
import { managedTrustDirectories } from "../dist/codexTrust.js";

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
