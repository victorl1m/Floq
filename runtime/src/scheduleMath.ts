/**
 * Pure schedule math for automations (no I/O, no clock). Times are computed in the schedule's IANA timezone with Intl.
 *
 * Conventions:
 *  - weekdays use the JS convention: 0 = Sunday ... 6 = Saturday.
 *  - monthly: `monthDay` beyond the month's length clamps to the last day (31 = last day in short months).
 *  - yearly: month/day come from startDate; Feb 29 clamps to Feb 28 in non-leap years.
 *  - weekly with interval N: weeks are Sunday-anchored and counted from the week containing startDate.
 *  - DST: a local time that does not exist (spring-forward gap) runs at the shifted-forward instant (02:30 -> 03:30);
 *    a local time that happens twice (fall-back overlap) runs at its first occurrence.
 *  - `count` counts occurrences from startDate (including ones in the past), independent of the clock.
 *  - Every date `endDate` (inclusive, local) bounds the schedule.
 */

export type RecurringFreq = "daily" | "weekly" | "monthly" | "yearly";
export type OnceSchedule = { kind: "once"; at: string };
export type RecurringSchedule = {
  kind: "recurring";
  freq: RecurringFreq;
  interval: number;
  weekdays?: number[];
  monthDay?: number;
  time: string;
  timezone: string;
  startDate: string;
  endDate?: string;
  count?: number;
};
export type Schedule = OnceSchedule | RecurringSchedule;

export class ScheduleError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

const DAY_MS = 86_400_000;
const MAX_ITERATIONS = 20_000;
const FREQS: RecurringFreq[] = ["daily", "weekly", "monthly", "yearly"];

type Ymd = { y: number; m: number; d: number };

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const epochDay = (v: Ymd) => Math.floor(Date.UTC(v.y, v.m - 1, v.d) / DAY_MS);
const fromEpochDay = (n: number): Ymd => { const dt = new Date(n * DAY_MS); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; };
const weekdayOf = (v: Ymd) => new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();

export function parseYmd(value: unknown, field: string): Ymd {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) throw new ScheduleError(field, `${field} must be YYYY-MM-DD`);
  const v = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.m)) throw new ScheduleError(field, `${field} is not a real date`);
  return v;
}
export function parseTime(value: unknown, field = "time"): { hh: number; mm: number } {
  const m = typeof value === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  if (!m) throw new ScheduleError(field, `${field} must be HH:MM (24h)`);
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timezone, f);
  }
  return f;
}
export function validTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone || timezone.length > 64) return false;
  try { formatter(timezone); return true; } catch { return false; }
}

/** Offset (local - UTC) in ms of the zone at a UTC instant. */
export function zoneOffsetMs(timezone: string, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(utcMs))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Local wall-clock -> UTC ms, with the gap/overlap rules described at the top of the file. */
export function zonedToUtc(v: Ymd, hh: number, mm: number, timezone: string): number {
  const wall = Date.UTC(v.y, v.m - 1, v.d, hh, mm);
  const before = zoneOffsetMs(timezone, wall - DAY_MS);
  const after = zoneOffsetMs(timezone, wall + DAY_MS);
  const valid: number[] = [];
  for (const o of new Set([before, after])) {
    const cand = wall - o;
    if (zoneOffsetMs(timezone, cand) === o) valid.push(cand);
  }
  if (valid.length) return Math.min(...valid); // overlap: first occurrence
  return wall - before; // gap: interpret with the pre-gap offset, which lands after the gap
}

