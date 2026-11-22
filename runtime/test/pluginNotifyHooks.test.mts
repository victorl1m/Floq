import test from "node:test";
import assert from "node:assert/strict";
import { createNetServer } from "./fixtures/plugins/freePort.mts";
import { createRuntimeServer } from "../dist/server.js";
import { Vault } from "../dist/vault.js";
import { PluginHost, publicBaseFrom } from "../dist/plugins/host.js";
import { Notifications, cleanPluginNote } from "../dist/notifications.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { echoManifest } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const PNG = "data:image/png;base64," + Buffer.from("not really a png but small").toString("base64");

function chatPlugin(probe: { ctx?: any; hooks: any[]; actions: any[] }, over: Record<string, unknown> = {}) {
  return definePlugin({
    manifest: echoManifest({ id: "chatty", name: "Chatty", icon: "IconMessage", access: "owner", secrets: [{ name: "HOOK_KEY", required: false }], contributes: { views: [{ id: "inbox", label: "Inbox" }], webhooks: ["events"], routes: true, migrations: false }, ...over }),
    start(ctx) {
      probe.ctx = ctx;
      ctx.webhooks.on("events", (req) => { probe.hooks.push(req.json()); return { ok: true }; });
      ctx.routes.post("/notify/action", (req) => { probe.actions.push(req); if ((req.body as any).actionId === "boom") throw ctx.httpError(409, "nope", "cannot do that"); return { done: (req.body as any).actionId }; });
      ctx.routes.get("/leak-url", async () => ({ url: await ctx.webhooks.url("events") }));
    },
  });
}

async function harness(t: any, opts: { publicUrl?: string | null; over?: Record<string, unknown> } = {}) {
  const f = await fakePool(); await f.addUser("admin"); await f.addUser("member");
  const probe = { ctx: undefined as any, hooks: [] as any[], actions: [] as any[] };
  const vault = new Vault(f.pool as never, { encryptionKey: Buffer.alloc(32, 5) } as never);
  const host = new PluginHost(f.pool as never, { plugins: [chatPlugin(probe, opts.over)], encryptionKey: Buffer.alloc(32, 9), sink: () => undefined, publicUrl: opts.publicUrl === undefined ? "https://floq.example.com" : opts.publicUrl });
  await host.load();
  const tokens: Record<string, string> = { "admin-token": "admin", "member-token": "member" };
  const auth = { handler() {}, api: { getSession: async ({ headers }: any) => { const u = tokens[(headers.get("authorization") ?? "").replace("Bearer ", "")]; return u ? { user: { id: u } } : null; } } };
  const port = await createNetServer();
  const notifications = new Notifications({ pool: f.pool as never });
  const config = { port, host: "127.0.0.1", allowedOrigins: [], maxBodyBytes: 1_000_000, version: "test", logLevel: "error", databaseUrl: "postgres://x/y", bootstrapAdminEmail: null };
  const server = createRuntimeServer({ config, manager: { activeCount: 0 }, auth, settings: {}, github: {}, vault, orchestrator: {}, pool: f.pool, credentials: {}, claudeOauth: {}, usage: {}, skills: {}, gitReview: {}, plugins: host, notifications } as never);
  await server.listen();
  t.after(async () => { await server.close(); });
  const raw = async (method: string, path: string, opts: { token?: string; body?: string } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(opts.token ? { Authorization: "Bearer " + opts.token } : {}), "Content-Type": "application/json" }, body: opts.body });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return {}; } })() };
  };
  const v1 = (token: string | null, method: string, path: string, body?: unknown) => raw(method, path, { token: token ?? undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  await v1("admin-token", "POST", "/v1/plugins/chatty/enable");
  // The list as the app gets it (the HTTP route also filters by organization, which this fixture has no tables for): JSON round trip included.
  const list = async (userId: string) => JSON.parse(JSON.stringify(await notifications.list(userId))) as any[];
  return { ...f, host, v1, raw, probe, notifications, list, ctx: () => probe.ctx };
}

test("publicBaseFrom: explicit wins, a loopback auth URL gives null, trailing slashes go", () => {
  assert.equal(publicBaseFrom("https://pub.example.com/", "http://localhost:8787"), "https://pub.example.com");
  assert.equal(publicBaseFrom(null, "https://floq.example.com/"), "https://floq.example.com");
  assert.equal(publicBaseFrom(undefined, "https://example.com/floq/"), "https://example.com/floq");
  for (const loop of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "http://app.localhost"]) assert.equal(publicBaseFrom("", loop), null, loop);
  assert.equal(publicBaseFrom("http://localhost:9000", "http://localhost:8787"), "http://localhost:9000"); // set on purpose
  assert.equal(publicBaseFrom("ftp://x", "nonsense"), null);
});

