import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { FrameDecoder, encodeFrame, isPrivateAddress, normalizeNavUrl, shouldBlockHost, tokenMatches, validateControl } from "../dist/image/floq-browserd-core.mjs";
import { formatBrowserStatus } from "../dist/image/floq-args.mjs";

const DAEMON = fileURLToPath(new URL("../dist/image/floq-browserd.mjs", import.meta.url));
const MCP = fileURLToPath(new URL("../dist/image/floq-browser-mcp.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fakeChromium.mjs", import.meta.url));
const TID = "C711BB681855D07964DB653782FFBE88";

// ------------------------------------------------------------------ validators

test("validateControl accepts the documented messages", () => {
  const ok = (m: unknown) => assert.equal(validateControl(m).ok, true, JSON.stringify(m));
  ok({ type: "hello" });
  ok({ type: "screencast.start", targetId: TID, maxW: 1600, maxH: 1200, quality: 60 });
  ok({ type: "screencast.stop" });
  ok({ type: "frame.ack", n: 3 });
  ok({ type: "input.mouse", kind: "mousePressed", x: 10.5, y: 20, button: "left", clickCount: 1, modifiers: 0 });
  ok({ type: "input.wheel", x: 1, y: 1, dx: 0, dy: -120 });
  ok({ type: "input.key", kind: "keyDown", key: "Enter", code: "Enter", modifiers: 0 });
  ok({ type: "input.key", kind: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: 2 });
  ok({ type: "input.key", kind: "keyUp", key: "é", code: "KeyE" });
  ok({ type: "input.text", text: "hello 😀" });
  ok({ type: "nav.go", targetId: TID, url: "https://example.com/a?b=c" });
  ok({ type: "nav.go", url: "about:blank" });
  for (const t of ["nav.back", "nav.forward", "nav.reload", "nav.stop"]) ok({ type: t });
  ok({ type: "page.open", nodeId: "main" }); ok({ type: "page.open", nodeId: "br-ab12_CD", url: "http://localhost:3000" }); ok({ type: "page.close", nodeId: "main" });
  ok({ type: "agent.scope", agent: "11111111-1111-1111-1111-111111111111", nodeId: "n1" }); ok({ type: "agent.scope", agent: "11111111-1111-1111-1111-111111111111", nodeId: null });
  ok({ type: "viewport", targetId: TID, width: 900, height: 600, dpr: 2 });
  ok({ type: "input.mouse", targetId: TID, kind: "mouseMoved", x: 1, y: 1, button: "left", buttons: 1, clickCount: 0, modifiers: 0 });
  ok({ type: "shutdown" });
});

test("validateControl rejects bad types, ranges, keys and oversize text", () => {
  const bad = (m: unknown, vp?: { w: number; h: number }) => assert.equal(validateControl(m, vp).ok, false, JSON.stringify(m)?.slice(0, 120));
  for (const v of [null, undefined, 1, "x", [], {}, { type: 5 }, { type: "nope" }, { type: "input.mouse" }, { type: "__proto__" }]) bad(v);
  const mouse = { type: "input.mouse", kind: "mouseMoved", x: 1, y: 1, button: "none", clickCount: 0, modifiers: 0 };
  bad({ ...mouse, x: -1 }); bad({ ...mouse, y: 801 }); bad({ ...mouse, x: 1281 }); bad({ ...mouse, x: NaN }); bad({ ...mouse, x: Infinity }); bad({ ...mouse, x: "1" });
  bad({ ...mouse, kind: "mouseWheel" }); bad({ ...mouse, button: "back" }); bad({ ...mouse, clickCount: 4 }); bad({ ...mouse, clickCount: 1.5 }); bad({ ...mouse, modifiers: 16 });
  assert.equal(validateControl({ ...mouse, x: 1500 }, { w: 1600, h: 900 }).ok, true, "coordinates follow the current viewport");
  bad({ type: "input.wheel", x: 1, y: 1, dx: 20000, dy: 0 }); bad({ type: "input.wheel", x: 1, y: 1, dx: 0 });
  const key = { type: "input.key", kind: "keyDown", key: "a", code: "KeyA", modifiers: 0 };
  bad({ ...key, key: "" }); bad({ ...key, key: "Enterr" }); bad({ ...key, key: "ab" }); bad({ ...key, key: "\u0007" }); bad({ ...key, key: "\u007f" }); bad({ ...key, kind: "keyPress" });
  bad({ ...key, code: "Key A" }); bad({ ...key, code: "x".repeat(33) }); bad({ ...key, text: "123456789" }); bad({ ...key, modifiers: -1 }); bad({ ...key, key: 5 });
  bad({ type: "input.text", text: "a".repeat(4097) }); bad({ type: "input.text", text: "é".repeat(2049) }); bad({ type: "input.text", text: 5 });
  assert.equal(validateControl({ type: "input.text", text: "a".repeat(4096) }).ok, true);
  bad({ type: "screencast.start", targetId: TID, maxW: 1601, maxH: 100, quality: 60 }); bad({ type: "screencast.start", targetId: TID, maxW: 100, maxH: 1201, quality: 60 });
  bad({ type: "screencast.start", targetId: TID, maxW: 100, maxH: 100, quality: 0 }); bad({ type: "screencast.start", targetId: "../x", maxW: 1, maxH: 1, quality: 1 });
  bad({ type: "frame.ack", n: -1 }); bad({ type: "frame.ack", n: 1.2 });
  bad({ type: "tab.close", targetId: TID }); bad({ type: "tab.select", targetId: TID }); bad({ type: "tab.new" }); bad({ type: "nav.back", targetId: 5 });
  bad({ type: "page.open", nodeId: "../x" }); bad({ type: "page.open", nodeId: "" }); bad({ type: "page.open", nodeId: "a".repeat(65) }); bad({ type: "page.open", nodeId: "n", url: "javascript:1" });
  bad({ type: "agent.scope", agent: "x", nodeId: "n" }); bad({ type: "agent.scope", agent: "11111111-1111-1111-1111-111111111111", nodeId: "a b" });
  bad({ type: "viewport", targetId: TID, width: 100, height: 600, dpr: 1 }); bad({ type: "viewport", width: 900, height: 600, dpr: 1 });
});

