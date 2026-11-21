import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, PLUGIN_API_MAX_BYTES } from "../dist/plugins/host.js";
import { HttpError } from "../dist/errors.js";
import { PluginInstaller } from "../dist/plugins/installer.js";
import { CatalogClient, PACKAGE_PATH_PREFIX } from "../dist/plugins/catalog.js";
import { loadInstalledPackages, packageDir } from "../dist/plugins/installed.js";
import { sha256Hex } from "../dist/plugins/package.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { forbidden } from "../dist/errors.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { echoManifest } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const CATALOG = "https://catalog.test/index.json";
const urlFor = (id: string, v: string) => `https://github.com${PACKAGE_PATH_PREFIX}${id}-v${v}/${id}-${v}.floqpkg.json`;

const RUNTIME = (version: string, extra = "") => `
export default {
  migrations: [{ id: "001_t", sql: "CREATE TABLE {{p}}things (user_id TEXT NOT NULL, label TEXT NOT NULL)" }],
  start(ctx) {
    ${extra}
    ctx.routes.get("/ping", ({ userId }) => ({ pong: true, userId, version: "${version}" }));
    ctx.routes.get("/teapot", () => { throw ctx.httpError(418, "teapot", "short and stout"); });
  },
};`;

interface Spec { id?: string; version: string; runtime?: string; ui?: string | null; manifest?: Record<string, unknown> }
const build = (s: Spec) => {
  const id = s.id ?? "echo2";
  const manifest = echoManifest({ id, name: "Echo 2", version: s.version, scope: "user", secrets: [], settings: [], contributes: { routes: true, migrations: true }, ...(s.manifest ?? {}) });
  const bytes = Buffer.from(JSON.stringify({ format: 1, manifest, runtime: s.runtime ?? RUNTIME(s.version), ui: s.ui ?? null, skills: {} }));
  return { id, version: s.version, bytes, sha256: sha256Hex(bytes) };
};
const entryOf = (p: ReturnType<typeof build>, over: Record<string, unknown> = {}) => ({ id: p.id, name: "Echo 2", version: p.version, apiVersion: 1, description: "d", scope: "user", secrets: [], network: [], contributes: ["routes"], package: urlFor(p.id, p.version), sha256: p.sha256, ...over });

async function setup(initial: ReturnType<typeof build>[] = [build({ version: "1.0.0" })]) {
  const f = await fakePool(); await f.addUser("admin"); await f.addUser("member");
  const pluginDir = mkdtempSync(join(tmpdir(), "floq-plugins-"));
  const served = new Map<string, Buffer>();
  const catalogEntries: unknown[] = [];
  const publish = (p: ReturnType<typeof build>, over: Record<string, unknown> = {}) => { served.set(urlFor(p.id, p.version), p.bytes); const i = catalogEntries.findIndex((e: any) => e.id === p.id); const e = entryOf(p, over); if (i >= 0) catalogEntries[i] = e; else catalogEntries.push(e); };
  initial.forEach((p) => publish(p));
  const requests: string[] = [];
  const fetchImpl = async (url: string) => { requests.push(url); if (url === CATALOG) return new Response(JSON.stringify({ format: 1, plugins: catalogEntries })); const b = served.get(url); return b ? new Response(b) : new Response("nope", { status: 404 }); };
  const logs: unknown[] = [];
  const builtin = definePlugin({ manifest: echoManifest({ id: "builtin-one", name: "Built-in" }) });
  const mkHost = () => new PluginHost(f.pool as never, { plugins: [builtin], encryptionKey: Buffer.alloc(32, 9), sink: (...a: unknown[]) => logs.push(a), retryDelaysMs: [0, 0] });
  const host = mkHost();
  await host.load();
  const installer = new PluginInstaller({ pool: f.pool as never, host, catalog: new CatalogClient({ catalogUrl: CATALOG, fetchImpl: fetchImpl as never }), pluginDir });
  host.setInstaller(installer);
  const call = (userId: string, method: string, path: string, body?: unknown) => host.handle({ userId, method, pathname: new URL("http://x" + path).pathname, query: new URL("http://x" + path).searchParams, readBody: async () => body, requireAdmin: async () => { if (userId !== "admin") throw forbidden("Administrator access required"); } }) as Promise<any>;
  const install = (id = "echo2") => call("admin", "POST", "/v1/plugins/install", { id, confirm: id });
  return { ...f, host, installer, call, install, pluginDir, publish, requests, logs, mkHost, builtin, served, catalogEntries, fetchImpl };
}
const countRows = async (db: any, table = "floq_plugin_packages") => (await db.query(`SELECT * FROM ${table}`)).rows.length;

