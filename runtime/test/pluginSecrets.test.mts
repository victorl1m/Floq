import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { PluginSecrets, pluginSecretAad } from "../dist/plugins/secrets.js";
import { deriveKey, encryptSecret, decryptSecret } from "../dist/crypto.js";
import { fakePool, closeAll } from "./fixtures/plugins/pgPool.mts";

test.after(closeAll);
// Each test opens its own in-memory database; tests run one after another, so free it right away (11 live databases at once got this file SIGKILLed under full-suite memory pressure).
afterEach(closeAll);
const MASTER = Buffer.alloc(32, 5);
const VAL = "tok_plugin_secret_value_777";

async function mk() {
  const f = await fakePool(); await f.addUser("u1"); await f.addUser("u2");
  const declared: Record<string, string[]> = { a: ["A_TOKEN"], b: ["A_TOKEN"] };
  const store = new PluginSecrets(f.pool as never, MASTER, (id) => declared[id] ?? []);
  return { ...f, store };
}

test("round trip, status never carries values, remove is idempotent", async () => {
  const { store, db } = await mk();
  assert.deepEqual(await store.status("a", "u1"), [{ name: "A_TOKEN", present: false, updatedAt: null }]);
  await store.set("a", "u1", "A_TOKEN", VAL, "u1");
  const st = await store.status("a", "u1");
  assert.equal(st[0].present, true); assert.ok(!JSON.stringify(st).includes(VAL));
  assert.equal(await store.resolve("a", "u1", "A_TOKEN"), VAL);
  assert.equal(await store.resolve("a", "u2", "A_TOKEN"), undefined);
  assert.ok(!JSON.stringify((await db.query("SELECT * FROM plugin_secrets")).rows).includes(VAL));
  await store.remove("a", "u1", "A_TOKEN", "u1"); await store.remove("a", "u1", "A_TOKEN", "u1");
  assert.equal(await store.resolve("a", "u1", "A_TOKEN"), undefined);
});

test("undeclared names are refused everywhere", async () => {
  const { store } = await mk();
  for (const op of [() => store.set("a", "u1", "OTHER", VAL, "u1"), () => store.resolve("a", "u1", "OTHER"), () => store.remove("a", "u1", "OTHER", "u1"), () => store.set("zzz", "u1", "A_TOKEN", VAL, "u1")]) {
    await assert.rejects(op(), (e: any) => e.code === "unknown_secret");
  }
});

test("AAD binds plugin, owner and name: a swapped ciphertext does not decrypt", async () => {
  const { store, db } = await mk();
  await store.set("a", "u1", "A_TOKEN", VAL, "u1");
  const enc = (await db.query("SELECT value_enc FROM plugin_secrets")).rows[0].value_enc as string;
  for (const [plugin, owner] of [["b", "u1"], ["a", "u2"]]) {
    await db.query("INSERT INTO plugin_secrets (plugin_id, owner_id, name, value_enc) VALUES ($1,$2,'A_TOKEN',$3)", [plugin, owner, enc]);
    await assert.rejects(store.resolve(plugin, owner, "A_TOKEN"), /could not be decrypted/);
  }
  const key = deriveKey(MASTER, "plugin-secrets/v1");
  assert.equal(decryptSecret(key, enc, pluginSecretAad("a", "u1", "A_TOKEN")), VAL);
  assert.throws(() => decryptSecret(key, enc, pluginSecretAad("a", "u1", "OTHER")));
});

test("a vault ciphertext does not decrypt in the plugin store (and vice versa)", async () => {
  const { store, db } = await mk();
  const vaultEnc = encryptSecret(MASTER, VAL, "u1:vault:A_TOKEN");
  await db.query("INSERT INTO plugin_secrets (plugin_id, owner_id, name, value_enc) VALUES ('a','u1','A_TOKEN',$1)", [vaultEnc]);
  await assert.rejects(store.resolve("a", "u1", "A_TOKEN"), /could not be decrypted/);
  await store.set("a", "u2", "A_TOKEN", VAL, "u2");
  const enc = (await db.query("SELECT value_enc FROM plugin_secrets WHERE owner_id='u2'")).rows[0].value_enc as string;
  assert.throws(() => decryptSecret(MASTER, enc, "u2:vault:A_TOKEN"));
});

test("audit rows hold plugin, owner, name, action, actor and never a value", async () => {
  const { store, db } = await mk();
  await store.set("a", "u1", "A_TOKEN", VAL, "u1"); await store.resolve("a", "u1", "A_TOKEN"); await store.remove("a", "u1", "A_TOKEN", "u1");
  const rows = (await db.query("SELECT plugin_id, owner_id, name, action, actor FROM plugin_secret_audit ORDER BY id")).rows;
  assert.deepEqual(rows.map((r: any) => r.action), ["set", "resolve", "remove"]);
  assert.ok(rows.every((r: any) => r.plugin_id === "a" && r.name === "A_TOKEN"));
  assert.ok(!JSON.stringify(rows).includes(VAL));
});

