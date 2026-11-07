import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../dist/plugins/host.js";
import { encryptSecret, decryptSecret, deriveKey } from "../dist/crypto.js";
import { pluginSecretAad } from "../dist/plugins/secrets.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";
import { makeEcho } from "./fixtures/plugins/echo/index.mts";

test.after(closeAll);
// Each test opens its own in-memory database; tests run one after another, so free it right away (11 live databases at once got this file SIGKILLed under full-suite memory pressure).
afterEach(closeAll);
const MASTER = Buffer.alloc(32, 9);
const VAL = "tok_vault_original_555";
const pkey = deriveKey(MASTER, "plugin-secrets/v1");

async function setup(opts: { refs?: { entry: string; secretNames: string[] }[] | null; plugins?: any[]; interval?: number } = {}) {
  const f = await fakePool(); await f.addUser("u1"); await f.addUser("u2");
  const logs: any[] = [];
  const plugins = opts.plugins ?? [makeEcho(undefined, { scope: "user" }).plugin];
  const host = new PluginHost(f.pool as never, { plugins, encryptionKey: MASTER, sink: (l: string, e: string, fields: unknown) => logs.push({ l, e, fields }), retryDelaysMs: [0, 0], lazyMigrationIntervalMs: opts.interval ?? 0 });
  const removed: string[] = [];
  const state = { refs: opts.refs === undefined ? [] : opts.refs, calls: 0 };
  host.setSecretMigrationPort({ vaultReferences: async () => { state.calls++; return state.refs; }, remove: async (_u: string, name: string) => { removed.push(name); } } as never);
  const putVault = (user: string, name: string, value: string) => f.db.query("INSERT INTO vault_secrets (user_id, name, value_enc) VALUES ($1,$2,$3) ON CONFLICT (user_id, name) DO UPDATE SET value_enc = $3", [user, name, encryptSecret(MASTER, value, user + ":vault:" + name)]);
  return { ...f, host, logs, removed, state, putVault };
}
const vaultRows = async (db: any) => (await db.query("SELECT user_id, name FROM vault_secrets ORDER BY user_id, name")).rows;

test("moves the vault secret into the plugin store, decryptable there, and deletes the vault row", async () => {
  const s = await setup();
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.putVault("u1", "UNRELATED", "keep-me");
  await s.host.load();
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "UNRELATED" }]);
  const enc = (await s.db.query("SELECT value_enc FROM plugin_secrets WHERE plugin_id='echo' AND owner_id='u1'")).rows[0].value_enc;
  assert.equal(decryptSecret(pkey, enc, pluginSecretAad("echo", "u1", "ECHO_TOKEN")), VAL);
  assert.deepEqual((await s.db.query("SELECT plugin_id, owner_id, name, kept_in_vault FROM plugin_secret_migrations")).rows, [{ plugin_id: "echo", owner_id: "u1", name: "ECHO_TOKEN", kept_in_vault: false }]);
  assert.ok(!JSON.stringify(s.logs).includes(VAL));
});

test("idempotent: a second boot changes nothing, and a re-created vault secret is not touched", async () => {
  const s = await setup();
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.host.load();
  await s.putVault("u1", "ECHO_TOKEN", "user-made-this-later");
  await s.host.load();
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
  assert.equal(await s.host.secrets.resolve("echo", "u1", "ECHO_TOKEN"), VAL);
  assert.equal((await s.db.query("SELECT 1 FROM plugin_secret_migrations")).rows.length, 1);
});

test("install scope moves the config owner's secret to '*install*'; users found through vault_audit are migrated too", async () => {
  const inst = await setup({ plugins: [makeEcho(undefined, { scope: "install" }).plugin] });
  await inst.db.query("INSERT INTO floq_plugins (id, config_owner) VALUES ('echo','u1')");
  await inst.putVault("u1", "ECHO_TOKEN", VAL);
  await inst.host.load();
  assert.equal(await inst.host.secrets.resolve("echo", "*install*", "ECHO_TOKEN"), VAL);
  assert.deepEqual(await vaultRows(inst.db), []);
  const usr = await setup();
  await usr.db.query("INSERT INTO vault_audit (user_id, session_id, secret_name, action) VALUES ('u2','plugin:echo','ECHO_TOKEN','reveal')");
  await usr.putVault("u2", "ECHO_TOKEN", VAL);
  await usr.host.load();
  assert.equal(await usr.host.secrets.resolve("echo", "u2", "ECHO_TOKEN"), VAL);
});

