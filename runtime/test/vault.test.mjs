import test from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret } from "../dist/crypto.js";
import { Vault } from "../dist/vault.js";

const key = Buffer.alloc(32, 7);

function fixture() {
  const secrets = new Map();
  secrets.set("API_OLD", {
    user_id: "user-1", name: "API_OLD", description: "Old label", expose: "tool",
    value_enc: encryptSecret(key, "private-token-value", "user-1:vault:API_OLD"),
    created_at: new Date("2026-01-02T03:04:05.000Z"), updated_at: new Date("2026-02-03T04:05:06.000Z"),
    last_used_at: new Date("2026-03-04T05:06:07.000Z"),
  });
  const audits = [];
  const statements = [];
  let duplicateName = null;
  let failUpdate = false;
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql, values });
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
          if (sql.includes("SELECT name,description,expose,value_enc")) {
            const [userId, name] = values;
            const row = secrets.get(name);
            return { rows: row && row.user_id === userId ? [{ ...row }] : [] };
          }
          if (sql.startsWith("UPDATE vault_secrets SET name=")) {
            const [userId, oldName, name, description, expose, value_enc] = values;
            if (failUpdate) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
            if (duplicateName === name) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
            const row = secrets.get(oldName);
            if (!row || row.user_id !== userId) return { rowCount: 0, rows: [] };
            secrets.delete(oldName);
            secrets.set(name, { ...row, name, description, expose, value_enc, updated_at: new Date("2026-04-05T06:07:08.000Z") });
            return { rowCount: 1, rows: [] };
          }
          throw new Error("Unexpected transaction query: " + sql);
        },
        release() {},
      };
    },
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT name, description, expose")) {
        return { rows: [...secrets.values()].filter((row) => row.user_id === values[0]).map((row) => ({
          name: row.name, description: row.description, expose: row.expose,
          created_at: row.created_at, updated_at: row.updated_at, last_used_at: row.last_used_at,
        })) };
      }
      if (sql.startsWith("INSERT INTO vault_audit")) { audits.push(values); return { rows: [] }; }
      throw new Error("Unexpected pool query: " + sql);
    },
  };
  const vault = new Vault(pool, { encryptionKey: key });
  return { vault, secrets, audits, statements, setDuplicateName: (name) => { duplicateName = name; }, setFailUpdate: (value) => { failUpdate = value; } };
}

test("renaming a secret atomically re-encrypts it under the new AAD and returns metadata only", async () => {
  const f = fixture();
  const before = f.secrets.get("API_OLD");
  const result = await f.vault.patch("user-1", "API_OLD", { name: "API_NEW", description: "  New description  ", expose: "env" });
  const stored = f.secrets.get("API_NEW");
  assert.equal(f.secrets.has("API_OLD"), false);
  assert.equal(decryptSecret(key, stored.value_enc, "user-1:vault:API_NEW"), "private-token-value");
  assert.throws(() => decryptSecret(key, stored.value_enc, "user-1:vault:API_OLD"));
  assert.equal(stored.description, "New description");
  assert.equal(stored.expose, "env");
  assert.equal(stored.created_at, before.created_at);
  assert.equal(stored.last_used_at, before.last_used_at);
  assert.notEqual(stored.updated_at, before.updated_at);
  assert.deepEqual(result, [{
    name: "API_NEW", description: "New description", expose: "env",
    createdAt: before.created_at.toISOString(), updatedAt: stored.updated_at.toISOString(), lastUsedAt: before.last_used_at.toISOString(),
  }]);
  assert.equal(JSON.stringify(result).includes("private-token-value"), false);
  assert.deepEqual(f.audits.map((values) => [values[2], values[3]]), [["API_OLD", "rename"], ["API_NEW", "rename"]]);
  assert.ok(f.statements.some(({ sql }) => sql === "BEGIN"));
  assert.ok(f.statements.some(({ sql }) => sql === "COMMIT"));
});

test("value edits use the current key AAD and explicit empty values are rejected", async () => {
  const f = fixture();
  await f.vault.patch("user-1", "API_OLD", { value: "replacement", description: "Rotated" });
  const row = f.secrets.get("API_OLD");
  assert.equal(decryptSecret(key, row.value_enc, "user-1:vault:API_OLD"), "replacement");
  await assert.rejects(f.vault.patch("user-1", "API_OLD", { value: "" }), { code: "bad_request" });
  await assert.rejects(f.vault.patch("user-1", "API_OLD", { value: "x".repeat(16 * 1024 + 1) }), { code: "bad_request" });
});

test("duplicate names roll back without changing the old secret and foreign owners get 404", async () => {
  const f = fixture();
  const before = { ...f.secrets.get("API_OLD") };
  f.setDuplicateName("API_TAKEN");
  await assert.rejects(f.vault.patch("user-1", "API_OLD", { name: "API_TAKEN" }), { code: "secret_exists", status: 409 });
  assert.deepEqual(f.secrets.get("API_OLD"), before);
  assert.ok(f.statements.some(({ sql }) => sql === "ROLLBACK"));
  await assert.rejects(f.vault.patch("user-other", "API_OLD", { name: "API_NEW" }), { status: 404 });
  assert.deepEqual(f.secrets.get("API_OLD"), before);
});

test("name validation rejects reserved keys before opening a transaction", async () => {
  const f = fixture();
  await assert.rejects(f.vault.patch("user-1", "API_OLD", { name: "PATH" }), { code: "reserved_name" });
  await assert.rejects(f.vault.patch("user-1", "API_OLD", { name: "bad-name" }), { code: "invalid_name" });
  assert.equal(f.statements.length, 0);
});
