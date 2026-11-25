import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrateApp } from "../src/db.ts";
import { ClaudeAccounts } from "../src/claudeAccounts.ts";
import { CredentialBroker, RefreshFailure } from "../src/credentials.ts";
import { decryptSecret } from "../src/crypto.ts";

const U = "user-1";
const KEY = Buffer.alloc(32, 7);
const cred = (token: string, extra: Record<string, unknown> = {}) => ({ accessToken: token, refreshToken: "r-" + token, expiresAt: Date.now() + 3 * 3600_000, scopes: ["user:inference"], subscriptionType: "max", ...extra });
/** access token -> account uuid, like /api/oauth/profile */
const uuids: Record<string, string> = {};

// One PGlite for the whole file (migrating takes seconds); every test starts from empty tables.
let shared: Promise<{ db: PGlite; query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }> }> | null = null;
test.after(async () => { if (shared) await (await shared).db.close().catch(() => undefined); });

async function database() {
  shared ??= (async () => {
    const db = new PGlite();
    const query = async (sql: string, params?: unknown[]) => {
      if (!params?.length) { const r = await db.exec(sql); const last = r[r.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await db.query(sql, params);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    };
    await db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
    await migrateApp({ query, async connect() { return { query, release() {} }; } } as never);
    return { db, query };
  })();
  return shared;
}

async function setup() {
  const { db, query } = await database();
  await db.exec(`DELETE FROM claude_accounts; DELETE FROM provider_credentials; DELETE FROM user_settings; DELETE FROM "user";`);
  const pool = { query, async connect() { return { query, release() {} }; } };
  await db.exec(`INSERT INTO "user" (id) VALUES ('${U}')`);
  const config = { encryptionKey: KEY } as never;
  const broker = new CredentialBroker(pool as never, config);
  const refreshed: string[] = [];
  broker.refreshData = async (_p, data) => { refreshed.push(String(data.accessToken)); if (data.accessToken === "dead") throw new RefreshFailure(true, "invalid_grant"); return { ...data, accessToken: data.accessToken + "-fresh", expiresAt: Date.now() + 3600_000 }; };
  const accounts = new ClaudeAccounts(pool as never, config, broker, { fetchProfile: async (token) => { const base = token.replace(/-fresh$/, ""); return uuids[base] ? { accountUuid: uuids[base]! } : null; } });
  const changed: Array<{ slot: string; token: unknown }> = [];
  accounts.onActiveChanged = (_u, data, slot) => changed.push({ slot, token: data.accessToken });
  return { db, pool, broker, accounts, changed, refreshed };
}

test("T-7 add: a second login becomes a reserve slot; the active credential is untouched; the same login again renews it", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, db } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const added = await accounts.add(U, cred("tokB"), "Work");
  assert.match(added.slot, /^acct_[0-9a-f]{8}$/);
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokA");
  const list = await accounts.list(U);
  assert.deepEqual(list.map((a) => [a.label, a.active]), [["Primary", true], ["Work", false]]);
  const again = await accounts.add(U, cred("tokB", { refreshToken: "r-tokB-new" }), "Again");
  assert.equal(again.slot, added.slot, "the same login renews its slot instead of failing with 'already connected'");
  const renewedActive = await accounts.add(U, cred("tokA", { refreshToken: "r-tokA-new" }), "Same as active");
  assert.equal(renewedActive.slot, "primary");
  assert.equal((await broker.get(U, "claude"))?.refreshToken, "r-tokA-new", "renewing the login in use replaces the stored active credential");
  assert.equal((await accounts.list(U)).length, 2, "no duplicate rows");
  const raw = (await db.query<{ data_enc: string; slot: string }>("SELECT slot, data_enc FROM claude_accounts WHERE slot = $1", [added.slot])).rows[0]!;
  assert.ok(!raw.data_enc.includes("tokB"), "encrypted at rest");
  assert.equal(JSON.parse(decryptSecret(KEY, raw.data_enc, `${U}:claude_oauth:${added.slot}`)).accessToken, "tokB");
  assert.throws(() => decryptSecret(KEY, raw.data_enc, `${U}:claude_oauth:primary`), undefined, "AAD binds the row to its slot");
});

