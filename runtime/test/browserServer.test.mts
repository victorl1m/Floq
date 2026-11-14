import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { BrowserService } from "../dist/browser.js";
import { createRuntimeServer } from "../dist/server.js";
import { Vault } from "../dist/vault.js";

const key = Buffer.alloc(32, 9);
const TID = "C711BB681855D07964DB653782FFBE88";
const ORIGIN = "https://app.test";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await wait(5); } };
const freePort = () => new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const TOKENS = { "tok-alice": "alice", "tok-bob": "bob" };

function fakeDaemon(user) {
  const c = new EventEmitter();
  c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.user = user; c.received = [];
  let buf = "";
  c.stdin.on("data", (d) => { buf += d.toString(); for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); c.received.push(m); if (m.type === "page.open") setImmediate(() => c.emitOut({ type: "page", nodeId: m.nodeId, targetId: TID, created: true })); if (m.type === "shutdown") { c.stdout.end(); c.emit("exit", 0, null); } } });
  c.emitOut = (m) => c.stdout.write(JSON.stringify(m) + "\n");
  c.kill = () => { c.stdout.end(); c.emit("exit", null, "SIGKILL"); return true; };
  setImmediate(() => c.emitOut({ type: "ready", port: user === "alice" ? 40001 : 40002, token: (user === "alice" ? "a" : "b").repeat(64), pid: 1, sandbox: "on" }));
  return c;
}

