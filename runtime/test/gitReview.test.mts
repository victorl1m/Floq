import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitReview } from "../dist/gitReview.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("lists and reads staged, unstaged, renamed, untracked, binary and literal-pathspec changes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "floq-git-review-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "workspace", "project");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Floq test");
  git(repo, "config", "user.email", "floq-test@example.invalid");

  const initial = {
    "space file.txt": "before\n",
    "literal[1].txt": "old\n",
    "literal1.txt": "unrelated\n",
    "rename-from.txt": "rename content\n",
    "staged.txt": "original\n",
  };
  for (const [name, contents] of Object.entries(initial)) writeFileSync(join(repo, name), contents);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture");

  writeFileSync(join(repo, "space file.txt"), "changed in worktree\n");
  writeFileSync(join(repo, "literal[1].txt"), "literal changed\n");
  writeFileSync(join(repo, "staged.txt"), "staged version\n");
  git(repo, "add", "staged.txt");
  writeFileSync(join(repo, "staged.txt"), "unstaged version\n");
  git(repo, "mv", "rename-from.txt", "rename-to.txt");
  writeFileSync(join(repo, "untracked space.txt"), "new file\n");
  writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 255]));

  const fakeShards = {
    driver: {
      name: "local",
      hostPath: (_handle, relative) => join(home, ...relative.split("/")),
    },
    wake: async () => ({ userId: "user-1", uid: typeof process.getuid === "function" ? process.getuid() : 1000, mountPath: home }),
  };
  const fakeManager = { get: async (id, userId) => {
    assert.equal(id, "session-1");
    assert.equal(userId, "user-1");
    return { cwd: "workspace/project" };
  } };
  const review = new GitReview(fakeManager, fakeShards);
  const list = await review.changes("user-1", "session-1");
  assert.equal(list.repository, "project");
  assert.equal(list.truncated, false);
  const byPath = new Map(list.changes.map((change) => [change.path, change]));
  assert.ok(byPath.has("space file.txt"));
  assert.ok(byPath.get("staged.txt").staged && byPath.get("staged.txt").unstaged);
  assert.ok(byPath.has("literal[1].txt"));
  assert.ok(byPath.get("rename-to.txt").originalPath === "rename-from.txt");
  assert.ok(byPath.get("untracked space.txt").untracked);

  const literalDiff = await review.diff("user-1", "session-1", "literal[1].txt");
  assert.match(literalDiff.patch, /literal changed/);
  assert.doesNotMatch(literalDiff.patch, /staged version/);
  const stagedAndUnstaged = await review.diff("user-1", "session-1", "staged.txt");
  assert.match(stagedAndUnstaged.patch, /staged version/);
  assert.match(stagedAndUnstaged.patch, /unstaged version/);
  const untracked = await review.diff("user-1", "session-1", "untracked space.txt");
  assert.match(untracked.patch, /new file/);
  const binary = await review.diff("user-1", "session-1", "binary.dat");
  assert.equal(binary.binary, true);
  const rename = await review.diff("user-1", "session-1", "rename-to.txt");
  assert.match(rename.patch, /rename from rename-from\.txt/);
  assert.match(rename.patch, /rename to rename-to\.txt/);
});

test("rejects a Git common directory outside the user's shard", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "floq-git-review-"));
  const external = mkdtempSync(join(tmpdir(), "floq-git-external-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  const repo = join(home, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "--separate-git-dir", external);
  const fakeShards = {
    driver: { name: "local", hostPath: (_handle, relative) => join(home, ...relative.split("/")) },
    wake: async () => ({ userId: "user-1", uid: 1000, mountPath: home }),
  };
  const review = new GitReview({ get: async () => ({ cwd: "repo" }) }, fakeShards);
  await assert.rejects(review.changes("user-1", "session-1"), { code: "invalid_git_workspace" });
});

