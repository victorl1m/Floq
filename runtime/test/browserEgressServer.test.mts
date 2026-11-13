import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer as createNetServer } from "node:net";
import type pg from "pg";
import WebSocket from "ws";
import { BrowserService } from "../dist/browser.js";
import { EgressHub } from "../dist/browserEgress.js";
import { RecordStream, T, decodeFrame, encodeFrame, encodeHello, encodeOpen, lengthPrefixed } from "../dist/egressCodec.js";
import { createRuntimeServer } from "../dist/server.js";
import { SettingsStore } from "../dist/settings.js";
import { Vault } from "../dist/vault.js";

const key = Buffer.alloc(32, 9);
const ORIGIN = "https://app.test";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await wait(5); } };
const freePort = () => new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); }); });
const TOKENS: Record<string, string> = { "tok-alice": "alice", "tok-bob": "bob" };

type FakeChild = EventEmitter & { user: string; spec: any; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; stdio: any[]; toRuntime: PassThrough; fromRuntime: Buffer[]; frames(): any[]; kill(): boolean; emitOut(m: unknown): void };

function fakeDaemon(user: string, spec: any): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.user = user; c.spec = spec;
  c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
  // fd 3: what the runtime writes to the daemon (fromRuntime) and what the daemon sends (toRuntime)
  const fd3 = Object.assign(new PassThrough(), {});
  c.toRuntime = fd3;
  c.fromRuntime = [];
  const rs = new RecordStream((r) => c.fromRuntime.push(r), () => undefined);
  const wrapper = new EventEmitter() as EventEmitter & { writable: boolean; write(b: Buffer): boolean; destroy(): void };
  wrapper.writable = true;
  wrapper.write = (b: Buffer) => { rs.push(b); return true; };
  wrapper.destroy = () => undefined;
  fd3.on("data", (d: Buffer) => wrapper.emit("data", d));
  c.stdio = [c.stdin, c.stdout, c.stderr, spec.extraPipe ? wrapper : undefined];
  c.frames = () => c.fromRuntime.map((r) => decodeFrame(r)).flatMap((d) => (d.ok ? [d.frame] : []));
  c.stdin.on("data", (d: Buffer) => { for (const line of d.toString().split("\n").filter(Boolean)) { const m = JSON.parse(line); if (m.type === "shutdown") { c.stdout.end(); setImmediate(() => c.emit("exit", 0, null)); } } });
  c.emitOut = (m) => c.stdout.write(JSON.stringify(m) + "\n");
  c.kill = () => { c.stdout.end(); setImmediate(() => c.emit("exit", null, "SIGKILL")); return true; };
  setImmediate(() => c.emitOut({ type: "ready", port: user === "alice" ? 40001 : 40002, token: (user === "alice" ? "a" : "b").repeat(64), pid: 1, sandbox: "on" }));
  return c;
}

