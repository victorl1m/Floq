import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EgressHub } from "../dist/browserEgress.js";
import * as srcCodec from "../dist/egressCodec.js";
import * as imgCodec from "../dist/image/floq-egress-codec.mjs";

const { T, encodeFrame, decodeFrame, encodeHello, encodeOpen, parseOpen, lengthPrefixed, RecordStream, INIT_CREDIT, RST_REASON } = srcCodec;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ codec

test("codec: the runtime copy is byte-identical to the image codec (below the header comment)", () => {
  const body = (p: string) => { const t = readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"); return t.slice(t.indexOf("\nexport const T")); };
  assert.equal(body("../src/egressCodec.ts"), body("../image/floq-egress-codec.mts"));
  assert.deepEqual(srcCodec.T, imgCodec.T);
});

test("codec: frames and OPEN payloads round-trip; the daemon and runtime builds agree on bytes", () => {
  for (const t of [{ atyp: 3 as const, host: "example.com", port: 443 }, { atyp: 1 as const, host: "93.184.216.34", port: 80 }, { atyp: 4 as const, host: "2001:db8:0:0:0:0:0:1", port: 8443 }]) {
    const p = encodeOpen(t);
    assert.deepEqual(parseOpen(p), t);
    assert.deepEqual(imgCodec.encodeOpen(t), p);
    const d = decodeFrame(encodeFrame(T.OPEN, 7, p));
    assert.ok(d.ok && d.frame.type === T.OPEN && d.frame.streamId === 7);
  }
  assert.deepEqual(parseOpen(encodeOpen({ atyp: 4, host: "::1", port: 1 })), { atyp: 4, host: "0:0:0:0:0:0:0:1", port: 1 });
  assert.throws(() => encodeOpen({ atyp: 3, host: "", port: 1 }));
  assert.throws(() => encodeOpen({ atyp: 3, host: "a".repeat(256), port: 1 }));
});

test("codec: structural validation refuses what the protocol forbids", () => {
  const bad = (b: Buffer, why: string) => { const r = decodeFrame(b); assert.ok(!r.ok && r.reason === why, why + " got " + JSON.stringify(r)); };
  bad(Buffer.from([1, 0, 0]), "short");
  bad(Buffer.from([99, 0, 0, 0, 1]), "unknown_type");
  bad(encodeFrame(T.DATA, 1, Buffer.alloc(32769)), "too_big");
  bad(encodeFrame(T.PING, 5, Buffer.alloc(8)), "bad_stream_id");
  bad(encodeFrame(T.OPENED, 0, Buffer.from([0])), "bad_stream_id");
  bad(encodeFrame(T.CREDIT, 1, Buffer.alloc(3)), "bad_payload");
  bad(encodeFrame(T.OPEN, 1, Buffer.alloc(2)), "bad_payload");
  assert.ok(decodeFrame(encodeFrame(T.DATA, 1, Buffer.alloc(32768))).ok);
});

test("codec: RecordStream reassembles split fd 3 reads and rejects a bad length", () => {
  const got: Buffer[] = [];
  let err = "";
  const rs = new RecordStream((r) => got.push(r), (e) => { err = e; });
  const a = lengthPrefixed(encodeFrame(T.DATA, 1, Buffer.from("hello"))), b = lengthPrefixed(encodeFrame(T.FIN, 1));
  const all = Buffer.concat([a, b]);
  for (let i = 0; i < all.length; i += 3) rs.push(all.subarray(i, i + 3));
  assert.equal(got.length, 2);
  assert.equal(err, "");
  rs.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  assert.equal(err, "bad_length");
});

// ------------------------------------------------------------------ hub

function rig(opts: ConstructorParameters<typeof EgressHub>[0] = {}) {
  const hub = new EgressHub(opts);
  const daemon = (userId: string) => {
    const toDaemon: Buffer[] = [];
    const rs = new RecordStream((r) => toDaemon.push(r), () => undefined);
    let closed = false;
    const h = hub.attachDaemon(userId, { write: (b) => rs.push(b), close: () => { closed = true; } });
    return {
      frames: () => toDaemon.map((r) => decodeFrame(r)).flatMap((d) => (d.ok ? [d.frame] : [])),
      send: (f: Buffer) => h.push(lengthPrefixed(f)),
      closed: () => closed, detach: () => h.close(),
    };
  };
  const desktop = (userId: string, machine = "Mac") => {
    const got: Buffer[] = []; let closedWith: [number, string] | null = null;
    const p = hub.attachDesktop(userId, { send: (f) => got.push(f), close: (c, r) => { closedWith = [c, r]; } });
    return {
      frames: () => got.map((r) => decodeFrame(r)).flatMap((d) => (d.ok ? [d.frame] : [])),
      send: (f: Buffer, binary = true) => p.onMessage(f, binary),
      hello: (extra: Record<string, unknown> = {}) => p.onMessage(encodeHello({ v: 1, caps: ["connect"], machine, ...extra }), true),
      close: () => p.onClose(), closedWith: () => closedWith,
    };
  };
  return { hub, daemon, desktop };
}
const types = (fs: Array<{ type: number }>) => fs.map((f) => f.type);
const open = (id: number, host = "example.com", port = 443) => encodeFrame(T.OPEN, id, encodeOpen({ atyp: 3, host, port }));
const opened = (id: number, rep = 0) => encodeFrame(T.OPENED, id, Buffer.from([rep]));
const data = (id: number, n: number) => encodeFrame(T.DATA, id, Buffer.alloc(n, 1));
const credit = (id: number, n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return encodeFrame(T.CREDIT, id, b); };

test("hub: LINK follows the desktop; frames flow between a user's own daemon and desktop, with HELLO standby false", () => {
  const { hub, daemon, desktop } = rig();
  const d = daemon("A");
  assert.deepEqual(d.frames().map((f) => [f.type, f.payload[0]]), [[T.LINK, 0]], "no desktop yet: LINK 0");
  const w = desktop("A");
  assert.equal(hub.isUp("A"), false, "not up before HELLO");
  w.hello();
  assert.equal(hub.isUp("A"), true);
  assert.deepEqual(hub.info("A"), { state: "up", machine: "Mac" });
  assert.deepEqual(d.frames().map((f) => [f.type, f.payload[0]]).slice(-1), [[T.LINK, 1]]);
  assert.deepEqual(JSON.parse(w.frames()[0].payload.toString()), { v: 1, role: "runtime" }, "the runtime speaks first, before any desktop frame");
  assert.deepEqual(JSON.parse(w.frames()[1].payload.toString()), { v: 1, standby: false });
  d.send(open(1));
  assert.deepEqual(types(w.frames().slice(2)), [T.OPEN]);
  w.send(opened(1));
  assert.deepEqual(types(d.frames().slice(1)), [T.LINK, T.OPENED]);
  d.send(data(1, 1000)); w.send(data(1, 2000));
  assert.deepEqual(types(w.frames().slice(2)), [T.OPEN, T.DATA]);
  assert.equal(d.frames().at(-1)!.type, T.DATA);
  hub.close();
});

test("hub: a restarted daemon starts at id 1 again but the desktop only ever sees strictly increasing OPEN ids, and its replies map back (v1.0.11 blank-page bug)", () => {
  // The desktop app admits OPEN ids that are odd and strictly increasing for the life of its WebSocket (src-tauri/src/egress.rs Admission).
  const { hub, daemon, desktop } = rig();
  const w = desktop("A"); w.hello();
  const seen: number[] = [];
  const opensSeen = () => w.frames().filter((f) => f.type === T.OPEN).map((f) => f.streamId);
  const d1 = daemon("A");
  for (const id of [1, 3, 5, 7]) { d1.send(open(id)); }
  d1.detach(); // daemon restart (egress switch, crash, idle stop)
  const d2 = daemon("A");
  for (const id of [1, 3, 5]) d2.send(open(id));
  const d3 = daemon("A"); // and again, with the previous daemon replaced rather than detached
  d3.send(open(1));
  for (const id of opensSeen()) seen.push(id);
  assert.equal(seen.length, 8);
  for (let i = 0; i < seen.length; i++) { assert.equal(seen[i] % 2, 1, "odd"); if (i) assert.ok(seen[i] > seen[i - 1], "strictly increasing: " + seen.join(",")); }
  // Replies for the current daemon's streams (desktop numbering) reach the daemon under ITS numbering.
  const deskId = seen[7];
  w.send(opened(deskId)); w.send(data(deskId, 100)); w.send(encodeFrame(T.FIN, deskId));
  assert.deepEqual(d3.frames().filter((f) => f.type !== T.LINK).map((f) => [f.type, f.streamId]), [[T.OPENED, 1], [T.DATA, 1], [T.FIN, 1]]);
  // And the daemon's frames reach the desktop under the desktop's numbering (DATA, CREDIT, FIN, RST).
  d3.send(data(1, 10)); d3.send(credit(1, 100)); d3.send(encodeFrame(T.FIN, 1));
  assert.deepEqual(w.frames().slice(-3).map((f) => [f.type, f.streamId]), [[T.DATA, deskId], [T.CREDIT, deskId], [T.FIN, deskId]]);
  // A late frame from the desktop about a stream of an earlier daemon names nothing live: ignored, never mistaken for a new stream.
  const before = d3.frames().length;
  w.send(opened(seen[0])); w.send(data(seen[0], 10));
  assert.equal(d3.frames().length, before);
  // Streams of the replaced daemon were reset toward the desktop with the OLD numbering.
  assert.ok(w.frames().some((f) => f.type === T.RST && f.streamId === seen[3]), "the old daemon's last stream is reset under its own id");
  hub.close();
});

test("hub: user A's daemon never reaches user B's desktop, and the other way round", () => {
  const { hub, daemon, desktop } = rig();
  const da = daemon("A"), db = daemon("B");
  const wa = desktop("A", "A-Mac"), wb = desktop("B", "B-Mac");
  wa.hello(); wb.hello();
  da.send(open(1, "a.example")); db.send(open(1, "b.example"));
  const hosts = (w: ReturnType<typeof desktop>) => w.frames().filter((f) => f.type === T.OPEN).map((f) => parseOpen(f.payload)!.host);
  assert.deepEqual(hosts(wa), ["a.example"]);
  assert.deepEqual(hosts(wb), ["b.example"]);
  wa.send(opened(1)); wa.send(data(1, 10));
  assert.equal(db.frames().some((f) => f.type === T.OPENED || f.type === T.DATA), false, "B's daemon saw nothing of A's traffic");
  // A user with a daemon but no desktop: LINK 0, and an OPEN is answered with RST (never forwarded anywhere).
  const dc = daemon("C");
  dc.send(open(1));
  assert.deepEqual(dc.frames().map((f) => f.type), [T.LINK, T.RST]);
  assert.equal(wa.frames().filter((f) => f.type === T.OPEN).length, 1);
  hub.close();
});

test("hub: the newest desktop is active, the older one goes standby and its streams end; when the newest leaves, the older takes over", () => {
  const { hub, daemon, desktop } = rig();
  const d = daemon("A");
  const old = desktop("A", "Old"); old.hello();
  d.send(open(1));
  old.send(opened(1));
  const fresh = desktop("A", "New"); fresh.hello();
  assert.deepEqual(hub.info("A"), { state: "up", machine: "New" });
  assert.deepEqual(JSON.parse(old.frames().filter((f) => f.type === T.HELLO).at(-1)!.payload.toString()), { v: 1, standby: true });
  assert.ok(d.frames().some((f) => f.type === T.RST && f.streamId === 1), "the daemon's stream on the old desktop was reset");
  assert.ok(old.frames().some((f) => f.type === T.RST && f.streamId === 1), "and so was the old desktop's end");
  old.send(data(1, 5)); // a standby desktop may not push data
  assert.equal(d.frames().filter((f) => f.type === T.DATA).length, 0);
  d.send(open(3));
  assert.equal(fresh.frames().filter((f) => f.type === T.OPEN).length, 1);
  assert.equal(old.frames().filter((f) => f.type === T.OPEN).length, 1, "only the first OPEN went to the old one");
  fresh.close();
  assert.deepEqual(hub.info("A"), { state: "up", machine: "Old" });
  assert.deepEqual(JSON.parse(old.frames().filter((f) => f.type === T.HELLO).at(-1)!.payload.toString()), { v: 1, standby: false });
  assert.ok(d.frames().some((f) => f.type === T.RST && f.streamId === 3));
  hub.close();
});

test("hub: RST-all when either side goes away, LINK 0 when the last desktop leaves", () => {
  const { hub, daemon, desktop } = rig();
  const d = daemon("A");
  const w = desktop("A"); w.hello();
  d.send(open(1)); d.send(open(3));
  w.send(opened(1)); w.send(opened(3));
  w.close();
  const dr = d.frames();
  assert.deepEqual(dr.filter((f) => f.type === T.RST).map((f) => f.streamId).sort(), [1, 3]);
  assert.equal(dr.filter((f) => f.type === T.LINK).at(-1)!.payload[0], 0);
  assert.equal(hub.isUp("A"), false);
  // and the other way: the daemon dies while a desktop is up
  const w2 = desktop("A"); w2.hello();
  const d2 = daemon("A");
  d2.send(open(1));
  const o2 = w2.frames().filter((f) => f.type === T.OPEN).at(-1)!.streamId; // the second daemon's stream 1, as the desktop numbers it
  w2.send(opened(o2));
  d2.detach();
  assert.ok(w2.frames().some((f) => f.type === T.RST && f.streamId === o2), "the desktop is told its stream is over");
  assert.equal(d2.closed(), true);
  hub.close();
});

test("hub: protocol errors close the desktop WS (1008): text, no HELLO first, forbidden types, second HELLO, bad frames", () => {
  const cases: Array<[string, (w: ReturnType<ReturnType<typeof rig>["desktop"]>) => void]> = [
    ["text message", (w) => w.send(Buffer.from("hi"), false)],
    ["data before hello", (w) => w.send(data(1, 1))],
    ["garbage", (w) => { w.hello(); w.send(Buffer.from([1, 2])); }],
    ["desktop sends LINK", (w) => { w.hello(); w.send(encodeFrame(T.LINK, 0, Buffer.from([1]))); }],
    ["second HELLO", (w) => { w.hello(); w.hello(); }],
  ];
  {
    const { hub, desktop } = rig();
    const w = desktop("A"); w.hello(); w.send(open(1));
    assert.equal(w.closedWith()?.[0], 4401, "a desktop-sent OPEN closes with 4401");
    assert.equal(hub.isUp("A"), false);
    hub.close();
  }
  for (const [name, fn] of cases) {
    const { hub, daemon, desktop } = rig();
    daemon("A");
    const w = desktop("A");
    fn(w);
    assert.deepEqual(w.closedWith()?.[0], 1008, name);
    assert.equal(hub.isUp("A"), false, name);
    hub.close();
  }
});

test("hub: an incompatible HELLO version closes with 4400; machine names are sanitized", () => {
  const { hub, desktop } = rig();
  const w = desktop("A");
  w.send(encodeHello({ v: 2 }));
  assert.deepEqual(w.closedWith(), [4400, "incompatible app"]);
  const w2 = desktop("A");
  w2.hello({ machine: "Víctor's <b>Mac</b>\n" + "x".repeat(100) });
  assert.match(hub.info("A").machine!, /^Víctors bMacb/);
  assert.ok(hub.info("A").machine!.length <= 64);
  hub.close();
});

test("hub: credit windows and caps: a sender over its window or the 256-stream cap is reset, not relayed", () => {
  const { hub, daemon, desktop } = rig();
  const d = daemon("A");
  const w = desktop("A"); w.hello();
  d.send(open(1)); w.send(opened(1));
  // The desktop may send at most INIT_CREDIT bytes before the daemon returns credit.
  let sent = 0;
  while (sent + 32768 <= INIT_CREDIT) { w.send(data(1, 32768)); sent += 32768; }
  assert.equal(d.frames().filter((f) => f.type === T.RST).length, 0);
  w.send(data(1, 100));
  assert.ok(d.frames().some((f) => f.type === T.RST && f.streamId === 1 && f.payload[0] === RST_REASON.PROTOCOL), "window exceeded => RST protocol");
  // credit lets it continue on a new stream
  d.send(open(3)); w.send(opened(3));
  for (let i = 0; i < 4; i++) { w.send(data(3, 32768)); }
  d.send(credit(3, 4 * 32768));
  for (let i = 0; i < 4; i++) { w.send(data(3, 32768)); }
  assert.equal(d.frames().filter((f) => f.type === T.RST && f.streamId === 3).length, 0);
  // data on a stream the desktop has not accepted yet is a protocol violation for that stream
  d.send(open(5));
  w.send(data(5, 1));
  assert.ok(w.frames().some((f) => f.type === T.RST && f.streamId === 5));
  // stream cap: ids must be odd and increasing
  d.send(open(4)); d.send(open(3));
  assert.deepEqual(d.frames().filter((f) => f.type === T.RST && (f.streamId === 4 || f.streamId === 3 && f.payload[0] === RST_REASON.PROTOCOL)).length >= 2, true);
  hub.close();
  const r2 = rig();
  const d2 = r2.daemon("A"); const w2 = r2.desktop("A"); w2.hello();
  for (let i = 0; i < 256; i++) d2.send(open(2 * i + 1));
  d2.send(open(513));
  assert.equal(w2.frames().filter((f) => f.type === T.OPEN).length, 256);
  assert.ok(d2.frames().some((f) => f.type === T.RST && f.streamId === 513));
  r2.hub.close();
});

test("hub: PING/PONG measures rtt, a silent desktop is dropped, a HELLO-less one is dropped", async () => {
  let now = 1_000_000;
  const changes: Array<boolean | undefined> = [];
  const { hub, daemon, desktop } = rig({ now: () => now, pingEveryMs: 20, deadAfterMs: 100, helloTimeoutMs: 60, onChange: (_u, rttOnly) => changes.push(rttOnly) });
  const d = daemon("A");
  const w = desktop("A"); w.hello();
  const silent = desktop("A", "Silent");
  await wait(120); // HELLO timeout (real timers) for the one that never said hello
  assert.deepEqual(silent.closedWith(), [1008, "HELLO expected"]);
  now += 30;
  await wait(1100); // tick runs every <= 1 s; fake clock decides whether it is time to ping
  const ping = w.frames().filter((f) => f.type === T.PING).at(-1);
  assert.ok(ping, "the relay pings the desktop");
  now += 7;
  w.send(encodeFrame(T.PONG, 0, ping!.payload));
  assert.equal(hub.info("A").rttMs, 7);
  assert.equal(changes.at(-1), true, "a PONG reports an rtt-only change (no route re-evaluation, L5)");
  assert.ok(changes.slice(0, -1).every((c) => !c), "connects and drops are full changes");
  now += 500; // no frame for longer than deadAfterMs
  await wait(1100);
  assert.equal(w.closedWith()?.[0], 1001);
  assert.equal(hub.isUp("A"), false);
  assert.equal(d.frames().at(-1)!.type, T.LINK);
  hub.close();
});

test("hub: the runtime sends HELLO first on attach, with the desktop's own public address when known (H1/H2)", () => {
  const hub = new EgressHub();
  const got: Buffer[] = [];
  hub.attachDesktop("A", { send: (f) => got.push(f), close: () => undefined }, { peerIp: "203.0.113.9" });
  const d = decodeFrame(got[0]);
  assert.ok(d.ok && d.frame.type === T.HELLO);
  assert.deepEqual(JSON.parse((d as { frame: { payload: Buffer } }).frame.payload.toString()), { v: 1, role: "runtime", peer: "203.0.113.9" });
  hub.attachDesktop("B", { send: (f) => got.push(f), close: () => undefined }, { peerIp: "not an ip; drop table" });
  assert.deepEqual(JSON.parse((decodeFrame(got[1]) as { frame: { payload: Buffer } }).frame.payload.toString()), { v: 1, role: "runtime" });
  hub.close();
});

test("hub: CREDIT is forwarded clamped to what the window accounts for (L4)", () => {
  const { hub, daemon, desktop } = rig();
  const d = daemon("A");
  const w = desktop("A"); w.hello();
  d.send(open(1)); w.send(opened(1));
  w.send(data(1, 1000));
  d.send(credit(1, 4_000_000_000)); // far more than the 1000 bytes the desktop sent
  const c = w.frames().filter((f) => f.type === T.CREDIT);
  assert.equal(c.length, 1);
  assert.equal(c[0].payload.readUInt32BE(0), 1000, "the daemon's grant is clamped to the 1000 bytes the desktop actually sent");
  d.send(data(1, 500));
  w.send(credit(1, 4_000_000_000));
  const c2 = d.frames().filter((f) => f.type === T.CREDIT);
  assert.equal(c2.length, 1);
  assert.equal(c2[0].payload.readUInt32BE(0), 500);
  hub.close();
});

test("hub: unknown frame types are ignored after HELLO, the connection cap closes the oldest (L3), RST reasons match the doc (M4)", () => {
  const { hub, desktop } = rig();
  const w = desktop("A"); w.hello();
  w.send(Buffer.from([99, 0, 0, 0, 0]));
  assert.equal(w.closedWith(), null);
  const ws = [w];
  for (let i = 0; i < 8; i++) ws.push(desktop("A"));
  assert.equal(w.closedWith()?.[0], 1008, "the oldest was closed past 8 connections");
  assert.equal(ws[ws.length - 1].closedWith(), null);
  // The numbers are the protocol doc's table (and egress.rs RST_* constants).
  assert.deepEqual(RST_REASON, { GENERIC: 0, GUARD: 1, STREAMS: 2, RATE: 3, BANDWIDTH: 4, DAILY: 5, IDLE: 6, PROTOCOL: 7, KILLED: 8, SHUTDOWN: 9, UPSTREAM: 10, LINK_DOWN: 11 });
  hub.close();
});

test("codec constants equal the Rust constants (M4/M5: TS<->Rust table check)", () => {
  const rs = readFileSync(fileURLToPath(new URL("../../src-tauri/src/egress.rs", import.meta.url)), "utf8");
  const num = (name: string) => Number(new RegExp(`pub const ${name}: u\\d+ = (\\d+);`).exec(rs)?.[1]);
  const table: Record<string, string> = { GENERIC: "RST_GENERIC", GUARD: "RST_GUARD", STREAMS: "RST_STREAMS", RATE: "RST_RATE", BANDWIDTH: "RST_BANDWIDTH", DAILY: "RST_DAILY", IDLE: "RST_IDLE", PROTOCOL: "RST_PROTOCOL", KILLED: "RST_KILLED", SHUTDOWN: "RST_SHUTDOWN", UPSTREAM: "RST_UPSTREAM", LINK_DOWN: "RST_LINK_DOWN" };
  for (const [k, rust] of Object.entries(table)) assert.equal(num(rust), (RST_REASON as Record<string, number>)[k], rust);
  assert.equal(Number(/const CLOSE_INCOMPATIBLE: u16 = (\d+)/.exec(rs)?.[1]), srcCodec.CLOSE.INCOMPATIBLE);
  assert.equal(Number(/const CLOSE_DESKTOP_OPEN: u16 = (\d+)/.exec(rs)?.[1]), srcCodec.CLOSE.DESKTOP_OPEN);
});
