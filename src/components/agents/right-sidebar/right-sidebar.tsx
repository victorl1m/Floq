import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { IconFiles, IconGitCompare, IconMessages, IconPlugConnected, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { sessionsForWorkspace } from "@/lib/runtime/projects";
import { useRuntime } from "@/lib/runtime/store";
import {
  RIGHT_SIDEBAR_MAX,
  RIGHT_SIDEBAR_MIN,
  setRightSidebarOpen,
  setRightSidebarTab,
  setRightSidebarWidth,
  useRightSidebar,
  type RightSidebarTab,
} from "@/lib/right-sidebar";
import { isLive } from "../provider";
import ChangesTab, { type WorkspaceTarget } from "./changes-tab";
import ConversationsTab from "./conversations-tab";
import FilesTab from "./files-tab";
import PortsTab from "./ports-tab";
import { PanelEmpty } from "./panel-states";

const TABS: Array<{ id: RightSidebarTab; label: string; icon: typeof IconFiles }> = [
  { id: "changes", label: "Changes", icon: IconGitCompare },
  { id: "files", label: "Files", icon: IconFiles },
  { id: "ports", label: "Ports", icon: IconPlugConnected },
  { id: "conversations", label: "Conversations", icon: IconMessages },
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

/** Right panel for the active session's project: changes, files and conversations. Overlays the content on narrow windows. */
export default function RightSidebar() {
  const { client, sessions, projects, view, selectedId, selectedTerminalId, activeProjectId } = useRuntime();
  const { open, width, tab } = useRightSidebar();
  const narrow = useNarrow();
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [changeCount, setChangeCount] = useState<number | null>(null);

  const inWorkspaceView = view === "terminal" || view === "session";
  const activeId = view === "terminal" ? selectedTerminalId : view === "session" ? selectedId : null;
  const activeSession = sessions.find((item) => item.id === activeId);
  // Closing the last tab leaves no active session; the panel must stay on the same project so its closed
  // conversations can be restored, and Changes/Files fall back to that project's newest session.
  const projectId = activeSession ? activeSession.projectId ?? null : inWorkspaceView ? activeProjectId : null;
  const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
  const session = useMemo(() => {
    if (activeSession) return activeSession;
    if (!projectId) return undefined;
    const mine = sessions.filter((item) => item.provider !== "shell" && item.projectId === projectId);
    const stamp = (item: (typeof mine)[number]) => Date.parse(item.endedAt ?? item.startedAt ?? item.createdAt) || 0;
    return mine.find((item) => isLive(item.state)) ?? mine.sort((a, b) => stamp(b) - stamp(a))[0];
  }, [activeSession, projectId, sessions]);
  // Changes and Files span every folder / worktree of the project, each reached through one of its sessions.
  const targets = useMemo<WorkspaceTarget[]>(() => {
    const result: WorkspaceTarget[] = [];
    const stamp = (item: (typeof sessions)[number]) => Date.parse(item.createdAt) || 0;
    for (const workspace of project?.workspaces ?? []) {
      const members = sessionsForWorkspace(project!.id, workspace, sessions);
      const rep = members.find((item) => item.id === activeSession?.id) ?? [...members].sort((a, b) => stamp(b) - stamp(a))[0];
      if (rep) result.push({ id: workspace.id, label: workspace.name || workspace.cwd, branch: workspace.branch, sessionId: rep.id });
    }
    if (result.length === 0 && session) result.push({ id: session.worktreeId ?? session.cwd, label: session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace", branch: session.branch ?? null, sessionId: session.id });
    return result;
  }, [project, sessions, activeSession, session]);
  const conversationCount = useMemo(() => projectId === null && !activeSession ? 0 : sessions.filter((item) => item.provider !== "shell" && (item.projectId ?? null) === projectId).length, [sessions, projectId, activeSession]);
  const badges: Partial<Record<RightSidebarTab, number | null>> = { changes: changeCount, conversations: conversationCount };

  if (!open || !client || (!activeSession && !projectId)) return null;

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
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onResizeMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current) setRightSidebarWidth(drag.current.startWidth + drag.current.startX - event.clientX);
  }
  function onResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") { event.preventDefault(); setRightSidebarWidth(width + 24); }
    if (event.key === "ArrowRight") { event.preventDefault(); setRightSidebarWidth(width - 24); }
  }

  return (
    <aside
      aria-label="Project panel"
      style={{ width: narrow ? `min(${width}px, calc(100vw - 2rem))` : width }}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-l border-border bg-background",
        // The app root is `min-h-svh` (not a fixed height), so a sibling whose height comes from its content stretches
        // the whole row and with it the terminal. The panel must have a definite height and scroll internally.
        narrow ? "fixed top-[48px] right-0 bottom-(--app-footer-height) z-30 shadow-xl" : "relative mt-[48px] h-[calc(100svh-48px-var(--app-footer-height))]",
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
          onPointerUp={() => { drag.current = null; }}
          onKeyDown={onResizeKey}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-ring/30 focus-visible:bg-ring/40 focus-visible:outline-none"
        />
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <div role="tablist" aria-label="Project panel sections" onKeyDown={onKeyDown} className="flex min-w-0 flex-1 items-center gap-0.5">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`right-sidebar-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls="right-sidebar-panel"
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setRightSidebarTab(id)}
              className={cn("flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
              {!!badges[id] && <span className="shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-[10px] leading-4 text-muted-foreground tabular-nums">{badges[id]! > 99 ? "99+" : badges[id]}</span>}
            </button>
          ))}
        </div>
        {narrow && <Button type="button" variant="ghost" size="icon-xs" aria-label="Close project panel" onClick={() => setRightSidebarOpen(false)}><IconX /></Button>}
      </div>
      {/* Panels stay mounted so tree expansion, scroll and loaded diffs survive switching tabs. */}
      <div id="right-sidebar-panel" role="tabpanel" aria-labelledby={`right-sidebar-tab-${tab}`} className="min-h-0 flex-1">
        <div className={cn("h-full", tab !== "changes" && "hidden")}>
          {session ? <ChangesTab client={client} targets={targets} onCount={setChangeCount} /> : <PanelEmpty icon={<IconGitCompare />} title="No agent in this project" hint="Start an agent to review its changes." />}
        </div>
        <div className={cn("h-full", tab !== "files" && "hidden")}>
          {session ? <FilesTab client={client} targets={targets} /> : <PanelEmpty icon={<IconFiles />} title="No agent in this project" hint="Start an agent to browse its workspace files." />}
        </div>
        <div className={cn("h-full", tab !== "ports" && "hidden")}>
          {session ? <PortsTab client={client} sessionId={session.id} /> : <PanelEmpty icon={<IconPlugConnected />} title="No agent in this project" hint="Start an agent to forward its ports." />}
        </div>
        <div className={cn("h-full", tab !== "conversations" && "hidden")}>
          <ConversationsTab projectId={projectId} project={project} />
        </div>
      </div>
    </aside>
  );
}