async function harness(t: test.TestContext, modes: Record<string, string>) {
  const children: FakeChild[] = [];
  const shards = {
    awakeHandle: (u: string) => ({ userId: u, uid: u === "alice" ? 1 : 2, mountPath: "/m/" + u }),
    wake: async (u: string) => ({ userId: u, uid: 1, mountPath: "/m/" + u }),
    driver: { hostPath: () => "", spawnPipe: (h: { userId: string }, spec: any) => { const c = fakeDaemon(h.userId, spec); children.push(c); return c; } },
  };
  const settingsPort = { agentBrowser: async () => true, agentBrowserEgress: async (u: string) => (modes[u] ?? "server") as any };
  const browser = new BrowserService(shards as any, settingsPort, { sync: async () => ({ claude: "unchanged", codex: "unchanged" }) } as any, { mode: "auto", idleMs: 0, memMb: 0, allowPrivate: false, browsersDir: "/x", version: { chromium: "157", revision: "1", playwrightMcp: "0" }, stopWaitMs: 100, startTimeoutMs: 1000 }, () => false);
  browser.egress = new EgressHub({ onChange: (u, rttOnly) => browser.onEgressChange(u, rttOnly) });
  const pool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error("unused"); } };
  const vault = new Vault(pool as never, { encryptionKey: key } as never);
  const auth = { handler() {}, api: { getSession: async ({ headers }: { headers: Headers }) => { const user = TOKENS[(headers.get("authorization") ?? "").replace("Bearer ", "")]; return user ? { user: { id: user }, session: { id: "s-" + user } } : null; } } };
  const settings = { async profile() { return {}; }, async get() { return {}; }, async update() { return {}; } };
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [ORIGIN], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y", providers: { claude: "claude", codex: "codex", shell: "bash" }, codexModelsOverridden: true, models: { claude: [], codex: [] }, authSecret: "x".repeat(40) };
  const manager = { activeCount: 0, getLive() { throw new Error("gone"); }, findLive: () => undefined };
  const server = createRuntimeServer({ config, manager, auth, settings, github: {}, vault, orchestrator: {}, pool, credentials: {}, claudeOauth: {}, usage: {}, claudeConnectors: {}, skills: {}, gitReview: {}, browser } as never);
  await server.listen();
  t.after(async () => { await browser.shutdown(); browser.egress?.close(); await server.close(); });
  /** Opens /v1/browser/egress; resolves with the socket and frames received, or the status of a refused upgrade. */
  const open = (opts: { query?: string; origin?: string | null; headers?: Record<string, string>; protocols?: string[] } = {}) => new Promise<{ status: number; ws?: WebSocket; frames?: Buffer[]; closed?: () => [number, string] | null }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/browser/egress${opts.query ?? ""}`, opts.protocols ?? [], { headers: { ...(opts.origin === null ? {} : { Origin: opts.origin ?? ORIGIN }), ...(opts.headers ?? {}) } });
    const frames: Buffer[] = [];
    let closed: [number, string] | null = null;
    ws.on("message", (d, isBinary) => { if (isBinary) frames.push(d as Buffer); });
    ws.on("close", (code, reason) => { closed = [code, reason.toString()]; });
    ws.on("open", () => resolve({ status: 101, ws, frames, closed: () => closed }));
    ws.on("unexpected-response", (_r, res) => { resolve({ status: res.statusCode! }); res.resume(); });
    ws.on("error", () => undefined);
  });
  return { open, children, browser, port };
}
const bearer = (who: string) => ({ Authorization: "Bearer tok-" + who });
const parse = (b: Buffer) => { const d = decodeFrame(b); return d.ok ? d.frame : null; };

test("/v1/browser/egress: refuses no token, a token in the URL or subprotocol, a bad token and a foreign origin; accepts the header", async (t) => {
  const { open, children } = await harness(t, { alice: "desktop" });
  assert.equal((await open({ origin: null })).status, 401, "no Authorization header");
  assert.equal((await open({ origin: null, headers: bearer("alice"), query: "?token=tok-alice" })).status, 400, "token in the query is refused even with a header");
  assert.equal((await open({ origin: null, query: "?token=tok-alice" })).status, 400, "token in the query");
  assert.equal((await open({ origin: null, protocols: ["floq.v1", "floq.bearer.tok-alice"] })).status, 400, "token in a subprotocol");
  assert.equal((await open({ origin: null, headers: { Authorization: "Bearer nope" } })).status, 401, "wrong token");
  assert.equal((await open({ origin: "https://evil.test", headers: bearer("alice") })).status, 403, "foreign origin");
  assert.equal(children.length, 0, "a refused socket never starts anything");
  const ok = await open({ origin: null, headers: bearer("alice") });
  assert.equal(ok.status, 101);
  // Interop (H1): a faithful desktop speaks only AFTER the runtime's HELLO, exactly like src-tauri/src/egress.rs.
  await until(() => ok.frames!.length > 0);
  const first = JSON.parse(parse(ok.frames![0])!.payload.toString());
  assert.equal(first.v, 1); assert.equal(first.role, "runtime");
  assert.equal(ok.frames!.length, 1, "nothing else before the desktop answers");
  ok.ws!.send(encodeHello({ v: 1, caps: ["connect"], machine: "Test Mac" }));
  await until(() => ok.frames!.length > 1);
  assert.deepEqual(JSON.parse(parse(ok.frames![1])!.payload.toString()), { v: 1, standby: false });
  ok.ws!.close();
});

test("a desktop is paired with its own user's browser only; modes route spawn and fd 3; paused is reported", async (t) => {
  const { open, children, browser } = await harness(t, { alice: "desktop", bob: "server" });
  // Alice's browser starts with the relay pipe and the desktop env; Bob's (server mode) has neither.
  const a = await browser.ensure("alice", { wake: true });
  const b = await browser.ensure("bob", { wake: true });
  const [ca, cb] = [children.find((c) => c.user === "alice")!, children.find((c) => c.user === "bob")!];
  assert.equal(ca.spec.extraPipe, true);
  assert.equal(ca.spec.env.FLOQ_BROWSER_EGRESS, "desktop");
  assert.equal(cb.spec.extraPipe, undefined);
  assert.equal(cb.spec.env.FLOQ_BROWSER_EGRESS, "server");
  assert.equal(a.egress, "paused", "mode desktop and no desktop connected: the MCP wrapper is told once");
  assert.equal(b.egress, undefined);
  assert.deepEqual(ca.frames().map((f) => [f.type, f.payload[0]]), [[T.LINK, 0]], "daemon is told: no desktop");
  // Alice's desktop connects: LINK 1 reaches her daemon.
  const wa = await open({ origin: null, headers: bearer("alice") });
  wa.ws!.send(encodeHello({ v: 1, caps: ["connect"], machine: "Alice Mac" }));
  await until(() => ca.frames().some((f) => f.type === T.LINK && f.payload[0] === 1));
  assert.equal((await browser.ensure("alice")).egress, undefined, "no longer paused");
  assert.deepEqual(await browser.egressStatus("alice"), { mode: "desktop", effective: "desktop", state: "up", machine: "Alice Mac" });
  // Alice's daemon asks for a connection: it reaches Alice's desktop and nobody else's.
  const wb = await open({ origin: null, headers: bearer("bob") });
  wb.ws!.send(encodeHello({ v: 1, caps: ["connect"], machine: "Bob Mac" }));
  await until(() => wb.frames!.length > 0);
  ca.toRuntime.write(lengthPrefixed(encodeFrame(T.OPEN, 1, encodeOpen({ atyp: 3, host: "example.com", port: 443 }))));
  await until(() => wa.frames!.some((f) => parse(f)?.type === T.OPEN));
  await wait(50);
  assert.equal(wb.frames!.some((f) => parse(f)?.type === T.OPEN), false, "bob's desktop saw nothing of alice's browser");
  assert.equal(cb.frames().length, 0, "bob's server-mode browser has no relay at all");
  // The desktop closes: Alice's daemon is told (LINK 0) and her streams end.
  wa.ws!.close();
  await until(() => ca.frames().filter((f) => f.type === T.LINK).at(-1)?.payload[0] === 0);
  wb.ws!.close();
});

test("desktop-fallback: server route while the desktop is away, a restart onto the desktop when it connects, and back when it leaves", async (t) => {
  const modes = { alice: "desktop-fallback" };
  const { open, children, browser } = await harness(t, modes);
  await browser.ensure("alice", { wake: true });
  assert.equal(children[0].spec.env.FLOQ_BROWSER_EGRESS, "server", "desktop away: the server's connection, as chosen");
  assert.equal(children[0].spec.extraPipe, undefined);
  const wa = await open({ origin: null, headers: bearer("alice") });
  wa.ws!.send(encodeHello({ v: 1, caps: ["connect"], machine: "Alice Mac" }));
  await until(() => wa.frames!.length > 0);
  await browser.reconcileEgress("alice", 0); // the hub's own call is debounced 1.5 s; same path
  await until(() => children.length === 2, 5000);
  assert.equal(children[1].spec.env.FLOQ_BROWSER_EGRESS, "desktop");
  assert.equal(children[1].spec.extraPipe, true);
  wa.ws!.close();
  await until(() => children[1].frames().some((f) => f.type === T.LINK && f.payload[0] === 0));
  await browser.reconcileEgress("alice", 0);
  await until(() => children.length === 3, 5000);
  assert.equal(children[2].spec.env.FLOQ_BROWSER_EGRESS, "server", "back to the server connection, with the badge showing the truth");
});

test("'Use server this time' is a transient override: the setting stays, routing goes to the server, and it ends when the desktop comes back (M3)", async (t) => {
  const { open, children, browser, port } = await harness(t, { alice: "desktop" });
  await browser.ensure("alice", { wake: true });
  assert.equal(children[0].spec.env.FLOQ_BROWSER_EGRESS, "desktop");
  const post = (body: unknown, who = "alice") => fetch(`http://127.0.0.1:${port}/v1/browser/egress/override`, { method: "POST", headers: { ...bearer(who), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ server: "yes" })).status, 400);
  const res = await post({ server: true });
  assert.equal(res.status, 200);
  const st = await res.json() as Record<string, unknown>;
  assert.equal(st.mode, "desktop", "the persisted setting is untouched");
  assert.equal(st.override, true);
  assert.equal(st.state, "down");
  await until(() => children.length === 2, 5000);
  assert.equal(children[1].spec.env.FLOQ_BROWSER_EGRESS, "server");
  assert.equal(children[1].spec.extraPipe, undefined);
  // A desktop that connects while the override is on does not end it (it was down when the override began)... then going down and up again does.
  const w = await open({ origin: null, headers: bearer("alice") });
  w.ws!.send(encodeHello({ v: 1, caps: ["connect"], machine: "Alice Mac" }));
  await until(() => w.frames!.length > 1);
  await wait(50);
  assert.equal((await browser.egressStatus("alice")).override, undefined, "the desktop came up after having been down: the override is over");
  await browser.reconcileEgress("alice", 0);
  await until(() => children.length === 3, 5000);
  assert.equal(children[2].spec.env.FLOQ_BROWSER_EGRESS, "desktop", "back on the desktop route");
  w.ws!.close();
});

