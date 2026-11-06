import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { normalizeTask, TASK_CACHE_TTL_MS } from "../dist/plugins/taskSources.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

test.after(closeAll);
const manifest = (over = {}) => ({
  id: "tix", name: "Tickets", version: "1.0.0", apiVersion: 1, tier: "core", description: "d", scope: "user",
  secrets: [{ name: "TIX_TOKEN", required: false }],
  settings: [{ key: "q", type: "text", label: "Query" }],
  contributes: { taskSources: [{ id: "all", label: "Tickets", view: "generic" }] }, ...over,
});

async function setup(opts: { provider?: any; manifest?: any } = {}) {
  const f = await fakePool();
  await f.addUser("u1"); await f.addUser("u2");
  const calls = { list: 0, get: 0 };
  const provider = opts.provider ?? {
    async list(_u: string, o: any) { calls.list++; return { items: [{ externalId: "1", title: "T1", status: "Open", statusCategory: "todo", url: "https://t.test/1", updatedAt: "2026-01-02T00:00:00Z", fields: [{ label: "Q", value: o.query ?? "" }], secret: "nope" }, { externalId: "bad" }, { externalId: "2", title: "T2", statusCategory: "weird", url: "javascript:alert(1)" }], nextCursor: "c2" }; },
    async get(_u: string, id: string) { calls.get++; return id === "1" ? { externalId: "1", title: "T1", url: "https://t.test/1", statusCategory: "done" } : null; },
  };
  let now = 1_000_000;
  const plugin = definePlugin({ manifest: manifest(opts.manifest), start(ctx) { ctx.taskSources.register({ id: "all", provider }); } });
  const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: { async reveal() { return {}; } } as never, sink: () => undefined, now: () => now });
  await host.load();
  await host.enable("tix", "u1");
  const get = (userId: string, path: string) => host.handle({ userId, method: "GET", pathname: new URL("http://x" + path).pathname, query: new URL("http://x" + path).searchParams, readBody: async () => undefined, requireAdmin: async () => undefined });
  const toggle = (userId: string, enabled: boolean) => host.handle({ userId, method: "PUT", pathname: "/v1/plugins/tix/user", query: new URLSearchParams(), readBody: async () => ({ enabled }), requireAdmin: async () => undefined });
  return { ...f, host, calls, get, toggle, tick: (ms: number) => { now += ms; } };
}

test("normalizeTask follows the ExternalTask schema and drops unusable items", () => {
  const t = normalizeTask({ externalId: 7, title: " Hello ", status: "Open", statusCategory: "doing", url: "https://x.test/a", updatedAt: "2026-02-03T04:05:06Z", assignee: "Ann", priority: "High", fields: [{ label: "A", value: "b" }, { label: "", value: "x" }], extra: 1 }, "p/s")!;
  assert.deepEqual(t, { sourceId: "p/s", externalId: "7", title: "Hello", status: "Open", statusCategory: "doing", url: "https://x.test/a", updatedAt: "2026-02-03T04:05:06.000Z", fields: [{ label: "A", value: "b" }], assignee: "Ann", priority: "High" });
  assert.equal(normalizeTask({ externalId: "1", title: "t", url: "ftp://x" }, "p/s"), null);
  assert.equal(normalizeTask({ title: "t", url: "https://x" }, "p/s"), null);
  assert.equal(normalizeTask(null, "p/s"), null);
  assert.equal(normalizeTask({ externalId: "1", title: "t", url: "https://x.test", statusCategory: "nope" }, "p/s")!.statusCategory, "todo");
});

test("listing only covers sources of plugins the user has enabled", async () => {
  const { get, toggle } = await setup();
  assert.deepEqual((await get("u2", "/v1/task-sources")).body, { sources: [] }); // user scope, not switched on
  await toggle("u2", true);
  const r: any = await get("u2", "/v1/task-sources");
  assert.deepEqual(r.body.sources.map((s: any) => [s.pluginId, s.sourceId, s.label, s.view]), [["tix", "all", "Tickets", "generic"]]);
  assert.deepEqual((await get("u1", "/v1/task-sources")).body, { sources: [] }); // u1 never switched it on
  await assert.rejects(get("u1", "/v1/task-sources/tix/all/items"), (e: any) => e.code === "source_not_found");
});

