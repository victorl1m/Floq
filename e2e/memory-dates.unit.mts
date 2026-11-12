// Run: node --experimental-strip-types --test e2e/memory-dates.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import { absoluteDate, compareDesc, dateParts, eventTime, isoDate, NO_DATE, relativeTime, toMs } from "../src/lib/memory-dates.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ISO = "2026-11-12T11:55:00.000Z";
const MS = Date.parse(ISO);

test("toMs accepts ISO strings, epoch ms, epoch seconds, numeric strings and Date", () => {
  assert.equal(toMs(ISO), MS);
  assert.equal(toMs(MS), MS);
  assert.equal(toMs(MS / 1000), MS);
  assert.equal(toMs(String(MS)), MS);
  assert.equal(toMs(String(MS / 1000)), MS);
  assert.equal(toMs(new Date(MS)), MS);
  assert.equal(toMs("  " + ISO + " "), MS);
});

test("toMs rejects null, empty, garbage, the epoch placeholder and out-of-range values", () => {
  for (const v of [null, undefined, "", "   ", "garbage", "not-a-date", NaN, Infinity, -5, 0, "0", true, {}, [], new Date("x"), "1970-01-01T00:00:00.000Z", 9e15]) {
    assert.equal(toMs(v), null, `expected null for ${String(v)}`);
  }
});

test("relativeTime never says Invalid Date", () => {
  assert.equal(relativeTime(ISO, NOW), "5m ago");
  assert.equal(relativeTime(MS, NOW), "5m ago");
  assert.equal(relativeTime(MS / 1000, NOW), "5m ago");
  assert.equal(relativeTime(NOW - 10_000, NOW), "just now");
  assert.equal(relativeTime(NOW + 20_000, NOW), "just now", "small clock skew");
  assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), "3h ago");
  assert.equal(relativeTime(NOW - 2 * 86_400_000, NOW), "2d ago");
  assert.equal(relativeTime(NOW - 400 * 86_400_000, NOW), "1y ago");
  for (const v of [null, undefined, "garbage", "1970-01-01T00:00:00.000Z", 0]) assert.equal(relativeTime(v, NOW), NO_DATE);
  assert.doesNotMatch(relativeTime(NOW + 10 * 86_400_000, NOW), /Invalid|ago/);
});

test("absoluteDate and isoDate format valid input and degrade to a dash", () => {
  const s = absoluteDate(ISO, { locale: "en-US", timeZone: "UTC" });
  assert.match(s, /Nov 12, 2026/);
  assert.match(s, /11:55/);
  assert.equal(absoluteDate(MS / 1000, { locale: "en-US", timeZone: "UTC", dateOnly: true }), "Nov 12, 2026");
  assert.equal(absoluteDate("garbage"), NO_DATE);
  assert.equal(absoluteDate(null), NO_DATE);
  assert.equal(isoDate(MS / 1000), ISO);
  assert.equal(isoDate("nope"), undefined);
  for (const v of [null, "garbage", 0, MS, ISO]) assert.doesNotMatch(absoluteDate(v), /Invalid/);
});

test("dateParts bundles the three views; eventTime reads `at` then `createdAt`", () => {
  assert.deepEqual(dateParts(null, NOW), { relative: NO_DATE, absolute: NO_DATE, iso: undefined, valid: false });
  assert.equal(dateParts(ISO, NOW).valid, true);
  assert.equal(eventTime({ at: ISO }), ISO);
  assert.equal(eventTime({ createdAt: ISO }), ISO);
  assert.equal(eventTime({ at: "bad", createdAt: ISO }), ISO);
  assert.equal(eventTime(null), null);
});

test("compareDesc sorts newest first and invalid dates last", () => {
  const list = ["garbage", ISO, MS / 1000 - 3600, null, NOW];
  assert.deepEqual([...list].sort(compareDesc), [NOW, ISO, MS / 1000 - 3600, "garbage", null]);
});
