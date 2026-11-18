/** Pure helpers: classify Claude Code usage-limit TEXT (transcript record text or terminal banner). No manager imports (testable without node-pty). */

export type LimitKind = "window" | "spend" | "extra_usage";

export interface LimitText {
  /** five_hour, seven_day, seven_day_opus, seven_day_sonnet, spend_limit, extra_usage or usage_limit (unknown wording). */
  rateLimitType: string;
  kind: LimitKind;
  /** Next UTC occurrence of the clock time the text names ("resets 2:50am (UTC)"), ISO, or null. */
  resetsAt: string | null;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;

export function stripAnsiText(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "\n");
}

/** True when the text is a Claude Code limit message: a "hit your ... limit" line, "Usage limit reached", a spend cap or an exhausted-extra-usage notice. */
const LIMIT_MESSAGE = /(you['’]ve hit your [^\n]{0,80}(limit|spend)|usage limit reached|spend limit|usage-credits|out of extra usage|extra usage (is )?(exhausted|limit)|continuing automatically at)/i;

/** "resets 2:50am (UTC)" / "resets 6pm (UTC)" / "continuing automatically at 2:50am" to the next such UTC time after `now`. */
export function parseResetClock(text: string, now: number): string | null {
  const m = /(?:resets?|continuing automatically at)\s+(?:[A-Z][a-z]{2}\s+\d{1,2},\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (/pm/i.test(m[3]!)) hour += 12;
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  const base = new Date(now);
  let at = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute, 0);
  if (at <= now) at += 86_400_000;
  return new Date(at).toISOString();
}

/** Classify a limit message; null when the text is not one. Spend caps win over the window they mention (the cap is what blocks). */
export function classifyLimitText(raw: string, now: number): LimitText | null {
  const text = stripAnsiText(raw);
  if (!LIMIT_MESSAGE.test(text)) return null;
  const resetsAt = parseResetClock(text, now);
  if (/spend limit|usage-credits|monthly (spend|limit)|org['’]?s? [^\n]{0,20}limit/i.test(text)) return { rateLimitType: "spend_limit", kind: "spend", resetsAt };
  if (/extra usage/i.test(text)) return { rateLimitType: "extra_usage", kind: "extra_usage", resetsAt };
  if (/opus/i.test(text) && /week|7-day|seven/i.test(text)) return { rateLimitType: "seven_day_opus", kind: "window", resetsAt };
  if (/sonnet/i.test(text) && /week|7-day|seven/i.test(text)) return { rateLimitType: "seven_day_sonnet", kind: "window", resetsAt };
  if (/week|7-day|seven[- ]day/i.test(text)) return { rateLimitType: "seven_day", kind: "window", resetsAt };
  if (/5-hour|five[- ]hour|session limit/i.test(text)) return { rateLimitType: "five_hour", kind: "window", resetsAt };
  return { rateLimitType: "usage_limit", kind: "window", resetsAt };
}

/**
 * The CLI's own terminal banner, stricter than classifyLimitText because terminal text can be anything an agent prints:
 * "Usage limit reached · continuing automatically at 2:50am" or "You've hit your ... limit · ...", with the CLI's "·" separator.
 */
const BANNER = /(usage limit reached\s*[\u00b7\u2022]\s*continuing automatically at|you['\u2019]ve hit your [^\n\u00b7]{0,80}\s[\u00b7\u2022]\s)/i;

export function classifyBanner(raw: string, now: number): LimitText | null {
  const text = stripAnsiText(raw);
  return BANNER.test(text) ? classifyLimitText(text, now) : null;
}

/** Keep the screen tail bounded: strip escapes, append, cut to the last `max` chars. */
export function appendTail(tail: string, data: string, max = 2000): string {
  return (tail + stripAnsiText(data)).slice(-max);
}

/** Percent at or above which an account counts as exhausted for the fallback chain (the CLI blocks at ~99-100 %). */
export const NEAR_FULL_PERCENT = 98;
