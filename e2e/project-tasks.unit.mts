// Run: node --experimental-strip-types --test e2e/project-tasks.unit.mts
import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultScheduleForm, describeSchedule, dropPosition, formToSchedule, fromLocalInput, groupByStatus, scheduleToForm, taskOrigin,
  toLocalInput, validateAutomationForm, validateScheduleForm, validateTaskTitle, type ProjectTask, type RecurringSchedule,
} from "../src/lib/project-tasks.ts";

const NOW = new Date("2026-11-18T12:00:00");
const rec = (over: Partial<RecurringSchedule> = {}): RecurringSchedule => ({ kind: "recurring", freq: "monthly", interval: 1, monthDay: 19, time: "09:00", timezone: "America/Sao_Paulo", startDate: "2026-11-18", ...over });

test("sentence: monthly on day 19", () => {
  assert.equal(describeSchedule(rec()), "Every month on day 19 at 09:00 (America/Sao_Paulo), from Nov 18, 2026");
});
test("sentence: intervals, weekdays, last day, yearly, end rules", () => {
  assert.equal(describeSchedule(rec({ freq: "daily", interval: 2, monthDay: undefined })), "Every 2 days at 09:00 (America/Sao_Paulo), from Nov 18, 2026");
  assert.match(describeSchedule(rec({ freq: "weekly", monthDay: undefined, weekdays: [1, 3] })), /^Every week on Mon, Wed at 09:00/);
  assert.match(describeSchedule(rec({ monthDay: 31 })), /^Every month on the last day at/);
  assert.match(describeSchedule(rec({ freq: "yearly", monthDay: undefined })), /^Every year on Nov 18 at/);
  assert.match(describeSchedule(rec({ endDate: "2027-01-01", count: 3 })), /, until Jan 1, 2027, 3 times in total$/);
});
test("sentence: once", () => {
  assert.equal(describeSchedule({ kind: "once", at: "2026-11-19T12:00:00.000Z" }, "UTC"), "Once on Nov 19, 2026 at 12:00");
});
test("local input round trip", () => {
  const iso = fromLocalInput("2026-11-19T09:00");
  assert.ok(iso);
  assert.equal(toLocalInput(iso), "2026-11-19T09:00");
  assert.equal(fromLocalInput(""), null);
  assert.equal(toLocalInput(null), "");
});
test("validation: once must be in the future", () => {
  const f = { ...defaultScheduleForm(NOW, "UTC"), mode: "once" as const };
  assert.ok(validateScheduleForm({ ...f, onceAt: "2026-11-17T09:00" }, NOW)["schedule.at"]);
  assert.ok(validateScheduleForm({ ...f, onceAt: "" }, NOW)["schedule.at"]);
  assert.deepEqual(validateScheduleForm({ ...f, onceAt: "2026-11-19T09:00" }, NOW), {});
});
test("validation: repeat fields", () => {
  const f = defaultScheduleForm(NOW, "UTC");
  assert.deepEqual(validateScheduleForm(f, NOW), {});
  assert.ok(validateScheduleForm({ ...f, interval: "0" }, NOW)["schedule.interval"]);
  assert.ok(validateScheduleForm({ ...f, interval: "1.5" }, NOW)["schedule.interval"]);
  assert.ok(validateScheduleForm({ ...f, time: "25:00" }, NOW)["schedule.time"]);
  assert.ok(validateScheduleForm({ ...f, timezone: "Mars/Base" }, NOW)["schedule.timezone"]);
  assert.ok(validateScheduleForm({ ...f, startDate: "2026-02-30" }, NOW)["schedule.startDate"]);
  assert.ok(validateScheduleForm({ ...f, weekdays: [] }, NOW)["schedule.weekdays"]);
  const m = { ...f, freq: "monthly" as const };
  assert.ok(validateScheduleForm({ ...m, monthDay: "32" }, NOW)["schedule.monthDay"]);
  assert.ok(validateScheduleForm({ ...f, endMode: "date", endDate: "2026-11-01" }, NOW)["schedule.endDate"]);
  assert.ok(validateScheduleForm({ ...f, endMode: "count", count: "" }, NOW)["schedule.count"]);
});
test("form -> schedule -> form", () => {
  const f = { ...defaultScheduleForm(NOW, "UTC"), freq: "monthly" as const, monthDay: "19", endMode: "count" as const, count: "4" };
  const s = formToSchedule(f);
  assert.deepEqual(s, { kind: "recurring", freq: "monthly", interval: 1, time: "09:00", timezone: "UTC", startDate: "2026-11-18", monthDay: 19, count: 4 });
  const back = scheduleToForm(s, NOW);
  assert.equal(back.endMode, "count");
  assert.equal(back.monthDay, "19");
  const w = formToSchedule({ ...f, freq: "weekly", weekdays: [3, 1, 3] });
  assert.deepEqual((w as RecurringSchedule).weekdays, [1, 3]);
  assert.equal("monthDay" in w, false);
});
test("automation form needs a title", () => {
  const schedule = defaultScheduleForm(NOW, "UTC");
  assert.ok(validateAutomationForm({ title: "  ", instructions: "", schedule }, NOW).title);
  assert.deepEqual(validateAutomationForm({ title: "Report", instructions: "x", schedule }, NOW), {});
  assert.ok(validateTaskTitle(" "));
  assert.equal(validateTaskTitle("ok"), null);
});
const task = (id: string, status: ProjectTask["status"], position: number): ProjectTask => ({ id, projectId: "p", title: id, description: "", status, priority: "normal", assigneeSessionId: null, createdBy: "user", dueAt: null, runAt: null, automationId: null, position, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", completedAt: null });
test("grouping, drop position, origin", () => {
  const g = groupByStatus([task("a", "todo", 2), task("b", "todo", 1), task("c", "done", 1), task("d", "cancelled", 1)]);
  assert.deepEqual(g.todo.map((t) => t.id), ["b", "a"]);
  assert.equal(g.done.length, 1);
  assert.equal(dropPosition([], 0), 1);
  assert.equal(dropPosition([{ position: 1 }, { position: 3 }], 1), 2);
  assert.equal(dropPosition([{ position: 1 }], 1), 2);
  assert.equal(dropPosition([{ position: 1 }], 0), 0);
  assert.deepEqual(taskOrigin("agent:x"), { kind: "agent", sessionId: "x" });
  assert.deepEqual(taskOrigin("automation:y"), { kind: "automation", automationId: "y" });
});
