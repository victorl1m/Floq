import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../../src/lib/runtime/projects.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { composeProjectEntries, groupByProject } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));

const session = (id, cwd, projectCwd, gitUrl = null) => ({
  id,
  provider: "claude",
  title: id,
  state: "running",
  cwd,
  projectCwd,
  gitUrl,
});

test("sidebar groups isolated worker under its parent while retaining each terminal cwd", () => {
  const parent = session("lead", "workspace/repo", "workspace/repo", "https://example.test/repo.git");
  const worker = session("worker", ".floq/worktrees/worker", "workspace/repo", "https://example.test/repo.git");
  const groups = groupByProject([parent, worker]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cwd, "workspace/repo");
  assert.deepEqual(groups[0].sessions.map((item) => item.cwd), ["workspace/repo", ".floq/worktrees/worker"]);

  const entries = composeProjectEntries([parent, worker], [{ label: "repo", url: "https://example.test/repo.git", workspaceCwds: ["workspace/repo"] }], [], []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cwd, "workspace/repo");
  assert.equal(entries[0].sessions.length, 2);
});

test("fresh clients and empty recent-repo metadata still group an isolated child under its server project", () => {
  const parent = session("lead", "workspace/deadbeef", "workspace/deadbeef", "https://example.test/repo.git");
  const worker = session("worker", ".floq/worktrees/worker", "workspace/deadbeef");
  const entries = composeProjectEntries([parent, worker], [], [], []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "example.test/repo");
  assert.equal(entries[0].sessions.length, 2);
  assert.equal(entries[0].sessions.find((item) => item.id === "worker").cwd, ".floq/worktrees/worker");
});

test("recent repo grouping infers isolated children without saved workspace cwd hints", () => {
  const parent = session("lead", "workspace/repo", "workspace/repo", "https://example.test/repo.git");
  const worker = session("worker", ".floq/worktrees/worker", "workspace/repo");
  const entries = composeProjectEntries([parent, worker], [{ label: "repo", url: "https://example.test/repo.git" }], [], []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessions.length, 2);
});

test("explicit roots keep cloned workspace IDs separate from one another and from legacy scratch", () => {
  const a = session("a", "workspace/aaaaaaaa", "workspace/aaaaaaaa", "https://example.test/a.git");
  const b = session("b", "workspace/bbbbbbbb", "workspace/bbbbbbbb", "https://example.test/b.git");
  const legacyScratch = session("scratch", "workspace/cccccccc", null);
  const groups = groupByProject([a, b, legacyScratch]);
  assert.equal(groups.length, 3);
  assert.deepEqual(new Set(groups.map((group) => group.sessions[0].id)), new Set(["a", "b", "scratch"]));
});

test("legacy clone project-root backfill is scoped to the same user's cloned cwd", () => {
  const migration = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  assert.match(migration, /UPDATE agent_sessions AS child SET project_cwd = child\.cwd/);
  assert.match(migration, /repo\.user_id = child\.user_id AND repo\.git_url IS NOT NULL AND repo\.cwd = child\.cwd/);
});
