import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Vault, scrubSecrets } from "../dist/vault.js";
import { GithubLinker } from "../dist/github.js";
import { encryptSecret } from "../dist/crypto.js";

const key = Buffer.alloc(32, 7);

function vaultWith(secrets) {
  const rows = Object.entries(secrets).map(([name, value]) => ({ name, value_enc: encryptSecret(key, value, "u1:vault:" + name) }));
  const pool = { async query(sql, params) { if (/SELECT name, value_enc/.test(sql)) return { rows: rows.filter((r) => !params[1] || (params[1].includes?.(r.name) ?? true)) }; return { rows: [], rowCount: 0 }; } };
  return new Vault(pool, { encryptionKey: key });
}

test("vault.run injects secrets into the launched child and returns only redacted output", async () => {
  const vault = vaultWith({ MY_TOKEN: "super-secret-value-123" });
  let seenEnv;
  const result = await vault.run("u1", "s1", ["MY_TOKEN"], (secrets) => {
    seenEnv = secrets;
    return spawn("sh", ["-c", 'echo "tok=$MY_TOKEN"; echo "err=$MY_TOKEN" >&2; exit 3'], { env: { ...process.env, ...secrets } });
  });
  assert.equal(seenEnv.MY_TOKEN, "super-secret-value-123");
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "tok=[REDACTED]\n");
  assert.equal(result.stderr, "err=[REDACTED]\n");
  assert.ok(!JSON.stringify(result).includes("super-secret-value-123"));
});

test("vault.run reports a missing named secret and caps output", async () => {
  const vault = vaultWith({ A_KEY: "aaaa-secret" });
  await assert.rejects(() => vault.run("u1", "s1", ["A_KEY", "NOPE"], () => spawn("true")), /NOPE/);
  const big = await vault.run("u1", "s1", ["A_KEY"], () => spawn("sh", ["-c", "head -c 5000 /dev/zero | tr '\\0' x"]), { maxBytes: 1000 });
  assert.equal(big.truncated, true);
  assert.equal(big.stdout.length, 1000);
});

test("scrubSecrets replaces longest values first and ignores very short ones", () => {
  assert.equal(scrubSecrets("abcd abcdef xy", { A: "abcd", B: "abcdef", C: "xy" }), "[REDACTED] [REDACTED] xy");
});

test("github device-flow start is rate limited per user (L1)", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ device_code: "d", user_code: "U", interval: 5, expires_in: 900 }), { status: 200 }); };
  try {
    const linker = new GithubLinker({ githubClientId: "cid" }, {});
    for (let i = 0; i < 5; i++) await linker.start("alice");
    await assert.rejects(() => linker.start("alice"), (error) => error.status === 429);
    assert.equal(calls, 5, "the 6th attempt never reached GitHub");
    await linker.start("bob"); // another user is unaffected
    assert.equal(calls, 6);
  } finally { globalThis.fetch = original; }
});
