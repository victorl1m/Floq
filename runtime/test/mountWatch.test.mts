import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encryptSecret } from "../dist/crypto.js";
import { MountWatchdog, RestartStormGuard, recoverFromMountDeath } from "../dist/mountWatch.js";
import { gocryptfsArgv, probeMountAsync } from "../dist/shard.js";
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

test("watchdog marks a probe that never settles as hung after the timeout and never stacks probes", async () => {
  let probes = 0;
  const reasons: string[] = [];
  const dog = new MountWatchdog(() => { probes++; return new Promise<boolean>(() => undefined); }, (reason) => { reasons.push(reason); }, 10_000, 40);
  dog.start();
  const t0 = Date.now();
  const first = dog.tick();
  assert.equal(await dog.tick(), false, "no second probe while the first is pending");
  assert.equal(probes, 1);
  await first;
  assert.ok(Date.now() - t0 >= 35, "waited for the timeout");
  assert.deepEqual(reasons, ["hung"]);
  assert.equal(probes, 1);
  dog.stop();
});

test("probeMountAsync classifies alive, dead and hung without blocking", async () => {
  assert.equal(await probeMountAsync("/", 1000, "true", []), "alive");
  assert.equal(await probeMountAsync("/", 1000, "sh", ["-c", "echo 'ls: x: Transport endpoint is not connected' >&2; exit 2"]), "dead");
  assert.equal(await probeMountAsync("/", 1000, "sh", ["-c", "echo 'ls: x: No such file' >&2; exit 2"]), "alive");
  assert.equal(await probeMountAsync("/", 1000, "definitely-not-a-binary-xyz", []), "alive");
  let ticks = 0;
  const spin = setInterval(() => { ticks++; }, 5);
  const t0 = Date.now();
  assert.equal(await probeMountAsync("/", 150, "sleep", ["30"]), "hung");
  clearInterval(spin);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(ticks >= 10, "event loop kept running during the hung probe");
});

test("ShardService: a hung mount is abandoned (never probed synchronously), remounted, and recovery fires", async () => {
  const temp = mkdtempSync(join(tmpdir(), "floq-hung-"));
  try {
    const encryptionKey = randomBytes(32);
    const row = { uid: 20000, data_key_enc: encryptSecret(encryptionKey, randomBytes(32).toString("hex"), "shard:u1") };
    const pool = { query: async (sql: string) => ({ rows: sql.startsWith("SELECT uid") ? [row] : [] }) };
    let hung = false, wakes = 0, abandons = 0, syncProbes = 0;
    const driver = {
      name: "linux",
      wake: async () => { wakes++; hung = false; return { userId: "u1", uid: 20000, mountPath: temp }; },
      sleep: async () => undefined,
      isAlive: () => { syncProbes++; return !hung; },
      probe: async () => (hung ? "hung" as const : "alive" as const),
      abandon: async () => { abandons++; },
    };
    const config = { encryptionKey, skelDir: join(temp, "no-skel"), preinstallSkills: false };
    const service = new ShardService(pool as never, config as never, driver as never);
    service.probeMs = 20;
    let recovered = 0;
    service.onMountRecovered = () => { recovered++; };
    await service.wake("u1");
    const before = syncProbes;
    await sleep(60);
    assert.equal(syncProbes, before, "the timer never uses the synchronous probe when the driver has probe()");
    hung = true;
    await sleep(120);
    assert.equal(abandons, 1);
    assert.equal(wakes, 2);
    assert.equal(recovered, 1);
    await service.sleep("u1");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
