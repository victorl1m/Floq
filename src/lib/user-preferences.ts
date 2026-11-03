export interface UserPreferences {
    version: 1;
    activeTeamId: string | null;
    sidebarOpen: boolean;
    taskNavigatorOpen: boolean;
}

export type UserPreferencePatch = Partial<Omit<UserPreferences, "version">>;

export const USER_PREFERENCE_DEFAULTS: UserPreferences = {
    version: 1,
    activeTeamId: null,
    sidebarOpen: true,
    taskNavigatorOpen: true,
};

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
        return {
            version: 1,
            activeTeamId: typeof parsed.activeTeamId === "string" ? parsed.activeTeamId : null,
            sidebarOpen: typeof parsed.sidebarOpen === "boolean" ? parsed.sidebarOpen : true,
            taskNavigatorOpen: typeof parsed.taskNavigatorOpen === "boolean" ? parsed.taskNavigatorOpen : true,
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
