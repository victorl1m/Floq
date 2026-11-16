import { useCallback, useSyncExternalStore } from "react";
import type { ProviderId } from "./runtime/types";

// Client-only preferences, persisted in localStorage (every access is guarded).

function read(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function write(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        /* ignore */
    }
}

// --- terminal appearance ---

export type CursorStyle = "block" | "bar" | "underline";

export interface TerminalPrefs {
    fontSize: number;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
}

const TERMINAL_KEY = "floq.terminal";
const TERMINAL_EVENT = "floq:terminal-prefs";
export const TERMINAL_DEFAULTS: TerminalPrefs = { fontSize: 13, cursorStyle: "block", cursorBlink: true };

let terminalRaw: string | null | undefined;
let terminalCache: TerminalPrefs = TERMINAL_DEFAULTS;

export function loadTerminalPrefs(): TerminalPrefs {
    const raw = read(TERMINAL_KEY);
    if (raw === terminalRaw) return terminalCache;
    terminalRaw = raw;
    try {
        const v = raw ? (JSON.parse(raw) as Partial<TerminalPrefs>) : {};
        terminalCache = {
            fontSize: typeof v.fontSize === "number" ? Math.min(18, Math.max(11, v.fontSize)) : TERMINAL_DEFAULTS.fontSize,
            cursorStyle: v.cursorStyle === "bar" || v.cursorStyle === "underline" ? v.cursorStyle : "block",
            cursorBlink: v.cursorBlink !== false,
        };
    } catch {
        terminalCache = TERMINAL_DEFAULTS;
    }
    return terminalCache;
}

function subscribeTerminal(callback: () => void) {
    window.addEventListener(TERMINAL_EVENT, callback);
    return () => window.removeEventListener(TERMINAL_EVENT, callback);
}

export function useTerminalPrefs(): [TerminalPrefs, (patch: Partial<TerminalPrefs>) => void] {
    const prefs = useSyncExternalStore(subscribeTerminal, loadTerminalPrefs, () => TERMINAL_DEFAULTS);
    const update = useCallback((patch: Partial<TerminalPrefs>) => {
        write(TERMINAL_KEY, JSON.stringify({ ...loadTerminalPrefs(), ...patch }));
        window.dispatchEvent(new Event(TERMINAL_EVENT));
    }, []);
    return [prefs, update];
}

// --- terminal memory/performance ---

export type PerformanceMode = "automatic" | "balanced" | "low-memory" | "custom";

export interface PerformancePrefs {
    mode: PerformanceMode;
    scrollback: number;
    /** Hidden terminal tabs of the current project kept mounted; the rest reload when shown. */
    warmTerminals: number;
    reduceMotion: boolean;
    smoothTerminalScrolling: boolean;
    reduceBackgroundRefresh: boolean;
}

const PERFORMANCE_KEY = "floq.performance";
const PERFORMANCE_EVENT = "floq:performance-prefs";
const PERFORMANCE_DEFAULTS: PerformancePrefs = {
    mode: "automatic",
    scrollback: 3_000,
    warmTerminals: 0,
    reduceMotion: false,
    smoothTerminalScrolling: false,
    reduceBackgroundRefresh: false,
};
const MAX_WARM_TERMINALS = 6;
const MIN_SCROLLBACK = 1_000;
const MAX_SCROLLBACK = 20_000;

let performanceRaw: string | null | undefined;
let performanceCache: PerformancePrefs = PERFORMANCE_DEFAULTS;

function boundedWarmTerminals(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return PERFORMANCE_DEFAULTS.warmTerminals;
    return Math.min(MAX_WARM_TERMINALS, Math.max(0, Math.round(value)));
}

function boundedScrollback(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return PERFORMANCE_DEFAULTS.scrollback;
    return Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(value / 1_000) * 1_000));
}

