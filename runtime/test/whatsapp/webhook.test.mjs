// Floq's webhook in WAHA: set when a session is created or attached, repaired when it is missing, stale or short of events, never rewritten when it is right.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { bundle, cleanup, closeAll, harness } from "./helpers.mjs";

let plugin, migrations, wh;
before(async () => { plugin = (await bundle("../../src/plugins/whatsapp/index.ts")).default; ({ migrations } = await bundle("../../src/plugins/whatsapp/migrations.ts")); wh = await bundle("../../src/plugins/whatsapp/webhook.ts"); });
afterEach(closeAll);
after(cleanup);

const URL_NOW = "https://floq.example.com/v1/plugins/waha/hooks/events/NEWTOKEN";
const OLD = { url: "https://old.example.com/v1/plugins/waha/hooks/events/OLDTOKEN", events: ["message.any"], hmac: { key: "k" }, retries: null, customHeaders: null };
const FOREIGN1 = { url: "https://n8n.example.com/webhook/abc", events: ["message"], hmac: null, retries: null, customHeaders: [{ name: "X-A", value: "1" }] };
const FOREIGN2 = { url: "https://other.example.com/hook", events: ["*"], hmac: { key: "theirs" }, retries: { policy: "constant", delaySeconds: 5, attempts: 3 }, customHeaders: null };
const CONFIG = { proxy: null, debug: true, metadata: { "user.id": "7" }, noweb: { store: { enabled: true, fullSync: true }, markOnline: false }, ignore: { status: true } };

/** A fake WAHA with these sessions ({ name: webhooks[] }); the PUTs are kept in puts. */
function fake(sessions, extra = {}) {
  const state = { sessions: {}, puts: [], posts: [], reset() { this.sessions = Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, { status: "WORKING", config: { ...CONFIG, webhooks: structuredClone(v) } }])); } };
  state.reset();
  const info = (name) => ({ name, status: state.sessions[name].status, engine: { engine: "NOWEB" }, me: null, config: state.sessions[name].config });
  state.waha = (method, path, req) => {
    if (method === "PUT" && state.failPut) return { status: 500, json: {} };
    if (method === "GET" && path === "/api/sessions") return { json: Object.keys(state.sessions).map(info) };
    const one = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (one && method === "GET") return state.sessions[one[1]] ? { json: info(one[1]) } : { status: 404, json: {} };
    if (one && method === "PUT") { state.puts.push({ name: one[1], body: req.body }); state.sessions[one[1]].config = req.body.config; return { json: {} }; }
    if (method === "POST" && path === "/api/sessions") { state.posts.push(req.body); state.sessions[req.body.name] = { status: "SCAN_QR_CODE", config: { webhooks: req.body.config?.webhooks ?? [] } }; return { json: { name: req.body.name } }; }
    if (method === "POST" && /^\/api\/sessions\/[^/]+\/start$/.test(path)) return { json: {} };
    return extra.fallback?.(method, path, req);
  };
  return state;
}
/** The plugin on that fake; the check it runs when it starts is let through and forgotten, so a test starts from a quiet plugin. */
async function boot(state, opts = {}) {
  const h = await harness(plugin, migrations, { waha: state.waha, webhookUrl: URL_NOW, ...opts });
  await h.idle();
  state.reset(); h.hmac = opts.hmac;
  state.puts.length = 0; state.posts.length = 0; h.requests.length = 0; h.secretWrites.length = 0;
  return h;
}
const hooks = (state, name = "default") => state.sessions[name].config.webhooks;
const ours = (w) => w.url.includes("/hooks/events/");

