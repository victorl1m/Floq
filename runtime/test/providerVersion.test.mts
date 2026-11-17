import test from "node:test";
import assert from "node:assert/strict";
import { detectVersion } from "../dist/providers.js";

test("a cached CLI version is served without blocking, and a stale one refreshes in the background", async (t) => {
  const bin = process.execPath;
  const first = detectVersion(bin); // the only synchronous check
  assert.equal(first.available, true);
  assert.equal(first.version, process.version);

  // Make the entry stale, then make sure the next call returns at once with the cached value.
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 10 * 60_000;
  const started = process.hrtime.bigint();
  const stale = detectVersion(bin);
  const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(stale, first);
  assert.ok(tookMs < 20, `stale lookup must not spawn synchronously (took ${tookMs.toFixed(1)}ms)`);

  // The background refresh lands and stamps the entry fresh again.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(detectVersion(bin), first);
});

test("a missing CLI is reported unavailable", () => {
  assert.deepEqual(detectVersion("floq-test-definitely-missing-cli"), { available: false, version: null });
});