test("size and NUL limits; purgePlugin removes everything of that plugin only", async () => {
  const { store } = await mk();
  for (const bad of ["", "a\u0000b", "x".repeat(8193), 5 as never]) await assert.rejects(store.set("a", "u1", "A_TOKEN", bad, "u1"), (e: any) => e.code === "invalid_secret" && !String(e.message).includes("xxxx"));
  await store.set("a", "u1", "A_TOKEN", "x".repeat(8192), "u1");
  await store.set("b", "u1", "A_TOKEN", VAL, "u1");
  await store.purgePlugin("a");
  assert.equal(await store.resolve("a", "u1", "A_TOKEN"), undefined);
  assert.equal(await store.resolve("b", "u1", "A_TOKEN"), VAL);
});

test("resolve audits are sampled (one per key per interval); set and remove are always recorded", async () => {
  const f = await fakePool(); await f.addUser("u1");
  let now = 1_000_000;
  const store = new PluginSecrets(f.pool as never, MASTER, () => ["A_TOKEN"], { now: () => now, resolveAuditEveryMs: 60_000 });
  const count = async (action: string) => Number((await f.db.query("SELECT count(*)::int AS n FROM plugin_secret_audit WHERE action = $1", [action])).rows[0].n);
  await store.set("a", "u1", "A_TOKEN", VAL, "u1");
  for (let i = 0; i < 5; i++) await store.resolve("a", "u1", "A_TOKEN");
  assert.equal(await count("resolve"), 1); // five reads inside the interval: one row
  now += 61_000;
  await store.resolve("a", "u1", "A_TOKEN");
  assert.equal(await count("resolve"), 2);
  await store.set("a", "u1", "A_TOKEN", VAL + "x", "u1"); await store.set("a", "u1", "A_TOKEN", VAL + "y", "u1");
  assert.equal(await count("set"), 3);
  await store.remove("a", "u1", "A_TOKEN", "u1");
  assert.equal(await count("remove"), 1);
  assert.ok(!JSON.stringify((await f.db.query("SELECT * FROM plugin_secret_audit")).rows).includes(VAL));
});

test("pruneAudit removes rows past retention and trims a plugin above the cap, keeping the newest", async () => {
  const f = await fakePool();
  const store = new PluginSecrets(f.pool as never, MASTER, () => ["A_TOKEN"], { retentionDays: 90, capPerPlugin: 3 });
  const add = (plugin: string, name: string, days: number) => f.db.query("INSERT INTO plugin_secret_audit (plugin_id, owner_id, name, action, at) VALUES ($1,'u1',$2,'set', now() - ($3::int * interval '1 day'))", [plugin, name, days]);
  await add("a", "old1", 120); await add("a", "old2", 91); // past retention
  for (let i = 1; i <= 6; i++) await add("a", "n" + i, 0); // above the cap of 3
  await add("b", "b1", 1); await add("b", "b2", 2); // under the cap: untouched
  const removed = await store.pruneAudit();
  assert.equal(removed, 2 + 3);
  const names = async (plugin: string) => (await f.db.query("SELECT name FROM plugin_secret_audit WHERE plugin_id = $1 ORDER BY id", [plugin])).rows.map((r: any) => r.name);
  assert.deepEqual(await names("a"), ["n4", "n5", "n6"]); // oldest trimmed first
  assert.deepEqual(await names("b"), ["b1", "b2"]);
  assert.equal(await store.pruneAudit(), 0); // idempotent
});

test("host.load prunes the audit trail at boot", async () => {
  const { PluginHost } = await import("../dist/plugins/host.js");
  const { makeEcho } = await import("./fixtures/plugins/echo/index.mts");
  const f = await fakePool();
  await f.db.query("INSERT INTO plugin_secret_audit (plugin_id, owner_id, name, action, at) VALUES ('echo','u1','X','set', now() - interval '200 days')");
  await f.db.query("INSERT INTO plugin_secret_audit (plugin_id, owner_id, name, action) VALUES ('echo','u1','Y','set')");
  const host = new PluginHost(f.pool as never, { plugins: [makeEcho().plugin], encryptionKey: MASTER, sink: () => undefined, retryDelaysMs: [0, 0] });
  await host.load();
  assert.deepEqual((await f.db.query("SELECT name FROM plugin_secret_audit ORDER BY id")).rows.map((r: any) => r.name), ["Y"]);
});
