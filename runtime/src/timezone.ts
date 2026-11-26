import { readFileSync } from "node:fs";
import { log } from "./logger.js";

/**
 * The runtime's default IANA time zone. Resolution order: FLOQ_TIMEZONE, then the standard TZ, then the server's own clock
 * (the process zone, which in a container follows a mounted /etc/localtime, else /etc/timezone, else UTC).
 * An invalid value is logged once and skipped. Users' own per-schedule zones always win over this server default.
 */
export type TimeZoneSource = "FLOQ_TIMEZONE" | "TZ" | "system";
export interface RuntimeTimeZone { zone: string; source: TimeZoneSource }

export function isValidZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

const warned = new Set<string>();
function warnOnce(name: string, value: string): void {
  const key = name + "=" + value;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn("timezone.invalid", { variable: name, value: value.slice(0, 64), hint: "use an IANA zone such as America/Sao_Paulo; falling back" });
}

/** TZ may carry a leading colon (":America/Sao_Paulo"). */
function candidate(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().replace(/^:/, "");
  return v || null;
}

function systemZone(): string {
  try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (isValidZone(z)) return z; } catch { /* fall through */ }
  try { const z = readFileSync("/etc/timezone", "utf8").trim(); if (isValidZone(z)) return z; } catch { /* not mounted */ }
  return "UTC";
}

export function resolveTimeZone(env: Record<string, string | undefined> = process.env): RuntimeTimeZone {
  for (const name of ["FLOQ_TIMEZONE", "TZ"] as const) {
    const v = candidate(env[name]);
    if (!v) continue;
    if (isValidZone(v)) return { zone: v, source: name };
    warnOnce(name, v);
  }
  return { zone: systemZone(), source: "system" };
}

export const runtimeTimeZone = (env: Record<string, string | undefined> = process.env): string => resolveTimeZone(env).zone;