/** Local calendar date of a UTC instant in the zone. */
export function localDateOf(utcMs: number, timezone: string): Ymd {
  const o = zoneOffsetMs(timezone, utcMs);
  const dt = new Date(utcMs + o);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Validates untrusted input and returns the normalised schedule. `now` is only used to reject a one-off in the past. */
export function validateSchedule(raw: unknown, now: Date): Schedule {
  if (!raw || typeof raw !== "object") throw new ScheduleError("schedule", "schedule is required");
  const s = raw as Record<string, unknown>;
  if (s.kind === "once") {
    const at = typeof s.at === "string" ? Date.parse(s.at) : NaN;
    if (!Number.isFinite(at)) throw new ScheduleError("schedule.at", "at must be an ISO date-time");
    if (at <= now.getTime()) throw new ScheduleError("schedule.at", "at must be in the future");
    return { kind: "once", at: new Date(at).toISOString() };
  }
  if (s.kind !== "recurring") throw new ScheduleError("schedule.kind", "kind must be once or recurring");
  if (!FREQS.includes(s.freq as RecurringFreq)) throw new ScheduleError("schedule.freq", "freq must be daily, weekly, monthly or yearly");
  const interval = s.interval === undefined ? 1 : s.interval;
  if (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > 1000) throw new ScheduleError("schedule.interval", "interval must be an integer from 1 to 1000");
  parseTime(s.time, "schedule.time");
  if (!validTimezone(s.timezone)) throw new ScheduleError("schedule.timezone", "timezone must be an IANA name such as America/Sao_Paulo");
  const start = parseYmd(s.startDate, "schedule.startDate");
  const out: RecurringSchedule = { kind: "recurring", freq: s.freq as RecurringFreq, interval: interval as number, time: s.time as string, timezone: s.timezone as string, startDate: s.startDate as string };
  if (s.weekdays !== undefined && s.weekdays !== null) {
    if (s.freq !== "weekly") throw new ScheduleError("schedule.weekdays", "weekdays only applies to weekly schedules");
    const w = s.weekdays;
    if (!Array.isArray(w) || !w.length || w.length > 7 || !w.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)) throw new ScheduleError("schedule.weekdays", "weekdays must be 1-7 integers from 0 (Sunday) to 6");
    out.weekdays = [...new Set(w as number[])].sort((a, b) => a - b);
  }
  if (s.monthDay !== undefined && s.monthDay !== null) {
    if (s.freq !== "monthly") throw new ScheduleError("schedule.monthDay", "monthDay only applies to monthly schedules");
    if (!Number.isInteger(s.monthDay) || (s.monthDay as number) < 1 || (s.monthDay as number) > 31) throw new ScheduleError("schedule.monthDay", "monthDay must be 1-31");
    out.monthDay = s.monthDay as number;
  }
  if (s.endDate !== undefined && s.endDate !== null) {
    const end = parseYmd(s.endDate, "schedule.endDate");
    if (epochDay(end) < epochDay(start)) throw new ScheduleError("schedule.endDate", "endDate must not be before startDate");
    out.endDate = s.endDate as string;
  }
  if (s.count !== undefined && s.count !== null) {
    if (!Number.isInteger(s.count) || (s.count as number) < 1 || (s.count as number) > 100_000) throw new ScheduleError("schedule.count", "count must be an integer from 1 to 100000");
    out.count = s.count as number;
  }
  return out;
}

