/* Safe date handling for the Memory screen.
   The runtime stores times as epoch milliseconds and serialises them as ISO strings, but older rows, imports and the
   history log do not all agree: event entries carry `at` (not `createdAt`), a missing timestamp falls back to the epoch
   (1970-01-01), and hand-made or migrated rows may hold epoch seconds, numeric strings, null or garbage. Every date in the
   Memory screen goes through `toMs` so none of those can render as "Invalid Date" or "56y ago". Pure: unit tested
   (e2e/memory-dates.unit.mts). */

export const NO_DATE = "—";

/** Epoch seconds below this are treated as seconds (≈ year 33658 in ms; any real ms value since 2001 is larger). */
const SECONDS_BELOW = 1e12;

/** Milliseconds since the epoch, or null when the value is missing, unparseable or the zero/epoch placeholder. */
export function toMs(value: unknown): number | null {
  let n: number;
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  if (value instanceof Date) n = value.getTime();
  else if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    n = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s);
  } else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < SECONDS_BELOW) n *= 1000;
  // Beyond what Date can represent (±8.64e15) is garbage too.
  return n > 8.64e15 ? null : n;
}

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago"; small clock skew into the future reads "just now"; missing → "—". */
export function relativeTime(value: unknown, now = Date.now()): string {
  const t = toMs(value);
  if (t === null) return NO_DATE;
  const diff = now - t;
  if (diff < -60_000) return absoluteDate(t, { dateOnly: true });
  const s = Math.floor(Math.max(0, diff) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(m, 1)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Locale date and time ("Nov 9, 2026, 12:00 PM"), or only the date; missing → "—". */
export function absoluteDate(value: unknown, opts: { dateOnly?: boolean; locale?: string; timeZone?: string } = {}): string {
  const t = toMs(value);
  if (t === null) return NO_DATE;
  try {
    return new Intl.DateTimeFormat(opts.locale, opts.dateOnly
      ? { year: "numeric", month: "short", day: "numeric", timeZone: opts.timeZone }
      : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: opts.timeZone }).format(t);
  } catch { return new Date(t).toISOString(); }
}

/** Machine-readable value for <time dateTime>, or undefined when missing. */
export function isoDate(value: unknown): string | undefined {
  const t = toMs(value);
  return t === null ? undefined : new Date(t).toISOString();
}

/** One place for the label + tooltip + dateTime triple the UI shows. */
export function dateParts(value: unknown, now = Date.now()): { relative: string; absolute: string; iso: string | undefined; valid: boolean } {
  const t = toMs(value);
  return { relative: relativeTime(t, now), absolute: absoluteDate(t), iso: isoDate(t), valid: t !== null };
}

/** A history entry's time: the runtime writes `at`; older clients and fixtures use `createdAt`. */
export function eventTime(ev: { at?: unknown; createdAt?: unknown } | null | undefined): unknown {
  if (!ev) return null;
  return toMs(ev.at) !== null ? ev.at : ev.createdAt;
}

/** Newest-first comparator on possibly-invalid dates (invalid sorts last). */
export function compareDesc(a: unknown, b: unknown): number {
  return (toMs(b) ?? -Infinity) - (toMs(a) ?? -Infinity) || 0;
}
