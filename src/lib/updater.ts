import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { loadAutoUpdate } from "./prefs";
import {
    INITIAL_UPDATE_STATE,
    canAutoCheck,
    describeUpdateError,
    nextCheckDelay,
    reduceUpdate,
    type UpdateEvent,
    type UpdateState,
} from "./updater-logic";

// Desktop auto-updater. The plugin verifies the minisign signature against the pubkey in tauri.conf.json and refuses
// anything that is not newer than the running version, so the only decisions made here are WHEN to check and what to show.

let state: UpdateState = INITIAL_UPDATE_STATE;
const listeners = new Set<() => void>();
/** The downloaded update, held until the user restarts. */
let pending: Update | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function dispatch(event: UpdateEvent) {
    state = reduceUpdate(state, event);
    for (const l of listeners) l();
}

export function useUpdateState(): UpdateState {
    return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        () => state,
        () => INITIAL_UPDATE_STATE,
    );
}

export const updaterSupported = (): boolean => isTauri();
const isProdBuild = (): boolean => import.meta.env.PROD;

export async function currentVersion(): Promise<string | null> {
    if (!isTauri()) return null;
    try { return await getVersion(); } catch { return null; }
}

/** Check, and when an update exists download it in the background. `manual` also runs in dev builds and with auto-update off. */
export async function checkForUpdates(manual: boolean): Promise<void> {
    if (!isTauri()) return;
    if (!manual && !canAutoCheck({ isDesktop: true, isProd: isProdBuild(), enabled: loadAutoUpdate(), status: state.status })) return;
    if (state.status === "checking" || state.status === "downloading" || state.status === "ready" || state.status === "installing") return;
    dispatch({ type: "check-start" });
    let update: Update | null;
    try {
        update = await check();
    } catch (e) {
        dispatch({ type: "check-error", at: Date.now(), message: describeUpdateError(e) });
        return;
    }
    if (!update) { dispatch({ type: "check-none", at: Date.now() }); return; }
    dispatch({ type: "found", at: Date.now(), version: update.version, notes: update.body ?? null });
    let total: number | null = null;
    let received = 0;
    try {
        await update.download((event: DownloadEvent) => {
            if (event.event === "Started") total = event.data.contentLength ?? null;
            else if (event.event === "Progress") {
                received += event.data.chunkLength;
                dispatch({ type: "progress", chunk: event.data.chunkLength, total, received });
            }
        });
    } catch (e) {
        dispatch({ type: "download-error", message: describeUpdateError(e) });
        return;
    }
    pending = update;
    dispatch({ type: "downloaded" });
}

/** Install the downloaded update. On Windows the passive NSIS installer closes and restarts the app itself. */
export async function installAndRestart(): Promise<void> {
    if (!pending || state.status !== "ready") return;
    dispatch({ type: "install-start" });
    try {
        await pending.install();
        await relaunch();
    } catch (e) {
        dispatch({ type: "install-error", message: describeUpdateError(e) });
    }
}

function schedule() {
    clearTimeout(timer);
    const failed = state.status === "error";
    timer = setTimeout(async () => {
        await checkForUpdates(false);
        schedule();
    }, nextCheckDelay({ lastCheckedAt: state.lastCheckedAt, now: Date.now(), failed }));
}

/** First check 30 s after launch, then every 6 h. Idempotent; returns a stop function. */
export function startUpdateScheduler(): () => void {
    if (started || !isTauri()) return () => undefined;
    started = true;
    schedule();
    return () => { started = false; clearTimeout(timer); };
}
