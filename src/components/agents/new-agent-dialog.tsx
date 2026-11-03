import { useEffect, useState, type FormEvent } from "react";
import { IconCheck, IconRobot } from "@tabler/icons-react";
import { toast } from "sonner";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "cn";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { AgentRole, CreateSessionInput, LoginProviderId, ProviderId } from "@/lib/runtime/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ModelSelect, { normalizeModels } from "./model-select";
import { Skeleton } from "@/components/ui/skeleton";
import { loadComposerPrefs } from "@/lib/prefs";
import { useUsableProviders } from "./use-usable-providers";
import SetupAgentsDialog from "./setup-agents-dialog";
import { PROVIDER_LABEL, ProviderIcon } from "./provider";
import ProjectPicker from "@/components/projects/project-picker";
import CloneDialog from "@/components/home/clone-dialog";

const FORM_ID = "new-agent-form";
const GENERALIST = "__generalist__";

export default function NewAgentDialog() {
    const { client, info, newAgentOpen, newAgentOrigin, setNewAgentOpen, upsertSession, openSession, focusOnCanvas, view, refresh, projects, projectsLoading, activeProjectId, activeWorkspaceId, selectProject, createProject } = useRuntime();
    const [chosen, setChosen] = useState<ProviderId>(() => loadComposerPrefs().provider);
    const [modelByProvider, setModelByProvider] = useState<Record<string, string>>(() => loadComposerPrefs().models);
    const [title, setTitle] = useState("");
    const [cloneOpen, setCloneOpen] = useState(false);
    const [isolated, setIsolated] = useState(false);
    const [roles, setRoles] = useState<AgentRole[]>([]);
    const [role, setRole] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [setupOpen, setSetupOpen] = useState(false);
    const { loading, usable, hasMissing, reload: reloadStatus } = useUsableProviders();
    // A remembered provider that is no longer connected falls back to the first connected one.
    const provider: ProviderId = usable.includes(chosen as LoginProviderId) ? chosen : (usable[0] ?? chosen);
    const modelOptions = normalizeModels(info?.providers.find((p) => p.id === provider)?.models);
    const model = modelOptions.some((m) => m.value === modelByProvider[provider]) ? modelByProvider[provider] : "";

    // Ask for a project only when none was selected at the moment the dialog opened.
    // Snapshotted so choosing one in the picker doesn't make the picker vanish.
    const [askProject, setAskProject] = useState(false);
    const [wasOpen, setWasOpen] = useState(false);
    if (newAgentOpen !== wasOpen) {
        setWasOpen(newAgentOpen);
        if (newAgentOpen) setAskProject(!activeProjectId);
    }

    useEffect(() => {
        if (newAgentOpen) setIsolated(false);
    }, [newAgentOpen]);

    useEffect(() => {
        if (!newAgentOpen || !client || roles.length > 0) return;
        client.agentRoles().then(setRoles).catch(() => undefined); // Older runtimes: no role picker.
    }, [newAgentOpen, client, roles.length]);

    function reset() {
        setTitle("");
        setError(null);
    }

    function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (usable.length === 0) return setSetupOpen(true);
        void create();
    }

    async function create() {
        if (!client) return;
        const selectedProject = projects.find((project) => project.id === activeProjectId);
        if (!selectedProject) return;
        const input: CreateSessionInput = { provider };
        if (title.trim()) input.title = title.trim();
        input.projectId = selectedProject.id;
        if (activeWorkspaceId) input.workspaceId = activeWorkspaceId;
        if (isolated) input.isolated = true;
        input.specKit = true;
        input.lead = true;
        // With a role and no explicit model, the runtime picks one from the role's capability hint.
        if (model) input.model = model;
        else if (role) input.model = "auto";
        if (role) input.role = role;
        setBusy(true);
        setError(null);
        try {
            const session = await client.createSession(input);
            upsertSession(session);
            // Started from the canvas: stay on it, centre the new node and show its terminal in the dialog instead of navigating to the old view.
            if (view === "canvas" && session.projectId) focusOnCanvas(session, { dialog: true });
            else openSession(session, newAgentOrigin);
            setNewAgentOpen(false);
            reset();
            void refresh();
        } catch (e) {
            setError(errorMessage(e));
            toast.error("Could not create agent", { description: errorMessage(e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
        <AppDialog
            open={newAgentOpen}
            onOpenChange={(open) => !busy && setNewAgentOpen(open)}
            icon={<IconRobot />}
            title="New agent"
            description="Start a coding agent in a cloud terminal."
            footer={
                <>
                    <Button type="button" variant="outline" disabled={busy} onClick={() => setNewAgentOpen(false)}>
                        Cancel
                    </Button>
                    <Button type="submit" form={FORM_ID} disabled={busy || loading || projectsLoading || usable.length === 0 || !activeProjectId}>
                        {busy && <Spinner />}
                        {busy ? "Creating..." : "Create agent"}
                    </Button>
                </>
            }
        >
            <form id={FORM_ID} onSubmit={onSubmit} className="flex flex-col gap-4">
                {error && <ErrorBanner>{error}</ErrorBanner>}

                {loading ? (
                    <div className="grid grid-cols-2 gap-3">
                        <Skeleton className="h-14 rounded-xl" />
                        <Skeleton className="h-14 rounded-xl" />
                    </div>
                ) : usable.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-5 text-center">
                        <p className="text-sm text-muted-foreground">No agent is connected yet.</p>
                        <Button type="button" onClick={() => setSetupOpen(true)}>
                            Connect Claude or Codex
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <div className={cn("grid gap-3", usable.length > 1 ? "grid-cols-2" : "grid-cols-1")} role="radiogroup" aria-label="Provider">
                            {usable.map((id) => {
                                const selected = provider === id;
                                return (
                                    <button
                                        key={id}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        onClick={() => setChosen(id)}
                                        className={cn(
                                            "relative flex items-center gap-2.5 rounded-xl border p-3 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                                            selected ? "border-border bg-muted" : "border-border"
                                        )}
                                    >
                                        <ProviderIcon provider={id} className="size-5" />
                                        {PROVIDER_LABEL[id]}
                                        {selected && <IconCheck className="absolute top-2 right-2 size-4 text-primary" />}
                                    </button>
                                );
                            })}
                        </div>
                        {hasMissing && (
                            <button
                                type="button"
                                className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                                onClick={() => setSetupOpen(true)}
                            >
                                + Connect another agent
                            </button>
                        )}
                    </div>
                )}

                {modelOptions.length > 0 && usable.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <Label>Model</Label>
                        <ModelSelect
                            provider={provider === "claude" ? "claude" : "codex"}
                            options={modelOptions}
                            value={model}
                            disabled={busy}
                            onChange={(value) => setModelByProvider({ ...modelByProvider, [provider]: value })}
                        />
                    </div>
                )}

                {roles.length > 0 && usable.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="agent-role">Role</Label>
                        <Select value={role || GENERALIST} disabled={busy} onValueChange={(value) => setRole(value === GENERALIST ? "" : value)}>
                            <SelectTrigger id="agent-role" className="w-full">
                                <SelectValue>{roles.find((r) => r.id === role)?.label ?? "Generalist"}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-w-[min(var(--radix-select-content-available-width),28rem)]">
                                <SelectItem value={GENERALIST}>Generalist</SelectItem>
                                {roles.map((r) => (
                                    <SelectItem key={r.id} value={r.id} textValue={r.label}>
                                        <span className="flex min-w-0 flex-col items-start gap-0.5">
                                            <span>{r.label}</span>
                                            <span className="text-xs font-normal text-muted-foreground">{r.summary}</span>
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {role && !model && <p className="text-xs text-muted-foreground">Model: Auto, chosen for this role ({roles.find((r) => r.id === role)?.capability}).</p>}
                    </div>
                )}

                {askProject && (
                    <div className="flex flex-col gap-2">
                        <Label>Project</Label>
                        <ProjectPicker
                            projects={projects}
                            selectedProjectId={activeProjectId}
                            selectedWorkspaceId={activeWorkspaceId}
                            onSelect={(project, workspaceId) => selectProject(project.id, workspaceId)}
                            onAddProject={() => setCloneOpen(true)}
                            disabled={busy || projectsLoading}
                        />
                    </div>
                )}

                <div className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5">
                    <Checkbox id="agent-isolated-worktree" checked={isolated} onCheckedChange={(checked) => setIsolated(checked === true)} disabled={busy || !activeProjectId} />
                    <div className="grid gap-0.5">
                        <Label htmlFor="agent-isolated-worktree" className="cursor-pointer text-sm font-medium">Isolated worktree</Label>
                        <p className="text-xs text-muted-foreground">Starts from the project's latest commit in a separate branch.</p>
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-title">Title</Label>
                    <Input id="agent-title" placeholder="Optional" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
                </div>

            </form>
        </AppDialog>
        <SetupAgentsDialog
            open={setupOpen}
            onOpenChange={(open) => {
                setSetupOpen(open);
                if (!open) void reloadStatus();
            }}
            preferred={provider === "codex" ? "codex" : "claude"}
            onContinue={() => void create()}
            onStatusChange={() => void reloadStatus()}
        />
        <CloneDialog
            open={cloneOpen}
            onOpenChange={setCloneOpen}
            onClone={async (repo) => {
                const project = await createProject({ gitUrl: repo.url, name: repo.label });
                selectProject(project.id, project.workspaces[0]?.id);
            }}
        />
        </>
    );
}
