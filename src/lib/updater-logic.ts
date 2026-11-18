// Pure update-scheduling and display logic. No Tauri imports: unit-tested by scripts/dev/updater-logic.test.mts.

export const REPO_URL = "https://github.com/victorl1m/Floq";
/** First check after launch, so startup is never slowed down. */
export const INITIAL_CHECK_DELAY_MS = 30_000;
/** Interval between automatic checks while the app stays open. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A failed automatic check is retried sooner, but never more often than this. */
export const RETRY_DELAY_MS = 30 * 60 * 1000;

export type UpdateStatus = "idle" | "checking" | "uptodate" | "downloading" | "ready" | "installing" | "error";

export interface UpdateState {
    status: UpdateStatus;
    /** Version of the update being downloaded / ready. */
    version: string | null;
    notes: string | null;
    /** 0..1 when the size is known, otherwise null. */
    progress: number | null;
    error: string | null;
    lastCheckedAt: number | null;
}

export const INITIAL_UPDATE_STATE: UpdateState = {
    status: "idle",
    version: null,
    notes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
};

/** Automatic checks only run in a packaged desktop build with the preference on, and never while busy. */
export function canAutoCheck(input: { isDesktop: boolean; isProd: boolean; enabled: boolean; status: UpdateStatus }): boolean {
    if (!input.isDesktop || !input.isProd || !input.enabled) return false;
    return input.status === "idle" || input.status === "uptodate" || input.status === "error";
}

/** Delay before the next automatic check. `null` = never checked yet in this run. */
export function nextCheckDelay(input: { lastCheckedAt: number | null; now: number; failed: boolean }): number {
    if (input.lastCheckedAt === null) return INITIAL_CHECK_DELAY_MS;
    if (input.failed) return RETRY_DELAY_MS;
    return Math.max(0, input.lastCheckedAt + CHECK_INTERVAL_MS - input.now);
}

export type UpdateEvent =
    | { type: "check-start" }
    | { type: "check-none"; at: number }
    | { type: "check-error"; at: number; message: string }
    | { type: "found"; at: number; version: string; notes: string | null }
    | { type: "progress"; chunk: number; total: number | null; received: number }
    | { type: "downloaded" }
    | { type: "download-error"; message: string }
    | { type: "install-start" }
    | { type: "install-error"; message: string };

export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
    switch (event.type) {
        case "check-start":
            // A manual check never disturbs a download or a ready update.
            if (state.status === "downloading" || state.status === "ready" || state.status === "installing") return state;
            return { ...state, status: "checking", error: null };
        case "check-none":
            return { ...INITIAL_UPDATE_STATE, status: "uptodate", lastCheckedAt: event.at };
        case "check-error":
            return { ...state, status: "error", error: event.message, lastCheckedAt: event.at };
        case "found":
            return { ...state, status: "downloading", version: event.version, notes: event.notes, progress: null, error: null, lastCheckedAt: event.at };
        case "progress":
            return { ...state, progress: event.total && event.total > 0 ? Math.min(1, event.received / event.total) : null };
        case "downloaded":
            return { ...state, status: "ready", progress: 1 };
        case "download-error":
            return { ...state, status: "error", error: event.message, progress: null };
        case "install-start":
            return { ...state, status: "installing", error: null };
        case "install-error":
            return { ...state, status: "ready", error: event.message };
    }
}

export function releaseNotesUrl(version: string): string {
    return `${REPO_URL}/releases/tag/v${version.replace(/^v/, "")}`;
}

/** Short, user-facing text for an error from the updater plugin. */
export function describeUpdateError(error: unknown): string {
    const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (!text) return "Could not check for updates.";
    if (/pubkey|public key|base64/i.test(text)) return "Updates are not configured in this build.";
    if (/signature/i.test(text)) return "The update failed its signature check and was not installed.";
    if (/network|fetch|connect|dns|timed? ?out|status code|404|403/i.test(text)) return "Could not reach the update server.";
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
