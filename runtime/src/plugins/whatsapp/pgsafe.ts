// Postgres refuses two things WhatsApp text can carry: the NUL character (TEXT and JSONB both reject it) and a lone UTF-16 surrogate
// (half an emoji, e.g. a preview cut mid-character), which JSON.stringify writes as a "\udXXX" escape that JSONB rejects with
// "invalid input syntax for type json". One such message used to fail a whole history import.

/** The text with NUL removed and lone surrogates replaced by U+FFFD, so Postgres accepts it. */
export function pgText(s: string): string {
  const t = s.includes("\u0000") ? s.replaceAll("\u0000", "") : s;
  return wellFormed(t);
}

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** String.prototype.toWellFormed (the runtime's TypeScript lib predates it): lone surrogates become U+FFFD. */
export const wellFormed = (s: string): string => s.replace(LONE, "\uFFFD");

/** JSON.stringify for a JSONB parameter: every string inside goes through pgText first. */
export function pgJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "string" ? pgText(x) : x));
}
