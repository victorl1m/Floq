import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import { FETCH_MAX_BYTES, hostAllowed, matchRoute, compilePattern } from "../dist/plugins/context.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { makeEcho } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const SECRET = "tok_supersecretvalue_12345";

async function setup(over: { fetchImpl?: any } = {}) {
  const f = await fakePool();
  await f.addUser("u1");
  const reveals: unknown[][] = [];
  const vault = { async reveal(...args: unknown[]) { reveals.push(args); return { ECHO_TOKEN: SECRET }; } };
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const { plugin, probe } = makeEcho();
  const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: vault as never, fetchImpl: over.fetchImpl, sink: (level, event, fields) => logs.push({ level, event, fields }) });
  await host.load();
  await host.enable("echo", "u1");
  return { ...f, host, ctx: probe.ctx, reveals, logs };
}

test("secrets: undeclared names throw, declared go through the vault audited as plugin:<id>", async () => {
  const { ctx, reveals } = await setup();
  await assert.rejects(ctx.secrets.get("u1", "OTHER_SECRET"), /not declared/);
  assert.equal(reveals.length, 0);
  assert.equal(await ctx.secrets.get("u1", "ECHO_TOKEN"), SECRET);
  assert.deepEqual(reveals[0], ["u1", ["ECHO_TOKEN"], null, "plugin:echo"]);
});

test("fetch: disallowed hosts and non-https are refused before any request", async () => {
  let calls = 0;
  const { ctx } = await setup({ fetchImpl: async () => { calls++; return new Response("ok"); } });
  await assert.rejects(ctx.fetch("https://evil.test/x"), /allow-list/);
  await assert.rejects(ctx.fetch("http://api.echo.test/x"), /https/);
  await assert.rejects(ctx.fetch("https://cdn.echo.test/x"), /allow-list/); // bare suffix is not *.suffix
  await assert.rejects(ctx.fetch("not a url"), /invalid URL/);
  assert.equal(calls, 0);
  const ok = await ctx.fetch("https://api.echo.test/x");
  assert.equal(ok.text(), "ok");
  assert.equal(calls, 1);
  assert.equal((await ctx.fetch("https://a.b.cdn.echo.test/x")).status, 200);
});

test("fetch: refuses redirects, passes a timeout signal, and caps the body at 5 MiB", async () => {
  let seen: any;
  const { ctx } = await setup({ fetchImpl: async (_u: unknown, init: any) => { seen = init; return new Response(new Uint8Array(FETCH_MAX_BYTES + 1)); } });
  await assert.rejects(ctx.fetch("https://api.echo.test/big"), /5 MiB/);
  assert.equal(seen.redirect, "error");
  assert.ok(seen.signal instanceof AbortSignal);
  const small = await setup({ fetchImpl: async () => new Response(new Uint8Array(FETCH_MAX_BYTES)) });
  assert.equal((await small.ctx.fetch("https://api.echo.test/ok")).bytes.length, FETCH_MAX_BYTES);
});

test("log: tagged with the plugin id and secret values never appear", async () => {
  const { ctx, logs } = await setup();
  await ctx.secrets.get("u1", "ECHO_TOKEN");
  ctx.log.info(`calling with ${SECRET}`, { header: `Bearer ${SECRET}`, nested: { v: SECRET } });
  const line = logs.find((l) => l.event === "plugin.echo")!;
  assert.equal(line.fields.plugin, "echo");
  assert.ok(!JSON.stringify(logs).includes(SECRET), JSON.stringify(logs));
  assert.ok(JSON.stringify(line).includes("[REDACTED]"));
});