test("shared-use guards keep the vault row: referenced by a non-plugin MCP entry, or configs unreadable", async () => {
  for (const refs of [[{ entry: "my-own-server", secretNames: ["ECHO_TOKEN"] }], null]) {
    const s = await setup({ refs });
    await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
    await s.putVault("u1", "ECHO_TOKEN", VAL);
    await s.host.load();
    assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
    assert.equal(await s.host.secrets.resolve("echo", "u1", "ECHO_TOKEN"), VAL);
    assert.equal((await s.db.query("SELECT kept_in_vault FROM plugin_secret_migrations")).rows[0].kept_in_vault, true);
    // later boot: the reference is gone and the value is unchanged -> the copy is removed
    s.state.refs = [];
    await s.host.load();
    assert.deepEqual(await vaultRows(s.db), []);
    assert.equal((await s.db.query("SELECT kept_in_vault FROM plugin_secret_migrations")).rows[0].kept_in_vault, false);
  }
});

test("two plugins that share a name both get a copy before the vault row goes", async () => {
  const a = makeEcho(undefined, { id: "echo", scope: "user" }).plugin;
  const b = makeEcho(undefined, { id: "echo2", scope: "user", contributes: { routes: true, migrations: false } }).plugin;
  const s = await setup({ plugins: [a, b] });
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true), ('echo2','u1',true)");
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.host.load();
  assert.equal(await s.host.secrets.resolve("echo", "u1", "ECHO_TOKEN"), VAL);
  assert.equal(await s.host.secrets.resolve("echo2", "u1", "ECHO_TOKEN"), VAL);
  assert.deepEqual(await vaultRows(s.db), []);
});

test("failure leaves both rows unchanged, logs plugin and name only, and is retried next boot", async () => {
  const s = await setup();
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
  await s.db.query("INSERT INTO vault_secrets (user_id, name, value_enc) VALUES ('u1','ECHO_TOKEN', 'v1.garbage.garbage.garbage')");
  await s.host.load();
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
  assert.equal((await s.db.query("SELECT 1 FROM plugin_secrets")).rows.length, 0);
  assert.equal((await s.db.query("SELECT 1 FROM plugin_secret_migrations")).rows.length, 0);
  const fail = s.logs.find((l: any) => l.e === "plugin.secret_migration_failed");
  assert.deepEqual(fail.fields, { plugin: "echo", secret: "ECHO_TOKEN" });
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.host.load();
  assert.equal(await s.host.secrets.resolve("echo", "u1", "ECHO_TOKEN"), VAL);
});

test("old plugin-<id>-* wrapper entries for a moved secret are removed; others stay", async () => {
  const s = await setup({ refs: [{ entry: "plugin-echo-api", secretNames: ["ECHO_TOKEN"] }, { entry: "plugin-other-x", secretNames: ["ECHO_TOKEN"] }, { entry: "mine", secretNames: [] }] });
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.host.load();
  assert.deepEqual(s.removed, ["plugin-echo-api", "plugin-echo-api"]); // claude + codex
  assert.deepEqual(await vaultRows(s.db), []);
});

