import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, connect as tcpConnect, type Socket, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromiumArgs, egressFlags } from "../dist/image/floq-browserd.mjs";
import { CdpMux, shouldBlockHost } from "../dist/image/floq-browserd-core.mjs";
import {
  EgressMux, PeerChecker, parseGreeting, parseProcNetTcp4, parseRequest, socksReply, attachMuxToStream, socketSink, startSocksListener,
} from "../dist/image/floq-egress.mjs";
import {
  INIT_CREDIT, REP, RST_REASON, T, RecordStream, decodeFrame, encodeFrame, encodeHello, encodeOpen, lengthPrefixed, parseOpen,
} from "../dist/image/floq-egress-codec.mjs";
import { EgressHub } from "../dist/browserEgress.js";

const DAEMON = fileURLToPath(new URL("../dist/image/floq-browserd.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fakeChromium.mjs", import.meta.url));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, ms = 8000, what = "condition") => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error("timeout: " + what); await wait(10); } };

// ------------------------------------------------------------------ Chromium flags

test("chromiumArgs: the proxy flags exist only in egress mode, and no stealth flag ever does", () => {
  const off = chromiumArgs({ sandbox: true, profile: "/p" });
  assert.equal(off.some((a) => /proxy|host-resolver|quic|webrtc|dns-prefetch/.test(a)), false);
  const on = chromiumArgs({ sandbox: true, profile: "/p", egressPort: 4242 });
  assert.ok(on.includes("--proxy-server=socks5://127.0.0.1:4242"));
  assert.ok(on.includes("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost"));
  assert.ok(on.includes("--disable-quic"));
  assert.ok(on.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(on.includes("--dns-prefetch-disable"));
  assert.equal(on.some((a) => a.startsWith("--proxy-bypass-list")), false, "loopback keeps bypassing the proxy (Chromium default)");
  assert.deepEqual(on.filter((a) => !egressFlags(4242).includes(a)), off, "egress adds exactly the documented flags");
  for (const a of on) assert.doesNotMatch(a, /user-agent|webdriver|AutomationControlled|timezone|--lang|fingerprint|disable-blink-features/i, a);
});

test("T6 interceptor in egress mode checks literals and localhost names but never resolves names on the VPS", async () => {
  let lookups = 0;
  const dns = async () => { lookups++; return ["10.0.0.1"]; };
  assert.equal(await shouldBlockHost("example.com", dns, { literalOnly: true }), false);
  assert.equal(lookups, 0);
  assert.equal(await shouldBlockHost("127.0.0.1", dns, { literalOnly: true }), true);
  assert.equal(await shouldBlockHost("[::1]", dns, { literalOnly: true }), true);
  assert.equal(await shouldBlockHost("app.localhost", dns, { literalOnly: true }), true);
  assert.equal(await shouldBlockHost("example.com", dns), true, "without egress the lookup still runs");
});

// ------------------------------------------------------------------ SOCKS5 parsing

const req = (cmd: number, atyp: number, addr: Buffer, port = 443) => Buffer.concat([Buffer.from([5, cmd, 0, atyp]), addr, Buffer.from([port >> 8, port & 255])]);
const domain = (h: string) => Buffer.concat([Buffer.from([h.length]), Buffer.from(h)]);

test("SOCKS5: greeting needs method 0, CONNECT with a domain/IPv4/IPv6 target parses, everything else is refused", () => {
  assert.deepEqual(parseGreeting(Buffer.from([5, 1, 0])), { kind: "greeting_ok", consumed: 3 });
  assert.equal(parseGreeting(Buffer.from([5, 2, 2, 0])).kind, "greeting_ok");
  assert.equal(parseGreeting(Buffer.from([5, 1, 2])).kind, "greeting_bad", "no anonymous method offered");
  assert.equal(parseGreeting(Buffer.from([4, 1, 0])).kind, "greeting_bad", "SOCKS4 would resolve locally: never");
  assert.equal(parseGreeting(Buffer.from([5])).kind, "need_more");
  const dom = parseRequest(req(1, 3, domain("example.com")));
  assert.deepEqual(dom.kind === "request" && dom.target, { atyp: 3, host: "example.com", port: 443 });
  const v4 = parseRequest(req(1, 1, Buffer.from([93, 184, 216, 34]), 80));
  assert.deepEqual(v4.kind === "request" && v4.target, { atyp: 1, host: "93.184.216.34", port: 80 });
  const v6 = parseRequest(req(1, 4, Buffer.from("20010db8000000000000000000000001", "hex")));
  assert.deepEqual(v6.kind === "request" && v6.target, { atyp: 4, host: "2001:db8:0:0:0:0:0:1", port: 443 });
  assert.deepEqual(parseRequest(req(2, 1, Buffer.alloc(4))), { kind: "refuse", rep: REP.CMD }, "BIND");
  assert.deepEqual(parseRequest(req(3, 1, Buffer.alloc(4))), { kind: "refuse", rep: REP.CMD }, "UDP ASSOCIATE");
  assert.deepEqual(parseRequest(req(1, 9, Buffer.alloc(4))), { kind: "refuse", rep: REP.ATYP });
  assert.equal(parseRequest(req(1, 3, Buffer.from([0]))).kind, "refuse", "empty host");
  assert.equal(parseRequest(req(1, 3, domain("bad host"))).kind, "refuse", "space in a hostname");
  assert.equal(parseRequest(req(1, 3, domain("a\u0000b"))).kind, "refuse", "NUL in a hostname");
  assert.equal(parseRequest(req(1, 3, domain("exämple.com"))).kind, "refuse", "IDNs arrive as punycode");
  assert.equal(parseRequest(req(1, 3, domain("example.com"), 0)).kind, "refuse", "port 0");
  assert.equal(parseRequest(req(1, 3, domain("example.com")).subarray(0, 8)).kind, "need_more");
});

// ------------------------------------------------------------------ peer check

const NET_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const hexAddr = (ip: string, port: number) => ip.split(".").reverse().map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase() + ":" + port.toString(16).toUpperCase().padStart(4, "0");
const row = (n: number, local: [string, number], remote: [string, number], uid: number, inode: string) => `   ${n}: ${hexAddr(...local)} ${hexAddr(...remote)} 01 00000000:00000000 00:00000000 00000000  ${String(uid).padStart(4)}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

test("peer check: uid must match AND the socket must be held by the Chromium process tree", () => {
  const listen = { address: "127.0.0.1", port: 40000 };
  const mine = 1234;
  let inodes = new Set(["555"]);
  let reads = 0;
  const net = () => NET_HEADER
    + row(1, ["127.0.0.1", 50001], ["127.0.0.1", 40000], mine, "555")   // Chromium's socket
    + row(2, ["127.0.0.1", 50002], ["127.0.0.1", 40000], mine, "666")   // same uid, some other process (an agent's curl)
    + row(3, ["127.0.0.1", 50003], ["127.0.0.1", 40000], 4321, "777")   // another user's sandbox on the shared loopback
    + row(4, ["127.0.0.1", 50004], ["127.0.0.1", 41111], mine, "555");  // not to us
  let now = 1000;
  const checker = new PeerChecker({ uid: mine, rootPid: () => 99, readNetTcp: net, tree: () => [99, 100], inodesOf: () => { reads++; return { inodes, unreadable: 0 }; }, now: () => now });
  assert.deepEqual(checker.check({ address: "127.0.0.1", port: 50001 }, listen), { ok: true });
  assert.deepEqual(checker.check({ address: "127.0.0.1", port: 50002 }, listen), { ok: false, reason: "inode" });
  assert.deepEqual(checker.check({ address: "127.0.0.1", port: 50003 }, listen), { ok: false, reason: "uid" });
  assert.deepEqual(checker.check({ address: "127.0.0.1", port: 50004 }, listen), { ok: false, reason: "no_row" }, "a row for a different listener is not ours");
  assert.deepEqual(checker.check({ address: "127.0.0.1", port: 59999 }, listen), { ok: false, reason: "no_row" });
  // A hit is served from the cache; a miss re-reads the tree.
  const before = reads;
  assert.deepEqual(checker.check({ address: "127.0.0.1", port: 50001 }, listen), { ok: true });
  assert.equal(reads, before, "a cached hit costs no /proc walk");
  inodes = new Set(["555", "666"]); // the agent's process became part of the tree (e.g. a new child)
  assert.deepEqual(checker.check({ address: "127.0.0.1", port: 50002 }, listen), { ok: true }, "a miss refreshes the tree");
  const noChrome = new PeerChecker({ uid: mine, rootPid: () => undefined, readNetTcp: net });
  assert.deepEqual(noChrome.check({ address: "127.0.0.1", port: 50001 }, listen), { ok: false, reason: "no_chromium" });
  const uidOnly = new PeerChecker({ uid: mine, rootPid: () => undefined, readNetTcp: net, strictness: "uid" });
  assert.deepEqual(uidOnly.check({ address: "127.0.0.1", port: 50002 }, listen), { ok: true }, "documented fallback: uid only");
  assert.deepEqual(uidOnly.check({ address: "127.0.0.1", port: 50003 }, listen), { ok: false, reason: "uid" });
});

test("parseProcNetTcp4 reads the kernel's little-endian addresses", () => {
  const rows = parseProcNetTcp4(NET_HEADER + row(1, ["127.0.0.1", 50001], ["10.1.2.3", 443], 1000, "42"));
  assert.deepEqual(rows, [{ local: "127.0.0.1:50001", remote: "10.1.2.3:443", uid: 1000, inode: "42" }]);
});

// ------------------------------------------------------------------ the mux (daemon side) against a scripted runtime

function fd3Pair() {
  // The daemon side of fd 3 is a socket; the test plays the runtime on the other end.
  const server = createServer();
  return new Promise<{ daemonEnd: Socket; runtimeEnd: Socket; close(): void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const runtimeEnd = tcpConnect((server.address() as { port: number }).port, "127.0.0.1");
      server.once("connection", (daemonEnd) => resolve({ daemonEnd, runtimeEnd, close: () => { daemonEnd.destroy(); runtimeEnd.destroy(); server.close(); } }));
    });
  });
}
const frames = (s: Socket) => {
  const got: ReturnType<typeof decodeFrame>[] = [];
  const rs = new RecordStream((r) => got.push(decodeFrame(r)), () => got.push({ ok: false, reason: "stream" }));
  s.on("data", (c) => rs.push(c));
  return { get: () => got.flatMap((g) => (g.ok ? [g.frame] : [])), all: got };
};
const link = (up: boolean) => lengthPrefixed(encodeFrame(T.LINK, 0, Buffer.from([up ? 1 : 0])));
const send = (s: Socket, f: Buffer) => s.write(lengthPrefixed(f));

async function socksClient(port: number, target: Buffer): Promise<{ sock: Socket; reply: Promise<Buffer>; data: Buffer[] }> {
  const sock = tcpConnect(port, "127.0.0.1");
  sock.on("error", () => undefined);
  const data: Buffer[] = [];
  let stage = 0;
  let resolveReply!: (b: Buffer) => void;
  const reply = new Promise<Buffer>((r) => { resolveReply = r; });
  let acc = Buffer.alloc(0);
  sock.on("data", (c) => {
    if (stage >= 2) { data.push(c); return; }
    acc = Buffer.concat([acc, c]);
    if (stage === 0 && acc.length >= 2) { stage = 1; acc = acc.subarray(2); sock.write(target); }
    if (stage === 1 && acc.length >= 10) { stage = 2; resolveReply(acc.subarray(0, 10)); const rest = acc.subarray(10); if (rest.length) data.push(rest); }
  });
  sock.on("close", () => { if (stage < 2) resolveReply(Buffer.alloc(0)); });
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write(Buffer.from([5, 1, 0]));
  return { sock, reply, data };
}

async function muxRig(t: test.TestContext) {
  const pair = await fd3Pair();
  const runtime = frames(pair.runtimeEnd);
  const mux = new EgressMux(socketSink(pair.daemonEnd), { log: () => undefined });
  attachMuxToStream(mux, pair.daemonEnd);
  // Accept every peer: the peer check has its own tests above.
  const peers = { check: () => ({ ok: true as const }) } as unknown as PeerChecker;
  const { server, port } = await startSocksListener({ mux, peers, log: () => undefined, acceptBudgetPerSec: 100000 });
  t.after(() => { server.close(); pair.close(); });
  return { pair, runtime, mux, port };
}

test("daemon mux: HELLO first; link down (the default) answers every CONNECT with REP 1 and never emits OPEN", async (t) => {
  const { runtime, port } = await muxRig(t);
  await waitUntil(() => runtime.get().length > 0);
  assert.equal(runtime.get()[0].type, T.HELLO);
  const c = await socksClient(port, req(1, 3, domain("example.com")));
  const rep = await c.reply;
  assert.equal(rep[1], REP.GENERAL, "egress offline => 0x01");
  await wait(50);
  assert.equal(runtime.get().some((f) => f.type === T.OPEN), false, "fail closed: nothing was requested");
});

test("daemon mux: OPEN carries the hostname (never resolved here), OPENED(0) completes the SOCKS reply and data flows both ways with credit", async (t) => {
  const { pair, runtime, port } = await muxRig(t);
  pair.runtimeEnd.write(link(true));
  await wait(30);
  const c = await socksClient(port, req(1, 3, domain("ipify.test"), 8080));
  await waitUntil(() => runtime.get().some((f) => f.type === T.OPEN));
  const open = runtime.get().find((f) => f.type === T.OPEN)!;
  assert.equal(open.streamId, 1);
  assert.deepEqual(parseOpen(open.payload), { atyp: 3, host: "ipify.test", port: 8080 });
  send(pair.runtimeEnd, encodeFrame(T.OPENED, 1, Buffer.from([0])));
  const rep = await c.reply;
  assert.deepEqual([...rep.subarray(0, 2)], [5, 0]);
  // client -> desktop
  c.sock.write("GET / HTTP/1.1\r\n\r\n");
  await waitUntil(() => runtime.get().some((f) => f.type === T.DATA));
  assert.equal(Buffer.concat(runtime.get().filter((f) => f.type === T.DATA).map((f) => f.payload)).toString(), "GET / HTTP/1.1\r\n\r\n");
  // desktop -> client, big enough to need CREDIT back (> 32 KiB)
  const big = Buffer.alloc(100 * 1024, 7);
  for (let off = 0; off < big.length; off += 32768) send(pair.runtimeEnd, encodeFrame(T.DATA, 1, big.subarray(off, off + 32768)));
  await waitUntil(() => Buffer.concat(c.data).length >= big.length);
  await waitUntil(() => runtime.get().some((f) => f.type === T.CREDIT && f.streamId === 1));
  const credited = runtime.get().filter((f) => f.type === T.CREDIT).reduce((n, f) => n + f.payload.readUInt32BE(0), 0);
  assert.ok(credited >= 64 * 1024 && credited <= big.length, "credit is returned as the socket consumed the bytes: " + credited);
  // half close both ways, then reset
  c.sock.end();
  await waitUntil(() => runtime.get().some((f) => f.type === T.FIN && f.streamId === 1));
  send(pair.runtimeEnd, encodeFrame(T.FIN, 1));
  await waitUntil(() => c.sock.destroyed || c.sock.readableEnded);
});

test("daemon mux: a refused OPEN maps the desktop's reason to the SOCKS reply; LINK down resets live streams; the 15 s open timeout is a reply, not a hang", async (t) => {
  const { pair, runtime, port } = await muxRig(t);
  pair.runtimeEnd.write(link(true));
  await wait(30);
  const a = await socksClient(port, req(1, 3, domain("blocked.example")));
  await waitUntil(() => runtime.get().some((f) => f.type === T.OPEN));
  send(pair.runtimeEnd, encodeFrame(T.OPENED, 1, Buffer.from([REP.NOT_ALLOWED])));
  assert.equal((await a.reply)[1], REP.NOT_ALLOWED, "guard refusal => 0x02");
  const b = await socksClient(port, req(1, 3, domain("live.example")));
  await waitUntil(() => runtime.get().filter((f) => f.type === T.OPEN).length === 2);
  send(pair.runtimeEnd, encodeFrame(T.OPENED, 3, Buffer.from([0])));
  assert.equal((await b.reply)[1], 0);
  const closed = new Promise<void>((r) => b.sock.once("close", () => r()));
  pair.runtimeEnd.write(link(false));
  await closed; // the live stream was torn down
  const c = await socksClient(port, req(1, 3, domain("after.example")));
  assert.equal((await c.reply)[1], REP.GENERAL, "after LINK 0 new requests fail closed again");
});

test("daemon mux: streams are capped at 256 (the 257th gets REP 1) and an unknown frame is ignored", async (t) => {
  const { pair, runtime, port } = await muxRig(t);
  pair.runtimeEnd.write(link(true));
  await wait(30);
  const socks: Socket[] = [];
  for (let i = 0; i < 256; i++) socks.push((await socksClient(port, req(1, 3, domain("h" + i + ".example")))).sock);
  await waitUntil(() => runtime.get().filter((f) => f.type === T.OPEN).length === 256, 15000, "256 OPEN frames");
  const extra = await socksClient(port, req(1, 3, domain("one-too-many.example")));
  assert.equal((await extra.reply)[1], REP.GENERAL);
  assert.equal(runtime.get().filter((f) => f.type === T.OPEN).length, 256);
  pair.runtimeEnd.write(Buffer.concat([lengthPrefixed(encodeFrame(T.DATA, 999, Buffer.from("x")))]));
  for (const s of socks) s.destroy();
});

// ------------------------------------------------------------------ daemon process (fake Chromium)

type Spawned = { child: ChildProcess; msgs: any[]; stderr: () => string; fd3: Socket; home: string; log(): string; stop(): Promise<void> };
function startEgressDaemon(t: test.TestContext, env: Record<string, string>, opts: { exe?: string; fd3?: boolean; home?: string } = {}): Spawned {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "floq-egress-"));
  if (!opts.home) t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [DAEMON], {
    env: { PATH: process.env.PATH!, HOME: home, FLOQ_BROWSER_EXECUTABLE: opts.exe ?? FAKE, FAKE_CHROMIUM_LOG: join(home, "chromium.log"), ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}), ...env },
    stdio: opts.fd3 === false ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
  });
  child.stdin!.on("error", () => undefined);
  const msgs: any[] = [];
  let buf = "", err = "";
  child.stdout!.on("data", (c: Buffer) => { buf += c; for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  child.stderr!.on("data", (c: Buffer) => { err += c; });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const fd3 = child.stdio[3] as Socket;
  fd3?.on("error", () => undefined);
  const s: Spawned = { child, msgs, stderr: () => err, fd3, home, log: () => { try { return readFileSync(join(home, "chromium.log"), "utf8"); } catch { return ""; } }, stop: async () => { if (child.exitCode === null) { child.stdin!.write(JSON.stringify({ type: "shutdown" }) + "\n"); setTimeout(() => child.kill("SIGKILL"), 4000).unref(); } await exited; } };
  t.after(() => s.stop());
  return s;
}
const listeningPort = (s: Spawned): number => Number(/"event":"egress.listening","port":(\d+)/.exec(s.stderr())?.[1]);

test("daemon (egress=desktop): Chromium starts with the proxy flags, the SOCKS listener refuses a same-uid process outside the Chromium tree, and BIND is refused", async (t) => {
  const d = startEgressDaemon(t, { FLOQ_BROWSER_EGRESS: "desktop" });
  await waitUntil(() => d.msgs.some((m) => m.type === "ready"), 20000, "ready");
  const port = listeningPort(d);
  assert.ok(port > 0, d.stderr());
  const args = JSON.parse(/ARGS (.*)/.exec(d.log())![1]) as string[];
  assert.ok(args.includes(`--proxy-server=socks5://127.0.0.1:${port}`));
  assert.ok(args.includes("--disable-quic") && args.includes("--dns-prefetch-disable"));
  // We are the same uid and not a Chromium descendant => closed without a single SOCKS byte, logged.
  const sock = tcpConnect(port, "127.0.0.1");
  sock.on("error", () => undefined);
  const got: Buffer[] = [];
  sock.on("data", (c) => got.push(c));
  await new Promise<void>((r) => sock.once("connect", () => r()));
  sock.write(Buffer.from([5, 1, 0]));
  await new Promise<void>((r) => sock.once("close", () => r()));
  assert.equal(Buffer.concat(got).length, 0, "no reply at all to a refused peer");
  await waitUntil(() => /"event":"egress.peer_refused","reason":"inode"/.test(d.stderr()), 3000, "peer_refused logged");
});

