import test from "node:test";
import assert from "node:assert/strict";
import { nextRun, upcomingRuns, validateSchedule, zonedToUtc, planAutomationTick, localDateLabel, ScheduleError } from "../src/scheduleMath.ts";

const rec = (o) => ({ kind: "recurring", freq: "daily", interval: 1, time: "09:00", timezone: "UTC", startDate: "2026-01-01", ...o });
const iso = (d) => d && d.toISOString();
const runs = (s, after, n = 5) => upcomingRuns(s, new Date(after), n).map(iso);

test("daily and interval > 1", () => {
  assert.deepEqual(runs(rec({}), "2026-01-01T10:00:00Z", 2), ["2026-01-02T09:00:00.000Z", "2026-01-03T09:00:00.000Z"]);
  assert.deepEqual(runs(rec({ interval: 3 }), "2026-01-01T08:00:00Z", 3), ["2026-01-01T09:00:00.000Z", "2026-01-04T09:00:00.000Z", "2026-01-07T09:00:00.000Z"]);
  // far in the future still lands on the interval grid (skip-ahead)
  assert.equal(iso(nextRun(rec({ interval: 3 }), new Date("2030-06-15T10:00:00Z"))), "2030-06-18T09:00:00.000Z");
});

test("strictly after: an occurrence at exactly `after` is not returned", () => {
  assert.equal(iso(nextRun(rec({}), new Date("2026-01-02T09:00:00Z"))), "2026-01-03T09:00:00.000Z");
});

test("not before startDate", () => {
  assert.equal(iso(nextRun(rec({ startDate: "2026-03-10" }), new Date("2026-01-01T00:00:00Z"))), "2026-03-10T09:00:00.000Z");
});

test("weekly weekdays, default weekday and interval 2", () => {
  // 2026-01-05 is a Monday
  const s = rec({ freq: "weekly", weekdays: [1, 3, 5], startDate: "2026-01-05" });
  assert.deepEqual(runs(s, "2026-01-05T00:00:00Z", 4), ["2026-01-05T09:00:00.000Z", "2026-01-07T09:00:00.000Z", "2026-01-09T09:00:00.000Z", "2026-01-12T09:00:00.000Z"]);
  assert.deepEqual(runs(rec({ freq: "weekly", startDate: "2026-01-05" }), "2026-01-05T10:00:00Z", 2), ["2026-01-12T09:00:00.000Z", "2026-01-19T09:00:00.000Z"]);
  const biweekly = rec({ freq: "weekly", interval: 2, weekdays: [1], startDate: "2026-01-05" });
  assert.deepEqual(runs(biweekly, "2026-01-05T10:00:00Z", 2), ["2026-01-19T09:00:00.000Z", "2026-02-02T09:00:00.000Z"]);
  assert.equal(iso(nextRun(biweekly, new Date("2027-03-01T10:00:00Z"))), "2027-03-15T09:00:00.000Z");
});

test("weekly start mid-week does not emit earlier weekdays of that week", () => {
  const s = rec({ freq: "weekly", weekdays: [0, 1, 6], startDate: "2026-01-07" }); // Wednesday
  assert.deepEqual(runs(s, "2026-01-01T00:00:00Z", 3), ["2026-01-10T09:00:00.000Z", "2026-01-11T09:00:00.000Z", "2026-01-12T09:00:00.000Z"]);
});

test("monthly day 19 and day 31 -> last day of shorter months", () => {
  assert.deepEqual(runs(rec({ freq: "monthly", monthDay: 19, startDate: "2026-01-01" }), "2026-01-20T00:00:00Z", 2), ["2026-02-19T09:00:00.000Z", "2026-03-19T09:00:00.000Z"]);
  const s = rec({ freq: "monthly", monthDay: 31, startDate: "2026-01-01" });
  assert.deepEqual(runs(s, "2026-01-01T00:00:00Z", 5), ["2026-01-31T09:00:00.000Z", "2026-02-28T09:00:00.000Z", "2026-03-31T09:00:00.000Z", "2026-04-30T09:00:00.000Z", "2026-05-31T09:00:00.000Z"]);
  assert.equal(iso(nextRun(s, new Date("2028-02-01T00:00:00Z"))), "2028-02-29T09:00:00.000Z");
});

test("monthly interval 3 and default day from startDate", () => {
  assert.deepEqual(runs(rec({ freq: "monthly", interval: 3, startDate: "2026-01-15" }), "2026-01-16T00:00:00Z", 2), ["2026-04-15T09:00:00.000Z", "2026-07-15T09:00:00.000Z"]);
});

