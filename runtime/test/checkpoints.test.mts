import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointScheduler, checkpointDirectory, checkpointSnapshot, checkpointTranscript, findCodexRolloutPath, restoreFromCheckpoint, sweepCheckpoints, validSegment } from "../dist/checkpoints.js";

const SID = "11111111-1111-4111-8111-111111111111";
const uid = process.getuid?.() ?? null;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "floq-ckpt-"));
  const dir = join(home, ".claude", "projects", "-work");
  mkdirSync(dir, { recursive: true });
  return { home, source: join(dir, SID + ".jsonl"), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const req = (home: string, sourcePath: string, extra: object = {}) => ({ home, uid, sessionId: SID, provider: "claude" as const, providerSessionId: SID, sourcePath, ...extra });
const ckptDir = (home: string) => join(home, ".floq", "checkpoints", SID);

test("path segment validation", () => {
  for (const ok of [SID, "ses_abc123", "a.b-c_d"]) assert.equal(validSegment(ok), true, ok);
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a..b", "x\0y", "a".repeat(200), 5 as unknown as string]) assert.equal(validSegment(bad), false, String(bad));
});

test("incremental append copies only new complete lines", async () => {
  const { home, source, cleanup } = setup();
  try {
    writeFileSync(source, '{"a":1}\n{"a":2}\n{"a"');
    const first = await checkpointTranscript(req(home, source));
    assert.equal(first.status, "copied");
    const copy = join(ckptDir(home), SID + ".jsonl");
    assert.equal(readFileSync(copy, "utf8"), '{"a":1}\n{"a":2}\n'); // torn last line is left for later
    assert.equal(lstatSync(copy).mode & 0o777, 0o600);
    assert.equal((await checkpointTranscript(req(home, source))).status, "unchanged");
    appendFileSync(source, ':3}\n{"a":4}\n');
    const second = await checkpointTranscript(req(home, source));
    assert.equal(second.status, "copied");
    assert.equal(second.generation, 0);
    assert.equal(readFileSync(copy, "utf8"), readFileSync(source, "utf8"));
    const meta = JSON.parse(readFileSync(join(ckptDir(home), SID + ".meta.json"), "utf8"));
    assert.equal(meta.offset, readFileSync(source).length);
    assert.equal(meta.provider, "claude");
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);
    assert.equal(meta.sourceRel, ".claude/projects/-work/" + SID + ".jsonl");
  } finally { cleanup(); }
});

test("truncation and rewrite start a new generation and never overwrite the old one", async () => {
  const { home, source, cleanup } = setup();
  try {
    writeFileSync(source, "line-one\nline-two\nline-three\n");
    await checkpointTranscript(req(home, source));
    const gen0 = join(ckptDir(home), SID + ".jsonl");
    const original = readFileSync(gen0, "utf8");
    // truncation: source shorter than the recorded offset
    writeFileSync(source, "short\n");
    const t = await checkpointTranscript(req(home, source));
    assert.equal(t.status, "new-generation");
    assert.equal(t.generation, 1);
    assert.equal(readFileSync(gen0, "utf8"), original);
    assert.equal(readFileSync(join(ckptDir(home), SID + ".g1.jsonl"), "utf8"), "short\n");
    // rewrite at equal or longer size with different prefix: hash mismatch
    writeFileSync(source, "SHORT\nmore\n");
    const r = await checkpointTranscript(req(home, source));
    assert.equal(r.status, "new-generation");
    assert.equal(r.generation, 2);
    assert.equal(readFileSync(join(ckptDir(home), SID + ".g1.jsonl"), "utf8"), "short\n");
    assert.equal(readFileSync(join(ckptDir(home), SID + ".g2.jsonl"), "utf8"), "SHORT\nmore\n");
    // a plain append after the rewrite keeps appending to generation 2
    appendFileSync(source, "tail\n");
    assert.equal((await checkpointTranscript(req(home, source))).generation, 2);
    assert.equal(readFileSync(join(ckptDir(home), SID + ".g2.jsonl"), "utf8"), "SHORT\nmore\ntail\n");
  } finally { cleanup(); }
});

