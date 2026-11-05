import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DEFAULT_DISPLAY_BASE_PORT, DisplayAllocator, displayBasePort, displayEnv, displayStatus, portIsFree, stopDisplayServer } from "../dist/display.js";
import { abstractSocketProblems, abstractXSocket, displayEnvExports, displayFromEnv, parseAbstractListeners, xpraStartArgs, xpraStopArgs } from "../dist/image/floq-args.mjs";
import { createServer } from "node:net";

let n = 0;
const tokens = () => "tok" + ++n;

test("slots are runtime-wide: display 100+slot, port base+slot, lowest free slot reused", () => {
  const a = new DisplayAllocator(14500, 10, tokens);
  const s1 = a.acquire("s1")!;
  const s2 = a.acquire("s2")!;
  assert.deepEqual([s1.slot, s1.display, s1.port], [0, 100, 14500]);
  assert.deepEqual([s2.slot, s2.display, s2.port], [1, 101, 14501]);
  assert.notEqual(s1.token, s2.token);
  assert.equal(a.release("s1"), true);
  const s3 = a.acquire("s3")!;
  assert.equal(s3.slot, 0);
});

test("relaunch while the old sandbox is still exiting: new slot, old one drains until its own exit", () => {
  const a = new DisplayAllocator(14500, 10, tokens);
  const first = a.acquire("s1")!;
  const second = a.acquire("s1")!;
  assert.notEqual(second.slot, first.slot, "the old Xvfb/xpra may still hold :100 and its port");
  assert.notEqual(second.token, first.token);
  assert.equal(a.get("s1")?.token, second.token);
  assert.equal(a.acquire("other")!.slot, 2, "draining slot 0 is not handed to anyone");
  assert.equal(a.release("s1", first.token), true, "old process exited: its slot is freed");
  assert.equal(a.get("s1")?.token, second.token, "and the current lease is untouched");
  assert.equal(a.release("s1", first.token), false, "idempotent");
  assert.equal(a.acquire("third")!.slot, 0);
  assert.equal(a.release("other", second.token), false, "a token only frees its own session's lease");
  assert.equal(a.release("s1", second.token), true);
  assert.equal(a.get("s1"), null);
});

test("sleep/remove do not free a slot before exit: only the exit (token) release does", () => {
  const a = new DisplayAllocator(14500, 1, tokens);
  const lease = a.acquire("s1")!;
  // the manager no longer releases in sleep/remove/project delete; until whenExited() fires the slot stays taken
  assert.equal(a.acquire("s2"), null);
  a.release("s1", lease.token);
  assert.equal(a.acquire("s2")!.display, 100);
});

test("exhausted slots return null; slot count is capped by the port range", () => {
  const a = new DisplayAllocator(14500, 2, tokens);
  assert.ok(a.acquire("a"));
  assert.ok(a.acquire("b"));
  assert.equal(a.acquire("c"), null);
  const edge = new DisplayAllocator(65535, 50, tokens);
  assert.equal(edge.acquire("x")!.port, 65535);
  assert.equal(edge.acquire("y"), null);
});

test("base port env override, invalid values fall back to the default", () => {
  assert.equal(displayBasePort({}), DEFAULT_DISPLAY_BASE_PORT);
  assert.equal(displayBasePort({ FLOQ_DISPLAY_BASE_PORT: "20000" }), 20000);
  assert.equal(displayBasePort({ FLOQ_DISPLAY_BASE_PORT: "80" }), DEFAULT_DISPLAY_BASE_PORT);
  assert.equal(displayBasePort({ FLOQ_DISPLAY_BASE_PORT: "abc" }), DEFAULT_DISPLAY_BASE_PORT);
});

test("launch env and status: token only while the port is in the session's own listeners", () => {
  const a = new DisplayAllocator(14500, 4, tokens);
  const lease = a.acquire("s1")!;
  assert.deepEqual(displayEnv(lease), { FLOQ_DISPLAY: ":100", FLOQ_DISPLAY_PORT: "14500", FLOQ_DISPLAY_TOKEN: lease.token });
  assert.deepEqual(displayStatus(null, [{ port: 14500 }]), { running: false, port: null, token: null });
  assert.deepEqual(displayStatus(lease, [{ port: 3000 }]), { running: false, port: 14500, token: null });
  assert.deepEqual(displayStatus(lease, [{ port: 3000 }, { port: 14500 }]), { running: true, port: 14500, token: lease.token });
});

test("announce reaches only that user's subscribers and needs a lease", () => {
  const a = new DisplayAllocator(14500, 4, tokens);
  const seen: unknown[] = [];
  const off = a.subscribe("u1", (e) => seen.push(e));
  a.subscribe("u2", () => assert.fail("other user"));
  assert.equal(a.announce("u1", "missing"), false);
  a.acquire("s1");
  assert.equal(a.announce("u1", "s1"), true);
  assert.deepEqual(seen, [{ type: "display-started", sessionId: "s1", port: 14500 }]);
  off();
  a.announce("u1", "s1");
  assert.equal(seen.length, 1);
});

