import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ModelSelect, { normalizeModels } from "@/components/agents/model-select";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { IconPlus, IconArrowUp, IconArrowRight, IconChevronDown, IconBug, IconCode, IconSparkles } from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import IconBrandFloq from "@/components/ui/brand/IconBrandFloq";
import { Spinner } from "@/components/ui/spinner";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/agents/provider";
import CloneDialog from "./clone-dialog";
import SetupAgentsDialog from "@/components/agents/setup-agents-dialog";
import { useUsableProviders } from "@/components/agents/use-usable-providers";
import { FloqReveal, Skeleton } from "@/components/ui/skeleton";
import { loadComposerPrefs, saveComposerPrefs } from "@/lib/prefs";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { CreateSessionInput, LoginProviderId, ProviderId } from "@/lib/runtime/types";
import ProjectPicker from "@/components/projects/project-picker";
import { ProjectMark } from "@/components/projects/project-identity";
import { GlassSurface } from "@/components/ui/glass-surface";

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
    const { client, user, info, upsertSession, openSession, refresh, projects, projectsLoading, activeProjectId, activeWorkspaceId, selectProject, createProject } = useRuntime();
    const [prefs, setPrefs] = useState(loadComposerPrefs);
    const [prompt, setPrompt] = useState("");
    const [cloneOpen, setCloneOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
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
        setBusy(true);
        try {
            const session = await client.createSession(input);
            upsertSession(session);
            setPrompt("");
            openSession(session);
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
        <div className="absolute inset-0 overflow-y-auto px-5 py-8 sm:px-10 lg:px-14 lg:py-12">
            <FloqReveal selector="[data-home-reveal]" className="relative mx-auto flex w-full max-w-5xl flex-col gap-8">
                <header className="flex items-center justify-between gap-4 border-b border-border/60 pb-5">
                    <span className="flex items-center gap-2 text-sm font-medium"><IconBrandFloq size={20} variant="brand" />Home</span>
                    <Button data-ascii="skip" variant="outline" size="sm" onClick={() => setCloneOpen(true)}><IconPlus />New project</Button>
                </header>
                <div data-home-reveal className="space-y-3">
                    <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Start a new task</h1>
                    <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{greeting()}{name ? `, ${name}` : ""}. Choose a project and tell your agent what to build.</p>
                </div>

                <div className="flex flex-col gap-1">
                    <GlassSurface data-ascii="skip" className="glass-key-surface flex flex-col rounded-2xl p-4 transition-colors focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/30 sm:p-5">
                        <div className="mb-3 flex items-center gap-3 px-1">
                            <label htmlFor="home-prompt" className="text-sm font-medium">Task</label>
                        </div>
                        <textarea
                            id="home-prompt"
                            ref={area}
                            rows={3}
                            value={prompt}
                            disabled={busy}
                            onChange={(e) => setPrompt(e.target.value)}
                            onKeyDown={onKeyDown}
                            aria-describedby="home-help"
                            placeholder="Describe what you want to build, change, or fix?"
                            className="min-h-28 w-full resize-none border-0 bg-transparent px-1 py-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-0"
                        />
                        <div className="mt-4 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center">
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
                                                        Connect another agent
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

                                <Button
                                    size="default"
                                    className="h-9 rounded-xl px-3"
                                    aria-label={busy ? "Preparing project and starting agent" : "Start agent"}
                                    aria-busy={busy}
                                    disabled={!canSend}
                                    onClick={() => void send()}
                                >
                                    <span className="hidden sm:inline">Start agent</span>{busy ? <Spinner /> : <IconArrowUp />}
                                </Button>
                            </div>
                        </div>
                    </GlassSurface>
                    <p id="home-help" role="status" aria-live="polite" className="min-h-4 px-1 text-xs text-muted-foreground">
                        {busy
                            ? selectedProject ? `Starting an agent in ${selectedProject.displayName || selectedProject.name}…` : "Starting your agent…"
                            : !selectedProject ? "Choose or import a project to start an agent."
                                : needsConnect ? <button type="button" className="underline" onClick={() => setConnecting(true)}>Connect Claude or Codex to start</button>
                                    : prompt.trim() ? "Clear your prompt to choose a different starter." : "Choose a starter or describe the work for your agent."}
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
                                            + Connect another agent
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
                    <section aria-labelledby="home-projects-title" className="min-w-0">
                        <h2 id="home-projects-title" className="mb-4 text-base font-medium">Projects</h2>
                        <div className="divide-y divide-border/60">
                            {projects.slice(0, 4).map((project) => <Button key={project.id} type="button" variant="ghost" aria-pressed={project.id === activeProjectId} className="h-auto w-full justify-start gap-3 rounded-lg px-2 py-3 text-left" onClick={() => { selectProject(project.id, project.workspaces?.[0]?.id); area.current?.focus(); }}>
                                <ProjectMark project={project} className="size-5" />
                                <span className="flex min-w-0 flex-1 flex-col gap-1"><span className="truncate font-medium">{project.displayName || project.name}</span><span className="truncate font-mono text-xs text-muted-foreground">{project.workspaces?.[0]?.branch || project.workspaces?.[0]?.name || "Project checkout"}</span></span>
                                <IconArrowRight className="size-4 text-muted-foreground" />
                            </Button>)}
                            {!projectsLoading && projects.length === 0 && <div className="py-3"><p className="mb-3 text-sm text-muted-foreground">Add a project to give your agent a place to work.</p><Button variant="outline" size="sm" onClick={() => setCloneOpen(true)}><IconPlus />Add project</Button></div>}
                            {projectsLoading && <div role="status" aria-label="Loading projects" className="space-y-4 py-3"><Skeleton rows={1} className="h-4 w-3/4" /><Skeleton rows={1} className="h-4 w-1/2" /></div>}
                        </div>
                    </section>
                    <section aria-labelledby="home-starters-title" className="min-w-0">
                        <h2 id="home-starters-title" className="mb-4 text-base font-medium">Start with</h2>
                        <div role="group" aria-label="Prompt starters" className="divide-y divide-border/60">
                            {promptStarters.map((starter) => <Button key={starter.label} type="button" variant="ghost" disabled={busy || !!prompt.trim()} className="h-auto w-full justify-start gap-3 rounded-lg px-2 py-4 text-left" onClick={() => { setPrompt(starter.prompt); requestAnimationFrame(() => area.current?.focus()); }}><starter.icon aria-hidden="true" className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1">{starter.label}</span><IconArrowRight className="size-4 text-muted-foreground" /></Button>)}
                        </div>
                    </section>
                </div>
            </FloqReveal>
        </div>
    );
}
