import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../dist/manager.js";
import { readClaudeNativeTitle, readCodexNativeTitle } from "../dist/nativeTitle.js";

const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("Claude title sync reads only exact-session native title records and prefers custom title", (t) => {
  const home = join(tmpdir(), `floq-claude-title-${process.pid}-${Date.now()}`);
  const project = join(home, ".claude", "projects", "-work-repo");
  const transcript = join(project, id + ".jsonl");
  mkdirSync(project, { recursive: true });
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: "A private prompt that must not become the title" }),
    JSON.stringify({ type: "ai-title", aiTitle: "Native AI title" }),
  ].join("\n") + "\n");
  assert.equal(readClaudeNativeTitle(home, id), "Native AI title");
  assert.equal(readClaudeNativeTitle(home, "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"), null);
  const customDir = join(project, id);
  mkdirSync(customDir);
  writeFileSync(join(customDir, "custom-title.json"), JSON.stringify({ customTitle: "  Manually renamed\n" }));
  assert.equal(readClaudeNativeTitle(home, id), "Manually renamed");
  assert.equal(readClaudeNativeTitle(home, "../../etc/passwd"), null);
  t.after(() => rmSync(home, { recursive: true, force: true }));
});

test("Claude title sync rejects symlinked title sidecars and project roots", (t) => {
  const home = join(tmpdir(), `floq-claude-title-${process.pid}-${Date.now()}-link`);
  const project = join(home, ".claude", "projects", "-work-repo");
  const transcript = join(project, id + ".jsonl");
  const outside = join(home, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "Safe fallback" }) + "\n");
  writeFileSync(join(outside, "custom-title.json"), JSON.stringify({ customTitle: "Outside title" }));
  symlinkSync(outside, join(project, id), "junction");
  assert.equal(readClaudeNativeTitle(home, id), "Safe fallback");
  rmSync(join(home, ".claude", "projects"), { recursive: true, force: true });
  symlinkSync(outside, join(home, ".claude", "projects"), "junction");
  assert.equal(readClaudeNativeTitle(home, id), null);
  t.after(() => rmSync(home, { recursive: true, force: true }));
});

test("Codex title sync reads the newest matching provider-id entry only", (t) => {
  const shard = join(tmpdir(), `floq-codex-title-${process.pid}-${Date.now()}`);
  const home = join(shard, ".floq", "codex", id);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "session_index.jsonl"), [
    JSON.stringify({ id, thread_name: "First title", updated_at: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", thread_name: "Another session" }),
    JSON.stringify({ id, thread_name: "Latest native title", updated_at: "2026-01-02T00:00:00Z" }),
  ].join("\n") + "\n");
  assert.equal(readCodexNativeTitle(shard, home, id), "Latest native title");
  assert.equal(readCodexNativeTitle(shard, home, "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"), null);
  t.after(() => rmSync(shard, { recursive: true, force: true }));
});

test("Codex title sync rejects symlinked private homes and index files", (t) => {
  const shard = join(tmpdir(), `floq-codex-title-${process.pid}-${Date.now()}-link`);
  const safeHome = join(shard, ".floq", "codex", id);
  const outsideHome = join(shard, "outside");
  mkdirSync(safeHome, { recursive: true });
  mkdirSync(outsideHome, { recursive: true });
  writeFileSync(join(outsideHome, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Outside title" }));
  const externalHome = join(shard, "external-home");
  symlinkSync(outsideHome, externalHome, "junction");
  assert.equal(readCodexNativeTitle(shard, externalHome, id), null);
  const privateParent = join(shard, ".floq", "codex");
  rmSync(privateParent, { recursive: true, force: true });
  mkdirSync(join(outsideHome, id), { recursive: true });
  writeFileSync(join(outsideHome, id, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Ancestor escape" }));
  symlinkSync(outsideHome, privateParent, "junction");
  assert.equal(readCodexNativeTitle(shard, join(privateParent, id), id), null);
  rmSync(privateParent, { recursive: true, force: true });
  mkdirSync(safeHome, { recursive: true });
  const indexPath = join(safeHome, "session_index.jsonl");
  symlinkSync(join(outsideHome, "session_index.jsonl"), indexPath);
  assert.equal(readCodexNativeTitle(shard, safeHome, id), null);
  t.after(() => rmSync(shard, { recursive: true, force: true }));
});

test("reaper adopts late native titles over the initial prompt and follows a native rename", async (t) => {
  const home = join(tmpdir(), `floq-claude-live-title-${process.pid}-${Date.now()}`);
  const project = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(project, { recursive: true });
  const transcript = join(project, id + ".jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "First native title" }) + "\n");

  let storedTitle = "initial user prompt";
  const session = {
    id,
    userId: "user-1",
    isAlive: true,
    lastActivity: Date.now(),
    startedAtMs: Date.now(),
    title: storedTitle,
    setTitle(title) { this.title = title; },
  };
  const manager = Object.create(SessionManager.prototype);
  manager.config = { idleTimeoutMs: 0, maxLifetimeMs: 0 };
  manager.live = new Map([[id, session]]);
  manager.logins = new Map();
  manager.syncBack = async () => {};
  manager.shards = { driver: { homePath: () => home, hostPath: (_handle, rel) => join(home, rel) } };
  manager.nativeTitleSessions = new Map([[id, {
    userId: "user-1",
    provider: "claude",
    fallback: storedTitle,
    lastNativeTitle: null,
    providerSessionId: id,
    handle: {},
    checkedAt: 0,
    checking: false,
  }]]);
  manager.pool = { async query(_sql, values) {
    assert.equal(values[0], id);
    if (storedTitle !== values[3]) return { rows: [] };
    storedTitle = values[1];
    return { rows: [{ id }] };
  } };

  await manager.reap();
  assert.equal(storedTitle, "First native title");
  assert.equal(session.title, "First native title");
  writeFileSync(transcript, [
    JSON.stringify({ type: "ai-title", aiTitle: "First native title" }),
    JSON.stringify({ type: "custom-title", customTitle: "Renamed in Claude" }),
  ].join("\n") + "\n");
  manager.nativeTitleSessions.get(id).checkedAt = 0;
  await manager.reap();
  assert.equal(storedTitle, "Renamed in Claude");
  assert.equal(session.title, "Renamed in Claude");
  t.after(() => rmSync(home, { recursive: true, force: true }));
});
