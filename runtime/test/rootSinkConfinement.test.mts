import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureArtifactsDir } from "../src/artifacts.ts";
import { GitReview } from "../src/gitReview.ts";
import { SessionManager } from "../src/manager.ts";
import { ShardService } from "../src/shards.ts";
import {
  chmodHomeDir, copySeedTree, lstatHome, mkdirOwned, mkdirOwnedSegment, pruneHomeEntriesAsync, pruneHomeFiles, UnsafeHomePathError, writeFileOwned,
} from "../src/shard.ts";
import { createWorktree } from "../src/worktree.ts";

/*
 * Every root-side sink in runtime/src that touches a path the agent can write must refuse (never follow, never block on):
 *  - a symlink planted where a directory or file is expected, pointing at another tenant's home (or /etc);
 *  - a FIFO planted where a regular file or directory is expected.
 * The "victim" tree below stands for another tenant's mounted home. A test fails when anything in it is created, changed or chmod'ed.
 */
const uid = process.getuid!();
const TIMEOUT = { timeout: 20_000 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "floq-sinks-"));
  const home = join(root, "home");
  const victim = join(root, "victim");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(victim, "secret"), { recursive: true });
  writeFileSync(join(victim, "secret", "token.txt"), "victim-secret");
  chmodSync(join(victim, "secret", "token.txt"), 0o644);
  chmodSync(join(victim, "secret"), 0o755);
  return { root, home, victim };
}
const fifo = (path: string) => execFileSync("mkfifo", [path]);
const victimIntact = (f: { victim: string }) => {
  assert.deepEqual(readdirSync(f.victim), ["secret"], "nothing was created next to the victim's data");
  assert.deepEqual(readdirSync(join(f.victim, "secret")), ["token.txt"], "nothing was created in the victim's tree");
  assert.equal(readFileSync(join(f.victim, "secret", "token.txt"), "utf8"), "victim-secret");
  assert.equal(statSync(join(f.victim, "secret", "token.txt")).mode & 0o777, 0o644);
  assert.equal(statSync(join(f.victim, "secret")).mode & 0o777, 0o755);
};
const cleanup = (f: { root: string }) => rmSync(f.root, { recursive: true, force: true });

/** A SessionManager shell with just the collaborators the sink under test touches. */
function managerFor(home: string) {
  const handle = { userId: "u1", uid, mountPath: home };
  const manager = Object.create(SessionManager.prototype) as any;
  manager.shards = {
    wake: async () => handle,
    awakeHandle: () => handle,
    driver: { name: "local", hostPath: (_h: unknown, rel: string) => join(home, ...rel.split("/")), homePath: () => "/home/agent" },
  };
  return { manager, handle };
}

test("mkdirOwned: a symlinked or FIFO segment is refused and nothing is created through it", TIMEOUT, () => {
  const f = fixture();
  try {
    symlinkSync(f.victim, join(f.home, "x"));
    assert.throws(() => mkdirOwned(f.home, join(f.home, "x", "secret", "new"), uid), UnsafeHomePathError);
    symlinkSync("/etc", join(f.home, "etc"));
    assert.throws(() => mkdirOwned(f.home, join(f.home, "etc", "floq-planted"), uid), UnsafeHomePathError);
    assert.equal(existsSync("/etc/floq-planted"), false);
    fifo(join(f.home, "pipe"));
    assert.throws(() => mkdirOwned(f.home, join(f.home, "pipe", "child"), uid), UnsafeHomePathError);
    victimIntact(f);
  } finally { cleanup(f); }
});

test("mkdirOwnedSegment: a symlinked parent is refused before anything is created", TIMEOUT, () => {
  const f = fixture();
  try {
    symlinkSync(f.victim, join(f.home, "x"));
    assert.throws(() => mkdirOwnedSegment(f.home, join(f.home, "x", "new"), uid), UnsafeHomePathError);
    fifo(join(f.home, "pipe"));
    assert.throws(() => mkdirOwnedSegment(f.home, join(f.home, "pipe", "new"), uid));
    victimIntact(f);
  } finally { cleanup(f); }
});