export function loadPerformancePrefs(): PerformancePrefs {
    const raw = read(PERFORMANCE_KEY);
    if (raw === performanceRaw) return performanceCache;
    performanceRaw = raw;
    try {
        const value: unknown = raw ? JSON.parse(raw) : null;
        const parsed = value && typeof value === "object" ? value as Partial<PerformancePrefs> : {};
        const mode: PerformanceMode = parsed.mode === "balanced" || parsed.mode === "low-memory" || parsed.mode === "custom"
            ? parsed.mode
            : "automatic";
        performanceCache = {
            mode,
            scrollback: boundedScrollback(parsed.scrollback),
            warmTerminals: boundedWarmTerminals(parsed.warmTerminals),
            reduceMotion: parsed.reduceMotion === true,
            smoothTerminalScrolling: parsed.smoothTerminalScrolling === true,
            reduceBackgroundRefresh: parsed.reduceBackgroundRefresh === true,
        };
    } catch {
        performanceCache = PERFORMANCE_DEFAULTS;
    }
    return performanceCache;
}

/** Device RAM is intentionally a coarse hint: many desktop WebViews do not expose it. */
export function recommendedScrollback(): number {
    const memory = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
    return typeof memory === "number" && memory > 0 && memory < 8 ? 2_500 : 3_000;
}

export function effectiveScrollback(prefs = loadPerformancePrefs()): number {
    if (prefs.mode === "low-memory") return 2_500;
    if (prefs.mode === "custom") return boundedScrollback(prefs.scrollback);
    return prefs.mode === "automatic" ? recommendedScrollback() : 10_000;
}

export function runtimePollInterval(hidden: boolean, reduceBackgroundRefresh: boolean): number {
    return hidden && reduceBackgroundRefresh ? 30_000 : 5_000;
}

function subscribePerformance(callback: () => void) {
    window.addEventListener(PERFORMANCE_EVENT, callback);
    window.addEventListener("storage", callback);
    return () => {
        window.removeEventListener(PERFORMANCE_EVENT, callback);
        window.removeEventListener("storage", callback);
    };
}

export function usePerformancePrefs(): [PerformancePrefs, (patch: Partial<PerformancePrefs>) => void] {
    const prefs = useSyncExternalStore(subscribePerformance, loadPerformancePrefs, () => PERFORMANCE_DEFAULTS);
    const update = useCallback((patch: Partial<PerformancePrefs>) => {
        const current = loadPerformancePrefs();
        const next: PerformancePrefs = {
            ...current,
            ...patch,
            scrollback: boundedScrollback(patch.scrollback ?? current.scrollback),
            warmTerminals: boundedWarmTerminals(patch.warmTerminals ?? current.warmTerminals),
        };
        write(PERFORMANCE_KEY, JSON.stringify(next));
        window.dispatchEvent(new Event(PERFORMANCE_EVENT));
    }, []);
    return [prefs, update];
}

// --- resume sleeping agents on click ---

const AUTO_RESUME_KEY = "floq.autoResumeOnClick";
const AUTO_RESUME_EVENT = "floq:auto-resume-pref";

/** Off by default. When on, clicking a sleeping session in the sidebar or a tab resumes it. */
export function loadAutoResumeOnClick(): boolean {
    return read(AUTO_RESUME_KEY) === "1";
}

function subscribeAutoResume(callback: () => void) {
    window.addEventListener(AUTO_RESUME_EVENT, callback);
    window.addEventListener("storage", callback);
    return () => {
        window.removeEventListener(AUTO_RESUME_EVENT, callback);
        window.removeEventListener("storage", callback);
    };
}

export function useAutoResumeOnClick(): [boolean, (value: boolean) => void] {
    const value = useSyncExternalStore(subscribeAutoResume, loadAutoResumeOnClick, () => false);
    const update = useCallback((next: boolean) => {
        write(AUTO_RESUME_KEY, next ? "1" : "0");
        window.dispatchEvent(new Event(AUTO_RESUME_EVENT));
    }, []);
    return [value, update];
}

// --- Home composer (last used / defaults) ---

