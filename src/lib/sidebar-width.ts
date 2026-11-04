import { useSyncExternalStore } from "react";

/**
 * User-resizable left sidebar width. The sidebar can only be enlarged beyond its default width (17rem = 272px).
 * The width is published as `--sidebar-user-width` on <html>; SidebarProvider resolves `--sidebar-width` from it
 * (falling back to 17rem), so the sidebar, gap, titlebar and content frame all follow one variable.
 */
export const SIDEBAR_MIN_PX = 272;
export const SIDEBAR_MAX_PX = 520;
export const SIDEBAR_MAX_RATIO = 0.4;
export const SIDEBAR_MIN_CONTENT_PX = 480;
/** Below this viewport width the stored width is ignored and the sidebar behaves as before. */
export const SIDEBAR_COMPACT_BREAKPOINT = 900;
export const SIDEBAR_STEP_PX = 16;
export const SIDEBAR_STEP_LARGE_PX = 64;

const KEY = "floq.sidebar-width.v1";
const VAR = "--sidebar-user-width";
const SHELL_GUTTER_PX = 16;

const isBrowser = typeof window !== "undefined";

function loadRequested(): number {
    try {
        const value = Number(JSON.parse(localStorage.getItem(KEY) ?? "null"));
        return Number.isFinite(value) ? Math.round(value) : SIDEBAR_MIN_PX;
    } catch { return SIDEBAR_MIN_PX; }
}

/** Width the user asked for (persisted). The effective width is this clamped to the current window. */
let requested = isBrowser ? loadRequested() : SIDEBAR_MIN_PX;
let effective = SIDEBAR_MIN_PX;
const listeners = new Set<() => void>();

function rightPanelReserve(): number {
    const panel = document.querySelector<HTMLElement>('.floq-right-sidebar[data-state="open"]');
    if (!panel || getComputedStyle(panel).position === "fixed") return 0;
    return panel.getBoundingClientRect().width + SHELL_GUTTER_PX / 2;
}

export function isSidebarCompact(): boolean {
    return isBrowser && window.innerWidth < SIDEBAR_COMPACT_BREAKPOINT;
}

/** Largest permitted width for the current window; never below the minimum. */
export function getSidebarMax(): number {
    if (!isBrowser) return SIDEBAR_MAX_PX;
    const byRatio = Math.floor(window.innerWidth * SIDEBAR_MAX_RATIO);
    const byContent = window.innerWidth - SIDEBAR_MIN_CONTENT_PX - SHELL_GUTTER_PX - rightPanelReserve();
    return Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, byRatio, byContent));
}

export function clampSidebarWidth(width: number, max = getSidebarMax()): number {
    return Math.min(max, Math.max(SIDEBAR_MIN_PX, Math.round(width)));
}

/** Writes the CSS variable only: no React work. At the minimum the override is removed so the default (17rem) applies. */
export function paintSidebarWidth(px: number): void {
    if (!isBrowser) return;
    const style = document.documentElement.style;
    if (px <= SIDEBAR_MIN_PX) style.removeProperty(VAR);
    else style.setProperty(VAR, `${px}px`);
}

function recompute(): void {
    const next = isSidebarCompact() ? SIDEBAR_MIN_PX : clampSidebarWidth(requested);
    paintSidebarWidth(next);
    if (next !== effective) {
        effective = next;
        listeners.forEach((listener) => listener());
    }
}

/** Live preview while dragging: paints without committing or notifying React. */
export function previewSidebarWidth(px: number): number {
    const next = clampSidebarWidth(px);
    paintSidebarWidth(next);
    return next;
}

/** Commit (and persist) a width chosen by the user. */
export function setSidebarWidth(px: number): void {
    requested = clampSidebarWidth(px);
    try { localStorage.setItem(KEY, JSON.stringify(requested)); } catch { /* optional preference */ }
    recompute();
    paintSidebarWidth(effective);
}

export const resetSidebarWidth = () => setSidebarWidth(SIDEBAR_MIN_PX);

export function getEffectiveSidebarWidth(): number { return effective; }

export function useSidebarWidth(): number {
    return useSyncExternalStore(
        (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
        () => effective,
        () => SIDEBAR_MIN_PX,
    );
}

if (isBrowser) {
    recompute();
    let frame = 0;
    window.addEventListener("resize", () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(recompute);
    });
}
