import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../dist/worktree.js";
import { Orchestrator, selectableAgentModels } from "../dist/orchestrator.js";
import { ownHomeAliasArgs } from "../dist/sandboxPaths.js";
import { buildRecruitPayload, formatAgentListEntry, formatModel, formatRecruitment, parseArgs } from "../dist/image/floq-args.mjs";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

test("sandbox exposes only the current user's shard at its Git metadata path", () => {
  const args = ownHomeAliasArgs("/mnt/floq/20001", "/mnt/floq");
  assert.deepEqual(args.slice(-3), ["--bind", "/mnt/floq/20001", "/mnt/floq/20001"]);
  assert.ok(args.includes("--dir") && args.includes("/mnt/floq"));
  assert.equal(args.some((arg) => arg.includes("cipher") || arg.includes("20002")), false);
  assert.throws(() => ownHomeAliasArgs("/var/lib/floq/shards/cipher/20001", "/mnt/floq"), /direct child/);
});

test("recruit CLI keeps worktree isolation opt-in and parses --isolated as a flag", () => {
  assert.deepEqual(parseArgs(["Builder", "--provider", "codex", "--model", "gpt-6.1-sol", "--isolated", "--role", "review this"]), {
    positional: ["Builder"],
    named: { provider: "codex", model: "gpt-6.1-sol", isolated: true, role: "review this" },
  });
  assert.deepEqual(parseArgs(["Builder"]).named, {});
  const id = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(parseArgs([id, "please review"]), { positional: [id, "please review"], named: {} });
  assert.equal(formatAgentListEntry({ id, name: "Builder", provider: "claude", model: "haiku", state: "running", lead: false, self: false }), "  Builder  " + id + "  [claude, configured model: haiku, running]");
  const fullTitle = "A long native session title ".repeat(5);
  assert.ok(formatAgentListEntry({ id, name: fullTitle, provider: "claude", model: null, state: "running", lead: false, self: false }).includes(fullTitle));
  assert.equal(formatRecruitment({ id, name: "Builder", provider: "claude", model: "haiku" }), "recruited Builder " + id + " (claude, configured model: haiku)");
  assert.equal(formatModel("claude", { id: "haiku", label: "Haiku" }), "claude\thaiku\tHaiku");
  const parsed = parseArgs(["Haiku A", "--provider", "claude", "--model", "haiku", "--cwd", "workspace/repo", "--isolated", "--role", "write a haiku"]);
  assert.deepEqual(buildRecruitPayload(parsed.positional, parsed.named), {
    name: "Haiku A", provider: "claude", model: "haiku", cwd: "workspace/repo", role: "write a haiku", isolated: true,
  });
  const help = spawnSync(process.execPath, ["dist/image/floq.mjs", "--help"], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH } });
  assert.equal(help.status, 0);
  for (const flag of ["--model", "--cwd", "--isolated", "floq models"]) assert.ok(help.stdout.toString().includes(flag));
});

