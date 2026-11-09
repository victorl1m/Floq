import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseCacheTtl } from "../dist/config.js";

const base = { BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: "https://floq.example", DATABASE_URL: "postgres://x", FLOQ_ENCRYPTION_KEY: "0".repeat(64) };

test("cache config defaults to auto/off and falls back to auto on invalid values", () => {
  const config = loadConfig({ ...base });
  assert.equal(config.cacheTtl, "auto");
  assert.equal(config.cacheHelperTtl, "auto");
  assert.equal(config.cacheDisable, false);
  const bad = loadConfig({ ...base, FLOQ_CACHE_TTL: "2h", FLOQ_CACHE_HELPER_TTL: "forever" });
  assert.equal(bad.cacheTtl, "auto");
  assert.equal(bad.cacheHelperTtl, "auto");
});

test("cache config accepts 5m, 1h (case-insensitive) and FLOQ_CACHE_DISABLE", () => {
  const config = loadConfig({ ...base, FLOQ_CACHE_TTL: "1H", FLOQ_CACHE_HELPER_TTL: "5m", FLOQ_CACHE_DISABLE: "1" });
  assert.equal(config.cacheTtl, "1h");
  assert.equal(config.cacheHelperTtl, "5m");
  assert.equal(config.cacheDisable, true);
  assert.equal(parseCacheTtl(undefined), "auto");
});