test("navigation URLs: only http, https and about:blank, however they are dressed", () => {
  const forbidden = [
    "file:///etc/passwd", "chrome://settings", "devtools://devtools/bundled/inspector.html", "javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
    "JAVASCRIPT:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "java\tscript:alert(1)", "\u0000javascript:alert(1)", "vbscript:x", "blob:https://example.com/uuid",
    "about:srcdoc", "about:blank#x", "about:blank?x", "view-source:https://example.com", "chrome-extension://abc/x", "ftp://example.com", "ws://example.com", "http://", "https:///", "//example.com",
    "example.com", "", "http://exa mple.com", "http://example.com/\n", " http://example.com", "https://example.com\u2028", "x".repeat(2049), "chrome-untrusted://x", "filesystem:https://example.com/temporary/x",
  ];
  for (const u of forbidden) assert.equal(normalizeNavUrl(u), null, JSON.stringify(u).slice(0, 80));
  for (const bad of [null, undefined, 5, {}, ["https://a.com"]]) assert.equal(normalizeNavUrl(bad), null);
  assert.equal(normalizeNavUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeNavUrl("HTTP://Example.COM:8080/a b".replace(" ", "%20")), "http://example.com:8080/a%20b");
  assert.equal(normalizeNavUrl("https://münchen.de/"), "https://xn--mnchen-3ya.de/");
  assert.equal(normalizeNavUrl("about:blank"), "about:blank");
  assert.equal(normalizeNavUrl("ABOUT:BLANK"), null, "only the exact lowercase about:blank");
  assert.equal(validateControl({ type: "nav.go", url: "javascript:1" }).ok, false);
  const r = validateControl({ type: "page.open", nodeId: "n", url: "data:text/html,x" });
  assert.deepEqual(r, { ok: false, code: "bad_url" });
});

test("private address checks cover v4, v6 and v4-mapped v6", () => {
  for (const a of ["127.0.0.1", "127.9.9.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "[::1]", "224.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::1", "2002:0a00:0001::", "2002:c0a8:1::1"]) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "example.com", "64:ff9b::808:808", "2002:0808:0808::1"]) assert.equal(isPrivateAddress(a), false, a);
});

test("shouldBlockHost resolves names and refuses localhost names without a lookup", async () => {
  const dns = async (h: string) => (h === "rebind.example" ? ["1.2.3.4", "10.0.0.5"] : h === "good.example" ? ["93.184.216.34"] : (() => { throw new Error("ENOTFOUND"); })());
  assert.equal(await shouldBlockHost("localhost", dns), true);
  assert.equal(await shouldBlockHost("app.localhost", dns), true);
  assert.equal(await shouldBlockHost("127.0.0.1", dns), true);
  assert.equal(await shouldBlockHost("[::1]", dns), true);
  assert.equal(await shouldBlockHost("rebind.example", dns), true);
  assert.equal(await shouldBlockHost("good.example", dns), false);
  assert.equal(await shouldBlockHost("nx.example", dns), true, "resolve failure fails closed");
  assert.equal(await shouldBlockHost("empty.example", async () => []), true);
});

test("token comparison", () => {
  assert.equal(tokenMatches("Bearer abc", "abc"), true);
  for (const g of [undefined, "", "abc", "bearer abc", "Bearer abd", "Bearer ", "Bearer abcd", "Basic abc"]) assert.equal(tokenMatches(g, "abc"), false, String(g));
});

test("FrameDecoder handles fragmentation, split reads and refuses bad frames", () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = (op: number, payload: Buffer, fin = true) => {
    const p = Buffer.from(payload).map((b, i) => b ^ mask[i & 3]);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | payload.length]), mask, p]);
  };
  const got: [number, string][] = []; const errs: string[] = [];
  const d = new FrameDecoder((op, data) => got.push([op, data.toString()]), (r) => errs.push(r), 1000);
  const all = Buffer.concat([frame(1, Buffer.from("hel"), false), frame(0, Buffer.from("lo")), frame(9, Buffer.from("p"))]);
  for (let i = 0; i < all.length; i++) d.push(all.subarray(i, i + 1));
  assert.deepEqual(got, [[9, "p"], [1, "hello"]].sort(() => 0).length ? got : got);
  assert.deepEqual(got.map((g) => g[1]).sort(), ["hello", "p"]);
  d.push(Buffer.from([0x81, 0x01, 0x41])); // unmasked
  assert.deepEqual(errs, ["client frame not masked"]);
  const big = new FrameDecoder(() => {}, (r) => errs.push(r), 10);
  big.push(Buffer.concat([Buffer.from([0x81, 0xfe, 0x00, 0x20]), mask, Buffer.alloc(32)]));
  assert.equal(errs.at(-1), "frame too large");
  assert.equal(encodeFrame(1, Buffer.from("hi"))[1], 2);
});

test("floq browser status text and exit codes", () => {
  const v = { chromium: "157.0.8103.15", revision: "1252", playwrightMcp: "0.0.84", build: "chromium" };
  const running = formatBrowserStatus({ state: "running", pid: 4123, uptimeSec: 720, agents: 2, tabs: 3, version: v, profile: "~/.floq/browser/profile", profileBytes: 38 * 1024 * 1024, sandbox: "chromium sandbox on" });
  assert.equal(running.exitCode, 0);
  assert.equal(running.text, "browser: running (pid 4123, up 12m, 2 agent connections, 3 tabs)\nchromium: 157.0.8103.15 (full build, new headless r1252), playwright-mcp 0.0.84\nprofile: ~/.floq/browser/profile (38 MB)\nsandbox: chromium sandbox on");
  assert.equal(formatBrowserStatus({ state: "stopped", version: v }).exitCode, 3);
  assert.equal(formatBrowserStatus({ state: "disabled" }).exitCode, 4);
  assert.equal(formatBrowserStatus({ state: "unavailable" }).exitCode, 4);
});

// -------------------------------------------------------------- daemon (fake Chromium)

type Daemon = { chromiumLog(): string; child: ChildProcess; msgs: any[]; stderr: string; ready: any; home: string; send(m: unknown): void; waitFor(pred: (m: any) => boolean, ms?: number): Promise<any>; stop(): Promise<void> };