test("isolated worktrees start at committed HEAD, keep source edits, disable hooks, and reject collisions", { skip: !gitAvailable }, async () => {
  const home = mkdtempSync(join(tmpdir(), "floq-worktree-test-"));
  try {
    const source = join(home, "repo");
    const target = join(home, ".floq", "worktrees", "worker-id");
    mkdirSync(source);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Floq Test"], { cwd: source });
    execFileSync("git", ["config", "user.email", "floq-test@example.invalid"], { cwd: source });
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: source, stdio: "ignore" });
    writeFileSync(join(source, "tracked.txt"), "uncommitted source edit\n");
    writeFileSync(join(source, "untracked.txt"), "uncommitted file\n");
    writeFileSync(join(source, ".git", "hooks", "post-checkout"), `#!/bin/sh\nprintf ran > '${join(home, "hook-ran")}'\n`, { mode: 0o755 });

    const userGitCommands = [];
    const result = await createWorktree({
      home,
      source,
      target,
      branch: "floq/00000000-0000-0000-0000-000000000001",
      runAsUser: async (args) => {
        userGitCommands.push(args);
        return execFileSync("git", args, {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: process.env.TEMP ?? "/tmp", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
        }).trim();
      },
    });
    assert.equal(userGitCommands.length, 3);
    for (const args of userGitCommands) {
      assert.ok(args.includes("-c") && args.includes("core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null")));
    }
    assert.equal(result.cwd.replaceAll("\\", "/"), ".floq/worktrees/worker-id");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: target, encoding: "utf8" }).trim(), "floq/00000000-0000-0000-0000-000000000001");
    assert.equal(readFileSync(join(target, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(readFileSync(join(source, "tracked.txt"), "utf8"), "uncommitted source edit\n");
    assert.equal(readFileSync(join(source, "untracked.txt"), "utf8"), "uncommitted file\n");
    assert.throws(() => readFileSync(join(target, "untracked.txt")));
    assert.throws(() => readFileSync(join(home, "hook-ran")));
    await assert.rejects(createWorktree({ home, source, target, branch: "floq/00000000-0000-0000-0000-000000000002" }), /already exists/);
    assert.equal(readFileSync(join(target, "tracked.txt"), "utf8"), "committed\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("project membership groups isolated workers with their parent and separates explicit workspace roots", async () => {
  const agents = [
    { id: "00000000-0000-4000-8000-000000000001", title: "Lead", provider: "claude", model: null, state: "running", lead: true, cwd: "workspace/repo-a", git_url: "https://example.test/repo-a.git", project_cwd: "workspace/repo-a" },
    { id: "00000000-0000-4000-8000-000000000002", title: "Worker", provider: "codex", model: "gpt-6.1-sol", state: "running", lead: false, cwd: ".floq/worktrees/worker", git_url: null, project_cwd: "workspace/repo-a" },
    { id: "00000000-0000-4000-8000-000000000003", title: "Worker", provider: "claude", model: "haiku", state: "sleeping", lead: false, cwd: ".floq/worktrees/worker-two", git_url: null, project_cwd: "workspace/repo-a" },
    { id: "00000000-0000-4000-8000-000000000004", title: "Other", provider: "claude", model: null, state: "running", lead: false, cwd: "workspace/repo-b", git_url: "https://example.test/repo-b.git", project_cwd: "workspace/repo-b" },
  ];
  const pool = { query: async () => ({ rows: agents }) };
  const orchestrator = new Orchestrator(pool, {}, {});
  const listed = await orchestrator.list("user", "00000000-0000-4000-8000-000000000001", { here: true });
  assert.deepEqual(listed.map((agent) => [agent.id, agent.name]), [
    ["00000000-0000-4000-8000-000000000001", "Lead"],
    ["00000000-0000-4000-8000-000000000002", "Worker"],
    ["00000000-0000-4000-8000-000000000003", "Worker"],
  ]);
  assert.deepEqual(await orchestrator.connect("user", listed[0].id, listed[0].id, listed[1].id), { ok: true });
  await assert.rejects(orchestrator.connect("user", listed[0].id, "Lead", "Worker"), /use its Floq UUID/);
  await assert.rejects(orchestrator.connect("user", listed[0].id, listed[0].id, "Other"), /outside your project/);
});

test("recruit forwards an explicit configured model and returns the canonical Floq id", async () => {
  const leadId = "00000000-0000-4000-8000-000000000011";
  const workerId = "00000000-0000-4000-8000-000000000012";
  const rows = [{ id: leadId, title: "Lead", provider: "claude", model: null, state: "running", lead: true, role: "orchestrator", cwd: "workspace/repo", git_url: null, project_cwd: "workspace/repo", project_id: null, workspace_id: null }];
  let createdInput;
  const manager = { create: async (_user, _profile, input) => { createdInput = input; return { id: workerId, model: input.model, state: "running" }; }, findLive: () => null };
  const settings = { profile: async () => ({}) };
  const orchestrator = new Orchestrator({ query: async () => ({ rows }) }, manager, settings);
  assert.deepEqual(await orchestrator.recruit("user", leadId, { name: "Haiku A", provider: "claude", model: "haiku" }), {
    id: workerId, name: "Haiku A", provider: "claude", model: "haiku", state: "running",
  });
  assert.equal(createdInput.model, "haiku");
});

test("recruit maps --cwd to a registered workspace and rejects unregistered paths", async () => {
  const leadId = "00000000-0000-4000-8000-000000000021";
  const workerId = "00000000-0000-4000-8000-000000000022";
  const lead = { id: leadId, title: "Lead", provider: "claude", model: null, state: "running", lead: true, role: "orchestrator", cwd: ".floq/worktrees/current", git_url: "https://example.test/repo.git", project_cwd: "workspace/repo", project_id: "project-id", workspace_id: "worktree-id" };
  const workspaces = [
    { id: "main-id", cwd: "workspace/repo" },
    { id: "worktree-id", cwd: ".floq/worktrees/current" },
  ];
  const pool = { query: async (query, params) => query.includes("SELECT id,cwd FROM floq_project_workspaces") ? { rows: workspaces.filter((workspace) => workspace.cwd === params[2]) } : { rows: [lead] } };
  let createdInput;
  const manager = { create: async (_user, _profile, input) => { createdInput = input; return { id: workerId, model: null, state: "running" }; }, findLive: () => null };
  const orchestrator = new Orchestrator(pool, manager, { profile: async () => ({}) });
  await orchestrator.recruit("user", leadId, { name: "Root worker", cwd: "workspace/repo" });
  assert.equal(createdInput.cwd, "workspace/repo");
  assert.equal(createdInput.workspaceId, "main-id");
  await assert.rejects(orchestrator.recruit("user", leadId, { name: "Unknown cwd", cwd: "workspace/not-registered" }), /registered workspace/);
});

test("Claude-only model lookup does not trigger Codex model discovery", async () => {
  let codexLookups = 0;
  const models = await selectableAgentModels(
    { models: { claude: [{ id: "haiku", label: "Haiku" }], codex: [] }, codexModelsOverridden: false },
    async () => { codexLookups++; return []; },
    "user",
    "claude",
  );
  assert.deepEqual(models, { claude: [{ id: "default", label: "Default", default: true }, { id: "haiku", label: "Haiku" }] });
  assert.equal(codexLookups, 0);
});
