import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../dist/manager.js";
import { antigravityPrompt, AGY_BLOCK_MAX_BYTES, truncateUtf8 } from "../dist/cliProviders.js";

const handle = { mountPath: "/nonexistent" } as never;
type Any = Record<string, any>;

function manager(extra: Any): Any {
  const m = Object.create(SessionManager.prototype) as Any;
  Object.assign(m, { cliProbes: new Map(), agyGates: new Map(), agyRelease: new Map(), ...extra });
  return m;
}
const probe = (over: Any = {}) => ({ provider: "antigravity", userId: "u1", cwd: "p", cwds: ["/home/agent/p"], baseline: "BASE", env: {}, inFlight: false, misses: 0, nextAt: 0, ...over });

test("agy capture refuses an id another agy row of the user already holds", async () => {
  const queries: string[] = [];
  const m = manager({
    readAntigravityId: () => "OTHER-A",
    pool: { async query(sql: string) { queries.push(sql); return { rows: sql.startsWith("SELECT 1") ? [{ "?column?": 1 }] : [] }; } },
  });
  m.cliProbes.set("s1", probe());
  assert.equal(await m.captureCliId("s1", handle), false);
  assert.equal(queries.some((q) => q.startsWith("UPDATE")), false, "must not persist a held id");
  assert.ok(m.cliProbes.has("s1"), "keeps waiting for its own id");
});

test("agy capture ignores the baseline and stores a fresh id", async () => {
  const queries: string[] = [];
  let seen = "BASE";
  const m = manager({ readAntigravityId: () => seen, pool: { async query(sql: string) { queries.push(sql); return { rows: [] }; } } });
  m.cliProbes.set("s1", probe());
  assert.equal(await m.captureCliId("s1", handle), false);
  seen = "NEW";
  assert.equal(await m.captureCliId("s1", handle), true);
  assert.ok(queries.some((q) => q.startsWith("UPDATE agent_sessions SET provider_session_id")));
  assert.equal(m.cliProbes.has("s1"), false);
});

test("fresh agy starts are serialised per (user, cwd) until captured/released", async () => {
  const m = manager({});
  await m.enterAgyGate("a", "u1", "p");
  let bEntered = false;
  const b = m.enterAgyGate("b", "u1", "p").then(() => { bEntered = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bEntered, false, "B waits for A's capture");
  const other = m.enterAgyGate("c", "u1", "other-cwd"); // different cwd is independent
  await other;
  m.releaseAgyGate("a");
  await b;
  assert.equal(bEntered, true);
  m.releaseAgyGate("b"); m.releaseAgyGate("c");
});

test("opencode probe: single in flight, backs off after a miss, final probe skips the backoff", async () => {
  let calls = 0;
  let release!: (v: string | null) => void;
  const m = manager({ probeOpencodeId: () => { calls++; return new Promise((r) => { release = r; }); }, pool: { async query() { return { rows: [] }; } } });
  m.cliProbes.set("s1", probe({ provider: "opencode" }));
  const first = m.captureCliId("s1", handle);
  assert.equal(await m.captureCliId("s1", handle), false, "overlapping probe refused");
  assert.equal(calls, 1);
  release(null);
  assert.equal(await first, false);
  assert.ok(m.cliProbes.get("s1").nextAt > Date.now(), "backoff set");
  assert.equal(await m.captureCliId("s1", handle), false);
  assert.equal(calls, 1, "no probe during backoff");
  const final = m.captureCliId("s1", handle, true);
  assert.equal(calls, 2, "final probe ignores the backoff");
  release("ses_abc");
  assert.equal(await final, true);
});

test("resume fallback clears the dead provider id before the fresh launch (codex and others)", async () => {
  const order: string[] = [];
  let launched: Any | null = null;
  const session = { id: "s1", userId: "u1", provider: "codex", resumeCount: 2, toSummary: () => ({ seq: 1 }) };
  const m = manager({
    live: new Map([["s1", session]]),
    intentionalSleep: new Set(),
    nativeTitleSessions: new Map(),
    codexPollers: new Map(),
    vault: { revokeSession() {} },
    captureCodexId: async () => false,
    updateNativeTitle: async () => {},
    row: async () => ({ id: "s1", user_id: "u1", provider: "codex", provider_session_id: "dead-id", resume_count: 2 }),
    pool: { async query(sql: string) { order.push(sql.split(" SET ")[0] + (sql.includes("provider_session_id = NULL") ? ":clear" : "")); return { rows: [] }; } },
    launch: async (row: Any) => { order.push("launch"); launched = row; return { broadcast() {}, toSummary: () => ({}) }; },
  });
  await m.onExit(session, "failed", true, {}, handle);
  assert.deepEqual(order.slice(0, 2), ["UPDATE agent_sessions:clear", "launch"]);
  assert.equal(launched!.provider_session_id, null);
});

test("agy first message is capped under the argv limit and points at floq wired", () => {
  const big = "é".repeat(200_000); // 400 KB of UTF-8
  const text = antigravityPrompt(big, "do the task", false)!;
  assert.ok(Buffer.byteLength(text, "utf8") < 110 * 1024);
  assert.match(text, /floq wired/);
  assert.match(text, /do the task$/);
  assert.ok(Buffer.byteLength(truncateUtf8(big, 1001), "utf8") <= 1001);
  assert.equal(antigravityPrompt("small", undefined, false)!.includes("floq wired"), false);
  assert.ok(AGY_BLOCK_MAX_BYTES <= 64 * 1024);
});

test("three queued agy starters in one cwd run strictly one after another", async () => {
  const m = manager({});
  const order: string[] = [];
  const start = (name: string) => m.enterAgyGate(name, "u1", "p").then(() => order.push(name));
  const all = [start("a"), start("b"), start("c")];
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["a"], "only the first holds the slot");
  m.releaseAgyGate("a");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["a", "b"], "c still waits for b");
  m.releaseAgyGate("b");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["a", "b", "c"]);
  m.releaseAgyGate("c");
  await Promise.all(all);
  assert.equal(m.agyGates.size, 0, "map is cleaned up");
});

test("a stale probe resolving late does not remove a newer probe", async () => {
  let resolveRead!: (v: string | null) => void;
  const m = manager({ readAntigravityId: () => "NEW", pool: { async query(sql: string) { if (sql.startsWith("SELECT 1")) await new Promise<void>((r) => { resolveRead = () => r(); }); return { rows: [] }; } } });
  const old = probe();
  m.cliProbes.set("s1", old);
  const pending = m.captureCliId("s1", handle);
  await new Promise((r) => setTimeout(r, 5));
  const fresh = probe();
  m.cliProbes.set("s1", fresh); // session slept and relaunched meanwhile
  resolveRead(null);
  await pending;
  assert.equal(m.cliProbes.get("s1"), fresh);
});
