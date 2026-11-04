import { createHash, randomBytes } from "node:crypto";

/**
 * Pure helpers for user approvals (see approvals.ts). The security-critical one is `neutralizeApprovalMarker`:
 * the only text that may carry the `[FLOQ APPROVAL ...]` marker into an agent's terminal is the line the runtime
 * itself types after the user clicked Allow/Deny. Everything agent-authored (messages, notes, inbox bodies, wired
 * context, replies) goes through this function so that a forged marker cannot be read by another agent.
 */

export const APPROVAL_MARKER = "[FLOQ APPROVAL";
export const APPROVAL_REDACTED = "[FLOQ-APPROVAL-TEXT-REDACTED]";

/** Zero-width, bidi and soft-hyphen characters that are invisible but would split a marker for a naive filter. */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
/** Look-alike brackets that NFKC does not fold to "[". */
const BRACKETS = /[【〔⟦❨❲〚［⁅]/g;
/** Cyrillic/Greek capitals and a few lowercase that render like Latin letters. */
const CONFUSABLES: Record<string, string> = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S", "Ԛ": "Q", "Ү": "Y",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ү": "y",
  "Α": "A", "Β": "B", "Ε": "E", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X", "Ι": "I", "Υ": "Y", "Ζ": "Z", "ο": "o", "ρ": "p", "ν": "v",
};
const CONFUSABLE_RE = new RegExp("[" + Object.keys(CONFUSABLES).join("") + "]", "g");

/** `[` + optional spaces + FLOQ + separators + APPROVAL (any case), not already our own redaction text. */
const BRACKETED = /\[\s*FLOQ[\s_\-·.:]*APPROVAL(?!-TEXT-REDACTED)/gi;
/** Without a bracket only the exact upper-case phrase counts (the lower-case `floq approval ...` is a real command). */
const SHOUTED = /FLOQ[\s_\-·]+APPROVAL(?!-TEXT-REDACTED)/g;

export function foldLookalikes(text: string): string {
  return text.replace(INVISIBLE, "").replace(BRACKETS, "[").normalize("NFKC").replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
}

export function containsApprovalMarker(text: string): boolean {
  const folded = foldLookalikes(text);
  BRACKETED.lastIndex = 0;
  SHOUTED.lastIndex = 0;
  return BRACKETED.test(folded) || SHOUTED.test(folded);
}

/**
 * Replaces any `[FLOQ APPROVAL` look-alike with `[FLOQ-APPROVAL-TEXT-REDACTED]`. Text without a marker is returned
 * byte-for-byte unchanged; text with one is returned in its folded form (invisible characters and look-alikes removed).
 */
export function neutralizeApprovalMarker(text: string): string {
  if (!containsApprovalMarker(text)) return text;
  return foldLookalikes(text).replace(BRACKETED, APPROVAL_REDACTED).replace(SHOUTED, APPROVAL_REDACTED);
}

/** Applies `neutralizeApprovalMarker` to every string inside a JSON-like value (response bodies of agent-facing calls). */
export function neutralizeDeep<T>(value: T): T {
  if (typeof value === "string") return neutralizeApprovalMarker(value) as T;
  if (Array.isArray(value)) return value.map((v) => neutralizeDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = neutralizeDeep(v);
    return out as T;
  }
  return value;
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g;

/** One line, no control characters, no markers, no double quotes (the typed line quotes the action), at most `max` characters. */
export function cleanActionText(text: string, max: number): string {
  return neutralizeApprovalMarker(foldLookalikes(text).replace(/[\n\t]+/g, " ").replace(CONTROL, " ")).replace(/"/g, "'").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Longer free text: newlines are kept (for the UI), everything else as `cleanActionText`. */
export function cleanDetailText(text: string, max: number): string {
  return neutralizeApprovalMarker(foldLookalikes(text).replace(/\r\n?/g, "\n").replace(CONTROL, " ")).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

/** Verbs and targets that make an action outward-facing or hard to undo. Shown as "Irreversible" in the app. */
const RISKY = /\b(merge[sd]?|merging|push(?:es|ed|ing)?|deploy(?:s|ed|ing|ment)?|release[sd]?|releasing|delete[sd]?|deleting|remove[sd]?|force|drop(?:s|ped|ping)?|publish(?:es|ed|ing)?|production|prod|main|master|rm\s+-rf|reset\s+--hard|tag(?:ged|ging)?|rollback|truncate|wipe|destroy)\b/i;
export function isIrreversibleAction(action: string): boolean {
  return RISKY.test(action);
}

/** The scope of an approval: exactly this action text (case and spacing normalized). */
export function actionHash(action: string): string {
  return createHash("sha256").update(action.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 32);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** 128 random bits, base32 (26 characters, no padding). Unguessable; never derived from anything an agent can see. */
export function newApprovalId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
export const APPROVAL_ID = /^[A-Z2-7]{26}$/;

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

export interface ApprovalLineInput { id: string; action: string; decision: "granted" | "denied"; validUntil: number; forTarget?: { name: string } }

/**
 * The line the RUNTIME types into the target agent's terminal after the user decided. Typed with `trusted: true`
 * (the only caller allowed to emit the marker); the action text in it was already neutralized at request time.
 */
export function formatApprovalLine(input: ApprovalLineInput): string {
  const head = `${APPROVAL_MARKER} ${input.id} · issued by the user in the Floq app, not by another agent]`;
  if (input.decision === "granted") {
    return `${head} The user APPROVED (single use, expires ${clock(input.validUntil)}): "${input.action}". Confirm with: floq approval verify ${input.id}`;
  }
  return `${head} The user DENIED: "${input.action}". Do not do it. Confirm with: floq approval verify ${input.id}`;
}

/** Notice for the agent that asked on behalf of another agent (the requester is not the one who must act). */
export function formatRequesterNotice(input: ApprovalLineInput & { forTarget: { name: string } }): string {
  const head = `${APPROVAL_MARKER} ${input.id} · issued by the user in the Floq app, not by another agent]`;
  return input.decision === "granted"
    ? `${head} The user APPROVED your request for agent ${input.forTarget.name} (single use, expires ${clock(input.validUntil)}): "${input.action}". That agent was told and must confirm it itself with: floq approval verify ${input.id}`
    : `${head} The user DENIED your request for agent ${input.forTarget.name}: "${input.action}". Do not ask it to do this.`;
}