test("ctx.webhooks.url: a stable host-managed URL that works next to the admin token; stored hashed and encrypted only", async (t) => {
  const h = await harness(t);
  const url: string = await h.ctx().webhooks.url("events");
  assert.match(url, /^https:\/\/floq\.example\.com\/v1\/plugins\/chatty\/hooks\/events\/[A-Za-z0-9_-]{43}$/);
  assert.equal(await h.ctx().webhooks.url("events"), url);
  const [a, b] = await Promise.all([h.ctx().webhooks.url("events"), h.ctx().webhooks.url("events")]);
  assert.equal(a, b);
  const token = url.split("/").pop()!;
  const row = (await h.db.query("SELECT webhook_auto_hash, webhook_auto_enc, webhook_token_hash FROM floq_plugins WHERE id='chatty'")).rows[0] as any;
  assert.ok(row.webhook_auto_hash && row.webhook_auto_enc && !JSON.stringify(row).includes(token));
  assert.equal(row.webhook_token_hash, null);
  const path = new URL(url).pathname;
  assert.equal((await h.raw("POST", path, { body: JSON.stringify({ n: 1 }) })).status, 200);
  assert.deepEqual(h.probe.hooks, [{ n: 1 }]);
  assert.equal((await h.raw("POST", path.slice(0, -3) + "abc", { body: "{}" })).status, 404);
  // The admin's hand-made token and the host-managed one are both valid.
  const manual = (await h.v1("admin-token", "POST", "/v1/plugins/chatty/webhook-token")).json.token;
  assert.equal((await h.raw("POST", `/v1/plugins/chatty/hooks/events/${manual}`, { body: "{}" })).status, 200);
  // ...and a rotation drops the host-managed one: the old URL stops working, the plugin gets a new one.
  assert.equal((await h.raw("POST", path, { body: "{}" })).status, 404);
  const next: string = await h.ctx().webhooks.url("events");
  assert.notEqual(next, url);
  assert.equal((await h.raw("POST", new URL(next).pathname, { body: "{}" })).status, 200);
  assert.equal((await h.raw("POST", `/v1/plugins/chatty/hooks/events/${manual}`, { body: "{}" })).status, 200);
});

test("ctx.webhooks.url: declared names only, install scope only, null without a public base, never leaves through a route", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.ctx().webhooks.url("other"), /not declared/);
  const leaked = await h.v1("admin-token", "GET", "/v1/plugins/chatty/api/leak-url");
  const token = (await h.ctx().webhooks.url("events")).split("/").pop();
  assert.equal(leaked.status, 200);
  assert.ok(!leaked.text.includes(token), "the token is scrubbed from route output");
  const none = await harness(t, { publicUrl: null });
  assert.equal(await none.ctx().webhooks.url("events"), null);
  assert.equal((await none.db.query("SELECT webhook_auto_hash FROM floq_plugins WHERE id='chatty'")).rows[0].webhook_auto_hash, null);
  const user = await harness(t, { over: { scope: "user", access: undefined } });
  await assert.rejects(user.ctx().webhooks.url("events"), /install-scoped/);
});