test("install: verified, stored in the database, written to the cache, registered, and left off until an admin enables it", async () => {
  const t = await setup();
  const r = await t.install();
  assert.deepEqual([r.body.plugin.id, r.body.plugin.source, r.body.plugin.status, r.body.plugin.enabled], ["echo2", "installed", "disabled", false]);
  const p = build({ version: "1.0.0" });
  const row = (await t.db.query("SELECT id, version, sha256, installed_by FROM floq_plugin_packages")).rows[0];
  assert.deepEqual([row.id, row.version, row.sha256, row.installed_by], ["echo2", "1.0.0", p.sha256, "admin"]);
  const file = join(packageDir(t.pluginDir, "echo2", p.sha256), "runtime.mjs");
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), RUNTIME("1.0.0"));
  await t.call("admin", "POST", "/v1/plugins/echo2/enable");
  await t.call("member", "PUT", "/v1/plugins/echo2/user", { enabled: true });
  assert.deepEqual((await t.call("member", "GET", "/v1/plugins/echo2/api/ping")).body, { pong: true, userId: "member", version: "1.0.0" });
  assert.equal((await t.db.query("SELECT table_schema FROM information_schema.tables WHERE table_name='things'")).rows[0].table_schema, "plugin_echo2"); // migrations ran in the plugin schema
  await assert.rejects(t.call("member", "GET", "/v1/plugins/echo2/api/teapot"), (e: any) => e.status === 418 && e.code === "teapot" && e.message === "short and stout"); // ctx.httpError
});

test("install is admin-only and needs the typed id; built-ins and duplicates are refused", async () => {
  const t = await setup();
  await assert.rejects(t.call("member", "POST", "/v1/plugins/install", { id: "echo2", confirm: "echo2" }), (e: any) => e.status === 403);
  await assert.rejects(t.call("member", "GET", "/v1/plugins/catalog"), (e: any) => e.status === 403);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/install", { id: "echo2" }), (e: any) => e.status === 400 && e.code === "confirmation_required");
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/install", { id: "echo2", confirm: "other" }), (e: any) => e.code === "confirmation_required");
  assert.deepEqual([await countRows(t.db), t.requests.length], [0, 0]); // nothing was even fetched
  await t.install();
  await assert.rejects(t.install(), (e: any) => e.status === 409 && e.code === "already_installed");
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/install", { id: "builtin-one", confirm: "builtin-one" }), (e: any) => e.status === 409 && e.code === "builtin");
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/install", { id: "missing", confirm: "missing" }), (e: any) => e.status === 404 && e.code === "not_in_catalog");
});

test("a package whose bytes do not match the catalog sha256 is refused, and nothing is stored or written", async () => {
  const t = await setup();
  const p = build({ version: "1.0.0" });
  t.publish(p, { sha256: "0".repeat(64) });
  await assert.rejects(t.install(), (e: any) => e.status === 422 && e.code === "invalid_package" && /sha256/.test(e.message));
  assert.equal(await countRows(t.db), 0);
  assert.equal(existsSync(join(t.pluginDir, "echo2")), false);
  assert.equal(t.host.ids().includes("echo2"), false);
  // a package that claims a built-in id is refused too
  const clash = build({ id: "builtin-one", version: "1.0.0" });
  t.publish(clash);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/install", { id: "builtin-one", confirm: "builtin-one" }), (e: any) => e.status === 409);
});

test("installed plugins survive a restart from the database alone (the cache can be gone)", async () => {
  const t = await setup();
  await t.install(); await t.call("admin", "POST", "/v1/plugins/echo2/enable");
  await t.call("member", "PUT", "/v1/plugins/echo2/user", { enabled: true });
  const fresh = mkdtempSync(join(tmpdir(), "floq-plugins-restart-")); // a rebuilt container: empty cache directory
  const host2 = t.mkHost();
  const boot = await loadInstalledPackages(t.pool as never, host2, fresh, sha256Hex);
  assert.deepEqual(boot, { loaded: ["echo2"], broken: [] });
  await host2.load();
  assert.equal(host2.statusOf("echo2"), "enabled");
  const r = await host2.handle({ userId: "member", method: "GET", pathname: "/v1/plugins/echo2/api/ping", query: new URLSearchParams(), readBody: async () => undefined, requireAdmin: async () => undefined });
  assert.deepEqual(r!.body, { pong: true, userId: "member", version: "1.0.0" });
  assert.ok(existsSync(join(packageDir(fresh, "echo2", build({ version: "1.0.0" }).sha256), "runtime.mjs")));
});