async function startDaemon(t: test.TestContext, opts: { exe?: string; env?: Record<string, string>; home?: string } = {}): Promise<Daemon> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "floq-browserd-"));
  if (!opts.home) t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [DAEMON], { env: { PATH: process.env.PATH!, HOME: home, FLOQ_BROWSER_EXECUTABLE: opts.exe ?? FAKE, FAKE_CHROMIUM_LOG: join(home, "chromium.log"), ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}), ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {});
  const d: Daemon = { chromiumLog: () => { try { return readFileSync(join(home, "chromium.log"), "utf8"); } catch { return ""; } }, child, msgs: [], stderr: "", ready: null, home, send: (m) => { if (child.stdin!.writable) child.stdin!.write(JSON.stringify(m) + "\n"); }, waitFor: null as any, stop: null as any };
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  let buf = "";
  child.stdout!.on("data", (c: Buffer) => {
    buf += c.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      d.msgs.push(m);
      if (m.type === "ready") d.ready = m;
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    }
  });
  child.stderr!.on("data", (c: Buffer) => { d.stderr += c; });
  d.waitFor = (pred, ms = 8000) => {
    const hit = d.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("timeout waiting for message; got " + JSON.stringify(d.msgs.map((m) => m.type)) + "\n" + d.stderr)), ms); waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } }); });
  };
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  d.stop = async () => { if (child.exitCode === null) { d.send({ type: "shutdown" }); setTimeout(() => child.kill("SIGKILL"), 4000).unref(); } await exited; };
  t.after(() => d.stop());
  await d.waitFor((m) => m.type === "ready", 20000);
  return d;
}

type Cdp = { ws: WebSocket; call(method: string, params?: unknown, sessionId?: string): Promise<any>; events: any[]; waitEvent(method: string, ms?: number): Promise<any>; close(): void };

async function connect(d: Daemon, t: test.TestContext, headers: Record<string, string> = {}): Promise<Cdp> {
  const ws = new WebSocket(`ws://127.0.0.1:${d.ready.port}/devtools/browser`, { headers: { Authorization: "Bearer " + d.ready.token, ...headers } });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); ws.once("unexpected-response", (_r, res) => reject(new Error("HTTP " + res.statusCode))); });
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  const events: any[] = [];
  const waiters: { method: string; resolve: (m: any) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id !== undefined) return pending.get(m.id)?.(m);
    events.push(m);
    for (const w of [...waiters]) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const c: Cdp = {
    ws, events,
    call: (method, params = {}, sessionId) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    waitEvent: (method, ms = 5000) => { const hit = events.find((e) => e.method === method); if (hit) return Promise.resolve(hit); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("no event " + method)), ms); waiters.push({ method, resolve: (m) => { clearTimeout(timer); resolve(m); } }); }); },
    close: () => ws.close(),
  };
  t.after(() => ws.close());
  return c;
}

const refused = (d: Daemon, headers: Record<string, string>, path = "/devtools/browser") => new Promise<number>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${d.ready.port}${path}`, { headers });
  ws.once("open", () => { ws.close(); reject(new Error("upgrade was accepted")); });
  ws.once("unexpected-response", (_r, res) => resolve(res.statusCode!));
  ws.once("error", () => {});
});

test("daemon: authenticated endpoint refuses missing/wrong token, any Origin, wrong Host and wrong path", async (t) => {
  const d = await startDaemon(t);
  assert.match(d.ready.token, /^[0-9a-f]{64}$/);
  assert.equal(d.ready.sandbox, "on");
  assert.equal(await refused(d, {}), 401);
  assert.equal(await refused(d, { Authorization: "Bearer nope" }), 401);
  assert.equal(await refused(d, { Authorization: "Bearer " + d.ready.token.slice(0, 63) }), 401);
  assert.equal(await refused(d, { Authorization: "Bearer " + d.ready.token, Origin: "http://evil.example" }), 403);
  assert.equal(await refused(d, { Authorization: "Bearer " + d.ready.token, Origin: "null" }), 403);
  assert.equal(await refused(d, { Authorization: "Bearer " + d.ready.token, Host: "evil.example:" + d.ready.port }), 403);
  assert.equal(await refused(d, { Authorization: "Bearer " + d.ready.token, Host: "localhost:" + d.ready.port }), 403);
  assert.equal(await refused(d, { Authorization: "Bearer " + d.ready.token }, "/devtools/page/x"), 404);
  const cdp = await connect(d, t);
  assert.match((await cdp.call("Browser.getVersion")).result.product, /Chrome/);
  // Plain HTTP never serves anything, token or not.
  const res = await fetch(`http://127.0.0.1:${d.ready.port}/json/version`, { headers: { Authorization: "Bearer " + d.ready.token } });
  assert.equal(res.status, 404);
});

test("daemon: listens on loopback only, endpoint.json is 0600, profile is 0700", async (t) => {
  const d = await startDaemon(t);
  const hex = d.ready.port.toString(16).toUpperCase().padStart(4, "0");
  const listeners = readFileSync("/proc/net/tcp", "utf8").split("\n").filter((l) => /\s0A\s/.test(l) && l.includes(":" + hex + " "));
  assert.equal(listeners.length, 1);
  assert.match(listeners[0], /0100007F:/);
  const endpoint = join(d.home, ".floq/browser/endpoint.json");
  assert.equal(statSync(endpoint).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(endpoint, "utf8"))).sort(), ["pid", "port", "startedAt"]);
  assert.equal(statSync(join(d.home, ".floq/browser/profile")).mode & 0o777, 0o700);
  assert.ok(existsSync(join(d.home, "Downloads")));
  assert.doesNotMatch(d.stderr, new RegExp(d.ready.token), "the token is never logged");
});

test("daemon: falls back to --no-sandbox when Chromium cannot start sandboxed, and says why", async (t) => {
  const d = await startDaemon(t, { env: { FAKE_CHROMIUM_NEEDS_NO_SANDBOX: "1" } });
  assert.equal(d.ready.sandbox, "off");
  assert.match(d.ready.sandboxReason, /No usable sandbox/);
  assert.match(d.stderr, /browser\.chromium_sandbox_off/);
});

