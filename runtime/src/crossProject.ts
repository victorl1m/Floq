import { HttpError } from "./errors.js";

/**
 * Cross-project agent messaging guards. Pure and in-memory so they are testable without a database.
 * Same-user scoping is enforced by the caller (every query is filtered by user id); this module only
 * decides whether one more cross-project message may be delivered right now and how it is presented.
 */

export const CROSS_MAX_PER_MINUTE = 10;
export const CROSS_MAX_CHARS = 8_000;
export const CROSS_MAX_HOPS = 4;
export const CROSS_DEDUPE_MS = 60_000;
/** How long a delivered cross-project message counts as the "cause" of whatever the receiver forwards next. */
export const CROSS_CHAIN_MS = 10 * 60_000;

const clean = (text: string, max: number) =>
  text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export interface CrossParty { id: string; title: string; projectName: string }

/**
 * One-line provenance header typed in front of the message. Only names and the session UUID appear: never a
 * secret value, a path or a token. `hop` is 1 for a message that did not itself come from another project.
 */
export function buildProvenance(from: CrossParty, hop: number): string {
  return `[Message from agent ${clean(from.title, 60) || "agent"} (project ${clean(from.projectName, 60) || "unnamed"}, session ${from.id}, hop ${hop})]`;
}

/** Appended after the body so the receiver knows how to answer. */
export function buildReplyHint(from: CrossParty, waiting: boolean): string {
  return waiting
    ? ` (Reply path: ${clean(from.title, 60) || "the sender"} is waiting for your final answer in this turn, just reply normally. You can also send later with: floq ask ${from.id} "...")`
    : ` (Reply path: floq ask ${from.id} "your reply")`;
}

export class CrossProjectGuard {
  private readonly sent = new Map<string, number[]>();
  private readonly recent = new Map<string, number>();
  private readonly inbound = new Map<string, { hop: number; at: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = { perMinute: CROSS_MAX_PER_MINUTE, maxChars: CROSS_MAX_CHARS, maxHops: CROSS_MAX_HOPS, dedupeMs: CROSS_DEDUPE_MS },
  ) {}

  /** Throws HttpError when the message must not go out; otherwise records it and returns its hop number. */
  admit(fromId: string, toId: string, body: string): { hop: number } {
    const t = this.now();
    if (body.length > this.limits.maxChars) throw new HttpError(413, "cross_project_too_large", `Cross-project messages are limited to ${this.limits.maxChars} characters; send a shorter message or share files in the target's project.`);
    const inbound = this.inbound.get(fromId);
    const hop = inbound && t - inbound.at < CROSS_CHAIN_MS ? inbound.hop + 1 : 1;
    if (hop > this.limits.maxHops) throw new HttpError(429, "cross_project_loop", `Refused: this message would be forwarded across projects ${hop} times in a row (limit ${this.limits.maxHops}). Answer the sender directly or tell the user.`);
    const key = fromId + ">" + toId + ":" + body.trim();
    for (const [k, at] of this.recent) if (t - at >= this.limits.dedupeMs) this.recent.delete(k);
    if (this.recent.has(key)) throw new HttpError(429, "cross_project_duplicate", "Refused: you already sent this exact message to that agent a moment ago. Wait for its reply instead of repeating it.");
    const window = (this.sent.get(fromId) ?? []).filter((at) => t - at < 60_000);
    if (window.length >= this.limits.perMinute) throw new HttpError(429, "cross_project_rate", `Rate limit: at most ${this.limits.perMinute} cross-project messages per minute per agent. Wait a bit.`);
    window.push(t);
    this.sent.set(fromId, window);
    this.recent.set(key, t);
    this.inbound.set(toId, { hop, at: t });
    return { hop };
  }
}