test("planWebhook: missing, stale, short of events, duplicates; foreign entries stay as they are and in order", () => {
  const want = { url: URL_NOW, key: "K" }, plan = (list) => wh.planWebhook("waha", list, want);
  assert.equal(plan([]).state, "missing");
  assert.equal(plan(undefined).state, "missing");
  const right = { url: URL_NOW, events: ["*"], hmac: { key: "K" } };
  assert.equal(plan([right]).state, "ok");
  assert.equal(plan([right, FOREIGN1]).state, "ok");
  assert.equal(plan([{ ...right, hmac: { key: "********" } }]).state, "ok", "a key WAHA shows masked is not a difference");
  assert.equal(plan([{ ...right, hmac: { key: "other" } }]).state, "stale");
  assert.equal(plan([{ ...right, hmac: null }]).state, "stale");
  assert.equal(plan([{ ...right, events: ["message.any"] }]).state, "missing-events");
  assert.ok(plan([{ ...right, events: ["message.any"] }]).missingEvents.includes("message.ack"));
  const p = plan([FOREIGN1, OLD, FOREIGN2, { ...OLD, url: "http://x/v1/plugins/waha/hooks/events/T2" }]);
  assert.equal(p.state, "stale");
  assert.equal(p.webhooks.length, 3);
  assert.equal(p.webhooks[0], FOREIGN1); assert.equal(p.webhooks[2], FOREIGN2);
  assert.equal(p.webhooks[1].url, URL_NOW);
  assert.deepEqual(p.webhooks[1].hmac, { key: "K" });
  assert.equal(plan([FOREIGN1]).webhooks.length, 2, "a foreign webhook alone does not count as Floq's");
  assert.equal(wh.isFloqHook("waha", { url: "https://a/v1/plugins/waha/hooks/eventsX/t" }), false);
  assert.equal(wh.maskUrl("waha", URL_NOW), "https://floq.example.com/v1/plugins/waha/hooks/events/…");
});

test("a session with no webhook gets Floq's: all events, signed, retries; every other config field and foreign webhook is sent back unchanged", async () => {
  const st = fake({ default: [FOREIGN1] }), h = await boot(st);
  const r = await h.post("/session/webhook-repair");
  assert.equal(st.puts.length, 1);
  const sent = st.puts[0].body.config;
  assert.deepEqual({ ...sent, webhooks: undefined }, { ...CONFIG, webhooks: undefined });
  assert.equal(sent.webhooks[0], undefined === 0 ? 0 : sent.webhooks[0]);
  assert.deepEqual(sent.webhooks[0], FOREIGN1);
  const mine = sent.webhooks[1];
  assert.equal(mine.url, URL_NOW);
  const plan = wh.planWebhook("waha", [mine], { url: URL_NOW, key: h.hmac });
  assert.equal(plan.state, "ok", "every wanted event is in it");
  assert.deepEqual(mine.retries, { policy: "exponential", delaySeconds: 2, attempts: 8 });
  assert.equal(r.state, "ok"); assert.equal(r.repaired, true);
  assert.equal(JSON.stringify(r).includes("NEWTOKEN"), false, "the credential never leaves in an answer");
  assert.equal(r.address, "https://floq.example.com/v1/plugins/waha/hooks/events/…");
  assert.ok(r.lastEnsuredAt);
});

test("an HMAC key is made when the secret is missing (32 random bytes, once) and reused when it is saved", async () => {
  const st = fake({ default: [] }), h = await boot(st);
  assert.equal(h.hmac, undefined);
  await h.post("/session/webhook-repair");
  assert.deepEqual(h.secretWrites, ["WAHA_WEBHOOK_HMAC"]);
  assert.match(h.hmac, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hooks(st)[0].hmac.key, h.hmac);
  const first = h.hmac;
  st.sessions.default.config.webhooks = [];
  await h.post("/session/webhook-repair");
  assert.equal(h.hmac, first, "the same key signs the next one");
  assert.equal(h.secretWrites.length, 1);

  const st2 = fake({ default: [] }), h2 = await boot(st2, { hmac: "my-own-key" });
  await h2.post("/session/webhook-repair");
  assert.equal(h2.secretWrites.length, 0);
  assert.equal(hooks(st2)[0].hmac.key, "my-own-key");
});

test("nothing differs: no PUT (a PUT restarts the session), whatever the key looks like in WAHA's answer", async () => {
  const st = fake({ default: [] }), h = await boot(st, { hmac: "K" });
  await h.post("/session/webhook-repair");
  assert.equal(st.puts.length, 1);
  const r = await h.post("/session/webhook-repair");
  assert.equal(st.puts.length, 1);
  assert.equal(r.state, "ok"); assert.equal(r.repaired, false);
  hooks(st)[0].hmac = { key: "********" };
  await h.post("/session/webhook-repair");
  assert.equal(st.puts.length, 1, "a masked key is not a difference by itself");
});

