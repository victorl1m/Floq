import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAY_MS, DEFAULT_CONFIG } from "../src/storageSense/plan.js";
import { StorageSense, type SessionRow, type StorageSenseHost, type WorkspaceRow } from "../src/storageSense/service.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "aaaaaaaa-0000-4000-8000-000000000002", C = "aaaaaaaa-0000-4000-8000-000000000003", D = "aaaaaaaa-0000-4000-8000-000000000004", E = "aaaaaaaa-0000-4000-8000-000000000005";
const FUTURE = Date.now() + 120 * DAY_MS;

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "floq-ss-")));
  const repo = join(home, ".floq/projects/p1");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init");
  const workspaces: WorkspaceRow[] = [];
  const sessions: SessionRow[] = [];
  const addWt = (id: string) => {
    git(repo, "worktree", "add", "-q", "-b", `floq/${id}`, join(home, ".floq/worktrees", id), "HEAD");
    workspaces.push({ id: "ws-" + id, projectId: "p1", cwd: `.floq/worktrees/${id}`, projectCwd: ".floq/projects/p1", isWorktree: true, available: true, createdMs: 1 });
    return join(home, ".floq/worktrees", id);
  };
  const unavailable: string[] = [];
  const host: StorageSenseHost = {
    awakeUserIds: () => ["u"], homeOf: () => home,
    sessions: async () => sessions, workspaces: async () => workspaces,
    git: async (_u, cwd, args) => { try { return { stdout: execFileSync("git", args, { cwd: join(home, cwd), env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), exitCode: 0 }; } catch (e) { const err = e as { status?: number; stdout?: string; stderr?: string }; return { stdout: String(err.stdout ?? "") + String(err.stderr ?? ""), exitCode: err.status ?? 1 }; } },
    withProject: (_u, _p, fn) => fn(), withActivity: (_u, fn) => fn(),
    markWorkspaceUnavailable: async (_u, _p, id) => { unavailable.push(id); const w = workspaces.find((x) => x.id === id); if (w) w.available = false; },
    freePercent: async () => 50,
  };
  return { home, repo, workspaces, sessions, addWt, host, unavailable, svc: new StorageSense(host) };
}
const run = (f: ReturnType<typeof fixture>, dryRun = false) => f.svc.run("u", DEFAULT_CONFIG, { dryRun, trigger: "manual", now: FUTURE });
const find = (r: NonNullable<Awaited<ReturnType<typeof run>>>, label: string) => r.entries.find((e) => e.label.includes(label));

