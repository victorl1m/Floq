import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ModelSelect, { normalizeModels } from "@/components/agents/model-select";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { IconPlus, IconArrowUp, IconArrowRight, IconChevronDown, IconBug, IconCode, IconSparkles } from "@tabler/icons-react";
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
import IconBrandFloq from "@/components/ui/brand/IconBrandFloq";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/agents/provider";
import { confirmAutoApprove } from "@/components/agents/auto-approve-confirm";
import { providerThemeProps } from "@/lib/provider-theme";
import CloneDialog from "./clone-dialog";
import SetupAgentsDialog from "@/components/agents/setup-agents-dialog";
import { useUsableProviders } from "@/components/agents/use-usable-providers";
import { Skeleton } from "@/components/ui/skeleton";
import { loadComposerPrefs, saveComposerPrefs } from "@/lib/prefs";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { ORCHESTRATOR_HINT, ORCHESTRATOR_ROLE, isOrchestrator } from "@/lib/runtime/orchestrator";
import type { CreateSessionInput, LoginProviderId, ProviderId } from "@/lib/runtime/types";
import ProjectPicker from "@/components/projects/project-picker";
import { ProjectMark } from "@/components/projects/project-identity";
import { FloqSurface } from "@/components/ui/floq-surface";
import { MatrixTrail } from "@/components/ui/matrix-trail";

function greeting(): string {
    const hour = new Date().getHours();
    return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

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
    { label: "Build a feature", detail: "Plan and implement a focused change.", icon: IconSparkles, prompt: "Help me build a feature. First inspect the project, then propose a small implementation plan." },
    { label: "Fix a bug", detail: "Trace a problem and make a targeted fix.", icon: IconBug, prompt: "Help me find and fix a bug. Start by inspecting the relevant code and explaining what you find." },
    { label: "Explain this code", detail: "Map the important parts of this project.", icon: IconCode, prompt: "Explore this project and explain how its main pieces fit together." },
];