test("a damaged checkpoint file (shorter than the offset) moves to a new generation", async () => {
  const { home, source, cleanup } = setup();
  try {
    writeFileSync(source, "aaaa\nbbbb\n");
    await checkpointTranscript(req(home, source));
    writeFileSync(join(ckptDir(home), SID + ".jsonl"), "aa");
    const r = await checkpointTranscript(req(home, source));
    assert.equal(r.status, "new-generation");
    assert.equal(readFileSync(join(ckptDir(home), SID + ".g1.jsonl"), "utf8"), "aaaa\nbbbb\n");
  } finally { cleanup(); }
});

test("cap prunes old generations but keeps the newest", async () => {
  const { home, source, cleanup } = setup();
  try {
    const big = "x".repeat(1024) + "\n";
    writeFileSync(source, big.repeat(3000)); // ~3 MiB
    await checkpointTranscript(req(home, source));
    writeFileSync(source, "tiny-1\n");
    await checkpointTranscript(req(home, source));
    writeFileSync(source, "tiny-2-different\n");
    await checkpointTranscript(req(home, source));
    const names = readdirSync(ckptDir(home)).filter((n) => n.endsWith(".jsonl")).sort();
    assert.ok(!names.includes(SID + ".jsonl"), "oversized generation 0 pruned: " + names.join());
    assert.ok(names.includes(SID + ".g2.jsonl"));
  } finally { cleanup(); }
});

test("restore puts the checkpoint back only when the live file is missing or shorter", async () => {
  const { home, source, cleanup } = setup();
  try {
    writeFileSync(source, '{"m":1}\n{"m":2}\n{"m":3}\n');
    const full = readFileSync(source, "utf8");
    await checkpointTranscript(req(home, source));
    assert.equal(restoreFromCheckpoint(home, SID, "claude", SID), false, "live file is as long");
    writeFileSync(source, '{"m":1}\n');
    assert.equal(restoreFromCheckpoint({ home, uid }, SID, "claude", SID), true, "shorter");
    assert.equal(readFileSync(source, "utf8"), full);
    rmSync(join(home, ".claude"), { recursive: true });
    assert.equal(restoreFromCheckpoint(home, SID, "claude", SID), true, "missing, parent dirs recreated");
    assert.equal(readFileSync(source, "utf8"), full);
    assert.equal(lstatSync(source).mode & 0o777, 0o600);
    appendFileSync(source, '{"m":4}\n');
    assert.equal(restoreFromCheckpoint(home, SID, "claude", SID), false, "live grew past the checkpoint");
    assert.match(readFileSync(source, "utf8"), /"m":4/);
    assert.equal(restoreFromCheckpoint(home, SID, "codex", SID), false, "provider mismatch");
    assert.equal(restoreFromCheckpoint(home, SID, "claude", "22222222-2222-4222-8222-222222222222"), false, "no checkpoint");
  } finally { cleanup(); }
});