test("db: queries run inside the plugin schema; forUser binds $1", async () => {
  const { ctx, db } = await setup();
  await ctx.db.query("INSERT INTO notes (user_id, body) VALUES ($1, $2)", ["u1", "hi"]);
  assert.deepEqual((await ctx.db.forUser("u1").query("SELECT body FROM notes WHERE user_id = $1")).rows, [{ body: "hi" }]);
  assert.deepEqual((await db.query("SELECT body FROM plugin_echo.notes")).rows, [{ body: "hi" }]);
  await assert.rejects(ctx.db.query("SELECT * FROM floq_plugins")); // public tables are not on the search_path
  // a failed statement rolls back and the connection stays usable
  await assert.rejects(ctx.db.query("INSERT INTO notes (user_id) VALUES ('x')"));
  assert.equal((await ctx.db.query("SELECT 1 AS one")).rows[0].one, 1);
});

test("kv: namespaced per plugin and user, does not leak into settings", async () => {
  const { ctx, db } = await setup();
  assert.equal(await ctx.kv.get("u1", "cursor"), undefined);
  await ctx.kv.set("u1", "cursor", { n: 1 });
  await ctx.kv.set("u1", "other", "x");
  await ctx.kv.set("u1", "cursor", { n: 2 });
  assert.deepEqual(await ctx.kv.get("u1", "cursor"), { n: 2 });
  assert.equal(await ctx.kv.get("u1", "other"), "x");
  assert.deepEqual((await db.query("SELECT enabled FROM floq_plugin_user_settings")).rows, [{ enabled: false }]);
});

test("schedule: runs never overlap and stop with the plugin", async (t) => {
  const { ctx, host } = await setup();
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  let active = 0, max = 0, runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  ctx.schedule(1000, async () => { runs++; active++; max = Math.max(max, active); await gate; active--; });
  const flush = () => new Promise((r) => setImmediate(r));
  mock.timers.tick(1000); await flush(); mock.timers.tick(1000); mock.timers.tick(1000);
  assert.equal(runs, 1);
  release();
  await flush();
  mock.timers.tick(1000); await flush();
  assert.equal(runs, 2);
  assert.equal(max, 1);
  await host.disable("echo");
  mock.timers.tick(5000); await flush();
  assert.equal(runs, 2);
  assert.throws(() => ctx.schedule(10, () => undefined), /at least/);
});

test("route matching and host allow-list helpers", () => {
  const e = [{ method: "GET" as const, segments: compilePattern("/items/:id"), handler: () => 1 }];
  assert.deepEqual(matchRoute(e, "GET", "/items/a%20b")?.params, { id: "a b" });
  assert.equal(matchRoute(e, "POST", "/items/1"), null);
  assert.equal(matchRoute(e, "GET", "/items"), null);
  assert.equal(matchRoute(e, "GET", "/items/%E0%A4%A"), null);
  assert.ok(hostAllowed("API.Echo.test", ["api.echo.test"]));
  assert.ok(!hostAllowed("xapi.echo.test", ["api.echo.test"]));
  assert.ok(!hostAllowed("echo.test", ["*.echo.test"]));
  assert.throws(() => compilePattern("items"));
  // decoded params may not smuggle separators, NUL or dot segments
  for (const bad of ["a%2Fb", "a%5Cb", "%2E%2E", "%2e", "a%00b"]) assert.equal(matchRoute(e, "GET", "/items/" + bad), null, bad);
});

