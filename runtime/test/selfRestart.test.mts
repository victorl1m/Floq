import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../dist/manager.js";
import { Session } from "../dist/session.js";
import type { RuntimeProfile } from "../dist/settings.js";
import type { ShardHandle } from "../dist/shard.js";
import type { SessionState } from "../dist/types.js";

const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fakeSession(overrides: Record<string, unknown> = {}): Session {
  return {
    id,
    userId: "user-1",
    provider: "claude",
    isAlive: true,
    hasExited: false,
    toSummary: () => ({ id, seq: 3 }),
    broadcast() {},
    dispose() {},
    async disposeAndWait() { return false; },
    whenExited: () => new Promise<void>(() => {}),
    ...overrides,
  } as unknown as Session;
}

test("self-restart preflight refuses a Codex session without a captured conversation ID", async () => {
  const session = fakeSession({ provider: "codex" });
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  Object.assign(manager, {
    live: new Map([[id, session]]),
    nativeTitleSessions: new Map(),
    pool: { async query() { return { rows: [{ id, user_id: "user-1", provider: "codex", provider_session_id: null }] }; } },
  });
  await assert.rejects(manager.assertSelfRestartable("user-1", id), { status: 409, code: "restart_not_ready" });
  assert.equal(session.isAlive, true, "preflight leaves the running process untouched");
});

test("restartSelf coalesces duplicate requests and strictly resumes only after the old PTY stops", async () => {
  const order: string[] = [];
  let finishStop!: () => void;
  const stopped = new Promise<void>((resolve) => { finishStop = resolve; });
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  Object.assign(manager, {
    lifecycle: { assertOpen() {} },
    restartTasks: new Map(),
    intentionalSleep: new Set(),
    assertSelfRestartable: async (_userId: string, sessionId: string) => { order.push(`preflight:${sessionId}`); },
    sleepSession: async (sessionId: string, reason: string, options: { waitForExit?: boolean }) => {
      order.push(`stop:${sessionId}:${reason}:${options.waitForExit}`);
      await stopped;
    },
    resumeOnce: async (_userId: string, _profile: RuntimeProfile, sessionId: string, strict: boolean) => {
      order.push(`resume:${sessionId}:${strict}`);
      return { id: sessionId, cwd: "workspace/feature" };
    },
  });
  const first = manager.restartSelf("user-1", {} as RuntimeProfile, id);
  const duplicate = manager.restartSelf("user-1", {} as RuntimeProfile, id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [`preflight:${id}`, `stop:${id}:self-restart:true`], "overlapping restart requests share one lifecycle operation");
  finishStop();
  const [resumed, duplicateResult] = await Promise.all([first, duplicate]);
  assert.deepEqual(resumed, { id, cwd: "workspace/feature" });
  assert.deepEqual(duplicateResult, resumed);
  assert.deepEqual(order, [`preflight:${id}`, `stop:${id}:self-restart:true`, `resume:${id}:true`]);
});

test("PTY restart stop escalates from SIGTERM to SIGKILL and resolves only after exit", async () => {
  let onExit: ((event: { exitCode: number; signal: number | null }) => void) | undefined;
  const signals: string[] = [];
  const pty = {
    pid: 42,
    onData() {},
    onExit(listener: (event: { exitCode: number; signal: number | null }) => void) { onExit = listener; },
    write() {},
    resize() {},
    kill(signal = "SIGTERM") {
      signals.push(signal);
      if (signal === "SIGKILL") onExit?.({ exitCode: 1, signal: 9 });
    },
  };
  const session = new Session({ id, userId: "user-1", provider: "claude", title: "Restart fixture", cwd: "repo", cols: 80, rows: 24, outputBufferBytes: 1024, pty: pty as never });
  assert.equal(await session.disposeAndWait(5, 100), true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(session.hasExited, true);
});

test("a PTY that misses bounded termination stays tracked and blocks manual resume", async () => {
  let finishExit!: () => void;
  const exited = new Promise<void>((resolve) => { finishExit = resolve; });
  const session = fakeSession({ whenExited: () => exited });
  const lockRequests: string[] = [];
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  Object.assign(manager, {
    logins: new Map(),
    live: new Map([[id, session]]),
    stoppingSessions: new Map(),
    nativeTitleSessions: new Map(),
    codexPollers: new Map(),
    intentionalSleep: new Set(),
    lifecycle: { assertOpen() {} },
    resumeTasks: new Map(),
    restartTasks: new Map(),
    intentionalSleep: new Set(),
    pool: { async query() { return { rows: [] }; } },
    vault: { revokeSession() {} },
    scheduleLock: (userId: string) => lockRequests.push(userId),
  });

  await assert.rejects(manager.sleepSession(id, "self-restart", { waitForExit: true }), { status: 503, code: "restart_stop_failed" });
  assert.equal(manager.activeCountFor("user-1"), 1, "the old process still counts as active while it exits");
  await assert.rejects(manager.resume("user-1", {} as RuntimeProfile, id), { status: 503, code: "session_stopping" });

  Object.defineProperty(session, "hasExited", { value: true });
  finishExit();
  await exited;
  await Promise.resolve();
  assert.equal(manager.activeCountFor("user-1"), 0);
  assert.equal(lockRequests.includes("user-1"), true, "the shard can be locked after the old PTY exits");
});

test("a late exit from the previous PTY cannot revoke the resumed session token", async () => {
  const oldSession = fakeSession();
  const newSession = fakeSession();
  const revoked: string[] = [];
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  Object.assign(manager, {
    live: new Map([[id, newSession]]),
    vault: { revokeSession: (sessionId: string) => revoked.push(sessionId) },
    nativeTitleSessions: new Map([[id, { userId: "user-1", provider: "claude", providerSessionId: id }]]),
    codexPollers: new Map(),
  });
  const onExit = Reflect.get(SessionManager.prototype, "onExit") as (
    this: SessionManager,
    session: Session,
    state: SessionState,
    resumeFailedFast: boolean,
    profile: RuntimeProfile,
    handle: ShardHandle,
  ) => Promise<void>;
  await onExit.call(manager, oldSession, "failed", false, {} as RuntimeProfile, {} as ShardHandle);
  assert.deepEqual(revoked, []);
  assert.equal(manager.nativeTitleSessions.has(id), true);
});