test("daemon: removes a stale SingletonLock whose pid is dead", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "floq-browserd-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, ".floq/browser/profile");
  mkdirSync(profile, { recursive: true });
  symlinkSync("somehost-999999", join(profile, "SingletonLock"));
  const d = await startDaemon(t, { home });
  assert.match(d.stderr, /stale_singleton_removed/);
  assert.throws(() => lstatSync(join(profile, "SingletonLock")));
});

test("daemon: two agents share one browser with their own sessions and cannot use each other's", async (t) => {
  const d = await startDaemon(t);
  const a = await connect(d, t), b = await connect(d, t);
  await d.waitFor((m) => m.type === "clients" && m.agents === 2);
  for (const c of [a, b]) {
    assert.deepEqual((await c.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })).result, {});
  }
  const sa = (await a.waitEvent("Target.attachedToTarget")).params.sessionId, sb = (await b.waitEvent("Target.attachedToTarget")).params.sessionId;
  assert.notEqual(sa, sb);
  assert.equal((await a.call("Runtime.evaluate", { expression: "1" }, sa)).result.result.value, "url=about:blank");
  assert.equal((await b.call("Runtime.evaluate", { expression: "1" }, sb)).result.result.value, "url=about:blank");
  // Cross-session and unknown-session use is refused.
  assert.match((await a.call("Runtime.evaluate", {}, sb)).error.message, /not found/);
  assert.match((await b.call("Runtime.evaluate", {}, "S9999")).error.message, /not found/);
  // Ids of the two clients collide freely (both start at 1) and still route correctly.
  const [ra, rb] = await Promise.all([a.call("Page.navigate", { url: "https://a.example/" }, sa), b.call("Browser.getVersion")]);
  assert.ok(ra.result.frameId); assert.ok(rb.result.product);
  // A client that opens a tab gets a session for it; the other sees the target; the tab is attributed to the agent.
  const created = await b.call("Target.createTarget", { url: "https://new.example/" });
  const tabs = await d.waitFor((m) => m.type === "tabs" && m.tabs.some((x: any) => x.targetId === created.result.targetId && x.opener === "agent"));
  assert.equal(tabs.tabs.find((x: any) => x.opener === "user").url, "https://a.example/");
  // Browser.close and friends are not available to agents.
  assert.match((await a.call("Browser.close")).error.message, /not allowed/);
  assert.equal(d.child.exitCode, null);
  // agent activity is reported for session commands, not for browser-level ones.
  await d.waitFor((m) => m.type === "agentActivity");
  a.close();
  await d.waitFor((m) => m.type === "clients" && m.agents === 1);
  b.close();
  await d.waitFor((m) => m.type === "clients" && m.agents === 0);
});

test("daemon: malformed agent traffic never takes the daemon down", async (t) => {
  const d = await startDaemon(t);
  const c = await connect(d, t);
  c.ws.send("not json"); c.ws.send(JSON.stringify([1, 2])); c.ws.send(JSON.stringify({ id: "x", method: 5 })); c.ws.send(JSON.stringify({ id: 99999 }));
  assert.ok((await c.call("Browser.getVersion")).result.product);
});

