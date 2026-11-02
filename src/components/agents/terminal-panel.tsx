import { useEffect, useRef, useState } from "react";
import { IconLayoutColumns, IconPlus, IconRobot, IconTerminal2, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import { ProviderIcon } from "./provider";
import ProjectPicker from "@/components/projects/project-picker";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import CloneDialog from "@/components/home/clone-dialog";
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
        projectsLoading,
        activeProjectId,
        activeWorkspaceId,
        selectProject,
        createProject,
    } = useRuntime();

    const shells = sessions.filter((s) => s.provider === "shell");
    const supported = info ? info.server.providers.includes("shell") : null;
    const slot = useTitlebarSlot();
    const creating = useRef(false);
    const [shellError, setShellError] = useState<string | null>(null);
    const [newTerminalProjectOpen, setNewTerminalProjectOpen] = useState(false);
    const [cloneProjectOpen, setCloneProjectOpen] = useState(false);
    const [newTerminalBusy, setNewTerminalBusy] = useState(false);
    const [splitSelection, setSplitSelection] = useState<{ primaryId: string; peerId: string } | null>(null);
    const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

    async function newShell(projectId?: string | null, workspaceId?: string | null): Promise<boolean> {
        if (!client || creating.current) return false;
        creating.current = true;
        setShellError(null);
        try {
            const session = await client.createSession({
                provider: "shell",
                title: "Terminal",
                ...(projectId ? { projectId } : {}),
                ...(workspaceId ? { workspaceId } : {}),
            });
            upsertSession(session);
            // From the Terminal view stay there; from a project, join its tab strip beside the agents.
            openSession(session, view === "terminal" ? "terminal" : "agent");
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
    // The project strip shows agents and terminals together.
    const agentTabs = agentTabIds.flatMap((id) => {
        const session = sessions.find((item) => item.id === id);
        return session ? [session] : [];
    });

    // Entering the Terminal view reopens an existing terminal before creating anything new.
    const wasTerminal = useRef(false);
    useEffect(() => {
        const entering = view === "terminal" && !wasTerminal.current;
        if (view !== "terminal") wasTerminal.current = false;
        if (view !== "terminal" || !loaded || supported !== true) return;
        if (terminalTabs.length === 0) {
            if (shells.length > 0) {
                openSession(shells.find((s) => isLive(s.state)) ?? shells[0], "terminal");
                return;
            }
            if (entering && !creating.current) {
                wasTerminal.current = true;
                if (activeProjectId) void newShell(activeProjectId, activeWorkspaceId);
                else setNewTerminalProjectOpen(true);
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
        if (!projectId) {
            setNewTerminalProjectOpen(true);
            return;
        }
        selectProject(projectId, workspaceId);
        void newShell(projectId, workspaceId);
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
                        <ProviderIcon provider={session.provider} />
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
                                    <ProviderIcon provider={session.provider} />
                                    <button type="button" className="max-w-40 truncate" title={[project?.displayName || project?.name, session.branch, session.title].filter(Boolean).join(" · ")} onClick={() => activateSession(session, "terminal")}>
                                        {session.title}
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={session.provider === "shell" ? `Stop terminal ${session.title}` : `Close tab ${session.title}`}
                                        title={session.provider === "shell" ? `Stop terminal ${session.title}` : `Close tab and put ${session.title} to sleep`}
                                        disabled={closingIds.includes(session.id)}
                                        className="rounded p-0.5 hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                        onClick={() => session.provider === "shell" ? void closeShell(session.id) : void closeAgent(session, "terminal")}
                                    >
                                        <IconX className="size-3" />
                                    </button>
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
                                <ProviderIcon provider={session.provider} />
                                <button type="button" className="max-w-40 truncate" title={[project?.displayName || project?.name, session.branch, session.title].filter(Boolean).join(" · ")} onClick={() => activateSession(session, "agent")}>
                                    {session.title}
                                </button>
                                <button
                                    type="button"
                                    aria-label={session.provider === "shell" ? `Stop terminal ${session.title}` : `Close tab ${session.title}`}
                                    title={session.provider === "shell" ? `Stop terminal ${session.title}` : isLive(session.state) ? `Close tab and put ${session.title} to sleep` : `Close tab ${session.title}`}
                                    disabled={closingIds.includes(session.id)}
                                    className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                    onClick={() => session.provider === "shell" ? void closeShell(session.id) : void closeAgent(session, "agent")}
                                >
                                    <IconX className="size-3" />
                                </button>
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
                                    <ProviderIcon provider={session.provider} />
                                    <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[session.state])} title={session.state} />
                                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                                    <button
                                        type="button"
                                        className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
                                        aria-label="Close split view"
                                        onClick={closeSplit}
                                    >
                                        <IconX className="size-3.5" />
                                    </button>
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
                        {shellError ? <span className="text-destructive">{shellError}</span> : "Choose a project to open a terminal."}
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button onClick={() => setNewTerminalProjectOpen(true)}>Choose project</Button>
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
            <AppDialog
                open={newTerminalProjectOpen}
                onOpenChange={(open) => !newTerminalBusy && setNewTerminalProjectOpen(open)}
                icon={<IconTerminal2 />}
                title="New terminal"
                description="Choose a project and workspace for this terminal."
                footer={
                    <>
                        <Button type="button" variant="outline" disabled={newTerminalBusy} onClick={() => setNewTerminalProjectOpen(false)}>Cancel</Button>
                        <Button
                            type="button"
                            disabled={newTerminalBusy || projectsLoading || !activeProjectId}
                            onClick={() => {
                                if (!activeProjectId) return;
                                setNewTerminalBusy(true);
                                void newShell(activeProjectId, activeWorkspaceId).then((opened) => {
                                    if (opened) setNewTerminalProjectOpen(false);
                                }).finally(() => setNewTerminalBusy(false));
                            }}
                        >
                            {newTerminalBusy && <Spinner />}
                            {newTerminalBusy ? "Opening..." : "Open terminal"}
                        </Button>
                    </>
                }
            >
                {shellError && <ErrorBanner>{shellError}</ErrorBanner>}
                <div className="flex flex-col gap-2">
                    <Label className="text-sm">Project</Label>
                    <ProjectPicker
                        projects={projects}
                        selectedProjectId={activeProjectId}
                        selectedWorkspaceId={activeWorkspaceId}
                        onSelect={(project, workspaceId) => selectProject(project.id, workspaceId)}
                        onAddProject={() => setCloneProjectOpen(true)}
                        disabled={newTerminalBusy || projectsLoading}
                    />
                </div>
            </AppDialog>
            <CloneDialog
                open={cloneProjectOpen}
                onOpenChange={setCloneProjectOpen}
                onClone={async (repo) => {
                    const project = await createProject({ gitUrl: repo.url, name: repo.label });
                    selectProject(project.id, project.workspaces[0]?.id);
                }}
            />
        </div>
    );
}
