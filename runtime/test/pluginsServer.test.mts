import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { createRuntimeServer } from "../dist/server.js";
import { Vault } from "../dist/vault.js";
import { PluginHost } from "../dist/plugins/host.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { makeEcho } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const key = Buffer.alloc(32, 7);

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as any; s.close(() => resolve(port)); }); });
}

async function harness(t: any, plugins: any[], logs: any[] = []) {
  const f = await fakePool();
  await f.addUser("admin"); // earliest user becomes the bootstrap admin
  await f.addUser("member");
  const vault = new Vault(f.pool as never, { encryptionKey: key } as never);
  const host = new PluginHost(f.pool as never, { plugins, vault: vault as never, sink: (level: string, event: string, fields: unknown) => logs.push({ level, event, fields }) });
  await host.load();
  const tokens: Record<string, string> = { "admin-token": "admin", "member-token": "member" };
  const auth = { handler() {}, api: { getSession: async ({ headers }: any) => { const u = tokens[(headers.get("authorization") ?? "").replace("Bearer ", "")]; return u ? { user: { id: u } } : null; } } };
  const port = await freePort();
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y", bootstrapAdminEmail: null };
  const manager = { activeCount: 0 };
  const server = createRuntimeServer({ config, manager, auth, settings: {}, github: {}, vault, orchestrator: {}, pool: f.pool, credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {}, plugins: host } as never);
  await server.listen();
  t.after(async () => { await server.close(); });
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, json: text ? JSON.parse(text) : {} };
  };
  return { ...f, call, host, vault };
}

test("unauthenticated requests get 401", async (t) => {
  const { call } = await harness(t, [makeEcho().plugin]);
  assert.equal((await call(null, "GET", "/v1/plugins")).status, 401);
  assert.equal((await call(null, "POST", "/v1/plugins/echo/enable")).status, 401);
  assert.equal((await call(null, "GET", "/v1/plugins/echo/api/ping")).status, 401);
});

test("GET /v1/plugins returns the public subset with secret-present booleans and never values", async (t) => {
  const { call, vault } = await harness(t, [makeEcho().plugin]);
  await vault.create("admin", null, { name: "ECHO_TOKEN", value: "tok_server_secret_999" });
  const r = await call("admin-token", "GET", "/v1/plugins");
  assert.equal(r.status, 200);
  const p = r.json.plugins[0];
  assert.equal(p.id, "echo");
  assert.equal(p.status, "disabled");
  assert.deepEqual(p.secrets, [{ name: "ECHO_TOKEN", required: false, present: true }]);
  assert.ok(!r.text.includes("tok_server_secret_999"));
  assert.ok(!("network" in p) && !("mcpServers" in p.contributes));
  const m = await call("member-token", "GET", "/v1/plugins");
  assert.equal(m.json.plugins[0].secrets[0].present, false);
});

test("enable and disable require admin (403 for members) and change state", async (t) => {
  const { call } = await harness(t, [makeEcho().plugin]);
  assert.equal((await call("member-token", "POST", "/v1/plugins/echo/enable")).status, 403);
  assert.equal((await call("member-token", "POST", "/v1/plugins/echo/disable")).status, 403);
  const on = await call("admin-token", "POST", "/v1/plugins/echo/enable");
  assert.equal(on.status, 200);
  assert.equal(on.json.plugin.status, "enabled");
  assert.equal((await call("admin-token", "POST", "/v1/plugins/nope/enable")).status, 404);
  const off = await call("admin-token", "POST", "/v1/plugins/echo/disable");
  assert.equal(off.json.plugin.status, "disabled");
});

