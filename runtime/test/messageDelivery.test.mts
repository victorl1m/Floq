import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../src/db.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { CrossProjectGuard } from "../src/crossProject.ts";
import {
  INLINE_MAX_CHARS, MessageInbox, PASTE_END, PASTE_START, PLAIN_WRITE_MAX, bracketedPasteState, chunkText, clip, inboxPointer,
  sanitizeForTerminal, serialPerTarget, sha256Prefix, typeMessage,
} from "../src/messageDelivery.ts";
import { MAX_ARGV_MESSAGE_CHARS, formatDelivery, messageSource } from "../image/floq-args.mts";
import { spawnPty } from "../src/pty.ts";

const noSleep = async () => undefined;
const U = "u1";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // sender, project p1
// Same-project header and reply hint typed around every message body.
const SAME_HEAD = "[Message from agent Sender (session " + S1 + ")] ";
const SAME_HINT = " (Reply path: floq ask " + S1 + ' "your reply" --no-wait)';
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // receiver, project p1
const S3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // third agent, project p1
const S4 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // receiver in another project p2

/** The text a terminal application would see: paste markers removed, the final Enter (a lone "\r" write) noted. */
function receive(writes: string[]) {
  const submitted = writes.length > 0 && writes[writes.length - 1] === "\r";
  const raw = writes.slice(0, submitted ? -1 : undefined).join("");
  const bracketed = raw.startsWith(PASTE_START) && raw.endsWith(PASTE_END);
  const text = bracketed ? raw.slice(PASTE_START.length, raw.length - PASTE_END.length) : raw;
  return { text, bracketed, submitted, raw };
}

// ---------- pure framing ----------

test("chunkText round-trips, never splits a surrogate pair and keeps order", () => {
  const text = "a".repeat(255) + "😀" + "b".repeat(600) + "😀".repeat(300);
  const chunks = chunkText(text, 256);
  assert.equal(chunks.join(""), text);
  for (const c of chunks) {
    assert.ok(c.length <= 256);
    assert.ok(!/[\ud800-\udbff]$/.test(c), "chunk must not end in a lone high surrogate");
    assert.ok(!/^[\udc00-\udfff]/.test(c), "chunk must not start with a lone low surrogate");
  }
});

test("clip keeps the HEAD of the text (never the tail) and respects surrogates", () => {
  assert.equal(clip("abcdef", 3), "abc");
  assert.equal(clip("ab😀cd", 3), "ab");
  assert.equal(clip("abc", 10), "abc");
});

test("sanitizeForTerminal removes ESC and other control characters so the paste frame cannot be closed early", () => {
  assert.equal(sanitizeForTerminal("a\u001b[201~b\rc\u0000d"), "a [201~b c d");
  assert.equal(sanitizeForTerminal("tab\there"), "tab here");
});

test("bracketedPasteState follows the last announcement", () => {
  assert.equal(bracketedPasteState("hello"), undefined);
  assert.equal(bracketedPasteState("\u001b[?2004h"), true);
  assert.equal(bracketedPasteState("\u001b[?2004h ... \u001b[?2004l"), false);
  assert.equal(bracketedPasteState("\u001b[?2004l ... \u001b[?2004h"), true);
});

test("typeMessage: small text is one plain write, then a separate Enter", async () => {
  const writes: string[] = [];
  await typeMessage((d) => writes.push(d), "x".repeat(PLAIN_WRITE_MAX), { bracketed: true, sleep: noSleep });
  assert.deepEqual(writes, ["x".repeat(PLAIN_WRITE_MAX), "\r"]);
});

