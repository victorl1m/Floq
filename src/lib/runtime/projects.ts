import type { ProjectWorkspace, SessionSummary } from "./types";

export const SCRATCH = "Scratch";

export interface Project {
    /** Logical project root, or "" for scratch sessions. Individual sessions retain their own cwd. */
    cwd: string;
    label: string;
    sessions: SessionSummary[];
}

export interface ProjectEntry {
    id: string;
    label: string;
    repo?: { label: string; url: string; displayLabel?: string; folderId?: string | null; workspaceCwds?: string[] };
    cwd?: string;
    folderId: string | null;
    sessions: SessionSummary[];
}

export interface WorkspaceProjectMeta {
    cwd: string;
    displayLabel?: string;
    folderId?: string | null;
}

/** Resolve sessions to one canonical project's concrete workspace. Server workspace IDs are authoritative. */
export function sessionsForWorkspace(projectId: string, workspace: Pick<ProjectWorkspace, "id" | "cwd" | "sessionIds">, sessions: SessionSummary[]): SessionSummary[] {
    const ids = new Set(workspace.sessionIds);
    return sessions.filter((session) =>
        ids.has(session.id) ||
        (session.projectId === projectId && (session.worktreeId === workspace.id || session.cwd === workspace.cwd))
    );
}

/** Build sidebar entries before scratch cwd normalization so cloned workspace IDs stay attached to their repo. */
export function composeProjectEntries(
    sessions: SessionSummary[],
    recentRepos: ProjectEntry["repo"][],
    workspaceMeta: WorkspaceProjectMeta[],
    folderIds: string[],
): ProjectEntry[] {
    const live = sessions.filter((session) => session.provider !== "shell");
    const validFolders = new Set(folderIds);
    const remainingIds = new Set(live.map((session) => session.id));
    const result: ProjectEntry[] = [];
    for (const repo of recentRepos) {
        if (!repo) continue;
        const repoRoots = new Set(live.filter((session) => session.gitUrl === repo.url).map(projectPath));
        const rememberedCwds = new Set(repo.workspaceCwds ?? []);
        const repoSessions = live.filter((session) => session.gitUrl === repo.url || repoRoots.has(projectPath(session)) || rememberedCwds.has(projectPath(session)) || rememberedCwds.has(session.cwd));
        const byCwd = new Map<string, SessionSummary[]>();
        for (const session of repoSessions) {
            remainingIds.delete(session.id);
            const cwd = projectPath(session);
            byCwd.set(cwd, [...(byCwd.get(cwd) ?? []), session]);
        }
        const folderId = repo.folderId && validFolders.has(repo.folderId) ? repo.folderId : null;
        const baseLabel = repo.displayLabel?.trim() || repo.label;
        if (!byCwd.size) {
            result.push({ id: `repo:${repo.url}`, label: baseLabel, repo, folderId, sessions: [] });
            continue;
        }
        for (const [cwd, cwdSessions] of byCwd) {
            const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
            const label = byCwd.size > 1 ? `${baseLabel} · ${parts[parts.length - 1]}` : baseLabel;
            result.push({ id: `repo:${repo.url}:${cwd}`, label, repo, cwd, folderId, sessions: cwdSessions });
        }
    }

    const remaining = live.filter((session) => remainingIds.has(session.id));
    const remainingSessions = remaining.filter((session) => remainingIds.has(session.id));
    const remoteRoots = new Map<string, Set<string>>();
    for (const session of remainingSessions) {
        if (!session.gitUrl) continue;
        const roots = remoteRoots.get(session.gitUrl) ?? new Set<string>();
        roots.add(projectPath(session));
        remoteRoots.set(session.gitUrl, roots);
    }
    for (const [url, roots] of remoteRoots) {
        const repoSessions = remainingSessions.filter((session) => session.gitUrl === url || roots.has(projectPath(session)));
        const byCwd = new Map<string, SessionSummary[]>();
        for (const session of repoSessions) {
            remainingIds.delete(session.id);
            const cwd = projectPath(session);
            byCwd.set(cwd, [...(byCwd.get(cwd) ?? []), session]);
        }
        for (const [cwd, cwdSessions] of byCwd) {
            const meta = workspaceMeta.find((item) => item.cwd === cwd);
            const folderId = meta?.folderId && validFolders.has(meta.folderId) ? meta.folderId : null;
            const parts = cwd.split("/").filter(Boolean);
            const suffix = parts[parts.length - 1] ?? cwd;
            const baseLabel = meta?.displayLabel?.trim() || projectLabel(cwd, url);
            const label = meta?.displayLabel?.trim() || (byCwd.size > 1 ? `${baseLabel} · ${suffix}` : baseLabel);
            result.push({ id: `url:${url}:${cwd}`, label, cwd, folderId, sessions: cwdSessions });
        }
    }
    const ungrouped = remaining.filter((session) => remainingIds.has(session.id));
    for (const project of groupByProject(ungrouped)) {
        const meta = workspaceMeta.find((item) => item.cwd === project.cwd);
        const folderId = meta?.folderId && validFolders.has(meta.folderId) ? meta.folderId : null;
        result.push({ id: project.cwd || "scratch", label: meta?.displayLabel?.trim() || project.label, cwd: project.cwd || undefined, folderId, sessions: project.sessions });
    }
    return result.sort((a, b) => a.label.localeCompare(b.label));
}

/** Sessions created without a project directory get an auto "workspace/<id>" cwd. */
function isScratch(cwd: string): boolean {
    return !cwd || /^(\.\/)?workspace\/[0-9a-f]{8}$/i.test(cwd.replace(/\\/g, "/"));
}

export function projectLabel(cwd: string, gitUrl?: string | null): string {
    if (gitUrl) {
        const clean = gitUrl.trim().replace(/\.git\/?$/i, "").replace(/\/$/, "");
        const parts = clean.split(/[/:]/).filter(Boolean);
        if (parts.length) return parts.slice(-2).join("/");
    }
    if (isScratch(cwd)) return SCRATCH;
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
}

export function groupByProject(sessions: SessionSummary[]): Project[] {
    const map = new Map<string, Project>();
    for (const session of sessions) {
        const logicalCwd = projectPath(session);
        const cwd = session.projectCwd !== null && session.projectCwd !== undefined
            ? logicalCwd
            : isScratch(logicalCwd) ? "" : logicalCwd;
        let project = map.get(cwd);
        if (!project) {
            project = { cwd, label: projectLabel(cwd), sessions: [] };
            map.set(cwd, project);
        }
        project.sessions.push(session);
    }
    // Real projects first (alphabetical), scratch last.
    return [...map.values()].sort((a, b) => {
        if (a.cwd === "") return 1;
        if (b.cwd === "") return -1;
        return a.label.localeCompare(b.label);
    });
}

function projectPath(session: SessionSummary): string {
    return session.projectCwd ?? session.cwd;
}