test("settings GET/PUT validate input; install scope needs admin to write", async (t) => {
  const { call } = await harness(t, [makeEcho().plugin]);
  assert.equal((await call("admin-token", "PUT", "/v1/plugins/echo/settings", { settings: { greeting: "hi", mode: "a" } })).status, 200);
  // install-scope config is admin configuration: members cannot read it
  assert.equal((await call("member-token", "GET", "/v1/plugins/echo/settings")).status, 403);
  assert.deepEqual((await call("admin-token", "GET", "/v1/plugins/echo/settings")).json.settings, { greeting: "hi", mode: "a" });
  assert.equal((await call("member-token", "PUT", "/v1/plugins/echo/settings", { settings: { greeting: "x" } })).status, 403);
  for (const bad of [{ settings: { nope: 1 } }, { settings: { mode: "zzz-LEAKY" } }, { settings: { greeting: 5 } }, { settings: [] }, {}]) {
    const r = await call("admin-token", "PUT", "/v1/plugins/echo/settings", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(!r.text.includes("zzz-LEAKY"));
  }
  assert.deepEqual((await call("admin-token", "GET", "/v1/plugins/echo/settings")).json.settings, { greeting: "hi", mode: "a" });
});

test("/api/* reaches the plugin when enabled and answers 404 plugin_disabled otherwise", async (t) => {
  const { call } = await harness(t, [makeEcho().plugin]);
  const off = await call("member-token", "GET", "/v1/plugins/echo/api/ping");
  assert.equal(off.status, 404);
  assert.equal(off.json.error.code, "plugin_disabled");
  await call("admin-token", "POST", "/v1/plugins/echo/enable");
  assert.deepEqual((await call("member-token", "GET", "/v1/plugins/echo/api/ping")).json, { pong: true, userId: "member" });
  assert.deepEqual((await call("member-token", "POST", "/v1/plugins/echo/api/echo", { a: 1 })).json, { body: { a: 1 } });
  assert.deepEqual((await call("member-token", "GET", "/v1/plugins/echo/api/items/42?x=y")).json, { id: "42", query: { x: "y" } });
  assert.equal((await call("member-token", "GET", "/v1/plugins/echo/api/missing")).status, 404);
  const crash = await call("member-token", "GET", "/v1/plugins/echo/api/crash");
  assert.equal(crash.status, 500);
  assert.ok(!crash.text.includes("internal detail"));
  await call("admin-token", "POST", "/v1/plugins/echo/disable");
  assert.equal((await call("member-token", "GET", "/v1/plugins/echo/api/ping")).json.error.code, "plugin_disabled");
});

test("user-scoped plugins also need the per-user toggle", async (t) => {
  const { call } = await harness(t, [makeEcho(undefined, { scope: "user" }).plugin]);
  await call("admin-token", "POST", "/v1/plugins/echo/enable");
  assert.equal((await call("member-token", "GET", "/v1/plugins/echo/api/ping")).json.error.code, "plugin_disabled");
  const on = await call("member-token", "PUT", "/v1/plugins/echo/user", { enabled: true });
  assert.equal(on.json.plugin.userEnabled, true);
  assert.equal((await call("member-token", "GET", "/v1/plugins/echo/api/ping")).status, 200);
  assert.equal((await call("admin-token", "GET", "/v1/plugins/echo/api/ping")).status, 404);
  assert.equal((await call("member-token", "PUT", "/v1/plugins/echo/user", { enabled: "yes" })).status, 400);
  // member settings are per user and survive a kv write
  assert.equal((await call("member-token", "PUT", "/v1/plugins/echo/settings", { settings: { greeting: "m" } })).status, 200);
  assert.deepEqual((await call("admin-token", "GET", "/v1/plugins/echo/settings")).json.settings, {});
});

test("secret values never escape through logs, error messages or route responses (raw, URL-encoded, JSON-escaped)", async (t) => {
  const TOKEN = 'tok/Secret+value "q" 9@x';
  const logs: any[] = [];
  const { call, vault } = await harness(t, [makeEcho().plugin], logs);
  await vault.create("member", null, { name: "ECHO_TOKEN", value: TOKEN });
  await call("admin-token", "POST", "/v1/plugins/echo/enable");
  const forms = [TOKEN, encodeURIComponent(TOKEN), JSON.stringify(TOKEN).slice(1, -1)];
  const clean = (text: string) => { for (const f of forms) assert.ok(!text.includes(f), "leaked form: " + f + " in " + text); };
  const thrown = await call("member-token", "GET", "/v1/plugins/echo/api/leak?mode=throw");
  assert.equal(thrown.status, 500);
  clean(thrown.text); clean(JSON.stringify(logs));
  assert.ok(logs.some((l) => l.event === "plugin.route_failed"));
  const returned = await call("member-token", "GET", "/v1/plugins/echo/api/leak?mode=return");
  assert.equal(returned.status, 200);
  assert.equal(returned.json.leaked, "[REDACTED]");
  clean(returned.text);
  const http = await call("member-token", "GET", "/v1/plugins/echo/api/leak?mode=http");
  assert.equal(http.status, 418);
  assert.equal(http.json.error.code, "teapot");
  assert.match(http.json.error.message, /REDACTED/);
  clean(http.text);
});
