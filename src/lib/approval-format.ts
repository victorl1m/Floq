/** Pure helpers for the approval prompt (no imports, so they run under plain `node --test`). */

export type RiskLevel = "production" | "irreversible" | "neutral";

const PRODUCTION = /\b(production|prod|main|master|deploy(?:s|ed|ing|ment)?|release[sd]?|publish(?:es|ed|ing)?)\b/i;

/**
 * "Irreversible" only when the server flagged the request. The action and detail text is written by the agent, so it never
 * lowers or raises the label; production-looking words only sharpen the label once the server already said irreversible.
 */
export function riskLevel(action: string, detail: string, irreversible: boolean): RiskLevel {
  if (!irreversible) return "neutral";
  return PRODUCTION.test(action + " " + detail) ? "production" : "irreversible";
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  production: "Irreversible · affects production",
  irreversible: "Irreversible",
  neutral: "Needs your OK",
};

/** 9:41 style, never negative. */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Screen readers hear the request once, then at 60s and 10s: never every tick. */
export function announceBucket(seconds: number): "start" | "60" | "10" {
  return seconds <= 10 ? "10" : seconds <= 60 ? "60" : "start";
}

export function describeAnnouncement(bucket: "start" | "60" | "10", who: string, action: string, seconds: number): string {
  if (bucket === "start") return `${who} needs your approval: ${action}. Expires in ${formatRemaining(seconds)}.`;
  return `${bucket} seconds left to answer: ${action}.`;
}

/** Newest first. */
export function newestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** `(2) Floq` while approvals wait; the plain title otherwise. */
export function titleWithPending(title: string, pending: number): string {
  return pending > 0 ? `(${pending}) ${title}` : title;
}

/** Details longer than this (or with several lines) start collapsed. */
export function detailIsLong(detail: string): boolean {
  return detail.length > 160 || detail.split("\n").length > 3;
}

/** How a requester or target is named in the prompt: plugins read "Plugin: <name>", agents keep their own name. */
export function actorLabel(actor: { name: string; kind?: string }): string {
  return actor.kind === "plugin" ? `Plugin: ${actor.name}` : actor.name;
}
