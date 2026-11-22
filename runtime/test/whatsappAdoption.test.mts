// WhatsApp moved from the catalog plugin "waha" (floq-plugin-waha 3.x) into Floq. An install that used the plugin keeps everything:
// the built-in integration takes over under the same id, and the installed package is removed so only one consumer of the webhooks exists.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as esbuild } from "esbuild";
import { PluginHost } from "../dist/plugins/host.js";
import { PluginInstaller } from "../dist/plugins/installer.js";
import { CatalogClient, PACKAGE_PATH_PREFIX } from "../dist/plugins/catalog.js";
import { loadInstalledPackages } from "../dist/plugins/installed.js";
import { sha256Hex } from "../dist/plugins/package.js";
import { BUILTIN_PLUGINS } from "../dist/plugins/index.js";
import { manifest } from "../dist/plugins/whatsapp/manifest.js";
import whatsapp from "../dist/plugins/whatsapp/index.js";
import { forbidden } from "../dist/errors.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

test.after(closeAll);
/** PGlite is one connection. A real pool gives a transaction its own: here a checked-out client holds the connection until it is released, so a plugin query (search_path set for its schema) never interleaves with a host query. */
function exclusive(pool: { query: (sql: string, params?: unknown[]) => Promise<any>; connect: () => Promise<any> }) {
  let tail: Promise<unknown> = Promise.resolve();
  const take = () => { let free!: () => void; const mine = new Promise<void>((r) => { free = r; }); const ready = tail; tail = tail.then(() => mine); return ready.then(() => free); };
  return {
    query: async (sql: string, params?: unknown[]) => { const free = await take(); try { return await pool.query(sql, params); } finally { free(); } },
    connect: async () => { const free = await take(); const c = await pool.connect(); return { query: c.query, release() { c.release(); free(); } }; },
  };
}
const CATALOG = "https://catalog.test/index.json";
const CHAT = "5534999990000@c.us";

