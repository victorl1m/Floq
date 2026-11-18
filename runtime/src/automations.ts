import { randomUUID } from "node:crypto";
import type pg from "pg";
import { HttpError, notFound } from "./errors.js";
import { log } from "./logger.js";
import { isUuid, type ProjectTasks } from "./projectTasks.js";
import { localDateLabel, nextRun, planAutomationTick, ScheduleError, upcomingRuns, validateSchedule, type CatchUp, type Schedule } from "./scheduleMath.js";

/** Recurring/one-off "create a task for the project's agent" rules. The scheduler (taskScheduler.ts) calls tickDue(). */

export interface Automation {
  id: string; projectId: string; title: string; instructions: string; enabled: boolean; schedule: Schedule; catchUp: CatchUp;
  nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; runCount: number; createdAt: string; updatedAt: string; upcoming: string[];
}

type Row = {
  id: string; user_id: string; project_id: string; title: string; instructions: string; enabled: boolean; schedule: Schedule | string; catch_up: string;
  next_run_at: Date | null; last_run_at: Date | null; last_status: string | null; run_count: number; created_at: Date; updated_at: Date;
};
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const scheduleOf = (r: Row): Schedule => (typeof r.schedule === "string" ? JSON.parse(r.schedule) : r.schedule);

export function toAutomation(r: Row, now = new Date()): Automation {
  const schedule = scheduleOf(r);
  let upcoming: string[] = [];
  if (r.enabled) { try { upcoming = upcomingRuns(schedule, now, 5).map((d) => d.toISOString()); } catch { /* corrupt schedule: no preview */ } }
  return {
    id: r.id, projectId: r.project_id, title: r.title, instructions: r.instructions, enabled: r.enabled, schedule, catchUp: r.catch_up as CatchUp,
    nextRunAt: iso(r.next_run_at), lastRunAt: iso(r.last_run_at), lastStatus: r.last_status, runCount: r.run_count, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, upcoming,
  };
}

/** Schedule validation as a 400 whose details name the offending field. */
export function checkSchedule(raw: unknown, now: Date): Schedule {
  try {
    return validateSchedule(raw, now);
  } catch (error) {
    if (error instanceof ScheduleError) throw new HttpError(400, "invalid_schedule", error.message, { field: error.field });
    throw error;
  }
}

function cleanTitle(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "invalid_title", "title is required", { field: "title" });
  const t = v.replace(/\s+/g, " ").trim();
  if (t.length > 160) throw new HttpError(400, "invalid_title", "title must be 160 characters or fewer", { field: "title" });
  return t;
}
function cleanInstructions(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "invalid_instructions", "instructions must be text", { field: "instructions" });
  if (v.length > 20_000) throw new HttpError(400, "invalid_instructions", "instructions must be 20000 characters or fewer", { field: "instructions" });
  return v.trim();
}
function cleanCatchUp(v: unknown): CatchUp {
  if (v !== "skip" && v !== "once") throw new HttpError(400, "invalid_catch_up", "catchUp must be skip or once", { field: "catchUp" });
  return v;
}
function cleanEnabled(v: unknown): boolean {
  if (typeof v !== "boolean") throw new HttpError(400, "invalid_enabled", "enabled must be true or false", { field: "enabled" });
  return v;
}

export interface AutomationHooks {
  notify(userId: string, n: { title: string; body?: string; level: "info" | "success" | "warning" | "error"; projectId: string }): Promise<void>;
}

export class Automations {
  constructor(private readonly pool: pg.Pool, private readonly tasks: ProjectTasks) {}

  async list(userId: string, projectId?: string, now = new Date(), organizationId?: string | null): Promise<Automation[]> {
    if (projectId) await this.tasks.requireProject(userId, projectId);
    const r = await this.pool.query(
      `SELECT a.* FROM automations a JOIN floq_projects p ON p.id = a.project_id WHERE a.user_id = $1${projectId ? " AND a.project_id = $2" : organizationId ? " AND p.organization_id = $2" : ""} ORDER BY a.created_at`,
      projectId ? [userId, projectId] : organizationId ? [userId, organizationId] : [userId],
    );
    return (r.rows as Row[]).map((row) => toAutomation(row, now));
  }