test("items are normalized and cached for 60s per user; a settings change busts the cache", async () => {
  const { get, toggle, calls, tick, host } = await setup();
  await toggle("u1", true); await toggle("u2", true);
  const a: any = await get("u1", "/v1/task-sources/tix/all/items?query=x");
  assert.equal(a.body.items.length, 1);
  assert.equal(a.body.items[0].sourceId, "tix/all");
  assert.ok(!("secret" in a.body.items[0]));
  assert.equal(a.body.nextCursor, "c2");
  await get("u1", "/v1/task-sources/tix/all/items?query=x");
  assert.equal(calls.list, 1);
  await get("u2", "/v1/task-sources/tix/all/items?query=x"); // another user: own cache entry
  assert.equal(calls.list, 2);
  await get("u1", "/v1/task-sources/tix/all/items?query=y"); // another query
  assert.equal(calls.list, 3);
  tick(TASK_CACHE_TTL_MS + 1);
  await get("u1", "/v1/task-sources/tix/all/items?query=x");
  assert.equal(calls.list, 4);
  await get("u1", "/v1/task-sources/tix/all/items?query=x");
  assert.equal(calls.list, 4);
  await host.handle({ userId: "u1", method: "PUT", pathname: "/v1/plugins/tix/settings", query: new URLSearchParams(), readBody: async () => ({ settings: { q: "z" } }), requireAdmin: async () => undefined });
  await get("u1", "/v1/task-sources/tix/all/items?query=x");
  assert.equal(calls.list, 5);
  await get("u2", "/v1/task-sources/tix/all/items?query=x"); // u2's entry had expired with the clock: one fresh call
  assert.equal(calls.list, 6);
  await host.handle({ userId: "u1", method: "PUT", pathname: "/v1/plugins/tix/settings", query: new URLSearchParams(), readBody: async () => ({ settings: { q: "w" } }), requireAdmin: async () => undefined });
  await get("u2", "/v1/task-sources/tix/all/items?query=x"); // u2's cache is untouched by u1's settings (user scope)
  assert.equal(calls.list, 6);
});

test("an undecodable item id is a 400 invalid_id, not a 500", async () => {
  const { get, toggle } = await setup();
  await toggle("u1", true);
  await assert.rejects(get("u1", "/v1/task-sources/tix/all/items/%E0%A4%A"), (e: any) => e.status === 400 && e.code === "invalid_id");
});

test("detail route returns one normalized item or 404", async () => {
  const { get, toggle } = await setup();
  await toggle("u1", true);
  const r: any = await get("u1", "/v1/task-sources/tix/all/items/1");
  assert.equal(r.body.item.statusCategory, "done");
  await assert.rejects(get("u1", "/v1/task-sources/tix/all/items/nope"), (e: any) => e.status === 404 && e.code === "item_not_found");
});

test("provider errors map to 502 source_unavailable without leaking upstream bodies", async () => {
  const provider = { async list() { throw new Error("upstream said: <html>token=sk-leak-123</html>"); }, async get() { throw new Error("sk-leak-123"); } };
  const { get, toggle } = await setup({ provider });
  await toggle("u1", true);
  for (const path of ["/v1/task-sources/tix/all/items", "/v1/task-sources/tix/all/items/1"]) {
    await assert.rejects(get("u1", path), (e: any) => e.status === 502 && e.code === "source_unavailable" && !/sk-leak|html/.test(e.message));
  }
});

test("missing required secrets answer 409 not_configured and are listed", async () => {
  const { get, toggle } = await setup({ manifest: { secrets: [{ name: "TIX_TOKEN", required: true }] } });
  await toggle("u1", true);
  const list: any = await get("u1", "/v1/task-sources");
  assert.deepEqual(list.body.sources[0].missingSecrets, ["TIX_TOKEN"]);
  await assert.rejects(get("u1", "/v1/task-sources/tix/all/items"), (e: any) => e.status === 409 && e.code === "not_configured");
});

test("an undeclared source cannot be registered; disabling removes sources", async () => {
  const f = await fakePool(); await f.addUser("u1");
  let err = "";
  const plugin = definePlugin({ manifest: manifest(), start(ctx) { try { ctx.taskSources.register({ id: "nope", provider: {} as never }); } catch (e) { err = String(e); } ctx.taskSources.register({ id: "all", provider: { async list() { return { items: [] }; }, async get() { return null; } } }); } });
  const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: { async reveal() { return {}; } } as never, sink: () => undefined });
  await host.load(); await host.enable("tix", "u1");
  assert.match(err, /not declared/);
  assert.ok(host.taskSources.has("tix", "all"));
  await host.disable("tix");
  assert.ok(!host.taskSources.has("tix", "all"));
});

// ---- secret scrubbing on the task-source path and events (review H-1) ----

