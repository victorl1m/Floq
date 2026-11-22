import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost, integrationActive } from "../dist/plugins/host.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { builtinWhatsappFromEnv, whatsappIntegration } from "../dist/whatsappServer.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { echoManifest } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const KEY = "builtin-key-" + "k".repeat(30);

/** The shape of the WhatsApp plugin as far as the host cares: install scope, a url setting, a required key, one webhook. */
function wahaLike(probe: { ctx?: any; hooks: unknown[] }) {
  return definePlugin({
    manifest: echoManifest({
      id: "waha", name: "WhatsApp", access: "owner",
      secrets: [{ name: "WAHA_API_KEY", required: true }, { name: "WAHA_WEBHOOK_HMAC", required: false }],
      settings: [{ key: "baseUrl", type: "url", label: "WAHA address", description: "Where WAHA listens.", required: true }, { key: "session", type: "text", label: "Session" }],
      contributes: { views: [{ id: "inbox", label: "WhatsApp" }], webhooks: ["events"], routes: true, migrations: false },
    }),
    start(ctx) {
      probe.ctx = ctx;
      ctx.webhooks.on("events", (req) => { probe.hooks.push(req.json()); return { ok: true }; });
      ctx.routes.get("/leak", async () => ({ key: await ctx.secrets.getInstall("WAHA_API_KEY"), hook: await ctx.webhooks.url("events") }));
    },
  });
}

async function setup(env: Record<string, string> = { FLOQ_WHATSAPP_API_KEY: KEY }) {
  const f = await fakePool(); await f.addUser("admin");
  const probe = { ctx: undefined as any, hooks: [] as unknown[] };
  const fetched: string[] = [];
  let activity = 0;
  const host = new PluginHost(f.pool as never, {
    plugins: [wahaLike(probe)], encryptionKey: Buffer.alloc(32, 9), sink: () => undefined, publicUrl: "https://floq.example.com",
    fetchImpl: (async (u: unknown) => { fetched.push(String(u)); return new Response("{}"); }) as never,
    integrations: { waha: whatsappIntegration(builtinWhatsappFromEnv(env), () => activity++) },
  });
  await host.load(); await host.enable("waha", "admin");
  const call = (method: string, path: string, body?: unknown) => host.handle({ userId: "admin", method, pathname: "/v1/plugins/waha" + path, query: new URLSearchParams(), readBody: async () => body, requireAdmin: async () => undefined });
  const info = async () => (await host.list("admin")).find((p) => p.id === "waha")!;
  return { ...f, host, probe, fetched, call, info, activity: () => activity, ctx: () => probe.ctx };
}

test("integrationActive: empty or the built-in address itself", () => {
  assert.equal(integrationActive(undefined, "http://waha:3000"), true);
  assert.equal(integrationActive("  ", "http://waha:3000"), true);
  assert.equal(integrationActive("http://waha:3000/", "http://waha:3000"), true);
  assert.equal(integrationActive("https://waha.example.com", "http://waha:3000"), false);
  assert.equal(integrationActive("not a url", "http://waha:3000"), false);
});

test("built-in server: the plugin gets address, key and an internal webhook URL with nothing saved; the key is never stored or shown", async () => {
  const h = await setup();
  assert.equal((await h.ctx().settings.get("admin")).baseUrl, "http://waha:3000");
  assert.equal(await h.ctx().secrets.getInstall("WAHA_API_KEY"), KEY);
  assert.equal(await h.ctx().secrets.getInstall("WAHA_WEBHOOK_HMAC"), undefined); // only the declared integration secret is provided
  const hook: string = await h.ctx().webhooks.url("events");
  assert.match(hook, /^http:\/\/runtime:8787\/v1\/plugins\/waha\/hooks\/events\/[\w-]{20,}$/);
  // The plugin reaches the built-in address without any saved setting; a send counts as activity, a read does not.
  await h.ctx().fetchUserUrl("admin", "http://waha:3000/api/sessions");
  await h.ctx().fetchUserUrl("admin", "http://waha:3000/api/sendText", { method: "POST", body: "{}" });
  await assert.rejects(h.ctx().fetchUserUrl("admin", "http://elsewhere:3000/api/sessions"), /not one the owner configured/);
  assert.deepEqual(h.fetched, ["http://waha:3000/api/sessions", "http://waha:3000/api/sendText"]);
  assert.equal(h.activity(), 1);

  const p = await h.info();
  assert.deepEqual(p.integration, { kind: "builtin-whatsapp", active: true });
  assert.deepEqual(p.secrets.find((s) => s.name === "WAHA_API_KEY"), { name: "WAHA_API_KEY", description: undefined, required: false, present: true });
  const decl = p.settings.find((d) => d.key === "baseUrl")!;
  assert.equal(decl.required, false);
  assert.match(decl.description!, /^Leave empty to use the server built into this Floq runtime\. Where WAHA listens\./);
  // Saving the form with an empty address is accepted, and what is stored stays empty (the default is not written into the config).
  const saved = (await h.call("PUT", "/settings", { settings: { session: "default" } }))!.body as any;
  assert.deepEqual(saved.settings, { session: "default" });
  assert.deepEqual(((await h.call("GET", "/settings"))!.body as any).settings, { session: "default" });
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM plugin_secrets WHERE plugin_id = 'waha'")).rows[0].n, 0);
  // Nothing a route returns carries the key or the webhook token.
  const leak = JSON.stringify((await h.call("GET", "/api/leak"))!.body);
  assert.ok(!leak.includes(KEY), leak);
  assert.ok(!leak.includes(hook.slice(hook.lastIndexOf("/") + 1)), leak);
  assert.ok(!JSON.stringify(p).includes(KEY));
  assert.deepEqual({ ...(await h.host.serviceOf("waha")), external: null }, { installed: true, enabled: true, mode: "builtin", external: null });
});

