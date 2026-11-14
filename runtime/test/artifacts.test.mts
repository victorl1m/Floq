import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifacts, artifactsGuidance, artifactsRel, ensureArtifactsDir } from "../dist/artifacts.js";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "floq-artifacts-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const handle = { mountPath: home, uid: process.getuid() };
  const manager = { get: async () => ({ projectId: "proj-1" }), withUserShardActivity: async (_u, fn) => fn(handle) };
  const shards = { wake: async () => handle, driver: { homePath: () => "/home/user" } };
  return { base, home, handle, svc: new Artifacts(manager, shards) };
}

test("creates Artifacts/<project> and is idempotent", (t) => {
  const { home, handle } = fixture(t);
  const dir = ensureArtifactsDir(handle, "proj-1");
  assert.equal(dir, join(home, "Artifacts", "proj-1"));
  assert.ok(lstatSync(dir).isDirectory());
  assert.equal(ensureArtifactsDir(handle, "proj-1"), dir);
  assert.equal(artifactsRel("../x"), "Artifacts/default");
  assert.match(artifactsGuidance("/home/user/Artifacts/p"), /FLOQ_ARTIFACTS_DIR/);
  const claude = artifactsGuidance("/home/user/Artifacts/p", "claude");
  assert.match(claude, /\/home\/user\/Artifacts\/p/);
  assert.match(claude, /replaces the claude\.ai Artifact tool[\s\S]*disabled in Floq/);
  assert.match(claude, /scratchpad[\s\S]*throwaway[\s\S]*never the only copy/);
  assert.match(claude, /Artifacts tab/);
  const codex = artifactsGuidance("/home/user/Artifacts/p", "codex");
  assert.match(codex, /\/home\/user\/Artifacts\/p/);
  assert.match(codex, /\/tmp is only for throwaway[\s\S]*never the only copy/);
  assert.doesNotMatch(codex, /claude\.ai/);
});

test("refuses a symlinked Artifacts parent", (t) => {
  const { base, home, handle } = fixture(t);
  mkdirSync(join(base, "elsewhere"));
  try { symlinkSync(join(base, "elsewhere"), join(home, "Artifacts")); } catch { return; }
  assert.throws(() => ensureArtifactsDir(handle, "proj-1"), (e) => e.code === "unsafe_artifacts_path");
  assert.equal(existsSync(join(base, "elsewhere", "proj-1")), false);
});

test("lists files newest first, skips symlinks and dotfiles, reads and authorizes downloads", async (t) => {
  const { base, handle, svc } = fixture(t);
  const dir = ensureArtifactsDir(handle, "proj-1");
  writeFileSync(join(dir, "old.md"), "# old");
  writeFileSync(join(dir, "new.txt"), "hello");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "deep.csv"), "a,b");
  writeFileSync(join(dir, ".hidden"), "x");
  writeFileSync(join(base, "secret"), "nope");
  try { symlinkSync(join(base, "secret"), join(dir, "link.txt")); } catch { /* ignore */ }
  utimesSync(join(dir, "old.md"), 1000, 1000);
  utimesSync(join(dir, "sub", "deep.csv"), 2000, 2000);
  const listing = await svc.list("u", "s");
  assert.deepEqual(listing.entries.map((e) => e.path), ["new.txt", "sub/deep.csv", "old.md"]);
  assert.equal(listing.entries[0].size, 5);
  assert.equal(listing.dir, "/home/user/Artifacts/proj-1");
  assert.equal((await svc.read("u", "s", "new.txt")).content, "hello");
  await assert.rejects(svc.read("u", "s", "link.txt"));
  await assert.rejects(svc.read("u", "s", "../secret"));
  assert.equal(await svc.authorizeDownload("u", "s", "new.txt"), "@artifacts/new.txt");
  await assert.rejects(svc.authorizeDownload("u", "s", ""));
  assert.throws(() => svc.download("u", "s", "new.txt", {}), (e) => e.status === 404);
});

test("rejects a root that was swapped for a symlink after the safety walk", async (t) => {
  const { base, home, svc } = fixture(t);
  const dir = ensureArtifactsDir({ mountPath: home, uid: process.getuid() }, "proj-1");
  writeFileSync(join(dir, "ok.txt"), "ok");
  mkdirSync(join(base, "elsewhere", "proj-1"), { recursive: true });
  writeFileSync(join(base, "elsewhere", "proj-1", "stolen.txt"), "secret");
  let reads = 0;
  const handle = { uid: process.getuid(), get mountPath() {
    // read 1 = ensureArtifactsDir's walk; read 2 happens after it, so swap there.
    if (++reads === 2) { try { renameSync(join(home, "Artifacts"), join(home, "Artifacts.bak")); symlinkSync(join(base, "elsewhere"), join(home, "Artifacts")); } catch { /* ignore */ } }
    return home;
  } };
  const swapped = new Artifacts({ get: async () => ({ projectId: "proj-1" }), withUserShardActivity: async (_u, fn) => fn(handle) }, { wake: async () => handle, driver: { homePath: () => "/home/user" } });
  await assert.rejects(swapped.read("u", "s", "stolen.txt"), (e) => e.status === 404);
  assert.ok(reads >= 2, "swap hook ran");
  void svc;
});
