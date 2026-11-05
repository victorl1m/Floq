import { useSyncExternalStore } from "react";

export type RightSidebarTab = "changes" | "files" | "conversations" | "app";
export const RIGHT_SIDEBAR_MIN = 260;
export const RIGHT_SIDEBAR_MAX = 720;

interface RightSidebarState {
    open: boolean;
    width: number;
    tab: RightSidebarTab;
    /** Current canvas selection; ephemeral and deliberately excluded from persisted preferences. */
    canvasSessionId: string | null;
}

const KEY = "floq.right-sidebar.v1";
const TABS: RightSidebarTab[] = ["changes", "files", "conversations", "app"];
const clamp = (width: number) => Math.min(RIGHT_SIDEBAR_MAX, Math.max(RIGHT_SIDEBAR_MIN, Math.round(width)));

function load(): RightSidebarState {
    const fallback: RightSidebarState = { open: false, width: 360, tab: "changes", canvasSessionId: null };
    try {
        const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<RightSidebarState> | null;
        if (!value || typeof value !== "object") return fallback;
        return {
            open: value.open === true,
            width: typeof value.width === "number" && Number.isFinite(value.width) ? clamp(value.width) : fallback.width,
            tab: TABS.includes(value.tab as RightSidebarTab) ? (value.tab as RightSidebarTab) : fallback.tab,
            canvasSessionId: null,
        };
    } catch { return fallback; }
}

let state = load();
const listeners = new Set<() => void>();

function set(patch: Partial<RightSidebarState>) {
    state = { ...state, ...patch, ...(patch.width !== undefined ? { width: clamp(patch.width) } : {}) };
    try { localStorage.setItem(KEY, JSON.stringify({ open: state.open, width: state.width, tab: state.tab })); } catch { /* optional preference */ }
    listeners.forEach((listener) => listener());
}

export function useRightSidebar(): RightSidebarState {
    return useSyncExternalStore((callback) => { listeners.add(callback); return () => listeners.delete(callback); }, () => state, () => state);
}

export const setRightSidebarOpen = (open: boolean) => set({ open });
export const toggleRightSidebar = () => set({ open: !state.open });
export const setRightSidebarWidth = (width: number) => set({ width });
export const setRightSidebarTab = (tab: RightSidebarTab) => set({ tab });
export const setCanvasSidebarSession = (canvasSessionId: string | null) => {
    if (state.canvasSessionId !== canvasSessionId) set({ canvasSessionId });
};
/** Open the sidebar on a given tab (e.g. from the "Review project changes" button). */
export const openRightSidebar = (tab: RightSidebarTab) => set({ open: true, tab });