export type Folder =
    | { kind: "none" }
    | { kind: "project"; cwd: string; label?: string }
    | { kind: "git"; url: string; label: string };

export interface ComposerPrefs {
    provider: ProviderId;
    folder: Folder;
    /** Last chosen model id per provider ("" = default). */
    models: Record<string, string>;
}

const COMPOSER_KEY = "floq.composer";

export function loadComposerPrefs(): ComposerPrefs {
    const fallback: ComposerPrefs = { provider: "claude", folder: { kind: "none" }, models: {} };
    try {
        const raw = read(COMPOSER_KEY);
        if (!raw) return fallback;
        const value = JSON.parse(raw) as Partial<ComposerPrefs>;
        return {
            provider: value.provider === "codex" || value.provider === "opencode" || value.provider === "antigravity" ? value.provider : "claude",
            folder:
                value.folder?.kind === "project" && value.folder.cwd
                    ? { kind: "project", cwd: value.folder.cwd, ...(typeof value.folder.label === "string" ? { label: value.folder.label } : {}) }
                    : value.folder?.kind === "git" && value.folder.url
                      ? value.folder
                      : { kind: "none" },
            models: value.models && typeof value.models === "object" ? value.models : {},
        };
    } catch {
        return fallback;
    }
}

export function saveComposerPrefs(prefs: ComposerPrefs) {
    write(COMPOSER_KEY, JSON.stringify(prefs));
}

// --- recently cloned repositories ---

export interface RecentRepo {
    label: string;
    url: string;
    displayLabel?: string;
    folderId?: string | null;
    workspaceCwds?: string[];
}

export function repoLabelFromUrl(url: string): string {
    const clean = url.trim().replace(/\.git\/?$/i, "").replace(/\/$/, "");
    const parts = clean.split(/[/:]/).filter(Boolean);
    return parts.slice(-2).join("/") || clean;
}

export interface ProjectFolder {
    id: string;
    name: string;
}

export interface CanonicalProjectMeta {
    projectId: string;
    folderId?: string | null;
}

export interface WorkspaceProjectMeta {
    cwd: string;
    displayLabel?: string;
    folderId?: string | null;
}

export interface LegacyProjectPrefs {
    displayName?: string;
    folderId?: string | null;
}

/** Match old local project preferences against a canonical project without changing repository paths. */
export function legacyPrefsForProject(
    project: { cwd: string; gitUrl: string | null; workspaces: Array<{ cwd: string }> },
    repos: RecentRepo[],
    workspaceMeta: WorkspaceProjectMeta[],
): LegacyProjectPrefs {
    const workspaces = new Set([project.cwd, ...project.workspaces.map((workspace) => workspace.cwd)]);
    const repo = repos.find((entry) =>
        (project.gitUrl !== null && entry.url === project.gitUrl) ||
        (entry.workspaceCwds ?? []).some((cwd) => workspaces.has(cwd)),
    );
    const workspaceEntries = workspaceMeta.filter((entry) => workspaces.has(entry.cwd));
    const namedWorkspace = workspaceEntries.find((entry) => !!entry.displayLabel?.trim());
    const folderWorkspace = workspaceEntries.find((entry) => entry.folderId !== undefined);
    const result: LegacyProjectPrefs = {};
    const displayName = repo?.displayLabel?.trim() || namedWorkspace?.displayLabel?.trim();
    if (displayName) result.displayName = displayName;
    if (repo?.folderId !== undefined) result.folderId = repo.folderId;
    else if (folderWorkspace) result.folderId = folderWorkspace.folderId;
    return result;
}

export function canonicalProjectPrefsMigrationKey(scope: string): string {
    return `floq.canonicalProjectPrefsMigrated.${encodeURIComponent(scope)}`;
}

export function projectScope(baseUrl: string | null, userId: string | null, organizationId?: string | null): string {
    return `${baseUrl ?? "offline"}:${userId ?? "anonymous"}${organizationId ? `:org:${organizationId}` : ""}`;
}