test("yearly incl. Feb 29 clamping and interval", () => {
  const s = rec({ freq: "yearly", startDate: "2024-02-29" });
  assert.deepEqual(runs(s, "2024-03-01T00:00:00Z", 4), ["2025-02-28T09:00:00.000Z", "2026-02-28T09:00:00.000Z", "2027-02-28T09:00:00.000Z", "2028-02-29T09:00:00.000Z"]);
  assert.deepEqual(runs(rec({ freq: "yearly", interval: 2, startDate: "2026-07-04" }), "2026-07-05T00:00:00Z", 2), ["2028-07-04T09:00:00.000Z", "2030-07-04T09:00:00.000Z"]);
});

test("endDate is inclusive and ends the schedule", () => {
  const s = rec({ endDate: "2026-01-03" });
  assert.deepEqual(runs(s, "2026-01-01T00:00:00Z", 10), ["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z", "2026-01-03T09:00:00.000Z"]);
  assert.equal(nextRun(s, new Date("2026-01-03T09:00:00Z")), null);
});

test("count counts from startDate regardless of the clock", () => {
  const s = rec({ count: 3 });
  assert.deepEqual(runs(s, "2025-01-01T00:00:00Z", 10), ["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z", "2026-01-03T09:00:00.000Z"]);
  assert.equal(nextRun(s, new Date("2026-01-02T10:00:00Z")).toISOString(), "2026-01-03T09:00:00.000Z");
  assert.equal(nextRun(s, new Date("2026-01-03T10:00:00Z")), null);
  const w = rec({ freq: "weekly", weekdays: [1, 2], startDate: "2026-01-05", count: 3 });
  assert.equal(runs(w, "2026-01-01T00:00:00Z", 10).length, 3);
});

test("once", () => {
  const s = { kind: "once", at: "2026-05-01T12:00:00.000Z" };
  assert.equal(iso(nextRun(s, new Date("2026-04-01T00:00:00Z"))), "2026-05-01T12:00:00.000Z");
  assert.equal(nextRun(s, new Date("2026-05-01T12:00:00Z")), null);
});

test("timezone: local time converts with the zone offset", () => {
  const s = rec({ timezone: "America/Sao_Paulo", time: "08:00" }); // UTC-3, no DST since 2019
  assert.equal(iso(nextRun(s, new Date("2026-06-01T00:00:00Z"))), "2026-06-01T11:00:00.000Z");
  const tokyo = rec({ timezone: "Asia/Tokyo", time: "01:00" });
  assert.equal(iso(nextRun(tokyo, new Date("2026-06-01T00:00:00Z"))), "2026-06-01T16:00:00.000Z"); // 01:00 JST on Jun 2
});

