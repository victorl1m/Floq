import { useEffect, useRef, useState } from "react";
import { IconHome, IconLayoutColumns, IconPlus, IconRobot, IconTerminal2, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { homeRelativeCwd, shellLocationLabel } from "@/lib/runtime/shell-location";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { createPortal } from "react-dom";
import { cn } from "cn";
import { useTitlebarSlot } from "@/lib/titlebar-slot";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { RuntimeError } from "@/lib/runtime/client";
import type { SessionSummary } from "@/lib/runtime/types";
import SessionTerminal, { STATE_DOT } from "./session-terminal";
import { isLive } from "./provider";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { usePerformancePrefs } from "@/lib/prefs";
import { chooseSplitPeer, resolveSplitPeer, visibleSplitIds } from "@/lib/runtime/terminal-split";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Temporarily keep split view out of the tab toolbar.
const SPLIT_VIEW_ENABLED = false;

/**
 * Hosts every opened xterm (kept mounted so scrollback survives switching).
 * "terminal" view = shell sessions with tabs; "session" view = the selected agent.
 */
function updateWarmTerminals(mru: string[], openedIds: string[], isVisible: (id: string) => boolean, inScope: (id: string) => boolean, maxWarmHidden: number): Set<string> {
    // Terminals of other projects are released (client-side only); the runtime keeps the session running.
    const open = new Set(openedIds.filter((id) => inScope(id) || isVisible(id)));
    const visible = openedIds.filter(isVisible);
    const next = [...visible, ...mru.filter((id) => open.has(id) && !visible.includes(id))];
    const keep = visible.length + maxWarmHidden;
    next.length = Math.min(next.length, keep);
    mru.splice(0, mru.length, ...next);
    return new Set(next);
}

export default function TerminalPanel() {
    const {
        client,
        info,
        sessions,
        loaded,
        openedIds,
        selectedId,
        selectedTerminalId,
        agentTabIds,
        terminalTabIds,
        view,
        upsertSession,
        openSession,
        activateSession,
        deleteSession,
        refresh,
        setNewAgentOpen,
        closeTab,
        projects,
        activeProjectId,
        activeWorkspaceId,
        selectProject,
        userPreferences,
        updateUserPreferences,
    } = useRuntime();

    const shells = sessions.filter((s) => s.provider === "shell");
    const supported = info ? info.server.providers.includes("shell") : null;
    const slot = useTitlebarSlot();
    const creating = useRef(false);
    const warmRef = useRef<string[]>([]);
    const [performancePrefs] = usePerformancePrefs();
    const [shellError, setShellError] = useState<string | null>(null);
    const [splitSelection, setSplitSelection] = useState<{ primaryId: string; peerId: string } | null>(null);
    const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

    /** Opens a shell: in a project workspace, or (`home`) in the runtime user's home directory with no project. */
    async function newShell({ projectId, workspaceId, home }: { projectId?: string | null; workspaceId?: string | null; home?: boolean } = {}): Promise<boolean> {
        if (!client || creating.current) return false;
        creating.current = true;
        setShellError(null);
        try {
            const session = await client.createSession({
                provider: "shell",
                title: "Terminal",
                ...(home || !projectId ? { home: true } : { projectId, ...(workspaceId ? { workspaceId } : {}) }),
            });
            upsertSession(session);
            // From the Terminal view stay there; from a project, join its tab strip beside the agents.
            // A home terminal has no project strip to join, so it always opens in the Terminal view.
            openSession(session, view === "terminal" || !session.projectId ? "terminal" : "agent");
            void refresh();
            return true;
        } catch (e) {
            setShellError(errorMessage(e));
            toast.error("Could not open a terminal", { description: errorMessage(e) });
            return false;
        } finally {
            creating.current = false;
        }
    }

    const terminalTabs = terminalTabIds.flatMap((id) => {
        const session = sessions.find((item) => item.id === id);
        return session && session.provider === "shell" ? [session] : [];
    });
    // The project strip shows agents and terminals together, for the whole project: every workspace and
    // worktree of the selected session's project, so moving between them never swaps the strip.
    const selectedSession = sessions.find((item) => item.id === selectedId);
    const tabProjectId = selectedSession ? selectedSession.projectId ?? null : activeProjectId;
    const agentTabs = agentTabIds.flatMap((id) => {
        const session = sessions.find((item) => item.id === id);
        return session && (session.projectId ?? null) === tabProjectId ? [session] : [];
    });
    // Label tabs with their workspace/branch only when the strip mixes several.
    const tabBranches = new Set(agentTabs.map((session) => session.worktreeId ?? session.cwd));
    const tabBranchLabel = (session: SessionSummary) => tabBranches.size > 1 ? session.branch || session.cwd.split("/").filter(Boolean).pop() || null : null;

    // Entering the Terminal view reopens an existing terminal before creating anything new.
    const wasTerminal = useRef(false);
    useEffect(() => {
        const entering = view === "terminal" && !wasTerminal.current;
        if (view !== "terminal") wasTerminal.current = false;
        if (view !== "terminal" || !loaded || supported !== true) return;
        if (terminalTabs.length === 0) {
            // Reopen only project-less shells: a project's terminal belongs to its canvas.
            const homeShells = shells.filter((s) => !s.projectId);
            if (homeShells.length > 0) {
                openSession(homeShells.find((s) => isLive(s.state)) ?? homeShells[0], "terminal");
                return;
            }
            if (entering && !creating.current) {
                wasTerminal.current = true;
                void newShell({ home: true });
            }
            return;
        }
        wasTerminal.current = true;
        if (!selectedTerminalId || !terminalTabs.some((session) => session.id === selectedTerminalId)) {
            openSession(terminalTabs[0], "terminal");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, loaded, supported, terminalTabs.length, selectedTerminalId, shells.length, activeProjectId, activeWorkspaceId]);

    async function closeShell(id: string) {
        try {
            await deleteSession(id);
            // Stopping the focused terminal in a project falls back to the neighbouring tab.
            if (view === "session" && id === selectedId) {
                const next = agentTabs.filter((session) => session.id !== id).pop();
                if (next) openSession(next, "agent");
            }
        } catch (e) {
            toast.error("Could not close terminal", { description: errorMessage(e) });
        }
    }

    // Closing an agent tab puts the agent to sleep first (it stays in the sidebar to resume).
    // On failure the tab stays open so the agent is never left running unseen.
    const closingAgents = useRef(new Set<string>());
    const [closingIds, setClosingIds] = useState<string[]>([]);
    async function closeAgent(session: SessionSummary, area: "agent" | "terminal") {
        if (closingAgents.current.has(session.id)) return;
        if (isLive(session.state)) {
            if (!client) return;
            closingAgents.current.add(session.id);
            setClosingIds([...closingAgents.current]);
            try {
                upsertSession(await client.sleepSession(session.id));
            } catch (e) {
                // 404: the runtime no longer has it running (it already stopped); nothing to put to sleep.
                if (e instanceof RuntimeError && e.status === 404) void refresh();
                else {
                    toast.error("Could not sleep this agent", { description: errorMessage(e) });
                    return;
                }
            } finally {
                closingAgents.current.delete(session.id);
                setClosingIds([...closingAgents.current]);
            }
        }
        closeTab(session.id, area);
        if (session.provider !== "shell") {
            // The conversation lives on under the right sidebar's Conversations tab; drop it from the left sidebar.
            updateUserPreferences({ hiddenSessionIds: { ...userPreferences.hiddenSessionIds, [session.id]: true } });
        }
        // Stay inside the project: fall back to a neighbouring tab of the same project when the focused tab closed.
        if (area === "agent" && view === "session" && session.id === selectedId) {
            const next = agentTabs.filter((item) => item.id !== session.id).pop();
            if (next) openSession(next, "agent");
        }
    }

    const isActive = (id: string) => {
        return view === "terminal" ? id === selectedTerminalId : view === "session" && id === selectedId;
    };

    const primaryId = view === "terminal" ? selectedTerminalId : view === "session" ? selectedId : null;
    const liveOpenedIds = new Set(openedIds.filter((id) => {
        const session = sessions.find((item) => item.id === id);
        return session && isLive(session.state);
    }));
    const desiredPeerId = splitSelection?.primaryId === primaryId ? splitSelection.peerId : null;
    const activeSplitPeer = resolveSplitPeer(primaryId, desiredPeerId, liveOpenedIds);
    const split = activeSplitPeer !== null;
    const visibleSplitSessions = visibleSplitIds(openedIds, primaryId, activeSplitPeer);
    const warmIds = updateWarmTerminals(warmRef.current, openedIds, (id) => (split ? visibleSplitSessions.has(id) : isActive(id)), (id) => (sessions.find((item) => item.id === id)?.projectId ?? null) === tabProjectId, performancePrefs.warmTerminals);
    const primarySession = sessions.find((session) => session.id === primaryId);
    const splitCandidates = sessions.filter((session) =>
        session.id !== primaryId && openedIds.includes(session.id) && isLive(session.state),
    );

    useEffect(() => {
        setSplitSelection(null);
        setFocusedPaneId(primaryId);
    }, [primaryId, view]);

    useEffect(() => {
        if (desiredPeerId && !activeSplitPeer) {
            setSplitSelection(null);
            setFocusedPaneId(primaryId);
        }
    }, [desiredPeerId, activeSplitPeer, primaryId]);

    function startSplit(peerId: string) {
        if (!primaryId) return;
        const chosen = chooseSplitPeer(primaryId, peerId, new Set(openedIds));
        if (!chosen) return;
        setFocusedPaneId(primaryId);
        setSplitSelection({ primaryId, peerId: chosen });
    }

    function closeSplit() {
        setSplitSelection(null);
        setFocusedPaneId(primaryId);
    }

    function addNewAgent() {
        if (primarySession?.projectId) selectProject(primarySession.projectId, primarySession.worktreeId ?? null);
        else if (primarySession) selectProject(null);
        else if (activeProjectId) selectProject(activeProjectId, activeWorkspaceId);
        setNewAgentOpen(true, view === "terminal" ? "terminal" : "agent");
    }

    function addNewTerminal() {
        const projectId = primarySession ? primarySession.projectId : activeProjectId;
        const workspaceId = primarySession ? primarySession.worktreeId : activeWorkspaceId;
        // The Terminal view only creates home terminals; with no project in context also open in the user's home.
        if (view === "terminal" || !projectId) {
            void newShell({ home: true });
            return;
        }
        selectProject(projectId, workspaceId);
        void newShell({ projectId, workspaceId });
    }

    const addSessionMenu = (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Add agent or terminal" title="Add agent or terminal">
                    <IconPlus />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48 min-w-[192px] whitespace-nowrap">
                <DropdownMenuItem onSelect={addNewAgent}><IconRobot />New agent</DropdownMenuItem>
                <DropdownMenuItem onSelect={addNewTerminal}><IconTerminal2 />New terminal</DropdownMenuItem>
                {view !== "terminal" && (primarySession ? primarySession.projectId : activeProjectId) && (
                    <DropdownMenuItem onSelect={() => void newShell({ home: true })}><IconHome />New terminal in ~</DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );

    const splitControl = SPLIT_VIEW_ENABLED && primarySession && (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Split terminal view" title="Split terminal view">
                    <IconLayoutColumns />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Show beside</DropdownMenuLabel>
                {splitCandidates.length ? splitCandidates.map((session) => (
                    <DropdownMenuItem key={session.id} onSelect={() => startSplit(session.id)}>
                        <AgentAvatar session={session} size={20} />
                        <span className="min-w-0 truncate">{session.title}</span>
                    </DropdownMenuItem>
                )) : (
                    <DropdownMenuItem disabled>Open another session first</DropdownMenuItem>
                )}
                {split && <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={closeSplit}>Close split view</DropdownMenuItem>
                </>}
            </DropdownMenuContent>
        </DropdownMenu>
    );

    return (
        <div className="absolute inset-0 flex flex-col">
            {view === "terminal" && slot &&
                createPortal(
                    <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
                        {terminalTabs.map((session) => {
                            const project = projects.find((item) => item.id === session.projectId);
                            const active = session.id === selectedTerminalId;
                            return (
                                <div key={session.id} className={cn("group flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
                                    <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[session.state])} title={session.state} />
                                    <AgentAvatar session={session} size={20} />
                                    <button type="button" className="max-w-40 truncate" title={[shellLocationLabel(session, project?.displayName || project?.name), session.branch, session.title].filter(Boolean).join(" · ")} onClick={() => activateSession(session, "terminal")}>
                                        {session.title}
                                    </button>
                                    {!session.projectId && <span className="shrink-0 font-mono text-[10px] text-muted-foreground" aria-label={`Working directory ${homeRelativeCwd(session.cwd)}`}>{homeRelativeCwd(session.cwd)}</span>}
                                    <Button variant="ghost" size="icon-xs"
                                        type="button"
                                        aria-label={session.provider === "shell" ? `Stop terminal ${session.title}` : `Close tab ${session.title}`}
                                        title={session.provider === "shell" ? `Stop terminal ${session.title}` : `Close tab and put ${session.title} to sleep`}
                                        disabled={closingIds.includes(session.id)}
                                        className="size-4 rounded text-muted-foreground"
                                        onClick={() => session.provider === "shell" ? void closeShell(session.id) : void closeAgent(session, "terminal")}
                                    >
                                        <IconX className="size-3" />
                                    </Button>
                                </div>
                            );
                        })}
                        {addSessionMenu}
                        {splitControl}
                    </div>,
                    slot,
                )}

            {view === "session" && slot && createPortal(
                <div className="flex h-full min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
                    {agentTabs.map((session) => {
                        const project = projects.find((item) => item.id === session.projectId);
                        const active = session.id === selectedId;
                        return (
                            <div key={session.id} className={cn("group flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")}>
                                <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[session.state])} title={session.state} />
                                <AgentAvatar session={session} size={20} />
                                <button type="button" className="max-w-40 truncate" title={[project?.displayName || project?.name, session.branch, session.title].filter(Boolean).join(" · ")} onClick={() => activateSession(session, "agent")}>
                                    {session.title}
                                </button>
                                {tabBranchLabel(session) && <span className="max-w-24 truncate text-[10px] text-muted-foreground/70">{tabBranchLabel(session)}</span>}
                                <Button variant="ghost" size="icon-xs"
                                    type="button"
                                    aria-label={session.provider === "shell" ? `Stop terminal ${session.title}` : `Close tab ${session.title}`}
                                    title={session.provider === "shell" ? `Stop terminal ${session.title}` : isLive(session.state) ? `Close tab and put ${session.title} to sleep` : `Close tab ${session.title}`}
                                    disabled={closingIds.includes(session.id)}
                                    className="size-4 rounded text-muted-foreground"
                                    onClick={() => session.provider === "shell" ? void closeShell(session.id) : void closeAgent(session, "agent")}
                                >
                                    <IconX className="size-3" />
                                </Button>
                            </div>
                        );
                    })}
                    {addSessionMenu}
                    {splitControl}
                </div>,
                slot,
            )}

            <div className={cn("relative min-h-0 flex-1", split && "grid grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1")}>
                {openedIds.map((id) => {
                    const session = sessions.find((item) => item.id === id);
                    const visible = split ? visibleSplitSessions.has(id) : isActive(id);
                    // Hidden tabs beyond the warm set are unmounted: xterm and its scrollback are freed,
                    // and the runtime replays buffered output when the tab is shown again.
                    if (!warmIds.has(id)) return null;
                    return (
                        <div
                            key={id}
                            className={cn(
                                split
                                    ? visible ? "relative min-h-0 overflow-hidden" : "hidden"
                                    : visible ? "absolute inset-0" : "hidden",
                                split && id === activeSplitPeer && "order-last border-t border-border md:border-t-0 md:border-l",
                                split && id === primaryId && "order-first",
                            )}
                            onFocusCapture={() => setFocusedPaneId(id)}
                        >
                            {split && session && (
                                <div className="absolute inset-x-0 top-0 z-20 flex h-7 items-center gap-1.5 border-b border-border bg-background px-2 text-xs">
                                    <AgentAvatar session={session} size={20} />
                                    <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[session.state])} title={session.state} />
                                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                                    <Button variant="ghost" size="icon-xs"
                                        type="button"
                                        className="size-5 rounded text-muted-foreground"
                                        aria-label="Close split view"
                                        onClick={closeSplit}
                                    >
                                        <IconX className="size-3.5" />
                                    </Button>
                                </div>
                            )}
                            <div className={cn("absolute inset-x-0 bottom-0", split ? "top-7" : "top-0")}>
                                <SessionTerminal
                                    sessionId={id}
                                    active={visible}
                                    titlebarActions={!split || focusedPaneId === id}
                                    titlebarTitle={false}
                                    focusOnActive={!split || focusedPaneId === id}
                                />
                            </div>
                        </div>
                    );
                })}

                {view === "terminal" && supported === false && terminalTabs.length === 0 && (
                    <Empty className="h-full">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <IconTerminal2 />
                            </EmptyMedia>
                            <EmptyTitle>Shell sessions are not available</EmptyTitle>
                            <EmptyDescription>This runtime doesn't support shell sessions yet.</EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                )}

                {view === "terminal" && supported === true && terminalTabs.length === 0 && loaded && (
                    <Empty className="h-full">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <IconTerminal2 />
                            </EmptyMedia>
                            <EmptyTitle>No terminal open</EmptyTitle>
                            <EmptyDescription>
                        {shellError ? <span role="alert" className="text-destructive">{shellError}</span> : "Opens in your home folder (~), no project needed. Project terminals are created on the project's canvas."}
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button onClick={() => void newShell({ home: true })}>
                                <IconTerminal2 />
                                {shellError ? "Try again" : "Open terminal"}
                            </Button>
                        </EmptyContent>
                    </Empty>
                )}

                {view === "terminal" && supported !== false && (!loaded || (terminalTabs.length > 0 && !terminalTabs.some((session) => session.id === selectedTerminalId))) && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Spinner />
                    </div>
                )}

                {view === "session" && !selectedId && (
                    <Empty className="h-full">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <IconTerminal2 />
                            </EmptyMedia>
                            <EmptyTitle>No agent selected</EmptyTitle>
                            <EmptyDescription>Pick an agent from the sidebar or start a new one.</EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button onClick={() => setNewAgentOpen(true)}>New agent</Button>
                        </EmptyContent>
                    </Empty>
                )}
            </div>
        </div>
    );
}
