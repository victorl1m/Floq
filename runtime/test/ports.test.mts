import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { databasePort, listSessionPorts, parseProcNetTcp, pipeTunnel, selectSessionPorts, tunnelTarget } from "../dist/ports.js";

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const V4 = HEADER +
  "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0\n" +
  "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 222 1 0 100 0 0\n" +
  "   2: 0100007F:D431 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0 100 0 0\n";
const V6 = HEADER +
  "   0: 00000000000000000000000001000000:22F0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0 100 0 0\n" +
  "   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0 100 0 0\n";

test("parses LISTEN rows from /proc/net/tcp and tcp6", () => {
  assert.deepEqual(parseProcNetTcp(V4, false).map((l) => [l.port, l.address, l.inode]), [[8080, "127.0.0.1", "111"], [22, "0.0.0.0", "222"]]);
  assert.deepEqual(parseProcNetTcp(V6, true).map((l) => [l.port, l.address]), [[8944, "::1"], [8080, "::"]]);
});

test("only ports whose sockets the session owns are listed, deduplicated by port", () => {
  const all = [...parseProcNetTcp(V4, false), ...parseProcNetTcp(V6, true)];
  assert.deepEqual(selectSessionPorts(all, new Set(["111", "555", "444"])), [
    { port: 8080, address: "127.0.0.1" },
    { port: 8944, address: "::1" },
  ]);
  assert.deepEqual(selectSessionPorts(all, new Set()), []);
});

test("tunnel target is rejected for ports the session is not listening on", () => {
  const ports = [{ port: 8080, address: "0.0.0.0" }];
  assert.deepEqual(tunnelTarget(ports, 8080), { host: "127.0.0.1", port: 8080 });
  assert.equal(tunnelTarget(ports, 22), null);
});

test("manual tunnel allows undetected unprivileged loopback ports only", () => {
  const manual = { denyPorts: [5432, 8787] };
  assert.deepEqual(tunnelTarget([], 3000, manual), { host: "127.0.0.1", port: 3000 });
  assert.equal(tunnelTarget([], 3000), null); // not manual
  assert.equal(tunnelTarget([], 1023, manual), null); // privileged
  assert.equal(tunnelTarget([], 22, manual), null);
  assert.equal(tunnelTarget([], 5432, manual), null); // deny list
  assert.equal(tunnelTarget([], 8787, manual), null); // runtime's own port
  assert.equal(tunnelTarget([], 65536, manual), null);
  assert.equal(tunnelTarget([], 3000.5, manual), null);
  // A detected port keeps its detected host.
  assert.deepEqual(tunnelTarget([{ port: 3000, address: "::1" }], 3000, manual), { host: "::1", port: 3000 });
});

test("databasePort reads the port from a connection string", () => {
  assert.equal(databasePort("postgres://u:p@localhost:5544/db"), 5544);
  assert.equal(databasePort("postgres://u:p@localhost/db"), 0);
  assert.equal(databasePort("nonsense"), 0);
});

test("listSessionPorts degrades to empty without a pid", async () => {
  assert.deepEqual(await listSessionPorts(null), []);
});

async function wsServer(onConn: (ws: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", r));
  wss.on("connection", onConn);
  return { wss, url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` };
}

test("pipeTunnel relays bytes both ways and closes both sides", async (t) => {
  const echo = createServer((socket) => socket.on("data", (d) => socket.write(d)));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as { port: number }).port;
  const { wss, url } = await wsServer((ws) => { pipeTunnel(ws, { host: "127.0.0.1", port: echoPort }); });
  t.after(() => { wss.close(); echo.close(); });

  const client = new WebSocket(url);
  await new Promise((r) => client.once("open", r));
  const reply = new Promise<Buffer>((r) => client.once("message", (d) => r(d as Buffer)));
  client.send(Buffer.from("hello"));
  assert.equal((await reply).toString(), "hello");
  const closed = new Promise((r) => client.once("close", r));
  client.close();
  await closed;
});

test("pipeTunnel closes the websocket when the target refuses", async (t) => {
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = (dead.address() as { port: number }).port;
  await new Promise((r) => dead.close(r));
  const { wss, url } = await wsServer((ws) => { pipeTunnel(ws, { host: "127.0.0.1", port: deadPort }); });
  t.after(() => wss.close());
  const client = new WebSocket(url);
  const code = await new Promise<number>((r) => client.once("close", (c) => r(c)));
  assert.equal(code, 1011);
});
