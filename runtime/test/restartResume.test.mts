import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// node-pty's native binding may be missing (CI/dev boxes): replace the module before dist/pty.js loads it.
const requireCjs = createRequire(import.meta.url);
const captured: Array<{ file: string; args: string[] }> = [];
const ptyId = requireCjs.resolve("node-pty");
requireCjs.cache[ptyId] = { id: ptyId, filename: ptyId, loaded: true, children: [], paths: [], exports: { spawn: (file: string, args: string[]) => { captured.push({ file, args }); return { pid: 1 }; } } } as any;
const { BOOT_RESUME_NOTICE, SessionManager } = await import("../dist/manager.js");

type Listener = (frame: { type: string }) => void;

function fakeSession(id: string, over: Record<string, unknown> = {}) {
  const listeners = new Set<Listener>();
  const written: string[] = [];
  return {
    id, userId: "u1", provider: "claude", isAlive: true, hasExited: false, written,
    toSummary: () => ({ id, seq: 7 }),
    broadcast() {}, dispose() {},
    subscribe(l: Listener) { listeners.add(l); return () => listeners.delete(l); },
    emit(frame: { type: string }) { for (const l of [...listeners]) l(frame); },
    write(d: string) { written.push(d); },
    ...over,
  } as any;
}

function shutdownManager(sessions: any[], working: Set<string>, queries: Array<{ sql: string; params: unknown[] }>) {
  const manager = Object.create(SessionManager.prototype) as any;
  Object.assign(manager, {
    lifecycle: { close() {} },
    reaper: setTimeout(() => {}, 0),
    lockTimers: new Map(),
    shardActivities: new Set(),
    restartTasks: new Map(),
    live: new Map(sessions.map((s) => [s.id, s])),
    stoppingSessions: new Map(),
    intentionalSleep: new Set(),
    nativeTitleSessions: new Map(),
    codexPollers: new Map(),
    cliProbes: new Map(),
    logins: new Map(),
    vault: { revokeSession() {} },
    scheduleLock() {},
    shards: { sleepAll: async () => {} },
    pool: { async query(sql: string, params: unknown[]) { queries.push({ sql, params }); return { rows: [] }; } },
    readAgentTurn: (id: string) => (working.has(id) ? { status: "working" } : { status: "idle" }),
  });
  return manager;
}

test("shutdown marks every running session resume-on-boot and records which were mid-turn", async () => {
  const busy = fakeSession("busy");
  const idle = fakeSession("idle");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const manager = shutdownManager([busy, idle], new Set(["busy"]), queries);
  await manager.shutdown();
  assert.match(queries[0].sql, /SET resume_on_boot = TRUE WHERE id = ANY/, "all live sessions are flagged in one UPDATE before any per-session sleep");
  assert.deepEqual([...(queries[0].params[0] as string[])].sort(), ["busy", "idle"]);
  const byId = new Map(queries.filter((q) => q.sql.includes("state = 'sleeping'")).map((q) => [q.params[0], q.params]));
  assert.deepEqual(byId.get("busy"), ["busy", "shutdown", 7, true, true]);
  assert.deepEqual(byId.get("idle"), ["idle", "shutdown", 7, true, false]);
});

test("a normal sleep (idle, user) never sets resume_on_boot", async () => {
  const s = fakeSession("s1");
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const manager = shutdownManager([s], new Set(), queries);
  await manager.sleepSession("s1", "user");
  const q = queries.find((x) => x.sql.includes("state = 'sleeping'"))!;
  assert.deepEqual(q.params, ["s1", "user", 7, false, false]);
});