test("ctx.secrets.setInstall stores a declared install secret (audited as the plugin)", async (t) => {
  const h = await harness(t);
  assert.equal(await h.ctx().secrets.getInstall("HOOK_KEY"), undefined);
  await h.ctx().secrets.setInstall("HOOK_KEY", "generated-key-123");
  assert.equal(await h.ctx().secrets.getInstall("HOOK_KEY"), "generated-key-123");
  await assert.rejects(h.ctx().secrets.setInstall("NOPE", "x"), /not declared/);
  const audit = (await h.db.query("SELECT actor, action FROM plugin_secret_audit WHERE name='HOOK_KEY' AND action='set'")).rows;
  assert.deepEqual(audit, [{ actor: "plugin:chatty", action: "set" }]);
  const enc = (await h.db.query("SELECT value_enc FROM plugin_secrets WHERE name='HOOK_KEY'")).rows[0] as any;
  assert.ok(!enc.value_enc.includes("generated-key-123"));
});

const note = (over: Record<string, unknown> = {}) => ({
  title: "Ana Souza", body: "Are we still on for 3?", subtitle: "Work · Family group", avatar: PNG, tag: "chat:1",
  actions: [{ id: "reply", label: "Reply", input: { placeholder: "Message" } }, { id: "read", label: "Mark read" }],
  actionRoute: "/notify/action", data: { session: "work", chatId: "1@c.us" }, target: { view: "inbox", params: { chat: "1@c.us", session: "work" } }, ...over,
});

test("ctx.notify: a message notification with the plugin part; route and data stay on the server", async (t) => {
  const h = await harness(t);
  const frames: any[] = []; h.notifications.subscribe("admin", (f) => frames.push(f));
  const { id } = await h.ctx().notify("admin", note());
  const listed = (await h.list("admin"));
  assert.equal(listed.length, 1);
  const n = listed[0];
  assert.deepEqual([n.id, n.category, n.level, n.title, n.body], [id, "message", "info", "Ana Souza", "Are we still on for 3?"]);
  assert.deepEqual(n.plugin, { id: "chatty", name: "Chatty", icon: "IconMessage", kind: "message", subtitle: "Work · Family group", avatar: PNG, tag: "chat:1",
    actions: [{ id: "reply", label: "Reply", input: { placeholder: "Message" } }, { id: "read", label: "Mark read" }], target: { view: "inbox", params: { chat: "1@c.us", session: "work" } } });
  assert.ok(!JSON.stringify(listed).includes("/notify/action") && !JSON.stringify(frames).includes("/notify/action") && !JSON.stringify(frames).includes('"data"'));
  assert.deepEqual(frames.map((f) => f.type), ["notification"]);
  assert.deepEqual(await h.list("member"), []);
});

test("notification action: runs the plugin's own route as the clicking user, with the stored data; then the notification is read", async (t) => {
  const h = await harness(t);
  const { id } = await h.ctx().notify("admin", note());
  const act = (token: string, nid: string, body: unknown) => h.v1(token, "POST", `/v1/notifications/${nid}/action`, body);
  // not yours, unknown action, missing text
  assert.equal((await act("member-token", id, { actionId: "read" })).status, 404);
  assert.equal((await act("admin-token", id, { actionId: "delete-everything" })).status, 404);
  assert.equal((await act("admin-token", "no-such-id", { actionId: "read" })).status, 404);
  assert.equal((await act("admin-token", id, { actionId: "reply" })).status, 400);
  assert.equal((await act("admin-token", id, { actionId: "reply", input: "   " })).status, 400);
  assert.equal(h.probe.actions.length, 0);
  // a body cannot redirect the call or swap the data
  const r = await act("admin-token", id, { actionId: "reply", input: "On my way", route: "/other", data: { chatId: "evil" }, userId: "member" });
  assert.deepEqual([r.status, r.json], [200, { ok: true, result: { done: "reply" } }]);
  assert.equal(h.probe.actions.length, 1);
  assert.equal(h.probe.actions[0].userId, "admin");
  assert.deepEqual(h.probe.actions[0].body, { notificationId: id, actionId: "reply", input: "On my way", data: { session: "work", chatId: "1@c.us" } });
  assert.ok((await h.list("admin"))[0].readAt);
  // an action without input ignores any text sent along
  await act("admin-token", id, { actionId: "read", input: "ignored" });
  assert.equal(h.probe.actions[1].body.input, null);
});