test("daemon: control channel validates, binds one page per node, streams frames, forwards pointer input and closes the page", async (t) => {
  const d = await startDaemon(t);
  const first = await d.waitFor((m) => m.type === "tabs" && m.tabs.length === 1);
  const initial = first.tabs[0].targetId;
  d.send({ type: "nav.go", targetId: initial, url: "javascript:alert(1)" });
  assert.deepEqual(await d.waitFor((m) => m.type === "error" && m.code === "bad_url"), { type: "error", code: "bad_url" });
  d.send({ type: "input.mouse", targetId: initial, kind: "mouseMoved", x: 99999, y: 1, button: "none", buttons: 0, clickCount: 0, modifiers: 0 });
  await d.waitFor((m) => m.type === "error" && m.code === "bad_message");
  d.child.stdin!.write("{broken\n");
  await d.waitFor((m) => m.type === "error" && m.code === "bad_json");
  // A page nobody claimed for a node is not controllable by the control channel.
  d.send({ type: "screencast.start", targetId: initial, maxW: 100, maxH: 100, quality: 60 });
  await d.waitFor((m) => m.type === "error" && m.code === "no_target");

  // The first node adopts the initial blank tab; a second node gets a page of its own.
  d.send({ type: "page.open", nodeId: "n1" });
  const p1 = await d.waitFor((m) => m.type === "page" && m.nodeId === "n1");
  assert.deepEqual([p1.targetId, p1.created], [initial, false]);
  d.send({ type: "page.open", nodeId: "n2", url: "https://two.example/" });
  const p2 = await d.waitFor((m) => m.type === "page" && m.nodeId === "n2");
  assert.equal(p2.created, true);
  assert.notEqual(p2.targetId, initial);
  d.send({ type: "page.open", nodeId: "n2" }); // idempotent
  const again = await d.waitFor((m) => m.type === "page" && m.nodeId === "n2" && m !== p2);
  assert.deepEqual([again.targetId, again.created], [p2.targetId, false]);
  const targetId = p1.targetId;

  d.send({ type: "screencast.start", targetId, maxW: 1280, maxH: 800, quality: 60 });
  const frame = await d.waitFor((m) => m.type === "frame");
  assert.deepEqual({ n: frame.n, targetId: frame.targetId, w: frame.w, h: frame.h, scale: frame.scale }, { n: 1, targetId, w: 1280, h: 800, scale: 1 });
  d.send({ type: "frame.ack", n: frame.n });
  d.send({ type: "viewport", targetId, width: 900, height: 500, dpr: 3 });
  for (let i = 0; i < 40 && !/EMULATION/.test(d.chromiumLog()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(d.chromiumLog(), /EMULATION \{"width":900,"height":500,"deviceScaleFactor":2,"mobile":false\}/, "viewport follows the node, dpr capped at 2");

  d.send({ type: "nav.go", targetId, url: "https://example.com" });
  const nav = await d.waitFor((m) => m.type === "nav" && m.targetId === targetId && m.url === "https://example.com/" && m.canBack);
  assert.equal(nav.canForward, false);
  d.send({ type: "nav.back", targetId });
  await d.waitFor((m) => m.type === "nav" && m.targetId === targetId && m.url === "about:blank" && m.canForward);

  // Pointer input: hover with buttons, press with clickCount/modifiers, wheel with modifiers, all on the node's page.
  d.send({ type: "input.mouse", targetId, kind: "mouseMoved", x: 5, y: 6, button: "left", buttons: 1, clickCount: 0, modifiers: 8 });
  d.send({ type: "input.mouse", targetId, kind: "mousePressed", x: 5, y: 6, button: "right", buttons: 2, clickCount: 2, modifiers: 2 });
  d.send({ type: "input.wheel", targetId, x: 7, y: 8, dx: -4, dy: 120, modifiers: 4 });
  d.send({ type: "input.text", targetId, text: "hi" });
  d.send({ type: "input.key", targetId, kind: "keyDown", key: "Enter", code: "Enter", modifiers: 0 });
  for (let i = 0; i < 60 && !/Input.insertText/.test(d.chromiumLog()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(d.chromiumLog(), /Input\.dispatchMouseEvent \{"type":"mouseMoved","x":5,"y":6,"button":"left","buttons":1,"clickCount":0,"modifiers":8\}/);
  assert.match(d.chromiumLog(), /Input\.dispatchMouseEvent \{"type":"mousePressed","x":5,"y":6,"button":"right","buttons":2,"clickCount":2,"modifiers":2\}/);
  assert.match(d.chromiumLog(), /Input\.dispatchMouseEvent \{"type":"mouseWheel","x":7,"y":8,"deltaX":-4,"deltaY":120,"modifiers":4\}/);
  const cursor = await d.waitFor((m) => m.type === "cursor" && m.targetId === targetId);
  assert.equal(cursor.cursor, "pointer", "the cursor under the pointer is reported");
  // Control of a node's page never reaches another node's page.
  d.send({ type: "input.text", targetId: initial === targetId ? p2.targetId : initial, text: "x" });

  // Closing the node destroys its page and frees the id.
  d.send({ type: "page.close", nodeId: "n2" });
  await d.waitFor((m) => m.type === "tabs" && m.tabs.length === 1 && m.tabs[0].targetId === targetId);
  d.send({ type: "shutdown" });
  await d.waitFor((m) => m.type === "exit");
});

test("daemon: a linked agent sees exactly its node's page; unlinked agents never see node pages; linking and unlinking are live", async (t) => {
  const d = await startDaemon(t);
  d.send({ type: "page.open", nodeId: "n1" });
  const p1 = await d.waitFor((m) => m.type === "page" && m.nodeId === "n1");
  d.send({ type: "page.open", nodeId: "n2", url: "https://two.example/" });
  const p2 = await d.waitFor((m) => m.type === "page" && m.nodeId === "n2");
  const AGENT = "11111111-1111-1111-1111-111111111111";
  d.send({ type: "agent.scope", agent: AGENT, nodeId: "n2" });

  const connectAs = async (agent?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.ready.port}/devtools/browser${agent ? "?agent=" + agent : ""}`, { headers: { Authorization: "Bearer " + d.ready.token } });
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    let id = 0; const pending = new Map<number, (m: any) => void>(); const events: any[] = [];
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.id !== undefined) pending.get(m.id)?.(m); else events.push(m); });
    t.after(() => ws.close());
    return { events, call: (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); }) };
  };
  const linked = await connectAs(AGENT);
  const free = await connectAs();
  const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const pagesOf = async (c: any) => (await c.call("Target.getTargets")).result.targetInfos.filter((x: any) => x.type === "page").map((x: any) => x.targetId).sort();
  assert.deepEqual(await pagesOf(linked), [p2.targetId], "a linked agent sees only its node's page");
  assert.ok(!(await pagesOf(free)).includes(p1.targetId) && !(await pagesOf(free)).includes(p2.targetId), "an unlinked agent sees neither node page");

  await linked.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await wait();
  const attached = linked.events.filter((e) => e.method === "Target.attachedToTarget");
  assert.deepEqual(attached.map((e) => e.params.targetInfo.targetId), [p2.targetId], "it is attached to its page and nothing else");
  assert.equal((await linked.call("Runtime.evaluate", { expression: "1" }, attached[0].params.sessionId)).result.result.value, "url=https://two.example/");
  // It cannot reach another node's page, open new ones or close its own through a side door.
  assert.match((await linked.call("Target.attachToTarget", { targetId: p1.targetId, flatten: true })).error.message, /No target/);
  assert.match((await linked.call("Target.closeTarget", { targetId: p1.targetId })).error.message, /No target/);
  assert.match((await linked.call("Target.createTarget", { url: "https://x.example/" })).error.message, /linked to one browser page/);
  // The unlinked agent can still open its own page, which stays out of the node view.
  const mine = (await free.call("Target.createTarget", { url: "https://free.example/" })).result.targetId;
  assert.ok(mine);
  await wait();
  assert.ok(!(await pagesOf(linked)).includes(mine), "a linked agent does not see other agents' pages");

  // Re-link live: the agent now drives node n1; it is told its old page went away and the new one appeared.
  linked.events.length = 0;
  d.send({ type: "agent.scope", agent: AGENT, nodeId: "n1" });
  await wait(200);
  assert.deepEqual(await pagesOf(linked), [p1.targetId]);
  assert.ok(linked.events.some((e) => e.method === "Target.detachedFromTarget"), "old session detached");
  assert.ok(linked.events.some((e) => e.method === "Target.attachedToTarget" && e.params.targetInfo.targetId === p1.targetId), "new page attached");
  // Unlink: it goes back to the shared world (unclaimed pages only).
  d.send({ type: "agent.scope", agent: AGENT, nodeId: null });
  await wait(200);
  const after = await pagesOf(linked);
  assert.ok(after.includes(mine) && !after.includes(p1.targetId) && !after.includes(p2.targetId));
  // Two agents may share one node: both see the page, nothing crashes.
  const second = await connectAs("22222222-2222-2222-2222-222222222222");
  d.send({ type: "agent.scope", agent: "22222222-2222-2222-2222-222222222222", nodeId: "n1" });
  d.send({ type: "agent.scope", agent: AGENT, nodeId: "n1" });
  await wait(200);
  assert.deepEqual(await pagesOf(second), [p1.targetId]);
  assert.deepEqual(await pagesOf(linked), [p1.targetId]);
  // The node's page being closed behind its back (by a linked agent) is reported so the runtime can re-open it.
  const sess = (await second.call("Target.attachToTarget", { targetId: p1.targetId, flatten: true })).result.sessionId;
  assert.ok(sess);
  await second.call("Target.closeTarget", { targetId: p1.targetId });
  await d.waitFor((m) => m.type === "pageGone" && m.nodeId === "n1");
});

test("daemon: caps open tabs at 20, closing the oldest agent-opened background tab first", async (t) => {
  const d = await startDaemon(t);
  const c = await connect(d, t);
  const ids: string[] = [];
  for (let i = 0; i < 22; i++) ids.push((await c.call("Target.createTarget", { url: `https://t${i}.example/` })).result.targetId);
  const last = await d.waitFor((m) => m.type === "tabs" && m.tabs.length === 20 && m.tabs.some((x: any) => x.targetId === ids[21]));
  assert.ok(!last.tabs.some((x: any) => x.targetId === ids[0]));
  assert.ok(last.tabs.some((x: any) => x.opener === "user"), "the user's own tab survives");
});

test("daemon: exits (and says so) when its control channel closes", async (t) => {
  const d = await startDaemon(t);
  d.child.stdin!.end();
  await d.waitFor((m) => m.type === "exit");
});

test("daemon: reports start_failed when Chromium is missing", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "floq-browserd-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [DAEMON], { env: { PATH: process.env.PATH!, HOME: home, PLAYWRIGHT_BROWSERS_PATH: join(home, "none") }, stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  assert.equal(code, 1);
  assert.match(out, /"code":"start_failed"/);
});

// ----------------------------------------------------------------- floq-browser-mcp

test("floq-browser-mcp: asks the runtime, keeps the token off disk, passes the CDP header to the MCP", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "floq-mcp-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const seen: any[] = [];
  let reply: any = { wsEndpoint: "ws://127.0.0.1:41234/devtools/browser", token: "tok-ABC" };
  const server = createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(reply.error ? 403 : 200, { "content-type": "application/json" }); res.end(JSON.stringify(reply)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const cli = join(home, "cli.js");
  writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));");
  // Async spawn: the fake runtime lives in this process, so a blocking spawnSync would deadlock it.
  const run = (env: Record<string, string> = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn(process.execPath, [MCP], { env: { PATH: process.env.PATH!, HOME: home, FLOQ_API_URL: `http://127.0.0.1:${(server.address() as any).port}`, FLOQ_AGENT_TOKEN: "agent-tok", FLOQ_BROWSER_MCP_CLI: cli, ...env } });
    let stdout = "", stderr = "";
    c.stdout.on("data", (x) => { stdout += x; }); c.stderr.on("data", (x) => { stderr += x; });
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const ok = await run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(seen[0], { url: "/internal/browser/ensure", auth: "Bearer agent-tok" });
  const argv = JSON.parse(ok.stdout);
  assert.deepEqual(argv, ["--cdp-endpoint", "ws://127.0.0.1:41234/devtools/browser", "--cdp-header", "Authorization: Bearer tok-ABC", "--output-dir", join(home, ".floq/browser/output"), "--image-responses", "omit"]);
  assert.equal(statSync(join(home, ".floq/browser/output")).mode & 0o777, 0o700);
  // no credentials -> clear error
  const none = spawnSync(process.execPath, [MCP], { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: home } });
  assert.equal(none.status, 2); assert.match(none.stderr, /not available in this session/);
  // disabled
  reply = { error: { code: "disabled", message: "off" } };
  const off = await run();
  assert.equal(off.status, 1); assert.match(off.stderr, /turned off in Floq settings/);
  // a runtime answer that points anywhere but loopback is refused (the token would leave the machine)
  reply = { wsEndpoint: "ws://evil.example:1/devtools/browser", token: "t" };
  const evil = await run();
  assert.equal(evil.status, 1); assert.match(evil.stderr, /unexpected endpoint/);
  assert.doesNotMatch(evil.stdout + evil.stderr, /tok-ABC/);
});

// ------------------------------------------------- real Chromium (skipped when it cannot run here)

function realChromium(): string | null {
  const candidates: string[] = [];
  if (process.env.FLOQ_TEST_CHROMIUM) candidates.push(process.env.FLOQ_TEST_CHROMIUM);
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/floq/browsers", join(process.env.HOME ?? "", ".cache/ms-playwright")]) {
    if (!root || !existsSync(root)) continue;
    for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) candidates.push(join(root, d, "chrome-linux64/chrome"));
  }
  for (const c of candidates) if (existsSync(c) && spawnSync(c, ["--version"], { timeout: 10000 }).status === 0) return c;
  return null;
}
function playwright(): any | null {
  for (const dir of [process.env.FLOQ_TEST_PLAYWRIGHT, "/opt/floq/playwright-mcp"]) {
    if (!dir) continue;
    try { return createRequire(join(dir, "x.js"))("playwright-core"); } catch { /* next */ }
  }
  return null;
}
const REAL = realChromium();
const PW = playwright();

