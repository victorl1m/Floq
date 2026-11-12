import test from "node:test";
import assert from "node:assert/strict";
import { UsageService, claudePlanLabel, parseClaudeUsage, usageErrorMessage } from "../dist/usage.js";

const reset = "2026-11-12T18:00:00.000000+00:00";
const max = {
  five_hour: { utilization: 37.0, resets_at: reset },
  seven_day: { utilization: 62, resets_at: "2026-11-15T10:00:00Z" },
  seven_day_oauth_apps: null,
  seven_day_opus: { utilization: 12.5, resets_at: "2026-11-15T10:00:00Z" },
  seven_day_sonnet: { utilization: null, resets_at: null },
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1230, utilization: 24.6 },
};

test("plan label: Max 5x/20x from tier, plain Max, Pro, none", () => {
  assert.equal(claudePlanLabel("max", "default_claude_max_5x"), "Max 5x");
  assert.equal(claudePlanLabel("max", "default_claude_max_20x"), "Max 20x");
  assert.equal(claudePlanLabel("max", null), "Max");
  assert.equal(claudePlanLabel("pro", "default_claude_ai"), "Pro");
  assert.equal(claudePlanLabel(null, null), null);
});

test("Max payload: session, weekly, per-model, extra usage; null windows skipped, null utilization is not 0%", () => {
  const w = parseClaudeUsage(max);
  assert.deepEqual(w.map((x) => x.id), ["five_hour", "seven_day", "seven_day_opus", "extra_usage"]);
  assert.equal(w[0].usedPercent, 37);
  assert.equal(w[0].resetsAt, "2026-11-12T18:00:00.000Z");
  assert.equal(w[3].usedPercent, 24.6);
  assert.equal(w[3].detail, "$12.30 of $50.00");
});

test("Pro payload and oauth-apps window", () => {
  const w = parseClaudeUsage({ five_hour: { utilization: 5, resets_at: reset }, seven_day: { utilization: 1, resets_at: reset }, seven_day_oauth_apps: { utilization: 3, resets_at: reset } });
  assert.deepEqual(w.map((x) => x.id), ["five_hour", "seven_day", "seven_day_oauth_apps"]);
});

test("extra usage derives percent from credits, ignored when disabled; empty and garbage bodies give no windows", () => {
  assert.equal(parseClaudeUsage({ extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500 } })[0].usedPercent, 25);
  assert.deepEqual(parseClaudeUsage({ extra_usage: { is_enabled: false, utilization: 50 } }), []);
  assert.deepEqual(parseClaudeUsage({}), []);
  assert.deepEqual(parseClaudeUsage({ five_hour: "x", seven_day: { utilization: "" } }), []);
});

test("error messages are readable", () => {
  assert.match(usageErrorMessage(403, "claude"), /missing scope/);
  assert.match(usageErrorMessage(401, "claude"), /expired/);
  assert.equal(usageErrorMessage(500, "claude"), "HTTP 500");
});

function service(data: Record<string, unknown> | null) {
  const broker = { refresh: async () => {}, get: async (_u: string, p: string) => (p === "claude" ? data : null) };
  return new UsageService(broker as never);
}
function stubFetch(status: number, body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("service: Max 20x end to end", async () => {
  const restore = stubFetch(200, max);
  try {
    const r = await service({ accessToken: "t", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" }).get("u1");
    assert.equal(r.claude?.plan, "Max 20x");
    assert.equal(r.claude?.windows.length, 4);
    assert.equal(r.claude?.error, undefined);
    assert.equal(r.codex, null);
  } finally { restore(); }
});

test("service: 403 degrades to a reason with no windows; API-key-only (no credential) is null; empty body explains itself", async () => {
  let restore = stubFetch(403, { error: { type: "permission_error" } });
  try {
    const r = await service({ accessToken: "t", subscriptionType: "max" }).get("u2");
    assert.equal(r.claude?.connected, true);
    assert.deepEqual(r.claude?.windows, []);
    assert.match(r.claude?.error ?? "", /missing scope/);
  } finally { restore(); }
  assert.equal((await service(null).get("u3")).claude, null);
  restore = stubFetch(200, {});
  try {
    const r = await service({ accessToken: "t" }).get("u4");
    assert.equal(r.claude?.plan, null);
    assert.match(r.claude?.error ?? "", /No plan usage/);
  } finally { restore(); }
});

test("service: 429 keeps the last windows", async () => {
  const svc = service({ accessToken: "t", subscriptionType: "pro" });
  let restore = stubFetch(200, max);
  await svc.get("u5");
  restore();
  (svc as any).cache.get("u5:claude").at = 0;
  restore = stubFetch(429, {});
  try {
    const r = await svc.get("u5");
    assert.equal(r.claude?.windows.length, 4);
    assert.match(r.claude?.error ?? "", /Rate limited/);
  } finally { restore(); }
});