test("notification action: a plugin error comes back as is and leaves the notification unread; a disabled plugin answers 404", async (t) => {
  const h = await harness(t);
  const { id } = await h.ctx().notify("admin", note({ actions: [{ id: "boom", label: "Fail" }] }));
  const r = await h.v1("admin-token", "POST", `/v1/notifications/${id}/action`, { actionId: "boom" });
  assert.deepEqual([r.status, r.json.error?.code ?? r.json.code], [409, "nope"]);
  assert.equal((await h.list("admin"))[0].readAt, null);
  await h.v1("admin-token", "POST", "/v1/plugins/chatty/disable");
  assert.equal((await h.v1("admin-token", "POST", `/v1/notifications/${id}/action`, { actionId: "boom" })).status, 404);
});

test("ctx.notify: one notification per tag (the newer replaces), clear by tag, its own rate bucket", async (t) => {
  const h = await harness(t);
  const frames: any[] = []; h.notifications.subscribe("admin", (f) => frames.push(f));
  const first = await h.ctx().notify("admin", note({ body: "one" }));
  const second = await h.ctx().notify("admin", note({ body: "two" }));
  await h.ctx().notify("admin", note({ tag: "chat:2", body: "other chat" }));
  let list = (await h.list("admin"));
  assert.deepEqual(list.map((n: any) => n.body).sort(), ["other chat", "two"]);
  assert.deepEqual(frames.filter((f) => f.type === "notification-cleared").map((f) => f.ids), [[first.id]]);
  await h.ctx().notifications.clear("admin", "chat:1");
  list = (await h.list("admin"));
  assert.deepEqual(list.map((n: any) => n.body), ["other chat"]);
  assert.deepEqual(frames.filter((f) => f.type === "notification-cleared").map((f) => f.ids), [[first.id], [second.id]]);
  // 120 a minute for the plugin; agents' own bucket (60) is untouched by it
  let refused = 0;
  for (let i = 0; i < 125; i++) await h.ctx().notify("admin", { title: "m" + i }).catch((e: any) => { refused++; assert.equal(e.status, 429); });
  assert.equal(refused, 125 - (120 - 3));
  await h.notifications.create("admin", { title: "agent note" });
});

test("cleanPluginNote: text is cleaned, a bad avatar is dropped, actions and targets are validated", () => {
  const plugin = { id: "chatty", name: "Chatty", views: ["inbox"] };
  const ok = cleanPluginNote({ plugin, note: note({ avatar: "https://evil.test/track.png", subtitle: "a\u0000b\nc" }) });
  assert.equal(ok.plugin.avatar, null);
  assert.ok(!/[\u0000\n]/.test(ok.plugin.subtitle!));
  assert.deepEqual(ok.priv, { route: "/notify/action", data: { session: "work", chatId: "1@c.us" } });
  assert.equal(cleanPluginNote({ plugin, note: note({ avatar: "data:image/svg+xml;base64,AAAA" }) }).plugin.avatar, null);
  assert.equal(cleanPluginNote({ plugin, note: note({ avatar: "data:image/png;base64," + "A".repeat(60_000) }) }).plugin.avatar, null);
  const bad = (over: Record<string, unknown>) => assert.throws(() => cleanPluginNote({ plugin, note: note(over) }), (e: any) => e.status === 400);
  bad({ actionRoute: undefined });
  bad({ actionRoute: "/a/../b" });
  bad({ actionRoute: "https://evil.test/x" });
  bad({ actions: [{ id: "bad id", label: "x" }] });
  bad({ actions: [{ id: "a", label: "x" }, { id: "a", label: "y" }] });
  bad({ actions: Array.from({ length: 5 }, (_, i) => ({ id: "a" + i, label: "x" })) });
  bad({ target: { view: "someone-elses-view" } });
  bad({ target: { view: "inbox", params: { chat: 5 } } });
  bad({ data: { big: "x".repeat(3000) } });
  bad({ kind: "approval" });
  const plain = cleanPluginNote({ plugin, note: { title: "Hi" } });
  assert.deepEqual([plain.plugin.actions, plain.plugin.target, plain.priv.route], [[], null, null]);
});
