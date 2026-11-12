// Run: node --experimental-strip-types --test e2e/org-prefs.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { loadUserPreferences, userPreferenceKey } = await import("../src/lib/user-preferences.ts");

test("old preferences without per-org canvas load with an empty map and keep the legacy id", () => {
  store.set(userPreferenceKey("http://x", "u")!, JSON.stringify({ version: 1, lastCanvasProjectId: "p1" }));
  const prefs = loadUserPreferences("http://x", "u");
  assert.deepEqual(prefs.lastCanvasProjectIdByOrg, {});
  assert.equal(prefs.lastCanvasProjectId, "p1");
});
test("per-org canvas map keeps strings only", () => {
  store.set(userPreferenceKey("http://x", "u")!, JSON.stringify({ version: 1, lastCanvasProjectIdByOrg: { a: "p", b: 3 } }));
  assert.deepEqual(loadUserPreferences("http://x", "u").lastCanvasProjectIdByOrg, { a: "p" });
});