test("stale token or origin replaced, duplicates collapsed, foreign webhooks kept in place", async () => {
  const st = fake({ default: [FOREIGN1, OLD, FOREIGN2, { ...OLD, url: "http://other/v1/plugins/waha/hooks/events/T9" }] }), h = await boot(st, { hmac: "K" });
  const info = await h.get("/session");
  assert.equal(info.webhook.state, "stale");
  assert.equal(info.webhook.configured, true);
  assert.deepEqual(Object.keys(info.webhook).filter((k) => ["configured", "events", "missingEvents"].includes(k)).sort(), ["configured", "events", "missingEvents"]);
  await h.post("/session/webhook-repair");
  const list = hooks(st);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((w) => w.url), [FOREIGN1.url, URL_NOW, FOREIGN2.url]);
  assert.equal(list[0], list[0]); assert.deepEqual(list[0], FOREIGN1); assert.deepEqual(list[2], FOREIGN2);
  assert.equal((await h.get("/session")).webhook.state, "ok");
});

test("a webhook with the right address but too few events is extended; events the user added stay", async () => {
  const mine = { url: URL_NOW, events: ["message.any", "my.custom"], hmac: { key: "K" }, retries: { policy: "linear", delaySeconds: 9, attempts: 2 }, customHeaders: null };
  const st = fake({ default: [mine] }), h = await boot(st, { hmac: "K" });
  const before = await h.get("/session");
  assert.equal(before.webhook.state, "missing-events");
  assert.ok(before.webhook.missingEvents.includes("message.ack"));
  await h.post("/session/webhook-repair");
  const now = hooks(st)[0];
  assert.ok(now.events.includes("my.custom") && now.events.includes("message.ack") && now.events.includes("call.received"));
  assert.deepEqual(now.retries, mine.retries, "the user's retry settings stay");
  assert.equal(hooks(st).length, 1);
  assert.equal((await h.get("/session")).webhookHealth.state, "ok");
});

test("Floq does not know its public address: nothing is changed, the reason says what to set", async () => {
  const st = fake({ default: [] }), h = await boot(st, { webhookUrl: null });
  const r = await h.post("/session/webhook-repair");
  assert.equal(r.state, "unknown");
  assert.match(r.reason, /Address WAHA uses to reach Floq/);
  assert.equal(st.puts.length, 0);
  const info = await h.get("/session");
  assert.equal(info.webhookHealth.state, "unknown");
});

test("an older Floq (no ctx.webhooks.url): unknown with a reason, the old paths are untouched", async () => {
  const st = fake({ default: [OLD] }), h = await harness(plugin, migrations, { waha: st.waha });
  await h.idle();
  h.requests.length = 0;
  const info = await h.get("/session");
  assert.equal(info.webhookHealth.state, "unknown");
  assert.match(info.webhookHealth.reason, /newer Floq/);
  assert.equal(info.webhook.configured, true, "the old reading of the webhook is still there");
  const r = await h.post("/session/webhook-repair");
  assert.equal(r.state, "unknown");
  assert.equal(st.puts.length, 0);
  assert.equal(h.requests.filter((x) => x.method === "PUT").length, 0);
});

test("\"Address WAHA uses to reach Floq\" replaces the origin of Floq's address", async () => {
  const st = fake({ default: [] }), h = await boot(st, { settings: { webhookBase: "http://floq:3000/" } });
  await h.post("/session/webhook-repair");
  assert.equal(hooks(st)[0].url, "http://floq:3000/v1/plugins/waha/hooks/events/NEWTOKEN");
  assert.equal(wh.withBase(URL_NOW, ""), URL_NOW);
  assert.equal(wh.withBase(URL_NOW, "not a url"), URL_NOW);
});

test("the plugin repairs a lost webhook when it starts, and when the session turns WORKING (not again right after)", async () => {
  const st = fake({ default: [] });
  const h = await harness(plugin, migrations, { waha: st.waha, webhookUrl: URL_NOW });
  await h.idle();
  assert.equal(st.puts.length, 1, "on start");
  assert.equal(hooks(st).filter(ours).length, 1);
  st.sessions.default.config.webhooks = []; // a redeploy forgets it again
  await h.event("session.status", { status: "WORKING" });
  await h.idle();
  assert.equal(st.puts.length, 1, "WAHA restarts a session that was just changed: its WORKING event does not restart it again");
  await h.post("/session/webhook-repair");
  assert.equal(st.puts.length, 2, "the button always works");
});

