import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const VAULT = fileURLToPath(new URL("../dist/image/floq-vault.mjs", import.meta.url));
const ECHO = fileURLToPath(new URL("./mcpEchoServer.mts", import.meta.url));
const TOKEN = "tok-wrapper-test";
const SECRETS = { MY_SERVER_API_KEY: "fake-secret-VALUE-123", MY_SERVER_OTHER: "fake-other-VALUE-456", NOT_REQUESTED: "never-asked-for-789" };

async function fakeRuntime(t, secrets = SECRETS) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ auth: req.headers.authorization, path: req.url, body: JSON.parse(body || "{}") });
      if (req.headers.authorization !== "Bearer " + TOKEN) { res.writeHead(401); return res.end("{}"); }
      const names = JSON.parse(body).names ?? Object.keys(secrets);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ secrets: Object.fromEntries(names.filter((n) => n in secrets).map((n) => [n, secrets[n]])) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

function run(rt, args, { env = {} } = {}) {
  const child = spawn(process.execPath, [VAULT, ...args], { env: { PATH: process.env.PATH, FLOQ_API_URL: rt.url, FLOQ_AGENT_TOKEN: TOKEN, ...env } });
  const out = { stdout: [], stderr: "", exit: null };
  child.stdout.on("data", (c) => out.stdout.push(c));
  child.stderr.on("data", (c) => { out.stderr += c; });
  out.done = new Promise((resolve) => child.on("close", (code) => { out.exit = code; resolve(out); }));
  out.child = child;
  return out;
}

/** Reads newline-delimited JSON frames from a child's stdout as they arrive. */
function frames(child) {
  const waiting = [];
  const ready = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let i;
    while ((i = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, i);
      buffer = buffer.subarray(i + 1);
      const frame = { text: line.toString("utf8"), message: JSON.parse(line.toString("utf8")) };
      (waiting.shift() ?? ((f) => ready.push(f)))(frame);
    }
  });
  return (ms = 4000) => ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame within " + ms + " ms")), ms);
    waiting.push((f) => { clearTimeout(timer); resolve(f); });
  });
}

const wrapperArgs = (extra = []) => ["run", "--stdio", "--only", "MY_SERVER_API_KEY", "--map", "TEST_SECRET=MY_SERVER_API_KEY", ...extra, "--", process.execPath, "--import", "tsx", ECHO];
const line = (obj) => JSON.stringify(obj) + "\n";

test("a JSON-RPC exchange passes through byte for byte, including a 3 MB frame, and small frames are not delayed", async (t) => {
  const rt = await fakeRuntime(t);
  const wrapper = run(rt, wrapperArgs());
  const next = frames(wrapper.child);

  // small frame: the answer must come back at once, without waiting for more output (the stdio mode has no hold-back buffer)
  const started = Date.now();
  const first = line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", note: "unicode: café ☃ 🚀" } });
  wrapper.child.stdin.write(first);
  const reply = await next();
  assert.ok(Date.now() - started < 2000, "small frame answered promptly");
  assert.equal(reply.message.result.sha256, createHash("sha256").update(first.slice(0, -1)).digest("hex"), "server saw exactly the bytes sent");
  assert.equal(reply.message.result.bytes, Buffer.byteLength(first) - 1);

  // large request frame (3 MB) and large response frame, written in pieces to cross pipe buffer boundaries
  const big = line({ jsonrpc: "2.0", id: 2, method: "big", params: { blob: "0123456789abcdef".repeat(200_000), size: 2_000_000 } });
  for (let i = 0; i < big.length; i += 65_536) wrapper.child.stdin.write(big.slice(i, i + 65_536));
  const bigReply = await next(15000);
  assert.equal(bigReply.message.result.sha256, createHash("sha256").update(big.slice(0, -1)).digest("hex"));
  assert.equal(bigReply.message.result.echo.length, 2_000_000);
  assert.equal(bigReply.message.id, 2);

  // many frames in one write come back in order
  wrapper.child.stdin.write([3, 4, 5, 6].map((id) => line({ jsonrpc: "2.0", id, method: "ping" })).join(""));
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await next()).message.id);
  assert.deepEqual(ids, [3, 4, 5, 6]);

  // closing stdin reaches the server, which exits, and the wrapper exits cleanly
  wrapper.child.stdin.end();
  await wrapper.done;
  assert.equal(wrapper.exit, 0);
});

test("the server gets the secret under the mapped name, never sees the session token, and the wrapper asked for exactly the --only names", async (t) => {
  const rt = await fakeRuntime(t);
  const wrapper = run(rt, ["run", "--stdio", "--only", "MY_SERVER_API_KEY,MY_SERVER_OTHER", "--map", "TEST_SECRET=MY_SERVER_API_KEY", "--map", "OTHER_SECRET=MY_SERVER_OTHER", "--", process.execPath, "--import", "tsx", ECHO]);
  const next = frames(wrapper.child);
  wrapper.child.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "ping" }));
  const { message } = await next();
  assert.equal(message.result.testSecret, SECRETS.MY_SERVER_API_KEY);
  assert.equal(message.result.other, SECRETS.MY_SERVER_OTHER);
  assert.equal(message.result.floqToken, "", "the child does not inherit the session token");
  wrapper.child.stdin.end();
  await wrapper.done;
  assert.equal(rt.calls.length, 1);
  assert.deepEqual(rt.calls[0].body, { names: ["MY_SERVER_API_KEY", "MY_SERVER_OTHER"] });
  assert.equal(rt.calls[0].auth, "Bearer " + TOKEN);
});