function bootManager(rows: any[], resumed: string[], opts: { fail?: Set<string>; live?: Set<string> } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let running = 0;
  let maxRunning = 0;
  const manager = Object.create(SessionManager.prototype) as any;
  Object.assign(manager, {
    shuttingDown: false,
    live: new Map([...(opts.live ?? [])].map((id) => [id, {}])),
    pool: {
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: sql.startsWith("SELECT") ? rows : [] };
      },
    },
    resume: async (userId: string, _profile: unknown, id: string) => {
      running++; maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (opts.fail?.has(id)) throw Object.assign(new Error("locked"), { code: "unavailable" });
      resumed.push(id);
      return {};
    },
  });
  return { manager, queries, maxRunning: () => maxRunning };
}

test("boot resumes only flagged sleeping sessions, skips deleted projects / failures, bounds concurrency and clears flags", async () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id, user_id: "u1", provider: "claude", interrupted_turn: false, project_gone: false }));
  rows.push({ id: "gone", user_id: "u1", provider: "claude", interrupted_turn: false, project_gone: true });
  const resumed: string[] = [];
  const { manager, queries, maxRunning } = bootManager(rows, resumed, { fail: new Set(["c"]) });
  const result = await manager.resumeAfterBoot(async () => ({}), 3);
  assert.deepEqual(resumed.sort(), ["a", "b", "d", "e"]);
  assert.deepEqual(result, { resumed: 4, skipped: 2 });
  assert.ok(maxRunning() <= 3 && maxRunning() > 1, "bounded, parallel concurrency: " + maxRunning());
  const select = queries.find((q) => q.sql.startsWith("SELECT"))!.sql;
  assert.match(select, /resume_on_boot = TRUE AND s\.state = 'sleeping'/, "user-slept or exited sessions are never selected");
  const cleared = queries.filter((q) => q.sql.includes("resume_on_boot = FALSE") && q.sql.includes("WHERE id = $1")).map((q) => q.params[0]).sort();
  assert.deepEqual(cleared, ["c", "gone"], "skipped rows get their flag cleared (resumed ones are cleared by launch)");
});

test("boot: interrupted agents get the notice queued, idle ones and shells do not", async () => {
  const rows = [
    { id: "busy", user_id: "u1", provider: "claude", interrupted_turn: true, project_gone: false },
    { id: "idle", user_id: "u1", provider: "claude", interrupted_turn: false, project_gone: false },
    { id: "shell", user_id: "u1", provider: "shell", interrupted_turn: true, project_gone: false },
  ];
  const resumed: string[] = [];
  const { manager } = bootManager(rows, resumed);
  const seen = new Map<string, string | undefined>();
  const original = manager.resume;
  manager.resume = async (u: string, p: unknown, id: string) => { seen.set(id, manager.bootNotices?.get(id)); return original(u, p, id); };
  await manager.resumeAfterBoot(async () => ({}), 1);
  assert.equal(seen.get("busy"), BOOT_RESUME_NOTICE);
  assert.equal(seen.get("idle"), undefined);
  assert.equal(seen.get("shell"), undefined);
  assert.match(BOOT_RESUME_NOTICE, /^\[Floq\] The runtime restarted while you were working/);
});

test("boot: a session already live is not resumed twice", async () => {
  const rows = [{ id: "x", user_id: "u1", provider: "claude", interrupted_turn: true, project_gone: false }];
  const resumed: string[] = [];
  const { manager } = bootManager(rows, resumed, { live: new Set(["x"]) });
  assert.deepEqual(await manager.resumeAfterBoot(async () => ({})), { resumed: 0, skipped: 1 });
  assert.deepEqual(resumed, []);
});

function readyManager() {
  const manager = Object.create(SessionManager.prototype) as any;
  manager.readyTiming = { quietMs: 20, timeoutMs: 500 };
  return manager;
}