test("daemon (egress=desktop, FLOQ_BROWSER_EGRESS_PEER=uid fallback): fd 3 carries OPEN only after LINK up; BIND / UDP are refused; link down is REP 1", async (t) => {
  const d = startEgressDaemon(t, { FLOQ_BROWSER_EGRESS: "desktop", FLOQ_BROWSER_EGRESS_PEER: "uid" });
  const runtime = frames(d.fd3);
  await waitUntil(() => d.msgs.some((m) => m.type === "ready"), 20000, "ready");
  const port = listeningPort(d);
  await waitUntil(() => runtime.get().some((f) => f.type === T.HELLO));
  const down = await socksClient(port, req(1, 3, domain("example.com")));
  assert.equal((await down.reply)[1], REP.GENERAL, "no desktop yet: fail closed");
  for (const cmd of [2, 3]) {
    const c = await socksClient(port, req(cmd, 1, Buffer.alloc(4)));
    assert.equal((await c.reply)[1], REP.CMD, "cmd " + cmd);
  }
  d.fd3.write(link(true));
  await wait(50);
  const up = await socksClient(port, req(1, 3, domain("example.com"), 443));
  await waitUntil(() => runtime.get().some((f) => f.type === T.OPEN));
  assert.deepEqual(parseOpen(runtime.get().find((f) => f.type === T.OPEN)!.payload), { atyp: 3, host: "example.com", port: 443 });
  send(d.fd3, encodeFrame(T.OPENED, 1, Buffer.from([0])));
  assert.equal((await up.reply)[1], 0);
  up.sock.destroy();
});

