import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BrowserService, PROFILE_DIR, agentToken } from "../dist/browser.js";

const TOKEN = "t".repeat(64);
const TID = "C711BB681855D07964DB653782FFBE88";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await wait(5); } };

/** A stand-in for floq-browserd behind spawnPipe: JSON lines in on stdin, JSON lines out on stdout. */
function fakeDaemon({ ready = true, ignoreShutdown = false, port = 40111, token = TOKEN } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.received = [];
  child.killed = [];
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      const msg = JSON.parse(line);
      child.received.push(msg);
      // One page per Browser node: answer page.open like the real daemon (node "main" gets TID, others a padded id).
      if (msg.type === "page.open") setImmediate(() => child.emitOut({ type: "page", nodeId: msg.nodeId, targetId: msg.nodeId === "main" ? TID : ("N" + msg.nodeId).padEnd(32, "0"), created: true }));
      if (msg.type === "shutdown" && !ignoreShutdown) child.die(0);
    }
  });
  child.emitOut = (msg) => child.stdout.write(JSON.stringify(msg) + "\n");
  child.die = (code = 0, signal = null) => { child.stdout.end(); child.emit("exit", code, signal); };
  child.kill = (sig) => { child.killed.push(sig); setImmediate(() => child.die(null, sig)); return true; };
  if (ready) setImmediate(() => child.emitOut({ type: "ready", port, token, pid: 4242, chromium: "157.0.8103.15", sandbox: "off", sandboxReason: "no userns" }));
  return child;
}

function harness({ awake = true, enabled = true, mode = "auto", version = { chromium: "157.0.8103.15", revision: "1252", playwrightMcp: "0.0.84" }, daemon = {}, ...options } = {}) {
  const state = { awake, enabled, spawns: [], children: [], wakes: 0, activity: [], mcpCalls: [], rm: { code: 0 } };
  const handle = { userId: "alice", uid: 20001, mountPath: "/mnt/alice" };
  const shards = {
    awakeHandle: () => (state.awake ? handle : undefined),
    wake: async () => { state.wakes++; state.awake = true; return handle; },
    driver: {
      hostPath: (_h, p) => "/mnt/alice/" + p,
      spawnPipe: (_h, spec) => {
        state.spawns.push(spec);
        if (spec.file === "rm" || spec.file === "du") {
          const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true;
          setImmediate(() => { if (spec.file === "du") c.stdout.write("4096\t.floq/browser/profile\n"); c.emit("exit", state.rm.code); });
          return c;
        }
        const c = fakeDaemon(typeof daemon === "function" ? daemon(state.children.length) : daemon);
        state.children.push(c);
        return c;
      },
    },
  };
  const settings = { agentBrowser: async () => state.enabled };
  const mcp = { sync: async (userId, desired) => { state.mcpCalls.push([userId, desired]); return { claude: "unchanged", codex: "unchanged" }; } };
  const service = new BrowserService(shards, settings, mcp, { mode, idleMs: 10 * 60_000, memMb: 0, allowPrivate: false, browsersDir: "/nonexistent", version, startTimeoutMs: 500, stopWaitMs: 60, ackRetryMs: 10, ...options }, () => false);
  service.onActivity = (userId, running) => state.activity.push([userId, running]);
  return { service, state };
}

const bound = (s) => until(() => s.msgs("page").length > 0);

/** A viewer socket: records everything the service sends and lets a test control bufferedAmount. */
function sink() {
  const s = { texts: [], buffered: 0, closed: false };
  s.send = (t) => s.texts.push(t);
  s.bufferedAmount = () => s.buffered;
  s.close = () => { s.closed = true; };
  s.msgs = (type) => s.texts.map((t) => JSON.parse(t)).filter((m) => !type || m.type === type);
  return s;
}

test("refuses to start without a shard handle: nothing is ever spawned on the host", async () => {
  const { service, state } = harness({ awake: false });
  await assert.rejects(() => service.ensure("alice"), (e) => e.status === 503 && e.code === "sandbox_unavailable");
  assert.equal(state.spawns.length, 0);
  // A viewer opening the node may wake the shard; an agent's ensure may not.
  await service.ensure("alice", { wake: true });
  assert.equal(state.wakes, 1);
  assert.equal(state.spawns.length, 1);
  await service.shutdown();
});

