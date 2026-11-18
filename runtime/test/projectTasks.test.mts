import test from "node:test";
import assert from "node:assert/strict";
import { ProjectTasks, buildDispatchText, cleanTaskInput, decideDispatch, DISPATCH_BACKOFF_MS } from "../src/projectTasks.ts";
import { Automations, checkSchedule } from "../src/automations.ts";
import { TaskScheduler, SCHEDULER_LOCK_KEY } from "../src/taskScheduler.ts";
import { HttpError } from "../src/errors.ts";

const NOW = new Date("2026-06-19T12:00:00Z");
const P = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const L = "33333333-3333-4333-8333-333333333333";
const base = { status: "todo", runAt: null, autoAgent: true, now: NOW, assigneeSessionId: null, settingsAgentSessionId: null, leadSessionId: L, recentFailure: false };

test("decideDispatch: only todo tasks of auto-agent projects at/after run_at, to assignee > settings agent > lead", () => {
  assert.deepEqual(decideDispatch(base), { action: "dispatch", targetSessionId: L });
  assert.deepEqual(decideDispatch({ ...base, settingsAgentSessionId: A }), { action: "dispatch", targetSessionId: A });
  assert.deepEqual(decideDispatch({ ...base, settingsAgentSessionId: A, assigneeSessionId: P }), { action: "dispatch", targetSessionId: P });
  assert.equal(decideDispatch({ ...base, autoAgent: false }).reason, "auto_off");
  for (const status of ["in_progress", "blocked", "done", "cancelled"]) assert.equal(decideDispatch({ ...base, status }).reason, "not_todo");
  assert.equal(decideDispatch({ ...base, runAt: new Date("2026-06-19T12:00:01Z") }).reason, "scheduled");
  assert.equal(decideDispatch({ ...base, runAt: new Date("2026-06-19T12:00:00Z") }).action, "dispatch"); // at the instant
  assert.equal(decideDispatch({ ...base, runAt: new Date("2026-06-01T00:00:00Z") }).action, "dispatch");
  assert.equal(decideDispatch({ ...base, recentFailure: true }).reason, "backoff");
  assert.equal(decideDispatch({ ...base, leadSessionId: null }).reason, "no_target");
});

test("buildDispatchText carries id, title, description and the CLI to report with", () => {
  const text = buildDispatchText({ id: P, title: "Pay invoices", description: "all of them", priority: "high", dueAt: null, createdBy: "user" });
  for (const part of [P, "Pay invoices", "all of them", "Priority: high", `floq task done ${P}`, `floq task update ${P}`]) assert.ok(text.includes(part), part);
  assert.ok(!text.includes("\n"));
});

test("cleanTaskInput validates and leaves absent fields absent", () => {
  assert.deepEqual(cleanTaskInput({}), {});
  assert.equal(cleanTaskInput({ title: "  a   b " }).title, "a b");
  assert.equal(cleanTaskInput({ dueAt: null }).dueAt, null);
  assert.equal(cleanTaskInput({ runAt: "2026-06-19T12:00:00+02:00" }).runAt, "2026-06-19T10:00:00.000Z");
  const bad = (input, code) => assert.throws(() => cleanTaskInput(input), (e) => e instanceof HttpError && e.status === 400 && e.code === code, JSON.stringify(input));
  bad({ title: "" }, "invalid_title");
  bad({ title: 5 }, "invalid_title");
  bad({ title: "x".repeat(201) }, "invalid_title");
  bad({ description: 1 }, "invalid_description");
  bad({ status: "finished" }, "invalid_status");
  bad({ priority: "asap" }, "invalid_priority");
  bad({ dueAt: "tomorrow" }, "invalid_dueAt");
  bad({ runAt: 12 }, "invalid_runAt");
  bad({ assigneeSessionId: "not-a-uuid" }, "invalid_assignee");
  bad({ position: "1" }, "invalid_position");
});

