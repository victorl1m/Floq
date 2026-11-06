import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import { definePlugin } from "../dist/plugins/sdk.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { makeEcho } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
const vault = { async reveal() { return {}; } };
const quiet = () => undefined;
const mk = async (plugins: any[], storage?: "schema" | "prefix") => {
  const f = await fakePool();
  await f.addUser("admin");
  return { ...f, host: new PluginHost(f.pool as never, { plugins, vault: vault as never, storage, sink: quiet, retryDelaysMs: [0, 0] }) };
};
const rows = async (db: any, sql: string) => (await db.query(sql)).rows;

test("load registers valid plugins and an invalid manifest only disables itself", async () => {
  const { plugin } = makeEcho();
  const bad = definePlugin({ manifest: { id: "broken", name: "B", version: "1.0.0", apiVersion: 2, tier: "core", description: "d", scope: "user" } });
  const { host, db } = await mk([bad, plugin]);
  await host.load();
  assert.equal(host.statusOf("broken"), "invalid");
  assert.equal(host.statusOf("echo"), "disabled");
  assert.equal((await rows(db, "SELECT id FROM floq_plugins")).length, 1);
  await assert.rejects(host.enable("broken", "admin"), /invalid/);
  const list = await host.list("admin");
  assert.equal(list.find((p) => p.id === "broken")?.status, "invalid");
});

test("enable runs migrations in schema plugin_<id> with the ledger, calls start; disable calls stop and keeps data", async () => {
  const { plugin, probe } = makeEcho();
  const { host, db } = await mk([plugin]);
  await host.load();
  await host.enable("echo", "admin");
  assert.equal(probe.starts, 1);
  assert.equal(host.statusOf("echo"), "enabled");
  assert.deepEqual(await rows(db, "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'notes'"), [{ table_schema: "plugin_echo", table_name: "notes" }]);
  assert.deepEqual(await rows(db, "SELECT migration_id FROM floq_plugin_migrations"), [{ migration_id: "001_notes" }]);
  assert.deepEqual(await rows(db, "SELECT enabled, status, config_owner FROM floq_plugins"), [{ enabled: true, status: "enabled", config_owner: "admin" }]);
  await host.disable("echo");
  assert.equal(probe.stops, 1);
  assert.equal(host.statusOf("echo"), "disabled");
  assert.deepEqual(await rows(db, "SELECT enabled, status FROM floq_plugins"), [{ enabled: false, status: "disabled" }]);
  await host.enable("echo", "admin"); // re-enable: migration is not re-applied
  assert.equal((await rows(db, "SELECT 1 FROM floq_plugin_migrations")).length, 1);
});

test("hyphenated ids map to underscore schemas", async () => {
  const { plugin } = makeEcho(undefined, { id: "azure-devops" });
  const { host, db } = await mk([plugin]);
  await host.load();
  await host.enable("azure-devops", "admin");
  assert.deepEqual(await rows(db, "SELECT table_schema FROM information_schema.tables WHERE table_name = 'notes'"), [{ table_schema: "plugin_azure_devops" }]);
});

test("migrations and ledger roll back together on failure; fixed list then succeeds", async () => {
  const bad = [{ id: "001", sql: "CREATE TABLE {{p}}a (x INT)" }, { id: "002", sql: "CREATE TABLE {{p}}b (x INT); SELECT * FROM missing_table" }];
  const { plugin } = makeEcho(undefined, {}, bad);
  const { host, db } = await mk([plugin]);
  await host.load();
  await assert.rejects(host.enable("echo", "admin"));
  assert.equal((await rows(db, "SELECT 1 FROM floq_plugin_migrations")).length, 0);
  assert.equal((await rows(db, "SELECT 1 FROM information_schema.tables WHERE table_name = 'a'")).length, 0);
  assert.equal(host.statusOf("echo"), "failed");
});

test("table-prefix fallback when schemas are off", async () => {
  const { plugin } = makeEcho();
  const { host, db } = await mk([plugin], "prefix");
  await host.load();
  await host.enable("echo", "admin");
  assert.deepEqual(await rows(db, "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name LIKE 'plugin_echo__%'"), [{ table_schema: "public", table_name: "plugin_echo__notes" }]);
  assert.equal((await rows(db, "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'plugin_echo'")).length, 0);
});

