import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProjectBranchSwitch, listProjectBranches, switchProjectBranch } from "../dist/projectBranches.js";

const execFile = promisify(execFileCallback);
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
async function git(cwd: string, args: string[]) { return (await execFile("git", args, { cwd, env: ENV })).stdout; }
const runner = (cwd: string) => async (args: string[]) => {
  try { const { stdout, stderr } = await execFile("git", args, { cwd, env: ENV }); return { stdout: stdout + stderr, exitCode: 0 }; }
  catch (error) { const e = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), exitCode: typeof e.code === "number" ? e.code : 1 }; }
};

async function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "floq-remote-branches-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin"), clone = join(root, "clone");
  await execFile("git", ["init", "--initial-branch=main", origin], { env: ENV });
  for (const [k, v] of [["user.name", "T"], ["user.email", "t@example.invalid"]]) await git(origin, ["config", k, v]);
  writeFileSync(join(origin, "a.txt"), "a\n"); await git(origin, ["add", "a.txt"]); await git(origin, ["commit", "-m", "init"]);
  await git(origin, ["branch", "homologacao/maria-enesa-ia-generativa"]);
  await git(origin, ["branch", "floq/2765ee49-77a7-4a51-96ec-4ca2b9394c59"]);
  await execFile("git", ["clone", "--quiet", origin, clone], { env: ENV });
  await git(clone, ["branch", "floq/8eb8ec9d-1055-4a27-9315-048a005c612f"]);
  return { origin, clone };
}

test("remote-only branches are listed and marked; Floq agent branches are hidden", async (t) => {
  const { clone } = await setup(t);
  const result = await listProjectBranches(runner(clone));
  assert.deepEqual(result.branches, ["homologacao/maria-enesa-ia-generativa", "main"]);
  assert.deepEqual(result.remoteOnly, ["homologacao/maria-enesa-ia-generativa"]);
  assert.equal(result.currentBranch, "main");
});

test("fetch picks up a branch pushed after the clone; a failing fetch only sets fetchError", async (t) => {
  const { origin, clone } = await setup(t);
  await git(origin, ["branch", "feat/new-on-remote"]);
  assert.ok(!(await listProjectBranches(runner(clone))).branches.includes("feat/new-on-remote"));
  const fetched = await listProjectBranches(runner(clone), { fetch: true });
  assert.ok(fetched.branches.includes("feat/new-on-remote"));
  assert.equal(fetched.fetchError, undefined);
  await git(clone, ["remote", "set-url", "origin", join(origin, "missing")]);
  const failed = await listProjectBranches(runner(clone), { fetch: true });
  assert.ok(failed.fetchError);
  assert.ok(failed.branches.includes("main"));
});

test("switching to a remote-only branch creates a local branch tracking it", async (t) => {
  const { clone } = await setup(t);
  const checked = await checkProjectBranchSwitch(runner(clone), "homologacao/maria-enesa-ia-generativa");
  assert.equal(checked.trackRemote, "origin/homologacao/maria-enesa-ia-generativa");
  assert.equal(await switchProjectBranch(runner(clone), "homologacao/maria-enesa-ia-generativa"), "homologacao/maria-enesa-ia-generativa");
  assert.equal((await git(clone, ["symbolic-ref", "--short", "HEAD"])).trim(), "homologacao/maria-enesa-ia-generativa");
  assert.equal((await git(clone, ["rev-parse", "--abbrev-ref", "@{upstream}"])).trim(), "origin/homologacao/maria-enesa-ia-generativa");
  const after = await listProjectBranches(runner(clone));
  assert.deepEqual(after.remoteOnly, []);
});

test("unknown, option-like and agent branches are refused", async (t) => {
  const { clone } = await setup(t);
  await assert.rejects(checkProjectBranchSwitch(runner(clone), "nope"), /no longer available/);
  await assert.rejects(checkProjectBranchSwitch(runner(clone), "--orphan"), /valid branch/);
  await assert.rejects(checkProjectBranchSwitch(runner(clone), "floq/2765ee49-77a7-4a51-96ec-4ca2b9394c59"), /no longer available/);
});