test("writeFileOwned: a symlinked parent is refused; a planted symlink or FIFO leaf is replaced, never opened", TIMEOUT, () => {
  const f = fixture();
  try {
    symlinkSync(f.victim, join(f.home, "x"));
    assert.throws(() => writeFileOwned(f.home, join(f.home, "x", "secret", "token.txt"), "pwned", uid, 0o600), UnsafeHomePathError);
    symlinkSync(join(f.victim, "secret", "token.txt"), join(f.home, "leaf"));
    writeFileOwned(f.home, join(f.home, "leaf"), "mine", uid, 0o600);
    assert.equal(lstatSync(join(f.home, "leaf")).isSymbolicLink(), false);
    fifo(join(f.home, "pipe"));
    writeFileOwned(f.home, join(f.home, "pipe"), "mine", uid, 0o600); // an open() of the FIFO would block forever
    assert.equal(lstatSync(join(f.home, "pipe")).isFIFO(), false);
    assert.equal(readFileSync(join(f.home, "pipe"), "utf8"), "mine");
    victimIntact(f);
  } finally { cleanup(f); }
});

test("chmodHomeDir and lstatHome: a symlinked directory or ancestor is refused, the target's mode never changes", TIMEOUT, () => {
  const f = fixture();
  try {
    symlinkSync(join(f.victim, "secret"), join(f.home, "tmp")); // the prepareTmp / secret dir shape
    assert.throws(() => chmodHomeDir(f.home, join(f.home, "tmp"), 0o1777), UnsafeHomePathError);
    symlinkSync(f.victim, join(f.home, "x"));
    assert.throws(() => chmodHomeDir(f.home, join(f.home, "x", "secret"), 0o777), UnsafeHomePathError);
    assert.throws(() => lstatHome(f.home, join(f.home, "x", "secret", "token.txt")), UnsafeHomePathError);
    assert.equal(lstatHome(f.home, join(f.home, "nothing")), null);
    fifo(join(f.home, "pipe"));
    assert.throws(() => chmodHomeDir(f.home, join(f.home, "pipe"), 0o777));
    assert.equal(lstatHome(f.home, join(f.home, "pipe"))?.isFIFO(), true);
    victimIntact(f);
  } finally { cleanup(f); }
});

test("pruning: a symlinked directory is refused, stale links and FIFOs inside are unlinked without being opened", TIMEOUT, async () => {
  const f = fixture();
  try {
    const old = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(f.victim, "secret", "token.txt"), old, old);
    symlinkSync(join(f.victim, "secret"), join(f.home, "handoff"));
    assert.throws(() => pruneHomeFiles(f.home, join(f.home, "handoff"), 1000), UnsafeHomePathError);
    await assert.rejects(pruneHomeEntriesAsync(f.home, join(f.home, "handoff"), 1000), UnsafeHomePathError);
    victimIntact(f);

    mkdirSync(join(f.home, "tmp"));
    symlinkSync(f.victim, join(f.home, "tmp", "link"));
    fifo(join(f.home, "tmp", "pipe"));
    for (const name of ["link", "pipe"]) { /* lutimes is unavailable: age the entries through their (pinned) parent below */ void name; }
    // Age the directory contents: only real files carry an mtime we can set; the link and FIFO are removed with their parent entry.
    mkdirSync(join(f.home, "tmp", "olddir"));
    symlinkSync(f.victim, join(f.home, "tmp", "olddir", "link"));
    fifo(join(f.home, "tmp", "olddir", "pipe"));
    utimesSync(join(f.home, "tmp", "olddir"), old, old);
    const removed = await pruneHomeEntriesAsync(f.home, join(f.home, "tmp"), 86_400_000, Date.now() + 40 * 86_400_000);
    assert.ok(removed >= 1);
    assert.equal(existsSync(join(f.home, "tmp", "olddir")), false);
    victimIntact(f);
  } finally { cleanup(f); }
});

test("copySeedTree: planted links and FIFOs in the destination are skipped, a symlinked destination is refused", TIMEOUT, () => {
  const f = fixture();
  try {
    const skel = join(f.root, "skel");
    mkdirSync(join(skel, ".claude", "skills"), { recursive: true });
    writeFileSync(join(skel, ".claude", "settings.json"), "{}");
    writeFileSync(join(skel, ".claude", "skills", "a.md"), "a");
    writeFileSync(join(skel, "plain.txt"), "plain");
    // The agent pre-plants: ~/.claude -> victim, ~/plain.txt as a FIFO.
    symlinkSync(f.victim, join(f.home, ".claude"));
    fifo(join(f.home, "plain.txt"));
    copySeedTree(f.home, skel, f.home, uid);
    assert.equal(lstatSync(join(f.home, ".claude")).isSymbolicLink(), true, "the planted link is left alone");
    assert.equal(lstatSync(join(f.home, "plain.txt")).isFIFO(), true, "the FIFO was not opened or replaced");
    victimIntact(f);
    // A destination that is itself (or lies behind) a symlink is refused outright.
    symlinkSync(f.victim, join(f.home, "dest"));
    assert.throws(() => copySeedTree(f.home, skel, join(f.home, "dest"), uid), UnsafeHomePathError);
    assert.throws(() => copySeedTree(f.home, skel, join(f.home, "dest", "secret"), uid), UnsafeHomePathError);
    victimIntact(f);
    // Normal case still copies and never overwrites.
    const clean = join(f.home, "clean");
    mkdirSync(clean);
    writeFileSync(join(clean, "plain.txt"), "mine");
    copySeedTree(f.home, skel, clean, uid);
    assert.equal(readFileSync(join(clean, "plain.txt"), "utf8"), "mine");
    assert.equal(readFileSync(join(clean, ".claude", "skills", "a.md"), "utf8"), "a");
  } finally { cleanup(f); }
});

