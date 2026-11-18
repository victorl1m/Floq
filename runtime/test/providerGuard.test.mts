import assert from "node:assert/strict";
import test from "node:test";
import { assertProviderConnected, providerConnected, PROVIDER_NOT_CONNECTED, type ProviderGuardDeps } from "../src/providerGuard.js";

const goodClaude = { accessToken: "a", refreshToken: "r" };
const goodCodex = { tokens: { access_token: "a", refresh_token: "r" } };

function deps(over: Partial<ProviderGuardDeps> = {}): ProviderGuardDeps {
  return {
    config: { passHostEnv: false, sessionEnvAllow: [] },
    credential: async () => null,
    antigravityLogin: async () => false,
    vaultEnvNames: async () => new Set(),
    env: {},
    ...over,
  };
}

test("claude and codex need a valid stored login", async () => {
  assert.equal(await providerConnected(deps(), "u", "codex"), false);
  assert.equal(await providerConnected(deps(), "u", "claude"), false);
  assert.equal(await providerConnected(deps({ credential: async () => ({ accessToken: "a" }) }), "u", "claude"), false, "no refresh token = not valid");
  assert.equal(await providerConnected(deps({ credential: async (_u, p) => (p === "codex" ? goodCodex : goodClaude) }), "u", "codex"), true);
  assert.equal(await providerConnected(deps({ credential: async () => goodClaude }), "u", "codex"), false, "a Claude credential never counts for Codex");
  assert.equal(await providerConnected(deps({ credential: async () => { throw new Error("db down"); } }), "u", "codex"), false, "errors fail closed");
});

test("an operator API key counts only when it reaches sessions", async () => {
  const env = { OPENAI_API_KEY: "k" };
  assert.equal(await providerConnected(deps({ env }), "u", "codex"), false);
  assert.equal(await providerConnected(deps({ env, config: { passHostEnv: true, sessionEnvAllow: [] } }), "u", "codex"), true);
  assert.equal(await providerConnected(deps({ env, config: { passHostEnv: false, sessionEnvAllow: ["OPENAI_API_KEY"] } }), "u", "codex"), true);
});

test("antigravity needs a Google login or GEMINI_API_KEY in the vault", async () => {
  assert.equal(await providerConnected(deps(), "u", "antigravity"), false);
  assert.equal(await providerConnected(deps({ antigravityLogin: async () => true }), "u", "antigravity"), true);
  assert.equal(await providerConnected(deps({ vaultEnvNames: async () => new Set(["GEMINI_API_KEY"]) }), "u", "antigravity"), true);
});

test("shell and opencode are not gated", async () => {
  assert.equal(await providerConnected(deps(), "u", "shell"), true);
  assert.equal(await providerConnected(deps(), "u", "opencode"), true);
});

test("assertProviderConnected throws provider_not_connected with a clear message", async () => {
  await assert.rejects(assertProviderConnected(deps(), "u", "codex"), (error: { code?: string; status?: number; message: string }) => {
    assert.equal(error.code, PROVIDER_NOT_CONNECTED);
    assert.equal(error.status, 409);
    assert.match(error.message, /Codex is not connected/);
    return true;
  });
  await assertProviderConnected(deps({ credential: async () => goodCodex }), "u", "codex");
});
