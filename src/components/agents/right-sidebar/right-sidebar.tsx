import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { IconAppWindow, IconChevronRight, IconFiles, IconGitCompare, IconMessages, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { sessionsForWorkspace } from "@/lib/runtime/projects";
import { useRuntime } from "@/lib/runtime/store";
import { usePerformancePrefs } from "@/lib/prefs";
import {
  RIGHT_SIDEBAR_MAX,
  RIGHT_SIDEBAR_MIN,
  setRightSidebarOpen,
  setRightSidebarTab,
  setRightSidebarWidth,
  RIGHT_SIDEBAR_DEFAULT,
  useRightSidebar,
  resolveRightSidebarTab,
  type RightSidebarTab,
} from "@/lib/right-sidebar";
import { isLive } from "../provider";
import ChangesTab, { type WorkspaceTarget } from "./changes-tab";
import AppWindowTab, { useDisplayAnnouncements } from "./app-window-tab";
import ConversationsTab from "./conversations-tab";
import FilesTab from "./files-tab";
import { PanelEmpty } from "./panel-states";
import { PluginBoundary, usePlugins } from "@/plugins/host";
import { resolvePluginIcon } from "@/plugins/icons";

const CORE_TAB_DEFS: Array<{ id: RightSidebarTab; label: string; icon: typeof IconFiles }> = [
  { id: "changes", label: "Changes", icon: IconGitCompare },
  { id: "files", label: "Files", icon: IconFiles },
  { id: "conversations", label: "Conversations", icon: IconMessages },
  { id: "app", label: "App window", icon: IconAppWindow },
];

function useNarrow(): boolean {
  const query = "(max-width: 1023px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** Shared project panel for agent workspaces and the selected canvas workspace. Overlays content on narrow windows. */
export default function RightSidebar() {
  const { client, sessions, projects, view, selectedId, selectedTerminalId, activeProjectId, canvasProjectId, activeWorkspaceId } = useRuntime();
  const { open, width, tab: storedTab, canvasSessionId } = useRightSidebar();
  // The four core tabs never change; enabled plugin tabs append. A stored tab of a disabled plugin falls back to Changes.
  const plugins = usePlugins();
  const pluginTabs = plugins.tabs;
  const TABS = useMemo(() => [...CORE_TAB_DEFS, ...pluginTabs.map((t) => ({ id: `plugin:${t.pluginId}/${t.tabId}` as RightSidebarTab, label: t.label, icon: resolvePluginIcon(t.icon) }))], [pluginTabs]);
  const tab = resolveRightSidebarTab(storedTab, TABS.map((t) => t.id));
  const narrow = useNarrow();
  const [performancePrefs] = usePerformancePrefs();
  const [reducedBySystem, setReducedBySystem] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const reducedMotion = reducedBySystem || performancePrefs.reduceMotion;
  const [present, setPresent] = useState(open);
  const [shown, setShown] = useState(open);
  const presentRef = useRef(open);
  const panelRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openFrame = useRef<number | undefined>(undefined);
  const drag = useRef<{ startX: number; startWidth: number; moved: boolean } | null>(null);
  const hideTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const [changeCount, setChangeCount] = useState<number | null>(null);
  useDisplayAnnouncements(client, sessions);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedBySystem(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    clearTimeout(closeTimer.current);
    cancelAnimationFrame(openFrame.current ?? 0);
    if (open) {
      if (!presentRef.current) {
        presentRef.current = true;
        setPresent(true);
        setShown(reducedMotion);
        if (!reducedMotion) openFrame.current = requestAnimationFrame(() => setShown(true));
      } else {
        setShown(true);
      }
    } else if (presentRef.current) {
      setShown(false);
      if (reducedMotion) {
        presentRef.current = false;
        setPresent(false);
      } else {
        closeTimer.current = setTimeout(() => {
          presentRef.current = false;
          setPresent(false);
        }, 160);
      }
    }
    return () => {
      clearTimeout(closeTimer.current);
      cancelAnimationFrame(openFrame.current ?? 0);
    };
  }, [open, reducedMotion]);

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
  const contextTarget = targets.find((target) => !activeSession || target.sessionId === activeSession.id) ?? targets[0];
  const contextWorkspaceLabel = contextTarget?.label ?? (view === "canvas" ? canvasWorkspace?.name || canvasWorkspace?.cwd : undefined);
  const conversationCount = useMemo(() => projectId === null && !activeSession ? 0 : sessions.filter((item) => item.provider !== "shell" && (item.projectId ?? null) === projectId).length, [sessions, projectId, activeSession]);
  const badges: Partial<Record<RightSidebarTab, number | null>> = { changes: changeCount, conversations: conversationCount };

  const contextAvailable = !!client && (!!activeSession || !!projectId);
  if (!present || !contextAvailable) return null;

  function closePanel() {
    if (panelRef.current?.contains(document.activeElement)) {
      document.querySelector<HTMLButtonElement>("[data-right-sidebar-trigger]")?.focus({ preventScroll: true });
    }
    setRightSidebarOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((item) => item.id === tab);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length];
    setRightSidebarTab(target.id);
    document.getElementById(`right-sidebar-tab-${target.id}`)?.focus();
  }

  function onResizeStart(event: PointerEvent<HTMLDivElement>) {
    window.clearTimeout(hideTimer.current);
    drag.current = { startX: event.clientX, startWidth: width, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onResizeMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    if (!state.moved && Math.abs(event.clientX - state.startX) < 3) return;
    state.moved = true;
    setRightSidebarWidth(state.startWidth + state.startX - event.clientX);
  }
  // Same as the left rail: a click without a drag hides the panel (after the double-click window), a double-click resets the width.
  function onResizeEnd(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    drag.current = null;
    if (state && !state.moved && event.type === "pointerup") hideTimer.current = window.setTimeout(closePanel, 250);
  }
  function onResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") { event.preventDefault(); setRightSidebarWidth(width + 24); }
    if (event.key === "ArrowRight") { event.preventDefault(); setRightSidebarWidth(width - 24); }
  }

  return (
    <aside
      ref={panelRef}
      aria-label="Project panel"
      aria-hidden={!open}
      inert={!open}
      data-state={open ? "open" : "closed"}
      style={{ width: narrow ? `min(${width}px, calc(100vw - 2rem))` : width }}
      className={cn(
        "floq-right-sidebar flex shrink-0 flex-col overflow-hidden border border-border/70 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
        "rounded-(--shell-radius)",
        shown ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-2 opacity-0",
        reducedMotion && "transition-none",
        // The app root is `min-h-svh` (not a fixed height), so a sibling whose height comes from its content stretches
        // the whole row and with it the terminal. The panel must have a definite height and scroll internally.
        narrow ? "fixed top-(--shell-top) right-0 bottom-(--shell-bottom) z-30 shadow-xl" : "relative mt-(--shell-top) mr-(--shell-gap) mb-(--shell-bottom) h-[calc(100svh-var(--shell-top)-var(--shell-bottom))]",
      )}
    >
      {!narrow && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize project panel"
          aria-valuemin={RIGHT_SIDEBAR_MIN}
          aria-valuemax={RIGHT_SIDEBAR_MAX}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onDoubleClick={() => { window.clearTimeout(hideTimer.current); setRightSidebarWidth(RIGHT_SIDEBAR_DEFAULT); }}
          title="Drag to resize, click to hide. Double-click to reset."
          onKeyDown={onResizeKey}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-ring/30 focus-visible:bg-ring/40 focus-visible:outline-none"
        />
      )}
      <div className="shrink-0 border-b border-border/70 px-3 pt-3 pb-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <div
            role="group"
            className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground"
            aria-label={`Project ${project?.displayName?.trim() || project?.name || "Unknown"}${contextWorkspaceLabel ? `, workspace ${contextWorkspaceLabel}` : ""}`}
            title={[project?.displayName?.trim() || project?.name, contextWorkspaceLabel].filter(Boolean).join(" / ")}
          >
            <span className="min-w-0 truncate font-medium text-foreground">{project?.displayName?.trim() || project?.name || "Project"}</span>
            {contextWorkspaceLabel && <><IconChevronRight aria-hidden className="size-3 shrink-0 opacity-60" /><span className="min-w-0 truncate">{contextWorkspaceLabel}</span></>}
          </div>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Close project panel" title="Close project panel" onClick={closePanel}><IconX /></Button>
        </div>
        <div className="mt-1 truncate text-sm font-medium" title={activeSession?.title ?? (view === "canvas" ? "Workspace overview" : "Project overview")}>
          {activeSession?.title ?? (view === "canvas" ? "Workspace overview" : "Project overview")}
        </div>
      </div>
      <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-2">
        <div role="tablist" aria-label="Project panel sections" onKeyDown={onKeyDown} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`right-sidebar-tab-${id}`}
              type="button"
              role="tab"
              aria-label={label}
              title={label}
              aria-selected={tab === id}
              aria-controls="right-sidebar-panel"
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setRightSidebarTab(id)}
              className={cn("flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === id ? "bg-muted/90 text-foreground" : "text-muted-foreground hover:bg-muted/55 hover:text-foreground")}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
              {!!badges[id] && <span className="shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-[10px] leading-4 text-muted-foreground tabular-nums">{badges[id]! > 99 ? "99+" : badges[id]}</span>}
            </button>
          ))}
        </div>
      </div>
      {/* Panels stay mounted so tree expansion, scroll and loaded diffs survive switching tabs. */}
      <div id="right-sidebar-panel" role="tabpanel" aria-labelledby={`right-sidebar-tab-${tab}`} className="min-h-0 flex-1">
        <div className={cn("h-full", tab !== "changes" && "hidden")}>
          {session ? <ChangesTab client={client} targets={targets} onCount={setChangeCount} /> : <PanelEmpty icon={<IconGitCompare />} title={view === "canvas" && !canvasWorkspace ? "No active workspace" : view === "canvas" ? "No agent in this workspace" : "No agent in this project"} hint={view === "canvas" && !canvasWorkspace ? "Choose a workspace for this project to review its changes." : "Start an agent in this workspace to review its changes."} />}
        </div>
        <div className={cn("h-full", tab !== "files" && "hidden")}>
          {session ? <FilesTab client={client} targets={targets} projectId={projectId} /> : <PanelEmpty icon={<IconFiles />} title={view === "canvas" && !canvasWorkspace ? "No active workspace" : view === "canvas" ? "No agent in this workspace" : "No agent in this project"} hint={view === "canvas" && !canvasWorkspace ? "Choose a workspace for this project to browse its files." : "Start an agent in this workspace to browse its files."} />}
        </div>
        <div className={cn("h-full", tab !== "conversations" && "hidden")}>
          <ConversationsTab projectId={projectId} project={project} />
        </div>
        {pluginTabs.filter((t) => tab === `plugin:${t.pluginId}/${t.tabId}`).map((t) => (
          <div key={`${t.pluginId}/${t.tabId}`} className="relative h-full">
            <PluginBoundary pluginId={t.pluginId}><t.Component plugin={t.plugin} tab={t.decl} /></PluginBoundary>
          </div>
        ))}
        <div className={cn("h-full", tab !== "app" && "hidden")}>
          <AppWindowTab client={client} session={activeSession ?? session} active={open && tab === "app"} />
        </div>
      </div>
    </aside>
  );
}