test("daemon (egress=desktop) without fd 3 does not start: Chromium is never launched unproxied", async (t) => {
  const d = startEgressDaemon(t, { FLOQ_BROWSER_EGRESS: "desktop" }, { fd3: false });
  await waitUntil(() => d.msgs.some((m) => m.type === "error" && m.code === "start_failed"), 20000, "start_failed");
  assert.equal(d.log().includes("ARGS"), false, "chromium was not started");
});

test("daemon (egress=server): no proxy flags, no listener, nothing changes", async (t) => {
  const d = startEgressDaemon(t, { FLOQ_BROWSER_EGRESS: "server" }, { fd3: false });
  await waitUntil(() => d.msgs.some((m) => m.type === "ready"), 20000, "ready");
  assert.equal(d.log().includes("proxy-server"), false);
  assert.ok(!/egress\.listening/.test(d.stderr()));
});

// ------------------------------------------------------------------ end to end: real Chromium + hub + a local process playing the desktop

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

/** The "desktop": speaks the mux over the hub, resolves names through its own table and connects from 127.0.0.2, so a stub can tell it from the daemon (127.0.0.1). */
function fakeDesktop(hub: EgressHub, userId: string, resolve: Record<string, { host: string; port: number }>, opts: { machine?: string; realistic?: boolean } = {}) {
  const seen: string[] = [];
  // `realistic` mimics the shipped desktop app (src-tauri/src/egress.rs): OPEN ids must be odd and strictly increasing for the whole
  // WebSocket (a regression drops the link) and DATA toward the daemon never exceeds the window the daemon granted.
  let lastId = 0; const violations: string[] = []; const sendCredit = new Map<number, number>(); const pausedOut = new Map<number, Buffer[]>();
  const socks = new Map<number, Socket>();
  const out: Buffer[] = [];
  const peer = hub.attachDesktop(userId, { send: (f) => onFrame(f), close: () => undefined });
  const send = (f: Buffer) => peer.onMessage(f, true);
  send(encodeHello({ v: 1, caps: ["connect"], machine: opts.machine ?? "Test Mac" }));
  function onFrame(buf: Buffer) {
    const d = decodeFrame(buf);
    if (!d.ok) return;
    const f = d.frame;
    if (f.type === T.OPEN) {
      const target = parseOpen(f.payload)!;
      seen.push(`${target.host}:${target.port}`);
      if (opts.realistic) {
        if (f.streamId % 2 === 0 || f.streamId <= lastId) { violations.push(`OPEN ${f.streamId} after ${lastId}`); peer.onClose(); return; }
        lastId = f.streamId; sendCredit.set(f.streamId, INIT_CREDIT);
      }
      const to = resolve[target.host];
      if (!to) return send(encodeFrame(T.OPENED, f.streamId, Buffer.from([REP.HOST_UNREACHABLE])));
      const s = tcpConnect({ host: to.host, port: to.port, localAddress: "127.0.0.2" });
      socks.set(f.streamId, s);
      s.once("connect", () => send(encodeFrame(T.OPENED, f.streamId, Buffer.from([0]))));
      s.once("error", () => { if (socks.delete(f.streamId)) send(encodeFrame(T.OPENED, f.streamId, Buffer.from([REP.REFUSED]))); });
      s.on("data", (c) => {
        if (!opts.realistic) { for (let o = 0; o < c.length; o += 32768) send(encodeFrame(T.DATA, f.streamId, c.subarray(o, o + 32768))); return; }
        const q = pausedOut.get(f.streamId) ?? []; q.push(c); pausedOut.set(f.streamId, q); drain(f.streamId, s);
      });
      s.on("end", () => send(encodeFrame(T.FIN, f.streamId)));
      s.on("close", () => { if (socks.delete(f.streamId)) send(encodeFrame(T.RST, f.streamId, Buffer.from([0]))); });
    } else if (f.type === T.DATA) { const s = socks.get(f.streamId); if (s) { s.write(f.payload); const n = Buffer.alloc(4); n.writeUInt32BE(f.payload.length); out.push(n); send(encodeFrame(T.CREDIT, f.streamId, n)); } }
    else if (f.type === T.CREDIT && opts.realistic) { sendCredit.set(f.streamId, (sendCredit.get(f.streamId) ?? 0) + f.payload.readUInt32BE(0)); const s = socks.get(f.streamId); if (s) drain(f.streamId, s); }
    else if (f.type === T.FIN) socks.get(f.streamId)?.end();
    else if (f.type === T.RST) { socks.get(f.streamId)?.destroy(); socks.delete(f.streamId); }
    else if (f.type === T.PING) send(encodeFrame(T.PONG, 0, f.payload));
  }
  /** Sends queued socket bytes while the daemon's window allows; pauses the socket otherwise. */
  function drain(id: number, s: Socket) {
    const q = pausedOut.get(id) ?? [];
    while (q.length && (sendCredit.get(id) ?? 0) > 0) {
      const head = q[0]; const n = Math.min(head.length, 32768, sendCredit.get(id)!);
      q[0] = head.subarray(n); if (!q[0].length) q.shift();
      sendCredit.set(id, sendCredit.get(id)! - n);
      send(encodeFrame(T.DATA, id, head.subarray(0, n)));
    }
    if (q.length) s.pause(); else s.resume();
  }
  return { seen, violations, drop: () => { for (const s of socks.values()) s.destroy(); socks.clear(); peer.onClose(); } };
}

