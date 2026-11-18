import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_INTERVAL_MS, INITIAL_CHECK_DELAY_MS, INITIAL_UPDATE_STATE, RETRY_DELAY_MS,
  canAutoCheck, describeUpdateError, nextCheckDelay, reduceUpdate, releaseNotesUrl,
} from "../../src/lib/updater-logic.ts";

test("automatic checks need a packaged desktop build, the preference on and an idle state", () => {
  const ok = { isDesktop: true, isProd: true, enabled: true, status: "idle" as const };
  assert.equal(canAutoCheck(ok), true);
  assert.equal(canAutoCheck({ ...ok, isDesktop: false }), false);
  assert.equal(canAutoCheck({ ...ok, isProd: false }), false);
  assert.equal(canAutoCheck({ ...ok, enabled: false }), false);
  for (const status of ["checking", "downloading", "ready", "installing"] as const) assert.equal(canAutoCheck({ ...ok, status }), false);
  assert.equal(canAutoCheck({ ...ok, status: "error" }), true);
});

test("scheduling: 30 s after launch, then every 6 h, retry sooner after a failure", () => {
  assert.equal(nextCheckDelay({ lastCheckedAt: null, now: 5, failed: false }), INITIAL_CHECK_DELAY_MS);
  assert.equal(nextCheckDelay({ lastCheckedAt: 1000, now: 1000, failed: false }), CHECK_INTERVAL_MS);
  assert.equal(nextCheckDelay({ lastCheckedAt: 1000, now: 1000 + CHECK_INTERVAL_MS + 5, failed: false }), 0);
  assert.equal(nextCheckDelay({ lastCheckedAt: 1000, now: 1000, failed: true }), RETRY_DELAY_MS);
});

test("state machine: found -> progress -> downloaded -> installing", () => {
  let s = reduceUpdate(INITIAL_UPDATE_STATE, { type: "check-start" });
  assert.equal(s.status, "checking");
  s = reduceUpdate(s, { type: "found", at: 10, version: "1.2.3", notes: "n" });
  assert.deepEqual([s.status, s.version, s.lastCheckedAt], ["downloading", "1.2.3", 10]);
  s = reduceUpdate(s, { type: "progress", chunk: 50, total: 200, received: 50 });
  assert.equal(s.progress, 0.25);
  s = reduceUpdate(s, { type: "progress", chunk: 50, total: null, received: 100 });
  assert.equal(s.progress, null);
  s = reduceUpdate(s, { type: "downloaded" });
  assert.equal(s.status, "ready");
  // A manual check does not disturb a ready update.
  assert.equal(reduceUpdate(s, { type: "check-start" }), s);
  s = reduceUpdate(s, { type: "install-start" });
  assert.equal(s.status, "installing");
  s = reduceUpdate(s, { type: "install-error", message: "x" });
  assert.deepEqual([s.status, s.error, s.version], ["ready", "x", "1.2.3"]);
});

test("none and error", () => {
  const none = reduceUpdate(INITIAL_UPDATE_STATE, { type: "check-none", at: 7 });
  assert.deepEqual([none.status, none.lastCheckedAt], ["uptodate", 7]);
  const err = reduceUpdate(none, { type: "check-error", at: 9, message: "boom" });
  assert.deepEqual([err.status, err.error, err.lastCheckedAt], ["error", "boom", 9]);
});

test("notes url and error text", () => {
  assert.equal(releaseNotesUrl("1.2.3"), "https://github.com/victorl1m/Floq/releases/tag/v1.2.3");
  assert.equal(releaseNotesUrl("v1.2.3"), "https://github.com/victorl1m/Floq/releases/tag/v1.2.3");
  assert.match(describeUpdateError(new Error("the public key is not valid base64")), /not configured/);
  assert.match(describeUpdateError("Signature verification failed"), /signature check/);
  assert.match(describeUpdateError("error sending request: connect timed out"), /reach/);
  assert.equal(describeUpdateError(undefined), "Could not check for updates.");
});