test("settings: agentBrowserEgress accepts only the three modes and defaults to server", async () => {
  const row: Record<string, unknown> = { user_id: "u1" };
  let exists = false;
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("SELECT * FROM user_settings")) return { rows: exists ? [row] : [] };
      if (sql.startsWith("SELECT login")) return { rows: [] };
      if (sql.startsWith("SELECT agent_browser_egress")) return { rows: exists ? [row] : [] };
      if (sql.startsWith("INSERT INTO user_settings")) { exists = true; return { rows: [] }; }
      if (sql.startsWith("UPDATE user_settings")) { if (sql.includes("agent_browser_egress = $2")) row.agent_browser_egress = values[1]; return { rows: [] }; }
      throw new Error("unexpected query " + sql);
    },
  } as never as pg.Pool;
  const store = new SettingsStore(pool, { gitCoauthor: "", encryptionKey: Buffer.alloc(32) } as never);
  assert.equal((await store.get("u1")).agentBrowserEgress, "server");
  for (const bad of ["on", "", "DESKTOP", 1, null, true, {}]) await assert.rejects(store.update("u1", { agentBrowserEgress: bad as never }), /agentBrowserEgress/);
  assert.equal((await store.update("u1", { agentBrowserEgress: "desktop" })).agentBrowserEgress, "desktop");
  assert.equal(await store.agentBrowserEgress("u1"), "desktop");
  assert.equal((await store.update("u1", { agentBrowserEgress: "desktop-fallback" })).agentBrowserEgress, "desktop-fallback");
  assert.equal((await store.update("u1", { agentBrowserEgress: "server" })).agentBrowserEgress, "server");
});