const RECENT_KEY = "floq.recentRepos";
const RECENT_EVENT = "floq:recent-repos";
const CANONICAL_PROJECT_EVENT = "floq:canonical-projects";
const recentCache = new Map<string, { raw: string | null; value: RecentRepo[] }>();
const folderCache = new Map<string, { raw: string | null; value: ProjectFolder[] }>();
const workspaceCache = new Map<string, { raw: string | null; value: WorkspaceProjectMeta[] }>();
const canonicalProjectCache = new Map<string, { raw: string | null; value: CanonicalProjectMeta[] }>();
const EMPTY_RECENT: RecentRepo[] = [];
const EMPTY_FOLDERS: ProjectFolder[] = [];

function foldersKey(scope: string): string {
    return `floq.projectFolders.${encodeURIComponent(scope)}`;
}

function workspaceMetaKey(scope: string): string {
    return `floq.workspaceProjects.${encodeURIComponent(scope)}`;
}

function canonicalProjectMetaKey(scope: string): string {
    return `floq.canonicalProjects.${encodeURIComponent(scope)}`;
}

export function loadCanonicalProjectMeta(scope: string): CanonicalProjectMeta[] {
    try {
        const key = canonicalProjectMetaKey(scope);
        const raw = read(key);
        const cached = canonicalProjectCache.get(key);
        if (cached?.raw === raw) return cached.value;
        const parsed: unknown = JSON.parse(raw ?? "[]");
        const value = Array.isArray(parsed) ? parsed.filter((entry) =>
            typeof entry?.projectId === "string" && !!entry.projectId &&
            (entry.folderId === undefined || entry.folderId === null || typeof entry.folderId === "string")
        ) as CanonicalProjectMeta[] : [];
        canonicalProjectCache.set(key, { raw, value });
        return value;
    } catch {
        return [];
    }
}

export function updateCanonicalProjectMeta(projectId: string, patch: Partial<CanonicalProjectMeta>, scope: string): void {
    const entries = loadCanonicalProjectMeta(scope);
    const current = entries.find((entry) => entry.projectId === projectId) ?? { projectId };
    const next = { ...current, ...patch };
    write(canonicalProjectMetaKey(scope), JSON.stringify([...entries.filter((entry) => entry.projectId !== projectId), next]));
    window.dispatchEvent(new Event(CANONICAL_PROJECT_EVENT));
}

export function useCanonicalProjectMeta(scope: string): CanonicalProjectMeta[] {
    const subscribe = useCallback((callback: () => void) => {
        window.addEventListener(CANONICAL_PROJECT_EVENT, callback);
        window.addEventListener("storage", callback);
        return () => {
            window.removeEventListener(CANONICAL_PROJECT_EVENT, callback);
            window.removeEventListener("storage", callback);
        };
    }, []);
    const snapshot = useCallback(() => loadCanonicalProjectMeta(scope), [scope]);
    return useSyncExternalStore(subscribe, snapshot, () => []);
}

function recentKey(scope: string): string {
    return `${RECENT_KEY}.${encodeURIComponent(scope)}`;
}

export function loadRecentRepos(scope = "legacy"): RecentRepo[] {
    try {
        const key = recentKey(scope);
        let raw = read(key);
        // Older builds kept imported repositories globally. Migrate those once, to the first
        // signed-in account that reads them, then remove the unscoped copy.
        if (scope !== "legacy" && raw === null) {
            const legacy = read(RECENT_KEY);
            if (legacy !== null) {
                raw = legacy;
                write(key, legacy);
                write(RECENT_KEY, "[]");
            }
        }
        const cached = recentCache.get(key);
        if (cached?.raw === raw) return cached.value;
        const list = JSON.parse(raw ?? "[]") as RecentRepo[];
        const value = Array.isArray(list)
            ? list.filter((r) => typeof r?.url === "string" && !!r.url && typeof r?.label === "string" && !!r.label).slice(0, 50).map((r) => ({
                label: r.label,
                url: r.url,
                ...(typeof r.displayLabel === "string" && r.displayLabel.trim() ? { displayLabel: r.displayLabel.trim().slice(0, 60) } : {}),
                ...(typeof r.folderId === "string" ? { folderId: r.folderId } : r.folderId === null ? { folderId: null } : {}),
                ...(Array.isArray(r.workspaceCwds) ? { workspaceCwds: r.workspaceCwds.filter((cwd: unknown): cwd is string => typeof cwd === "string") } : {}),
            }))
            : [];
        recentCache.set(key, { raw, value });
        return value;
    } catch {
        return [];
    }
}