/** The catalog package of the plugin as 3.1.0 shipped it: the same runtime code, bundled standalone, under the plugin's manifest. */
async function pluginPackage() {
  const out = await esbuild({ entryPoints: [new URL("../src/plugins/whatsapp/index.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", external: ["node:*"], logLevel: "silent" });
  const bytes = Buffer.from(JSON.stringify({ format: 1, manifest: { ...manifest, version: "3.1.0" }, runtime: out.outputFiles[0].text, ui: "export default {};", skills: { waha: { "SKILL.md": readFileSync(new URL("../src/plugins/whatsapp/skills/waha/SKILL.md", import.meta.url), "utf8") } } }));
  return { bytes, sha256: sha256Hex(bytes), url: `https://github.com${PACKAGE_PATH_PREFIX}waha-v3.1.0/waha-3.1.0.floqpkg.json` };
}

const req = (host: PluginHost, userId: string) => (method: string, path: string, body?: unknown) => {
  const u = new URL("http://x" + path);
  return host.handle({ userId, method, pathname: u.pathname, query: u.searchParams, readBody: async () => body, requireAdmin: async () => { if (userId !== "admin") throw forbidden("Administrator access required"); } }) as Promise<any>;
};
const hook = (host: PluginHost, token: string, payload: unknown) => host.handleWebhook({ pluginId: "waha", name: "events", token, ip: "10.0.0.1", query: new URLSearchParams(), headers: {}, readRaw: async () => Buffer.from(JSON.stringify(payload)) });
const message = (n: number, body: string) => ({ event: "message.any", session: "default", payload: { id: `false_${CHAT}_M${n}`, timestamp: 1700000000 + n, from: CHAT, fromMe: false, body, hasMedia: false, _data: { notifyName: "Ana" } } });

test("Floq with WhatsApp built in adopts an installed waha 3.x plugin in place: data, settings, credentials, webhook token and on/off state stay; the package is gone", async () => {
  const f0 = await fakePool(); await f0.addUser("admin"); await f0.addUser("member");
  const f = { ...f0, pool: exclusive(f0.pool) };
  const pkg = await pluginPackage();
  const entry = { id: "waha", name: manifest.name, version: "3.1.0", apiVersion: 1, description: "d", scope: "install", secrets: ["WAHA_API_KEY"], network: [], contributes: ["views"], package: pkg.url, sha256: pkg.sha256 };
  const fetchCatalog = async (url: string) => (url === CATALOG ? new Response(JSON.stringify({ format: 1, plugins: [entry] })) : url === pkg.url ? new Response(pkg.bytes) : new Response("nope", { status: 404 }));
  // WAHA itself is not reachable in this test: every call fails like a server that is down.
  const opts = { encryptionKey: Buffer.alloc(32, 7), retryDelaysMs: [0, 0], sink: (...a: unknown[]) => { if (process.env.WAHA_TEST_LOG) console.log(JSON.stringify(a)); }, fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never };

  // ---- the Floq of before: no built-in WhatsApp, the plugin installed from the catalog and in use ----
  const dirOld = mkdtempSync(join(tmpdir(), "floq-waha-old-"));
  const old = new PluginHost(f.pool as never, { ...opts, plugins: [] });
  await old.load();
  old.setInstaller(new PluginInstaller({ pool: f.pool as never, host: old, catalog: new CatalogClient({ catalogUrl: CATALOG, fetchImpl: fetchCatalog as never }), pluginDir: dirOld }));
  const admin = req(old, "admin");
  assert.equal((await admin("POST", "/v1/plugins/install", { id: "waha", confirm: "waha" })).body.plugin.source, "installed");
  await admin("PUT", "/v1/plugins/waha/settings", { settings: { baseUrl: "https://waha.example.com", messageMe: true } });
  await admin("PUT", "/v1/plugins/waha/secrets/WAHA_API_KEY", { value: "old-key-123" });
  await admin("POST", "/v1/plugins/waha/enable");
  const { token } = (await admin("POST", "/v1/plugins/waha/webhook-token")).body;
  await hook(old, token, message(1, "hello from before"));
  await admin("POST", "/v1/plugins/waha/api/phone", { phone: "+5511988887777" });
  const before = (await admin("GET", "/v1/plugins/waha/api/chats")).body.chats;
  assert.equal(before.length, 1);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM plugin_waha.messages")).rows[0].n, 1);
  const ledger = (await f.db.query("SELECT migration_id FROM floq_plugin_migrations WHERE plugin_id = 'waha' ORDER BY 1")).rows.map((r: any) => r.migration_id);
  assert.ok(ledger.length >= 6);
  assert.ok(existsSync(join(dirOld, "waha")));
  await old.stopAll();

  // ---- the update: WhatsApp is compiled in ----
  assert.ok(BUILTIN_PLUGINS.includes(whatsapp), "the runtime bundles the WhatsApp integration");
  const next = new PluginHost(f.pool as never, { ...opts, plugins: [whatsapp] });
  const boot = await loadInstalledPackages(f.pool as never, next, dirOld, sha256Hex);
  assert.deepEqual(boot, { loaded: [], broken: [], superseded: ["waha"] });
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM floq_plugin_packages")).rows[0].n, 0, "the deprecated package is removed");
  assert.ok(!existsSync(join(dirOld, "waha")), "and its cached code too");
  await next.load();
  const admin2 = req(next, "admin");
  const listed = (await admin2("GET", "/v1/plugins")).body.plugins.filter((p: any) => p.id === "waha");
  assert.equal(listed.length, 1, "one consumer, not two");
  assert.deepEqual([listed[0].source, listed[0].status, listed[0].enabled, listed[0].userEnabled, listed[0].version], ["builtin", "enabled", true, true, manifest.version]);
  assert.equal(listed[0].secrets.find((s: any) => s.name === "WAHA_API_KEY").present, true, "the API key stayed in the plugin store");
  assert.deepEqual((await admin2("GET", "/v1/plugins/waha/settings")).body.settings, { baseUrl: "https://waha.example.com", messageMe: true });
  // No migration ran twice (a second CREATE TABLE would have failed the start) and none was lost.
  assert.deepEqual((await f.db.query("SELECT migration_id FROM floq_plugin_migrations WHERE plugin_id = 'waha' ORDER BY 1")).rows.map((r: any) => r.migration_id), ledger);
  // The chats and messages the plugin stored are what the built-in inbox shows.
  const after = (await admin2("GET", "/v1/plugins/waha/api/chats")).body.chats;
  assert.deepEqual(after.map((c: any) => c.chatId ?? c.id), before.map((c: any) => c.chatId ?? c.id));
  const msgs = (await admin2("GET", "/v1/plugins/waha/api/messages?chatId=" + encodeURIComponent(after[0].chatId ?? after[0].id))).body.messages;
  assert.deepEqual(msgs.map((m: any) => m.body ?? m.text), ["hello from before"]);
  assert.equal((await admin2("GET", "/v1/plugins/waha/api/phone")).body.phone, "+5511988887777", "the number for message-me (plugin kv) stayed");
  // The webhook address WAHA already has keeps working, now answered by the built-in.
  await hook(next, token, message(2, "hello after the update"));
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM plugin_waha.messages")).rows[0].n, 2);
  // Still owner-only, like the plugin was.
  await assert.rejects(req(next, "member")("GET", "/v1/plugins/waha/api/chats"), (e: any) => e.status === 404);
  // The catalog plugin cannot come back next to the built-in.
  next.setInstaller(new PluginInstaller({ pool: f.pool as never, host: next, catalog: new CatalogClient({ catalogUrl: CATALOG, fetchImpl: fetchCatalog as never }), pluginDir: dirOld }));
  await assert.rejects(admin2("POST", "/v1/plugins/install", { id: "waha", confirm: "waha" }), (e: any) => e.status === 409 && e.code === "builtin");
  await assert.rejects(admin2("DELETE", "/v1/plugins/waha?confirm=waha"), (e: any) => e.status === 409 && e.code === "builtin");
  // A second boot has nothing left to adopt.
  const again = new PluginHost(f.pool as never, { ...opts, plugins: [whatsapp] });
  assert.deepEqual(await loadInstalledPackages(f.pool as never, again, dirOld, sha256Hex), { loaded: [], broken: [] });
  await next.stopAll();
});

test("a plugin that was installed but switched off is adopted switched off, with its data kept", async () => {
  const f = await fakePool(); await f.addUser("admin");
  const pkg = await pluginPackage();
  await f.db.query("INSERT INTO floq_plugin_packages (id, version, sha256, manifest, runtime, ui, skills, installed_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,'{}'::jsonb,$7)",
    ["waha", "3.1.0", pkg.sha256, JSON.stringify({ ...manifest, version: "3.1.0" }), "export default {};", null, "admin"]);
  await f.db.query("INSERT INTO floq_plugins (id, enabled, version, status, config, config_owner) VALUES ('waha', false, '3.1.0', 'disabled', $1::jsonb, 'admin')", [JSON.stringify({ baseUrl: "https://waha.example.com" })]);
  const dir = mkdtempSync(join(tmpdir(), "floq-waha-off-"));
  const host = new PluginHost(f.pool as never, { plugins: [whatsapp], encryptionKey: Buffer.alloc(32, 7), retryDelaysMs: [0, 0], sink: () => undefined });
  assert.deepEqual((await loadInstalledPackages(f.pool as never, host, dir, sha256Hex)).superseded, ["waha"]);
  await host.load();
  assert.equal(host.statusOf("waha"), "disabled");
  assert.deepEqual((await req(host, "admin")("GET", "/v1/plugins/waha/settings")).body.settings, { baseUrl: "https://waha.example.com" });
});