test("onSessionReady fires after the first output goes quiet, not before", async () => {
  const manager = readyManager();
  const fired: string[] = [];
  manager.onSessionReady((u: string, id: string) => fired.push(u + ":" + id));
  const s = fakeSession("s1");
  const flow = manager.readyFlow(s);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(fired, [], "no output yet");
  s.emit({ type: "output" });
  await new Promise((r) => setTimeout(r, 10));
  s.emit({ type: "output" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(fired, [], "still painting");
  await flow;
  assert.deepEqual(fired, ["u1:s1"]);
});

test("onSessionReady falls back to the timeout when the TUI never prints", async () => {
  const manager = readyManager();
  manager.readyTiming = { quietMs: 20, timeoutMs: 60 };
  const fired: string[] = [];
  manager.onSessionReady((_u: string, id: string) => fired.push(id));
  await manager.readyFlow(fakeSession("silent"));
  assert.deepEqual(fired, ["silent"]);
});

test("boot-resumed interrupted session: notice is typed first, then onSessionReady fires; idle sessions get no notice", async () => {
  const manager = readyManager();
  const order: string[] = [];
  const busy = fakeSession("busy", { write(d: string) { order.push("write:" + d.slice(0, 12)); } });
  const typed = () => order.filter((e) => e.startsWith("write:")).join("");
  const idle = fakeSession("idle", { write(d: string) { order.push("idle-write"); } });
  manager.bootNotices = new Map([["busy", BOOT_RESUME_NOTICE]]);
  manager.onSessionReady((_u: string, id: string) => order.push("ready:" + id));
  const a = manager.readyFlow(busy);
  const b = manager.readyFlow(idle);
  busy.emit({ type: "output" });
  idle.emit({ type: "output" });
  await Promise.all([a, b]);
  assert.match(typed(), /\[Floq\] The r/, "notice typed: " + order.join(","));
  const lastWrite = Math.max(...order.map((e, i) => (e.startsWith("write:") ? i : -1)));
  assert.ok(lastWrite < order.indexOf("ready:busy"), "notice (incl. Enter) fully typed before the ready callback");
  assert.ok(order.includes("ready:idle"));
  assert.ok(!order.includes("idle-write"), "idle session got no notice");
  assert.equal(manager.bootNotices.has("busy"), false, "notice is consumed");
});

test("a session that exited before it was ready does not fire onSessionReady", async () => {
  const manager = readyManager();
  const fired: string[] = [];
  manager.onSessionReady((_u: string, id: string) => fired.push(id));
  const s = fakeSession("dead");
  const flow = manager.readyFlow(s);
  s.isAlive = false;
  s.emit({ type: "exit" });
  await flow;
  assert.deepEqual(fired, []);
});

test("sandbox args bind the per-user /tmp from inside the encrypted home (not tmpfs), keep /run as tmpfs, and users never share it", async () => {
  const { LinuxShardDriver } = await import("../dist/shard.js");
  // Built without the constructor: it creates /mnt/... which an unprivileged test run cannot.
  const driver = Object.create(LinuxShardDriver.prototype) as any;
  Object.assign(driver, { cipherRoot: "/var/lib/floq/shards/cipher", mountRoot: "/mnt/floq", metaRoot: "/var/lib/floq/shards/meta", netns: null });
  captured.length = 0;
  for (const uid of [40001, 40002]) {
    driver.spawn({ userId: "u" + uid, uid, mountPath: "/mnt/floq/" + uid }, { file: "/bin/true", args: [], env: {}, cwd: ".", cols: 80, rows: 24 });
  }
  const [one, two] = captured.map((c) => c.args);
  const tmpBind = (args: string[]) => { const i = args.findIndex((a, n) => a === "--bind" && args[n + 2] === "/tmp"); return i < 0 ? null : args[i + 1]; };
  assert.equal(tmpBind(one), "/mnt/floq/40001/.floq/tmp");
  assert.equal(tmpBind(two), "/mnt/floq/40002/.floq/tmp");
  assert.ok(!one.some((a, n) => a === "--tmpfs" && one[n + 1] === "/tmp"), "/tmp is no longer a tmpfs");
  assert.ok(one.some((a, n) => a === "--tmpfs" && one[n + 1] === "/run"), "/run stays a tmpfs");
  assert.ok(!one.some((a) => a.includes("40002")), "never sees another user's directory");
});

test("prepareTmp creates <home>/.floq/tmp as sticky 1777 and prunes unused entries", async () => {
  const { LinuxShardDriver, TMP_MAX_AGE_MS } = await import("../dist/shard.js");
  const home = mkdtempSync(join(tmpdir(), "floq-home-"));
  try {
    const driver = Object.create(LinuxShardDriver.prototype) as any;
    const handle = { userId: "u", uid: process.getuid!(), mountPath: home };
    const dir = driver.tmpPath(handle);
    assert.equal(dir, join(home, ".floq/tmp"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old"), "x");
    writeFileSync(join(dir, "keep"), "x");
    const past = new Date(Date.now() - TMP_MAX_AGE_MS - 3600_000);
    utimesSync(join(dir, "old"), past, past);
    await driver.prepareTmp(handle);
    assert.equal(statSync(dir).mode & 0o7777, 0o1777);
    assert.equal(existsSync(join(dir, "old")), false);
    assert.equal(existsSync(join(dir, "keep")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reconcile marks rows left 'running' by a killed process as resume-on-boot AND interrupted", async () => {
  const { ShardService } = await import("../dist/shards.js");
  const queries: string[] = [];
  const svc = Object.create(ShardService.prototype) as any;
  svc.pool = { async query(sql: string) { queries.push(sql); return { rows: [] }; } };
  await svc.reconcile();
  const q = queries.find((x) => x.includes("agent_sessions"))!;
  assert.match(q, /state = 'sleeping'/);
  assert.match(q, /resume_on_boot = TRUE, interrupted_turn = TRUE WHERE state = 'running'/);
});

test("pruneOldEntries uses the newest mtime inside an entry, keeps entries when the walk bound is hit, never follows symlinks", async () => {
  const { pruneOldEntries, TMP_MAX_AGE_MS } = await import("../dist/shard.js");
  const dir = mkdtempSync(join(tmpdir(), "floq-prune-"));
  try {
    const past = new Date(Date.now() - TMP_MAX_AGE_MS - 3600_000);
    const old = (p: string) => utimesSync(p, past, past);
    // wholly old tree
    mkdirSync(join(dir, "old-venv/bin"), { recursive: true });
    writeFileSync(join(dir, "old-venv/bin/py"), "x");
    for (const p of ["old-venv/bin/py", "old-venv/bin", "old-venv"]) old(join(dir, p));
    // long-lived scratchpad: old top-level dirs, one recent file deep inside
    mkdirSync(join(dir, "claude-1/proj/sess/scratchpad"), { recursive: true });
    writeFileSync(join(dir, "claude-1/proj/sess/scratchpad/notes.md"), "x");
    for (const p of ["claude-1/proj/sess/scratchpad", "claude-1/proj/sess", "claude-1/proj", "claude-1"]) old(join(dir, p));
    // too deep to inspect: kept even though everything we can see is old
    let deep = join(dir, "deep");
    for (let i = 0; i < 9; i++) deep = join(deep, "d" + i);
    mkdirSync(deep, { recursive: true });
    old(join(dir, "deep"));
    writeFileSync(join(dir, "old.txt"), "x"); old(join(dir, "old.txt"));
    writeFileSync(join(dir, "fresh.txt"), "x");
    symlinkSync("/etc", join(dir, "link"));
    pruneOldEntries(dir, TMP_MAX_AGE_MS);
    assert.equal(existsSync(join(dir, "old-venv")), false);
    assert.equal(existsSync(join(dir, "old.txt")), false);
    assert.equal(existsSync(join(dir, "claude-1")), true, "recent file deep inside keeps the whole entry");
    assert.equal(existsSync(join(dir, "deep")), true, "bound hit: keep");
    assert.equal(existsSync(join(dir, "fresh.txt")), true);
    assert.equal(existsSync("/etc"), true, "symlink targets are never followed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
