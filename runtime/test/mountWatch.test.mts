import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encryptSecret } from "../dist/crypto.js";
import { MountWatchdog, RestartStormGuard, recoverFromMountDeath } from "../dist/mountWatch.js";
import { gocryptfsArgv } from "../dist/shard.js";
import { ShardService } from "../dist/shards.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watchdog keeps one probe in flight and runs onDead once per death", async () => {
  let release!: () => void;
  let probes = 0;
  let dead = 0;
  const dog = new MountWatchdog(() => { probes++; return new Promise<boolean>((r) => { release = () => r(false); }); }, () => { dead++; });
  dog.start();
  const first = dog.tick();
  assert.equal(await dog.tick(), false, "second tick skipped while first is in flight");
  assert.equal(probes, 1);
  release();
  await first;
  assert.equal(dead, 1);
  dog.stop();
  assert.equal(await dog.tick(), false, "stopped watchdog never probes");
});

test("storm guard allows N per window, blocks, notifies once, recovers after the window", () => {
  const g = new RestartStormGuard(2, 1000);
  assert.equal(g.record("u", 0).allowed, true);
  assert.equal(g.record("u", 10).allowed, true);
  const a = g.record("u", 20);
  assert.deepEqual([a.allowed, a.firstBlock], [false, true]);
  assert.equal(g.record("u", 30).firstBlock, false);
  assert.equal(g.record("other", 30).allowed, true);
  assert.equal(g.record("u", 2000).allowed, true);
});

test("recovery restarts sessions and notifies; storm stops restarts and notifies once", async () => {
  const notices: { level: string }[] = [];
  let restarts = 0;
  const deps = {
    guard: new RestartStormGuard(1, 60_000),
    restartSessions: async () => { restarts++; return { restarted: 2, skipped: 1, failed: 0 }; },
    notify: (_u: string, n: { level: string }) => { notices.push(n); },
  };
  assert.equal(await recoverFromMountDeath(deps, "u"), "restarted");
  assert.equal(notices[0].level, "warning");
  assert.equal(await recoverFromMountDeath(deps, "u"), "storm");
  assert.equal(await recoverFromMountDeath(deps, "u"), "storm");
  assert.equal(restarts, 1);
  assert.deepEqual(notices.map((n) => n.level), ["warning", "error"]);
  const idle = { ...deps, guard: new RestartStormGuard(), restartSessions: async () => ({ restarted: 0, skipped: 0, failed: 0 }) };
  const before = notices.length;
  assert.equal(await recoverFromMountDeath(idle, "v"), "idle");
  assert.equal(notices.length, before, "no live agents: nothing lost, no notification");
});

test("ShardService: timer detects a dead mount, remounts, fires the recovery hook once; sleep stops the timer", async () => {
  const temp = mkdtempSync(join(tmpdir(), "floq-watch-"));
  try {
    const encryptionKey = randomBytes(32);
    const row = { uid: 20000, data_key_enc: encryptSecret(encryptionKey, randomBytes(32).toString("hex"), "shard:u1") };
    const pool = { query: async (sql: string) => ({ rows: sql.startsWith("SELECT uid") ? [row] : [] }) };
    let alive = true, wakes = 0, probes = 0, failRemount = false;
    const driver = {
      name: "linux",
      wake: async () => { if (failRemount) throw new Error("mount failed"); wakes++; alive = true; return { userId: "u1", uid: 20000, mountPath: temp }; },
      sleep: async () => undefined,
      isAlive: () => { probes++; return alive; },
    };
    const config = { encryptionKey, skelDir: join(temp, "no-skel"), preinstallSkills: false };
    const service = new ShardService(pool as never, config as never, driver as never);
    service.probeMs = 20;
    let recovered = 0;
    service.onMountRecovered = () => { recovered++; };

    await service.wake("u1");
    await sleep(70);
    assert.ok(probes >= 2, "live shard is probed repeatedly");
    assert.equal(recovered, 0);

    alive = false;
    failRemount = true;
    await sleep(70);
    assert.equal(recovered, 0, "no hook while the remount keeps failing");
    failRemount = false;
    await sleep(100);
    assert.equal(wakes, 2, "remounted once");
    assert.equal(recovered, 1, "hook fired once after the successful remount");
    await sleep(60);
    assert.equal(recovered, 1);

    await service.sleep("u1");
    const seen = probes;
    await sleep(80);
    assert.equal(probes, seen, "timer stopped when the shard slept");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("gocryptfs starts with a very low oom score unless disabled", () => {
  const on = gocryptfsArgv(["-q", "cipher", "mnt"], {});
  assert.equal(on.command, "/bin/sh");
  assert.match(on.args[1], /echo -900 > \/proc\/self\/oom_score_adj/);
  assert.deepEqual(on.args.slice(3), ["-q", "cipher", "mnt"]);
  assert.match(gocryptfsArgv([], { FLOQ_GOCRYPTFS_OOM_SCORE_ADJ: "-5000" }).args[1], /echo -1000 /);
  assert.deepEqual(gocryptfsArgv(["x"], { FLOQ_GOCRYPTFS_OOM_SCORE_ADJ: "0" }), { command: "gocryptfs", args: ["x"] });
});