test("ShardService.seed: a symlinked ~/.claude is not written through (home-pinned), others still seed", TIMEOUT, () => {
  const f = fixture();
  try {
    const skel = join(f.root, "skel");
    mkdirSync(join(skel, ".claude"), { recursive: true });
    writeFileSync(join(skel, ".claude", "settings.json"), "{}");
    writeFileSync(join(skel, ".bashrc"), "# skel");
    symlinkSync(f.victim, join(f.home, ".claude"));
    const service = new ShardService({} as never, { skelDir: skel, preinstallSkills: false } as never, {} as never);
    service.seed(f.home, ".", uid, new Set(), f.home);
    assert.equal(readFileSync(join(f.home, ".bashrc"), "utf8"), "# skel");
    assert.equal(existsSync(join(f.victim, "settings.json")), false);
    assert.equal(existsSync(join(f.victim, "secret", "settings.json")), false);
    victimIntact(f);
  } finally { cleanup(f); }
});

test("ensureArtifactsDir: a symlinked or FIFO Artifacts folder is refused; the victim gets no project directory", TIMEOUT, () => {
  const f = fixture();
  try {
    const handle = { mountPath: f.home, uid };
    symlinkSync(f.victim, join(f.home, "Artifacts"));
    assert.throws(() => ensureArtifactsDir(handle, "proj"), /unsafe/i);
    rmSync(join(f.home, "Artifacts"));
    mkdirSync(join(f.home, "Artifacts"));
    symlinkSync(f.victim, join(f.home, "Artifacts", "proj"));
    assert.throws(() => ensureArtifactsDir(handle, "proj"), /unsafe/i);
    rmSync(join(f.home, "Artifacts", "proj"));
    fifo(join(f.home, "Artifacts", "proj"));
    assert.throws(() => ensureArtifactsDir(handle, "proj"), /unsafe/i);
    victimIntact(f);
  } finally { cleanup(f); }
});

test("attachment and project directories: a symlinked ~/.floq is refused (400) and the victim stays untouched", TIMEOUT, () => {
  const f = fixture();
  try {
    const { manager, handle } = managerFor(f.home);
    symlinkSync(f.victim, join(f.home, ".floq"));
    assert.throws(() => manager.prepareAttachmentDirectory(handle), (e: any) => e.status === 400 && e.code === "unsafe_attachment_path");
    assert.throws(() => manager.ensureProjectParent(handle), (e: any) => e.status === 400 && e.code === "unsafe_project_path");
    rmSync(join(f.home, ".floq"));
    mkdirSync(join(f.home, ".floq"));
    fifo(join(f.home, ".floq", "attachments"));
    assert.throws(() => manager.prepareAttachmentDirectory(handle), (e: any) => e.status === 400 && e.code === "unsafe_attachment_path");
    victimIntact(f);
  } finally { cleanup(f); }
});