/** Local dates of the schedule in order, from the first one at or after `startDate`. Lazy; may skip ahead when no count applies. */
function* localDates(s: RecurringSchedule, skipTo?: Ymd): Generator<Ymd> {
  const start = parseYmd(s.startDate, "startDate");
  const startDay = epochDay(start);
  const skipDay = skipTo && s.count === undefined ? epochDay(skipTo) : startDay;
  if (s.freq === "daily") {
    let k = Math.max(0, Math.floor((skipDay - startDay) / s.interval) - 1);
    for (;; k++) yield fromEpochDay(startDay + k * s.interval);
  } else if (s.freq === "weekly") {
    const weekdays = s.weekdays?.length ? s.weekdays : [weekdayOf(start)];
    const anchor = startDay - weekdayOf(start); // Sunday of the start week
    let w = Math.max(0, Math.floor((skipDay - anchor) / (7 * s.interval)) - 1);
    for (;; w++) {
      const weekStart = anchor + w * 7 * s.interval;
      for (const wd of weekdays) {
        const day = weekStart + wd;
        if (day >= startDay) yield fromEpochDay(day);
      }
    }
  } else if (s.freq === "monthly") {
    const target = s.monthDay ?? start.d;
    const startIdx = start.y * 12 + (start.m - 1);
    const skipV = fromEpochDay(skipDay);
    let k = Math.max(0, Math.floor((skipV.y * 12 + skipV.m - 1 - startIdx) / s.interval) - 1);
    for (;; k++) {
      const idx = startIdx + k * s.interval;
      const y = Math.floor(idx / 12), m = (idx % 12) + 1;
      const cand = { y, m, d: Math.min(target, daysInMonth(y, m)) };
      if (epochDay(cand) >= startDay) yield cand;
    }
  } else {
    const skipV = fromEpochDay(skipDay);
    let k = Math.max(0, Math.floor((skipV.y - start.y) / s.interval) - 1);
    for (;; k++) {
      const y = start.y + k * s.interval;
      const cand = { y, m: start.m, d: Math.min(start.d, daysInMonth(y, start.m)) };
      if (epochDay(cand) >= startDay) yield cand;
    }
  }
}

/** The first occurrence strictly after `after`, or null when the schedule is finished. */
export function nextRun(schedule: Schedule, after: Date): Date | null {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    return Number.isFinite(at) && at > after.getTime() ? new Date(at) : null;
  }
  const { hh, mm } = parseTime(schedule.time);
  const end = schedule.endDate ? epochDay(parseYmd(schedule.endDate, "endDate")) : Infinity;
  // Occurrences can sit a day either side of the local date of `after` (zone offsets), so aim a day early.
  const skipTo = fromEpochDay(epochDay(localDateOf(after.getTime(), schedule.timezone)) - 1);
  let n = 0;
  for (const date of localDates(schedule, skipTo)) {
    if (++n > MAX_ITERATIONS) return null;
    if (epochDay(date) > end) return null;
    // The count only works when iteration starts at startDate (localDates never skips when count is set).
    if (schedule.count !== undefined && n > schedule.count) return null;
    const at = zonedToUtc(date, hh, mm, schedule.timezone);
    if (at > after.getTime()) return new Date(at);
  }
  return null;
}

/** The next `limit` occurrences strictly after `after`. */
export function upcomingRuns(schedule: Schedule, after: Date, limit = 5): Date[] {
  const out: Date[] = [];
  let cursor = after;
  while (out.length < limit) {
    const next = nextRun(schedule, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Local calendar date (YYYY-MM-DD) of an instant, used in generated task titles. */
export function localDateLabel(at: Date, timezone: string): string {
  const v = localDateOf(at.getTime(), timezone);
  return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
}

export type CatchUp = "skip" | "once";
export type TickPlan =
  | { action: "wait" }
  | { action: "run"; nextRunAt: Date | null; missed: boolean }
  | { action: "skip"; nextRunAt: Date | null };

/** How late an occurrence may fire and still count as "on time" (scheduler ticks every 30 s). */
export const ON_TIME_GRACE_MS = 5 * 60_000;

/**
 * Decision for one automation at `now`. The next run is always the first occurrence after now, so a long downtime
 * never produces a burst: `skip` jumps over the missed occurrence(s), `once` runs a single catch-up run now.
 */
export function planAutomationTick(input: { enabled: boolean; schedule: Schedule; nextRunAt: Date | null; catchUp: CatchUp; now: Date }): TickPlan {
  const { enabled, schedule, nextRunAt, catchUp, now } = input;
  if (!enabled || !nextRunAt || nextRunAt.getTime() > now.getTime()) return { action: "wait" };
  const next = nextRun(schedule, now);
  const late = now.getTime() - nextRunAt.getTime();
  if (late > ON_TIME_GRACE_MS && catchUp === "skip") return { action: "skip", nextRunAt: next };
  return { action: "run", nextRunAt: next, missed: late > ON_TIME_GRACE_MS };
}