test("DST spring-forward gap runs at the shifted instant, once per day", () => {
  // America/New_York 2026-03-08: 02:00 -> 03:00. 02:30 does not exist.
  const s = rec({ timezone: "America/New_York", time: "02:30", startDate: "2026-03-06" });
  assert.deepEqual(runs(s, "2026-03-06T12:00:00Z", 4), ["2026-03-07T07:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  assert.equal(iso(new Date(zonedToUtc({ y: 2026, m: 3, d: 8 }, 2, 30, "America/New_York"))), "2026-03-08T07:30:00.000Z"); // 03:30 EDT
});

test("DST fall-back overlap runs once, at the first occurrence", () => {
  // 2026-11-01 01:30 happens twice in New York (EDT 05:30Z, EST 06:30Z).
  const s = rec({ timezone: "America/New_York", time: "01:30", startDate: "2026-10-31" });
  assert.deepEqual(runs(s, "2026-10-31T12:00:00Z", 3), ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z", "2026-11-03T06:30:00.000Z"]);
});

test("local time stays constant across a DST change", () => {
  const s = rec({ timezone: "Europe/Berlin", time: "09:00", startDate: "2026-03-27" });
  assert.deepEqual(runs(s, "2026-03-27T00:00:00Z", 3), ["2026-03-27T08:00:00.000Z", "2026-03-28T08:00:00.000Z", "2026-03-29T07:00:00.000Z"]);
});

test("southern hemisphere gap (Australia/Sydney, October)", () => {
  const s = rec({ timezone: "Australia/Sydney", time: "02:30", startDate: "2026-10-03" }); // 2026-10-04 02:00 -> 03:00
  assert.deepEqual(runs(s, "2026-10-02T00:00:00Z", 3), ["2026-10-02T16:30:00.000Z", "2026-10-03T16:30:00.000Z", "2026-10-04T15:30:00.000Z"]);
});

test("validation errors carry the field name", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const bad = (s, field) => assert.throws(() => validateSchedule(s, now), (e) => e instanceof ScheduleError && e.field === field, JSON.stringify(s));
  bad(null, "schedule");
  bad({ kind: "x" }, "schedule.kind");
  bad({ kind: "once", at: "2025-12-31T00:00:00Z" }, "schedule.at"); // once in the past rejected
  bad({ kind: "once", at: "2026-01-01T00:00:00Z" }, "schedule.at"); // not strictly future
  bad({ kind: "once", at: "garbage" }, "schedule.at");
  bad(rec({ freq: "hourly" }), "schedule.freq");
  bad(rec({ interval: 0 }), "schedule.interval");
  bad(rec({ interval: 1.5 }), "schedule.interval");
  bad(rec({ time: "25:00" }), "schedule.time");
  bad(rec({ time: "9:00" }), "schedule.time");
  bad(rec({ timezone: "Mars/Base" }), "schedule.timezone");
  bad(rec({ startDate: "2026-02-30" }), "schedule.startDate");
  bad(rec({ weekdays: [1] }), "schedule.weekdays"); // daily with weekdays
  bad(rec({ freq: "weekly", weekdays: [7] }), "schedule.weekdays");
  bad(rec({ monthDay: 5 }), "schedule.monthDay");
  bad(rec({ freq: "monthly", monthDay: 32 }), "schedule.monthDay");
  bad(rec({ endDate: "2025-12-31" }), "schedule.endDate");
  bad(rec({ count: 0 }), "schedule.count");
});

test("validation normalises and accepts valid schedules", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(validateSchedule({ kind: "once", at: "2026-06-01T10:00:00+02:00" }, now), { kind: "once", at: "2026-06-01T08:00:00.000Z" });
  const s = validateSchedule(rec({ freq: "weekly", weekdays: [5, 1, 1] }), now);
  assert.deepEqual(s.weekdays, [1, 5]);
  assert.equal(validateSchedule(rec({ interval: undefined }), now).interval, 1);
});

test("planAutomationTick: wait, run, catch-up skip/once", () => {
  const schedule = rec({});
  const base = { enabled: true, schedule, catchUp: "once" };
  const at = new Date("2026-01-05T09:00:00Z");
  assert.equal(planAutomationTick({ ...base, nextRunAt: at, now: new Date("2026-01-05T08:59:59Z") }).action, "wait");
  assert.equal(planAutomationTick({ ...base, enabled: false, nextRunAt: at, now: new Date("2026-01-05T10:00:00Z") }).action, "wait");
  const onTime = planAutomationTick({ ...base, nextRunAt: at, now: new Date("2026-01-05T09:00:30Z") });
  assert.deepEqual([onTime.action, iso(onTime.nextRunAt), onTime.missed], ["run", "2026-01-06T09:00:00.000Z", false]);
  const lateOnce = planAutomationTick({ ...base, nextRunAt: at, now: new Date("2026-01-09T12:00:00Z") });
  assert.deepEqual([lateOnce.action, iso(lateOnce.nextRunAt), lateOnce.missed], ["run", "2026-01-10T09:00:00.000Z", true]);
  const lateSkip = planAutomationTick({ ...base, catchUp: "skip", nextRunAt: at, now: new Date("2026-01-09T12:00:00Z") });
  assert.deepEqual([lateSkip.action, iso(lateSkip.nextRunAt)], ["skip", "2026-01-10T09:00:00.000Z"]);
  // skip mode still runs when only slightly late
  assert.equal(planAutomationTick({ ...base, catchUp: "skip", nextRunAt: at, now: new Date("2026-01-05T09:01:00Z") }).action, "run");
  // finishing: no next occurrence
  const last = planAutomationTick({ ...base, schedule: rec({ count: 1, startDate: "2026-01-05" }), nextRunAt: at, now: new Date("2026-01-05T09:00:10Z") });
  assert.equal(last.nextRunAt, null);
});

test("localDateLabel uses the zone's calendar date", () => {
  assert.equal(localDateLabel(new Date("2026-01-02T01:00:00Z"), "America/Sao_Paulo"), "2026-01-01");
  assert.equal(localDateLabel(new Date("2026-01-02T01:00:00Z"), "UTC"), "2026-01-02");
});
