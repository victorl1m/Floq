import { useMemo } from "react";
import { sessionsForWorkspace } from "@/lib/runtime/projects";
import { useRuntime } from "@/lib/runtime/store";
import { useRightSidebar } from "@/lib/right-sidebar";
import { isLive } from "../provider";
import type { WorkspaceTarget } from "./changes-tab";

/** The project / workspace / session the project panel (and the Changes dialog) currently refer to, plus the folders reachable through sessions. */
export function usePanelContext() {
  const { sessions, projects, view, selectedId, selectedTerminalId, activeProjectId, canvasProjectId, activeWorkspaceId } = useRuntime();
  const { canvasSessionId } = useRightSidebar();
  const inWorkspaceView = view === "terminal" || view === "session";
  const activeId = view === "terminal" ? selectedTerminalId : view === "session" ? selectedId : null;
  const canvasSelection = view === "canvas" && canvasSessionId
    ? sessions.find((item) => item.id === canvasSessionId && item.projectId === canvasProjectId && item.provider !== "shell")
    : undefined;
  const activeSession = view === "canvas" ? canvasSelection : sessions.find((item) => item.id === activeId);
  // Closing the last tab leaves no active session; the panel must stay on the same project so its closed
  // conversations can be restored, and Changes/Files fall back to that project's newest session.
  const projectId = view === "canvas"
    ? activeSession?.projectId ?? canvasProjectId
    : activeSession ? activeSession.projectId ?? null : inWorkspaceView ? activeProjectId : null;
  const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
  const canvasWorkspace = view === "canvas" && project
    ? activeSession
      ? project.workspaces.find((workspace) => sessionsForWorkspace(project.id, workspace, sessions).some((item) => item.id === activeSession.id))
      : project.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    : undefined;
  const session = useMemo(() => {
    if (activeSession) return activeSession;
    if (!projectId) return undefined;
    const mine = view === "canvas"
      ? canvasWorkspace ? sessionsForWorkspace(projectId, canvasWorkspace, sessions).filter((item) => item.provider !== "shell") : []
      : sessions.filter((item) => item.provider !== "shell" && item.projectId === projectId);
    const stamp = (item: (typeof mine)[number]) => Date.parse(item.endedAt ?? item.startedAt ?? item.createdAt) || 0;
    return mine.find((item) => isLive(item.state)) ?? mine.sort((a, b) => stamp(b) - stamp(a))[0];
  }, [activeSession, projectId, sessions, view, canvasWorkspace]);
  // Changes and Files span every folder / worktree of the project, each reached through one of its sessions.
  const targets = useMemo<WorkspaceTarget[]>(() => {
    if (view === "canvas") {
      if (!project || !canvasWorkspace || !session) return [];
      return [{ id: canvasWorkspace.id, label: canvasWorkspace.name || canvasWorkspace.cwd, branch: canvasWorkspace.branch, sessionId: session.id }];
    }
    const result: WorkspaceTarget[] = [];
    const stamp = (item: (typeof sessions)[number]) => Date.parse(item.createdAt) || 0;
    for (const workspace of project?.workspaces ?? []) {
      const members = sessionsForWorkspace(project!.id, workspace, sessions);
      const rep = members.find((item) => item.id === activeSession?.id) ?? [...members].sort((a, b) => stamp(b) - stamp(a))[0];
      if (rep) result.push({ id: workspace.id, label: workspace.name || workspace.cwd, branch: workspace.branch, sessionId: rep.id });
    }
    if (result.length === 0 && session) result.push({ id: session.worktreeId ?? session.cwd, label: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace", branch: session.branch ?? null, sessionId: session.id });
    return result;
  }, [project, sessions, activeSession, session, view, canvasWorkspace]);
  return { session, activeSession, projectId, project, canvasWorkspace, targets, view };
}