const waitFor = async (check: () => Promise<boolean>, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
const ledger = async (db: any) => (await db.query("SELECT plugin_id, owner_id, name, kept_in_vault FROM plugin_secret_migrations ORDER BY owner_id, name")).rows;

test("lazy retry: unreadable at boot, readable later -> the vault row is removed once, and a repeat changes nothing", async () => {
  const s = await setup({ refs: null });
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.host.load();
  // Boot could not read the configs: copied, but the vault row stays and the ledger says so.
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
  assert.deepEqual(await ledger(s.db), [{ plugin_id: "echo", owner_id: "u1", name: "ECHO_TOKEN", kept_in_vault: true }]);
  assert.equal(await s.host.secrets.resolve("echo", "u1", "ECHO_TOKEN"), VAL);
  // Still unreadable: a lazy attempt keeps it.
  await s.host.lazyMigrate("u1");
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
  // The configs become readable: the next lazy attempt removes the vault copy.
  s.state.refs = [];
  await s.host.lazyMigrate("u1");
  assert.deepEqual(await vaultRows(s.db), []);
  assert.deepEqual(await ledger(s.db), [{ plugin_id: "echo", owner_id: "u1", name: "ECHO_TOKEN", kept_in_vault: false }]);
  assert.equal(await s.host.secrets.resolve("echo", "u1", "ECHO_TOKEN"), VAL);
  // Idempotent: a user-made vault secret of the same name later is not touched by another attempt or boot.
  await s.putVault("u1", "ECHO_TOKEN", "user-made-this-later");
  await s.host.lazyMigrate("u1", true); await s.host.load();
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
  assert.equal(await s.host.secrets.resolve("echo", "u1", "ECHO_TOKEN"), VAL);
  assert.equal((await ledger(s.db)).length, 1);
  assert.ok(!JSON.stringify(s.logs).includes(VAL));
});

test("lazy retry: listing plugins triggers it in the background, and a config that still references the secret keeps the vault copy", async () => {
  const s = await setup({ refs: null });
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.host.load();
  s.state.refs = [{ entry: "my-own-mcp", secretNames: ["ECHO_TOKEN"] }]; // a non-plugin entry still uses it
  await s.host.list("u1"); await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
  s.state.refs = []; // the user removed it
  await s.host.list("u1");
  assert.ok(await waitFor(async () => (await vaultRows(s.db)).length === 0), "the list call should have removed the vault copy");
});

test("lazy retry is scoped to the caller, throttled per user, and settles once nothing is pending", async () => {
  const s = await setup({ refs: null, interval: 60_000 });
  for (const u of ["u1", "u2"]) { await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo',$1,true)", [u]); await s.putVault(u, "ECHO_TOKEN", VAL); }
  await s.host.load();
  s.state.refs = [];
  const base = s.state.calls;
  await s.host.lazyMigrate("u1");
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u2", name: "ECHO_TOKEN" }]); // only u1's copy went
  // Throttled: an immediate second call for u1 does not even read the configs again (u1 is settled, anyway)...
  const afterFirst = s.state.calls;
  await s.host.lazyMigrate("u1");
  assert.equal(s.state.calls, afterFirst);
  // ...a forced run (enabling a plugin can create new work) does look again.
  await s.host.lazyMigrate("u1", true);
  assert.ok(s.state.calls >= afterFirst);
  assert.ok(afterFirst > base);
  // u2 is still pending until its own attempt.
  await s.host.lazyMigrate("u2");
  assert.deepEqual(await vaultRows(s.db), []);
});

test("lazy retry: still unreadable keeps retrying, but not more often than the throttle allows", async () => {
  const s = await setup({ refs: null, interval: 60_000 });
  await s.db.query("INSERT INTO floq_plugin_user_settings (plugin_id, user_id, enabled) VALUES ('echo','u1',true)");
  await s.putVault("u1", "ECHO_TOKEN", VAL);
  await s.host.load();
  const base = s.state.calls;
  await s.host.lazyMigrate("u1"); // first lazy attempt: reads once, still unreadable, still pending
  const first = s.state.calls;
  assert.ok(first > base);
  await s.host.lazyMigrate("u1"); await s.host.lazyMigrate("u1"); // inside the interval: no more reads
  assert.equal(s.state.calls, first);
  await s.host.lazyMigrate("u1", true); // force bypasses the throttle
  assert.ok(s.state.calls > first);
  assert.deepEqual(await vaultRows(s.db), [{ user_id: "u1", name: "ECHO_TOKEN" }]);
});
