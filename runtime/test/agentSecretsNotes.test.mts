import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mergeSecretEnv, openSecret, redactSecrets, sealSecret, validateSecretName, validateSecretValue } from "../dist/secrets.js";
import { parseNoteFields } from "../dist/notes.js";
import { mergeKeychainLayers, parseKeychainFields } from "../dist/keychains.js";
import { assertCanRecruit } from "../dist/orchestrator.js";
import { HttpError } from "../dist/errors.js";
import { getAgentRole, parseRoleId } from "../dist/roles.js";

const key = { encryptionKey: randomBytes(32) };

test("secret names: format and deny list", () => {
  assert.equal(validateSecretName("MY_TOKEN"), "MY_TOKEN");
  assert.equal(validateSecretName("_X1"), "_X1");
  for (const bad of ["lower", "1ABC", "A-B", "", "A".repeat(65), 5, undefined]) assert.throws(() => validateSecretName(bad), HttpError);
  for (const reserved of ["PATH", "HOME", "LD_PRELOAD", "DYLD_X", "NODE_OPTIONS", "FLOQ_API_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_NO_FLICKER", "CODEX_HOME", "OPENAI_API_KEY", "GITHUB_TOKEN", "DISABLE_AUTOUPDATER", "TERM"]) {
    assert.throws(() => validateSecretName(reserved), /reserved/, reserved);
  }
});

test("secret values: 1..16384 bytes", () => {
  assert.equal(validateSecretValue("x"), "x");
  assert.equal(validateSecretValue("a".repeat(16384)).length, 16384);
  assert.throws(() => validateSecretValue(""));
  assert.throws(() => validateSecretValue("a".repeat(16385)));
  assert.throws(() => validateSecretValue("é".repeat(8193)));
  assert.throws(() => validateSecretValue(1));
});

test("crypto round trip, AAD tamper rejection, fail closed without key", () => {
  const sealed = sealSecret(key, "u1", "s1", "TOK", "hunter2");
  assert.ok(!sealed.toString("utf8").includes("hunter2"));
  assert.equal(openSecret(key, "u1", "s1", "TOK", sealed), "hunter2");
  assert.throws(() => openSecret(key, "u2", "s1", "TOK", sealed));
  assert.throws(() => openSecret(key, "u1", "s2", "TOK", sealed));
  assert.throws(() => openSecret(key, "u1", "s1", "OTHER", sealed));
  assert.throws(() => openSecret({ encryptionKey: randomBytes(32) }, "u1", "s1", "TOK", sealed));
  assert.throws(() => sealSecret({ encryptionKey: Buffer.alloc(0) }, "u1", "s1", "TOK", "v"), /unavailable/);
  assert.throws(() => sealSecret({ encryptionKey: undefined as unknown as Buffer }, "u1", "s1", "TOK", "v"), /unavailable/);
});

test("redactor replaces exact values, longest first, skips tiny values", () => {
  assert.equal(redactSecrets("key=abcd1234 and abcd", { A: "abcd1234", B: "abcd" }), "key=[secret:A] and [secret:B]");
  assert.equal(redactSecrets("a b c", { S: "a" }), "a b c");
  assert.equal(redactSecrets("", { S: "abcdef" }), "");
});

test("keychain fields validation and later-created-wins merge", () => {
  assert.deepEqual(parseKeychainFields({ name: "  Prod  ", x: 1, y: 2 }, true), { name: "Prod", x: 1, y: 2 });
  assert.deepEqual(parseKeychainFields({ color: "blue" }, false), { color: "blue" });
  for (const bad of [{ x: 1, y: 2 }, { name: "", x: 1, y: 2 }, { name: "a".repeat(61), x: 1, y: 2 }, { name: "ok", x: 1 }, { name: "ok", x: 1, y: 2, color: "red" }, { name: "ok", x: 1, y: 2, w: 5 }]) {
    assert.throws(() => parseKeychainFields(bad, true), HttpError, JSON.stringify(bad));
  }
  assert.throws(() => parseKeychainFields({ name: "" }, false));
  assert.deepEqual(mergeKeychainLayers([{ A: "old", B: "b" }, { A: "new" }]), { A: "new", B: "b" });
});

test("env merge never overrides reserved names", () => {
  const env = { PATH: "/bin", FLOQ_SESSION_ID: "x", FOO: "old" };
  mergeSecretEnv(env, { PATH: "evil", FLOQ_SESSION_ID: "evil", LD_PRELOAD: "evil", FOO: "new", API_KEY: "k", "bad name": "z" });
  assert.deepEqual(env, { PATH: "/bin", FLOQ_SESSION_ID: "x", FOO: "new", API_KEY: "k" });
});

test("note validation", () => {
  assert.deepEqual(parseNoteFields({ x: 1, y: 2 }, true), { x: 1, y: 2 });
  assert.deepEqual(parseNoteFields({ text: "hi", color: "pink", w: 120, h: 2000 }, false), { text: "hi", color: "pink", w: 120, h: 2000 });
  assert.throws(() => parseNoteFields({ x: 1 }, true));
  for (const bad of [{ text: "x".repeat(20001) }, { color: "red" }, { w: 119 }, { h: 2001 }, { x: Infinity }, { x: NaN }, { y: "1" }, { text: 5 }]) {
    assert.throws(() => parseNoteFields(bad, false), HttpError, JSON.stringify(bad).slice(0, 40));
  }
  assert.throws(() => parseNoteFields(null, false));
  assert.deepEqual(parseNoteFields({ text: "x".repeat(20000) }, false).text?.length, 20000);
});

const row = (id: string, title: string, role: string | null, project = "p") => ({ id, title, role, cwd: project });
const same = (a: { cwd: string | null }, b: { cwd: string | null }) => a.cwd === b.cwd;

test("recruit: orchestrator allowed, others get 403 naming the project's orchestrators", () => {
  const all = [row("o1", "Boss", "orchestrator"), row("w1", "Worker", null), row("o2", "Other", "orchestrator", "q")];
  assert.doesNotThrow(() => assertCanRecruit(all[0], all, same));
  assert.throws(() => assertCanRecruit(all[1], all, same), (e: unknown) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.status, 403);
    assert.equal(e.message, 'Only the orchestrator can recruit agents. Ask Boss (o1) to recruit for you: floq ask o1 "Please recruit a <role> agent to <task>".');
    return true;
  });
  assert.throws(() => assertCanRecruit(row("w2", "W2", null, "z"), all, same), /no orchestrator yet.*Set as orchestrator/);
});

test("role presets: orchestrator is a valid preset; unknown role rejected (PATCH validation)", () => {
  assert.equal(parseRoleId("orchestrator")?.id, "orchestrator");
  assert.equal(parseRoleId(null), null);
  assert.equal(parseRoleId("generalist"), null);
  assert.throws(() => parseRoleId("god"), HttpError);
  assert.throws(() => parseRoleId(5), HttpError);
  assert.match(getAgentRole("orchestrator")!.prompt, /only the orchestrator can recruit/i);
});