test("floq display: env parsing and xpra argv (no password on the command line, private sockets only)", () => {
  assert.ok("error" in displayFromEnv({}));
  assert.ok("error" in displayFromEnv({ FLOQ_DISPLAY: ":100", FLOQ_DISPLAY_PORT: "80", FLOQ_DISPLAY_TOKEN: "t" }));
  assert.deepEqual(displayFromEnv({ FLOQ_DISPLAY: ":100", FLOQ_DISPLAY_PORT: "14500", FLOQ_DISPLAY_TOKEN: "secret" }), { display: ":100", port: 14500, token: "secret" });
  const args = xpraStartArgs(":100", 14500);
  assert.deepEqual(args.slice(0, 2), ["start", ":100"]);
  assert.ok(args.includes("--bind-ws=127.0.0.1:14500,auth=env"));
  assert.ok(args.includes("--html=on"));
  assert.ok(args.includes("--mdns=no"));
  assert.ok(args.includes("--bind=/tmp/floq-display/sockets/xpra.sock"));
  const xvfb = args.find((a) => a.startsWith("--xvfb="))!;
  assert.match(xvfb, /-nolisten tcp/);
  assert.match(xvfb, /-auth \$XAUTHORITY/, "MIT cookie guards the abstract X socket");
  assert.doesNotMatch(xvfb, /-nolisten local/, "Xvfb must hold its abstract name so nobody else can");
  assert.ok(!args.some((a) => a.includes("secret")));
  assert.ok(!args.some((a) => /0\.0\.0\.0/.test(a)));
  assert.deepEqual(xpraStopArgs(":100"), ["stop", ":100", "--socket-dirs=/tmp/floq-display/sockets"]);
});

test("stopDisplayServer signals only the child in the session tree that holds the display port", { skip: process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, ["-e", "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port));setTimeout(()=>{},60000)"], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = Number(await new Promise<string>((resolve) => child.stdout!.once("data", (d) => resolve(String(d).trim()))));
    const killed: number[] = [];
    assert.equal(await stopDisplayServer(process.pid, port, (pid) => { killed.push(pid); }), true);
    assert.deepEqual(killed, [child.pid]);
    assert.equal(await stopDisplayServer(process.pid, port === 65535 ? 65534 : port + 1, () => assert.fail("no listener")), false);
    assert.equal(await stopDisplayServer(null, port, () => assert.fail("no session")), false);
  } finally {
    child.kill();
  }
});

test("release is idempotent and frees the slot and port", () => {
  const a = new DisplayAllocator(14500, 2, tokens);
  a.acquire("s1");
  assert.equal(a.release("s1"), true);
  assert.equal(a.release("s1"), false);
  assert.equal(a.release("never"), false);
  assert.equal(a.acquire("s2")!.port, 14500);
});

test("a squatted port moves the lease to a free spare port; relaunch returns to the home port", async () => {
  const a = new DisplayAllocator(14500, 3, tokens);
  a.acquire("s1");
  a.acquire("s2");
  const busy = new Set([14500, 14503]);
  const isFree = async (port: number) => !busy.has(port);
  assert.equal(await a.ensureFreePort("s2", isFree), 14501, "free home port is kept");
  assert.equal(await a.ensureFreePort("s1", isFree), 14504, "skips the squatted spare 14503");
  assert.equal(a.get("s1")!.port, 14504);
  assert.equal(displayStatus(a.get("s1"), [{ port: 14504 }]).running, true);
  busy.add(14500); busy.add(14501);
  assert.equal(await a.ensureFreePort("s2", isFree), 14503 + 2, "spares already lent are skipped");
  const old = a.get("s1")!;
  const relaunched = a.acquire("s1")!;
  assert.equal(relaunched.port, 14502, "relaunch: next free slot's home port while the old lease drains");
  a.release("s1", old.token);
  const next = a.acquire("n")!;
  assert.equal(next.port, 14500, "old slot free again after exit");
  assert.equal(await a.ensureFreePort("n", async (port) => port !== 14500), 14503, "the spare 14504 was returned too, 14503 is free now");
  assert.equal(await a.ensureFreePort("missing", isFree), null);
  const none = new DisplayAllocator(14500, 1, tokens);
  none.acquire("x");
  assert.equal(await none.ensureFreePort("x", async () => false), null);
});

test("portIsFree sees a real listener", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await portIsFree(port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await portIsFree(port), true);
});

test("abstract socket guard: hijacked X name, missing X name, stray xpra abstract socket", () => {
  const unix = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 111 @/tmp/.X11-unix/X100",
    "0000000000000000: 00000002 00000000 00010000 0001 01 222 @xpra/100",
    "0000000000000000: 00000003 00000000 00000000 0001 03 333 @/tmp/.X11-unix/X101",
    "0000000000000000: 00000002 00000000 00010000 0001 01 444 /tmp/floq-display/sockets/xpra.sock",
  ].join("\n");
  const listeners = parseAbstractListeners(unix);
  assert.deepEqual(listeners, [{ path: "@/tmp/.X11-unix/X100", inode: "111" }, { path: "@xpra/100", inode: "222" }]);
  assert.equal(abstractXSocket(":100.0"), "@/tmp/.X11-unix/X100");
  assert.deepEqual(abstractSocketProblems(listeners, new Set(["111"]), ":100", true), []);
  assert.match(abstractSocketProblems(listeners, new Set(), ":100", false)[0], /another process .*X100/);
  assert.match(abstractSocketProblems(listeners, new Set(), ":101", true)[0], /not holding/);
  assert.deepEqual(abstractSocketProblems(listeners, new Set(), ":101", false), []);
  assert.match(abstractSocketProblems(listeners, new Set(["111", "222"]), ":100", true)[0], /xpra created the abstract socket @xpra\/100/);
});

test("floq display env prints only DISPLAY/XAUTHORITY exports; DISPLAY is never in the launch env", () => {
  assert.equal(displayEnvExports(":100"), "export DISPLAY=':100' XAUTHORITY='/tmp/floq-display/Xauthority'");
  const lease = new DisplayAllocator(14500, 1, tokens).acquire("s")!;
  assert.ok(!("DISPLAY" in displayEnv(lease)) && !("XAUTHORITY" in displayEnv(lease)));
  assert.ok("error" in displayFromEnv({ DISPLAY: ":100", FLOQ_DISPLAY_PORT: "14500", FLOQ_DISPLAY_TOKEN: "t" }), "reads FLOQ_DISPLAY, not DISPLAY");
});