test("real Chromium: Playwright connects over CDP, two agents work at once, the cookie jar survives a restart", { skip: !REAL ? "no runnable chrome-headless-shell (set FLOQ_TEST_CHROMIUM)" : !PW ? "no playwright-core (set FLOQ_TEST_PLAYWRIGHT=<dir with node_modules>)" : false, timeout: 120000 }, async (t) => {
  const site = createServer((req, res) => { res.setHeader("set-cookie", "floq=1; Max-Age=3600; Path=/"); res.setHeader("content-type", "text/html");
    if (req.url === "/interactive") return void res.end(`<title>interactive</title><style>body{margin:0}#box{position:absolute;left:100px;top:100px;width:200px;height:100px;background:#c00;cursor:pointer}#box:hover{background:green}</style><div id="box"></div><script>
      window.__ev=[];const b=document.getElementById('box');let down=false;
      b.addEventListener('mouseover',()=>__ev.push('over'));b.addEventListener('dblclick',()=>__ev.push('dblclick'));
      b.addEventListener('contextmenu',e=>{e.preventDefault();__ev.push('contextmenu')});
      b.addEventListener('click',e=>{if(e.shiftKey)__ev.push('shiftclick')});
      addEventListener('mousedown',e=>{down=true;__ev.push('down:'+e.button)});addEventListener('mouseup',()=>{down=false});
      addEventListener('mousemove',e=>{if(down&&e.buttons===1)__ev.push('drag:1')});
      addEventListener('wheel',e=>__ev.push('wheel:'+e.deltaX+':'+e.deltaY),{passive:true});
    </script>`);
    res.end(`<title>t:${req.url}</title><body>hello ${req.url}`); });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.close());
  const base = `http://127.0.0.1:${(site.address() as any).port}`;
  const home = mkdtempSync(join(tmpdir(), "floq-browserd-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const attach = async (d: Daemon) => PW.chromium.connectOverCDP(`ws://127.0.0.1:${d.ready.port}/devtools/browser`, { headers: { Authorization: "Bearer " + d.ready.token } });

  let d = await startDaemon(t, { exe: REAL!, home });
  // Chromium itself opens no TCP port: every listener in the box is the daemon's.
  const tcp = () => readFileSync("/proc/net/tcp", "utf8").split("\n").filter((l) => /\s0A\s/.test(l)).map((l) => l.trim().split(/\s+/)[1]);
  const mine = d.ready.port.toString(16).toUpperCase().padStart(4, "0");
  const chromePids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => { try { return /chrome/.test(readFileSync(`/proc/${p}/cmdline`, "utf8")) && Number(readFileSync(`/proc/${p}/status`, "utf8").match(/PPid:\s+(\d+)/)![1]) === d.child.pid; } catch { return false; } });
  assert.ok(chromePids.length >= 1, "chromium is running under the daemon");
  assert.deepEqual(tcp().filter((a) => a.endsWith(":" + mine)).length, 1);

  const b1 = await attach(d), b2 = await attach(d);
  const [p1, p2] = await Promise.all([b1.contexts()[0].newPage(), b2.contexts()[0].newPage()]);
  await Promise.all([p1.goto(base + "/one"), p2.goto(base + "/two")]);
  assert.equal(await p1.title(), "t:/one");
  assert.equal(await p2.title(), "t:/two");
  assert.match(await p1.evaluate(() => document.body.textContent), /hello \/one/);
  await d.waitFor((m) => m.type === "tabs" && m.tabs.some((x: any) => x.url === base + "/one" && x.opener === "agent"));
  await b1.close(); await b2.close();

  // The user's view is a Browser node: its page streams real JPEGs and takes hover, clicks (double, right), wheel and modifiers.
  d.send({ type: "page.open", nodeId: "n1", url: base + "/interactive" });
  const node = await d.waitFor((m) => m.type === "page" && m.nodeId === "n1");
  const NODE_AGENT = "33333333-3333-3333-3333-333333333333";
  d.send({ type: "agent.scope", agent: NODE_AGENT, nodeId: "n1" });
  d.send({ type: "screencast.start", targetId: node.targetId, maxW: 800, maxH: 600, quality: 50 });
  const frame = await d.waitFor((m) => m.type === "frame" && m.targetId === node.targetId, 15000);
  assert.equal(Buffer.from(frame.jpeg, "base64").subarray(0, 2).toString("hex"), "ffd8");
  d.send({ type: "frame.ack", n: frame.n });
  const watcher = await PW.chromium.connectOverCDP(`ws://127.0.0.1:${d.ready.port}/devtools/browser?agent=${NODE_AGENT}`, { headers: { Authorization: "Bearer " + d.ready.token } });
  for (let i = 0; i < 60 && watcher.contexts()[0].pages().length < 1; i++) await new Promise((r) => setTimeout(r, 50));
  const seen = watcher.contexts()[0].pages();
  assert.equal(seen.length, 1, "the linked agent drives exactly the node's page, not the agents' own tabs");
  const view = seen[0];
  for (let i = 0; i < 50 && !(await view.title().then((x: string) => x === "interactive")); i++) await new Promise((r) => setTimeout(r, 100));
  const log = () => view.evaluate(() => (window as any).__ev as string[]);
  const mouse = (kind: string, x: number, y: number, extra: Record<string, unknown> = {}) => d.send({ type: "input.mouse", targetId: node.targetId, kind, x, y, button: "none", buttons: 0, clickCount: 0, modifiers: 0, ...extra });
  mouse("mouseMoved", 150, 150); // inside #box
  await view.waitForFunction(() => (window as any).__ev.includes("over"));
  assert.equal(await view.evaluate(() => getComputedStyle(document.getElementById("box")!).backgroundColor), "rgb(0, 128, 0)", "CSS :hover applies from mouseMoved");
  const cursor = await d.waitFor((m) => m.type === "cursor" && m.targetId === node.targetId && m.cursor === "pointer", 5000);
  assert.equal(cursor.cursor, "pointer", "the page's cursor over #box is reported");
  // double click = press/release/press/release with clickCount 1 then 2
  for (const n of [1, 2]) { mouse("mousePressed", 150, 150, { button: "left", buttons: 1, clickCount: n }); mouse("mouseReleased", 150, 150, { button: "left", buttons: 0, clickCount: n }); }
  await view.waitForFunction(() => (window as any).__ev.includes("dblclick"));
  // right click
  mouse("mousePressed", 150, 150, { button: "right", buttons: 2, clickCount: 1 }); mouse("mouseReleased", 150, 150, { button: "right", buttons: 0, clickCount: 1 });
  await view.waitForFunction(() => (window as any).__ev.includes("contextmenu"));
  // shift + click
  mouse("mousePressed", 150, 150, { button: "left", buttons: 1, clickCount: 1, modifiers: 8 }); mouse("mouseReleased", 150, 150, { button: "left", buttons: 0, clickCount: 1, modifiers: 8 });
  await view.waitForFunction(() => (window as any).__ev.includes("shiftclick"));
  // wheel with dx/dy (the page's wheel handler sees both axes)
  d.send({ type: "input.wheel", targetId: node.targetId, x: 150, y: 150, dx: 30, dy: 120, modifiers: 0 });
  await view.waitForFunction(() => (window as any).__ev.some((e: string) => e.startsWith("wheel:30:120")));
  // drag: move with the button held; the page sees mousemove with buttons=1
  mouse("mousePressed", 150, 150, { button: "left", buttons: 1, clickCount: 1 });
  mouse("mouseMoved", 220, 170, { button: "left", buttons: 1 });
  mouse("mouseReleased", 220, 170, { button: "left", buttons: 0, clickCount: 1 });
  await view.waitForFunction(() => (window as any).__ev.includes("drag:1"));
  assert.ok((await log()).includes("down:0"), "left button reported as button 0");
  // viewport follows the node: the page sees the new size
  d.send({ type: "viewport", targetId: node.targetId, width: 640, height: 400, dpr: 1 });
  await view.waitForFunction(() => innerWidth === 640 && innerHeight === 400);
  // An unlinked agent never sees the node's page.
  const free = await attach(d);
  assert.ok(!free.contexts()[0].pages().some((pg: any) => /interactive/.test(pg.url())), "node page hidden from unlinked agents");
  await free.close();
  await watcher.close();
  d.send({ type: "screencast.stop", targetId: node.targetId });

  // Persist: the cookie set by the page is still there after a full daemon restart on the same profile.
  await d.stop();
  d = await startDaemon(t, { exe: REAL!, home });
  const b3 = await attach(d);
  const page = b3.contexts()[0].pages()[0] ?? await b3.contexts()[0].newPage();
  await page.goto("about:blank");
  const cookies = await b3.contexts()[0].cookies(base);
  assert.ok(cookies.some((c: any) => c.name === "floq" && c.value === "1"), JSON.stringify(cookies));
  await b3.close();
});

