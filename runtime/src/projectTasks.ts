import { randomUUID } from "node:crypto";
import type pg from "pg";
import { badRequest, conflict, notFound } from "./errors.js";
import { log } from "./logger.js";

/**
 * Per-project task list (the user's to-do list that agents can work on). Raw pg like the other new tables; the
 * organization boards in tasks.ts are unrelated and untouched.
 */

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TASK_EVENT_KINDS = ["created", "status", "update", "comment", "dispatched", "run_failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

export interface Task {
  id: string; projectId: string; title: string; description: string; status: TaskStatus; priority: TaskPriority;
  assigneeSessionId: string | null; createdBy: string; dueAt: string | null; runAt: string | null; automationId: string | null;
  position: number; createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface TaskEvent { id: number; taskId: string; at: string; actor: string; kind: TaskEventKind; text: string }
export interface TaskSettings { autoAgent: boolean; agentSessionId: string | null }
export type TasksChangedFrame = { type: "tasks.changed"; projectId: string };

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
const COMMENT_MAX = 4_000;
/** After a failed dispatch the task is left alone this long (no retry storm, one notification). */
export const DISPATCH_BACKOFF_MS = 15 * 60_000;
const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

type Row = {
  id: string; project_id: string; title: string; description: string; status: string; priority: string; assignee_session_id: string | null;
  created_by: string; due_at: Date | null; run_at: Date | null; automation_id: string | null; position: number; created_at: Date; updated_at: Date; completed_at: Date | null;
};
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
export const toTask = (r: Row): Task => ({
  id: r.id, projectId: r.project_id, title: r.title, description: r.description, status: r.status as TaskStatus, priority: r.priority as TaskPriority,
  assigneeSessionId: r.assignee_session_id, createdBy: r.created_by, dueAt: iso(r.due_at), runAt: iso(r.run_at), automationId: r.automation_id,
  position: Number(r.position), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, completedAt: iso(r.completed_at),
});

// ---------- validation (pure) ----------

function cleanTitle(v: unknown): string {
  if (typeof v !== "string") throw badRequest("title must be text", "invalid_title");
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) throw badRequest("title is required", "invalid_title");
  if (t.length > TITLE_MAX) throw badRequest(`title must be ${TITLE_MAX} characters or fewer`, "invalid_title");
  return t;
}
function cleanDescription(v: unknown): string {
  if (typeof v !== "string") throw badRequest("description must be text", "invalid_description");
  if (v.length > DESCRIPTION_MAX) throw badRequest(`description must be ${DESCRIPTION_MAX} characters or fewer`, "invalid_description");
  return v.trim();
}
export function cleanComment(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw badRequest("text is required", "invalid_text");
  if (v.length > COMMENT_MAX) throw badRequest(`text must be ${COMMENT_MAX} characters or fewer`, "invalid_text");
  return v.trim();
}
function cleanStatus(v: unknown): TaskStatus {
  if (!TASK_STATUSES.includes(v as TaskStatus)) throw badRequest(`status must be one of ${TASK_STATUSES.join(", ")}`, "invalid_status");
  return v as TaskStatus;
}
function cleanPriority(v: unknown): TaskPriority {
  if (!TASK_PRIORITIES.includes(v as TaskPriority)) throw badRequest(`priority must be one of ${TASK_PRIORITIES.join(", ")}`, "invalid_priority");
  return v as TaskPriority;
}
/** ISO date-time or null (clears). */
function cleanDate(v: unknown, field: string): string | null {
  if (v === null || v === "") return null;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw badRequest(`${field} must be an ISO date-time or null`, "invalid_" + field);
  return new Date(t).toISOString();
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export interface TaskInput {
  title?: unknown; description?: unknown; status?: unknown; priority?: unknown; dueAt?: unknown; runAt?: unknown; assigneeSessionId?: unknown; position?: unknown;
}
export interface CleanTaskInput {
  title?: string; description?: string; status?: TaskStatus; priority?: TaskPriority; dueAt?: string | null; runAt?: string | null; assigneeSessionId?: string | null; position?: number;
}
/** Validates the user/agent-supplied fields that are present; absent keys stay absent. */
export function cleanTaskInput(input: TaskInput): CleanTaskInput {
  const out: CleanTaskInput = {};
  if (input.title !== undefined) out.title = cleanTitle(input.title);
  if (input.description !== undefined) out.description = cleanDescription(input.description);
  if (input.status !== undefined) out.status = cleanStatus(input.status);
  if (input.priority !== undefined) out.priority = cleanPriority(input.priority);
  if (input.dueAt !== undefined) out.dueAt = cleanDate(input.dueAt, "dueAt");
  if (input.runAt !== undefined) out.runAt = cleanDate(input.runAt, "runAt");
  if (input.assigneeSessionId !== undefined) {
    if (input.assigneeSessionId !== null && input.assigneeSessionId !== "" && !isUuid(input.assigneeSessionId)) throw badRequest("assigneeSessionId must be an agent UUID or null", "invalid_assignee");
    out.assigneeSessionId = input.assigneeSessionId ? (input.assigneeSessionId as string) : null;
  }
  if (input.position !== undefined) {
    if (typeof input.position !== "number" || !Number.isFinite(input.position)) throw badRequest("position must be a number", "invalid_position");
    out.position = input.position;
  }
  return out;
}

// ---------- dispatch decision (pure) ----------

export type DispatchDecision =
  | { action: "dispatch"; targetSessionId: string }
  | { action: "wait"; reason: "auto_off" | "not_todo" | "scheduled" | "backoff" | "no_target" };

/** Whether a task goes to an agent now. Only `todo` tasks of projects with the switch ON, at/after run_at, once. */
export function decideDispatch(input: {
  status: TaskStatus; runAt: Date | null; autoAgent: boolean; now: Date; assigneeSessionId: string | null; settingsAgentSessionId: string | null; leadSessionId: string | null; recentFailure: boolean;
}): DispatchDecision {
  if (!input.autoAgent) return { action: "wait", reason: "auto_off" };
  if (input.status !== "todo") return { action: "wait", reason: "not_todo" };
  if (input.runAt && input.runAt.getTime() > input.now.getTime()) return { action: "wait", reason: "scheduled" };
  if (input.recentFailure) return { action: "wait", reason: "backoff" };
  const target = input.assigneeSessionId ?? input.settingsAgentSessionId ?? input.leadSessionId;
  if (!target) return { action: "wait", reason: "no_target" };
  return { action: "dispatch", targetSessionId: target };
}

/** The message typed into the agent's terminal (one logical message; long text is moved to its inbox by the delivery layer). */
export function buildDispatchText(task: Pick<Task, "id" | "title" | "description" | "priority" | "dueAt" | "createdBy">): string {
  const parts = [
    `Task ${task.id}: ${task.title}`,
    task.description ? `Details: ${task.description}` : "",
    `Priority: ${task.priority}.${task.dueAt ? " Due: " + task.dueAt + "." : ""}`,
    `Status is already in_progress. Report with the Floq CLI: floq task update ${task.id} --comment "progress"; if you cannot continue: floq task update ${task.id} --status blocked --comment "why"; when finished: floq task done ${task.id} --comment "summary of what you did". No reply message is needed.`,
  ];
  return parts.filter(Boolean).join(" ");
}

// ---------- service ----------

export interface TaskActor { actor: string; sessionId?: string }
export interface DispatchDeps {
  deliver(userId: string, sessionId: string, from: { id: string; title: string }, text: string): Promise<"delivered" | "queued">;
  notify(userId: string, n: { title: string; body?: string; level: "info" | "success" | "warning" | "error"; projectId: string }): Promise<void>;
}

export class ProjectTasks {
  private readonly subs = new Set<{ userId: string; fn: (f: TasksChangedFrame) => void }>();
  constructor(private readonly pool: pg.Pool) {}

  /** Live updates: 'tasks.changed' frames for one user (the websocket forwards them; the app refetches). */
  subscribe(userId: string, fn: (frame: TasksChangedFrame) => void): () => void {
    const sub = { userId, fn };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }
  emitChanged(userId: string, projectId: string): void {
    for (const s of this.subs) if (s.userId === userId) { try { s.fn({ type: "tasks.changed", projectId }); } catch { /* a broken subscriber never affects the writer */ } }
  }

  async requireProject(userId: string, projectId: string): Promise<void> {
    if (!isUuid(projectId)) throw notFound("Project not found");
    const r = await this.pool.query("SELECT 1 FROM floq_projects WHERE id = $1 AND user_id = $2", [projectId, userId]);
    if (!r.rows[0]) throw notFound("Project not found");
  }

  /** The project an agent session belongs to (agents only see their own project's tasks). */
  async agentContext(userId: string, sessionId: string): Promise<{ projectId: string; actor: string; sessionId: string }> {
    const r = await this.pool.query("SELECT project_id FROM agent_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
    if (!r.rows[0]) throw notFound("Calling session not found");
    if (!r.rows[0].project_id) throw conflict("This agent is not in a project, so it has no task list", "no_project");
    return { projectId: r.rows[0].project_id as string, actor: "agent:" + sessionId, sessionId };
  }

  private async checkAssignee(userId: string, projectId: string, sessionId: string): Promise<void> {
    const r = await this.pool.query("SELECT 1 FROM agent_sessions WHERE id = $1 AND user_id = $2 AND project_id = $3 AND archived_at IS NULL AND provider <> 'shell'", [sessionId, userId, projectId]);
    if (!r.rows[0]) throw badRequest("assigneeSessionId must be an agent of this project", "invalid_assignee");
  }

  async addEvent(taskId: string, actor: string, kind: TaskEventKind, text: string): Promise<void> {
    await this.pool.query("INSERT INTO task_events (task_id, actor, kind, text) VALUES ($1,$2,$3,$4)", [taskId, actor, kind, text.slice(0, 8000)]);
  }

  async list(userId: string, opts: { projectId?: string; status?: string; assigneeSessionId?: string } = {}): Promise<{ tasks: Task[]; settings: Record<string, TaskSettings> }> {
    const where = ["p.user_id = $1"];
    const params: unknown[] = [userId];
    if (opts.projectId) { await this.requireProject(userId, opts.projectId); params.push(opts.projectId); where.push(`t.project_id = $${params.length}`); }
    if (opts.status) {
      const statuses = opts.status.split(",").map((s) => cleanStatus(s.trim()));
      params.push(statuses); where.push(`t.status = ANY($${params.length}::text[])`);
    }
    if (opts.assigneeSessionId) { params.push(opts.assigneeSessionId); where.push(`t.assignee_session_id = $${params.length}`); }
    const rows = (await this.pool.query(`SELECT t.* FROM project_tasks t JOIN floq_projects p ON p.id = t.project_id WHERE ${where.join(" AND ")} ORDER BY t.position, t.created_at LIMIT 5000`, params)).rows as Row[];
    const sets = (await this.pool.query(`SELECT s.project_id, s.auto_agent, s.agent_session_id FROM project_task_settings s JOIN floq_projects p ON p.id = s.project_id WHERE p.user_id = $1${opts.projectId ? " AND s.project_id = $2" : ""}`, opts.projectId ? [userId, opts.projectId] : [userId])).rows;
    const settings: Record<string, TaskSettings> = {};
    for (const s of sets) settings[s.project_id as string] = { autoAgent: Boolean(s.auto_agent), agentSessionId: (s.agent_session_id as string | null) ?? null };
    return { tasks: rows.map(toTask), settings };
  }

  async get(userId: string, projectId: string, taskId: string): Promise<Task> {
    if (!isUuid(taskId)) throw notFound("Task not found");
    const r = await this.pool.query("SELECT t.* FROM project_tasks t JOIN floq_projects p ON p.id = t.project_id WHERE t.id = $1 AND t.project_id = $2 AND p.user_id = $3", [taskId, projectId, userId]);
    if (!r.rows[0]) throw notFound("Task not found");
    return toTask(r.rows[0] as Row);
  }

  async create(userId: string, projectId: string, input: TaskInput, who: TaskActor = { actor: "user" }, extra: { automationId?: string; status?: TaskStatus } = {}): Promise<Task> {
    await this.requireProject(userId, projectId);
    if (input.title === undefined) throw badRequest("title is required", "invalid_title");
    const c = cleanTaskInput({ ...input, status: extra.status ?? input.status });
    if (c.assigneeSessionId) await this.checkAssignee(userId, projectId, c.assigneeSessionId);
    const status = c.status ?? "todo";
    const id = randomUUID();
    const r = await this.pool.query(
      `INSERT INTO project_tasks (id, user_id, project_id, title, description, status, priority, assignee_session_id, created_by, due_at, run_at, automation_id, position, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13::float8, (SELECT COALESCE(MAX(position), 0) + 1 FROM project_tasks WHERE project_id = $3)), $14) RETURNING *`,
      [id, userId, projectId, c.title, c.description ?? "", status, c.priority ?? "normal", c.assigneeSessionId ?? null, who.actor, c.dueAt ?? null, c.runAt ?? null, extra.automationId ?? null, c.position ?? null, status === "done" || status === "cancelled" ? new Date().toISOString() : null],
    );
    await this.addEvent(id, who.actor, "created", c.title!);
    this.emitChanged(userId, projectId);
    return toTask(r.rows[0] as Row);
  }

  async update(userId: string, projectId: string, taskId: string, input: TaskInput & { comment?: unknown }, who: TaskActor = { actor: "user" }): Promise<Task> {
    const before = await this.get(userId, projectId, taskId);
    const c = cleanTaskInput(input);
    const comment = input.comment !== undefined && input.comment !== null && input.comment !== "" ? cleanComment(input.comment) : null;
    if (c.assigneeSessionId) await this.checkAssignee(userId, projectId, c.assigneeSessionId);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    const changed: string[] = [];
    if (c.title !== undefined && c.title !== before.title) { set("title", c.title); changed.push("title"); }
    if (c.description !== undefined && c.description !== before.description) { set("description", c.description); changed.push("description"); }
    if (c.priority !== undefined && c.priority !== before.priority) { set("priority", c.priority); changed.push("priority → " + c.priority); }
    if (c.dueAt !== undefined && c.dueAt !== before.dueAt) { set("due_at", c.dueAt); changed.push("due date"); }
    if (c.runAt !== undefined && c.runAt !== before.runAt) { set("run_at", c.runAt); changed.push("run at"); }
    if (c.assigneeSessionId !== undefined && c.assigneeSessionId !== before.assigneeSessionId) { set("assignee_session_id", c.assigneeSessionId); changed.push("assignee"); }
    if (c.position !== undefined && c.position !== before.position) set("position", c.position);
    const statusChanged = c.status !== undefined && c.status !== before.status;
    if (statusChanged) {
      set("status", c.status);
      set("completed_at", c.status === "done" || c.status === "cancelled" ? new Date().toISOString() : null);
    }
    if (sets.length) {
      params.push(taskId);
      await this.pool.query(`UPDATE project_tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
    }
    if (statusChanged) await this.addEvent(taskId, who.actor, "status", `${before.status} → ${c.status}${comment ? ": " + comment : ""}`);
    else if (comment) await this.addEvent(taskId, who.actor, "comment", comment);
    if (changed.length) await this.addEvent(taskId, who.actor, "update", "changed " + changed.join(", "));
    if (sets.length || comment) this.emitChanged(userId, projectId);
    return this.get(userId, projectId, taskId);
  }

  async remove(userId: string, projectId: string, taskId: string): Promise<void> {
    await this.get(userId, projectId, taskId);
    await this.pool.query("DELETE FROM project_tasks WHERE id = $1", [taskId]);
    this.emitChanged(userId, projectId);
  }

  async events(userId: string, projectId: string, taskId: string): Promise<TaskEvent[]> {
    await this.get(userId, projectId, taskId);
    const r = await this.pool.query("SELECT id, task_id, at, actor, kind, text FROM task_events WHERE task_id = $1 ORDER BY id LIMIT 500", [taskId]);
    return r.rows.map((e) => ({ id: Number(e.id), taskId: e.task_id as string, at: iso(e.at)!, actor: e.actor as string, kind: e.kind as TaskEventKind, text: e.text as string }));
  }

  async comment(userId: string, projectId: string, taskId: string, text: unknown, who: TaskActor = { actor: "user" }): Promise<TaskEvent[]> {
    await this.get(userId, projectId, taskId);
    await this.addEvent(taskId, who.actor, "comment", cleanComment(text));
    await this.pool.query("UPDATE project_tasks SET updated_at = now() WHERE id = $1", [taskId]);
    this.emitChanged(userId, projectId);
    return this.events(userId, projectId, taskId);
  }

  async getSettings(userId: string, projectId: string): Promise<TaskSettings> {
    await this.requireProject(userId, projectId);
    const r = await this.pool.query("SELECT auto_agent, agent_session_id FROM project_task_settings WHERE project_id = $1", [projectId]);
    return r.rows[0] ? { autoAgent: Boolean(r.rows[0].auto_agent), agentSessionId: (r.rows[0].agent_session_id as string | null) ?? null } : { autoAgent: false, agentSessionId: null };
  }

  async putSettings(userId: string, projectId: string, input: { autoAgent?: unknown; agentSessionId?: unknown }): Promise<TaskSettings> {
    await this.requireProject(userId, projectId);
    if (typeof input.autoAgent !== "boolean") throw badRequest("autoAgent must be true or false", "invalid_auto_agent");
    let agent: string | null = null;
    if (input.agentSessionId !== undefined && input.agentSessionId !== null && input.agentSessionId !== "") {
      if (!isUuid(input.agentSessionId)) throw badRequest("agentSessionId must be an agent UUID or null", "invalid_assignee");
      await this.checkAssignee(userId, projectId, input.agentSessionId);
      agent = input.agentSessionId;
    }
    await this.pool.query(
      "INSERT INTO project_task_settings (project_id, auto_agent, agent_session_id) VALUES ($1,$2,$3) ON CONFLICT (project_id) DO UPDATE SET auto_agent = EXCLUDED.auto_agent, agent_session_id = EXCLUDED.agent_session_id, updated_at = now()",
      [projectId, input.autoAgent, agent],
    );
    this.emitChanged(userId, projectId);
    return { autoAgent: input.autoAgent, agentSessionId: agent };
  }

  // ---------- dispatch ----------

  /**
   * Hands due `todo` tasks of auto-agent projects to their agent. Each task is CLAIMED atomically first
   * (todo -> in_progress with a guard), so overlapping ticks or several runtimes never dispatch it twice. A failed
   * delivery puts the task back to todo, records a run_failed event (backoff) and notifies the user once.
   * At most one task per target agent per call. Returns how many were dispatched.
   */
  async dispatchDue(now: Date, deps: DispatchDeps, limit = 25): Promise<number> {
    const rows = (await this.pool.query(
      `SELECT t.*, s.agent_session_id AS settings_agent,
              (SELECT a.id FROM agent_sessions a WHERE a.user_id = t.user_id AND a.project_id = t.project_id AND a.lead AND a.archived_at IS NULL AND a.provider <> 'shell' ORDER BY a.created_at LIMIT 1) AS lead_id,
              EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.kind = 'run_failed' AND e.at > $2::timestamptz - ($3 || ' milliseconds')::interval) AS recent_failure
         FROM project_tasks t JOIN project_task_settings s ON s.project_id = t.project_id AND s.auto_agent
        WHERE t.status = 'todo' AND (t.run_at IS NULL OR t.run_at <= $2::timestamptz)
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.position, t.created_at LIMIT $1`,
      [limit, now.toISOString(), String(DISPATCH_BACKOFF_MS)],
    )).rows as Array<Row & { user_id: string; settings_agent: string | null; lead_id: string | null; recent_failure: boolean }>;
    const used = new Set<string>();
    let dispatched = 0;
    for (const row of rows) {
      const decision = decideDispatch({ status: row.status as TaskStatus, runAt: row.run_at, autoAgent: true, now, assigneeSessionId: row.assignee_session_id, settingsAgentSessionId: row.settings_agent, leadSessionId: row.lead_id, recentFailure: row.recent_failure });
      if (decision.action !== "dispatch") {
        if (decision.reason === "no_target") await this.recordFailure(row.user_id, toTask(row), "No agent is available for this project's tasks (create an orchestrator or pick an agent in the task settings).", deps);
        continue;
      }
      if (used.has(decision.targetSessionId)) continue;
      const claimed = await this.pool.query("UPDATE project_tasks SET status = 'in_progress', assignee_session_id = $2, updated_at = now() WHERE id = $1 AND status = 'todo' RETURNING *", [row.id, decision.targetSessionId]);
      if (!claimed.rows[0]) continue; // someone else claimed it
      used.add(decision.targetSessionId);
      const task = toTask(claimed.rows[0] as Row);
      try {
        const how = await deps.deliver(row.user_id, decision.targetSessionId, { id: row.id, title: "Floq tasks" }, buildDispatchText(task));
        await this.addEvent(task.id, "system", "dispatched", `sent to agent ${decision.targetSessionId}${how === "queued" ? " (queued until it is ready)" : ""}`);
        dispatched++;
        this.emitChanged(row.user_id, task.projectId);
      } catch (error) {
        await this.pool.query("UPDATE project_tasks SET status = 'todo', assignee_session_id = $2, updated_at = now() WHERE id = $1 AND status = 'in_progress'", [row.id, row.assignee_session_id]);
        const message = error instanceof Error ? error.message : String(error);
        log.warn("task.dispatch_failed", { taskId: row.id, error: message.slice(0, 160) });
        await this.recordFailure(row.user_id, task, message, deps);
      }
    }
    return dispatched;
  }

  private async recordFailure(userId: string, task: Task, message: string, deps: DispatchDeps): Promise<void> {
    await this.addEvent(task.id, "system", "run_failed", message);
    this.emitChanged(userId, task.projectId);
    await deps.notify(userId, { title: "Task not started: " + task.title.slice(0, 80), body: message.slice(0, 500), level: "warning", projectId: task.projectId }).catch(() => undefined);
  }
}