  private async row(userId: string, projectId: string, id: string): Promise<Row> {
    if (!isUuid(id)) throw notFound("Automation not found");
    const r = await this.pool.query("SELECT * FROM automations WHERE id = $1 AND project_id = $2 AND user_id = $3", [id, projectId, userId]);
    if (!r.rows[0]) throw notFound("Automation not found");
    return r.rows[0] as Row;
  }

  preview(rawSchedule: unknown, now = new Date()): { upcoming: string[] } {
    const schedule = checkSchedule(rawSchedule, now);
    return { upcoming: upcomingRuns(schedule, now, 5).map((d) => d.toISOString()) };
  }

  async create(userId: string, projectId: string, body: Record<string, unknown>, now = new Date()): Promise<Automation> {
    await this.tasks.requireProject(userId, projectId);
    const title = cleanTitle(body.title);
    const instructions = cleanInstructions(body.instructions ?? "");
    const enabled = body.enabled === undefined ? true : cleanEnabled(body.enabled);
    const schedule = checkSchedule(body.schedule, now);
    const catchUp = body.catchUp === undefined ? "once" : cleanCatchUp(body.catchUp);
    const next = enabled ? nextRun(schedule, now) : null;
    const r = await this.pool.query(
      "INSERT INTO automations (id, user_id, project_id, title, instructions, enabled, schedule, catch_up, next_run_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *",
      [randomUUID(), userId, projectId, title, instructions, enabled, JSON.stringify(schedule), catchUp, next?.toISOString() ?? null],
    );
    this.tasks.emitChanged(userId, projectId);
    return toAutomation(r.rows[0] as Row, now);
  }