test("routes need contributes.routes; getInstall reads the enabling admin's vault and is install-scope only", async () => {
  const f = await fakePool(); await f.addUser("admin"); await f.addUser("member");
  const reveals: unknown[][] = [];
  const vault = { async reveal(...a: unknown[]) { reveals.push(a); return { ECHO_TOKEN: SECRET }; } };
  const mk = async (manifest: Record<string, unknown>, id: string) => {
    const { plugin, probe } = makeEcho(undefined, { id, ...manifest });
    const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: vault as never, sink: () => undefined });
    await host.load(); return { host, probe, plugin };
  };
  // routes flag
  const nr = makeEcho(undefined, { id: "nr", contributes: { routes: false, migrations: false } });
  const h1 = new PluginHost(f.pool as never, { plugins: [nr.plugin], vault: vault as never, sink: () => undefined, retryDelaysMs: [0, 0] });
  await h1.load();
  await assert.rejects(h1.enable("nr", "admin"), (e: any) => e.code === "plugin_start_failed");
  // install scope
  const inst = await mk({ scope: "install", contributes: { routes: true, migrations: false } }, "inst");
  await inst.host.enable("inst", "admin");
  assert.equal(await inst.probe.ctx.secrets.getInstall("ECHO_TOKEN"), SECRET);
  assert.deepEqual(reveals.at(-1), ["admin", ["ECHO_TOKEN"], null, "plugin:inst"]);
  await assert.rejects(inst.probe.ctx.secrets.getInstall("NOPE"), /not declared/);
  // user scope refuses
  const usr = await mk({ scope: "user", contributes: { routes: true, migrations: false } }, "usr");
  await usr.host.enable("usr", "admin");
  await assert.rejects(usr.probe.ctx.secrets.getInstall("ECHO_TOKEN"), /install-scoped/);
});

test("ctx.approvals.request asks as the plugin and is withdrawn when the plugin stops", async () => {
  const { ctx, host } = await setup();
  const calls: any[] = [];
  host.setApprovals({ askAsPlugin: (userId: string, plugin: unknown, input: unknown, signal: AbortSignal) => new Promise((resolve) => { calls.push({ userId, plugin, input }); signal.addEventListener("abort", () => resolve("expired")); }) } as never);
  const pending = ctx.approvals.request({ userId: "u1", action: "Send", detail: "d" });
  assert.deepEqual(calls[0], { userId: "u1", plugin: { id: "echo", name: "Echo" }, input: { action: "Send", detail: "d" } });
  await host.disable("echo");
  assert.equal(await pending, "expired");
});

test("fetchUserUrl reaches only the origin of a saved url setting (self-hosted services)", async () => {
  const f = await fakePool(); await f.addUser("admin");
  const seen: string[] = [];
  const mk = async (manifest: Record<string, unknown>, id: string) => {
    const { plugin, probe } = makeEcho(undefined, { id, contributes: { routes: true, migrations: false }, ...manifest });
    const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: { async reveal() { return {}; } } as never, fetchImpl: (async (u: URL) => { seen.push(String(u)); return new Response("ok"); }) as never, sink: () => undefined });
    await host.load(); await host.enable(id, "admin");
    return { host, ctx: probe.ctx };
  };
  // no url setting declared: refused outright
  const none = await mk({}, "nourl");
  await assert.rejects(none.ctx.fetchUserUrl("admin", "https://api.echo.test/x"), /no url setting/);
  const withUrl = await mk({ scope: "install", settings: [{ key: "baseUrl", type: "url", label: "Base" }] }, "withurl");
  // nothing saved yet: nothing is reachable
  await assert.rejects(withUrl.ctx.fetchUserUrl("admin", "http://waha.local:3000/api/x"), /not one the owner configured/);
  await withUrl.host.handle({ userId: "admin", method: "PUT", pathname: "/v1/plugins/withurl/settings", query: new URLSearchParams(), readBody: async () => ({ settings: { baseUrl: "http://waha.local:3000/prefix" } }), requireAdmin: async () => undefined });
  assert.equal((await withUrl.ctx.fetchUserUrl("admin", "http://waha.local:3000/api/sendText", { method: "POST", body: "{}" })).text(), "ok");
  assert.deepEqual(seen, ["http://waha.local:3000/api/sendText"]);
  for (const bad of ["http://waha.local:3001/api/x", "https://waha.local:3000/api/x", "http://evil.test/api/x", "http://waha.local.evil.test:3000/x", "ftp://waha.local:3000/x", "not a url"]) await assert.rejects(withUrl.ctx.fetchUserUrl("admin", bad), /fetch/, bad);
  assert.equal(seen.length, 1);
});