test("typeMessage: long text is ESC[200~ + ordered chunks + ESC[201~, then Enter as its own write after a pause", async () => {
  const writes: string[] = [];
  const events: string[] = [];
  const text = Array.from({ length: 4000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  await typeMessage((d) => { writes.push(d); events.push("w"); }, text, { bracketed: true, sleep: async (ms) => { events.push("s" + ms); } });
  assert.equal(writes[0], PASTE_START);
  assert.equal(writes[writes.length - 2], PASTE_END);
  assert.equal(writes[writes.length - 1], "\r");
  const body = writes.slice(1, -2);
  assert.ok(body.length > 10 && body.every((c) => c.length <= 256));
  assert.equal(body.join(""), text, "chunk order and content preserved");
  assert.ok(!writes.slice(0, -1).some((w) => w.includes("\r")), "no carriage return inside the paste");
  assert.match(events.slice(-2).join(","), /^s\d+,w$/, "Enter is written after a pause");
});

test("typeMessage without bracketed paste sends ordered plain chunks and no markers", async () => {
  const writes: string[] = [];
  await typeMessage((d) => writes.push(d), "y".repeat(1000), { bracketed: false, sleep: noSleep });
  assert.ok(!writes.some((w) => w.includes("\u001b")));
  assert.equal(writes.slice(0, -1).join(""), "y".repeat(1000));
});

test("serialPerTarget never interleaves two deliveries to the same terminal", async () => {
  const out: string[] = [];
  const job = (name: string) => serialPerTarget("t1", async () => { out.push(name + ":start"); await new Promise((r) => setTimeout(r, 15)); out.push(name + ":end"); });
  await Promise.all([job("a"), job("b"), job("c")]);
  assert.deepEqual(out, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

// ---------- orchestrator end to end (fake PTY, real inbox on PGlite) ----------

const row = (id: string, title: string, user: string, projectId: string, projectName: string) => ({
  id, title, provider: "claude", model: null, state: "running", lead: false, role: null, cwd: projectName, git_url: null, project_cwd: projectName, project_id: projectId, workspace_id: null, project_name: projectName, user_id: user,
});

async function setup(options: { secrets?: { redact: (u: string, ids: string[], t: string) => Promise<string> } } = {}) {
  const db = new PGlite();
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  };
  await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await migrateApp(pool as never);
  for (const u of [U, "u2"]) await db.exec(`INSERT INTO "user" (id) VALUES ('${u}')`);
  const P1 = "11111111-1111-4111-8111-111111111111";
  const P2 = "22222222-2222-4222-8222-222222222222";
  for (const [id, name] of [[P1, "p1"], [P2, "p2"]]) await db.query(`INSERT INTO floq_projects (id, user_id, name, cwd) VALUES ($1,$2,$3,$4)`, [id, U, name, "/w/" + name]);
  for (const [id, title, project] of [[S1, "Sender", P1], [S2, "Receiver", P1], [S3, "Third", P1], [S4, "Remote", P2]]) {
    await db.query(`INSERT INTO agent_sessions (id, user_id, provider, title, cwd, state, cols, rows, project_id) VALUES ($1,$2,'claude',$3,'/w','running',80,24,$4)`, [id, U, title, project]);
  }
  const rows = [row(S1, "Sender", U, P1, "p1"), row(S2, "Receiver", U, P1, "p1"), row(S3, "Third", U, P1, "p1"), row(S4, "Remote", U, P2, "p2")];
  const writes = new Map<string, string[]>();
  const lives = new Map<string, unknown>();
  const live = (id: string) => {
    if (!lives.has(id)) {
      writes.set(id, []);
      lives.set(id, { isAlive: true, state: "running", lastActivity: 0, id, provider: "claude", subscribe: () => () => undefined, write: (d: string) => { writes.get(id)!.push(d); }, replaySince: () => ({ chunks: [{ seq: 1, data: "\u001b[?2004h" }] }) });
    }
    return lives.get(id);
  };
  const realPool = pool;
  const fakePool = { query: async (sql: string, params?: unknown[]) => (/FROM agent_sessions s LEFT JOIN/.test(sql) ? { rows: rows.filter((r) => r.user_id === params?.[0]) } : realPool.query(sql, params)) };
  const manager = { findLive: (id: string) => live(id), readAgentTurn: () => null, resume: async () => undefined };
  const settings = { get: async () => ({ allowCrossProjectAgents: true }), profile: async () => ({}) };
  const links = { record: async () => undefined, upsert: async () => ({ id: "l" }) };
  const orchestrator = new Orchestrator(fakePool as never, manager as never, settings as never, links as never, options.secrets as never, new CrossProjectGuard(() => Date.now(), { perMinute: 1000, maxChars: 8000, maxHops: 1000, dedupeMs: 0 }), new MessageInbox(fakePool as never));
  return { db, pool: fakePool, orchestrator, writes, inbox: new MessageInbox(fakePool as never) };
}

const flatten = (text: string) => text.replace(/\r?\n/g, " ").trim();
const CONTENT = {
  plain: (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n),
  newlines: (n: number) => ("line one\nline two\r\n\nline four\n").repeat(Math.ceil(n / 30)).slice(0, n),
  shell: (n: number) => "echo \"quoted\" 'single' `backtick` $(rm -rf /) ${HOME} \\n \\\\ ; | & > < ".repeat(Math.ceil(n / 60)).slice(0, n),
  unicode: (n: number) => "héllo wörld 日本語 😀 ".repeat(Math.ceil(n / 14)).slice(0, n),
  trailing: (n: number) => ("spaces at end   ").repeat(Math.ceil(n / 16)).slice(0, n - 3) + "   ",
};

for (const [kind, make] of Object.entries(CONTENT)) {
  for (const size of [200, 2_000, 5_000, 20_000]) {
    test(`same-project ask of ${size} chars (${kind}): receiver gets everything, in full or via the inbox`, async (t) => {
      const { db, orchestrator, writes, inbox } = await setup();
      t.after(() => db.close());
      let body = make(size);
      if (!body.trim()) body = "x" + body;
      const r = await orchestrator.ask(U, S1, S2, body, 10, false);
      const got = receive(writes.get(S2)!);
      assert.ok(got.submitted, "message is submitted with a separate Enter");
      assert.ok(!got.text.includes("\r") && !got.text.includes("\n"), "one logical input line");
      const delivery = (r as { delivery: { mode: string; chars: number; sha256: string; inboxId?: string } }).delivery;
      if (flatten(body).length <= INLINE_MAX_CHARS) {
        assert.equal(delivery.mode, "full");
        assert.equal(got.text, SAME_HEAD + sanitizeForTerminal(flatten(body)) + SAME_HINT, "exact body, head to tail");
        assert.equal(got.bracketed, SAME_HEAD.length + flatten(body).length + SAME_HINT.length > PLAIN_WRITE_MAX);
      } else {
        assert.equal(delivery.mode, "inbox");
        assert.ok(got.bracketed);
        assert.ok(got.text.length < 800, "typed text stays short: " + got.text.length);
        assert.ok(got.text.startsWith(SAME_HEAD + sanitizeForTerminal(body.replace(/\s+/g, " ").trim()).slice(0, 50)), "starts with the HEAD of the message");
        assert.match(got.text, new RegExp("floq inbox read " + delivery.inboxId));
        const full = await inbox.read(U, S2, delivery.inboxId);
        assert.equal(full.body, body, "inbox holds the EXACT message including newlines, quotes and trailing spaces");
        assert.equal(full.chars, body.length);
        assert.equal(delivery.sha256, sha256Prefix(body));
      }
    });
  }
}

test("cross-project ask keeps the provenance header at the HEAD and the reply hint at the tail, all in one bracketed paste", async (t) => {
  const { db, orchestrator, writes } = await setup();
  t.after(() => db.close());
  const body = CONTENT.plain(1_200);
  await orchestrator.ask(U, S1, S4, body, 10, false);
  const got = receive(writes.get(S4)!);
  assert.equal(got.bracketed, true);
  assert.ok(got.text.startsWith("[Message from agent Sender (project p1, session " + S1 + ", hop 1)] word word"));
  assert.ok(got.text.includes(body.trim()));
  assert.ok(got.text.endsWith('"your reply" --no-wait)'));
});

test("cross-project long ask is stored whole in the inbox and typed as header + preview + pointer", async (t) => {
  const { db, orchestrator, writes, inbox } = await setup();
  t.after(() => db.close());
  const body = "BRIEF START " + CONTENT.shell(5_000) + " BRIEF END";
  const r = await orchestrator.ask(U, S1, S4, body, 10, false) as { delivery: { inboxId: string; mode: string } };
  const got = receive(writes.get(S4)!);
  assert.equal(r.delivery.mode, "inbox");
  assert.ok(got.text.startsWith("[Message from agent Sender (project p1, session " + S1 + ", hop 1)] BRIEF START"));
  assert.match(got.text, /floq inbox read [0-9a-f]{16}/);
  assert.ok(got.text.length < 900);
  assert.equal((await inbox.read(U, S4, r.delivery.inboxId)).body, body);
});

test("a body is never delivered tail-first: the typed message always begins with the header", async (t) => {
  const { db, orchestrator, writes } = await setup();
  t.after(() => db.close());
  await orchestrator.ask(U, S1, S2, CONTENT.plain(3_000), 10, false);
  const raw = writes.get(S2)!;
  assert.equal(raw[0], PASTE_START);
  assert.ok(raw[1].startsWith("[Message from agent Sender (session "));
});

test("concurrent asks to one receiver do not interleave their writes", async (t) => {
  const { db, orchestrator, writes } = await setup();
  t.after(() => db.close());
  const a = "A".repeat(900);
  const b = "B".repeat(900);
  await Promise.all([orchestrator.ask(U, S1, S2, a, 10, false), orchestrator.ask(U, S3, S2, b, 10, false)]);
  const all = writes.get(S2)!;
  const starts = all.map((w, i) => (w === PASTE_START ? i : -1)).filter((i) => i >= 0);
  assert.equal(starts.length, 2);
  const first = all.slice(starts[0], starts[1]).join("");
  assert.ok(first.endsWith("\r"), "the first message was fully submitted before the second began");
  assert.ok(!/A/.test(all.slice(starts[1]).join("")) || !/B/.test(first.replace(/Sender|Third/g, "")), "no mixed content");
});

// ---------- inbox access control and redaction ----------

test("inbox: only the receiving session of the same user can read; list is scoped; ids are validated", async (t) => {
  const { db, orchestrator, inbox } = await setup();
  t.after(() => db.close());
  const r = await orchestrator.ask(U, S1, S2, CONTENT.plain(4_000), 10, false) as { delivery: { inboxId: string } };
  const id = r.delivery.inboxId;
  assert.equal((await orchestrator.inboxRead(U, S2, id)).chars, 4_000);
  assert.equal((await orchestrator.inboxList(U, S2)).messages.length, 1);
  await assert.rejects(orchestrator.inboxRead(U, S1, id), /No such message/, "the sender cannot read the receiver's inbox");
  await assert.rejects(orchestrator.inboxRead(U, S3, id), /No such message/, "another agent of the same user cannot read it");
  await assert.rejects(orchestrator.inboxRead(U, S4, id), /No such message/, "an agent of another project cannot read it");
  await assert.rejects(inbox.read("u2", S2, id), /No such message/, "another user cannot read it");
  assert.deepEqual((await orchestrator.inboxList(U, S3)).messages, []);
  await assert.rejects(orchestrator.inboxRead(U, S2, "../../etc/passwd"), /inbox id/);
  await assert.rejects(orchestrator.inboxRead(U, S2, "0123456789abcdef"), /No such message/);
});

test("secret values are redacted from the typed preview, the stored body and inbox reads", async (t) => {
  const SECRET = "tok_live_SUPERSECRET";
  const secrets = { redact: async (_u: string, _ids: string[], text: string) => text.split(SECRET).join("[redacted]") };
  const { db, orchestrator, writes, pool } = await setup({ secrets });
  t.after(() => db.close());
  const body = SECRET + " " + CONTENT.plain(3_000) + " " + SECRET;
  const r = await orchestrator.ask(U, S1, S2, body, 10, false) as { delivery: { inboxId: string } };
  assert.ok(!writes.get(S2)!.join("").includes(SECRET));
  const stored = (await pool.query("SELECT body FROM agent_inbox WHERE id = $1", [r.delivery.inboxId])).rows[0].body as string;
  assert.ok(!stored.includes(SECRET) && stored.includes("[redacted]"));
  assert.ok(!(await orchestrator.inboxRead(U, S2, r.delivery.inboxId)).body.includes(SECRET));
});

test("inboxPointer previews the head and names the id and size", () => {
  const p = inboxPointer("HEAD " + "z".repeat(5000), "0123456789abcdef", 5005);
  assert.ok(p.startsWith("HEAD zzz"));
  assert.match(p, /5005 chars/);
  assert.match(p, /floq inbox read 0123456789abcdef/);
  assert.ok(p.length < 520);
});

// ---------- CLI: sender side ----------

test("messageSource: argv, stdin and file; long argv is refused with a clear error", () => {
  assert.deepEqual(messageSource(["A", "hello", "world"], {}), { kind: "argv", text: "hello world" });
  assert.deepEqual(messageSource(["A", "-"], {}), { kind: "stdin" });
  assert.deepEqual(messageSource(["A"], { file: "/tmp/x.md" }), { kind: "file", path: "/tmp/x.md" });
  assert.throws(() => messageSource(["A", "hi"], { file: "/tmp/x" }), /not both/);
  assert.throws(() => messageSource(["A"], { file: true }), /takes a path/);
  assert.throws(() => messageSource(["A", "x".repeat(MAX_ARGV_MESSAGE_CHARS + 1)], {}), /--file PATH/);
  assert.equal(messageSource(["A", "x".repeat(MAX_ARGV_MESSAGE_CHARS)], {}).kind, "argv");
});

test("formatDelivery prints a receipt for both modes", () => {
  assert.match(formatDelivery({ mode: "full", chars: 12, sha256: "abc" }), /^delivered 12 chars \(full/);
  assert.match(formatDelivery({ mode: "inbox", chars: 5000, sha256: "abc", inboxId: "0123456789abcdef" }), /delivered preview \+ inbox id 0123456789abcdef/);
  assert.equal(formatDelivery(undefined), "");
});

test("the CLI sends stdin and --file content byte for byte and prints the delivery receipt; long argv is refused", async (t) => {
  const FLOQ_IMG = fileURLToPath(new URL("../dist/image/floq.mjs", import.meta.url));
  const received: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: JSON.parse(data || "{}") });
      res.setHeader("content-type", "application/json");
      if (req.url === "/internal/agents/ask") res.end(JSON.stringify({ status: "sent", output: "", truncated: 0, delivery: { mode: "inbox", chars: 6000, sha256: "abcd", inboxId: "0123456789abcdef" } }));
      else res.end(JSON.stringify({ messages: [{ id: "0123456789abcdef", fromTitle: "A", fromId: S1, chars: 5, createdAt: "t" }], body: "full text", chars: 9, fromTitle: "A", from: S1 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "floq-msg-"));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = (args: string[], input = "") => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [FLOQ_IMG, ...args], { env: { PATH: process.env.PATH, FLOQ_API_URL: `http://127.0.0.1:${port}`, FLOQ_AGENT_TOKEN: "tok" } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  const text = "# Brief\n\nline `code` $(x) \"q\" 'q' 日本語 😀  \n" + "z".repeat(9_000);
  const viaStdin = await run(["ask", S2, "-", "--no-wait"], text + "\n");
  assert.equal(viaStdin.code, 0, viaStdin.stderr);
  assert.equal(received[0].body.prompt, text, "stdin text arrives intact (one trailing newline trimmed)");
  assert.match(viaStdin.stderr, /delivered preview \+ inbox id 0123456789abcdef/);
  const file = join(dir, "brief.md");
  writeFileSync(file, text);
  const viaFile = await run(["ask", S2, "--file", file, "--no-wait"]);
  assert.equal(viaFile.code, 0, viaFile.stderr);
  assert.equal(received[1].body.prompt, text);
  const tooLong = await run(["ask", S2, "x".repeat(MAX_ARGV_MESSAGE_CHARS + 10), "--no-wait"]);
  assert.equal(tooLong.code, 2);
  assert.match(tooLong.stderr, /--file PATH/);
  assert.equal(received.length, 2, "nothing was sent for the refused message");
  const read = await run(["inbox", "read", "0123456789abcdef"]);
  assert.equal(read.stdout.trim(), "full text");
  const list = await run(["inbox", "list"]);
  assert.match(list.stdout, /0123456789abcdef/);
});

// ---------- real PTY (raw mode) ----------

test("a real PTY in raw mode receives the bracketed paste frame and the exact text", { skip: process.platform === "win32" ? "ConPTY rewrites the stream; run on Linux/macOS" : false }, async (t) => {
  const child = `
    process.stdin.setRawMode(true); process.stdin.setEncoding("utf8"); process.stdout.write("\\x1b[?2004h");
    let buf = ""; process.stdin.on("data", (d) => { buf += d; if (buf.endsWith("\\r")) { require("fs").writeFileSync(process.argv[1], buf); process.exit(0); } });
  `;
  const dir = mkdtempSync(join(tmpdir(), "floq-pty-"));
  const out = join(dir, "got.txt");
  let pty;
  try {
    pty = spawnPty(process.execPath, ["-e", child, out], { name: "xterm-256color", cols: 100, rows: 30, cwd: dir, env: process.env as Record<string, string> });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    t.skip("node-pty unavailable here: " + (error instanceof Error ? error.message : String(error)));
    return;
  }
  t.after(() => { try { pty.kill(); } catch { /* gone */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* busy */ } });
  let seen = "";
  pty.onData((d) => { seen += d; });
  const exited = new Promise<void>((r) => pty.onExit(() => r()));
  for (let i = 0; i < 100 && !seen.includes("?2004h"); i++) await new Promise((r) => setTimeout(r, 50));
  if (!seen.includes("?2004h")) { t.skip("child did not start in this PTY"); return; }
  const text = "[Message from agent X] " + CONTENT.shell(1_400) + " tail 😀";
  await typeMessage((d) => pty.write(d), text, { bracketed: true });
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  const { readFileSync } = await import("node:fs");
  const got = readFileSync(out, "utf8");
  assert.equal(got, PASTE_START + sanitizeForTerminal(text) + PASTE_END + "\r");
});