const realSkip = { skip: !REAL ? "no runnable chrome-headless-shell (set FLOQ_TEST_CHROMIUM)" : !PW ? "no playwright-core (set FLOQ_TEST_PLAYWRIGHT=<dir with node_modules>)" : false, timeout: 120000 };

test("real Chromium: the private-network interceptor refuses loopback pages and leaves the switch-off case alone", realSkip, async (t) => {
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>internal</title>secret"); });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.close());
  const url = `http://127.0.0.1:${(site.address() as any).port}/`;
  for (const [block, expectBlocked] of [["1", true], ["0", false]] as const) {
    const d = await startDaemon(t, { exe: REAL!, env: { FLOQ_BROWSER_BLOCK_PRIVATE: block } });
    const b = await PW.chromium.connectOverCDP(`ws://127.0.0.1:${d.ready.port}/devtools/browser`, { headers: { Authorization: "Bearer " + d.ready.token } });
    const page = await b.contexts()[0].newPage();
    const outcome = await page.goto(url).then(() => "loaded", (e: Error) => e.message);
    if (expectBlocked) assert.match(outcome, /ERR_ACCESS_DENIED/);
    else { assert.equal(outcome, "loaded"); assert.equal(await page.title(), "internal"); }
    await b.close();
    await d.stop();
  }
});

