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
  const host = new PluginHost(f.pool as never, { plugins, encryptionKey: Buffer.alloc(32, 9), sink: (level: string, event: string, fields: unknown) => logs.push({ level, event, fields }) });
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
  const { call, host } = await harness(t, [makeEcho().plugin]);
  await host.secrets.set("echo", "*install*", "ECHO_TOKEN", "tok_server_secret_999", "admin");
  const r = await call("admin-token", "GET", "/v1/plugins");
  assert.equal(r.status, 200);
  const p = r.json.plugins[0];
  assert.equal(p.id, "echo");
  assert.equal(p.status, "disabled");
  assert.deepEqual(p.secrets, [{ name: "ECHO_TOKEN", required: false, present: true }]);
  assert.ok(!r.text.includes("tok_server_secret_999"));
  assert.ok(!("network" in p) && !("mcpServers" in p.contributes));
  const m = await call("member-token", "GET", "/v1/plugins");
  assert.equal(m.json.plugins[0].secrets[0].present, true); // install scope: one shared credential
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
  const { call, host } = await harness(t, [makeEcho(undefined, { scope: "user" }).plugin], logs);
  await host.secrets.set("echo", "member", "ECHO_TOKEN", TOKEN, "member");
  await call("admin-token", "POST", "/v1/plugins/echo/enable");
  await call("member-token", "PUT", "/v1/plugins/echo/user", { enabled: true });
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

// ---- credentials routes (plugin secret store) ----
const VAL = "tok/Route+secret \"v\" 4242";
const B64 = Buffer.from(VAL).toString("base64");
const noValue = (text: string) => { for (const f of [VAL, encodeURIComponent(VAL), JSON.stringify(VAL).slice(1, -1), B64]) assert.ok(!text.includes(f), "a response contained a secret form"); };

test("credentials routes: user scope is per caller; values are write-only; delete is idempotent", async (t) => {
  const logs: any[] = [];
  const { call, host, db } = await harness(t, [makeEcho(undefined, { scope: "user" }).plugin], logs);
  const put = await call("member-token", "PUT", "/v1/plugins/echo/secrets/ECHO_TOKEN", { value: VAL });
  assert.equal(put.status, 204); assert.equal(put.text, "");
  const list = await call("member-token", "GET", "/v1/plugins/echo/secrets");
  assert.equal(list.status, 200); noValue(list.text);
  assert.equal(list.json.secrets[0].name, "ECHO_TOKEN");
  assert.equal(list.json.secrets[0].present, true);
  assert.equal(list.json.secrets[0].scope, "user");
  assert.equal(list.json.secrets[0].editable, true);
  assert.equal((await call("admin-token", "GET", "/v1/plugins/echo/secrets")).json.secrets[0].present, false);
  noValue((await call("member-token", "GET", "/v1/plugins")).text);
  assert.equal((await host.secrets.resolve("echo", "member", "ECHO_TOKEN")), VAL);
  noValue(JSON.stringify(logs));
  assert.equal((await call("member-token", "PUT", "/v1/plugins/echo/secrets/NOPE", { value: "x" })).json.error.code, "unknown_secret");
  for (const bad of ["", "a\u0000b", "x".repeat(8193), 5]) { const r = await call("member-token", "PUT", "/v1/plugins/echo/secrets/ECHO_TOKEN", { value: bad }); assert.equal(r.status, 400); }
  assert.equal((await call("member-token", "PUT", "/v1/plugins/echo/secrets/ECHO_TOKEN", { value: "x".repeat(20000) })).status, 413);
  assert.equal((await call("member-token", "DELETE", "/v1/plugins/echo/secrets/ECHO_TOKEN")).status, 204);
  assert.equal((await call("member-token", "DELETE", "/v1/plugins/echo/secrets/ECHO_TOKEN")).status, 204);
  assert.equal((await host.secrets.resolve("echo", "member", "ECHO_TOKEN")), undefined);
  const audit = JSON.stringify((await db.query("SELECT * FROM plugin_secret_audit")).rows);
  noValue(audit); assert.ok(audit.includes("set") && audit.includes("remove"));
});

test("credentials routes: install scope is admin-only to write; members see presence and editable=false", async (t) => {
  const { call, host } = await harness(t, [makeEcho().plugin]);
  assert.equal((await call("member-token", "PUT", "/v1/plugins/echo/secrets/ECHO_TOKEN", { value: VAL })).status, 403);
  assert.equal((await call("member-token", "DELETE", "/v1/plugins/echo/secrets/ECHO_TOKEN")).status, 403);
  assert.equal((await call("admin-token", "PUT", "/v1/plugins/echo/secrets/ECHO_TOKEN", { value: VAL })).status, 204);
  assert.equal(await host.secrets.resolve("echo", "*install*", "ECHO_TOKEN"), VAL);
  const m = await call("member-token", "GET", "/v1/plugins/echo/secrets");
  noValue(m.text);
  assert.deepEqual([m.json.secrets[0].present, m.json.secrets[0].editable, m.json.secrets[0].scope], [true, false, "install"]);
  assert.equal((await call("admin-token", "GET", "/v1/plugins/echo/secrets")).json.secrets[0].editable, true);
  assert.equal((await call("admin-token", "DELETE", "/v1/plugins/echo/secrets/ECHO_TOKEN")).status, 204);
  assert.equal((await call("admin-token", "GET", "/v1/plugins/echo/secrets")).json.secrets[0].present, false);
});

test("secret-migrations routes: names only, per caller, dismissible; the word is not a plugin id", async (t) => {
  const { call, db } = await harness(t, [makeEcho(undefined, { scope: "user" }).plugin]);
  await db.exec(`INSERT INTO plugin_secret_migrations (plugin_id, owner_id, name, kept_in_vault) VALUES ('echo','member','ECHO_TOKEN', true), ('echo','admin','ECHO_TOKEN', false)`);
  const r = await call("member-token", "GET", "/v1/plugins/secret-migrations");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((x: any) => [x.pluginId, x.pluginName, x.name, x.keptInVault]), [["echo", "Echo", "ECHO_TOKEN", true]]);
  assert.equal((await call("member-token", "POST", "/v1/plugins/secret-migrations/dismiss")).status, 204);
  assert.equal((await call("member-token", "GET", "/v1/plugins/secret-migrations")).json.items.length, 0);
  assert.equal((await call("admin-token", "GET", "/v1/plugins/secret-migrations")).json.items.length, 1);
});

test("an agent session token never reaches the credentials routes", async (t) => {
  const { call, vault } = await harness(t, [makeEcho().plugin]);
  const agent = vault.issueToken("admin", "sess-1");
  for (const [m, p, b] of [["GET", "/v1/plugins/echo/secrets"], ["PUT", "/v1/plugins/echo/secrets/ECHO_TOKEN", { value: "x" }], ["DELETE", "/v1/plugins/echo/secrets/ECHO_TOKEN"], ["GET", "/v1/plugins/secret-migrations"]] as const) {
    assert.equal((await call(agent, m, p, b)).status, 401, m + " " + p);
  }
});
