import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHomeFile, UnsafeHomePathError } from "../src/shard.ts";
import { SessionManager } from "../src/manager.ts";

const uid = process.getuid!();
const token = (t: string) => JSON.stringify({ claudeAiOauth: { accessToken: t, refreshToken: "r-" + t, expiresAt: Date.now() + 3 * 3600_000, scopes: ["user:inference"], subscriptionType: "max" } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "floq-home-"));
  const victim = join(root, "victim");
  const home = join(root, "home");
  mkdirSync(join(victim, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(victim, ".claude", ".credentials.json"), token("victim-secret"));
  return { root, victim, home, cred: join(home, ".claude", ".credentials.json") };
}

test("readHomeFile reads a regular file, null when absent", () => {
  const f = fixture();
  try {
    assert.equal(readHomeFile(f.home, f.cred, uid), null);
    writeFileSync(f.cred, "{}");
    assert.equal(readHomeFile(f.home, f.cred, uid)?.text, "{}");
    assert.equal(readHomeFile(f.home, join(f.home, "nope", "x.json"), uid), null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("readHomeFile refuses a symlinked leaf, a symlinked directory, a FIFO, a foreign owner and oversize", () => {
  const f = fixture();
  try {
    symlinkSync(join(f.victim, ".claude", ".credentials.json"), f.cred);
    assert.throws(() => readHomeFile(f.home, f.cred, uid), UnsafeHomePathError);
    rmSync(f.cred);

    symlinkSync(join(f.victim, ".claude"), join(f.home, "linked"));
    assert.throws(() => readHomeFile(f.home, join(f.home, "linked", ".credentials.json"), uid), UnsafeHomePathError);

    execFileSync("mkfifo", [f.cred]);
    const started = Date.now();
    assert.throws(() => readHomeFile(f.home, f.cred, uid), UnsafeHomePathError); // must not block
    assert.ok(Date.now() - started < 2000);
    rmSync(f.cred);

    writeFileSync(f.cred, "{}");
    assert.throws(() => readHomeFile(f.home, f.cred, uid + 1), UnsafeHomePathError);
    writeFileSync(f.cred, "x".repeat(100));
    assert.throws(() => readHomeFile(f.home, f.cred, uid, 50), UnsafeHomePathError);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function manager(home: string, adopted: unknown[]) {
  const handle = { userId: "u1", uid, mountPath: home };
  const shards = { isAwake: () => true, wake: async () => handle, driver: { name: "local", hostPath: (_h: unknown, rel: string) => join(home, rel) } };
  const credentials = { adopt: async (_u: string, _p: string, data: unknown) => { adopted.push(data); return true; } };
  const m = new SessionManager({ shardLockDelayMs: 20, models: { codex: [] } } as never, {} as never, shards as never, {} as never);
  (m as any).credentials = credentials;
  return m;
}

test("syncClaudeNow never adopts a token reached through a symlink or FIFO", async () => {
  const f = fixture();
  const adopted: unknown[] = [];
  const m = manager(f.home, adopted);
  try {
    symlinkSync(join(f.victim, ".claude", ".credentials.json"), f.cred);
    await m.syncClaudeNow("u1");
    assert.deepEqual(adopted, []);
    rmSync(f.cred);

    execFileSync("mkfifo", [f.cred]);
    await m.syncClaudeNow("u1"); // must return, not hang
    assert.deepEqual(adopted, []);
    rmSync(f.cred);

    writeFileSync(f.cred, token("own-token"));
    await m.syncClaudeNow("u1");
    assert.equal(adopted.length, 1);
    assert.equal((adopted[0] as { accessToken: string }).accessToken, "own-token");
  } finally { clearInterval((m as any).reaper); rmSync(f.root, { recursive: true, force: true }); }
});
