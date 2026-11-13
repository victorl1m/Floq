import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HANDOFF_MAX_CHARS, buildHandoff, claudeBackNotice, codexHandoffPrompt, parseClaudeContext, redactSecrets } from "../dist/handoff.js";
import { SessionManager } from "../dist/manager.js";

const jl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user", isSidechain: false, uuid: "u-" + text.slice(0, 8), message: { role: "user", content: text }, ...extra });
const assistant = (blocks: unknown[], id = "m1") => ({ type: "assistant", isSidechain: false, uuid: "a-" + id, message: { id, role: "assistant", model: "claude-opus", content: blocks } });

test("T-6 context: first prompt from the head, last 3 prompts and last reply from the tail, newest TodoWrite wins; sidechains, meta and CLI error records ignored", () => {
  const head = jl(user("<meta>", { isMeta: true }), user("Build the export feature"), assistant([{ type: "text", text: "ok" }]));
  const tail = jl(
    user("p1"), user("p2"), user("p3"), user("p4"),
    assistant([{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "old", status: "pending" }] } }], "m2"),
    assistant([{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "write tests", status: "in_progress" }, { content: "ship", status: "completed" }] } }], "m3"),
    { ...assistant([{ type: "text", text: "sidechain text" }], "m4"), isSidechain: true },
    assistant([{ type: "text", text: "Part one. " }], "m5"),
    assistant([{ type: "text", text: "Part two." }], "m5"),
    { ...assistant([{ type: "text", text: "You've hit your 5-hour limit" }], "m6"), isApiErrorMessage: true },
  );
  const ctx = parseClaudeContext(head, tail);
  assert.equal(ctx.firstPrompt, "Build the export feature");
  assert.deepEqual(ctx.lastPrompts, ["p2", "p3", "p4"]);
  assert.equal(ctx.lastReply, "Part one. Part two.");
  assert.deepEqual(ctx.todos, [{ status: "in_progress", content: "write tests" }, { status: "completed", content: "ship" }]);
  assert.equal(parseClaudeContext("", jl(user("only"))).firstPrompt, "only", "falls back to the first prompt in the tail");
});

test("T-6 handoff text: sections, working tree, transcript path, size cap, token-like strings redacted, absolute paths kept", () => {
  const secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const text = buildHandoff({
    direction: "to-codex", title: "Builder", cwd: "/home/agent/work", role: "implementer", parentSessionId: "11111111-2222-4333-8444-555555555555",
    reason: { window: "five_hour", resetsAt: "2026-11-12T20:00:00.000Z" },
    context: { firstPrompt: "Use key " + secret + " to call the API", lastPrompts: ["a", "b"], lastReply: "Done with step 1", todos: [{ status: "pending", content: "step 2" }] },
    git: { branch: "feat/x", changes: [{ status: "M", path: "src/a.ts" }, { status: "??", path: "new.txt" }], truncated: false },
    transcriptPath: "/home/agent/.claude/projects/-w/abc.jsonl",
  });
  for (const part of ["# Handoff: Claude to Codex", "five_hour", "## Original task", "## Latest requests", "## Todo list", "- [ ] step 2", "branch feat/x", "M  src/a.ts", "/home/agent/.claude/projects/-w/abc.jsonl", "Parent agent"]) assert.ok(text.includes(part), part);
  assert.ok(!text.includes(secret), "secret redacted");
  assert.ok(text.includes("[redacted]"));
  const big = buildHandoff({ direction: "to-codex", title: "t", cwd: "/w", role: null, parentSessionId: null, reason: null, context: { firstPrompt: "x ".repeat(50_000), lastPrompts: Array(3).fill("y ".repeat(5000)), lastReply: "z ".repeat(9000), todos: Array.from({ length: 500 }, (_, i) => ({ status: "pending", content: "todo " + i })) }, git: { branch: null, changes: Array.from({ length: 900 }, (_, i) => ({ status: "M", path: "f" + i })), truncated: true }, transcriptPath: null });
  assert.ok(big.length <= HANDOFF_MAX_CHARS, "size " + big.length);
  assert.equal(redactSecrets("see /home/agent/.floq/handoff/abc-1.md now"), "see /home/agent/.floq/handoff/abc-1.md now");
});