  async update(userId: string, projectId: string, id: string, body: Record<string, unknown>, now = new Date()): Promise<Automation> {
    const before = await this.row(userId, projectId, id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown, cast = "") => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
    let schedule = scheduleOf(before);
    let enabled = before.enabled;
    if (body.title !== undefined) set("title", cleanTitle(body.title));
    if (body.instructions !== undefined) set("instructions", cleanInstructions(body.instructions));
    if (body.catchUp !== undefined) set("catch_up", cleanCatchUp(body.catchUp));
    let reschedule = false;
    if (body.schedule !== undefined) { schedule = checkSchedule(body.schedule, now); set("schedule", JSON.stringify(schedule), "::jsonb"); reschedule = true; }
    if (body.enabled !== undefined) { const next = cleanEnabled(body.enabled); if (next !== enabled) reschedule = true; enabled = next; set("enabled", enabled); }
    // Changing the schedule or re-enabling recomputes the next occurrence from now (a pause never queues up runs).
    if (reschedule) set("next_run_at", enabled ? (nextRun(schedule, now)?.toISOString() ?? null) : null);
    if (sets.length) {
      params.push(id);
      await this.pool.query(`UPDATE automations SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
      this.tasks.emitChanged(userId, projectId);
    }
    return toAutomation(await this.row(userId, projectId, id), now);
  }

  async remove(userId: string, projectId: string, id: string): Promise<void> {
    await this.row(userId, projectId, id);
    await this.pool.query("DELETE FROM automations WHERE id = $1", [id]);
    this.tasks.emitChanged(userId, projectId);
  }

  /** "Run now": creates the task immediately; the schedule (next_run_at) is untouched. */
  async runNow(userId: string, projectId: string, id: string, now = new Date()): Promise<{ task: Awaited<ReturnType<ProjectTasks["get"]>> }> {
    const row = await this.row(userId, projectId, id);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const taskId = await this.fire(client, row, now, "manual");
      await client.query("COMMIT");
      this.tasks.emitChanged(userId, projectId);
      return { task: await this.tasks.get(userId, projectId, taskId) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Inserts the occurrence's task (+ created event) and counts the run, inside the caller's transaction. */
  private async fire(client: pg.PoolClient, row: Row, now: Date, status: string, labelAt = now): Promise<string> {
    const schedule = scheduleOf(row);
    const tz = schedule.kind === "recurring" ? schedule.timezone : "UTC";
    const title = `${row.title} - ${localDateLabel(labelAt, tz)}`.slice(0, 200);
    const id = randomUUID();
    const created = "automation:" + row.id;
    await client.query(
      "INSERT INTO project_tasks (id, user_id, project_id, title, description, created_by, automation_id, position) VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(position), 0) + 1 FROM project_tasks WHERE project_id = $3))",
      [id, row.user_id, row.project_id, title, row.instructions, created, row.id],
    );
    await client.query("INSERT INTO task_events (task_id, actor, kind, text) VALUES ($1,$2,'created',$3)", [id, created, title]);
    await client.query("UPDATE automations SET last_run_at = $2, last_status = $3, run_count = run_count + 1, updated_at = now() WHERE id = $1", [row.id, now.toISOString(), status]);
    return id;
  }

  /**
   * One scheduler pass. Each due automation is handled in its own transaction under FOR UPDATE SKIP LOCKED: next_run_at
   * is advanced and the task inserted atomically, so an occurrence runs at most once even with several runtimes or a
   * crash in between. Dispatching the new task to an agent is the task dispatcher's job (after this commits).
   */
  async tickDue(now: Date, hooks: AutomationHooks, limit = 50): Promise<number> {
    let created = 0;
    for (let i = 0; i < limit; i++) {
      const client = await this.pool.connect();
      let notice: { userId: string; projectId: string; title: string; notify: boolean } | null = null;
      try {
        await client.query("BEGIN");
        const due = (await client.query("SELECT * FROM automations WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED", [now.toISOString()])).rows[0] as Row | undefined;
        if (!due) { await client.query("ROLLBACK"); break; }
        try {
          const schedule = scheduleOf(due);
          const plan = planAutomationTick({ enabled: due.enabled, schedule, nextRunAt: due.next_run_at, catchUp: due.catch_up as CatchUp, now });
          if (plan.action === "wait") {
            await client.query("ROLLBACK");
            break; // cannot happen (the query selected a due row); never loop on it
          }
          await client.query("UPDATE automations SET next_run_at = $2 WHERE id = $1", [due.id, plan.nextRunAt?.toISOString() ?? null]);
          if (plan.action === "skip") {
            await client.query("UPDATE automations SET last_status = 'skipped', updated_at = now() WHERE id = $1", [due.id]);
          } else {
            await this.fire(client, due, now, plan.missed ? "caught_up" : "ok", plan.missed ? now : due.next_run_at!);
            created++;
            const auto = await client.query("SELECT auto_agent FROM project_task_settings WHERE project_id = $1", [due.project_id]);
            notice = { userId: due.user_id, projectId: due.project_id, title: due.title, notify: !auto.rows[0]?.auto_agent };
          }
          await client.query("COMMIT");
        } catch (error) {
          // A broken row (corrupt schedule) must not stall the others: park it with an error status.
          await client.query("ROLLBACK").catch(() => undefined);
          log.warn("automation.tick_failed", { automationId: due.id, error: String(error).slice(0, 160) });
          await this.pool.query("UPDATE automations SET next_run_at = NULL, last_status = $2, updated_at = now() WHERE id = $1", [due.id, ("error: " + (error instanceof Error ? error.message : String(error))).slice(0, 200)]);
        }
      } finally {
        client.release();
      }
      if (notice) {
        this.tasks.emitChanged(notice.userId, notice.projectId);
        if (notice.notify) await hooks.notify(notice.userId, { title: "Automation created a task: " + notice.title.slice(0, 80), body: "Agents are not set to work on tasks automatically in this project, so it is waiting in the to-do list.", level: "info", projectId: notice.projectId }).catch(() => undefined);
      }
    }
    return created;
  }
}
