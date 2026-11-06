import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { WebSocket } from "ws";
import { createRuntimeServer } from "../dist/server.js";
import { Vault } from "../dist/vault.js";
import { PluginHost } from "../dist/plugins/host.js";
import { PluginEvents, EVENT_MAX_BYTES } from "../dist/plugins/events.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { makeEcho } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);

test("PluginEvents: only the target user's subscribers get the frame; payload is capped at 64 KiB", () => {
  const ev = new PluginEvents();
  const got: Record<string, unknown[]> = { a: [], b: [] };
  ev.subscribe("a", (f) => got.a.push(f)); const offB = ev.subscribe("b", (f) => got.b.push(f));
  ev.publish("a", "echo", "ping", { n: 1 });
  assert.deepEqual(got.a, [{ type: "plugin", pluginId: "echo", name: "ping", data: { n: 1 } }]);
  assert.deepEqual(got.b, []);
  offB(); ev.publish("b", "echo", "ping", 1); assert.equal(got.b.length, 0);
  assert.doesNotThrow(() => ev.publish("a", "echo", "big", "x".repeat(EVENT_MAX_BYTES - 2)));
  assert.throws(() => ev.publish("a", "echo", "big", "x".repeat(EVENT_MAX_BYTES)), /64 KiB/);
  assert.throws(() => ev.publish("a", "echo", "bad name!", 1), /event name/);
  const cyclic: any = {}; cyclic.self = cyclic;
  assert.throws(() => ev.publish("a", "echo", "c", cyclic), /JSON/);
  assert.equal(got.a.length, 2);
});

test("/v1/events delivers plugin frames to the target user's socket only", async (t) => {
  const f = await fakePool(); await f.addUser("u1"); await f.addUser("u2");
  const vault = new Vault(f.pool as never, { encryptionKey: Buffer.alloc(32, 3) } as never);
  const { plugin, probe } = makeEcho();
  const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: vault as never, sink: () => undefined });
  await host.load(); await host.enable("echo", "u1");
  const tokens: Record<string, string> = { t1: "u1", t2: "u2" };
  const auth = { handler() {}, api: { getSession: async ({ headers }: any) => { const u = tokens[(headers.get("authorization") ?? "").replace("Bearer ", "")]; return u ? { user: { id: u } } : null; } } };
  const port: number = await new Promise((r) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y" };
  const hub = { subscribe: () => () => undefined };
  const manager = { activeCount: 0, displays: hub };
  const server = createRuntimeServer({ config, manager, auth, links: { hub }, settings: {}, github: {}, vault, orchestrator: {}, pool: f.pool, credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {}, plugins: host } as never);
  await server.listen();
  t.after(async () => { await server.close(); });
  const open = (token: string) => new Promise<{ ws: WebSocket; frames: any[] }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events?token=${token}`); const frames: any[] = [];
    ws.on("message", (m) => frames.push(JSON.parse(String(m)))); ws.on("open", () => resolve({ ws, frames })); ws.on("error", reject);
    t.after(() => ws.close());
  });
  const a = await open("t1"), b = await open("t2");
  await new Promise((r) => setTimeout(r, 50));
  probe.ctx.events.publish("u1", "tick", { n: 5 });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(a.frames, [{ type: "plugin", pluginId: "echo", name: "tick", data: { n: 5 } }]);
  assert.deepEqual(b.frames, []);
  assert.throws(() => probe.ctx.events.publish("u1", "big", "x".repeat(EVENT_MAX_BYTES)), /64 KiB/);
});