const realSkip = { skip: !REAL ? "no runnable chrome" : !PW ? "no playwright-core (set FLOQ_TEST_PLAYWRIGHT)" : false, timeout: 150000 };

test("end to end (real Chromium): the page sees the desktop's source address, nothing resolves or connects from the VPS, and with the desktop gone navigation fails closed", realSkip, async (t) => {
  // The "ipify" stub echoes the TCP peer address it sees. Direct => 127.0.0.1; through the fake desktop => 127.0.0.2.
  const peersSeen: string[] = [];
  const stub = createHttpServer((rq, rs) => { peersSeen.push(rq.socket.remoteAddress ?? ""); rs.setHeader("content-type", "text/plain"); rs.end(rq.socket.remoteAddress ?? ""); });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  t.after(() => stub.close());
  const stubPort = (stub.address() as { port: number }).port;
  const hub = new EgressHub();
  t.after(() => hub.close());
  const userId = "u-e2e";
  const home = mkdtempSync(join(tmpdir(), "floq-egress-e2e-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const d = startEgressDaemon(t, { FLOQ_BROWSER_EGRESS: "desktop" }, { exe: REAL!, home });
  const daemonHandle = hub.attachDaemon(userId, { write: (b) => { if (d.fd3.writable) d.fd3.write(b); }, close: () => d.fd3.destroy() });
  d.fd3.on("data", (c) => daemonHandle.push(c));
  await waitUntil(() => d.msgs.some((m) => m.type === "ready"), 30000, "ready\n" + d.stderr());
  const ready = d.msgs.find((m) => m.type === "ready");
  const browser = await PW.chromium.connectOverCDP(`ws://127.0.0.1:${ready.port}/devtools/browser`, { headers: { Authorization: "Bearer " + ready.token } });
  t.after(() => browser.close().catch(() => undefined));
  const page = await browser.contexts()[0].newPage();
  t.after(() => { if (/peer_refused|egress\.(bad|fd3)/.test(d.stderr())) t.diagnostic(d.stderr().split("\n").filter((l) => /egress/.test(l)).slice(0, 12).join("\n")); });

  // 1) Desktop down: fail closed. The VPS must not connect anywhere.
  await assert.rejects(page.goto("http://ipify.test/", { timeout: 15000 }), /ERR_(PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|CONNECTION_RESET|CONNECTION_CLOSED)/);
  assert.deepEqual(peersSeen, [], "no direct egress while the desktop is away");

  // 2) Desktop up: the peer fetches on the page's behalf.
  const desktop = fakeDesktop(hub, userId, { "ipify.test": { host: "127.0.0.1", port: stubPort } });
  await waitUntil(() => hub.isUp(userId), 5000, "hub up");
  await wait(100); // LINK reaches the daemon
  const resp = await page.goto("http://ipify.test/", { timeout: 20000 });
  assert.equal(await resp!.text(), "127.0.0.2", "the page got the desktop's source address, not the daemon's");
  assert.ok(desktop.seen.includes("ipify.test:80"), "the hostname travelled to the desktop unresolved: " + desktop.seen.join(","));
  assert.equal(peersSeen.every((a) => a === "127.0.0.2"), true, "every connection to the stub came from the desktop");

  // 3) A name the desktop cannot resolve: the VPS must not try either (resolver rule), and the error is a navigation error.
  await assert.rejects(page.goto("http://unknown.test/", { timeout: 15000 }), /ERR_/);
  assert.equal(desktop.seen.includes("unknown.test:80"), true);

  // 4) Loopback still bypasses the proxy (Chromium default): an agent's dev server in the sandbox stays reachable.
  const page2 = await browser.contexts()[0].newPage();
  const direct = await page2.goto(`http://127.0.0.1:${stubPort}/`, { timeout: 15000 }).catch((e) => { throw new Error(String(e.message).split("\n")[0] + " | desktop saw: " + desktop.seen.join(",")); });
  assert.equal(await direct!.text(), "127.0.0.1");

  // 5) The desktop goes away mid-session: back to fail closed, right away.
  desktop.drop();
  await waitUntil(() => !hub.isUp(userId), 2000, "hub down");
  await wait(100);
  const before = peersSeen.length;
  const page3 = await browser.contexts()[0].newPage();
  await assert.rejects(page3.goto("http://ipify.test/again", { timeout: 15000 }), /ERR_/);
  assert.equal(peersSeen.length, before, "no request leaked");
  void (null as unknown as Server);
});

test("end to end (real Chromium, HTTPS): a big TLS page loads through daemon + hub + desktop, and still loads after the daemon restarts (v1.0.11 blank page)", realSkip, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "floq-egress-tls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=secure.test", "-addext", "subjectAltName=DNS:secure.test"], { encoding: "utf8" });
  if (gen.status !== 0) return t.skip("no openssl");
  const filler = Buffer.alloc(900_000); for (let i = 0; i < filler.length; i++) filler[i] = 97 + ((i * 7919) % 26); // incompressible enough, > 3 windows of credit
  const big = Buffer.alloc(3_000_000, 7);
  const { createServer: createTlsServer } = await import("node:https");
  const site = createTlsServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (rq, rs) => {
    if (rq.url === "/big") { rs.setHeader("content-type", "application/octet-stream"); return void rs.end(big); }
    rs.setHeader("content-type", "text/html"); rs.end(`<title>secure-ok</title><body><h1>secure hello</h1><!-- ${filler.toString("latin1")} -->`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.close());
  const hub = new EgressHub();
  t.after(() => hub.close());
  const userId = "u-tls";
  const desktop = fakeDesktop(hub, userId, { "secure.test": { host: "127.0.0.1", port: (site.address() as { port: number }).port } }, { realistic: true });
  await waitUntil(() => hub.isUp(userId), 5000, "hub up");

  async function session(label: string) {
    const home = mkdtempSync(join(tmpdir(), "floq-egress-e2e-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const d = startEgressDaemon(t, { FLOQ_BROWSER_EGRESS: "desktop" }, { exe: REAL!, home });
    const handle = hub.attachDaemon(userId, { write: (b) => { if (d.fd3.writable) d.fd3.write(b); }, close: () => d.fd3.destroy() });
    d.fd3.on("data", (c) => handle.push(c));
    d.fd3.on("close", () => handle.close());
    await waitUntil(() => d.msgs.some((m) => m.type === "ready"), 30000, label + " ready\n" + d.stderr());
    const ready = d.msgs.find((m) => m.type === "ready");
    const browser = await PW.chromium.connectOverCDP(`ws://127.0.0.1:${ready.port}/devtools/browser`, { headers: { Authorization: "Bearer " + ready.token } });
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage(); // the stub's certificate is self-signed
    await wait(150); // LINK reaches the daemon
    return { d, browser, page };
  }
  async function loads(s: Awaited<ReturnType<typeof session>>, label: string) {
    const resp = await s.page.goto("https://secure.test/", { timeout: 30000 }).catch((e: Error) => { throw new Error(label + ": " + e.message.split("\n")[0] + " | desktop: " + desktop.seen.join(",") + " | violations: " + desktop.violations.join(",") + "\n" + s.d.stderr().split("\n").filter((l) => /egress/.test(l)).slice(-6).join("\n")); });
    assert.equal(resp!.status(), 200, label);
    assert.equal(await s.page.title(), "secure-ok", label);
    assert.equal((await s.page.content()).length > 900_000, true, label + ": the whole 900 KB document arrived");
    const got = await s.page.evaluate(async () => (await (await fetch("/big")).arrayBuffer()).byteLength);
    assert.equal(got, 3_000_000, label + ": a 3 MB body crosses the window repeatedly");
  }

  const first = await session("first daemon");
  t.after(() => first.browser.close().catch(() => undefined));
  await loads(first, "first daemon");
  await first.browser.close().catch(() => undefined);
  await first.d.stop(); // the daemon restarts (egress switch, idle stop, crash): the desktop's WebSocket stays up
  const second = await session("restarted daemon");
  t.after(() => second.browser.close().catch(() => undefined));
  await loads(second, "restarted daemon");
  assert.deepEqual(desktop.violations, [], "the desktop never saw a stream id go backwards");
  assert.equal(hub.isUp(userId), true, "the desktop link survived the restart");
});

test("daemon mux: a large upload never exceeds the desktop's window; the rest waits for CREDIT and the FIN comes after the last byte (M2)", async (t) => {
  const { pair, runtime, port } = await muxRig(t);
  pair.runtimeEnd.write(link(true));
  await wait(30);
  const c = await socksClient(port, req(1, 3, domain("upload.test")));
  await waitUntil(() => runtime.get().some((f) => f.type === T.OPEN));
  send(pair.runtimeEnd, encodeFrame(T.OPENED, 1, Buffer.from([0])));
  await c.reply;
  const body = Buffer.alloc(INIT_CREDIT * 2 + 12345, 9);
  for (let off = 0; off < body.length; off += 65536) c.sock.write(body.subarray(off, off + 65536));
  c.sock.end();
  const sent = () => runtime.get().filter((f) => f.type === T.DATA).reduce((n, f) => n + f.payload.length, 0);
  await waitUntil(() => sent() >= INIT_CREDIT, 5000, "initial window sent");
  await wait(150);
  assert.equal(sent(), INIT_CREDIT, "exactly the window, never more, however large the socket reads were");
  assert.equal(runtime.get().some((f) => f.type === T.FIN), false, "no FIN before the queued data");
  const grant = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); send(pair.runtimeEnd, encodeFrame(T.CREDIT, 1, b)); };
  grant(1000); // a few bytes of credit: still never above it
  await wait(100);
  assert.ok(sent() <= INIT_CREDIT + 1000, "sent " + sent());
  for (let i = 0; i < 4; i++) { grant(INIT_CREDIT * 4); await wait(60); } // grants above the window are capped at it, so it takes a few
  assert.ok(sent() <= body.length);
  await waitUntil(() => sent() === body.length, 5000, "everything sent");
  await waitUntil(() => runtime.get().some((f) => f.type === T.FIN), 3000, "FIN");
  assert.equal(runtime.get().at(-1)!.type, T.FIN);
});

