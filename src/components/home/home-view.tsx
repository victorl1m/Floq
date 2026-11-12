import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { handlePaste } from "@/lib/paste";
import ModelSelect, { normalizeModels } from "@/components/agents/model-select";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
    IconPlus, IconArrowUp, IconArrowRight, IconChevronDown, IconBug, IconCode, IconSparkles, IconPaperclip,
    IconTestPipe, IconGitPullRequest, IconFolderPlus, IconGitBranch,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/agents/provider";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { confirmAutoApprove } from "@/components/agents/auto-approve-confirm";
import { providerThemeProps } from "@/lib/provider-theme";
import CloneDialog from "./clone-dialog";
import SetupAgentsDialog from "@/components/agents/setup-agents-dialog";
import { useUsableProviders } from "@/components/agents/use-usable-providers";
import { Skeleton } from "@/components/ui/skeleton";
import { loadComposerPrefs, saveComposerPrefs } from "@/lib/prefs";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { ORCHESTRATOR_HINT, ORCHESTRATOR_ROLE, isOrchestrator } from "@/lib/runtime/orchestrator";
import type { CreateSessionInput, LoginProviderId, ProviderId, SessionState, SessionSummary } from "@/lib/runtime/types";
import ProjectPicker from "@/components/projects/project-picker";
import { ProjectMark } from "@/components/projects/project-identity";
import { AttachmentChips, useAttachments, useTauriDrop } from "@/components/canvas/canvas-attachments";
import { deliverMessage, uploadAttachments, withPaths } from "@/components/canvas/canvas-send";
import { cn } from "cn";
import "./home.css";

