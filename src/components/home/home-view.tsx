import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ModelSelect, { normalizeModels } from "@/components/agents/model-select";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { IconPlus, IconArrowUp, IconChevronDown } from "@tabler/icons-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { loadComposerPrefs, saveComposerPrefs } from "@/lib/prefs";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { CreateSessionInput, LoginProviderId, ProviderId } from "@/lib/runtime/types";
import ProjectPicker from "@/components/projects/project-picker";

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

    const name = user?.name?.trim() || user?.email.split("@")[0] || "";
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
        <div className="absolute inset-0 flex items-center justify-center overflow-y-auto p-6">
            <div className="flex w-full max-w-3xl flex-col gap-6">
                <div className="flex items-center justify-center gap-4">
                    <IconBrandFloq size={40} variant="brand" />
                    <h1 className="text-4xl font-light tracking-tight">
                        {greeting()}
                        {name && `, ${name}`}
                    </h1>
                </div>

                <div className="flex flex-col gap-1">
                    <div className="flex flex-col rounded-2xl border border-border bg-card/60 p-3 shadow-xs focus-within:border-ring/50">
                        <textarea
                            ref={area}
                            autoFocus
                            rows={3}
                            value={prompt}
                            disabled={busy}
                            onChange={(e) => setPrompt(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="How can I help today?"
                            className="min-h-[4.5rem] w-full resize-none border-0 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
                        />
                        <div className="flex items-center gap-1">
                            <ProjectPicker
                                projects={projects}
                                selectedProjectId={activeProjectId}
                                selectedWorkspaceId={activeWorkspaceId}
                                disabled={busy || projectsLoading}
                                onSelect={(project, workspaceId) => selectProject(project.id, workspaceId)}
                                onAddProject={() => setCloneOpen(true)}
                            />

                            <div className="ml-auto flex items-center gap-1">
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
                                    size="icon"
                                    className="rounded-lg"
                                    aria-label={busy ? "Preparing project and starting agent" : "Send"}
                                    aria-busy={busy}
                                    disabled={!canSend}
                                    onClick={() => void send()}
                                >
                                    {busy ? <Spinner /> : <IconArrowUp />}
                                </Button>
                            </div>
                        </div>
                    </div>
                    {busy && (
                        <p role="status" aria-live="polite" className="px-1 text-xs text-muted-foreground">
                            {selectedProject ? `Starting an agent in ${selectedProject.displayName || selectedProject.name}…` : "Starting your agent…"}
                        </p>
                    )}
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
                            selectProject(project.id, project.workspaces?.[0]?.cwd);
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
            </div>
        </div>
    );
}