test("ensure spawns the daemon in the sandbox with a stdin pipe, shares one start, and hands the endpoint to the agent only", async () => {
  const { service, state } = harness();
  const [a, b] = await Promise.all([service.ensure("alice"), service.ensure("alice")]);
  assert.equal(state.spawns.length, 1, "concurrent ensure calls share one daemon");
  const spec = state.spawns[0];
  assert.equal(spec.file, "/usr/local/bin/floq-browserd");
  assert.equal(spec.stdin, true);
  assert.equal(spec.cwd, ".");
  assert.equal(spec.env.FLOQ_BROWSER_BLOCK_PRIVATE, "1", "no netns and no allowPrivate: the daemon blocks private ranges itself");
  assert.equal(spec.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1");
  assert.equal(spec.env.FLOQ_BROWSER_MEM_MB, undefined, "address-space cap is opt-in");
  assert.deepEqual(a, b);
  assert.equal(a.wsEndpoint, "ws://127.0.0.1:40111/devtools/browser?agent=floq-runtime-helper");
  assert.equal(a.token, agentToken(TOKEN, "floq-runtime-helper"));
  assert.notEqual(a.token, TOKEN, "the daemon-wide token never leaves the runtime");
  const one = await service.ensure("alice", { agentId: "11111111-1111-1111-1111-111111111111" });
  const two = await service.ensure("alice", { agentId: "22222222-2222-2222-2222-222222222222" });
  assert.notEqual(one.token, two.token, "each agent gets its own token");
  assert.equal(one.token, agentToken(TOKEN, "11111111-1111-1111-1111-111111111111"));
  assert.match(one.wsEndpoint, /\?agent=11111111-1111-1111-1111-111111111111$/);
  assert.deepEqual(state.activity, [["alice", true]]);
  const status = await service.status("alice");
  assert.equal(status.state, "running");
  assert.equal(status.pid, 4242);
  assert.match(status.sandbox, /^off \(no userns/);
  assert.ok(!JSON.stringify(status).includes(TOKEN), "status never carries the token");
  await service.shutdown();
});

test("netns and allowPrivate drop the private-range blocker; memMb is passed through when set", async () => {
  const h = harness({ memMb: 3072 });
  const viaNetns = new BrowserService({ ...{ awakeHandle: () => ({ userId: "alice", uid: 1, mountPath: "/m" }), wake: async () => ({}), driver: { hostPath: () => "", spawnPipe: (_h, spec) => { h.state.spawns.push(spec); const c = fakeDaemon(); h.state.children.push(c); return c; } } } }, { agentBrowser: async () => true }, null, { mode: "on", idleMs: 0, memMb: 3072, allowPrivate: false, browsersDir: "/x", version: { chromium: "1", revision: "1", playwrightMcp: "1" } }, () => true);
  await viaNetns.ensure("alice");
  assert.equal(h.state.spawns[0].env.FLOQ_BROWSER_BLOCK_PRIVATE, undefined);
  assert.equal(h.state.spawns[0].env.FLOQ_BROWSER_MEM_MB, "3072");
  await viaNetns.shutdown();
  const allow = harness({ allowPrivate: true });
  await allow.service.ensure("alice");
  assert.equal(allow.state.spawns[0].env.FLOQ_BROWSER_BLOCK_PRIVATE, undefined);
  await allow.service.shutdown();
});

test("with a per-user netns the daemon is spawned inside the sandbox and the endpoint stays on that sandbox's own loopback (no gateway, no host loopback)", async () => {
  const seen = [];
  const svc = new BrowserService({ awakeHandle: () => ({ userId: "alice", uid: 1, mountPath: "/m", netns: "/run/floq/netns/1" }), wake: async () => ({}), driver: { hostPath: () => "", spawnPipe: (h, spec) => { seen.push([h, spec]); return fakeDaemon(); } } }, { agentBrowser: async () => true }, null, { mode: "on", idleMs: 0, memMb: 0, allowPrivate: false, browsersDir: "/x", version: { chromium: "1", revision: "1", playwrightMcp: "1" } }, () => true);
  const e = await svc.ensure("alice");
  assert.equal(seen.length, 1, "launched through the shard driver (inside the tenant namespace), never by the runtime itself");
  assert.equal(seen[0][0].netns, "/run/floq/netns/1");
  // pasta no longer mirrors the runtime container's loopback (-T none -U none): the MCP wrapper reaches the daemon only because both
  // live in the same tenant namespace, so the endpoint must be 127.0.0.1 and must not name the gateway.
  assert.match(e.wsEndpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\?agent=/);
  await svc.shutdown();
});

test("admin off, user off and a missing browser each refuse with the right state", async () => {
  const off = harness({ mode: "off" });
  assert.equal(off.service.capability(), "disabled");
  assert.equal(await off.service.state("alice"), "disabled");
  await assert.rejects(() => off.service.ensure("alice"), (e) => e.status === 403 && e.code === "disabled");

  const missing = harness({ version: null });
  assert.equal(missing.service.capability(), "missing");
  assert.equal(await missing.service.state("alice"), "unavailable");
  await assert.rejects(() => missing.service.ensure("alice"), (e) => e.status === 503 && e.code === "unavailable");

  const user = harness({ enabled: false });
  assert.equal(user.service.capability(), "available");
  assert.equal(await user.service.state("alice"), "disabled");
  await assert.rejects(() => user.service.ensure("alice"), (e) => e.code === "disabled");
  assert.equal(user.state.spawns.length, 0);
  // A viewer of a disabled/unavailable browser only learns the state.
  const s = sink();
  await user.service.attachViewer("alice", s);
  assert.deepEqual(s.msgs(), [{ type: "state", state: "disabled" }]);
  const m = sink();
  await missing.service.attachViewer("alice", m);
  assert.deepEqual(m.msgs(), [{ type: "state", state: "unavailable" }]);
});

test("a daemon that never says ready is abandoned, and a start failure leaves the state stopped", async () => {
  const { service, state } = harness({ daemon: { ready: false }, startTimeoutMs: 60 });
  await assert.rejects(() => service.ensure("alice"), (e) => e.code === "browser_start_timeout");
  assert.equal(await service.state("alice"), "stopped");
  assert.deepEqual(state.children[0].killed, ["SIGKILL"]);
});

test("idle: stops after idleMs with no viewer and no agent, but not while a viewer is attached", async () => {
  const { service, state } = harness({ idleMs: 60 });
  await service.ensure("alice");
  const s = sink();
  const viewer = await service.attachViewer("alice", s);
  await wait(150);
  assert.equal(await service.state("alice"), "running", "a viewer keeps it alive");
  viewer.close();
  await until(() => state.children[0].received.some((m) => m.type === "shutdown"));
  await wait(30);
  assert.equal(await service.state("alice"), "stopped");
  assert.deepEqual(state.activity.at(-1), ["alice", false]);
});

test("idle: an agent connection keeps it alive until agentStaleMs after its last activity", async () => {
  const { service, state } = harness({ idleMs: 40, agentStaleMs: 200 });
  await service.ensure("alice");
  state.children[0].emitOut({ type: "clients", agents: 1 });
  await wait(120);
  assert.equal(await service.state("alice"), "running", "connected agent: not idle after idleMs");
  await until(() => state.children[0].received.some((m) => m.type === "shutdown"), 1500);
  assert.equal(state.children[0].received.some((m) => m.type === "shutdown"), true, "stale connection stops after agentStaleMs");
});

test("stop sends shutdown and resolves only after the process is gone; a daemon that ignores it is SIGKILLed", async () => {
  const clean = harness();
  await clean.service.ensure("alice");
  const order = [];
  const p = clean.service.stop("alice", "test").then(() => order.push("stopped"));
  await p;
  assert.ok(clean.state.children[0].received.some((m) => m.type === "shutdown"));
  assert.equal(await clean.service.state("alice"), "stopped");
  assert.deepEqual(clean.state.children[0].killed, []);

  const stuck = harness({ daemon: { ignoreShutdown: true } });
  await stuck.service.ensure("alice");
  const started = Date.now();
  await stuck.service.stop("alice", "test", 50);
  assert.deepEqual(stuck.state.children[0].killed, ["SIGKILL"]);
  assert.ok(Date.now() - started < 1500);
  assert.equal(await stuck.service.state("alice"), "stopped");
  await clean.service.stop("alice");
});

test("viewers get state, their page and its nav on attach, then live updates; only allowlisted fields pass and the token never does", async () => {
  const { service, state } = harness();
  await service.ensure("alice");
  const d = state.children[0];
  d.emitOut({ type: "tabs", tabs: [{ targetId: TID, title: "Example", url: "https://example.com/", opener: "agent", secret: TOKEN }] });
  d.emitOut({ type: "nav", targetId: TID, url: "https://example.com/", title: "Example", loading: false, canBack: false, canForward: true, extra: 1 });
  d.emitOut({ type: "clients", agents: 2 });
  d.emitOut({ type: "ready", port: 1, token: TOKEN });
  d.emitOut({ type: "weird", token: TOKEN });
  d.emitOut({ type: "error", code: "no_target", message: "has token " + TOKEN });
  await wait(30);
  const a = sink();
  await service.attachViewer("alice", a);
  await bound(a);
  assert.deepEqual(a.msgs().map((m) => m.type), ["state", "clients", "page", "nav"]);
  assert.equal(a.msgs("state")[0].state, "running");
  assert.equal(a.msgs("clients")[0].agents, 2);
  assert.deepEqual(a.msgs("page")[0], { type: "page", targetId: TID, created: true });
  assert.equal((await service.status("alice")).tabs, 1, "the tab list is kept for status only");
  assert.equal(a.msgs("tabs").length, 0, "viewers never see a tab list: one node, one page");
  d.emitOut({ type: "agentActivity", targetId: TID, at: 5 });
  d.emitOut({ type: "error", code: "bad_url", message: "x" });
  await wait(30);
  assert.deepEqual(a.msgs("agentActivity")[0], { type: "agentActivity", targetId: TID, at: 5 });
  assert.deepEqual(a.msgs("error").at(-1), { type: "error", code: "bad_url" });
  assert.ok(!a.texts.join("").includes(TOKEN), "token never reaches a viewer");
  assert.equal(service.viewerCount("alice"), 1);
  await service.shutdown();
});

test("viewer messages are validated, rate limited and relayed as the daemon's own messages", async () => {
  const { service, state } = harness();
  await service.ensure("alice");
  const d = state.children[0];
  const s = sink();
  const v = await service.attachViewer("alice", s);
  await bound(s);
  const sent = (m) => v.onMessage(JSON.stringify(m));
  sent({ type: "nav.go", targetId: TID, url: "javascript:alert(1)" });
  v.onMessage("not json");
  sent({ type: "shutdown" });
  sent({ type: "frame.ack", n: 1 });
  sent({ type: "hello" });
  sent({ type: "Target.sendMessageToTarget", message: "{}" });
  sent({ type: "input.text", text: "x".repeat(5000) });
  await wait(20);
  assert.deepEqual(d.received.map((m) => m.type), ["hello", "page.open"], "only the runtime's own messages reached the daemon");
  assert.deepEqual(s.msgs("error").map((m) => m.code), ["bad_url", "bad_json", "bad_message", "bad_message", "bad_message", "bad_message", "bad_message"]);
  sent({ type: "nav.go", targetId: TID, url: "https://example.com/a" });
  sent({ type: "tab.new" }); // gone from the protocol: one node, one page
  sent({ type: "nav.go", targetId: "OTHERPAGE0000000000000000000000", url: "https://example.com/b" }); // a client-chosen target is overridden by the node's own page
  sent({ type: "input.mouse", kind: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 2, modifiers: 9 });
  sent({ type: "input.wheel", x: 5, y: 6, dx: -3, dy: 40, modifiers: 8 });
  sent({ type: "viewport", width: 800, height: 500, dpr: 2 });
  await wait(20);
  assert.deepEqual(d.received.slice(2), [
    { type: "nav.go", targetId: TID, url: "https://example.com/a" },
    { type: "nav.go", targetId: TID, url: "https://example.com/b" },
    { type: "input.mouse", targetId: TID, kind: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 2, modifiers: 9 },
    { type: "input.wheel", targetId: TID, x: 5, y: 6, dx: -3, dy: 40, modifiers: 8 },
    { type: "viewport", targetId: TID, width: 800, height: 500, dpr: 2 },
  ]);
  assert.equal(s.msgs("error").at(-1).code, "bad_message", "tab.* is rejected");
  // 120 input messages per second per socket: the rest are dropped.
  const before = d.received.length;
  for (let i = 0; i < 300; i++) sent({ type: "input.wheel", x: 1, y: 1, dx: 0, dy: 1 });
  await wait(30);
  const wheels = d.received.length - before;
  assert.ok(wheels >= 110 && wheels <= 120, "wheel messages relayed: " + wheels);
  sent({ type: "nav.reload" }); // not input.*: never rate limited
  await wait(10);
  assert.equal(d.received.at(-1).type, "nav.reload");
  await service.shutdown();
});

test("backpressure: frames go only to casting viewers, a slow socket drops frames and delays the ack until it drains", async () => {
  const { service, state } = harness();
  await service.ensure("alice");
  const d = state.children[0];
  const watcher = sink(), idle = sink();
  const w = await service.attachViewer("alice", watcher);
  await service.attachViewer("alice", idle);
  await bound(watcher); await bound(idle);
  const frame = (n) => d.emitOut({ type: "frame", n, targetId: TID, jpeg: "AAAA", w: 800, h: 600, scale: 1 });
  const acks = () => d.received.filter((m) => m.type === "frame.ack").map((m) => m.n);
  const sentFrames = () => watcher.msgs("frame").map((m) => m.n);

  frame(1); await wait(20);
  assert.deepEqual(sentFrames(), [], "nobody asked for a screencast: dropped");
  assert.deepEqual(acks(), [1], "and acked straight away so Chromium keeps its pace");

  w.onMessage(JSON.stringify({ type: "screencast.start", targetId: TID, maxW: 5000, maxH: 5000, quality: 60 }));
  await wait(10);
  assert.deepEqual(d.received.at(-1), { type: "screencast.start", targetId: TID, maxW: 1600, maxH: 1200, quality: 60 }, "frame size is capped at 1600x1200");
  frame(2); await wait(20);
  assert.deepEqual(sentFrames(), [2]);
  assert.equal(idle.msgs("frame").length, 0, "a viewer that did not ask never gets frames");
  assert.deepEqual(acks(), [1, 2]);

  watcher.buffered = 600 * 1024;
  frame(3); frame(4); await wait(60);
  assert.deepEqual(sentFrames(), [2], "frames are dropped while the socket is behind");
  assert.deepEqual(acks(), [1, 2], "no ack while the socket is behind: Chromium throttles itself");
  watcher.buffered = 0;
  await until(() => acks().length === 3);
  assert.deepEqual(acks(), [1, 2, 4], "the next ack is for the latest frame");
  await service.shutdown();
});

test("screencast stays on while another viewer still watches; stops when the last one stops or leaves", async () => {
  const { service, state } = harness();
  await service.ensure("alice");
  const d = state.children[0];
  const start = JSON.stringify({ type: "screencast.start", targetId: TID, maxW: 800, maxH: 600, quality: 60 });
  const stop = JSON.stringify({ type: "screencast.stop" });
  const sa = sink(), sb = sink();
  const a = await service.attachViewer("alice", sa);
  const b = await service.attachViewer("alice", sb);
  await bound(sa); await bound(sb);
  a.onMessage(start); b.onMessage(start);
  const stops = () => d.received.filter((m) => m.type === "screencast.stop").length;
  a.onMessage(stop);
  await wait(10);
  assert.equal(stops(), 0, "b is still watching");
  b.close();
  await wait(10);
  assert.equal(stops(), 1, "the last watcher leaving stops it");
  assert.equal(service.viewerCount("alice"), 1);
  await service.shutdown();
});

test("a crash moves to stopped for viewers; the next ensure starts a fresh daemon and a late exit of the old one is ignored", async () => {
  const { service, state } = harness({ daemon: (n) => ({ port: 40111 + n }) });
  await service.ensure("alice");
  const s = sink();
  await service.attachViewer("alice", s);
  state.children[0].emitOut({ type: "tabs", tabs: [{ targetId: TID, title: "T", url: "https://a.test/", opener: "user" }] });
  await wait(10);
  state.children[0].die(139, "SIGSEGV");
  await wait(20);
  assert.equal(await service.state("alice"), "stopped");
  assert.equal(s.msgs("state").at(-1).state, "stopped");
  assert.deepEqual(state.activity.at(-1), ["alice", false]);
  assert.equal((await service.status("alice")).tabs, 0);

  const again = await service.ensure("alice");
  assert.equal(again.wsEndpoint, "ws://127.0.0.1:40112/devtools/browser?agent=floq-runtime-helper");
  assert.equal(state.spawns.length, 2);
  assert.equal(s.msgs("state").at(-1).state, "running", "the same viewer sees it come back");
  state.children[0].emit("exit", 0, null); // a stale event from the first child
  await wait(10);
  assert.equal(await service.state("alice"), "running");
  await service.shutdown();
});

test("opening the node starts the browser (waking a sleeping shard); a start failure is reported to the viewer", async () => {
  const ok = harness({ awake: false });
  const s = sink();
  await ok.service.attachViewer("alice", s);
  await until(() => s.msgs("state").some((m) => m.state === "running"));
  assert.equal(ok.state.wakes, 1);
  assert.deepEqual(s.msgs("state").map((m) => m.state).slice(0, 3), ["stopped", "starting", "running"]);
  await ok.service.shutdown();

  const bad = harness({ daemon: { ready: false }, startTimeoutMs: 40 });
  const t = sink();
  await bad.service.attachViewer("alice", t);
  await until(() => t.msgs("error").length > 0);
  assert.equal(t.msgs("error")[0].code, "browser_start_timeout");
  assert.equal(t.msgs("state").at(-1).state, "stopped");
});

test("restart stops then starts; clear-data stops, then removes only the profile through the sandbox", async () => {
  const { service, state } = harness({ daemon: (n) => ({ port: 41000 + n }) });
  await service.ensure("alice");
  const status = await service.restart("alice");
  assert.equal(status.state, "running");
  assert.equal(state.children.length, 2);
  assert.ok(state.children[0].received.some((m) => m.type === "shutdown"));

  const cleared = await service.clearData("alice");
  assert.equal(cleared.state, "stopped");
  assert.ok(state.children[1].received.some((m) => m.type === "shutdown"), "stopped before anything is removed");
  const rm = state.spawns.find((s) => s.file === "rm");
  assert.deepEqual(rm.args, ["-rf", "--", PROFILE_DIR]);
  assert.equal(PROFILE_DIR, ".floq/browser/profile");
  assert.equal(rm.cwd, ".");

  state.rm.code = 1;
  await assert.rejects(() => service.clearData("alice"), (e) => e.code === "browser_clear_failed");
});

test("status reports the profile size measured in the sandbox, and the pinned version", async () => {
  const { service } = harness();
  const s = await service.status("alice", { profileBytes: true });
  assert.equal(s.state, "stopped");
  assert.equal(s.profileBytes, 4096 * 1024, "du -sk reports KiB");
  assert.deepEqual(s.version, { chromium: "157.0.8103.15", revision: "1252", playwrightMcp: "0.0.84" });
  assert.equal(s.profile, "~/.floq/browser/profile");
});

test("syncMcp asks for the entry only when the browser is available and on for the user; onToggle stops the daemon when it went off", async () => {
  const { service, state } = harness();
  await service.syncMcp("alice");
  state.enabled = false;
  await service.syncMcp("alice");
  assert.deepEqual(state.mcpCalls, [["alice", true], ["alice", false]]);
  state.enabled = true;
  await service.ensure("alice");
  state.enabled = false;
  await service.onToggle("alice");
  assert.equal(state.children[0].received.some((m) => m.type === "shutdown"), true);
  assert.deepEqual(state.mcpCalls.at(-1), ["alice", false]);

  const off = harness({ mode: "off" });
  await off.service.syncMcp("alice");
  assert.deepEqual(off.state.mcpCalls, [["alice", false]]);
  const none = new BrowserService({}, { agentBrowser: async () => true }, null, { mode: "on", idleMs: 0, memMb: 0, allowPrivate: false, browsersDir: "/x", version: null });
  assert.equal(await none.syncMcp("alice"), null);
});

test("users are isolated: each gets their own daemon, endpoint and viewers", async () => {
  const state = { children: [], spawns: [] };
  const shards = {
    awakeHandle: (u) => ({ userId: u, uid: u === "alice" ? 1 : 2, mountPath: "/m/" + u }),
    wake: async () => { throw new Error("no"); },
    driver: { hostPath: () => "", spawnPipe: (h, spec) => { state.spawns.push([h.userId, spec]); const c = fakeDaemon({ port: h.userId === "alice" ? 40001 : 40002, token: (h.userId === "alice" ? "a" : "b").repeat(64) }); state.children.push(c); return c; } },
  };
  const service = new BrowserService(shards, { agentBrowser: async () => true }, null, { mode: "on", idleMs: 0, memMb: 0, allowPrivate: false, browsersDir: "/x", version: { chromium: "1", revision: "1", playwrightMcp: "1" } });
  const [a, b] = await Promise.all([service.ensure("alice"), service.ensure("bob")]);
  assert.notEqual(a.token, b.token);
  assert.deepEqual([state.spawns[0][0], state.spawns[1][0]], ["alice", "bob"]);
  const sa = sink(), sb = sink();
  await service.attachViewer("alice", sa);
  await service.attachViewer("bob", sb);
  await bound(sa); await bound(sb);
  state.children[0].emitOut({ type: "nav", targetId: TID, url: "https://a.test/", title: "alice only", loading: false, canBack: false, canForward: false });
  await wait(20);
  assert.equal(sa.msgs("nav").at(-1).title, "alice only");
  assert.equal(sb.msgs("nav").length, 0, "bob never sees alice's page");
  assert.ok(!sb.texts.join("").includes("a".repeat(64)));
  assert.equal(service.viewerCount("alice"), 1);
  await service.shutdown();
});

test("concurrent ensure + attachViewer(wake) on a sleeping shard start exactly one daemon", async () => {
  const { service, state } = harness({ awake: false });
  const s = sink();
  await Promise.all([service.attachViewer("alice", s), service.ensure("alice", { wake: true }), service.ensure("alice", { wake: true })]);
  await until(() => state.spawns.some((x) => x.file !== "rm" && x.file !== "du") && service.isRunning("alice"));
  await service.ensure("alice", { wake: true });
  assert.equal(state.children.length, 1, "one daemon, never an orphan on the same profile");
  await service.shutdown();
});

test("a stuck casting viewer is evicted after the grace period and no longer throttles or pins the browser", async () => {
  const { service, state } = harness({ stuckViewerMs: 50 });
  await service.ensure("alice");
  const d = state.children[0];
  const stuck = sink(), fine = sink();
  const a = await service.attachViewer("alice", stuck);
  const b = await service.attachViewer("alice", fine);
  await bound(stuck); await bound(fine);
  const start = JSON.stringify({ type: "screencast.start", targetId: TID, maxW: 800, maxH: 600, quality: 60 });
  a.onMessage(start); b.onMessage(start);
  await wait(10);
  stuck.buffered = 900 * 1024; // half-open: never drains
  d.emitOut({ type: "frame", n: 1, targetId: TID, jpeg: "AAAA", w: 800, h: 600, scale: 1 });
  await until(() => stuck.closed, 1500);
  assert.equal(service.viewerCount("alice"), 1);
  await until(() => d.received.some((m) => m.type === "frame.ack" && m.n === 1), 1000);
  await service.shutdown();
});

test("input: press/release/key are never rate-limited, only mouseMoved and wheel are", async () => {
  const { service, state } = harness();
  await service.ensure("alice");
  const d = state.children[0];
  const vs = sink();
  const v = await service.attachViewer("alice", vs);
  await bound(vs);
  for (let i = 0; i < 400; i++) v.onMessage(JSON.stringify({ type: "input.mouse", kind: "mouseMoved", x: 1, y: 1, button: "none", clickCount: 0, modifiers: 0 }));
  v.onMessage(JSON.stringify({ type: "input.mouse", kind: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 }));
  await wait(20);
  const moves = d.received.filter((m) => m.type === "input.mouse" && m.kind === "mouseMoved").length;
  assert.ok(moves < 400, "moves are throttled");
  assert.equal(d.received.filter((m) => m.type === "input.mouse" && m.kind === "mouseReleased").length, 1, "the release always gets through");
  await service.shutdown();
});

test("one page per node: each node's socket gets only its own page, frames and acks stay per page", async () => {
  const { service, state } = harness();
  await service.ensure("alice");
  const d = state.children[0];
  const one = sink(), two = sink();
  const a = await service.attachViewer("alice", one, "n1");
  const b = await service.attachViewer("alice", two, "n2");
  await bound(one); await bound(two);
  const t1 = one.msgs("page")[0].targetId, t2 = two.msgs("page")[0].targetId;
  assert.notEqual(t1, t2);
  assert.deepEqual(d.received.filter((m) => m.type === "page.open").map((m) => m.nodeId), ["n1", "n2"]);
  d.emitOut({ type: "nav", targetId: t1, url: "https://one.test/", title: "One", loading: false, canBack: false, canForward: false });
  d.emitOut({ type: "cursor", targetId: t2, cursor: "pointer" });
  d.emitOut({ type: "cursor", targetId: t1, cursor: "javascript:alert(1)" });
  await wait(20);
  assert.equal(one.msgs("nav").length, 1); assert.equal(two.msgs("nav").length, 0);
  assert.deepEqual(two.msgs("cursor"), [{ type: "cursor", cursor: "pointer" }]);
  assert.deepEqual(one.msgs("cursor"), [{ type: "cursor", cursor: "default" }], "an unsafe cursor value is folded to default");
  a.onMessage(JSON.stringify({ type: "screencast.start", maxW: 800, maxH: 600, quality: 60 }));
  b.onMessage(JSON.stringify({ type: "screencast.start", maxW: 400, maxH: 300, quality: 50 }));
  await wait(10);
  const starts = d.received.filter((m) => m.type === "screencast.start");
  assert.deepEqual(starts.map((m) => m.targetId), [t1, t2], "the node's own page is filled in");
  d.emitOut({ type: "frame", n: 1, targetId: t1, jpeg: "AAAA", w: 800, h: 600, scale: 1 });
  d.emitOut({ type: "frame", n: 2, targetId: t2, jpeg: "BBBB", w: 400, h: 300, scale: 1 });
  await wait(20);
  assert.deepEqual(one.msgs("frame").map((m) => m.n), [1]);
  assert.deepEqual(two.msgs("frame").map((m) => m.n), [2]);
  assert.deepEqual(d.received.filter((m) => m.type === "frame.ack").map((m) => m.n).sort(), [1, 2], "both pages are acked, none is starved");
  a.onMessage(JSON.stringify({ type: "screencast.stop" }));
  await wait(10);
  assert.deepEqual(d.received.filter((m) => m.type === "screencast.stop").map((m) => m.targetId), [t1], "stopping one node leaves the other casting");
  await service.shutdown();
});

test("closing a node destroys its page and drops its links; a page that vanishes is re-opened for a live viewer", async () => {
  const removed = [];
  const { service, state } = harness();
  service.links = { forUser: async () => [{ sessionId: "11111111-1111-1111-1111-111111111111", nodeId: "n1" }], removeNode: async (u, n) => { removed.push([u, n]); return []; } };
  await service.ensure("alice");
  const d = state.children[0];
  await until(() => d.received.some((m) => m.type === "agent.scope"));
  assert.deepEqual(d.received.find((m) => m.type === "agent.scope"), { type: "agent.scope", agent: "11111111-1111-1111-1111-111111111111", nodeId: "n1" }, "stored links are re-applied when the daemon starts");
  const s = sink();
  const v = await service.attachViewer("alice", s, "n1");
  await bound(s);
  d.emitOut({ type: "pageGone", nodeId: "n1" });
  await wait(20);
  assert.equal(d.received.filter((m) => m.type === "page.open").length, 2, "re-opened for the viewer that is still there");
  v.onMessage(JSON.stringify({ type: "page.close" }));
  await wait(20);
  assert.ok(d.received.some((m) => m.type === "page.close" && m.nodeId === "n1"));
  assert.deepEqual(removed, [["alice", "n1"]]);
  service.setAgentScope("alice", "22222222-2222-2222-2222-222222222222", "n9");
  service.setAgentScope("alice", "22222222-2222-2222-2222-222222222222", null);
  await wait(10);
  assert.deepEqual(d.received.filter((m) => m.type === "agent.scope").slice(1), [
    { type: "agent.scope", agent: "22222222-2222-2222-2222-222222222222", nodeId: "n9" },
    { type: "agent.scope", agent: "22222222-2222-2222-2222-222222222222", nodeId: null },
  ]);
  const e = await service.ensure("alice", { agentId: "22222222-2222-2222-2222-222222222222" });
  assert.equal(e.wsEndpoint, "ws://127.0.0.1:40111/devtools/browser?agent=22222222-2222-2222-2222-222222222222");
  await service.shutdown();
});