test("a name outside --only, a malformed --map and a missing --only are refused before anything is launched", async (t) => {
  const rt = await fakeRuntime(t);
  for (const args of [
    ["run", "--stdio", "--only", "MY_SERVER_API_KEY", "--map", "X=NOT_REQUESTED", "--", process.execPath, "-e", "0"],
    ["run", "--stdio", "--only", "MY_SERVER_API_KEY", "--map", "bad name=MY_SERVER_API_KEY", "--", process.execPath, "-e", "0"],
    ["run", "--stdio", "--map", "X=MY_SERVER_API_KEY", "--", process.execPath, "-e", "0"],
    ["run", "--stdio", "--only", "lowercase", "--", process.execPath, "-e", "0"],
  ]) {
    const result = await run(rt, args).done;
    assert.equal(result.exit, 2, args.join(" "));
  }
  assert.equal(rt.calls.length, 0, "no vault request was made");
});

test("a deleted or renamed secret fails with a clear message and the server never starts", async (t) => {
  const rt = await fakeRuntime(t, { OTHER: "x-y-z-123" });
  const wrapper = run(rt, wrapperArgs());
  const result = await wrapper.done;
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /secret MY_SERVER_API_KEY was not found.*renamed or deleted in Floq > Secrets/);
  assert.equal(Buffer.concat(result.stdout).length, 0, "nothing was written to the protocol stream");
});

test("stdout is not rewritten, but the server's stderr is redacted line by line", async (t) => {
  const rt = await fakeRuntime(t);
  const wrapper = run(rt, wrapperArgs());
  const next = frames(wrapper.child);
  wrapper.child.stdin.write(line({ jsonrpc: "2.0", id: 1, method: "stderr" }));
  const { text, message } = await next();
  assert.equal(message.result.testSecret, SECRETS.MY_SERVER_API_KEY, "stdout frames are never rewritten");
  assert.ok(text.includes(SECRETS.MY_SERVER_API_KEY));
  wrapper.child.stdin.end();
  const result = await wrapper.done;
  assert.match(result.stderr, /server says \[REDACTED\]/);
  assert.ok(!result.stderr.includes(SECRETS.MY_SERVER_API_KEY));
});

test("an invalid session token is refused and the child is not started", async (t) => {
  const rt = await fakeRuntime(t);
  const result = await run(rt, wrapperArgs(), { env: { FLOQ_AGENT_TOKEN: "wrong" } }).done;
  assert.equal(result.exit, 1);
  assert.match(result.stderr, /request failed \(401\)/);
});

test("floq-vault headers resolves placeholders only for the named Claude Code MCP server", async (t) => {
  const rt = await fakeRuntime(t);
  const spec = Buffer.from(JSON.stringify({ Authorization: "Bearer {{MY_SERVER_API_KEY}}", "X-Other": "{{MY_SERVER_OTHER}}" })).toString("base64url");
  const ok = await run(rt, ["headers", "--server", "web", "--spec", spec], { env: { CLAUDE_CODE_MCP_SERVER_NAME: "web" } }).done;
  assert.equal(ok.exit, 0, ok.stderr);
  assert.deepEqual(JSON.parse(Buffer.concat(ok.stdout).toString()), { Authorization: "Bearer " + SECRETS.MY_SERVER_API_KEY, "X-Other": SECRETS.MY_SERVER_OTHER });
  assert.deepEqual(rt.calls[0].body.names.sort(), ["MY_SERVER_API_KEY", "MY_SERVER_OTHER"]);
  const callsBefore = rt.calls.length;
  assert.equal((await run(rt, ["headers", "--server", "web", "--spec", spec]).done).exit, 2, "refused outside Claude Code's helper call");
  assert.equal((await run(rt, ["headers", "--server", "web", "--spec", spec], { env: { CLAUDE_CODE_MCP_SERVER_NAME: "other" } }).done).exit, 2);
  assert.equal((await run(rt, ["headers", "--server", "web", "--spec", "!!!"], { env: { CLAUDE_CODE_MCP_SERVER_NAME: "web" } }).done).exit, 2);
  assert.equal(rt.calls.length, callsBefore, "refused calls never reach the vault");
  const gone = await fakeRuntime(t, {});
  const missing = await run(gone, ["headers", "--server", "web", "--spec", spec], { env: { CLAUDE_CODE_MCP_SERVER_NAME: "web" } }).done;
  assert.equal(missing.exit, 1);
  assert.match(missing.stderr, /was not found/);
});

test("without Floq session credentials the wrapper explains itself instead of running the server", async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [VAULT, ...wrapperArgs()], { env: { PATH: process.env.PATH } });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /not available in this session/);
});
