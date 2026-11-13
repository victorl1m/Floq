import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeConnectors, apiKeyReachesSessions, parseConnectors } from "../src/claudeConnectors.ts";

const TOKEN = "sk-ant-oat01-SECRET-TOKEN";
const cred = (extra: Record<string, unknown> = {}) => ({ accessToken: TOKEN, refreshToken: "r", scopes: ["user:inference", "user:mcp_servers"], ...extra });

function setup(opts: { data?: Record<string, unknown> | null; status?: number; body?: unknown; apiKey?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let clock = 1_000;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    if (opts.throws) throw new Error(`boom ${TOKEN} https://x`);
    const status = opts.status ?? 200;
    return { ok: status < 400, status, json: async () => opts.body ?? { data: [] } } as Response;
  }) as unknown as typeof fetch;
  const service = new ClaudeConnectors({
    credentials: { refresh: async () => undefined, get: async () => (opts.data === undefined ? cred() : opts.data) },
    apiKeyInEnv: () => opts.apiKey ?? false,
    fetch: fetchFn,
    now: () => clock,
  });
  return { service, calls, tick: (ms: number) => { clock += ms; } };
}

test("sends the bearer token and the connectors beta to /v1/mcp_servers", async () => {
  const { service, calls } = setup();
  await service.get("u");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/mcp_servers?limit=1000&include_additional_installs=true");
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(calls[0]!.headers["anthropic-beta"]!, /mcp-servers-2025-12-04/);
});

test("returns only allowlisted fields, with the host and no path or secrets", async () => {
  const body = { data: [{ id: "srv_1", name: "Gmail", display_name: "Gmail", url: "https://user:pw@mcp.example.com/v1/secret?token=abc", connected: true, oauth_token: "LEAK", extra: { a: 1 } }, { name: "Drive", status: "disconnected" }, 7, null] };
  const { service } = setup({ body });
  const result = await service.get("u");
  assert.deepEqual(result.connectors, [
    { name: "Gmail", displayName: "Gmail", host: "mcp.example.com", connected: true },
    { name: "Drive", displayName: "Drive", host: "", connected: false },
  ]);
  assert.ok(!JSON.stringify(result).includes("LEAK") && !JSON.stringify(result).includes("secret") && !JSON.stringify(result).includes(TOKEN));
});

test("parseConnectors accepts arrays and unknown shapes", () => {
  assert.equal(parseConnectors([{ name: "A" }]).length, 1);
  assert.deepEqual(parseConnectors("nope"), []);
  assert.deepEqual(parseConnectors({ other: 1 }), []);
});

test("401 becomes needs_signin; 403 and a missing stored scope become missing_scope", async () => {
  assert.deepEqual((await setup({ status: 401 }).service.get("u")).diagnostics, ["needs_signin"]);
  assert.deepEqual((await setup({ status: 403 }).service.get("u")).diagnostics, ["missing_scope"]);
  const noScope = setup({ data: cred({ scopes: ["user:inference"] }) });
  assert.deepEqual((await noScope.service.get("u")).diagnostics, ["missing_scope"]);
  assert.equal(noScope.calls.length, 0, "no request without the scope");
});

test("no stored Claude login is needs_signin", async () => {
  const r = await setup({ data: null }).service.get("u");
  assert.deepEqual(r.diagnostics, ["needs_signin"]);
});

test("an API key in the session env adds the api_key diagnostic", async () => {
  const r = await setup({ apiKey: true }).service.get("u");
  assert.deepEqual(r.diagnostics, ["api_key"]);
  assert.deepEqual(apiKeyReachesSessions({ passHostEnv: false, sessionEnvAllow: [] }, { ANTHROPIC_API_KEY: "x" }), false);
  assert.equal(apiKeyReachesSessions({ passHostEnv: false, sessionEnvAllow: ["ANTHROPIC_API_KEY"] }, { ANTHROPIC_API_KEY: "x" }), true);
  assert.equal(apiKeyReachesSessions({ passHostEnv: true, sessionEnvAllow: [] }, {}), false);
});

test("failures are 'unavailable' and never echo the token, the error text or the body", async () => {
  for (const s of [setup({ throws: true }), setup({ status: 500, body: { error: TOKEN } })]) {
    const r = await s.service.get("u");
    assert.equal(r.error, "unavailable");
    assert.ok(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes("boom"));
  }
});

test("cached for 5 minutes per user, invalidate refetches", async () => {
  const { service, calls, tick } = setup();
  await service.get("u"); await service.get("u");
  assert.equal(calls.length, 1);
  await service.get("other");
  assert.equal(calls.length, 2);
  tick(4 * 60_000); await service.get("u");
  assert.equal(calls.length, 2);
  tick(2 * 60_000); await service.get("u");
  assert.equal(calls.length, 3);
  service.invalidate("u"); await service.get("u");
  assert.equal(calls.length, 4);
});