test("service rejects bad input with 400 before touching the database (REST validation)", async () => {
  const queries = [];
  const pool = { query: async (sql) => { queries.push(sql); return { rows: [{ ok: 1 }] }; } };
  const svc = new ProjectTasks(pool);
  await assert.rejects(svc.create("u", P, {}), (e) => e.status === 400 && e.code === "invalid_title");
  await assert.rejects(svc.create("u", P, { title: "ok", priority: "nope" }), (e) => e.status === 400 && e.code === "invalid_priority");
  await assert.rejects(svc.putSettings("u", P, { autoAgent: "yes" }), (e) => e.status === 400);
  await assert.rejects(svc.putSettings("u", P, { autoAgent: true, agentSessionId: "x" }), (e) => e.status === 400);
  await assert.rejects(svc.comment("u", P, A, "   "), (e) => e.status === 404 || e.status === 400);
  await assert.rejects(svc.requireProject("u", "not-a-uuid"), (e) => e.status === 404);
  assert.ok(queries.every((q) => !/INSERT INTO project_tasks/.test(q)));
});

test("automation schedule validation is a 400 naming the field", () => {
  assert.throws(() => checkSchedule({ kind: "once", at: "2020-01-01T00:00:00Z" }, NOW), (e) => e instanceof HttpError && e.status === 400 && e.details?.field === "schedule.at");
  assert.throws(() => checkSchedule({ kind: "recurring", freq: "daily", time: "9", timezone: "UTC", startDate: "2026-01-01" }, NOW), (e) => e.details?.field === "schedule.time");
  assert.equal(checkSchedule({ kind: "recurring", freq: "monthly", monthDay: 19, time: "09:00", timezone: "America/Sao_Paulo", startDate: "2026-01-01" }, NOW).interval, 1);
});

// ---- dispatchDue control flow with a scripted pool ----
function dispatchPool(rows, { claimFails = new Set() } = {}) {
  const log = [];
  const pool = {
    log,
    query: async (sql, params) => {
      if (/FROM project_tasks t JOIN project_task_settings/.test(sql)) return { rows };
      if (/UPDATE project_tasks SET status = 'in_progress'/.test(sql)) {
        log.push(["claim", params[0], params[1]]);
        if (claimFails.has(params[0])) return { rows: [] };
        const r = rows.find((x) => x.id === params[0]);
        return { rows: [{ ...r, status: "in_progress", assignee_session_id: params[1] }] };
      }
      if (/UPDATE project_tasks SET status = 'todo'/.test(sql)) { log.push(["revert", params[0], params[1]]); return { rows: [] }; }
      if (/INSERT INTO task_events/.test(sql)) { log.push(["event", params[0], params[2], params[3]]); return { rows: [] }; }
      throw new Error("unexpected sql " + sql.slice(0, 60));
    },
  };
  return pool;
}
const taskRow = (id, over = {}) => ({ id, user_id: "u", project_id: P, title: "T " + id.slice(0, 2), description: "", status: "todo", priority: "normal", assignee_session_id: null, created_by: "user", due_at: null, run_at: null, automation_id: null, position: 1, created_at: NOW, updated_at: NOW, completed_at: null, settings_agent: null, lead_id: L, recent_failure: false, ...over });
const T1 = "a1111111-1111-4111-8111-111111111111", T2 = "a2222222-2222-4222-8222-222222222222", T3 = "a3333333-3333-4333-8333-333333333333";

test("dispatchDue claims once, delivers, logs a dispatched event, one task per target per pass", async () => {
  const pool = dispatchPool([taskRow(T1), taskRow(T2), taskRow(T3, { settings_agent: A })]);
  const delivered = [];
  const n = await new ProjectTasks(pool).dispatchDue(NOW, { deliver: async (u, s, from, text) => { delivered.push([s, text]); return "delivered"; }, notify: async () => { throw new Error("no notify expected"); } });
  assert.equal(n, 2); // T1 -> lead, T2 skipped (lead busy this pass), T3 -> A
  assert.deepEqual(delivered.map((d) => d[0]), [L, A]);
  assert.ok(delivered[0][1].includes(T1));
  assert.deepEqual(pool.log.filter((l) => l[0] === "claim").map((l) => l[1]), [T1, T3]);
  assert.equal(pool.log.filter((l) => l[0] === "event" && l[2] === "dispatched").length, 2);
});

test("dispatchDue never delivers a task another runtime already claimed", async () => {
  const pool = dispatchPool([taskRow(T1)], { claimFails: new Set([T1]) });
  let delivered = 0;
  assert.equal(await new ProjectTasks(pool).dispatchDue(NOW, { deliver: async () => { delivered++; return "delivered"; }, notify: async () => undefined }), 0);
  assert.equal(delivered, 0);
});

