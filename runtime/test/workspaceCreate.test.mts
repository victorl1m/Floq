import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles } from "../dist/workspaceFiles.js";
import { createWorkspaceEntry, validateEntryName } from "../dist/workspaceWrite.js";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "floq-create-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "home", "workspace");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "exists.txt"), "keep");
  return { base, root, outside };
}
const trySymlink = (target, path) => { try { symlinkSync(target, path); return true; } catch { return false; } };
const rejects = (promise, status, code) => assert.rejects(promise, (e) => e.status === status && (!code || e.code === code));

test("creates an empty file and a folder, returns workspace-relative paths", async (t) => {
  const { root } = fixture(t);
  assert.deepEqual(await createWorkspaceEntry(root, "src", "new.ts", "file"), { path: "src/new.ts", type: "file" });
  assert.equal(statSync(join(root, "src", "new.ts")).size, 0);
  assert.deepEqual(await createWorkspaceEntry(root, "", "docs", "dir"), { path: "docs", type: "dir" });
  assert.ok(statSync(join(root, "docs")).isDirectory());
  assert.deepEqual(await createWorkspaceEntry(root, null, "top.md", "file"), { path: "top.md", type: "file" });
});

test("refuses to overwrite an existing entry", async (t) => {
  const { root } = fixture(t);
  await rejects(createWorkspaceEntry(root, "", "exists.txt", "file"), 409, "already_exists");
  await rejects(createWorkspaceEntry(root, "", "exists.txt", "dir"), 409, "already_exists");
  await rejects(createWorkspaceEntry(root, "", "src", "dir"), 409, "already_exists");
  assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "keep");
});

test("rejects bad names", async (t) => {
  const { root } = fixture(t);
  for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "../x", "x\0y", "tab\tname", ".git", "node_modules", "a".repeat(256), 5, null]) {
    await rejects(createWorkspaceEntry(root, "", bad, "file"), 400, "invalid_name");
  }
  assert.equal(validateEntryName("ok name.txt"), "ok name.txt");
  assert.equal(validateEntryName(".gitignore"), ".gitignore");
  await rejects(createWorkspaceEntry(root, "", "x", "socket"), 400, "invalid_kind");
});

test("rejects traversal, repository internals and missing parents", async (t) => {
  const { root, outside } = fixture(t);
  await rejects(createWorkspaceEntry(root, "../outside", "x", "file"), 400);
  await rejects(createWorkspaceEntry(root, "/etc", "x", "file"), 400);
  await rejects(createWorkspaceEntry(root, "src/../../outside", "x", "file"), 400);
  await rejects(createWorkspaceEntry(root, ".git", "x", "file"), 400);
  await rejects(createWorkspaceEntry(root, "node_modules", "x", "file"), 403);
  await rejects(createWorkspaceEntry(root, "missing", "x", "file"), 404);
  await rejects(createWorkspaceEntry(root, "exists.txt", "x", "file"), 404);
  assert.equal(existsSync(join(outside, "x")), false);
});

test("symlinks cannot escape the workspace", async (t) => {
  const { root, outside } = fixture(t);
  if (!trySymlink(outside, join(root, "link"))) return t.skip("symlinks unavailable");
  await rejects(createWorkspaceEntry(root, "link", "x.txt", "file"), 400);
  await rejects(createWorkspaceEntry(root, "link", "d", "dir"), 400);
  assert.equal(existsSync(join(outside, "x.txt")), false);
  assert.equal(existsSync(join(outside, "d")), false);
  // A planted symlink with the requested name is never followed or replaced.
  trySymlink(join(outside, "target.txt"), join(root, "planted"));
  await rejects(createWorkspaceEntry(root, "", "planted", "file"), 409, "already_exists");
  assert.equal(existsSync(join(outside, "target.txt")), false);
  assert.ok(lstatSync(join(root, "planted")).isSymbolicLink());
});

test("symlink inside the workspace is allowed as a parent", async (t) => {
  const { root } = fixture(t);
  if (!trySymlink(join(root, "src"), join(root, "alias"))) return t.skip("symlinks unavailable");
  assert.deepEqual(await createWorkspaceEntry(root, "alias", "ok.txt", "file"), { path: "alias/ok.txt", type: "file" });
  assert.ok(existsSync(join(root, "src", "ok.txt")));
});

test("created entries are chowned to the sandbox uid", async (t) => {
  const { root } = fixture(t);
  const me = process.getuid?.();
  if (me === undefined) return t.skip("no uid");
  // chown to our own uid always succeeds; verifies the path is exercised and ownership matches.
  await createWorkspaceEntry(root, "", "f", "file", me);
  await createWorkspaceEntry(root, "", "d", "dir", me);
  assert.equal(statSync(join(root, "f")).uid, me);
  assert.equal(statSync(join(root, "d")).uid, me);
  if (me === 0) {
    await createWorkspaceEntry(root, "", "g", "file", 4242);
    assert.equal(statSync(join(root, "g")).uid, 4242);
  } else {
    // Unprivileged: chowning to another uid fails and leaves nothing behind.
    await assert.rejects(createWorkspaceEntry(root, "", "h", "file", me + 1));
    assert.equal(existsSync(join(root, "h")), false);
    await assert.rejects(createWorkspaceEntry(root, "", "hd", "dir", me + 1));
    assert.equal(existsSync(join(root, "hd")), false);
  }
});

test("WorkspaceFiles.create is owner scoped and passes the shard uid", async (t) => {
  const { base, root } = fixture(t);
  const manager = { get: async (_id, userId) => { if (userId !== "owner") throw Object.assign(new Error("nope"), { status: 404 }); return { cwd: "workspace" }; } };
  const shards = { wake: async () => ({ mountPath: join(base, "home"), uid: process.getuid?.() }), driver: { hostPath: (h, rel) => join(h.mountPath, rel) } };
  const files = new WorkspaceFiles(manager, shards);
  assert.deepEqual(await files.create("owner", "s", { path: "src", name: "a.txt", kind: "file" }), { path: "src/a.txt", type: "file" });
  await rejects(files.create("intruder", "s", { path: "src", name: "b.txt", kind: "file" }), 404);
  assert.equal(existsSync(join(root, "src", "b.txt")), false);
});

test("openWithin refuses a symlinked final component with 404 (ELOOP), even one that stays inside the root", async (t) => {
  const { openWithin } = await import("../dist/workspaceFiles.js");
  const { root, outside } = fixture(t);
  writeFileSync(join(root, "real.txt"), "ok");
  writeFileSync(join(outside, "secret.txt"), "secret");
  if (!trySymlink(join(root, "real.txt"), join(root, "inner-link.txt")) || !trySymlink(join(outside, "secret.txt"), join(root, "out-link.txt"))) return;
  const handle = await openWithin(root, join(root, "real.txt"));
  await handle.close();
  await rejects(openWithin(root, join(root, "inner-link.txt")), 404);
  await rejects(openWithin(root, join(root, "out-link.txt")), 404);
  const followed = await openWithin(root, join(root, "inner-link.txt"), undefined, true);
  await followed.close();
  await rejects(openWithin(root, join(root, "out-link.txt"), undefined, true), 400);
});