test("T-7 switchTo: reserve becomes the stored active credential, the old one moves to its slot, idempotent, callback gets the new credential", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, changed, db } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "Work");
  const first = await accounts.switchTo(U, b.slot);
  assert.deepEqual([first.from, first.to, first.changed], ["primary", b.slot, true]);
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokB");
  assert.equal(await accounts.activeSlot(U), b.slot);
  assert.ok(await accounts.activeSince(U));
  const rows = (await db.query<{ slot: string; data_enc: string | null }>("SELECT slot, data_enc FROM claude_accounts ORDER BY slot")).rows;
  assert.equal(rows.find((r) => r.slot === b.slot)!.data_enc, null, "the active slot's credential lives only in provider_credentials");
  assert.equal(JSON.parse(decryptSecret(KEY, rows.find((r) => r.slot === "primary")!.data_enc!, `${U}:claude_oauth:primary`)).accessToken, "tokA");
  assert.deepEqual(changed, [{ slot: b.slot, token: "tokB" }]);
  const again = await accounts.switchTo(U, b.slot);
  assert.equal(again.changed, false);
  assert.equal(changed.length, 1, "no second callback");
  const back = await accounts.switchTo(U, "primary");
  assert.equal(back.changed, true);
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokA");
});

test("T-7 concurrent switches to the same slot are one switch", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, changed } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "Work");
  const results = await Promise.all([accounts.switchTo(U, b.slot), accounts.switchTo(U, b.slot), accounts.switchTo(U, b.slot)]);
  assert.equal(results.filter((r) => r.changed).length, 1);
  assert.equal(changed.length, 1);
});

test("T-7 switching to an expiring reserve renews it first; a dead login is marked disconnected and never replaces the working one", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b"; uuids.dead = "uuid-dead";
  const { broker, accounts, refreshed } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const old = await accounts.add(U, cred("tokB", { expiresAt: Date.now() + 60_000 }), "Work");
  await accounts.switchTo(U, old.slot);
  assert.deepEqual(refreshed, ["tokB"]);
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokB-fresh");
  await accounts.switchTo(U, "primary");
  const dead = await accounts.add(U, cred("dead", { expiresAt: Date.now() + 1000 }), "Dead");
  await assert.rejects(accounts.switchTo(U, dead.slot), { code: "account_signin_required" });
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokA", "the working login stays active");
  assert.equal((await accounts.list(U)).find((a) => a.slot === dead.slot)?.status, "disconnected");
});

test("T-8 syncBack attribution: a late CLI refresh of account A is not adopted into B; unknown accounts are not adopted", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b"; uuids.tokX = "uuid-x";
  const { broker, accounts, db } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  assert.equal(await accounts.adoptAttributed(U, cred("anything")), "single", "one account: old behaviour");
  const b = await accounts.add(U, cred("tokB"), "Work");
  assert.equal(await accounts.adoptAttributed(U, cred("tokA")), "active");
  await accounts.switchTo(U, b.slot); // the file now holds B; a CLI that still had A rewrites it
  const lateA = cred("tokA", { accessToken: "tokA", refreshToken: "r-tokA-rotated", expiresAt: Date.now() + 9 * 3600_000 });
  assert.equal(await accounts.adoptAttributed(U, lateA), "reserve");
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokB", "B's credential was not overwritten");
  const stored = (await db.query<{ data_enc: string }>("SELECT data_enc FROM claude_accounts WHERE slot = 'primary'")).rows[0]!;
  assert.equal(JSON.parse(decryptSecret(KEY, stored.data_enc, `${U}:claude_oauth:primary`)).refreshToken, "r-tokA-rotated", "A's rotated refresh token reached A's own slot");
  assert.equal(await accounts.adoptAttributed(U, cred("tokX")), "unmatched");
  assert.equal(await accounts.adoptAttributed(U, cred("nouuid")), "retry", "profile unavailable: not adopted now, not dropped either");
});

