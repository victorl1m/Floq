import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createClient } from "redis";
import { PING_INTERVAL_MS, SOCKET_IDLE_TIMEOUT_MS } from "../dist/memories.js";

/** A minimal RESP server: answers PING with PONG and every other command with OK, and counts connections. */
async function fakeRedis(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // Each command is a RESP array: *N\r\n then N bulk strings ($len\r\nvalue\r\n).
      for (;;) {
        const m = /^\*(\d+)\r\n/.exec(buf);
        if (!m) return;
        let pos = m[0].length;
        const args: string[] = [];
        for (let i = 0; i < Number(m[1]); i++) {
          const b = /^\$(\d+)\r\n/.exec(buf.slice(pos));
          if (!b) return;
          const start = pos + b[0].length;
          const end = start + Number(b[1]);
          if (buf.length < end + 2) return;
          args.push(buf.slice(start, end));
          pos = end + 2;
        }
        buf = buf.slice(pos);
        socket.write(args[0]?.toUpperCase() === "PING" ? "+PONG\r\n" : "+OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connections: () => count,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function idleReconnects(options: { pingInterval?: number; socketTimeout: number }, idleMs: number): Promise<number> {
  const srv = await fakeRedis();
  const client = createClient({
    url: `redis://127.0.0.1:${srv.port}`,
    disableOfflineQueue: true,
    ...(options.pingInterval ? { pingInterval: options.pingInterval } : {}),
    socket: { connectTimeout: 2000, socketTimeout: options.socketTimeout, reconnectStrategy: () => 20 },
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await sleep(idleMs);
    return srv.connections() - 1;
  } finally {
    try { client.destroy(); } catch { /* already closed */ }
    await srv.close();
  }
}

test("memory client keeps the idle connection alive: ping interval is shorter than the idle socket timeout", () => {
  assert.ok(PING_INTERVAL_MS > 0, "keepalive ping is on");
  assert.ok(PING_INTERVAL_MS * 2 <= SOCKET_IDLE_TIMEOUT_MS, `ping ${PING_INTERVAL_MS} ms must fire well before the ${SOCKET_IDLE_TIMEOUT_MS} ms idle timeout`);
});

test("an idle socketTimeout without a keepalive ping tears the connection down in a loop (the v1.0.13 log spam)", async () => {
  const reconnects = await idleReconnects({ socketTimeout: 150 }, 800);
  assert.ok(reconnects >= 2, `expected repeated reconnects, saw ${reconnects}`);
});

test("with a keepalive ping shorter than socketTimeout the idle connection stays up", async () => {
  const reconnects = await idleReconnects({ pingInterval: 50, socketTimeout: 150 }, 800);
  assert.equal(reconnects, 0);
});