function greeting(): string {
    const hour = new Date().getHours();
    return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** "3m", "2h", "4d" since an ISO timestamp; empty when unknown. */
function age(iso: string | null | undefined): string {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

const STATE_LABEL: Record<SessionState, { text: string; className: string }> = {
    running: { text: "Running", className: "text-emerald-700 dark:text-emerald-400" },
    starting: { text: "Starting", className: "text-amber-700 dark:text-amber-400" },
    sleeping: { text: "Sleeping", className: "text-muted-foreground" },
    exited: { text: "Exited", className: "text-muted-foreground" },
    failed: { text: "Failed", className: "text-destructive" },
};

function PickerButton({ children, ...props }: React.ComponentProps<typeof Button>) {
    return (
        <Button variant="ghost" size="sm" className="text-muted-foreground" {...props}>
            {children}
            <IconChevronDown className="size-3" />
        </Button>
    );
}

const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
const promptStarters = [
    { label: "Build a feature", icon: IconSparkles, prompt: "Help me build a feature. First inspect the project, then propose a small implementation plan." },
    { label: "Fix a bug", icon: IconBug, prompt: "Help me find and fix a bug. Start by inspecting the relevant code and explaining what you find." },
    { label: "Explain this code", icon: IconCode, prompt: "Explore this project and explain how its main pieces fit together." },
    { label: "Write tests", icon: IconTestPipe, prompt: "Find the least-tested important code in this project and add focused tests for it. Run them and report the results." },
    { label: "Review changes", icon: IconGitPullRequest, prompt: "Review the uncommitted changes in this project for bugs and risky edits, and suggest concrete fixes." },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function HomeView() {
    const { client, user, info, upsertSession, focusOnCanvas, openCanvas, sessions, refresh, projects, projectsLoading, activeProjectId, activeWorkspaceId, selectProject, createProject } = useRuntime();
    const [prefs, setPrefs] = useState(loadComposerPrefs);
    const [prompt, setPrompt] = useState("");
    const [cloneOpen, setCloneOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [dropHover, setDropHover] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
    const composer = useRef<HTMLDivElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const attachments = useAttachments();
    useTauriDrop(composer, attachments.add, setDropHover);
    const sessionsRef = useRef(sessions);
    sessionsRef.current = sessions;
    const typing = useRef<number | null>(null);
    const stopTyping = () => { if (typing.current !== null) { window.clearInterval(typing.current); typing.current = null; } };
    useEffect(() => stopTyping, []);
    // Types a starter into the composer character by character; any manual edit cancels it.
    const typePrompt = (text: string) => {
        stopTyping();
        area.current?.focus();
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("floq-reduced-motion");
        if (reduced) { setPrompt(text); return; }
        const chars = Array.from(text);
        const step = Math.max(1, Math.ceil(chars.length / 70));
        const old = Array.from(prompt);
        const eraseStep = Math.max(2, Math.ceil(old.length / 14));
        let left = old.length;
        let i = 0;
        // Phase 1: quickly erase whatever is there; phase 2: type the new starter.
        typing.current = window.setInterval(() => {
            if (left > 0) {
                left = Math.max(0, left - eraseStep);
                setPrompt(old.slice(0, left).join(""));
                return;
            }
            i = Math.min(chars.length, i + step);
            setPrompt(chars.slice(0, i).join(""));
            if (i >= chars.length) stopTyping();
        }, 18);
    };
    // Starters stay clickable while a starter's own text is in the input; text the user typed is protected.
    const promptIsStarter = !prompt.trim() || promptStarters.some((s) => s.prompt.startsWith(prompt));
    const { loading, usable, hasMissing, reload: reloadStatus } = useUsableProviders();
    const [connecting, setConnecting] = useState(false);
    // A remembered provider that is no longer connected falls back to the first connected one.
    const provider: ProviderId = usable.includes(prefs.provider as LoginProviderId) ? prefs.provider : (usable[0] ?? prefs.provider);
    const loginProvider = provider === "codex" ? "codex" : "claude";
    const needsConnect = !loading && usable.length === 0;
    const modelOptions = normalizeModels(info?.providers.find((p) => p.id === provider)?.models);
    // Only trust a remembered model that still exists for this provider ("" = default).
    const model = modelOptions.some((m) => m.value === prefs.models[provider]) ? prefs.models[provider] : "";

    useEffect(() => saveComposerPrefs(prefs), [prefs]);
    useEffect(() => {
        const sync = () => setPrefs(loadComposerPrefs());
        window.addEventListener("floq:composer-prefs", sync);
        return () => window.removeEventListener("floq:composer-prefs", sync);
    }, []);

    // Auto-grow the textarea (min height via CSS).
    useEffect(() => {
        const el = area.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 320) + "px";
    }, [prompt]);

    const selectedProject = projects.find((project) => project.id === activeProjectId) ?? null;
    const projectName = (id: string | null | undefined) => {
        const project = projects.find((p) => p.id === id);
        return project ? project.displayName || project.name : null;
    };

    // Recent agents: provider sessions in this organization's projects, newest activity first.
    const recentAgents = useMemo(() => sessions
        .filter((s) => s.provider !== "shell" && !!s.projectId && projects.some((p) => p.id === s.projectId))
        .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt))
        .slice(0, 6), [sessions, projects]);
    const agentCount = (projectId: string) => sessions.filter((s) => s.projectId === projectId && s.provider !== "shell").length;

    const name = user?.name?.trim().split(/\s+/)[0] || user?.email.split("@")[0] || "";
    const canSend = prompt.trim().length > 0 && !busy && usable.length > 0 && !!selectedProject;
    // Why "Start agent" is disabled, most blocking reason first (tooltip on the button, inline hint, sr text).
    const disabledReason = busy || canSend ? null
        : !selectedProject ? (projectsLoading ? "Loading projects…" : projects.length ? "Choose a project" : "Add a project first")
            : loading ? "Checking connected providers…"
                : usable.length === 0 ? "Connect Claude or Codex to start an agent"
                    : "Describe your task first";

    /** Attachments live in the new agent's own storage: upload once it exists, then paste the task with the saved paths. */
    async function deliverWithAttachments(session: SessionSummary, text: string) {
        if (!client) return;
        let paths: string[] = [];
        try {
            paths = await uploadAttachments(client, session.id, attachments.items, attachments.setFraction);
        } catch (e) {
            toast.warning("Some attachments could not be uploaded", { description: errorMessage(e) });
        }
        for (let i = 0; i < 40 && sessionsRef.current.find((s) => s.id === session.id)?.state !== "running"; i += 1) await sleep(500);
        await sleep(1500);
        await deliverMessage(client, session.id, withPaths(text, paths));
    }

    async function send() {
        if (!client || !canSend) return;
        const text = prompt.trim();
        const withFiles = attachments.items.length > 0;
        const input: CreateSessionInput = {
            provider: provider,
            title: text.replace(/\s+/g, " ").slice(0, 40),
            prompt: text,
        };
        if (!selectedProject) return;
        input.projectId = selectedProject.id;
        if (activeWorkspaceId) input.workspaceId = activeWorkspaceId;
        input.specKit = true;
        input.lead = true;
        if (model) input.model = model;
        // With attachments the task is pasted after upload (paths are only known once the agent exists).
        if (withFiles) delete input.prompt;
        const projectLabel = selectedProject.displayName || selectedProject.name;
        setBusy(true);
        attachments.resetProgress();
        try {
            if (!(await confirmAutoApprove(client, provider))) return;
            // A project needs one orchestrator. Check the live list (the store may be stale); fall back to the store.
            let known = sessions;
            try { known = await client.sessions(); } catch { /* use the store's list */ }
            const hasOrchestrator = known.some((s) => s.projectId === selectedProject.id && isOrchestrator(s));
            const orchestratorInput: CreateSessionInput = { ...input, title: "Orchestrator", role: ORCHESTRATOR_ROLE, model: model || "auto" };
            delete orchestratorInput.prompt;
            // Concurrently: the user's task must never depend on the orchestrator succeeding.
            const [taskResult, orchestratorResult] = await Promise.allSettled([
                client.createSession(input),
                hasOrchestrator ? Promise.resolve(null) : client.createSession(orchestratorInput),
            ]);
            if (orchestratorResult.status === "fulfilled" && orchestratorResult.value) {
                upsertSession(orchestratorResult.value);
                toast.success(`Orchestrator added to ${projectLabel}`, { description: ORCHESTRATOR_HINT });
            } else if (orchestratorResult.status === "rejected") {
                toast.warning("Could not add an orchestrator", { description: errorMessage(orchestratorResult.reason) });
            }
            if (taskResult.status === "rejected") throw taskResult.reason;
            const session = taskResult.value;
            upsertSession(session);
            if (withFiles) {
                try { await deliverWithAttachments(session, text); } catch (e) { toast.error("Could not send the task to the agent", { description: errorMessage(e) }); }
                attachments.clear();
            }
            setPrompt("");
            focusOnCanvas(session);
            void refresh();
        } catch (e) {
            toast.error("Could not create agent", { description: errorMessage(e) });
        } finally {
            setBusy(false);
        }
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
        }
    }

    const enter = isMac ? "↵" : "Enter";

    return (
        <div className="home-root absolute inset-0 overflow-y-auto">
            <div aria-hidden="true" className="home-backdrop" />
            <div className="home-page @container relative mx-auto flex min-h-full w-full max-w-[1040px] flex-col px-6 pt-[clamp(40px,11vh,120px)] pb-12 sm:px-10">
                {/* Hero: greeting, composer, starters. */}
                <div className="mx-auto flex w-full max-w-[720px] flex-col">
                    <div className="mb-6 space-y-1.5">
                        <h1 className="page-heading font-medium text-foreground">{greeting()}{name ? `, ${name}` : ""}</h1>
                        <p className="text-sm text-muted-foreground">What should your agents work on?</p>
                    </div>

                    <div
                        ref={composer}
                        data-drop-hover={dropHover || undefined}
                        className="home-composer flex flex-col rounded-[22px] border"
                        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDropHover(true); } }}
                        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropHover(false); }}
                        onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDropHover(false); attachments.addFiles(Array.from(event.dataTransfer.files)); } }}
                    >
                        {attachments.items.length > 0 && (
                            <div className="px-4 pt-4">
                                <AttachmentChips items={attachments.items} progress={attachments.progress} uploading={busy} onRemove={attachments.remove} />
                            </div>
                        )}
                        <label htmlFor="home-prompt" className="sr-only">Task</label>
                        <textarea
                            id="home-prompt"
                            ref={area}
                            rows={3}
                            value={prompt}
                            disabled={busy}
                            onChange={(e) => { stopTyping(); setPrompt(e.target.value); }}
                            onKeyDown={onKeyDown}
                            onPaste={(event) => {
                                handlePaste(event.nativeEvent, attachments.addFiles, (item) => attachments.add([item]));
                            }}
                            aria-describedby="home-help"
                            placeholder="Describe what you want to build, change, or fix…"
                            className="home-prompt-field min-h-[104px] w-full resize-none border-0 bg-transparent px-5 pt-4 pb-2 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/80 focus-visible:ring-0"
                        />
                        <div className="flex flex-wrap items-center gap-1 px-3 pt-1 pb-3">
                            <input ref={fileInput} type="file" multiple hidden onChange={(event) => { attachments.addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Attach files" disabled={busy} onClick={() => fileInput.current?.click()}>
                                        <IconPaperclip className="size-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">Attach files (or drop / paste them)</TooltipContent>
                            </Tooltip>
                            <ProjectPicker
                                projects={projects}
                                selectedProjectId={activeProjectId}
                                selectedWorkspaceId={activeWorkspaceId}
                                disabled={busy || projectsLoading}
                                onSelect={(project, workspaceId) => selectProject(project.id, workspaceId)}
                                onAddProject={() => setCloneOpen(true)}
                            />

                            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
                                {loading ? (
                                    <Skeleton className="h-7 w-28" />
                                ) : usable.length === 0 ? (
                                    <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
                                        Connect Claude or Codex
                                    </Button>
                                ) : (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <PickerButton disabled={busy} aria-label={`Provider: ${PROVIDER_LABEL[provider]}`}>
                                                <ProviderIcon provider={provider} />
                                                <span className="hidden @[560px]:inline">{PROVIDER_LABEL[provider]}</span>
                                            </PickerButton>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end" className="w-max max-w-[320px] min-w-[max(200px,var(--radix-dropdown-menu-trigger-width))]">
                                            {usable.map((id) => (
                                                <DropdownMenuItem key={id} onClick={() => setPrefs({ ...prefs, provider: id })}>
                                                    <ProviderIcon provider={id} />
                                                    {PROVIDER_LABEL[id]}
                                                </DropdownMenuItem>
                                            ))}
                                            {hasMissing && (
                                                <>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem onClick={() => setConnecting(true)}>
                                                        <IconPlus className="text-muted-foreground" />
                                                        Connect another provider
                                                    </DropdownMenuItem>
                                                </>
                                            )}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}

                                {modelOptions.length > 0 && usable.length > 0 && (
                                    <ModelSelect
                                        provider={provider === "claude" ? "claude" : "codex"}
                                        variant="compact"
                                        options={modelOptions}
                                        value={model}
                                        disabled={busy}
                                        onChange={(value) => setPrefs({ ...prefs, models: { ...prefs.models, [provider]: value } })}
                                    />
                                )}

                                <Tooltip open={disabledReason ? undefined : false}>
                                    <TooltipTrigger asChild>
                                        {/* A disabled button swallows pointer events, so the span carries hover/focus for the reason. */}
                                        <span tabIndex={disabledReason ? 0 : -1} className="ml-1 inline-flex rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-describedby={disabledReason ? "home-start-reason" : undefined}>
                                            <Button
                                                {...providerThemeProps(provider)}
                                                size="default"
                                                className="h-9 rounded-xl px-3 [--primary:var(--provider-accent)] [--primary-foreground:var(--provider-accent-foreground)] [--primary-hover:color-mix(in_oklab,var(--provider-accent)_88%,var(--foreground))]"
                                                shimmer
                                                aria-label={busy ? "Preparing project and starting agent" : "Start agent"}
                                                aria-busy={busy}
                                                loading={busy}
                                                disabled={!canSend && !busy}
                                                onClick={() => void send()}
                                            >
                                                <span className="hidden @[480px]:inline">Start agent</span>{!busy && <IconArrowUp />}
                                            </Button>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">{disabledReason}</TooltipContent>
                                </Tooltip>
                                {disabledReason && <span id="home-start-reason" className="sr-only">{disabledReason}</span>}
                            </div>
                        </div>
                        {dropHover && <div aria-hidden="true" className="home-drop-veil">Drop files to attach</div>}
                    </div>

                    <p id="home-help" role="status" aria-live="polite" className="sr-only">
                        {busy
                            ? selectedProject ? `Starting an agent in ${selectedProject.displayName || selectedProject.name}…` : "Starting your agent…"
                            : needsConnect ? "Connect Claude or Codex to start an agent."
                                : "Describe the work for your agent. Press Enter to send, or Shift+Enter for a new line."}
                    </p>
                    <div className="home-hint mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 text-xs">
                        {needsConnect ? (
                            <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setConnecting(true)}>
                                Connect Claude or Codex to start
                            </button>
                        ) : (
                            <>
                                <Kbd>{enter}</Kbd><span>to send</span>
                                <span aria-hidden="true" className="opacity-50">·</span>
                                <KbdGroup><Kbd>{isMac ? "⇧" : "Shift"}</Kbd><Kbd>{enter}</Kbd></KbdGroup><span>new line</span>
                                {hasMissing && (
                                    <>
                                        <span aria-hidden="true" className="opacity-50">·</span>
                                        <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => setConnecting(true)}>
                                            Connect another provider
                                        </button>
                                    </>
                                )}
                            </>
                        )}
                    </div>

                    <div role="group" aria-label="Prompt starters" className="mt-7 flex flex-wrap justify-center gap-2">
                        {promptStarters.map((starter) => (
                            <Button key={starter.label} type="button" variant="outline" size="sm" disabled={busy || !promptIsStarter} className="home-chip h-8 rounded-full px-3 text-[13px] font-normal" onClick={() => typePrompt(starter.prompt)}>
                                <starter.icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                                {starter.label}
                            </Button>
                        ))}
                    </div>
                </div>

                {/* Continue where you left off. */}
                <div className="mt-[clamp(40px,8vh,72px)] grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-10 @[860px]:grid-cols-[repeat(2,minmax(0,1fr))]">
                    <section aria-labelledby="home-agents-title" className="min-w-0">
                        <div className="mb-3 flex h-7 items-center justify-between">
                            <h2 id="home-agents-title" className="home-caption">Recent agents</h2>
                        </div>
                        {recentAgents.length > 0 ? (
                            <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
                                {recentAgents.map((session) => {
                                    const state = STATE_LABEL[session.state];
                                    const when = age(session.startedAt ?? session.createdAt);
                                    return (
                                        <li key={session.id} className="min-w-0">
                                            <button type="button" className="home-card group flex w-full min-w-0 items-center gap-3 rounded-2xl border px-3 py-2.5 text-left" onClick={() => focusOnCanvas(session)}>
                                                <AgentAvatar session={session} size={32} />
                                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                    <span className="truncate text-sm font-medium" title={session.title || "Untitled agent"}>{session.title || "Untitled agent"}</span>
                                                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                                                        <span className={cn("shrink-0 font-medium", state.className)}>{state.text}</span>
                                                        <span aria-hidden="true">·</span>
                                                        <span className="truncate" title={projectName(session.projectId) ?? undefined}>{projectName(session.projectId)}</span>
                                                        {isOrchestrator(session) && <><span aria-hidden="true">·</span><span className="shrink-0">Orchestrator</span></>}
                                                    </span>
                                                </span>
                                                {when && <span data-home-age className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground" aria-label={`Started ${when === "now" ? "just now" : `${when} ago`}`}>{when}</span>}
                                                <IconArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <div className="home-empty rounded-2xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
                                {projects.length
                                    ? "No agents yet. Describe a task above and Floq starts one in the selected project."
                                    : "Agents you start show up here, so you can jump back in."}
                            </div>
                        )}
                    </section>

                    <section aria-labelledby="home-projects-title" className="min-w-0">
                        <div className="mb-3 flex h-7 items-center justify-between">
                            <h2 id="home-projects-title" className="home-caption">Projects</h2>
                            {projects.length > 0 && (
                                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setCloneOpen(true)}><IconPlus />New project</Button>
                            )}
                        </div>
                        {projectsLoading ? (
                            <div role="status" aria-label="Loading projects" className="grid gap-2">
                                <Skeleton rows={1} className="h-14 w-full rounded-2xl" />
                                <Skeleton rows={1} className="h-14 w-full rounded-2xl" />
                            </div>
                        ) : projects.length > 0 ? (
                            <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
                                {projects.slice(0, 6).map((project) => {
                                    const ws = project.workspaces?.[0];
                                    const count = agentCount(project.id);
                                    return (
                                        <li key={project.id} className="min-w-0">
                                            <button type="button" aria-current={project.id === activeProjectId ? "true" : undefined} className="home-card group flex w-full min-w-0 items-center gap-3 rounded-2xl border px-3 py-2.5 text-left" onClick={() => openCanvas(project.id, ws?.id)}>
                                                <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-muted/70"><ProjectMark project={project} className="size-4" /></span>
                                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                    <span className="truncate text-sm font-medium" title={project.displayName || project.name}>{project.displayName || project.name}</span>
                                                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                                                        <IconGitBranch aria-hidden="true" className="size-3 shrink-0" />
                                                        <span className="truncate font-mono" title={ws?.branch || ws?.name || "Project checkout"}>{ws?.branch || ws?.name || "Project checkout"}</span>
                                                    </span>
                                                </span>
                                                {count > 0 && <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{count} {count === 1 ? "agent" : "agents"}</span>}
                                                <IconArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <div className="home-empty flex flex-col items-start gap-3 rounded-2xl border border-dashed p-5">
                                <span className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground"><IconFolderPlus className="size-5" aria-hidden="true" /></span>
                                <div className="space-y-1">
                                    <p className="text-sm font-medium">Add your first project</p>
                                    <p className="text-sm text-muted-foreground">Clone a repository or open a folder so your agents have a place to work.</p>
                                </div>
                                <Button variant="outline" size="sm" onClick={() => setCloneOpen(true)}><IconPlus />Add project</Button>
                            </div>
                        )}
                    </section>
                </div>
            </div>

            <CloneDialog
                open={cloneOpen}
                onOpenChange={setCloneOpen}
                onClone={async (repo) => {
                    const project = await createProject({ gitUrl: repo.url, name: repo.label });
                    selectProject(project.id, project.workspaces?.[0]?.id);
                }}
            />
            <SetupAgentsDialog
                open={connecting}
                onOpenChange={(open) => {
                    setConnecting(open);
                    if (!open) void reloadStatus();
                }}
                preferred={loginProvider}
                onContinue={() => void send()}
                onStatusChange={() => void reloadStatus()}
            />
        </div>
    );
}
