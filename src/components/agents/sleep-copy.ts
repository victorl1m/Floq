import type { ProviderId } from "@/lib/runtime/types";

/**
 * Plain-language wording for `SessionSummary.sleepReason`.
 * Values are the ones the runtime writes: manager.ts sleepSession() callers
 * ("idle", "lifetime", "shutdown", "logout", "manual") and shards.ts startup recovery ("restart").
 */
const SLEEP_REASON_COPY: Record<string, string> = {
    idle: "It went to sleep after being idle.",
    lifetime: "It reached its maximum running time.",
    logout: "It stopped when you signed out.",
    manual: "It was put to sleep.",
    shutdown: "It stopped when the server shut down.",
    restart: "It stopped when the server restarted.",
};

/** Never returns the raw internal value: unknown or missing reasons get a neutral sentence. */
export function sleepReasonText(reason: string | null | undefined): string {
    return (reason && Object.prototype.hasOwnProperty.call(SLEEP_REASON_COPY, reason) ? SLEEP_REASON_COPY[reason] : null) ?? "It is not running right now.";
}

/**
 * What Resume does. Claude always has a conversation id (the Floq session id); Codex's id is only
 * known to the runtime once captured, and either one falls back to a fresh start if the
 * conversation can't be reopened. A shell just starts a new login shell in the same folder.
 */
export function resumeHint(provider: ProviderId): string {
    if (provider === "shell") return "Resume opens a new shell in the same folder. Programs that were running won't carry over.";
    if (provider === "codex") return "Resume continues the same conversation when it can, and starts a new one if not.";
    return "Resume continues the same conversation. If it can't be reopened, a new one starts.";
}
