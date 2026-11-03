export interface UserPreferences {
    version: 1;
    activeOrganizationId: string | null;
    sidebarOpen: boolean;
    taskNavigatorOpen: boolean;
    projectNavExpanded: Record<string, boolean>;
    workspaceNavExpanded: Record<string, boolean>;
    folderNavExpanded: Record<string, boolean>;
    /** Sessions whose tab was closed: hidden from the left sidebar, still listed under Conversations. */
    hiddenSessionIds: Record<string, boolean>;
    /** Dragged Agent Canvas node positions: project id -> session id -> position. */
    canvasPositions: Record<string, Record<string, { x: number; y: number }>>;
    /** Resized Agent Canvas node sizes: project id -> session id -> size. */
    canvasSizes: Record<string, Record<string, { width: number; height: number }>>;
    /** Last Agent Canvas viewport per project, restored on open instead of re-fitting. */
    canvasViewports: Record<string, { x: number; y: number; zoom: number }>;
    /** Project whose Agent Canvas was open last; restored after a reload. */
    lastCanvasProjectId: string | null;
    /** Ports last forwarded by hand, per session id (most recent first), offered as one-click chips. */
    recentForwardPorts: Record<string, number[]>;
}

export type UserPreferencePatch = Partial<Omit<UserPreferences, "version">>;

export const USER_PREFERENCE_DEFAULTS: UserPreferences = {
    version: 1,
    activeOrganizationId: null,
    sidebarOpen: true,
    taskNavigatorOpen: true,
    projectNavExpanded: {},
    workspaceNavExpanded: {},
    folderNavExpanded: {},
    hiddenSessionIds: {},
    canvasPositions: {},
    canvasSizes: {},
    canvasViewports: {},
    lastCanvasProjectId: null,
    recentForwardPorts: {},
};

function portListMap(value: unknown): Record<string, number[]> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, number[]> = {};
    for (const [id, list] of Object.entries(value)) {
        if (!Array.isArray(list)) continue;
        result[id] = list.filter((port): port is number => Number.isInteger(port) && port >= 1024 && port <= 65535).slice(0, 5);
    }
    return result;
}

function positionMaps(value: unknown): UserPreferences["canvasPositions"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: UserPreferences["canvasPositions"] = {};
    for (const [project, nodes] of Object.entries(value)) {
        if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) continue;
        const positions: Record<string, { x: number; y: number }> = {};
        for (const [id, point] of Object.entries(nodes)) {
            const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown };
            if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x, y };
        }
        result[project] = positions;
    }
    return result;
}

function sizeMaps(value: unknown): UserPreferences["canvasSizes"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: UserPreferences["canvasSizes"] = {};
    for (const [project, nodes] of Object.entries(value)) {
        if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) continue;
        const sizes: Record<string, { width: number; height: number }> = {};
        for (const [id, size] of Object.entries(nodes)) {
            const { width, height } = (size ?? {}) as { width?: unknown; height?: unknown };
            if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width >= 100 && height >= 60 && width <= 4000 && height <= 4000) sizes[id] = { width, height };
        }
        result[project] = sizes;
    }
    return result;
}

function viewportMap(value: unknown): UserPreferences["canvasViewports"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: UserPreferences["canvasViewports"] = {};
    for (const [project, view] of Object.entries(value)) {
        const { x, y, zoom } = (view ?? {}) as { x?: unknown; y?: unknown; zoom?: unknown };
        if (typeof x === "number" && typeof y === "number" && typeof zoom === "number" && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom > 0 && zoom <= 8) result[project] = { x, y, zoom };
    }
    return result;
}

function booleanMap(value: unknown): Record<string, boolean> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}

function storage(): Storage | null {
    try { return localStorage; } catch { return null; }
}

export function userPreferenceKey(baseUrl: string | null, userId: string | null): string | null {
    if (!baseUrl || !userId) return null;
    return `floq.user-preferences.v1:${encodeURIComponent(baseUrl.replace(/\/+$/, ""))}:${encodeURIComponent(userId)}`;
}

export function loadUserPreferences(baseUrl: string | null, userId: string | null): UserPreferences {
    const key = userPreferenceKey(baseUrl, userId);
    const local = storage();
    if (!key || !local) return USER_PREFERENCE_DEFAULTS;
    try {
        const value: unknown = JSON.parse(local.getItem(key) ?? "null");
        if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return USER_PREFERENCE_DEFAULTS;
        const parsed = value as Partial<UserPreferences>;
        const legacy = value as { activeTeamId?: unknown }; // pre-rename persisted key
        return {
            version: 1,
            activeOrganizationId: typeof parsed.activeOrganizationId === "string" ? parsed.activeOrganizationId : typeof legacy.activeTeamId === "string" ? legacy.activeTeamId : null,
            sidebarOpen: typeof parsed.sidebarOpen === "boolean" ? parsed.sidebarOpen : true,
            taskNavigatorOpen: typeof parsed.taskNavigatorOpen === "boolean" ? parsed.taskNavigatorOpen : true,
            projectNavExpanded: booleanMap(parsed.projectNavExpanded),
            workspaceNavExpanded: booleanMap(parsed.workspaceNavExpanded),
            folderNavExpanded: booleanMap(parsed.folderNavExpanded),
            hiddenSessionIds: booleanMap(parsed.hiddenSessionIds),
            canvasPositions: positionMaps(parsed.canvasPositions),
            canvasSizes: sizeMaps(parsed.canvasSizes),
            canvasViewports: viewportMap(parsed.canvasViewports),
            lastCanvasProjectId: typeof parsed.lastCanvasProjectId === "string" ? parsed.lastCanvasProjectId : null,
            recentForwardPorts: portListMap(parsed.recentForwardPorts),
        };
    } catch { return USER_PREFERENCE_DEFAULTS; }
}

export function saveUserPreferences(baseUrl: string | null, userId: string | null, patch: UserPreferencePatch, fallback?: UserPreferences): UserPreferences {
    const local = storage();
    const current = fallback ?? loadUserPreferences(baseUrl, userId);
    const next: UserPreferences = { ...current, ...patch, version: 1 };
    const key = userPreferenceKey(baseUrl, userId);
    if (!key || !local) return next;
    try { local.setItem(key, JSON.stringify(next)); } catch { /* Preferences are optional when storage is blocked or full. */ }
    return next;
}