test("dispatchDue: failed delivery (e.g. provider not logged in) reverts to todo, records run_failed and notifies once", async () => {
  const pool = dispatchPool([taskRow(T1, { assignee_session_id: A })]);
  const notes = [];
  const n = await new ProjectTasks(pool).dispatchDue(NOW, {
    deliver: async () => { throw new HttpError(409, "provider_not_connected", "Claude Code is not connected for this account."); },
    notify: async (u, note) => { notes.push(note); },
  });
  assert.equal(n, 0);
  assert.deepEqual(pool.log.find((l) => l[0] === "revert"), ["revert", T1, A]); // back to todo with the original assignee
  assert.ok(pool.log.some((l) => l[0] === "event" && l[2] === "run_failed" && /not connected/.test(l[3])));
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /not started/i);
});

test("dispatchDue skips tasks in failure backoff and tasks with no run_at reached", async () => {
  const pool = dispatchPool([taskRow(T1, { recent_failure: true }), taskRow(T2, { run_at: new Date("2026-06-20T00:00:00Z") })]);
  assert.equal(await new ProjectTasks(pool).dispatchDue(NOW, { deliver: async () => { throw new Error("must not deliver"); }, notify: async () => undefined }), 0);
  assert.equal(pool.log.length, 0);
  assert.ok(DISPATCH_BACKOFF_MS >= 60_000);
});

test("dispatchDue with no available agent records the failure once and notifies", async () => {
  const pool = dispatchPool([taskRow(T1, { lead_id: null })]);
  const notes = [];
  await new ProjectTasks(pool).dispatchDue(NOW, { deliver: async () => "delivered", notify: async (u, n) => { notes.push(n); } });
  assert.equal(notes.length, 1);
  assert.ok(pool.log.some((l) => l[0] === "event" && l[2] === "run_failed"));
});

// ---- Automations.tickDue ----
const schedule = { kind: "recurring", freq: "daily", interval: 1, time: "09:00", timezone: "UTC", startDate: "2026-01-01" };
function autoPool(due, { autoAgent = false, failOnInsert = false } = {}) {
  const log = [];
  const client = {
    released: false,
    query: async (sql, params) => {
      const s = sql.trim();
      log.push(s.split(/\s+/).slice(0, 3).join(" "));
      if (/FROM automations WHERE enabled/.test(s)) { const d = due.shift(); return { rows: d ? [d] : [] }; }
      if (/UPDATE automations SET next_run_at = \$2 WHERE/.test(s)) { log.push("next:" + params[1]); return { rows: [] }; }
      if (/INSERT INTO project_tasks/.test(s)) { if (failOnInsert) throw new Error("boom"); log.push("task:" + params[3] + ":" + params[5]); return { rows: [] }; }
      if (/FROM project_task_settings/.test(s)) return { rows: [{ auto_agent: autoAgent }] };
      return { rows: [] };
    },
    release() { this.released = true; },
  };
  const pool = { log, client, connect: async () => client, query: async (sql, params) => { log.push("pool:" + sql.trim().split(/\s+/).slice(0, 3).join(" ") + ":" + (params?.[1] ?? "")); return { rows: [] }; } };
  return pool;
}
const autoRow = (over = {}) => ({ id: "b1111111-1111-4111-8111-111111111111", user_id: "u", project_id: P, title: "Monthly report", instructions: "do it", enabled: true, schedule, catch_up: "once", next_run_at: new Date("2026-06-19T09:00:00Z"), ...over });

test("tickDue advances next_run_at in the same transaction as the task insert (at most once per occurrence)", async () => {
  const pool = autoPool([autoRow()]);
  const notes = [];
  const n = await new Automations(pool, new ProjectTasks(pool)).tickDue(new Date("2026-06-19T09:00:20Z"), { notify: async (u, note) => { notes.push(note); } });
  assert.equal(n, 1);
  const log = pool.log;
  assert.ok(log.indexOf("BEGIN") < log.indexOf("next:2026-06-20T09:00:00.000Z") && log.indexOf("next:2026-06-20T09:00:00.000Z") < log.findIndex((l) => l.startsWith("task:")) && log.findIndex((l) => l.startsWith("task:")) < log.indexOf("COMMIT"), log.join(" | "));
  assert.ok(log.some((l) => l === "task:Monthly report - 2026-06-19:automation:b1111111-1111-4111-8111-111111111111"), log.join(" | "));
  assert.equal(notes.length, 1, "auto_agent off: the user is notified");
  assert.ok(pool.client.released);
});