const TOK = "tix/Secret+value \"q\" 77";
async function leaky(mode: "throw" | "field" | "url" | "http") {
  const f = await fakePool(); await f.addUser("u1");
  await f.db.exec(`INSERT INTO vault_secrets (user_id, name, value_enc) VALUES ('u1', 'TIX_TOKEN', 'enc')`);
  const logs: unknown[] = [];
  let pluginCtx: any;
  const plugin = definePlugin({
    manifest: manifest({ secrets: [{ name: "TIX_TOKEN", required: true }] }),
    start(ctx) {
      pluginCtx = ctx;
      ctx.taskSources.register({ id: "all", provider: {
        async list(userId: string) {
          const t = (await ctx.secrets.get(userId, "TIX_TOKEN")) as string;
          if (mode === "throw") throw new Error("GET https://api.tix.test/tickets?token=" + encodeURIComponent(t) + " failed");
          if (mode === "http") throw Object.assign(new Error("x"), {});
          return { items: [{ externalId: "1", title: "T " + t, status: "Open", url: mode === "url" ? "https://t.test/?token=" + encodeURIComponent(t) : "https://t.test/1", fields: [{ label: "debug", value: "fetched with " + t }] }] };
        },
        async get(userId: string) {
          const t = (await ctx.secrets.get(userId, "TIX_TOKEN")) as string;
          return { externalId: "1", title: "T", url: "https://t.test/1", fields: [{ label: "debug", value: JSON.stringify(t).slice(1, -1) }] };
        },
      } });
    },
  });
  const vault = { async reveal(_u: string, names: string[]) { return Object.fromEntries(names.map((n) => [n, TOK])); } };
  const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: vault as never, sink: (...a: unknown[]) => logs.push(a) });
  await host.load(); await host.enable("tix", "u1");
  const call = (method: string, path: string, body?: unknown) => host.handle({ userId: "u1", method, pathname: new URL("http://x" + path).pathname, query: new URL("http://x" + path).searchParams, readBody: async () => body, requireAdmin: async () => undefined }) as Promise<any>;
  await call("PUT", "/v1/plugins/tix/user", { enabled: true });
  return { host, call, logs, ctx: () => pluginCtx };
}
const forms = [TOK, encodeURIComponent(TOK), JSON.stringify(TOK).slice(1, -1)];
const clean = (text: string) => { for (const f of forms) assert.ok(!text.includes(f), "leaked " + f + " in " + text); };

test("H-1a: a provider error carrying the token (raw or URL-encoded) reaches neither the log nor the 502 body", async () => {
  const { call, logs } = await leaky("throw");
  await assert.rejects(call("GET", "/v1/task-sources/tix/all/items"), (e: any) => { clean(JSON.stringify({ s: e.status, c: e.code, m: e.message })); return e.status === 502; });
  assert.ok(logs.some((l: any) => l[1] === "plugin.task_source_failed"));
  clean(JSON.stringify(logs));
});

test("H-1b: list and detail results are redacted before they leave the host", async () => {
  const { call } = await leaky("field");
  const r = await call("GET", "/v1/task-sources/tix/all/items");
  clean(JSON.stringify(r.body));
  assert.match(r.body.items[0].fields[0].value, /\[REDACTED\]/);
  assert.match(r.body.items[0].title, /\[REDACTED\]/);
  const d = await call("GET", "/v1/task-sources/tix/all/items/1");
  clean(JSON.stringify(d.body));
  assert.match(d.body.item.fields[0].value, /\[REDACTED\]/);
  const u = await leaky("url");
  clean(JSON.stringify((await u.call("GET", "/v1/task-sources/tix/all/items")).body));
});

test("H-1c: events.publish and toast data are redacted before delivery", async () => {
  const { call, host, ctx } = await leaky("field");
  await call("GET", "/v1/task-sources/tix/all/items"); // reveals the token, so the scrubber knows it
  const frames: any[] = [];
  host.events.subscribe("u1", (f) => frames.push(f));
  ctx().events.publish("u1", "debug", { url: "https://x/?token=" + encodeURIComponent(TOK), raw: TOK, list: [TOK] });
  ctx().toast("u1", { title: "token " + TOK, description: JSON.stringify(TOK).slice(1, -1) });
  assert.equal(frames.length, 2);
  clean(JSON.stringify(frames));
  assert.match(JSON.stringify(frames[0]), /REDACTED/);
});

test("H-1d: a failing stop() is logged scrubbed", async () => {
  const f = await fakePool(); await f.addUser("u1");
  const logs: unknown[] = [];
  const plugin = definePlugin({ manifest: manifest({ secrets: [{ name: "TIX_TOKEN" }] }), async start(ctx) { await ctx.secrets.get("u1", "TIX_TOKEN"); }, stop() { throw new Error("stop failed for " + TOK); } });
  const host = new PluginHost(f.pool as never, { plugins: [plugin], vault: { async reveal(_u: string, n: string[]) { return Object.fromEntries(n.map((x) => [x, TOK])); } } as never, sink: (...a: unknown[]) => logs.push(a) });
  await host.load(); await host.enable("tix", "u1"); await host.disable("tix");
  assert.ok(logs.some((l: any) => l[1] === "plugin.stop_failed"));
  clean(JSON.stringify(logs));
});