test("T-7 remove: any account can be removed; the one in use hands over to the next; the last one is reported, not removed", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "Work");
  await accounts.switchTo(U, b.slot);
  assert.equal(await accounts.remove(U, b.slot), "removed");
  assert.equal(await accounts.activeSlot(U), "primary");
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokA");
  assert.deepEqual((await accounts.list(U)).map((a) => a.slot), ["primary"]);
  assert.equal(await accounts.remove(U, "primary"), "last", "the only account: the caller signs Claude out");
  const b2 = await accounts.add(U, cred("tokB"), "Work");
  assert.equal(await accounts.remove(U, "primary"), "removed", "the primary login in use is removable too");
  assert.equal(await accounts.activeSlot(U), b2.slot);
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokB");
  assert.deepEqual((await accounts.list(U)).map((a) => [a.slot, a.active]), [[b2.slot, true]]);
  await accounts.add(U, cred("tokA"), "Personal");
  await accounts.remove(U, (await accounts.list(U)).find((a) => a.label === "Personal")!.slot);
  await accounts.switchTo(U, b2.slot);
  const c = await accounts.add(U, cred("tokB"), "Work");
  await accounts.reset(U);
  assert.equal(await accounts.activeSlot(U), "primary");
  assert.deepEqual((await accounts.list(U)).map((a) => a.slot), ["primary"], c.slot + " forgotten");
});

test("T-7 labels are validated and per user data never leaks across users", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, db } = await setup();
  await db.exec(`INSERT INTO "user" (id) VALUES ('user-2')`);
  await broker.save(U, "claude", cred("tokA"));
  await assert.rejects(accounts.add(U, cred("tokB"), "x".repeat(50)), /40 characters/);
  const b = await accounts.add(U, cred("tokB"), "  Work   2 ");
  assert.equal(b.label, "Work 2");
  assert.deepEqual(await accounts.list("user-2"), []);
  await assert.rejects(accounts.switchTo("user-2", b.slot), { status: 404 });
  await assert.rejects(accounts.rename("user-2", b.slot, "mine"), { status: 404 });
});

// ---- reviewer 2: credential-loss risks ----

test("review2-6 adopt: a failing profile call never drops a rotated token (retry); an unchanged refresh token needs no profile call; a slot that became active meanwhile is adopted as active", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "Work");
  let profileCalls = 0;
  const realProfile = accounts.fetchProfile;
  accounts.fetchProfile = async (t) => { profileCalls++; return realProfile(t); };
  // same refresh token as the stored active login: no profile call at all
  assert.equal(await accounts.adoptAttributed(U, cred("tokA", { accessToken: "tokA-newer", refreshToken: "r-tokA" })), "active");
  assert.equal(profileCalls, 0);
  // profile endpoint down: the rotated credential is NOT dropped, the caller is told to look again
  accounts.fetchProfile = async () => null;
  assert.equal(await accounts.adoptAttributed(U, cred("tokA", { refreshToken: "r-tokA-rotated" })), "retry");
  // the account behind the file is the one that became active while adopting
  accounts.fetchProfile = realProfile;
  await accounts.switchTo(U, b.slot);
  assert.equal(await accounts.adoptAttributed(U, cred("tokB", { refreshToken: "r-tokB-rotated" })), "active");
});

test("review2-7 switch: the outgoing account's CLI-rotated token is synced first and lands in its reserve slot", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, db } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "Work");
  const order: string[] = [];
  accounts.beforeSwitch = async () => { order.push("sync"); await broker.save(U, "claude", cred("tokA", { refreshToken: "r-tokA-ROTATED-BY-CLI" })); };
  accounts.onActiveChanged = () => order.push("distribute");
  await accounts.switchTo(U, b.slot);
  assert.deepEqual(order, ["sync", "distribute"]);
  const stored = (await db.query<{ data_enc: string }>("SELECT data_enc FROM claude_accounts WHERE slot = 'primary'")).rows[0]!;
  assert.equal(JSON.parse(decryptSecret(KEY, stored.data_enc, `${U}:claude_oauth:primary`)).refreshToken, "r-tokA-ROTATED-BY-CLI", "no rotated token lost");
});

test("review2-7 switch: the target's renewed refresh token is persisted before the transaction, so a failed switch keeps it", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, db } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB", { expiresAt: Date.now() + 60_000 }), "Work");
  const realSave = broker.save.bind(broker);
  broker.save = (async (u: string, p: "claude" | "codex", d: never, dbArg?: never) => { if (dbArg) throw new Error("db down mid-switch"); return realSave(u, p, d); }) as never;
  await assert.rejects(accounts.switchTo(U, b.slot), /db down/);
  assert.equal(await accounts.activeSlot(U), "primary", "nothing half-switched");
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokA");
  const stored = (await db.query<{ data_enc: string }>("SELECT data_enc FROM claude_accounts WHERE slot = $1", [b.slot])).rows[0]!;
  assert.equal(JSON.parse(decryptSecret(KEY, stored.data_enc, `${U}:claude_oauth:${b.slot}`)).accessToken, "tokB-fresh", "the renewed (rotated) credential is what is stored");
});

