// Pure model for the per-project task list and automations (types, schedule form <-> API schedule, validation, copy).
// No imports from the app so it runs under `node --experimental-strip-types --test` (see e2e/project-tasks.unit.mts).

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export const BOARD_STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done", cancelled: "Cancelled" };
export const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export interface ProjectTask {
  id: string; projectId: string; title: string; description: string; status: TaskStatus; priority: TaskPriority;
  assigneeSessionId: string | null; createdBy: string; dueAt: string | null; runAt: string | null; automationId: string | null;
  position: number; createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface ProjectTaskEvent { id: number; taskId: string; at: string; actor: string; kind: "created" | "status" | "update" | "comment" | "dispatched" | "run_failed"; text: string }
export interface ProjectTaskSettings { autoAgent: boolean; agentSessionId: string | null }

export type RecurringFreq = "daily" | "weekly" | "monthly" | "yearly";
export type OnceSchedule = { kind: "once"; at: string };
export type RecurringSchedule = {
  kind: "recurring"; freq: RecurringFreq; interval: number; weekdays?: number[]; monthDay?: number;
  time: string; timezone: string; startDate: string; endDate?: string; count?: number;
};
export type Schedule = OnceSchedule | RecurringSchedule;
export type CatchUp = "skip" | "once";
export interface ProjectAutomation {
  id: string; projectId: string; title: string; instructions: string; enabled: boolean; schedule: Schedule; catchUp: CatchUp;
  nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; runCount: number; createdAt: string; updatedAt: string; upcoming: string[];
}

// ---------- tasks ----------

export type TaskOrigin = { kind: "user" } | { kind: "agent"; sessionId: string } | { kind: "automation"; automationId: string };
export function taskOrigin(createdBy: string): TaskOrigin {
  if (createdBy.startsWith("agent:")) return { kind: "agent", sessionId: createdBy.slice(6) };
  if (createdBy.startsWith("automation:")) return { kind: "automation", automationId: createdBy.slice(11) };
  return { kind: "user" };
}
/** Event actor: "user" | "system" | "agent:<id>". */
export function actorSession(actor: string): string | null { return actor.startsWith("agent:") ? actor.slice(6) : null; }

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
export function sortTasks(tasks: readonly ProjectTask[]): ProjectTask[] {
  return [...tasks].sort((a, b) => a.position - b.position || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
}
export function groupByStatus(tasks: readonly ProjectTask[]): Record<(typeof BOARD_STATUSES)[number], ProjectTask[]> {
  const out = { todo: [], in_progress: [], blocked: [], done: [] } as Record<(typeof BOARD_STATUSES)[number], ProjectTask[]>;
  for (const task of sortTasks(tasks)) if (task.status in out) out[task.status as keyof typeof out].push(task);
  return out;
}
/** Position for a card dropped at `index` among `column` (which must not contain the moved task). Float midpoint like the other boards. */
export function dropPosition(column: readonly Pick<ProjectTask, "position">[], index: number): number {
  const before = column[index - 1]?.position;
  const after = column[index]?.position;
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}
export function isOverdue(task: Pick<ProjectTask, "dueAt" | "status">, now = Date.now()): boolean {
  return !!task.dueAt && task.status !== "done" && task.status !== "cancelled" && Date.parse(task.dueAt) < now;
}

// ---------- date helpers ----------

const pad = (n: number) => String(n).padStart(2, "0");
/** ISO instant -> value of <input type="datetime-local"> in the viewer's time zone ("" when empty/invalid). */
export function toLocalInput(iso: string | null | undefined): string {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
/** datetime-local value (viewer's zone) -> ISO instant, or null when empty/invalid. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}
export function formatWhen(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(iso));
}
export function formatDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(iso));
}
/** Copy under the "Run on" trigger. */
export function runOnCopy(runAt: string | null, now = Date.now(), timeZone?: string): string {
  if (!runAt) return "No trigger: with “Agents work on tasks” on, agents pick this up as soon as it is To do.";
  const label = formatWhen(runAt, timeZone);
  return Date.parse(runAt) > now
    ? `Agents start this only on ${label.replace(",", ",")}. Until then it waits in To do.`
    : `The trigger time (${label}) has passed: agents can start this now.`;
}

export function ordinalDay(day: number): string { return String(day); }

/** Short relative time for list rows: "in 5 min", "in 3 hours", "tomorrow", "in 4 days", "2 days ago". */
export function relativeWhen(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  if (!Number.isFinite(diff)) return "";
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60_000) return diff >= 0 ? "in under a minute" : "just now";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute").replace("minutes", "min").replace("minute", "min");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 30 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), "day");
  if (abs < 365 * 86_400_000) return rtf.format(Math.round(diff / (30 * 86_400_000)), "month");
  return rtf.format(Math.round(diff / (365 * 86_400_000)), "year");
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_NAMES = WEEKDAYS;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ymdLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : ymd;
}

/** "Every month on day 19 at 09:00 (America/Sao_Paulo)". `timeZone` only affects one-off schedules (default: the viewer's). */
export function describeSchedule(schedule: Schedule, timeZone?: string): string {
  if (schedule.kind === "once") {
    const d = new Date(schedule.at);
    const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(d);
    const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(d);
    return `Once on ${date} at ${time}`;
  }
  const n = schedule.interval;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[schedule.freq];
  let text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  const start = /^(\d{4})-(\d{2})-(\d{2})$/.exec(schedule.startDate);
  if (schedule.freq === "weekly") {
    const days = schedule.weekdays?.length ? schedule.weekdays : start ? [new Date(Date.UTC(+start[1], +start[2] - 1, +start[3])).getUTCDay()] : [];
    if (days.length) text += ` on ${days.map((d) => WEEKDAYS[d]).join(", ")}`;
  } else if (schedule.freq === "monthly") {
    const day = schedule.monthDay ?? (start ? Number(start[3]) : undefined);
    if (day === 31) text += " on the last day";
    else if (day) text += ` on day ${day}`;
  } else if (schedule.freq === "yearly" && start) {
    text += ` on ${MONTHS[Number(start[2]) - 1]} ${Number(start[3])}`;
  }
  text += ` at ${schedule.time} (${schedule.timezone})`;
  if (schedule.startDate) text += `, from ${ymdLabel(schedule.startDate)}`;
  if (schedule.endDate) text += `, until ${ymdLabel(schedule.endDate)}`;
  if (schedule.count) text += `, ${schedule.count} ${schedule.count === 1 ? "time" : "times"} in total`;
  return text;
}

// ---------- schedule form ----------

export interface ScheduleForm {
  mode: "once" | "repeat";
  onceAt: string; // datetime-local
  freq: RecurringFreq;
  interval: string;
  weekdays: number[];
  monthDay: string;
  time: string;
  timezone: string;
  startDate: string; // YYYY-MM-DD
  endMode: "never" | "date" | "count";
  endDate: string;
  count: string;
}

export function todayYmd(now = new Date()): string { return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; }
export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export function defaultScheduleForm(now = new Date(), timezone = browserTimezone()): ScheduleForm {
  const nextHour = new Date(now.getTime() + 3_600_000);
  nextHour.setMinutes(0, 0, 0);
  return {
    mode: "repeat", onceAt: toLocalInput(nextHour.toISOString()), freq: "weekly", interval: "1", weekdays: [now.getDay()], monthDay: String(now.getDate()),
    time: "09:00", timezone, startDate: todayYmd(now), endMode: "never", endDate: "", count: "",
  };
}

export function scheduleToForm(schedule: Schedule, now = new Date()): ScheduleForm {
  const base = defaultScheduleForm(now);
  if (schedule.kind === "once") return { ...base, mode: "once", onceAt: toLocalInput(schedule.at) };
  return {
    ...base, mode: "repeat", freq: schedule.freq, interval: String(schedule.interval), weekdays: schedule.weekdays ?? [], monthDay: schedule.monthDay ? String(schedule.monthDay) : base.monthDay,
    time: schedule.time, timezone: schedule.timezone, startDate: schedule.startDate,
    endMode: schedule.endDate ? "date" : schedule.count ? "count" : "never", endDate: schedule.endDate ?? "", count: schedule.count ? String(schedule.count) : "",
  };
}

export type FormErrors = Record<string, string>;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isRealYmd = (v: string) => { if (!YMD.test(v)) return false; const [y, m, d] = v.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
export function validTimezone(tz: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return !!tz; } catch { return false; } }
const wholeNumber = (v: string) => /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;

/** Field errors keyed like the API's 400 `field` (schedule.at, schedule.interval, ...). Empty object = valid. */
export function validateScheduleForm(form: ScheduleForm, now = new Date()): FormErrors {
  const errors: FormErrors = {};
  if (form.mode === "once") {
    const iso = fromLocalInput(form.onceAt);
    if (!iso) errors["schedule.at"] = "Pick a date and time.";
    else if (Date.parse(iso) <= now.getTime()) errors["schedule.at"] = "Pick a moment in the future.";
    return errors;
  }
  const interval = wholeNumber(form.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) errors["schedule.interval"] = "Enter a whole number from 1 to 1000.";
  if (!HHMM.test(form.time)) errors["schedule.time"] = "Enter a time like 09:00.";
  if (!validTimezone(form.timezone)) errors["schedule.timezone"] = "Use an IANA name such as America/Sao_Paulo.";
  if (!isRealYmd(form.startDate)) errors["schedule.startDate"] = "Pick a start date.";
  if (form.freq === "weekly" && !form.weekdays.length) errors["schedule.weekdays"] = "Choose at least one weekday.";
  if (form.freq === "monthly") {
    const day = wholeNumber(form.monthDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) errors["schedule.monthDay"] = "Enter a day from 1 to 31.";
  }
  if (form.endMode === "date") {
    if (!isRealYmd(form.endDate)) errors["schedule.endDate"] = "Pick an end date.";
    else if (isRealYmd(form.startDate) && form.endDate < form.startDate) errors["schedule.endDate"] = "The end date is before the start date.";
  }
  if (form.endMode === "count") {
    const count = wholeNumber(form.count);
    if (!Number.isInteger(count) || count < 1 || count > 100_000) errors["schedule.count"] = "Enter a whole number from 1 to 100000.";
  }
  return errors;
}

/** The API schedule for a VALID form (check validateScheduleForm first). */
export function formToSchedule(form: ScheduleForm): Schedule {
  if (form.mode === "once") return { kind: "once", at: fromLocalInput(form.onceAt) ?? "" };
  const out: RecurringSchedule = { kind: "recurring", freq: form.freq, interval: Number(form.interval), time: form.time, timezone: form.timezone, startDate: form.startDate };
  if (form.freq === "weekly") out.weekdays = [...new Set(form.weekdays)].sort((a, b) => a - b);
  if (form.freq === "monthly") out.monthDay = Number(form.monthDay);
  if (form.endMode === "date") out.endDate = form.endDate;
  if (form.endMode === "count") out.count = Number(form.count);
  return out;
}

export interface AutomationFormValues { title: string; instructions: string; schedule: ScheduleForm }
export function validateAutomationForm(values: AutomationFormValues, now = new Date()): FormErrors {
  const errors = validateScheduleForm(values.schedule, now);
  const title = values.title.replace(/\s+/g, " ").trim();
  if (!title) errors.title = "Give the automation a name.";
  else if (title.length > 160) errors.title = "Use 160 characters or fewer.";
  if (values.instructions.length > 20_000) errors.instructions = "Use 20000 characters or fewer.";
  return errors;
}
export function validateTaskTitle(title: string): string | null {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return "Give the task a title.";
  if (t.length > 200) return "Use 200 characters or fewer.";
  return null;
}

/** Last-status text for the automation list (statuses written by the runtime: ok, manual, caught_up, skipped, "error: ...", dispatch results). */
export function lastStatusLabel(status: string | null): string {
  if (!status) return "Never ran";
  if (status.startsWith("error")) return status.replace(/^error:?\s*/, "Error: ") || "Error";
  const known: Record<string, string> = { ok: "Last run created a task", manual: "Last run was started by hand", caught_up: "Caught up after downtime", skipped: "A missed run was skipped" };
  return known[status] ?? status;
}
