// Run: node --experimental-transform-types --test e2e/org-error.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { RuntimeClient, RuntimeError } = await import("../src/lib/runtime/client.ts");
const { loadUserPreferences, saveUserPreferences, userPreferenceKey } = await import("../src/lib/user-preferences.ts");

async function fail(body: unknown): Promise<InstanceType<typeof RuntimeError>> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const client = new RuntimeClient("http://x", "t");
    await (client as unknown as { call: (m: string, p: string, b?: unknown) => Promise<unknown> }).call("POST", "/v1/projects", {});
  } catch (e) { return e as InstanceType<typeof RuntimeError>; } finally { globalThis.fetch = real; }
  throw new Error("expected failure");
}

test("real server error shape exposes details.projectId at the top of details", async () => {
  const e = await fail({ error: { code: "project_in_other_org", message: "m", details: { projectId: "p1", organizationId: "o1", organizationName: "Team" } } });
  assert.equal(e.code, "project_in_other_org");
  assert.equal(e.details?.projectId, "p1");
  assert.equal(e.details?.organizationId, "o1");
  assert.equal(e.details?.organizationName, "Team");
});
test("top-level shape still works", async () => {
  const e = await fail({ error: { code: "project_in_other_org", message: "m" }, projectId: "p2", organizationId: "o2" });
  assert.equal(e.details?.projectId, "p2");
  assert.equal(e.details?.organizationId, "o2");
});

test("saved active organization from before org scoping is ignored once", () => {
  const key = userPreferenceKey("http://x", "u")!;
  store.set(key, JSON.stringify({ version: 1, activeOrganizationId: "team-org" }));
  assert.equal(loadUserPreferences("http://x", "u").activeOrganizationId, null);
  saveUserPreferences("http://x", "u", { activeOrganizationId: "personal-org" });
  assert.equal(loadUserPreferences("http://x", "u").activeOrganizationId, "personal-org");
  saveUserPreferences("http://x", "u", { sidebarOpen: false });
  assert.equal(loadUserPreferences("http://x", "u").activeOrganizationId, "personal-org");
});