test("secret files: a planted ~/.floq/secrets link is refused; planted leaf links and FIFOs are replaced, the victim's mode is untouched", TIMEOUT, () => {
  const f = fixture();
  try {
    const { manager, handle } = managerFor(f.home);
    mkdirSync(join(f.home, ".floq", "secrets"), { recursive: true });
    // 1. the per-session secret directory is a symlink to the victim's tree (dir chmod 0700 / files 0400 would land there)
    symlinkSync(join(f.victim, "secret"), join(f.home, ".floq", "secrets", "s1"));
    assert.throws(() => manager.writeSecretFile(handle, "s1", "TOKEN", "v"), UnsafeHomePathError);
    victimIntact(f);
    // a full re-sync unlinks the planted link itself (never its target) and builds a real private directory in its place
    manager.syncSecretFiles(handle, "s1", { TOKEN: "v" });
    assert.equal(lstatSync(join(f.home, ".floq", "secrets", "s1")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(f.home, ".floq", "secrets", "s1", "TOKEN"), "utf8"), "v");
    victimIntact(f);
    // 2. the file slot is a symlink to a victim file, then a FIFO
    manager.syncSecretFiles(handle, "s2", { TOKEN: "first" });
    symlinkSync(join(f.victim, "secret", "token.txt"), join(f.home, ".floq", "secrets", "s2", "LINK"));
    manager.writeSecretFile(handle, "s2", "LINK", "mine");
    fifo(join(f.home, ".floq", "secrets", "s2", "PIPE"));
    manager.writeSecretFile(handle, "s2", "PIPE", "mine");
    for (const name of ["LINK", "PIPE"]) {
      const info = lstatSync(join(f.home, ".floq", "secrets", "s2", name));
      assert.ok(info.isFile() && !info.isSymbolicLink());
      assert.equal(info.mode & 0o777, 0o400);
      assert.equal(readFileSync(join(f.home, ".floq", "secrets", "s2", name), "utf8"), "mine");
    }
    assert.equal(statSync(join(f.home, ".floq", "secrets", "s2")).mode & 0o777, 0o700);
    victimIntact(f);
    // 3. removal unlinks links and FIFOs instead of following them
    manager.syncSecretFiles(handle, "s2", {});
    assert.equal(existsSync(join(f.home, ".floq", "secrets", "s2")), false);
    victimIntact(f);
  } finally { cleanup(f); }
});

test("handoff file: a symlinked ~/.floq/handoff is refused and never pruned through; a FIFO entry does not block", TIMEOUT, async () => {
  const f = fixture();
  try {
    const old = new Date(Date.now() - 30 * 86_400_000);
    writeFileSync(join(f.victim, "secret", "old.md"), "victim-handoff");
    utimesSync(join(f.victim, "secret", "old.md"), old, old);
    const { manager } = managerFor(f.home);
    mkdirSync(join(f.home, ".floq"));
    symlinkSync(join(f.victim, "secret"), join(f.home, ".floq", "handoff"));
    await assert.rejects(manager.writeHandoffFile("u1", "x.md", "hello"));
    assert.equal(readFileSync(join(f.victim, "secret", "old.md"), "utf8"), "victim-handoff", "stale victim file survived the prune");
    assert.equal(existsSync(join(f.victim, "secret", "x.md")), false);
    rmSync(join(f.home, ".floq", "handoff"));
    mkdirSync(join(f.home, ".floq", "handoff"));
    fifo(join(f.home, ".floq", "handoff", "pipe.md"));
    fifo(join(f.home, ".floq", "handoff", "x.md"));
    const path = await manager.writeHandoffFile("u1", "x.md", "hello");
    assert.equal(path, "/home/agent/.floq/handoff/x.md");
    assert.equal(readFileSync(join(f.home, ".floq", "handoff", "x.md"), "utf8"), "hello");
  } finally { cleanup(f); }
});

test("credential files: removal and rewrite never follow a symlinked ~/.claude or ~/.codex", TIMEOUT, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.victim, "secret", ".credentials.json"), "victim-cred");
    writeFileSync(join(f.victim, "secret", "auth.json"), "victim-auth");
    const { manager, handle } = managerFor(f.home);
    manager.credMtime = new Map();
    symlinkSync(join(f.victim, "secret"), join(f.home, ".claude"));
    symlinkSync(join(f.victim, "secret"), join(f.home, ".codex"));
    manager.removeHome(handle, join(f.home, ".claude", ".credentials.json"));
    manager.removeHome(handle, join(f.home, ".codex", "auth.json"));
    assert.throws(() => manager.writeCredFile(handle, join(f.home, ".claude", ".credentials.json"), "new"));
    for (const name of [".credentials.json", "auth.json"]) assert.ok(readFileSync(join(f.victim, "secret", name), "utf8").startsWith("victim-"));
    // a FIFO in the credential slot is replaced by the rename, not opened
    rmSync(join(f.home, ".claude"));
    mkdirSync(join(f.home, ".claude"));
    fifo(join(f.home, ".claude", ".credentials.json"));
    manager.writeCredFile(handle, join(f.home, ".claude", ".credentials.json"), "new");
    assert.equal(readFileSync(join(f.home, ".claude", ".credentials.json"), "utf8"), "new");
  } finally { cleanup(f); }
});