test("a broken package at boot becomes invalid and the runtime and other plugins carry on", async () => {
  const t = await setup([build({ version: "1.0.0" }), build({ id: "good-two", version: "1.0.0" })]);
  await t.install(); await t.install("good-two");
  // corrupt one stored runtime (syntax error) and make another claim no default export
  await t.db.exec(`UPDATE floq_plugin_packages SET runtime = 'export default {;' WHERE id = 'echo2'`);
  const t2 = await t.db.query("SELECT manifest FROM floq_plugin_packages WHERE id='good-two'");
  void t2;
  const host2 = t.mkHost();
  const boot = await loadInstalledPackages(t.pool as never, host2, mkdtempSync(join(tmpdir(), "floq-plugins-b-")), sha256Hex);
  assert.deepEqual([boot.loaded, boot.broken], [["good-two"], ["echo2"]]);
  await host2.load();
  assert.equal(host2.statusOf("echo2"), "invalid");
  assert.equal(host2.statusOf("good-two"), "disabled");
  const list = (await host2.handle({ userId: "admin", method: "GET", pathname: "/v1/plugins", query: new URLSearchParams(), readBody: async () => undefined, requireAdmin: async () => undefined }))!.body as any;
  const broken = list.plugins.find((p: any) => p.id === "echo2");
  assert.deepEqual([broken.status, broken.source], ["invalid", "installed"]);
  assert.ok(broken.error && !broken.error.includes("/tmp"));
  await t.db.exec(`UPDATE floq_plugin_packages SET runtime = 'export const x = 1;' WHERE id = 'good-two'`);
  const host3 = t.mkHost();
  const boot3 = await loadInstalledPackages(t.pool as never, host3, mkdtempSync(join(tmpdir(), "floq-plugins-c-")), sha256Hex);
  assert.deepEqual(boot3.broken.sort(), ["echo2", "good-two"]);
});

test("update: only to a newer version, with rollback when the new version cannot start", async () => {
  const t = await setup();
  await t.install(); await t.call("admin", "POST", "/v1/plugins/echo2/enable"); await t.call("member", "PUT", "/v1/plugins/echo2/user", { enabled: true });
  const ping = async () => (await t.call("member", "GET", "/v1/plugins/echo2/api/ping")).body.version;
  assert.equal(await ping(), "1.0.0");
  await assert.rejects(t.call("member", "POST", "/v1/plugins/echo2/update"), (e: any) => e.status === 403);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/echo2/update"), (e: any) => e.status === 409 && e.code === "up_to_date");
  // a downgrade in the catalog is refused
  const older = build({ version: "0.9.0" }); t.publish(older);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/echo2/update"), (e: any) => e.status === 409 && e.code === "downgrade_refused");
  // a newer version that throws on start: rolled back, still 1.0.0 and still running
  const broken = build({ version: "1.1.0", runtime: RUNTIME("1.1.0", 'throw new Error("cannot start");') }); t.publish(broken);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/echo2/update"), (e: any) => e.code === "plugin_start_failed" || e.status >= 400);
  assert.equal(await ping(), "1.0.0");
  assert.equal(t.host.statusOf("echo2"), "enabled");
  assert.equal((await t.db.query("SELECT version, sha256 FROM floq_plugin_packages")).rows[0].version, "1.0.0");
  assert.equal((await t.db.query("SELECT version FROM floq_plugins WHERE id='echo2'")).rows[0].version, "1.0.0");
  // a good newer version swaps the code (a new cache path), keeps the plugin on, and records the new row
  const good = build({ version: "1.2.0" }); t.publish(good);
  const r = await t.call("admin", "POST", "/v1/plugins/echo2/update");
  assert.equal(r.body.plugin.version, "1.2.0");
  assert.equal(await ping(), "1.2.0");
  assert.equal(t.host.statusOf("echo2"), "enabled");
  assert.deepEqual((await t.db.query("SELECT version, sha256 FROM floq_plugin_packages")).rows[0], { version: "1.2.0", sha256: good.sha256 });
  assert.ok(existsSync(join(packageDir(t.pluginDir, "echo2", good.sha256), "runtime.mjs")));
});

