import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles } from "../dist/workspaceFiles.js";
import { mkdirOwned, writeFileOwned, pruneOldEntriesAsync, TMP_MAX_AGE_MS } from "../dist/shard.js";
import { isAllowedGitUrl } from "../dist/manager.js";
import { GIT_HARDENING_ARGS, GIT_HARDENING_ENV } from "../dist/worktree.js";

const uid = process.getuid?.() ?? 0;
const tmp = (t) => { const d = mkdtempSync(join(tmpdir(), "floq-sec-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

function service(base) {
  const manager = { get: async () => ({ cwd: "workspace" }) };
  const shards = { wake: async () => ({ mountPath: join(base, "home") }), driver: { hostPath: (h, rel) => join(h.mountPath, rel) } };
  return new WorkspaceFiles(manager, shards);
}

test("file browser read/list stay inside the workspace and skip escaping links (descriptor-verified)", async (t) => {
  const base = tmp(t);
  const root = join(base, "home", "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(base, "outside"));
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(base, "outside", "secret.txt"), "secret\n");
  symlinkSync(join(base, "outside"), join(root, "escape"));
  symlinkSync(join(base, "outside", "secret.txt"), join(root, "leak.txt"));
  const files = service(base);
  const listing = await files.list("u", "s", "");
  assert.deepEqual(listing.entries.map((e) => e.name).sort(), ["README.md", "src"]);
  assert.equal((await files.read("u", "s", "README.md")).content, "hello\n");
  await assert.rejects(files.read("u", "s", "leak.txt"));
  await assert.rejects(files.list("u", "s", "escape"));
});

test("file browser read does not block on a FIFO", async (t) => {
  const base = tmp(t);
  const root = join(base, "home", "workspace");
  mkdirSync(root, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("mkfifo", [join(root, "pipe")]).status !== 0) return t.skip("mkfifo unavailable");
  await assert.rejects(service(base).read("u", "s", "pipe"), /no longer available/);
});

test("mkdirOwned rejects symlinked segments and writeFileOwned never follows a planted symlink", (t) => {
  const base = tmp(t);
  const home = join(base, "home");
  const victim = join(base, "victim");
  mkdirSync(home); mkdirSync(victim);
  writeFileSync(join(victim, "target"), "keep");
  symlinkSync(victim, join(home, "x"));
  assert.throws(() => mkdirOwned(home, join(home, "x", "new", "dir"), uid), /symlink/);
  assert.equal(existsSync(join(victim, "new")), false);
  mkdirOwned(home, join(home, "a", "b"), uid);
  assert.ok(lstatSync(join(home, "a", "b")).isDirectory());

  symlinkSync(join(victim, "target"), join(home, "cred.json"));
  writeFileOwned(home, join(home, "cred.json"), "secret", uid, 0o600);
  assert.equal(readFileSync(join(victim, "target"), "utf8"), "keep", "symlink target untouched");
  assert.equal(lstatSync(join(home, "cred.json")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(home, "cred.json"), "utf8"), "secret");
  assert.equal(lstatSync(join(home, "cred.json")).mode & 0o777, 0o600);
});

test("pruneOldEntriesAsync removes old entries only", async (t) => {
  const dir = tmp(t);
  const past = new Date(Date.now() - TMP_MAX_AGE_MS - 3600_000);
  writeFileSync(join(dir, "old"), "x"); utimesSync(join(dir, "old"), past, past);
  writeFileSync(join(dir, "fresh"), "x");
  assert.equal(await pruneOldEntriesAsync(dir, TMP_MAX_AGE_MS), 1);
  assert.equal(existsSync(join(dir, "old")), false);
  assert.equal(existsSync(join(dir, "fresh")), true);
});

test("clone URL rejects option-like hosts", () => {
  for (const ok of ["https://github.com/a/b.git", "ssh://git@github.com/a/b.git", "git@github.com:a/b.git"]) assert.equal(isAllowedGitUrl(ok), true, ok);
  for (const bad of ["ssh://-oProxyCommand=x/a", "ssh://git@-host/a", "git@-host:a/b", "https://-x/a", "ext::sh -c x", "file:///etc"]) assert.equal(isAllowedGitUrl(bad), false, bad);
});

test("git hardening neutralises attribute sources", () => {
  assert.equal(GIT_HARDENING_ENV.GIT_ATTR_NOSYSTEM, "1");
  assert.ok(GIT_HARDENING_ENV.GIT_ATTR_SOURCE);
  assert.ok(GIT_HARDENING_ARGS.includes("core.attributesFile=/dev/null"));
});