export function addRecentRepo(repo: RecentRepo, scope = "legacy"): RecentRepo[] {
    const existing = loadRecentRepos(scope).find((r) => r.url === repo.url);
    const next = [{ ...existing, ...repo, displayLabel: existing?.displayLabel, folderId: existing?.folderId, workspaceCwds: existing?.workspaceCwds }, ...loadRecentRepos(scope).filter((r) => r.url !== repo.url)].slice(0, 50);
    write(recentKey(scope), JSON.stringify(next));
    window.dispatchEvent(new Event(RECENT_EVENT));
    return next;
}

export function removeRecentRepo(url: string, scope = "legacy"): RecentRepo[] {
    const next = loadRecentRepos(scope).filter((repo) => repo.url !== url);
    write(recentKey(scope), JSON.stringify(next));
    window.dispatchEvent(new Event(RECENT_EVENT));
    return next;
}

function updateRepo(url: string, scope: string, update: (repo: RecentRepo) => RecentRepo): RecentRepo[] {
    const repos = loadRecentRepos(scope).map((repo) => repo.url === url ? update(repo) : repo);
    write(recentKey(scope), JSON.stringify(repos));
    window.dispatchEvent(new Event(RECENT_EVENT));
    return repos;
}

export function renameRecentRepo(url: string, name: string, scope: string): void {
    updateRepo(url, scope, (repo) => ({ ...repo, displayLabel: name.trim() || undefined }));
}

export function moveRecentRepo(url: string, folderId: string | null, scope: string): void {
    updateRepo(url, scope, (repo) => ({ ...repo, folderId }));
}

export function linkRepoWorkspace(url: string, cwd: string, scope: string): void {
    updateRepo(url, scope, (repo) => ({ ...repo, workspaceCwds: [...new Set([...(repo.workspaceCwds ?? []), cwd])] }));
}

export function loadProjectFolders(scope: string): ProjectFolder[] {
    try {
        const key = foldersKey(scope);
        const raw = read(key);
        const cached = folderCache.get(key);
        if (cached?.raw === raw) return cached.value;
        const parsed: unknown = JSON.parse(raw ?? "[]");
        const value = Array.isArray(parsed)
            ? parsed.filter((f): f is ProjectFolder => typeof f?.id === "string" && typeof f?.name === "string" && !!f.name.trim())
            : EMPTY_FOLDERS;
        folderCache.set(key, { raw, value });
        return value;
    } catch {
        return EMPTY_FOLDERS;
    }
}

export function saveProjectFolders(scope: string, folders: ProjectFolder[]): void {
    write(foldersKey(scope), JSON.stringify(folders));
    window.dispatchEvent(new Event(RECENT_EVENT));
}

export function removeProjectFolder(scope: string, folderId: string): void {
    saveProjectFolders(scope, loadProjectFolders(scope).filter((folder) => folder.id !== folderId));
    const repos = loadRecentRepos(scope).map((repo) => repo.folderId === folderId ? { ...repo, folderId: null } : repo);
    write(recentKey(scope), JSON.stringify(repos));
    const workspaceProjects = loadWorkspaceProjectMeta(scope).map((project) => project.folderId === folderId ? { ...project, folderId: null } : project);
    saveWorkspaceProjectMeta(scope, workspaceProjects);
    const canonicalProjects = loadCanonicalProjectMeta(scope).map((project) => project.folderId === folderId ? { ...project, folderId: null } : project);
    write(canonicalProjectMetaKey(scope), JSON.stringify(canonicalProjects));
    window.dispatchEvent(new Event(CANONICAL_PROJECT_EVENT));
    window.dispatchEvent(new Event(RECENT_EVENT));
}