test("three start failures mark the plugin failed until re-enabled", async () => {
  const probe = { starts: 0, stops: 0, failStarts: 3 };
  const { plugin } = makeEcho(probe);
  const { host, db } = await mk([plugin]);
  await host.load();
  await assert.rejects(host.enable("echo", "admin"), (e: any) => e.code === "plugin_start_failed");
  assert.equal(probe.starts, 3);
  assert.equal(host.statusOf("echo"), "failed");
  assert.deepEqual(await rows(db, "SELECT enabled, status FROM floq_plugins"), [{ enabled: false, status: "failed" }]);
  await host.enable("echo", "admin");
  assert.equal(host.statusOf("echo"), "enabled");
});

test("a transient start failure is retried and succeeds", async () => {
  const probe = { starts: 0, stops: 0, failStarts: 2 };
  const { plugin } = makeEcho(probe);
  const { host } = await mk([plugin]);
  await host.load();
  await host.enable("echo", "admin");
  assert.equal(probe.starts, 3);
  assert.equal(host.statusOf("echo"), "enabled");
});

test("a failing plugin does not stop others on load; enabled plugins restart on boot", async () => {
  const f = await fakePool();
  await f.addUser("admin");
  const a = makeEcho();
  const first = new PluginHost(f.pool as never, { plugins: [a.plugin], vault: vault as never, sink: quiet });
  await first.load();
  await first.enable("echo", "admin");
  const probe2 = { starts: 0, stops: 0, failStarts: 99 };
  const flaky = makeEcho(probe2, { id: "flaky" });
  const good = makeEcho(undefined, { id: "good" });
  await f.db.exec(`UPDATE floq_plugins SET enabled = true WHERE id = 'echo'`);
  await f.db.exec(`INSERT INTO floq_plugins (id, enabled) VALUES ('flaky', true), ('good', true)`);
  const second = new PluginHost(f.pool as never, { plugins: [flaky.plugin, good.plugin, makeEcho().plugin], vault: vault as never, sink: quiet, retryDelaysMs: [0, 0] });
  await second.load();
  assert.equal(second.statusOf("flaky"), "failed");
  // a boot-time failure keeps enabled=true so the next boot retries; it is not switched off for good
  assert.deepEqual((await f.db.query(`SELECT enabled, status FROM floq_plugins WHERE id='flaky'`)).rows, [{ enabled: true, status: "failed" }]);
  assert.equal(second.statusOf("good"), "enabled");
  assert.equal(second.statusOf("echo"), "enabled");
});

test("duplicate plugin ids: the second is invalid", async () => {
  const { host } = await mk([makeEcho().plugin, makeEcho().plugin]);
  await host.load();
  assert.equal(host.ids().length, 2);
  assert.equal(host.statusOf("echo"), "disabled");
  assert.equal(host.ids().filter((id) => host.statusOf(id) === "invalid").length, 1);
});

test("retries wait between attempts (backoff) and a later successful start clears failed", async () => {
  const probe = { starts: 0, stops: 0, failStarts: 2 };
  const { plugin } = makeEcho(probe);
  const f = await fakePool(); await f.addUser("admin");
  const stamps: number[] = [];
  const timed = { ...plugin, start(ctx: any) { stamps.push(Date.now()); return plugin.start!(ctx); } };
  const host = new PluginHost(f.pool as never, { plugins: [timed], vault: vault as never, sink: quiet, retryDelaysMs: [40, 80] });
  await host.load();
  await host.enable("echo", "admin");
  assert.ok(stamps[1] - stamps[0] >= 35 && stamps[2] - stamps[1] >= 75, JSON.stringify(stamps));
  assert.equal(host.statusOf("echo"), "enabled");
  assert.deepEqual((await f.db.query(`SELECT status FROM floq_plugins`)).rows, [{ status: "enabled" }]);
});

test("concurrent enables and disables serialise: start runs once", async () => {
  const { plugin, probe } = makeEcho();
  const { host } = await mk([plugin]);
  await host.load();
  await Promise.all([host.enable("echo", "admin"), host.enable("echo", "admin"), host.enable("echo", "admin")]);
  assert.equal(probe.starts, 1);
  await Promise.all([host.disable("echo"), host.enable("echo", "admin"), host.disable("echo")]);
  assert.equal(host.statusOf("echo"), "disabled");
  assert.equal(probe.stops, probe.starts);
});

test("stopAll calls stop on running plugins but keeps them enabled for the next boot", async () => {
  const { plugin, probe } = makeEcho();
  const { host, db } = await mk([plugin]);
  await host.load();
  await host.enable("echo", "admin");
  await host.stopAll();
  assert.equal(probe.stops, 1);
  assert.deepEqual((await rows(db, "SELECT enabled FROM floq_plugins")), [{ enabled: true }]);
  await host.stopAll();
  assert.equal(probe.stops, 1);
});
