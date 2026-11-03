import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  manager.shards = { driver: { homePath: () => "/home/agent", hostPath: (_handle, rel) => join(home, rel) } };
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

function fixtureHome(name) {
  const home = join(tmpdir(), `floq-title-${name}-${process.pid}-${Date.now()}`);
  const project = join(home, ".claude", "projects", "-work-repo");
  mkdirSync(project, { recursive: true });
  return { home, project };
}

test("Claude title found in the middle of a transcript larger than the old 1MB tail", (t) => {
  const { home, project } = fixtureHome("big");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const filler = JSON.stringify({ type: "assistant", text: "x".repeat(4000) });
  const lines = [JSON.stringify({ type: "ai-title", aiTitle: "Middle title" })];
  for (let i = 0; i < 700; i += 1) lines.push(filler); // ~2.8MB after the title
  writeFileSync(join(project, id + ".jsonl"), lines.join("\n") + "\n");
  assert.equal(readClaudeNativeTitle(home, id), "Middle title");
  // Incremental: appended records are picked up and the newest wins.
  appendFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Newer title" }) + "\n");
  assert.equal(readClaudeNativeTitle(home, id), "Newer title");
  appendFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "custom-title", customTitle: "Renamed" }) + "\n");
  assert.equal(readClaudeNativeTitle(home, id), "Renamed");
});

test("Claude legacy summary records are a lowest-priority fallback", (t) => {
  const { home, project } = fixtureHome("summary");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(project, id + ".jsonl"), [
    JSON.stringify({ type: "summary", summary: "Older summary", leafUuid: "x" }),
    JSON.stringify({ type: "summary", summary: "Latest summary", leafUuid: "y" }),
    JSON.stringify({ type: "user", message: "hi" }),
  ].join("\n") + "\n");
  assert.equal(readClaudeNativeTitle(home, id), "Latest summary");
  appendFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "AI wins" }) + "\n");
  assert.equal(readClaudeNativeTitle(home, id), "AI wins");
});

test("Claude duplicate transcripts for one uuid resolve to the newest instead of failing", (t) => {
  const { home, project } = fixtureHome("dup");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const other = join(home, ".claude", "projects", "-work-repo-worktree");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Old copy" }) + "\n");
  writeFileSync(join(other, id + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Live copy" }) + "\n");
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(project, id + ".jsonl"), past, past);
  assert.equal(readClaudeNativeTitle(home, id), "Live copy");
});

test("native title replaces a stale in-memory fallback but never a locked title", async () => {
  const { home, project } = fixtureHome("stale");
  writeFileSync(join(project, id + ".jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Native title" }) + "\n");
  let locked = false;
  let stored = "Claude Code (renamed by a role flow)";
  const session = { id, title: stored, setTitle(title) { this.title = title; } };
  const manager = Object.create(SessionManager.prototype);
  manager.live = new Map([[id, session]]);
  manager.shards = { driver: { homePath: () => "/home/agent", hostPath: () => home } };
  manager.nativeTitleSessions = new Map([[id, { userId: "u", provider: "claude", fallback: "Claude Code", lastNativeTitle: null, providerSessionId: id, handle: {}, checkedAt: 0, checking: false }]]);
  manager.pool = { async query(sql, values) {
    assert.ok(sql.includes("title_locked=FALSE"));
    if (locked) return { rows: [] };
    stored = values[1];
    return { rows: [{ id }] };
  } };
  await manager.updateNativeTitle(id, true);
  assert.equal(stored, "Native title");
  assert.equal(session.title, "Native title");
  rmSync(home, { recursive: true, force: true });
});