test("worktrees: clean+merged removed; dirty, unmerged and live-agent kept; cherry-picked counts as merged", async () => {
  const f = fixture();
  try {
    const clean = f.addWt(A);
    const dirty = f.addWt(B); writeFileSync(join(dirty, "new.txt"), "wip\n");
    const unmerged = f.addWt(C); writeFileSync(join(unmerged, "c.txt"), "c\n"); git(unmerged, "add", "."); git(unmerged, "commit", "-qm", "work");
    const live = f.addWt(D);
    f.sessions.push({ id: "s1", workspaceId: "ws-" + D, state: "sleeping", lastActiveMs: 1 });
    const picked = f.addWt(E); writeFileSync(join(picked, "e.txt"), "e\n"); git(picked, "add", "."); git(picked, "commit", "-qm", "feature");
    git(f.repo, "cherry-pick", `floq/${E}`); // different commit id, same patch: not an ancestor of main

    const dry = (await run(f, true))!;
    assert.equal(existsSync(clean), true, "dry run removes nothing");
    assert.equal(find(dry, A)!.action, "would-remove");

    const r = (await run(f))!;
    assert.equal(find(r, A)!.action, "removed");
    assert.equal(existsSync(clean), false);
    assert.equal(git(f.repo, "branch", "--list", `floq/${A}`), "", "its branch is deleted too");
    assert.equal(find(r, B)!.reason, "unsaved_work"); assert.equal(existsSync(join(dirty, "new.txt")), true);
    assert.equal(find(r, C)!.reason, "not_merged"); assert.equal(existsSync(unmerged), true);
    assert.equal(find(r, D)!.reason, "agent_live"); assert.equal(existsSync(live), true);
    assert.equal(find(r, E)!.action, "removed", "cherry-picked content is merged"); assert.equal(existsSync(picked), false);
    assert.equal(r.counts.attention, 2);
    assert.deepEqual(f.unavailable.sort(), ["ws-" + A, "ws-" + E].sort());
    // Idempotent: a second run has nothing left to remove.
    const again = (await run(f))!;
    assert.equal(again.counts.removed, 0);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("worktrees: recent activity keeps even a clean merged worktree", async () => {
  const f = fixture();
  try {
    const wt = f.addWt(A);
    const r = (await f.svc.run("u", DEFAULT_CONFIG, { dryRun: false, trigger: "manual" }))!;
    assert.equal(find(r, A)!.reason, "too_recent");
    assert.equal(existsSync(wt), true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("orphan branches: merged removed, unmerged and agent-owned kept", async () => {
  const f = fixture();
  try {
    f.workspaces.push({ id: "ws-main", projectId: "p1", cwd: ".floq/projects/p1", projectCwd: ".floq/projects/p1", isWorktree: false, available: true, createdMs: 1 });
    git(f.repo, "branch", `floq/${A}`);
    git(f.repo, "checkout", "-q", "-b", `floq/${B}`); writeFileSync(join(f.repo, "b.txt"), "b\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "b"); git(f.repo, "checkout", "-q", "main");
    git(f.repo, "branch", `floq/${C}`);
    f.sessions.push({ id: C, workspaceId: null, state: "exited", lastActiveMs: 1 });
    const r = (await run(f))!;
    assert.equal(find(r, A)!.action, "removed");
    assert.equal(find(r, B)!.reason, "not_merged");
    assert.equal(find(r, C)!.reason, "agent_exists");
    assert.equal(git(f.repo, "branch", "--list", "floq/*").split("\n").map((s) => s.trim()).sort().join(","), `floq/${B},floq/${C}`);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("files: stale attachments and scratchpads go; symlinks, Artifacts, checkpoints and recent data stay", async () => {
  const f = fixture();
  try {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "floq-ss-out-")));
    writeFileSync(join(outside, "precious.txt"), "keep");
    const att = (id: string) => join(f.home, ".floq/attachments", id);
    mkdirSync(att(A), { recursive: true }); writeFileSync(join(att(A), "f.bin"), "x".repeat(100));
    symlinkSync(outside, att(B)); // a symlink where an attachment dir is expected
    mkdirSync(att(C), { recursive: true }); symlinkSync(outside, join(att(C), "link")); // nested link
    const pad = (sid: string) => join(f.home, ".floq/tmp/claude-1000/-proj", sid, "scratchpad");
    mkdirSync(pad(D), { recursive: true }); writeFileSync(join(pad(D), "x"), "1");
    mkdirSync(pad(E), { recursive: true }); writeFileSync(join(pad(E), "x"), "1");
    f.sessions.push({ id: E, workspaceId: null, state: "running", lastActiveMs: 1 });
    mkdirSync(join(f.home, "Artifacts/x"), { recursive: true }); writeFileSync(join(f.home, "Artifacts/x/report.md"), "keep");
    mkdirSync(join(f.home, ".floq/checkpoints/s"), { recursive: true }); writeFileSync(join(f.home, ".floq/checkpoints/s/t.jsonl"), "keep");
    mkdirSync(join(f.home, ".floq/tmp/venv"), { recursive: true }); writeFileSync(join(f.home, ".floq/tmp/venv/pip.lock"), "");

    const r = (await run(f))!;
    assert.equal(find(r, `attachments/${A}`)!.action, "removed"); assert.equal(existsSync(att(A)), false);
    assert.equal(find(r, `attachments/${B}`)!.reason, "symlink"); assert.equal(existsSync(join(outside, "precious.txt")), true);
    assert.equal(find(r, `attachments/${C}`)!.action, "removed"); // removing the dir unlinks the nested link; its target survives
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep");
    assert.equal(find(r, D)!.action, "removed"); assert.equal(existsSync(join(f.home, ".floq/tmp/claude-1000/-proj", D)), false);
    assert.equal(find(r, E)!.reason, "agent_live"); assert.equal(existsSync(pad(E)), true);
    assert.equal(find(r, "tmp/venv")!.reason, "lock_file");
    assert.equal(readFileSync(join(f.home, "Artifacts/x/report.md"), "utf8"), "keep");
    assert.equal(readFileSync(join(f.home, ".floq/checkpoints/s/t.jsonl"), "utf8"), "keep");
    assert.ok(r.freedBytes >= 100);
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("a second run for the same user is refused while one is in flight", async () => {
  const f = fixture();
  try {
    const first = run(f);
    const second = await run(f);
    assert.equal(second, null);
    assert.ok(await first);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