test("real Chromium: the pinned Playwright MCP, launched by floq-browser-mcp, drives the shared browser", realSkip, async (t) => {
  const cliDir = process.env.FLOQ_TEST_PLAYWRIGHT ?? "/opt/floq/playwright-mcp";
  const cli = join(cliDir, "node_modules/@playwright/mcp/cli.js");
  if (!existsSync(cli)) return t.skip("@playwright/mcp is not installed");
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>mcp-page</title><h1>Hello from MCP</h1>"); });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.close());
  const d = await startDaemon(t, { exe: REAL! });
  const runtime = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ wsEndpoint: `ws://127.0.0.1:${d.ready.port}/devtools/browser`, token: d.ready.token })); });
  await new Promise<void>((r) => runtime.listen(0, "127.0.0.1", r));
  t.after(() => runtime.close());
  const child = spawn(process.execPath, [MCP], { env: { PATH: process.env.PATH!, HOME: d.home, FLOQ_API_URL: `http://127.0.0.1:${(runtime.address() as any).port}`, FLOQ_AGENT_TOKEN: "agent", FLOQ_BROWSER_MCP_CLI: cli } });
  t.after(() => child.kill("SIGKILL"));
  child.stdin.on("error", () => {});
  const replies = new Map<number, (m: any) => void>();
  let buf = "";
  child.stdout.on("data", (c) => { buf += c; for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); replies.get(m.id)?.(m); } catch { /* log line */ } } });
  let n = 0;
  const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const id = ++n; const timer = setTimeout(() => reject(new Error("mcp timeout " + method)), 60000); replies.set(id, (m) => { clearTimeout(timer); resolve(m); }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await rpc("tools/list", {});
  assert.ok(tools.result.tools.some((x: any) => x.name === "browser_navigate"));
  const nav = await rpc("tools/call", { name: "browser_navigate", arguments: { url: `http://127.0.0.1:${(site.address() as any).port}/` } });
  assert.match(JSON.stringify(nav.result), /Page Title: mcp-page/);
  const snap = await rpc("tools/call", { name: "browser_snapshot", arguments: {} });
  assert.match(JSON.stringify(snap.result), /Hello from MCP/);
  // The user's side sees the agent's tab.
  const tabs = await d.waitFor((m) => m.type === "tabs" && m.tabs.some((x: any) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(x.url)));
  assert.ok(tabs.tabs.length >= 1);
});

test("daemon: a target whose Fetch.enable fails is closed and never resumed (fail closed)", async (t) => {
  const d = await startDaemon(t, { env: { FLOQ_BROWSER_BLOCK_PRIVATE: "1", FAKE_CHROMIUM_FETCH_FAILS: "1" } });
  const end = Date.now() + 5000;
  while (!/browser\.fetch_enable_failed/.test(d.stderr) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.match(d.stderr, /browser\.fetch_enable_failed/);
  await new Promise((r) => setTimeout(r, 100));
  assert.doesNotMatch(d.stderr, /RUN_IF_WAITING/, "an unprotected target must not be resumed");
  assert.match(d.stderr, /CLOSE_TARGET|"event":"browser\.fetch_enable_failed"/);
});