test("restore refuses a symlinked destination and does not write through it", async () => {
  const { home, source, cleanup } = setup();
  const outside = mkdtempSync(join(tmpdir(), "floq-outside-"));
  try {
    writeFileSync(source, "one\ntwo\n");
    await checkpointTranscript(req(home, source));
    rmSync(source);
    const target = join(outside, "stolen");
    symlinkSync(target, source);
    assert.equal(restoreFromCheckpoint(home, SID, "claude", SID), false);
    assert.equal(existsSync(target), false);
    rmSync(source);
    rmSync(join(home, ".claude", "projects", "-work"), { recursive: true });
    symlinkSync(outside, join(home, ".claude", "projects", "-work"));
    assert.equal(restoreFromCheckpoint(home, SID, "claude", SID), false, "symlinked ancestor");
    assert.deepEqual(readdirSync(outside), []);
  } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("checkpoint never follows links out of the home", async () => {
  const { home, source, cleanup } = setup();
  const outside = mkdtempSync(join(tmpdir(), "floq-outside-"));
  try {
    writeFileSync(join(outside, "secret.jsonl"), "secret\n");
    // source is a symlink to a file outside
    symlinkSync(join(outside, "secret.jsonl"), source);
    await assert.rejects(checkpointTranscript(req(home, source)));
    rmSync(source);
    // source path escapes the home textually
    await assert.rejects(checkpointTranscript(req(home, join(outside, "secret.jsonl"))));
    // checkpoint root planted as a symlink out of the home
    mkdirSync(join(home, ".floq"), { recursive: true });
    symlinkSync(outside, join(home, ".floq", "checkpoints"));
    writeFileSync(source, "ok\n");
    await assert.rejects(checkpointTranscript(req(home, source)));
    assert.deepEqual(readdirSync(outside), ["secret.jsonl"]);
  } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("session and provider ids are validated as path segments", async () => {
  const { home, source, cleanup } = setup();
  try {
    writeFileSync(source, "x\n");
    for (const bad of ["../escape", "a/b", "..", ""]) {
      await assert.rejects(checkpointTranscript({ ...req(home, source), sessionId: bad }));
      await assert.rejects(checkpointTranscript({ ...req(home, source), providerSessionId: bad }));
      assert.equal(restoreFromCheckpoint(home, bad, "claude", SID), false);
      assert.equal(restoreFromCheckpoint(home, SID, "claude", bad), false);
    }
    assert.equal(existsSync(join(home, ".floq", "checkpoints", "..", "escape")), false);
  } finally { cleanup(); }
});

test("missing source is skipped, not an error", async () => {
  const { home, source, cleanup } = setup();
  try {
    assert.equal((await checkpointTranscript(req(home, source))).status, "skipped");
  } finally { cleanup(); }
});

test("codex rollout discovery picks the newest rollout without following links", () => {
  const { home, cleanup } = setup();
  try {
    const sessions = join(home, ".floq", "codex", SID, "sessions", "2026", "11", "18");
    mkdirSync(sessions, { recursive: true });
    const a = join(sessions, "rollout-2026-11-18T01-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    const b = join(sessions, "rollout-2026-11-18T02-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl");
    writeFileSync(a, "a\n"); writeFileSync(b, "b\n");
    utimesSync(a, 1000, 1000); utimesSync(b, 2000, 2000);
    const found = findCodexRolloutPath(home, join(home, ".floq", "codex", SID, "sessions"), uid);
    assert.equal(found, b);
    assert.equal(findCodexRolloutPath(home, join(home, "nope"), uid), null);
  } finally { cleanup(); }
});

test("codex checkpoint + restore round trip", async () => {
  const { home, cleanup } = setup();
  try {
    const dir = join(home, ".floq", "codex", SID, "sessions", "2026", "11", "18");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-2026-11-18T01-00-00-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    writeFileSync(file, '{"t":1}\n{"t":2}\n');
    const pid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await checkpointTranscript({ home, uid, sessionId: SID, provider: "codex", providerSessionId: pid, sourcePath: file });
    rmSync(file);
    assert.equal(restoreFromCheckpoint(home, SID, "codex", pid), true);
    assert.equal(readFileSync(file, "utf8"), '{"t":1}\n{"t":2}\n');
  } finally { cleanup(); }
});

test("opencode snapshot is written once per distinct content", () => {
  const { home, cleanup } = setup();
  try {
    const base = { home, uid, sessionId: SID, provider: "opencode" as const, providerSessionId: "ses_abc123" };
    assert.equal(checkpointSnapshot({ ...base, content: '{"v":1}' }).status, "copied");
    assert.equal(checkpointSnapshot({ ...base, content: '{"v":1}' }).status, "unchanged");
    const next = checkpointSnapshot({ ...base, content: '{"v":2}' });
    assert.equal(next.status, "new-generation");
    assert.equal(readFileSync(join(ckptDir(home), "ses_abc123.snapshot.json"), "utf8"), '{"v":1}');
    assert.equal(readFileSync(join(ckptDir(home), "ses_abc123.g1.snapshot.json"), "utf8"), '{"v":2}');
    assert.equal(checkpointSnapshot({ ...base, content: "" }).status, "skipped");
  } finally { cleanup(); }
});

test("agy directory mirror and restore", () => {
  const { home, cleanup } = setup();
  try {
    const src = join(home, ".gemini", "conversations", "conv1");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "a.pb"), "AAAA"); writeFileSync(join(src, "sub", "b.pb"), "BB");
    symlinkSync("/etc/passwd", join(src, "link.pb"));
    const base = { home, uid, sessionId: SID, provider: "antigravity" as const, providerSessionId: "conv1", sourceDir: src };
    assert.equal(checkpointDirectory(base).status, "copied");
    assert.equal(readFileSync(join(ckptDir(home), "conv1.dir", "sub", "b.pb"), "utf8"), "BB");
    assert.equal(existsSync(join(ckptDir(home), "conv1.dir", "link.pb")), false);
    rmSync(src, { recursive: true });
    assert.equal(restoreFromCheckpoint(home, SID, "antigravity", "conv1"), true);
    assert.equal(readFileSync(join(src, "a.pb"), "utf8"), "AAAA");
    assert.equal(readFileSync(join(src, "sub", "b.pb"), "utf8"), "BB");
    assert.equal(restoreFromCheckpoint(home, SID, "antigravity", "conv1"), false, "nothing missing: nothing restored");
  } finally { cleanup(); }
});

test("retention: deleted agents' checkpoints are kept 7 days, live agents' never", async () => {
  const { home, source, cleanup } = setup();
  try {
    writeFileSync(source, "x\n");
    await checkpointTranscript(req(home, source));
    const t0 = 1_000_000_000_000;
    assert.equal(sweepCheckpoints({ home, uid }, new Set([SID]), t0), 0);
    assert.equal(existsSync(join(ckptDir(home), ".deleted")), false);
    assert.equal(sweepCheckpoints({ home, uid }, new Set(), t0), 0); // first sight of deletion: marker only
    assert.equal(existsSync(join(ckptDir(home), ".deleted")), true);
    assert.equal(sweepCheckpoints({ home, uid }, new Set(), t0 + 6 * 24 * 3600_000), 0);
    assert.equal(sweepCheckpoints({ home, uid }, new Set([SID]), t0 + 6.5 * 24 * 3600_000), 0); // agent came back
    assert.equal(existsSync(join(ckptDir(home), ".deleted")), false);
    sweepCheckpoints({ home, uid }, new Set(), t0 + 7 * 24 * 3600_000); // re-marked
    assert.equal(sweepCheckpoints({ home, uid }, new Set(), t0 + 14.1 * 24 * 3600_000), 1);
    assert.equal(existsSync(ckptDir(home)), false);
  } finally { cleanup(); }
});

test("scheduler: at most one run per interval, trailing run, flush forces", async () => {
  let now = 0;
  const runs: string[] = [];
  const s = new CheckpointScheduler(async (k) => { runs.push(k); }, { intervalMs: 60_000, now: () => now });
  try {
    assert.equal(s.notify("a"), true);
    await new Promise((r) => setImmediate(r));
    now = 10_000;
    assert.equal(s.notify("a"), false);
    assert.equal(s.notify("a"), false);
    assert.deepEqual(runs, ["a"]);
    await s.flush("a");
    assert.deepEqual(runs, ["a", "a"]);
    now = 200_000;
    assert.equal(s.notify("a"), true);
    assert.equal(s.notify("b"), true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(runs.sort(), ["a", "a", "a", "b"]);
  } finally { s.dispose(); }
});

test("scheduler reports errors and keeps going", async () => {
  const errors: unknown[] = [];
  const s = new CheckpointScheduler(async () => { throw new Error("boom"); }, { intervalMs: 0, onError: (_k, e) => errors.push(e) });
  await s.flush("a");
  await s.flush("a");
  assert.equal(errors.length, 2);
  s.dispose();
});