export default function HomeView() {
    const { client, user, info, upsertSession, focusOnCanvas, openCanvas, sessions, refresh, projects, projectsLoading, activeProjectId, activeWorkspaceId, selectProject, createProject } = useRuntime();
    const [prefs, setPrefs] = useState(loadComposerPrefs);
    const [prompt, setPrompt] = useState("");
    const [cloneOpen, setCloneOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
    const typing = useRef<number | null>(null);
    const stopTyping = () => { if (typing.current !== null) { window.clearInterval(typing.current); typing.current = null; } };
    useEffect(() => stopTyping, []);
    // Types a starter into the composer character by character; any manual edit cancels it.
    const typePrompt = (text: string) => {
        stopTyping();
        area.current?.focus();
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setPrompt(text); return; }
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

    // Auto-grow the textarea (min 3 rows via CSS).
    useEffect(() => {
        const el = area.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 320) + "px";
    }, [prompt]);

    const selectedProject = projects.find((project) => project.id === activeProjectId) ?? null;

    const name = user?.name?.trim().split(/\s+/)[0] || user?.email.split("@")[0] || "";
    const canSend = prompt.trim().length > 0 && !busy && usable.length > 0 && !!selectedProject;
    // Why "Start agent" is disabled, most blocking reason first (shown as a tooltip on the button).
    const disabledReason = busy || canSend ? null
        : !selectedProject ? (projectsLoading ? "Loading projects…" : "No project selected")
            : loading ? "Checking connected providers…"
                : usable.length === 0 ? "Connect Claude or Codex to start an agent"
                    : "Describe your task first";

    async function send() {
        if (!client || !canSend) return;
        const text = prompt.trim();
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
        const projectName = selectedProject.displayName || selectedProject.name;
        setBusy(true);
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
                toast.success(`Orchestrator added to ${projectName}`, { description: ORCHESTRATOR_HINT });
            } else if (orchestratorResult.status === "rejected") {
                toast.warning("Could not add an orchestrator", { description: errorMessage(orchestratorResult.reason) });
            }
            if (taskResult.status === "rejected") throw taskResult.reason;
            const session = taskResult.value;
            upsertSession(session);
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

    return (
        <div className="absolute inset-0">
        <MatrixTrail />
        <div data-matrix-bg className="absolute inset-0 overflow-y-auto px-5 py-8 sm:px-10 lg:px-14 lg:py-12">
            <div data-matrix-bg className="relative mx-auto flex w-full max-w-5xl flex-col gap-8">
                <header data-matrix-quiet className="flex items-center justify-between gap-4 border-b border-border/60 pb-5">
                    <span className="flex items-center gap-2 text-sm font-medium"><IconBrandFloq size={20} variant="brand" />Home</span>
                    <Button data-ascii="skip" variant="outline" size="sm" onClick={() => setCloneOpen(true)}><IconPlus />New project</Button>
                </header>
                <div data-matrix-quiet className="space-y-3">
                    <h1 className="page-heading text-3xl font-medium tracking-tight sm:text-4xl">Start a new task</h1>
                    <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{greeting()}{name ? `, ${name}` : ""}. Choose a project and tell your agent what to build.</p>
                </div>

                <div data-matrix-bg className="flex flex-col gap-1">
                    <FloqSurface data-ascii="skip" data-matrix-bg data-matrix-exclude className="home-task-composer glass-key-surface flex flex-col rounded-2xl p-4 sm:p-5">
                        <div data-matrix-bg className="mb-3 flex items-center gap-3 px-1">
                            <label data-matrix-quiet htmlFor="home-prompt" className="text-sm font-medium">Task</label>
                        </div>
                        <textarea
                            data-matrix-quiet
                            id="home-prompt"
                            ref={area}
                            rows={3}
                            value={prompt}
                            disabled={busy}
                            onChange={(e) => { stopTyping(); setPrompt(e.target.value); }}
                            onKeyDown={onKeyDown}
                            aria-describedby="home-help"
                            placeholder="Describe what you want to build, change, or fix?"
                            className="home-prompt-field min-h-28 w-full resize-none border-0 bg-transparent px-1 py-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-0"
                        />
                        <div data-matrix-bg data-matrix-quiet className="mt-4 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center">
                            <ProjectPicker
                                projects={projects}
                                selectedProjectId={activeProjectId}
                                selectedWorkspaceId={activeWorkspaceId}
                                disabled={busy || projectsLoading}
                                onSelect={(project, workspaceId) => selectProject(project.id, workspaceId)}
                                onAddProject={() => setCloneOpen(true)}
                            />

                            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 sm:ml-auto">
                                {loading ? (
                                    <Skeleton className="h-7 w-28" />
                                ) : usable.length === 0 ? (
                                    <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
                                        Connect Claude or Codex
                                    </Button>
                                ) : (
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <PickerButton disabled={busy}>
                                                <ProviderIcon provider={provider} />
                                                {PROVIDER_LABEL[provider]}
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
                                        <span tabIndex={disabledReason ? 0 : -1} className="inline-flex rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-describedby={disabledReason ? "home-start-reason" : undefined}>
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
                                                <span className="hidden sm:inline">Start agent</span>{!busy && <IconArrowUp />}
                                            </Button>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">{disabledReason}</TooltipContent>
                                </Tooltip>
                                {disabledReason && <span id="home-start-reason" className="sr-only">{disabledReason}</span>}
                            </div>
                        </div>
                    </FloqSurface>
                    <p id="home-help" role="status" aria-live="polite" className="sr-only">
                        {busy
                            ? selectedProject ? `Starting an agent in ${selectedProject.displayName || selectedProject.name}…` : "Starting your agent…"
                            : needsConnect ? "Connect Claude or Codex to start an agent."
                                : "Describe the work for your agent. Press Enter to send, or Shift+Enter for a new line."}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1 pt-1 text-xs text-muted-foreground">
                        {needsConnect ? (
                            <button type="button" className="underline" onClick={() => setConnecting(true)}>
                                Connect Claude or Codex to start
                            </button>
                        ) : (
                            <>
                                <Kbd>{isMac ? "↵" : "Enter"}</Kbd> to send &middot;{" "}
                                <KbdGroup>
                                    <Kbd>{isMac ? "⇧" : "Shift"}</Kbd>
                                    <Kbd>{isMac ? "↵" : "Enter"}</Kbd>
                                </KbdGroup>{" "}
                                for a new line
                                {hasMissing && (
                                    <>
                                        {" "}
                                        &middot;{" "}
                                        <button type="button" className="underline" onClick={() => setConnecting(true)}>
                                            + Connect another provider
                                        </button>
                                    </>
                                )}
                            </>
                        )}
                    </p>
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
                <div className="grid gap-8 pb-8 md:grid-cols-2 md:gap-12">
                    <section data-matrix-quiet aria-labelledby="home-projects-title" className="min-w-0">
                        <h2 id="home-projects-title" className="mb-4 text-base font-medium">Projects</h2>
                        <div className="divide-y divide-border/60">
                            {projects.slice(0, 4).map((project) => <Button key={project.id} type="button" variant="ghost" aria-pressed={project.id === activeProjectId} className="home-list-row h-auto w-full justify-start gap-3 rounded-lg px-2 py-3 text-left" onClick={() => openCanvas(project.id, project.workspaces?.[0]?.id)}>
                                <ProjectMark project={project} className="size-5" />
                                <span className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate font-medium">{project.displayName || project.name}</span><span className="truncate font-mono text-xs text-muted-foreground">{project.workspaces?.[0]?.branch || project.workspaces?.[0]?.name || "Project checkout"}</span></span>
                                <IconArrowRight className="size-4 text-muted-foreground" />
                            </Button>)}
                            {!projectsLoading && projects.length === 0 && <div className="py-3"><p className="mb-3 text-sm text-muted-foreground">Add a project to give your agent a place to work.</p><Button variant="outline" size="sm" onClick={() => setCloneOpen(true)}><IconPlus />Add project</Button></div>}
                            {projectsLoading && <div role="status" aria-label="Loading projects" className="space-y-4 py-3"><Skeleton rows={1} className="h-4 w-3/4" /><Skeleton rows={1} className="h-4 w-1/2" /></div>}
                        </div>
                    </section>
                    <section data-matrix-quiet aria-labelledby="home-starters-title" className="min-w-0">
                        <h2 id="home-starters-title" className="mb-4 text-base font-medium">Start with</h2>
                        <div role="group" aria-label="Prompt starters" className="divide-y divide-border/60">
                            {promptStarters.map((starter) => <Button key={starter.label} type="button" variant="ghost" disabled={busy || !promptIsStarter} className="home-list-row h-auto w-full justify-start gap-3 rounded-lg px-2 py-4 text-left" onClick={() => typePrompt(starter.prompt)}><starter.icon aria-hidden="true" className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1">{starter.label}</span><IconArrowRight className="size-4 text-muted-foreground" /></Button>)}
                        </div>
                    </section>
                </div>
            </div>
        </div>
        </div>
    );
}