test("checkout branch checks: a symlinked .git, a symlinked or FIFO HEAD, and an escaping gitdir all read as 'not a checkout' without blocking", TIMEOUT, () => {
  const f = fixture();
  try {
    const { manager, handle } = managerFor(f.home);
    const reject = (cwd: string) => assert.throws(() => manager.assertSafeRegisteredCheckout(handle, cwd), (e: any) => e.status === 400);
    const repo = join(f.home, "ws", "a");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    assert.doesNotThrow(() => manager.assertSafeRegisteredCheckout(handle, "ws/a"));
    // .git -> another tenant's repo
    mkdirSync(join(f.victim, "repo", ".git"), { recursive: true });
    writeFileSync(join(f.victim, "repo", ".git", "HEAD"), "ref: refs/heads/stolen\n");
    mkdirSync(join(f.home, "ws", "b"));
    symlinkSync(join(f.victim, "repo", ".git"), join(f.home, "ws", "b", ".git"));
    reject("ws/b");
    // HEAD is a FIFO (a plain readFileSync would hang the whole runtime)
    mkdirSync(join(f.home, "ws", "c", ".git"), { recursive: true });
    fifo(join(f.home, "ws", "c", ".git", "HEAD"));
    reject("ws/c");
    // HEAD is a symlink to the victim's HEAD
    mkdirSync(join(f.home, "ws", "d", ".git"), { recursive: true });
    symlinkSync(join(f.victim, "repo", ".git", "HEAD"), join(f.home, "ws", "d", ".git", "HEAD"));
    reject("ws/d");
    // .git is a FIFO
    mkdirSync(join(f.home, "ws", "e"));
    fifo(join(f.home, "ws", "e", ".git"));
    reject("ws/e");
    // worktree-style marker pointing outside the home
    mkdirSync(join(f.home, "ws", "g"));
    writeFileSync(join(f.home, "ws", "g", ".git"), `gitdir: ${join(f.victim, "repo", ".git")}\n`);
    reject("ws/g");
    // a symlinked ancestor of the checkout
    symlinkSync(f.victim, join(f.home, "ws", "h"));
    reject("ws/h/repo");
  } finally { cleanup(f); }
});

test("git review: a FIFO or symlink as objects/info/alternates is refused (400) without blocking", TIMEOUT, async () => {
  const f = fixture();
  try {
    const repo = join(f.home, "workspace", "project");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    mkdirSync(join(repo, ".git", "objects", "info"), { recursive: true });
    const driver = {
      name: "linux",
      spawnPipe: (_h: unknown, spec: { file: string; args: string[]; env: Record<string, string> }) => spawn(spec.file, spec.args, { stdio: ["ignore", "pipe", "pipe"], env: spec.env }),
      hostPath: (_h: unknown, rel: string) => join(f.home, ...rel.split("/")),
    };
    const review = new GitReview({ get: async () => ({ cwd: "workspace/project" }) } as never, { driver, wake: async () => ({ userId: "u1", uid, mountPath: f.home }) } as never);
    const alternates = join(repo, ".git", "objects", "info", "alternates");
    fifo(alternates);
    await assert.rejects(review.changes("u1", "s1"), (e: any) => e.status === 400 && e.code === "invalid_git_workspace");
    rmSync(alternates);
    writeFileSync(join(f.victim, "secret", "alt.txt"), join(repo, ".git", "objects") + "\n");
    symlinkSync(join(f.victim, "secret", "alt.txt"), alternates);
    await assert.rejects(review.changes("u1", "s1"), (e: any) => e.status === 400 && e.code === "invalid_git_workspace");
  } finally { cleanup(f); }
});

test("createWorktree: a symlinked destination parent is refused and the victim gets no directory", TIMEOUT, async () => {
  const f = fixture();
  try {
    const repo = join(f.home, "ws", "repo");
    mkdirSync(repo, { recursive: true });
    const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    g("init", "-q"); g("config", "user.name", "t"); g("config", "user.email", "t@example.invalid");
    writeFileSync(join(repo, "a.txt"), "a");
    g("add", "."); g("commit", "-qm", "init");
    symlinkSync(f.victim, join(f.home, "wt"));
    await assert.rejects(
      createWorktree({ home: f.home, source: repo, target: join(f.home, "wt", "secret", "new"), branch: "floq/11111111-1111-1111-1111-111111111111", uid }),
      (e: any) => e.status === 400,
    );
    fifo(join(f.home, "pipeparent"));
    await assert.rejects(
      createWorktree({ home: f.home, source: repo, target: join(f.home, "pipeparent", "new"), branch: "floq/22222222-2222-2222-2222-222222222222", uid }),
    );
    victimIntact(f);
  } finally { cleanup(f); }
});
