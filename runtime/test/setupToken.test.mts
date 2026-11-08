import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { createBootstrapAdmin, setupLookupStep } from "../dist/auth.js";
import { SetupToken } from "../dist/setupToken.js";

const EMAIL = "owner@example.test";
const config = { bootstrapAdminEmail: EMAIL } as never;

/** Minimal in-memory stand-in for the three tables the setup flow touches. */
function fakeDb() {
  const state = { users: [] as string[], tokenHash: null as string | null, usedAt: null as Date | null };
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO setup_token")) { state.tokenHash = String(values[0]); state.usedAt = null; return { rowCount: 1, rows: [] }; }
    if (sql.startsWith("SELECT token_hash")) return state.tokenHash && !state.usedAt ? { rowCount: 1, rows: [{ token_hash: state.tokenHash }] } : { rowCount: 0, rows: [] };
    if (sql.startsWith("UPDATE setup_token")) { if (state.usedAt || !state.tokenHash) return { rowCount: 0, rows: [] }; state.usedAt = new Date(); return { rowCount: 1, rows: [] }; }
    if (sql.startsWith("SELECT pg_advisory_xact_lock") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 1, rows: [] };
    if (sql.startsWith("SELECT") && sql.includes('"user"')) return { rowCount: state.users.includes(String(values[0])) ? 1 : 0, rows: [] };
    if (sql.startsWith('INSERT INTO public."user"')) { state.users.push(String(values[2])); return { rowCount: 1, rows: [] }; }
    return { rowCount: 1, rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as never as pg.Pool;
  const auth = { $context: Promise.resolve({ password: { hash: async (v: string) => `hash:${v}` } }) } as never;
  return { state, pool, auth };
}

async function claim(db: ReturnType<typeof fakeDb>, tokens: SetupToken, token: unknown) {
  return createBootstrapAdmin(db.auth, db.pool, config, EMAIL, "correct horse battery", "Owner", undefined, tokens, token);
}

test("issueIfNeeded stores only a hash and issues nothing once the account exists", async () => {
  const db = fakeDb();
  const tokens = new SetupToken(db.pool);
  const token = await tokens.issueIfNeeded(EMAIL);
  assert.ok(token && token.length >= 32);
  assert.notEqual(db.state.tokenHash, token);
  assert.match(db.state.tokenHash!, /^[0-9a-f]{64}$/);
  assert.equal(await new SetupToken(fakeDb().pool).issueIfNeeded(null), null);
  db.state.users.push(EMAIL);
  assert.equal(await tokens.issueIfNeeded(EMAIL), null);
});

test("missing, wrong and non-string tokens are rejected and nothing is created", async () => {
  const db = fakeDb();
  const tokens = new SetupToken(db.pool);
  await tokens.issueIfNeeded(EMAIL);
  for (const bad of [undefined, "", "   ", "wrong-token", 12345, null, "x".repeat(300)]) {
    assert.equal(await claim(db, tokens, bad), false);
  }
  assert.equal(db.state.users.length, 0);
});

test("the correct token works once, then is invalidated", async () => {
  const db = fakeDb();
  const tokens = new SetupToken(db.pool);
  const token = await tokens.issueIfNeeded(EMAIL);
  assert.equal(await claim(db, tokens, token), true);
  assert.deepEqual(db.state.users, [EMAIL]);
  assert.ok(db.state.usedAt);
  assert.equal(await tokens.verify(token), false);
  assert.equal(await claim(db, tokens, token), false);
});

test("a token left over from before a restart stops working once a new one is issued", async () => {
  const db = fakeDb();
  const tokens = new SetupToken(db.pool);
  const first = await tokens.issueIfNeeded(EMAIL);
  const second = await tokens.issueIfNeeded(EMAIL);
  assert.notEqual(first, second);
  assert.equal(await claim(db, tokens, first), false);
  assert.equal(await claim(db, tokens, second), true);
});

test("lookup reveals setup only to a holder of the token", async () => {
  const db = fakeDb();
  const tokens = new SetupToken(db.pool);
  const token = await tokens.issueIfNeeded(EMAIL);
  assert.equal(await setupLookupStep(db.pool, config, tokens, EMAIL, undefined), "password");
  assert.equal(await setupLookupStep(db.pool, config, tokens, EMAIL, "wrong"), "password");
  assert.equal(await setupLookupStep(db.pool, config, tokens, "other@example.test", token), "password");
  assert.equal(await setupLookupStep(db.pool, config, tokens, EMAIL, token), "setup");
  await claim(db, tokens, token);
  assert.equal(await setupLookupStep(db.pool, config, tokens, EMAIL, token), "password");
});