export function loadWorkspaceProjectMeta(scope: string): WorkspaceProjectMeta[] {
    try {
        const key = workspaceMetaKey(scope);
        const raw = read(key);
        const cached = workspaceCache.get(key);
        if (cached?.raw === raw) return cached.value;
        const parsed: unknown = JSON.parse(raw ?? "[]");
        const value = Array.isArray(parsed) ? parsed.filter((entry) =>
            typeof entry?.cwd === "string" && !!entry.cwd &&
            (entry.displayLabel === undefined || typeof entry.displayLabel === "string") &&
            (entry.folderId === undefined || entry.folderId === null || typeof entry.folderId === "string")
        ) as WorkspaceProjectMeta[] : [];
        workspaceCache.set(key, { raw, value });
        return value;
    } catch {
        return EMPTY_WORKSPACES;
    }
}

const EMPTY_WORKSPACES: WorkspaceProjectMeta[] = [];

export function saveWorkspaceProjectMeta(scope: string, projects: WorkspaceProjectMeta[]): void {
    write(workspaceMetaKey(scope), JSON.stringify(projects));
    window.dispatchEvent(new Event(RECENT_EVENT));
}

export function updateWorkspaceProject(cwd: string, patch: Partial<WorkspaceProjectMeta>, scope: string): void {
    const projects = loadWorkspaceProjectMeta(scope);
    const current = projects.find((project) => project.cwd === cwd) ?? { cwd };
    const next = { ...current, ...patch };
    saveWorkspaceProjectMeta(scope, [...projects.filter((project) => project.cwd !== cwd), next]);
}

export function useWorkspaceProjectMeta(scope: string): WorkspaceProjectMeta[] {
    const subscribe = useCallback((callback: () => void) => {
        window.addEventListener(RECENT_EVENT, callback);
        window.addEventListener("storage", callback);
        return () => {
            window.removeEventListener(RECENT_EVENT, callback);
            window.removeEventListener("storage", callback);
        };
    }, []);
    const snapshot = useCallback(() => loadWorkspaceProjectMeta(scope), [scope]);
    return useSyncExternalStore(subscribe, snapshot, () => EMPTY_WORKSPACES);
}

export function selectRecentRepo(repo: RecentRepo) {
    const prefs = loadComposerPrefs();
    saveComposerPrefs({ ...prefs, folder: { kind: "git", ...repo } });
    window.dispatchEvent(new Event("floq:composer-prefs"));
}

export function useRecentRepos(scope: string): RecentRepo[] {
    const subscribe = useCallback((callback: () => void) => {
        window.addEventListener(RECENT_EVENT, callback);
        window.addEventListener("storage", callback);
        return () => {
            window.removeEventListener(RECENT_EVENT, callback);
            window.removeEventListener("storage", callback);
        };
    }, []);
    const snapshot = useCallback(() => loadRecentRepos(scope), [scope]);
    return useSyncExternalStore(subscribe, snapshot, () => EMPTY_RECENT);
}

export function useProjectFolders(scope: string): ProjectFolder[] {
    const subscribe = useCallback((callback: () => void) => {
        window.addEventListener(RECENT_EVENT, callback);
        window.addEventListener("storage", callback);
        return () => {
            window.removeEventListener(RECENT_EVENT, callback);
            window.removeEventListener("storage", callback);
        };
    }, []);
    const snapshot = useCallback(() => loadProjectFolders(scope), [scope]);
    return useSyncExternalStore(subscribe, snapshot, () => []);
}