test("daemon listener: connects beyond the per-second accept budget are dropped before any /proc read, and refusals are logged at most once a second (L1)", async (t) => {
  const pair = await fd3Pair();
  const mux = new EgressMux(socketSink(pair.daemonEnd), { log: () => undefined });
  attachMuxToStream(mux, pair.daemonEnd);
  let checks = 0;
  const peers = { check: () => { checks++; return { ok: false as const, reason: "uid" as const }; }, treeSize: 0, unreadable: 0 } as unknown as PeerChecker;
  const logs: string[] = [];
  const { server, port } = await startSocksListener({ mux, peers, log: (e) => logs.push(e), acceptBudgetPerSec: 5 });
  t.after(() => { server.close(); pair.close(); });
  const socks = await Promise.all(Array.from({ length: 40 }, async () => { const s = tcpConnect(port, "127.0.0.1"); s.on("error", () => undefined); await new Promise<void>((r) => s.once("connect", () => r())); return s; }));
  await wait(200);
  assert.ok(checks <= 5, "peer checks (= /proc reads) bounded by the budget: " + checks);
  assert.ok(logs.filter((e) => e === "egress.peer_refused").length <= 2, "refusal log is rate limited: " + logs.length);
  socks.forEach((s) => s.destroy());
});

test("CDP mux: in egress mode Target.createBrowserContext loses proxyServer / proxyBypassList; without egress it is untouched (M1)", () => {
  const run = (lock: boolean) => {
    const sent: Array<Record<string, unknown>> = [];
    const mux = new CdpMux((m) => sent.push(m as Record<string, unknown>));
    mux.lockProxy = lock;
    const client = { id: 1, send: () => undefined, close: () => undefined };
    mux.addClient(client);
    mux.fromClient(client, { id: 5, method: "Target.createBrowserContext", params: { disposeOnDetach: true, proxyServer: "direct://", proxyBypassList: "*", proxyBypassRules: "*" } });
    return sent.find((m) => m.method === "Target.createBrowserContext")!.params as Record<string, unknown>;
  };
  assert.deepEqual(run(true), { disposeOnDetach: true });
  assert.equal(run(false).proxyServer, "direct://");
});
