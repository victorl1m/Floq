import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles, cleanRelativePath, resolveInside } from "../dist/workspaceFiles.js";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "floq-files-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "home", "workspace");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  writeFileSync(join(root, ".git", "config"), "[remote]\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  return { base, root, outside };
}

function trySymlink(target, path, type) {
  try { symlinkSync(target, path, type); return true; } catch { return false; }
}

// Minimal stand-ins: the session cwd is "workspace" inside a fake mount.
function service(base) {
  const manager = { get: async () => ({ cwd: "workspace" }) };
  const shards = { wake: async () => ({ mountPath: join(base, "home") }), driver: { hostPath: (h, rel) => join(h.mountPath, rel) } };
  return new WorkspaceFiles(manager, shards);
}

test("cleanRelativePath rejects traversal, absolute, backslash, NUL and .git paths", () => {
  assert.equal(cleanRelativePath(""), "");
  assert.equal(cleanRelativePath(undefined), "");
  assert.equal(cleanRelativePath("./src//a.ts"), "src/a.ts");
  for (const bad of ["../x", "src/../../x", "/etc/passwd", "src" + String.fromCharCode(92) + "a.ts", "a\0b", ".git/config", "src/.git/x", 5]) {
    assert.throws(() => cleanRelativePath(bad), { code: "invalid_file_path" }, String(bad));
  }
});

test("resolveInside rejects symlinks that escape the root", async (t) => {
  const { root, outside } = fixture(t);
  assert.ok((await resolveInside(root, "src/a.ts")).real.endsWith("a.ts"));
  await assert.rejects(resolveInside(root, "missing.txt"), { status: 404 });
  const linked = trySymlink(outside, join(root, "escape"), "junction");
  const fileLinked = trySymlink(join(outside, "secret.txt"), join(root, "secret-link.txt"), "file");
  if (linked) {
    await assert.rejects(resolveInside(root, "escape"), { code: "invalid_file_path" });
    await assert.rejects(resolveInside(root, "escape/secret.txt"), { code: "invalid_file_path" });
  }
  if (fileLinked) await assert.rejects(resolveInside(root, "secret-link.txt"), { code: "invalid_file_path" });
  if (!linked && !fileLinked) t.diagnostic("symlinks unavailable on this platform; escape cases skipped");
});

test("lists lazily, hides .git and node_modules, reads text and flags binary", async (t) => {
  const { base, root, outside } = fixture(t);
  const files = service(base);
  const top = await files.list("u", "s", "");
  assert.deepEqual(top.entries.map((e) => `${e.type}:${e.name}`), ["dir:src", "file:bin.dat", "file:README.md"]);
  const src = await files.list("u", "s", "src");
  assert.deepEqual(src.entries.map((e) => e.path), ["src/a.ts"]);
  await assert.rejects(files.list("u", "s", ".git"), { code: "invalid_file_path" });
  await assert.rejects(files.read("u", "s", ".git/config"), { code: "invalid_file_path" });
  await assert.rejects(files.read("u", "s", "../outside/secret.txt"), { code: "invalid_file_path" });
  await assert.rejects(files.read("u", "s", "src"), { status: 404 });
  assert.equal((await files.read("u", "s", "src/a.ts")).content, "export const a = 1;\n");
  assert.equal((await files.read("u", "s", "bin.dat")).binary, true);
  writeFileSync(join(root, "big.txt"), "x".repeat(600 * 1024));
  const big = await files.read("u", "s", "big.txt");
  assert.equal(big.tooLarge, true);
  assert.equal(big.content, "");
  if (trySymlink(outside, join(root, "escape"), "junction")) {
    assert.ok(!(await files.list("u", "s", "")).entries.some((e) => e.name === "escape"));
  }
});
