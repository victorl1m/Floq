import { DAY_MS, DEFAULT_CONFIG, type StorageSenseConfig } from "./plan.js";

export type Mode = "off" | "report" | "clean";
export const HOUR_MS = 3600 * 1000;

function days(v: unknown, dflt: number, max = 3650): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.min(Math.max(Math.floor(v), 0), max);
}

/** Saved plugin settings -> an effective, clamped config. Unset or invalid values fall back to the defaults; 0 turns a category off. */
export function effectiveConfig(settings: Record<string, unknown>): { mode: Mode; config: StorageSenseConfig } {
  const mode: Mode = settings.mode === "off" || settings.mode === "clean" || settings.mode === "report" ? settings.mode : "report";
  return {
    mode,
    config: {
      worktreeDays: days(settings.worktreeDays, DEFAULT_CONFIG.worktreeDays),
      branchDays: days(settings.branchDays, DEFAULT_CONFIG.branchDays),
      scratchpadDays: days(settings.scratchpadDays, DEFAULT_CONFIG.scratchpadDays),
      attachmentDays: days(settings.attachmentDays, DEFAULT_CONFIG.attachmentDays),
      tmpDays: days(settings.tmpDays, DEFAULT_CONFIG.tmpDays),
      lowSpacePercent: days(settings.lowSpacePercent, DEFAULT_CONFIG.lowSpacePercent, 90),
    },
  };
}

/**
 * Which trigger (if any) is due: a daily run, or an extra run when free space is below the threshold (at most hourly, so a full
 * disk that cleanup cannot fix does not make it loop). Like Windows Storage Sense, whose cadence is "daily" or "when disk space is low".
 */
export function dueTrigger(input: { now: number; lastRunAt: number | null; freePercent: number | null; lowSpacePercent: number }): "schedule" | "low-space" | null {
  const since = input.lastRunAt === null ? Infinity : input.now - input.lastRunAt;
  if (since >= DAY_MS) return "schedule";
  if (input.lowSpacePercent > 0 && input.freePercent !== null && input.freePercent < input.lowSpacePercent && since >= HOUR_MS) return "low-space";
  return null;
}