async function harness(t, { version = { chromium: "157.0.8103.15", revision: "1252", playwrightMcp: "0.0.84" }, mode = "auto" } = {}) {
  const state = { children: [], prefs: { alice: true, bob: true }, mcp: [], rm: 0 };
  const shards = {
    awakeHandle: (u) => ({ userId: u, uid: u === "alice" ? 1 : 2, mountPath: "/m/" + u }),
    wake: async (u) => ({ userId: u, uid: 1, mountPath: "/m/" + u }),
    driver: {
      hostPath: () => "",
      spawnPipe: (h, spec) => {
        if (spec.file === "rm" || spec.file === "du") { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true; setImmediate(() => { state.rm++; c.emit("exit", 0); }); return c; }
        const c = fakeDaemon(h.userId); state.children.push(c); return c;
      },
    },
  };
  const settingsPort = { agentBrowser: async (u) => state.prefs[u] !== false };
  const browser = new BrowserService(shards, settingsPort, { sync: async (u, desired) => { state.mcp.push([u, desired]); return { claude: "unchanged", codex: "unchanged" }; } }, { mode, idleMs: 0, memMb: 0, allowPrivate: false, browsersDir: "/x", version, stopWaitMs: 100, startTimeoutMs: 1000 }, () => false);
  const pool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error("unused"); } };
  const vault = new Vault(pool, { encryptionKey: key });
  const auth = { handler() {}, api: { getSession: async ({ headers }) => { const user = TOKENS[(headers.get("authorization") ?? "").replace("Bearer ", "")]; return user ? { user: { id: user }, session: { id: "s-" + user } } : null; } } };
  const settings = {
    async profile() { return {}; },
    async get(u) { return { agentBrowser: state.prefs[u] !== false }; },
    async update(u, body) { if (body.agentBrowser !== undefined) state.prefs[u] = body.agentBrowser; return { agentBrowser: state.prefs[u] !== false }; },
  };
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [ORIGIN], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y", providers: { claude: "claude", codex: "codex", shell: "bash" }, codexModelsOverridden: true, models: { claude: [], codex: [] }, authSecret: "x".repeat(40) };
  const manager = { activeCount: 0, getLive() { throw new Error("gone"); }, findLive: () => undefined };
  const server = createRuntimeServer({ config, manager, auth, settings, github: {}, vault, orchestrator: {}, pool, credentials: {}, claudeOauth: {}, usage: {}, claudeConnectors: {}, skills: {}, gitReview: {}, browser });
  await server.listen();
  t.after(async () => { await browser.shutdown(); await server.close(); });
  const http = async (token, method, path, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : {} };
  };
  const agent = (user, path, body = {}) => http(vault.issueToken(user, "sess-" + user), "POST", "/internal/" + path, body);
  /** Opens the stream; resolves with the socket and the messages it has seen, or with the HTTP status of a refused upgrade. */
  const open = (query, { origin = ORIGIN, headers = {} } = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/browser/stream${query}`, { headers: { ...(origin ? { Origin: origin } : {}), ...headers } });
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve({ ws, msgs, status: 101 }));
    ws.on("unexpected-response", (_req, res) => { resolve({ status: res.statusCode }); res.resume(); });
    ws.on("error", () => undefined);
  });
  return { http, agent, open, state, browser, port };
}

test("the stream refuses a missing or wrong token and any origin that is not allowed", async (t) => {
  const { open, state } = await harness(t);
  assert.equal((await open("")).status, 401, "no token");
  assert.equal((await open("?token=nope")).status, 401, "wrong token");
  assert.equal((await open("?token=tok-alice", { origin: "https://evil.test" })).status, 403, "foreign origin");
  assert.equal((await open("?token=tok-alice", { origin: "null" })).status, 403);
  assert.equal(state.children.length, 0, "a refused socket never starts a browser");
  const ok = await open("?token=tok-alice");
  assert.equal(ok.status, 101);
  ok.ws.close();
  // The bearer header works like the other sockets; no Origin (a native client) is allowed.
  const viaHeader = await open("", { origin: null, headers: { Authorization: "Bearer tok-bob" } });
  assert.equal(viaHeader.status, 101);
  viaHeader.ws.close();
});

test("a socket always belongs to the token's own user: it cannot be pointed at another user's browser", async (t) => {
  const { open, state, agent } = await harness(t);
  const alice = await open("?token=tok-alice&user=bob&userId=bob&user_id=bob");
  const bob = await open("?token=tok-bob");
  await until(() => alice.msgs.some((m) => m.type === "state" && m.state === "running") && bob.msgs.some((m) => m.type === "state" && m.state === "running"));
  assert.deepEqual(state.children.map((c) => c.user).sort(), ["alice", "bob"], "one daemon each, started in each user's own sandbox");
  const aliceDaemon = state.children.find((c) => c.user === "alice");
  aliceDaemon.emitOut({ type: "nav", targetId: TID, title: "alice secret tab", url: "https://alice.test/", loading: false, canBack: false, canForward: false });
  aliceDaemon.emitOut({ type: "frame", n: 1, targetId: TID, jpeg: "QQ==", w: 10, h: 10, scale: 1 });
  await until(() => alice.msgs.some((m) => m.type === "nav"));
  await wait(50);
  assert.ok(!JSON.stringify(bob.msgs).includes("alice secret tab"), "bob never sees alice's tabs");
  // Bob's input only ever reaches bob's daemon.
  bob.ws.send(JSON.stringify({ type: "nav.go", targetId: TID, url: "https://bob.test/" }));
  await until(() => state.children.find((c) => c.user === "bob").received.some((m) => m.type === "nav.go"));
  assert.ok(!aliceDaemon.received.some((m) => m.type === "nav.go"));
  // Each agent gets only its own user's endpoint.
  const a = await agent("alice", "browser/ensure"), b = await agent("bob", "browser/ensure");
  assert.match(a.json.wsEndpoint, /^ws:\/\/127\.0\.0\.1:40001\/devtools\/browser(\?agent=[\w-]+)?$/);
  assert.match(b.json.wsEndpoint, /^ws:\/\/127\.0\.0\.1:40002\/devtools\/browser(\?agent=[\w-]+)?$/);
  assert.notEqual(a.json.token, b.json.token);
  alice.ws.close(); bob.ws.close();
});

test("the relay validates what the app sends: bad URLs, unknown messages and raw CDP never reach the daemon", async (t) => {
  const { open, state } = await harness(t);
  const v = await open("?token=tok-alice");
  await until(() => v.msgs.some((m) => m.type === "state" && m.state === "running"));
  const daemon = state.children[0];
  // Sent straight after the upgrade: queued until the attach finishes, none lost.
  for (const m of [
    { type: "nav.go", targetId: TID, url: "javascript:alert(1)" },
    { type: "Runtime.evaluate", expression: "1" },
    { type: "frame.ack", n: 9 }, { type: "shutdown" },
    { type: "nav.go", url: "https://ok.test/" },
  ]) v.ws.send(JSON.stringify(m));
  v.ws.send(Buffer.from([1, 2, 3]));
  v.ws.send("not json");
  await until(() => v.msgs.filter((m) => m.type === "error").length >= 5);
  assert.deepEqual(v.msgs.filter((m) => m.type === "error").map((m) => m.code), ["bad_url", "bad_message", "bad_message", "bad_message", "bad_json"]);
  assert.deepEqual(daemon.received.filter((m) => m.type !== "hello" && m.type !== "page.open"), [{ type: "nav.go", targetId: TID, url: "https://ok.test/" }]);
  assert.equal(daemon.received.some((m) => m.type === "shutdown"), false);
  v.ws.close();
});

test("a viewer connecting before the shard is awake starts the browser; closing the socket drops the viewer", async (t) => {
  const { open, browser } = await harness(t);
  const v = await open("?token=tok-alice");
  await until(() => browser.viewerCount("alice") === 1);
  v.ws.close();
  await until(() => browser.viewerCount("alice") === 0);
});

test("GET /v1/browser has the shape the canvas expects, and needs a real session", async (t) => {
  const { http, open, browser } = await harness(t);
  assert.equal((await http("", "GET", "/v1/browser")).status, 401);
  assert.equal((await http("garbage", "GET", "/v1/browser")).status, 401);
  const idle = await http("tok-alice", "GET", "/v1/browser");
  assert.equal(idle.status, 200);
  assert.equal(idle.json.state, "stopped");
  assert.deepEqual(idle.json.version, { chromium: "157.0.8103.15", revision: "1252", playwrightMcp: "0.0.84" });
  assert.equal(idle.json.profile, "~/.floq/browser/profile");
  assert.equal(idle.json.agents, 0);
  const v = await open("?token=tok-alice");
  await until(() => v.msgs.some((m) => m.state === "running"));
  const running = await http("tok-alice", "GET", "/v1/browser");
  assert.equal(running.json.state, "running");
  assert.equal(typeof running.json.tabs, "number");
  assert.ok(!JSON.stringify(running.json).includes("a".repeat(64)), "the token is never in a status");
  assert.equal((await http("tok-bob", "GET", "/v1/browser")).json.state, "stopped", "bob's status is bob's own");
  v.ws.close();
  assert.equal(browser.capability(), "available");
});

test("restart and clear-data: restart needs a session, clear-data needs the typed confirmation", async (t) => {
  const { http, state } = await harness(t);
  assert.equal((await http("", "POST", "/v1/browser/restart", {})).status, 401);
  const restarted = await http("tok-alice", "POST", "/v1/browser/restart", {});
  assert.equal(restarted.status, 200);
  assert.equal(restarted.json.state, "running");
  assert.equal((await http("tok-alice", "POST", "/v1/browser/clear-data", {})).status, 400);
  assert.equal((await http("tok-alice", "POST", "/v1/browser/clear-data", { confirm: "yes" })).json.error.code, "confirm_required");
  assert.equal(state.rm, 0, "nothing was removed without the confirmation");
  const cleared = await http("tok-alice", "POST", "/v1/browser/clear-data", { confirm: "clear" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.state, "stopped");
  assert.equal(state.rm, 1);
  assert.equal((await http("", "POST", "/v1/browser/clear-data", { confirm: "clear" })).status, 401);
});

test("internal routes: ensure/status/restart work for the calling agent's user; disabled answers 403 from ensure and 200 from status", async (t) => {
  const { agent, http, state } = await harness(t);
  assert.equal((await http("", "POST", "/internal/browser/ensure", {})).status, 401);
  const ensured = await agent("alice", "browser/ensure");
  assert.equal(ensured.status, 200);
  assert.match(ensured.json.wsEndpoint, /^ws:\/\/127\.0\.0\.1:40001\/devtools\/browser(\?agent=[\w-]+)?$/);
  assert.match(ensured.json.token, /^[0-9a-f]{64}$/);
  assert.notEqual(ensured.json.token, "a".repeat(64), "never the daemon-wide token");
  const status = await agent("alice", "browser/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.state, "running");
  assert.equal(status.json.pid, 1);
  assert.equal(typeof status.json.uptimeSec, "number");
  assert.match(status.json.sandbox, /chromium sandbox on/);
  assert.equal((await agent("alice", "browser/restart")).json.state, "running");
  assert.equal(state.children.length, 2);

  state.prefs.alice = false;
  const off = await agent("alice", "browser/ensure");
  assert.equal(off.status, 403);
  assert.equal(off.json.error.code, "disabled");
  const offStatus = await agent("alice", "browser/status");
  assert.equal(offStatus.status, 200, "floq browser status must be able to print 'disabled'");
  assert.equal(offStatus.json.state, "disabled");
});

test("a missing browser (older image) answers unavailable everywhere and the stream says so", async (t) => {
  const { agent, http, open } = await harness(t, { version: null });
  assert.equal((await agent("alice", "browser/status")).json.state, "unavailable");
  const e = await agent("alice", "browser/ensure");
  assert.equal(e.status, 503);
  assert.equal(e.json.error.code, "unavailable");
  assert.equal((await http("tok-alice", "GET", "/v1/browser")).json.state, "unavailable");
  const v = await open("?token=tok-alice");
  await until(() => v.msgs.length > 0);
  assert.deepEqual(v.msgs, [{ type: "state", state: "unavailable" }]);
  v.ws.close();
});

test("turning the toggle off over PATCH /v1/settings stops the user's browser and syncs the MCP entry; other users are untouched", async (t) => {
  const { http, open, state } = await harness(t);
  const a = await open("?token=tok-alice"), b = await open("?token=tok-bob");
  await until(() => state.children.length === 2);
  await until(() => a.msgs.some((m) => m.state === "running") && b.msgs.some((m) => m.state === "running"));
  const patched = await http("tok-alice", "PATCH", "/v1/settings", { agentBrowser: false });
  assert.equal(patched.status, 200);
  await until(() => state.mcp.some(([u, d]) => u === "alice" && d === false));
  await until(() => a.msgs.some((m) => m.state === "stopped"));
  assert.ok(state.children.find((c) => c.user === "alice").received.some((m) => m.type === "shutdown"));
  assert.equal(state.children.find((c) => c.user === "bob").received.some((m) => m.type === "shutdown"), false);
  assert.equal(b.msgs.at(-1).type === "state" ? b.msgs.at(-1).state : "running", "running");
  a.ws.close(); b.ws.close();
});

test("/v1/info advertises the browser capability", async (t) => {
  const { http } = await harness(t);
  const info = await http("tok-alice", "GET", "/v1/info");
  assert.equal(info.json.server.browser, "available");
  assert.ok(info.json.server.capabilities.includes("agent-browser"));
  assert.ok(info.json.server.capabilities.includes("branch-switch-v2"));
});