test("update keeps data, settings and the webhook token, and runs migrations added by the new version", async () => {
  const t = await setup();
  await t.install(); await t.call("admin", "POST", "/v1/plugins/echo2/enable"); await t.call("member", "PUT", "/v1/plugins/echo2/user", { enabled: true });
  await t.host.handle({ userId: "member", method: "PUT", pathname: "/v1/plugins/echo2/settings", query: new URLSearchParams(), readBody: async () => ({ settings: {} }), requireAdmin: async () => undefined });
  await t.db.query("INSERT INTO plugin_echo2.things (user_id, label) VALUES ('member', 'kept')");
  await t.db.query("UPDATE floq_plugins SET webhook_token_hash = $1 WHERE id = 'echo2'", ["a".repeat(64)]);
  const next = build({ version: "1.3.0", runtime: RUNTIME("1.3.0").replace("migrations: [", 'migrations: [{ id: "002_more", sql: "CREATE TABLE {{p}}extras (user_id TEXT NOT NULL, note TEXT NOT NULL)" }, ') });
  t.publish(next);
  await t.call("admin", "POST", "/v1/plugins/echo2/update");
  assert.deepEqual((await t.db.query("SELECT migration_id FROM floq_plugin_migrations WHERE plugin_id='echo2' ORDER BY migration_id")).rows.map((r: any) => r.migration_id).sort(), ["001_t", "002_more"]);
  await t.db.query("INSERT INTO plugin_echo2.extras (user_id, note) VALUES ('member', 'new table works')");
  assert.deepEqual((await t.db.query("SELECT label FROM plugin_echo2.things")).rows, [{ label: "kept" }]);
  assert.equal((await t.db.query("SELECT 1 FROM floq_plugin_user_settings WHERE plugin_id='echo2'")).rows.length, 1);
  assert.deepEqual((await t.db.query("SELECT version, webhook_token_hash FROM floq_plugins WHERE id='echo2'")).rows[0], { version: "1.3.0", webhook_token_hash: "a".repeat(64) });
  assert.equal(t.host.statusOf("echo2"), "enabled");
});

test("plugin api routes accept bodies up to PLUGIN_API_MAX_BYTES (1 MiB ok, 9 MiB is 413)", async () => {
  const t = await setup([build({ version: "1.0.0", runtime: 'export default { start(ctx) { ctx.routes.post("/up", ({ body }) => ({ n: JSON.stringify(body).length })); } };' })]);
  await t.install(); await t.call("admin", "POST", "/v1/plugins/echo2/enable"); await t.call("member", "PUT", "/v1/plugins/echo2/user", { enabled: true });
  assert.equal(PLUGIN_API_MAX_BYTES, 8 * 1024 * 1024);
  const post = (size: number, path = "/v1/plugins/echo2/api/up") => {
    const text = JSON.stringify({ data: "x".repeat(size) });
    return t.host.handle({
      userId: "member", method: "POST", pathname: path, query: new URLSearchParams(), requireAdmin: async () => undefined,
      // same contract as server.ts readJson: the limit is applied as given, 413 payload_too_large above it
      readBody: async (limit = 64 * 1024) => { if (text.length > limit) throw new HttpError(413, "payload_too_large", "Request body too large"); return JSON.parse(text); },
    }) as Promise<any>;
  };
  assert.equal((await post(1024 * 1024)).body.n, 1024 * 1024 + 11);
  await assert.rejects(post(9 * 1024 * 1024), (e: any) => e.status === 413 && e.code === "payload_too_large");
});