test("review2-11 a corrupt stored credential is 'sign in again', not a 500; usageOf and tick survive it", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, db } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "Work");
  accounts.fetchUsage = async () => [];
  await db.query("UPDATE claude_accounts SET data_enc = 'not-a-valid-ciphertext', expires_at = now() WHERE slot = $1", [b.slot]);
  assert.equal(await accounts.usageOf(U, b.slot), null);
  await accounts.tick();
  await assert.rejects(accounts.switchTo(U, b.slot), { code: "account_signin_required" });
  assert.equal((await accounts.list(U)).find((a) => a.slot === b.slot)?.status, "disconnected");
});

test("review2-9 reset forgets the extras in one transaction and tells the fallback service", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, db } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  await accounts.add(U, cred("tokB"), "Work");
  await db.exec(`INSERT INTO user_settings (user_id, claude_account_return) VALUES ('${U}', '{"slot":"primary","window":"five_hour","resetsAt":null}') ON CONFLICT (user_id) DO UPDATE SET claude_account_return = '{"slot":"primary","window":"five_hour","resetsAt":null}'`);
  const told: string[] = [];
  accounts.onReset = (u) => told.push(u);
  await accounts.reset(U);
  assert.deepEqual(told, [U]);
  assert.equal((await db.query<{ claude_account_return: unknown }>("SELECT claude_account_return FROM user_settings WHERE user_id = $1", [U])).rows[0]!.claude_account_return, null);
  assert.deepEqual((await accounts.list(U)).map((a) => a.slot), ["primary"]);
});

test("review2-10 tick does not refresh a reserve whose expiry is unknown, every time", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts, db, refreshed } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB", { expiresAt: undefined }), "Work");
  await db.query("UPDATE claude_accounts SET expires_at = NULL WHERE slot = $1", [b.slot]);
  await accounts.tick();
  assert.deepEqual(refreshed, []);
});

test("order: added accounts go last; moving one to the top switches to it; the order survives and drives reserveSlots", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b"; uuids.tokC = "uuid-c";
  const { broker, accounts } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "B");
  const c = await accounts.add(U, cred("tokC"), "C");
  assert.deepEqual((await accounts.list(U)).map((a) => a.slot), ["primary", b.slot, c.slot]);
  assert.deepEqual(await accounts.reorder(U, [c.slot, "primary", b.slot]), { switched: true });
  assert.equal(await accounts.activeSlot(U), c.slot);
  assert.equal((await broker.get(U, "claude"))?.accessToken, "tokC");
  assert.deepEqual((await accounts.list(U)).map((a) => a.slot), [c.slot, "primary", b.slot]);
  assert.deepEqual((await accounts.reserveSlots(U)).map((a) => a.slot), ["primary", b.slot], "fallback walks the list order");
  assert.deepEqual(await accounts.reorder(U, [c.slot, b.slot, "primary"]), { switched: false });
  await assert.rejects(accounts.reorder(U, [c.slot, b.slot]), { code: "invalid_order" });
  await assert.rejects(accounts.reorder(U, [c.slot, c.slot, b.slot]), { code: "invalid_order" });
});

test("usageOf: a failed read (429) serves the last value and is not retried during the backoff", async () => {
  uuids.tokA = "uuid-a"; uuids.tokB = "uuid-b";
  const { broker, accounts } = await setup();
  await broker.save(U, "claude", cred("tokA"));
  const b = await accounts.add(U, cred("tokB"), "B");
  let calls = 0; let fail = false;
  accounts.fetchUsage = async () => { calls++; if (fail) throw new Error("rate_limited"); return [{ id: "five_hour", label: "5h", usedPercent: 20, resetsAt: null }]; };
  assert.equal((await accounts.usageOf(U, b.slot))?.[0]?.usedPercent, 20);
  (accounts as any).usageCache.get(U + ":" + b.slot).at = 0; // the minute cache expired
  fail = true;
  assert.equal((await accounts.usageOf(U, b.slot))?.[0]?.usedPercent, 20, "last known value instead of null");
  assert.equal((await accounts.usageOf(U, b.slot))?.[0]?.usedPercent, 20);
  assert.equal(calls, 2, "no new request while backing off");
});