test("T-6 back to Claude: carries the Codex reply and the earlier handoff; prompts name the file and say not to redo steps", () => {
  const text = buildHandoff({ direction: "to-claude", title: "B", cwd: "/w", role: null, parentSessionId: null, reason: null, context: { firstPrompt: null, lastPrompts: [], lastReply: null, todos: [] }, git: null, transcriptPath: null, codexReply: "I finished the parser", previousHandoff: "/home/agent/.floq/handoff/x-1.md" });
  assert.match(text, /# Handoff: Codex back to Claude/);
  assert.match(text, /I finished the parser/);
  assert.match(text, /x-1\.md/);
  assert.match(codexHandoffPrompt("/h/f.md"), /Read \/h\/f\.md first.*Do not redo finished steps/);
  assert.match(claudeBackNotice("/h/f.md"), /Back on Claude.*\/h\/f\.md/);
});

test("T-6 writeHandoffFile: mode 0600, owned by the uid, name validated, files older than 7 days pruned", async () => {
  const root = mkdtempSync(join(tmpdir(), "floq-handoff-"));
  try {
    const manager = Object.create(SessionManager.prototype) as SessionManager;
    const uid = process.getuid!();
    Object.assign(manager, { shards: { wake: async () => ({ mountPath: root, uid }), driver: { hostPath: (_h: unknown, rel: string) => join(root, rel), homePath: () => "/home/agent" } } });
    const dir = join(root, ".floq/handoff");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old-1.md"), "old");
    const past = new Date(Date.now() - 8 * 86_400_000);
    utimesSync(join(dir, "old-1.md"), past, past);
    const path = await manager.writeHandoffFile("u1", "abc-1.md", "hello");
    assert.equal(path, "/home/agent/.floq/handoff/abc-1.md");
    const st = statSync(join(dir, "abc-1.md"));
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, uid);
    assert.equal(readFileSync(join(dir, "abc-1.md"), "utf8"), "hello");
    assert.equal(existsSync(join(dir, "old-1.md")), false, "stale handoff pruned");
    await assert.rejects(manager.writeHandoffFile("u1", "../escape.md", "x"), /invalid handoff name/);
    await assert.rejects(manager.writeHandoffFile("u1", "a/b.md", "x"), /invalid handoff name/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("T-6 switchProvider: stops the old process, flips provider+model in the same row, queues the notice, fresh Codex start carries the prompt; a failure restores the row", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const order: string[] = [];
  const row = { id, user_id: "u1", provider: "claude", model: "opus", provider_session_id: null as string | null };
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  Object.assign(manager, {
    lifecycle: { assertOpen() {} },
    restartTasks: new Map(),
    intentionalSleep: new Set(),
    bootNotices: new Map(),
    pool: { async query(sql: string, v: unknown[] = []) {
      if (sql.startsWith("SELECT")) return { rows: [{ ...row }] };
      if (sql.includes("SET provider = $3, model = $4 WHERE")) { order.push(`row:${v[2]}:${v[3]}`); row.provider = v[2] as string; row.model = v[3] as string; return { rows: [] }; }
      if (sql.includes("fallback-switch-failed")) { order.push("failed-restored:" + v[2]); row.provider = v[2] as string; return { rows: [] }; }
      throw new Error("unexpected " + sql);
    } },
    sleepSession: async (sid: string, reason: string, o: { waitForExit?: boolean }) => { order.push(`stop:${reason}:${o.waitForExit}`); },
    resumeOnce: async (_u: string, _p: unknown, sid: string, strict: boolean, opts: { fresh?: boolean; prompt?: string }) => { order.push(`launch:${strict}:${opts.fresh}:${opts.prompt}`); return { id: sid }; },
  });
  await manager.switchProvider("u1", {} as never, id, { provider: "codex", model: "gpt-x", prompt: "[Floq] read the file" });
  assert.deepEqual(order, ["stop:usage-fallback:true", "row:codex:gpt-x", "launch:true:true:[Floq] read the file"]);
  // resume of an existing Codex conversation: not fresh, the notice is queued for after the launch
  order.length = 0; row.provider_session_id = "codex-conv-1"; row.provider = "claude";
  await manager.switchProvider("u1", {} as never, id, { provider: "codex", model: "gpt-x", notice: "[Floq] back with you" });
  assert.deepEqual(order, ["stop:usage-fallback:true", "row:codex:gpt-x", "launch:true:false:undefined"]);
  assert.equal((manager as unknown as { bootNotices: Map<string, string> }).bootNotices.get(id), "[Floq] back with you");
  // failure: row goes back to its provider, notice dropped
  order.length = 0; row.provider = "claude"; row.model = "opus";
  (manager as unknown as { resumeOnce: () => Promise<never> }).resumeOnce = async () => { throw new Error("launch failed"); };
  await assert.rejects(manager.switchProvider("u1", {} as never, id, { provider: "codex", model: "gpt-x", notice: "n" }), /launch failed/);
  assert.equal(row.provider, "claude");
  assert.equal((manager as unknown as { bootNotices: Map<string, string> }).bootNotices.has(id), false);
});

test("review2-1 redaction keeps file paths (relative and long absolute) and still removes token-like strings", () => {
  const files = "M src/components/canvas/agent-node.tsx\n?? runtime/test/fixtures/claude-usage-limit-2.1.319.jsonl\nR  docs/design/claude-swap-fallback.md";
  assert.equal(redactSecrets(files), files);
  const long = "/home/agent/.floq/projects/1151cd0e-3578-48c7-8816-0d0c82f16a7f/some/deeply/nested/dir/with/a/very/long/path/to/the/transcript-file-name-0123456789.jsonl";
  assert.equal(redactSecrets("see " + long), "see " + long);
  assert.equal(redactSecrets("key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY end"), "key [redacted] end", "no extension, no leading slash: not a path");
  assert.equal(redactSecrets("token sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx end"), "token [redacted] end");
  assert.equal(redactSecrets("b64 QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo= end"), "b64 [redacted] end");
  const text = buildHandoff({ direction: "to-codex", title: "t", cwd: "/w", role: null, parentSessionId: null, reason: null, context: { firstPrompt: "x", lastPrompts: [], lastReply: null, todos: [] }, git: { branch: "b", changes: [{ status: "M", path: "src/components/canvas/agent-node.tsx" }], truncated: false }, transcriptPath: null });
  assert.match(text, /M {2}src\/components\/canvas\/agent-node\.tsx/, "the working tree list stays useful");
});

test("review2-5 switchProvider: when the old process could not be stopped the row is NOT marked failed (it is still tracked)", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const queries: string[] = [];
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  Object.assign(manager, {
    lifecycle: { assertOpen() {} }, restartTasks: new Map(), intentionalSleep: new Set(), bootNotices: new Map(),
    pool: { async query(sql: string) { queries.push(sql); if (sql.startsWith("SELECT")) return { rows: [{ id, user_id: "u1", provider: "claude", model: "opus" }] }; return { rows: [] }; } },
    sleepSession: async () => { throw new Error("old process did not stop"); },
  });
  await assert.rejects(manager.switchProvider("u1", {} as never, id, { provider: "codex", model: "gpt-x", prompt: "p" }), /did not stop/);
  assert.ok(!queries.some((q) => q.includes("fallback-switch-failed") || q.includes("SET provider")), "no provider flip, no failed marker");
});

test("advisor typeNotice: only a live Claude/Codex agent of that user gets the notice", async () => {
  const typed: string[] = [];
  const live = { userId: "u1", isAlive: true, provider: "claude", write: (d: string) => typed.push(d) };
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  Object.assign(manager, { logins: new Map(), live: new Map([["p1", live], ["sh", { ...live, provider: "shell" }], ["other", { ...live, userId: "u2" }]]) });
  assert.equal(await manager.typeNotice("u1", "p1", "[Floq] hi"), true);
  assert.ok(typed.join("").includes("[Floq] hi"));
  assert.equal(await manager.typeNotice("u1", "sh", "x"), false);
  assert.equal(await manager.typeNotice("u1", "other", "x"), false);
  assert.equal(await manager.typeNotice("u1", "missing", "x"), false);
});

test("review2-6 syncClaudeNow: adopts what the CLI wrote; an account that could not be identified is retried, not dropped", async () => {
  const root = mkdtempSync(join(tmpdir(), "floq-sync-"));
  try {
    const credPath = join(root, ".claude", ".credentials.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    const write = (token: string) => writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: token } }));
    const adopted: string[] = [];
    const result = { value: "active" as string };
    const manager = Object.create(SessionManager.prototype) as SessionManager;
    Object.assign(manager, {
      shards: { isAwake: () => true, wake: async () => ({ mountPath: root, uid: 0 }), driver: { hostPath: (_h: unknown, rel: string) => join(root, rel) } },
      credMtime: new Map<string, number>(),
      credentials: { adopt: async (_u: string, _p: string, data: { refreshToken: string }) => { adopted.push(data.refreshToken); return true; } },
      accounts: { adoptAttributed: async () => result.value },
    });
    write("r1");
    await manager.syncClaudeNow("u1");
    assert.deepEqual(adopted, ["r1"]);
    result.value = "retry"; write("r2");
    await manager.syncClaudeNow("u1");
    assert.deepEqual(adopted, ["r1"], "not adopted now");
    assert.equal((manager as unknown as { credMtime: Map<string, number> }).credMtime.size, 0, "the file is looked at again next time");
    result.value = "reserve"; write("r3");
    await manager.syncClaudeNow("u1");
    assert.deepEqual(adopted, ["r1"], "belongs to a reserve account: stored there, not as the active login");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