test("uninstall: built-ins cannot be uninstalled; the package, cache and registry entry go, the data stays until 'delete data'", async () => {
  const t = await setup();
  await assert.rejects(t.call("admin", "DELETE", "/v1/plugins/builtin-one?confirm=builtin-one"), (e: any) => e.status === 409 && e.code === "builtin");
  await t.install(); await t.call("admin", "POST", "/v1/plugins/echo2/enable"); await t.call("member", "PUT", "/v1/plugins/echo2/user", { enabled: true });
  await t.host.handle({ userId: "member", method: "PUT", pathname: "/v1/plugins/echo2/settings", query: new URLSearchParams(), readBody: async () => ({ settings: {} }), requireAdmin: async () => undefined });
  await assert.rejects(t.call("member", "DELETE", "/v1/plugins/echo2?confirm=echo2"), (e: any) => e.status === 403);
  await assert.rejects(t.call("admin", "DELETE", "/v1/plugins/echo2"), (e: any) => e.code === "confirmation_required");
  assert.equal(await countRows(t.db), 1);
  const r = await t.call("admin", "DELETE", "/v1/plugins/echo2?confirm=echo2");
  assert.deepEqual(r.body, { uninstalled: true });
  assert.equal(await countRows(t.db), 0);
  assert.equal(existsSync(join(t.pluginDir, "echo2")), false);
  assert.equal(t.host.ids().includes("echo2"), false);
  assert.equal((await t.db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='plugin_echo2'")).rows.length, 1); // data kept
  assert.equal((await t.db.query("SELECT 1 FROM floq_plugin_user_settings WHERE plugin_id='echo2'")).rows.length, 1);
  // reinstalling finds its data again (same id, same schema); migrations are not re-applied
  await t.install();
  assert.equal((await t.db.query("SELECT 1 FROM floq_plugin_migrations WHERE plugin_id='echo2'")).rows.length, 1);
  // "delete data": admin only, typed id, not while running
  await t.call("admin", "POST", "/v1/plugins/echo2/enable");
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/echo2/purge", { confirm: "echo2" }), (e: any) => e.status === 409 && e.code === "plugin_running");
  await t.call("admin", "POST", "/v1/plugins/echo2/disable");
  await assert.rejects(t.call("member", "POST", "/v1/plugins/echo2/purge", { confirm: "echo2" }), (e: any) => e.status === 403);
  await assert.rejects(t.call("admin", "POST", "/v1/plugins/echo2/purge", { confirm: "nope" }), (e: any) => e.code === "confirmation_required");
  await t.call("admin", "DELETE", "/v1/plugins/echo2?confirm=echo2");
  await t.call("admin", "POST", "/v1/plugins/echo2/purge", { confirm: "echo2" });
  assert.equal((await t.db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='plugin_echo2'")).rows.length, 0);
  for (const table of ["floq_plugin_user_settings", "floq_plugin_migrations"]) assert.equal((await t.db.query(`SELECT 1 FROM ${table} WHERE plugin_id='echo2'`)).rows.length, 0);
  assert.equal((await t.db.query("SELECT 1 FROM floq_plugins WHERE id='echo2'")).rows.length, 0);
});

test("the catalog lists built-in and installed state with an update flag", async () => {
  const t = await setup([build({ version: "1.0.0" }), build({ id: "builtin-one", version: "1.0.0" })]);
  await t.install();
  t.publish(build({ version: "1.1.0" }));
  const c = (await t.call("admin", "GET", "/v1/plugins/catalog")).body.plugins;
  const by = (id: string) => c.find((p: any) => p.id === id);
  assert.deepEqual([by("echo2").installedVersion, by("echo2").updateAvailable, by("echo2").builtin], ["1.0.0", true, false]);
  assert.deepEqual([by("builtin-one").installedVersion, by("builtin-one").updateAvailable, by("builtin-one").builtin], [null, false, true]);
});

test("the UI bundle is served only for an enabled, installed plugin, with its sha256", async () => {
  const ui = "export default { views: {} };";
  const t = await setup([build({ version: "1.0.0", ui, manifest: { contributes: { routes: true, migrations: true, views: [{ id: "main", label: "Echo" }] } } }), build({ id: "noui", version: "1.0.0" })]);
  await t.install(); await t.install("noui");
  await assert.rejects(t.call("admin", "GET", "/v1/plugins/echo2/ui.js"), (e: any) => e.status === 404 && e.code === "plugin_disabled");
  await t.call("admin", "POST", "/v1/plugins/echo2/enable"); await t.call("member", "PUT", "/v1/plugins/echo2/user", { enabled: true });
  const r = await t.call("member", "GET", "/v1/plugins/echo2/ui.js");
  assert.deepEqual([r.status, r.raw.text, r.raw.contentType, r.raw.headers["X-Floq-Plugin-Sha256"], r.raw.headers["Cache-Control"]], [200, ui, "text/javascript; charset=utf-8", sha256Hex(ui), "no-store"]);
  const list = (await t.call("member", "GET", "/v1/plugins")).body.plugins;
  assert.deepEqual(list.find((p: any) => p.id === "echo2").ui, { sha256: sha256Hex(ui) });
  assert.equal(list.find((p: any) => p.id === "noui").ui, null);
  await t.call("admin", "POST", "/v1/plugins/noui/enable"); await t.call("member", "PUT", "/v1/plugins/noui/user", { enabled: true });
  await assert.rejects(t.call("member", "GET", "/v1/plugins/noui/ui.js"), (e: any) => e.status === 404);
  await t.call("admin", "POST", "/v1/plugins/echo2/disable");
  await assert.rejects(t.call("member", "GET", "/v1/plugins/echo2/ui.js"), (e: any) => e.code === "plugin_disabled");
});

test("reserved route words cannot be plugin ids, and agents have no install path", async () => {
  const { parseManifest } = await import("../dist/plugins/manifest.js");
  for (const id of ["catalog", "install"]) assert.throws(() => parseManifest({ ...echoManifest({ id }) }), /reserved/);
  const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.ok(!/plugins\/install|installer/i.test(src.slice(src.indexOf("/internal/")).split("switch (path)")[0]), "no /internal route reaches the installer");
});
