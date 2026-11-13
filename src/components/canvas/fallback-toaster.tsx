import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRuntime } from "@/lib/runtime/store";
import { fallbackBadgeText } from "./fallback-badge";

/**
 * Headless: one toast when an agent starts a usage-limit fallback (model swap or pause). Sessions that already carry a
 * fallback on first load are not announced, and each fallback is announced once. Swap-back is quiet (the badge goes away).
 */
export function FallbackToaster() {
  const { sessions, loaded } = useRuntime();
  const seen = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (!loaded) return;
    const keyOf = (s: { fallback?: { kind: string; label: string } | null }) => (s.fallback ? `${s.fallback.kind}:${s.fallback.label}` : "");
    if (seen.current === null) {
      seen.current = new Map(sessions.map((s) => [s.id, keyOf(s)]));
      return;
    }
    const known = seen.current;
    for (const session of sessions) {
      const key = keyOf(session);
      if (known.get(session.id) === key) continue;
      known.set(session.id, key);
      if (!session.fallback) continue;
      const fb = session.fallback;
      if (fb.kind === "paused") {
        const why = fb.reason === "pause_override" ? "Its policy is \"Pause instead\"."
          : fb.reason === "fallback_loop" ? "It was moved too many times in an hour."
          : fb.reason === "steps_unavailable" ? "No fallback has room right now (your other account is full, or Codex is at its limit)."
          : "No fallback applies to this limit. Add a second Claude account or enable Codex in Settings > Agents to keep working.";
        toast.warning(`${session.title} paused: Claude usage limit`, { description: `${fallbackBadgeText(fb)}. It continues on its own when the limit resets. ${why}` });
      } else if (fb.kind === "account") toast.info(`Claude account switched to ${fb.label}`, { description: `${session.title} hit a usage limit. Your main account comes back when its limit resets.` });
      else if (fb.kind === "codex") toast.info(`${session.title} continues on Codex`, { description: "It hit a Claude usage limit; Codex picks up from a handoff summary and asks for approvals if its auto-approve is off. It returns to Claude at the reset." });
      else toast.info(`${session.title} hit a usage limit`, { description: `Now on ${fb.label} (was ${fb.originLabel}). It switches back when the limit resets.` });
    }
  }, [sessions, loaded]);

  return null;
}