test("two checks at once change a session once", async () => {
  const st = fake({ default: [] }), h = await boot(st);
  await Promise.all([h.post("/session/webhook-repair"), h.post("/session/webhook-repair"), h.post("/session/webhook-events")]);
  assert.equal(st.puts.length, 1);
});

test("a failed PUT is reported, not thrown; the next repair tries again", async () => {
  const st = fake({ default: [] }), h = await boot(st);
  st.failPut = true;
  const r = await h.post("/session/webhook-repair");
  assert.equal(r.state, "missing"); assert.equal(r.repaired, false); assert.match(r.lastError, /500/);
  st.failPut = false;
  assert.equal((await h.post("/session/webhook-repair")).state, "ok");
});

test("create: the new session is made with Floq's webhook; attach: an existing one gets it, one that has it is left alone", async () => {
  const st = fake({ default: [], spare: [], done: [{ url: URL_NOW, events: ["*"], hmac: { key: "********" } }] });
  const h = await boot(st, { kv: { accounts: [{ session: "default", label: "", name: "", phone: "", addedAt: "2026-01-01T00:00:00.000Z" }] } });
  const created = await h.post("/accounts/create", { name: "fresh" });
  assert.equal(created.webhook, "added");
  const made = st.posts.find((p) => p.name === "fresh");
  assert.equal(made.config.webhooks.length, 1);
  assert.equal(made.config.webhooks[0].url, URL_NOW);
  assert.equal(wh.planWebhook("waha", made.config.webhooks, { url: URL_NOW, key: h.hmac }).state, "ok");
  const a = await h.post("/accounts/attach", { name: "spare" });
  assert.equal(a.webhook, "added");
  assert.equal(hooks(st, "spare").filter(ours).length, 1);
  assert.equal(st.puts.length, 1);
  const b = await h.post("/accounts/attach", { name: "done" });
  assert.equal(b.webhook, "ok");
  assert.equal(st.puts.length, 1, "no PUT, no restart");
});

test("start: a missing session is created with Floq's webhook; a stopped one gets it before it starts", async () => {
  const st = fake({ default: [] }), h = await boot(st, { kv: { accounts: [{ session: "gone", label: "", name: "", phone: "", addedAt: "2026-01-01T00:00:00.000Z" }, { session: "default", label: "", name: "", phone: "", addedAt: "2026-01-01T00:00:00.000Z" }] } });
  await h.post("/session/start", {}, "u1");
  const made = st.posts.find((p) => p.name === "gone");
  assert.equal(made.config.webhooks[0].url, URL_NOW);
  st.sessions.default.status = "STOPPED";
  await h.routes["POST /session/start"]({ userId: "u1", query: { session: "default" }, params: {}, body: {} });
  assert.equal(hooks(st).filter(ours).length, 1);
  const order = h.requests.filter((x) => x.method !== "GET").map((x) => x.method + " " + x.path);
  assert.ok(order.indexOf("PUT /api/sessions/default") < order.indexOf("POST /api/sessions/default/start"));
});

test("the agents' diagnostics show the webhook's health with a masked address, never the URL or the key", async () => {
  const st = fake({ default: [OLD] }), h = await boot(st, { hmac: "SECRETKEY" });
  const d = await h.call("/diagnostics");
  assert.equal(d.sessionRead.webhook.state, "stale");
  assert.equal(d.sessionRead.webhook.address, "https://floq.example.com/v1/plugins/waha/hooks/events/…");
  const text = JSON.stringify(d);
  assert.equal(text.includes("NEWTOKEN"), false); assert.equal(text.includes("OLDTOKEN") && !JSON.stringify(d.sessionRead.webhooks).includes("OLDTOKEN"), false);
  assert.equal(text.includes("SECRETKEY"), false);
});

test("/session/webhook-events still works: with a known address it repairs, a non-owner gets 403", async () => {
  const st = fake({ default: [{ url: URL_NOW, events: ["message.any"], hmac: null }] }), h = await boot(st);
  const r = await h.post("/session/webhook-events");
  assert.equal(r.ok, true); assert.ok(r.added.includes("message.ack"));
  assert.ok(hooks(st)[0].events.includes("message.ack"));
  await assert.rejects(h.post("/session/webhook-repair", {}, "someone-else"), { status: 403 });
});
