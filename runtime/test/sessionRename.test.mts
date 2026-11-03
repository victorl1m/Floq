import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../dist/manager.js";
import { Session } from "../dist/session.js";

const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function row(title, titleLocked = false) {
  return {
    id, user_id: "user-1", provider: "claude", title, title_locked: titleLocked,
    cwd: "workspace/repo", project_cwd: null, project_id: null, workspace_id: null,
    branch: null, git_url: null, state: "running", cols: 120, rows: 32,
    last_seq: "0", resume_count: 0, sleep_reason: null, created_at: new Date(0),
    last_active_at: new Date(0), slept_at: null, provider_session_id: null, lead: false, model: null,
  };
}

test("rename validates title, persists lock, broadcasts state, and keeps Floq ID stable", async (t) => {
  const home = join(tmpdir(), `floq-title-rename-${process.pid}-${Date.now()}`);
  const project = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Native title" }) + "\n");

  let stored = row("initial user prompt");
  let updateCount = 0;
  const manager = Object.create(SessionManager.prototype);
  const pty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 42 };
  const session = new Session({ id, userId: "user-1", provider: "claude", title: stored.title, cwd: stored.cwd, cols: 120, rows: 32, outputBufferBytes: 1024, pty });
  const frames = [];
  session.subscribe((frame) => frames.push(frame));
  manager.live = new Map([[id, session]]);
  manager.nativeTitleSessions = new Map([[id, {
    userId: "user-1", provider: "claude", fallback: stored.title, lastNativeTitle: null,
    providerSessionId: id, handle: {}, checkedAt: 0, checking: false,
  }]]);
  manager.shards = { driver: { homePath: () => home } };
  manager.pool = { async query(sql, values) {
    updateCount += 1;
    if (sql.includes("title_locked=TRUE")) {
      assert.deepEqual(values, [id, "user-1", "A clearer name"]);
      stored = row(values[2], true);
      return { rows: [stored] };
    }
    if (sql.includes("title_locked=FALSE")) {
      assert.equal(values[0], id);
      assert.equal(stored.title_locked, true);
      return { rows: [] };
    }
    assert.fail(`Unexpected query: ${sql}`);
  } };

  const renamed = await manager.renameSession("user-1", id, "  A clearer\n name  ");
  assert.equal(renamed.id, id);
  assert.equal(renamed.title, "A clearer name");
  assert.equal(session.title, "A clearer name");
  assert.equal(stored.title_locked, true);
  assert.deepEqual(frames.map((frame) => frame.type), ["state"]);

  await manager.updateNativeTitle(id, true);
  assert.equal(stored.title, "A clearer name", "native metadata cannot overwrite a manual rename");
  assert.equal(session.title, "A clearer name");
  assert.equal(manager.nativeTitleSessions.has(id), false, "native sync stops after the manual-title lock is observed");
  assert.equal(updateCount, 1, "manual rename removes native sync state before another DB update can run");
  t.after(() => rmSync(home, { recursive: true, force: true }));
});

test("rename rejects invalid titles and cannot update another user's session", async () => {
  let queries = 0;
  const manager = Object.create(SessionManager.prototype);
  manager.live = new Map();
  manager.pool = { async query(_sql, values) {
    queries += 1;
    assert.deepEqual(values, [id, "user-other", "Valid title"]);
    return { rows: [] };
  } };

  await assert.rejects(manager.renameSession("user-1", id, "  \n "), { code: "invalid_session_title" });
  await assert.rejects(manager.renameSession("user-1", id, "x".repeat(121)), { code: "invalid_session_title" });
  await assert.rejects(manager.renameSession("user-1", id, null), { code: "invalid_session_title" });
  assert.equal(queries, 0, "invalid titles are rejected before database access");
  await assert.rejects(manager.renameSession("user-other", id, "Valid title"), { status: 404 });
  assert.equal(queries, 1);
});

test("a delayed native-title DB response cannot overwrite a completed manual rename in the live session", async (t) => {
  const home = join(tmpdir(), `floq-title-race-${process.pid}-${Date.now()}`);
  const project = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Native title" }) + "\n");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  let stored = row("initial prompt");
  let finishNative;
  let notifyNativeStarted;
  const nativeStarted = new Promise((resolve) => { notifyNativeStarted = resolve; });
  const nativeResponse = new Promise((resolve) => { finishNative = resolve; });
  const manager = Object.create(SessionManager.prototype);
  const pty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 42 };
  const session = new Session({ id, userId: "user-1", provider: "claude", title: stored.title, cwd: stored.cwd, cols: 120, rows: 32, outputBufferBytes: 1024, pty });
  manager.live = new Map([[id, session]]);
  manager.nativeTitleSessions = new Map([[id, {
    userId: "user-1", provider: "claude", fallback: stored.title, lastNativeTitle: null,
    providerSessionId: id, handle: {}, checkedAt: 0, checking: false,
  }]]);
  manager.shards = { driver: { homePath: () => home } };
  manager.pool = { async query(sql, values) {
    if (sql.includes("title_locked=FALSE")) {
      // Model the native UPDATE having committed while its result packet is delayed.
      stored = row(values[1]);
      notifyNativeStarted();
      return nativeResponse;
    }
    if (sql.includes("title_locked=TRUE")) {
      stored = row(values[2], true);
      return { rows: [stored] };
    }
    assert.fail(`Unexpected query: ${sql}`);
  } };

  const nativeUpdate = manager.updateNativeTitle(id, true);
  await nativeStarted;
  await manager.renameSession("user-1", id, "Manual title");
  assert.equal(stored.title, "Manual title");
  assert.equal(session.title, "Manual title");
  finishNative({ rows: [{ id }] });
  await nativeUpdate;
  assert.equal(stored.title, "Manual title");
  assert.equal(session.title, "Manual title");
  assert.deepEqual(manager.nativeTitleSessions.has(id), false);
});