test("tickDue with auto_agent ON creates the task without a notification (the dispatcher hands it out)", async () => {
  const pool = autoPool([autoRow()], { autoAgent: true });
  const notes = [];
  await new Automations(pool, new ProjectTasks(pool)).tickDue(new Date("2026-06-19T09:00:20Z"), { notify: async (u, n) => { notes.push(n); } });
  assert.equal(notes.length, 0);
});

test("tickDue catch_up=skip after downtime jumps to the next future run without creating a task", async () => {
  const pool = autoPool([autoRow({ catch_up: "skip" })]);
  const n = await new Automations(pool, new ProjectTasks(pool)).tickDue(new Date("2026-06-25T10:00:00Z"), { notify: async () => undefined });
  assert.equal(n, 0);
  assert.ok(pool.log.includes("next:2026-06-26T09:00:00.000Z"));
  assert.ok(!pool.log.some((l) => l.startsWith("task:")));
});

test("tickDue catch_up=once after downtime runs a single task and schedules the next future run", async () => {
  const pool = autoPool([autoRow({ catch_up: "once" })]);
  const n = await new Automations(pool, new ProjectTasks(pool)).tickDue(new Date("2026-06-25T10:00:00Z"), { notify: async () => undefined });
  assert.equal(n, 1);
  assert.ok(pool.log.includes("next:2026-06-26T09:00:00.000Z"));
  assert.ok(pool.log.some((l) => l.startsWith("task:Monthly report - 2026-06-25")), "dated by the catch-up day");
});

test("tickDue parks a broken automation instead of looping or stalling the others", async () => {
  const pool = autoPool([autoRow({ schedule: { kind: "recurring", freq: "daily", time: "bad", timezone: "UTC", startDate: "2026-01-01" } }), autoRow({ id: "b2222222-2222-4222-8222-222222222222" })]);
  const n = await new Automations(pool, new ProjectTasks(pool)).tickDue(new Date("2026-06-19T09:00:20Z"), { notify: async () => undefined });
  assert.equal(n, 1);
  assert.ok(pool.log.some((l) => l.startsWith("pool:UPDATE automations SET")), pool.log.join(" | "));
  assert.ok(pool.log.includes("ROLLBACK"));
});

// ---- scheduler ----
test("scheduler tick takes the advisory lock, runs both phases and releases; skips when the lock is held", async () => {
  const calls = [];
  let lock = true;
  const client = { query: async (sql) => { calls.push(/try_advisory_lock/.test(sql) ? "lock" : /advisory_unlock/.test(sql) ? "unlock" : sql); return { rows: [{ ok: lock }] }; }, release: () => calls.push("release") };
  const pool = { connect: async () => client };
  const automations = { tickDue: async () => { calls.push("automations"); return 2; } };
  const tasks = { dispatchDue: async () => { calls.push("dispatch"); return 3; } };
  const scheduler = new TaskScheduler(pool, automations, tasks, {});
  assert.deepEqual(await scheduler.tick(NOW), { automations: 2, dispatched: 3 });
  assert.deepEqual(calls, ["lock", "automations", "dispatch", "unlock", "release"]);
  calls.length = 0; lock = false;
  assert.equal(await scheduler.tick(NOW), null);
  assert.deepEqual(calls, ["lock", "release"]);
  assert.ok(Number.isSafeInteger(SCHEDULER_LOCK_KEY));
});

test("scheduler never overlaps ticks in one process and releases the lock when a phase throws", async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = { query: async (sql) => { calls.push(/try/.test(sql) ? "lock" : /advisory_unlock/.test(sql) ? "unlock" : "?"); return { rows: [{ ok: true }] }; }, release: () => undefined };
  const scheduler = new TaskScheduler({ connect: async () => client }, { tickDue: async () => { await gate; throw new Error("phase failed"); } }, { dispatchDue: async () => 0 }, {});
  const first = scheduler.tick(NOW);
  assert.equal(await scheduler.tick(NOW), null, "second tick while one runs is a no-op");
  release();
  await assert.rejects(first, /phase failed/);
  assert.deepEqual(calls, ["lock", "unlock"]);
  // the guard resets: a later tick runs again
  const again = new TaskScheduler({ connect: async () => client }, { tickDue: async () => 0 }, { dispatchDue: async () => 0 }, {});
  assert.deepEqual(await again.tick(NOW), { automations: 0, dispatched: 0 });
});