test("built-in server: a message webhook is activity, a receipt is not", async () => {
  const h = await setup();
  const hook: string = await h.ctx().webhooks.url("events");
  const token = hook.slice(hook.lastIndexOf("/") + 1);
  const post = (body: unknown) => h.host.handleWebhook({ pluginId: "waha", name: "events", token, ip: "10.0.0.5", query: new URLSearchParams(), headers: {}, readRaw: async () => Buffer.from(JSON.stringify(body)) });
  await post({ event: "message", session: "default" });
  await post({ event: "message.ack", session: "default" });
  await post({ event: "session.status", session: "default" });
  assert.equal(h.probe.hooks.length, 3);
  assert.equal(h.activity(), 1);
});

test("external WAHA: a saved address switches every default off and the built-in key is never handed out", async () => {
  const h = await setup();
  await h.call("PUT", "/settings", { settings: { baseUrl: "https://waha.example.com" } });
  assert.equal((await h.ctx().settings.get("admin")).baseUrl, "https://waha.example.com");
  assert.equal(await h.ctx().secrets.getInstall("WAHA_API_KEY"), undefined);
  assert.match(await h.ctx().webhooks.url("events"), /^https:\/\/floq\.example\.com\/v1\/plugins\/waha\/hooks\/events\//);
  await assert.rejects(h.ctx().fetchUserUrl("admin", "http://waha:3000/api/sessions"), /not one the owner configured/);
  const p = await h.info();
  assert.deepEqual(p.integration, { kind: "builtin-whatsapp", active: false });
  assert.equal(p.secrets.find((s) => s.name === "WAHA_API_KEY")!.present, false);
  await h.call("PUT", "/secrets/WAHA_API_KEY", { value: "their-own-key-123456" });
  assert.equal(await h.ctx().secrets.getInstall("WAHA_API_KEY"), "their-own-key-123456");
  const svc = await h.host.serviceOf("waha");
  assert.equal(svc.mode, "external"); assert.equal(svc.external!.url, "https://waha.example.com");
  assert.equal(await svc.external!.secret(), "their-own-key-123456");
  // Back to the built-in server: clear the address. The stored external key is ignored, not sent to the built-in server.
  await h.call("PUT", "/settings", { settings: {} });
  assert.equal(await h.ctx().secrets.getInstall("WAHA_API_KEY"), KEY);
  assert.equal((await h.info()).integration!.active, true);
});

test("no built-in server deployed: the plugin behaves as before, and is still marked as an integration", async () => {
  const h = await setup({});
  assert.equal((await h.ctx().settings.get("admin")).baseUrl, undefined);
  assert.equal(await h.ctx().secrets.getInstall("WAHA_API_KEY"), undefined);
  const p = await h.info();
  assert.deepEqual(p.integration, { kind: "builtin-whatsapp", active: false });
  assert.equal(p.settings.find((d) => d.key === "baseUrl")!.required, true);
  assert.equal(p.secrets.find((s) => s.name === "WAHA_API_KEY")!.required, true);
  await assert.rejects(h.call("PUT", "/settings", { settings: {} }), { code: "invalid_settings" });
  assert.equal((await h.host.serviceOf("waha")).mode, "none");
  assert.deepEqual(await h.host.serviceOf("ghost"), { installed: false, enabled: false, mode: "none", external: null });
  assert.match(await h.ctx().webhooks.url("events"), /^https:\/\/floq\.example\.com\//);
});

test("other plugins get nothing from an integration", async () => {
  const f = await fakePool(); await f.addUser("admin");
  const probe = { ctx: undefined as any, hooks: [] as unknown[] };
  const other = definePlugin({ manifest: echoManifest({ id: "other", secrets: [{ name: "WAHA_API_KEY", required: false }], settings: [{ key: "baseUrl", type: "url", label: "Base" }], contributes: { routes: true, migrations: false } }), start(ctx) { probe.ctx = ctx; } });
  const host = new PluginHost(f.pool as never, { plugins: [other], encryptionKey: Buffer.alloc(32, 9), sink: () => undefined, integrations: { waha: whatsappIntegration(builtinWhatsappFromEnv({ FLOQ_WHATSAPP_API_KEY: KEY })) } });
  await host.load(); await host.enable("other", "admin");
  assert.equal(await probe.ctx.secrets.getInstall("WAHA_API_KEY"), undefined);
  assert.equal((await probe.ctx.settings.get("admin")).baseUrl, undefined);
  assert.equal((await host.list("admin"))[0].integration, undefined);
});
