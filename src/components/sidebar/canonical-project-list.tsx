import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ORCHESTRATOR_HINT, ORCHESTRATOR_TEXT, isOrchestrator, orchestratorLabel, recruitCounts, setOrchestrator } from "@/lib/runtime/orchestrator";
import {
  IconChevronRight,
  IconCrown,
  IconCopy,
  IconChevronsDown,
  IconChevronsUp,
  IconDots,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconFiles,
  IconFolderOpen,
  IconGitCompare,
  IconLayoutKanban,
  IconTerminal2,
  IconX,
  IconFolder,
  IconFolderPlus,
  IconGitBranch,
  IconMoon,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { AppDialog, ErrorBanner } from "@/components/ui/app-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubItem } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import CloneDialog from "@/components/home/clone-dialog";
import WorktreeDeleteDialog, { type WorktreeDeleteTarget } from "@/components/sidebar/worktree-delete-dialog";
import { ProviderIcon, isLive } from "@/components/agents/provider";
import { ActivityIndicator, agentActivity } from "@/components/agents/activity-indicator";
import { ProjectMark } from "@/components/projects/project-identity";
import { canonicalProjectPrefsMigrationKey, legacyPrefsForProject, loadProjectFolders, projectScope, removeProjectFolder, saveProjectFolders, updateCanonicalProjectMeta, useCanonicalProjectMeta, useProjectFolders, useRecentRepos, useWorkspaceProjectMeta, type ProjectFolder } from "@/lib/prefs";
import { projectFaviconUrl, normalizeProjectImageUrl } from "@/lib/runtime/project-appearance";
import { copyText } from "@/lib/clipboard";
import { openRightSidebar } from "@/lib/right-sidebar";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { sessionsForWorkspace } from "@/lib/runtime/projects";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { RuntimeProject, SessionState, SessionSummary } from "@/lib/runtime/types";
import { cn } from "cn";

const CTX = "w-56";
const ROW_OPEN = "rounded-md data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground";
const MENU = "w-48 min-w-[192px] whitespace-nowrap";
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 32 * 1024;
const SOURCE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DOT: Record<SessionState, string> = { running: "bg-emerald-500", starting: "bg-amber-400 animate-pulse", sleeping: "bg-muted-foreground/40", exited: "bg-muted-foreground/40", failed: "bg-destructive" };

async function projectImageThumbnail(file: File): Promise<string> {
  if (!SOURCE_IMAGE_TYPES.has(file.type)) throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("Choose an image smaller than 10 MiB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This image could not be opened. Choose another file."); }
  try {
    if (bitmap.width * bitmap.height > 25_000_000) throw new Error("Choose an image with 25 megapixels or less.");
    const scale = Math.min(128 / bitmap.width, 128 / bitmap.height, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not prepare this image.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (!blob || blob.type !== "image/webp") throw new Error("This browser cannot prepare WebP images.");
      if (blob.size <= MAX_THUMBNAIL_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return `data:image/webp;base64,${btoa(binary)}`;
      }
    }
    throw new Error("This image is too detailed to fit the 32 KiB project image limit.");
  } finally {
    bitmap.close();
  }
}

function StateDot({ state }: { state: SessionState }) {
  return <span title={state} aria-label={state} className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />;
}

type EditState = { kind: "folder-new" } | { kind: "folder-edit"; folder: ProjectFolder } | { kind: "project"; project: RuntimeProject } | null;

export default function CanonicalProjectList() {
  const { loaded, openedIds, projects, projectsLoading, projectsError, retryProjects, sessions, selectedId, selectedTerminalId, view, canvasProjectId, openCanvas, focusOnCanvas, openSession, closeTab, client, upsertSession, deleteSession, setNewAgentOpen, navigate, selectProject, createProject, updateProject, refreshProjects, baseUrl, user, userPreferences, updateUserPreferences } = useRuntime();
  const scope = projectScope(baseUrl, user?.id ?? null);
  const folders = useProjectFolders(scope);
  const projectMeta = useCanonicalProjectMeta(scope);
  const legacyRepos = useRecentRepos(scope);
  const legacyWorkspaceMeta = useWorkspaceProjectMeta(scope);
  const migrationAttempt = useRef<string | null>(null);
  const [edit, setEdit] = useState<EditState>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [imageKind, setImageKind] = useState<"direct" | "favicon" | "file">("direct");
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageFileName, setImageFileName] = useState("");
  const [imageValidating, setImageValidating] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [removeFolder, setRemoveFolder] = useState<ProjectFolder | null>(null);
  const recruits = useMemo(() => recruitCounts(sessions), [sessions]);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [deletingWorktree, setDeletingWorktree] = useState<WorktreeDeleteTarget | null>(null);
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);

  const folderByProject = useMemo(() => {
    const knownFolders = new Set(folders.map((folder) => folder.id));
    return new Map(projectMeta.map((item) => [item.projectId, item.folderId && knownFolders.has(item.folderId) ? item.folderId : null]));
  }, [folders, projectMeta]);
  const projectsByFolder = useMemo(() => {
    const map = new Map<string | null, RuntimeProject[]>();
    for (const project of projects) {
      const folderId = folderByProject.get(project.id) ?? null;
      map.set(folderId, [...(map.get(folderId) ?? []), project]);
    }
    return map;
  }, [folderByProject, projects]);

  useEffect(() => {
    if (!loaded || projectsLoading || projectsError || projects.length === 0) return;
    const marker = canonicalProjectPrefsMigrationKey(scope);
    try {
      if (localStorage.getItem(marker) === "1") {
        migrationAttempt.current = scope;
        return;
      }
    } catch {
      // Continue with an in-memory, once-per-scope attempt if storage is unavailable.
    }
    if (migrationAttempt.current === scope) return;
    migrationAttempt.current = scope;

    void (async () => {
      try {
        const knownFolders = new Set(folders.map((folder) => folder.id));
        for (const project of projects) {
          const legacy = legacyPrefsForProject(project, legacyRepos, legacyWorkspaceMeta);
          const existing = projectMeta.find((entry) => entry.projectId === project.id);
          if ((!existing || existing.folderId === undefined) && legacy.folderId !== undefined) {
            const folderId = legacy.folderId && knownFolders.has(legacy.folderId) ? legacy.folderId : null;
            updateCanonicalProjectMeta(project.id, { folderId }, scope);
          }
          if (!project.displayName?.trim() && legacy.displayName) {
            await updateProject(project.id, { displayName: legacy.displayName });
          }
        }
        try { localStorage.setItem(marker, "1"); } catch { /* in-memory attempt still prevents request loops */ }
      } catch (error) {
        toast.error("Could not restore saved project preferences", { description: errorMessage(error) });
      }
    })();
  }, [folders, legacyRepos, legacyWorkspaceMeta, loaded, projectMeta, projects, projectsError, projectsLoading, scope, updateProject]);

  function openProjectEdit(project: RuntimeProject) {
    setEdit({ kind: "project", project });
    setName(project.displayName ?? project.name);
    const embeddedImage = project.imageUrl?.startsWith("data:image/webp;base64,") ? project.imageUrl : null;
    setImage(embeddedImage ? "" : project.imageUrl ?? "");
    setImageKind(embeddedImage ? "file" : "direct");
    setImageData(embeddedImage);
    setImageFileName(embeddedImage ? "Current project image" : "");
    setEditError(null);
  }

  function openFolderEdit(value: EditState) {
    setEdit(value);
    setName(value?.kind === "folder-edit" ? value.folder.name : "");
    setImage("");
    setImageData(null);
    setImageFileName("");
    setEditError(null);
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) return setEditError("Enter a name between 1 and 60 characters.");
    if (!edit) return;
    if (edit.kind === "folder-new") {
      saveProjectFolders(scope, [...loadProjectFolders(scope), { id: crypto.randomUUID(), name: trimmed }]);
      setEdit(null);
      return;
    }
    if (edit.kind === "folder-edit") {
      saveProjectFolders(scope, folders.map((folder) => folder.id === edit.folder.id ? { ...folder, name: trimmed } : folder));
      setEdit(null);
      return;
    }
    let imageUrl: string | null = null;
    if (imageKind === "file") {
      imageUrl = imageData;
    } else if (image.trim()) {
      imageUrl = imageKind === "favicon" ? projectFaviconUrl(image) : normalizeProjectImageUrl(image);
      if (!imageUrl) return setEditError("Enter a valid HTTP or HTTPS image or website URL without credentials.");
    }
    setSaving(true);
    try {
      await updateProject(edit.project.id, { displayName: trimmed === edit.project.name ? null : trimmed, imageUrl });
      setEdit(null);
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setImageValidating(true);
    try {
      const thumbnail = await projectImageThumbnail(file);
      setImageData(thumbnail);
      setImageFileName(file.name);
      setImage("");
      setEditError(null);
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setImageValidating(false);
    }
  }

  async function resume(session: SessionSummary) {
    if (!client) return;
    try { upsertSession(await client.resumeSession(session.id)); openSession(session); }
    catch (error) { toast.error("Could not resume", { description: errorMessage(error) }); }
  }
  async function sleep(session: SessionSummary) {
    if (!client) return;
    try { upsertSession(await client.sleepSession(session.id)); }
    catch (error) { toast.error("Could not sleep", { description: errorMessage(error) }); }
  }
  async function confirmDelete() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    try { await deleteSession(target.id); }
    catch (error) { toast.error("Could not delete", { description: errorMessage(error) }); }
  }

  async function saveRename(event: FormEvent) {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!renaming || !client) return;
    if (!title || title.length > 120) { setRenameError("Enter a title between 1 and 120 characters."); return; }
    setRenameSaving(true);
    setRenameError(null);
    try {
      upsertSession(await client.renameSession(renaming.id, title));
      setRenaming(null);
      toast.success("Conversation renamed");
    } catch (error) { setRenameError(errorMessage(error)); }
    finally { setRenameSaving(false); }
  }

  function copy(text: string, label: string) {
    void copyText(text).then(() => toast.success(`${label} copied`)).catch(() => toast.error(`Could not copy ${label.toLowerCase()}`));
  }
  function reveal(path: string) {
    revealItemInDir(path).catch((error) => toast.error("Could not open the folder", { description: errorMessage(error) }));
  }
  async function openTerminalHere(projectId: string, workspaceId: string) {
    if (!client) return;
    try {
      const session = await client.createSession({ provider: "shell", title: "Terminal", projectId, workspaceId });
      upsertSession(session);
      openSession(session, "agent");
    } catch (error) { toast.error("Could not open a terminal", { description: errorMessage(error) }); }
  }
  function setAllWorkspaces(project: RuntimeProject, open: boolean) {
    const next = { ...userPreferences.workspaceNavExpanded };
    for (const workspace of project.workspaces ?? []) next[`${project.id}:${workspace.id}`] = open;
    updateUserPreferences({ projectNavExpanded: { ...userPreferences.projectNavExpanded, [project.id]: true }, workspaceNavExpanded: next });
  }
  function hideSession(session: SessionSummary) {
    closeTab(session.id);
    updateUserPreferences({ hiddenSessionIds: { ...userPreferences.hiddenSessionIds, [session.id]: true } });
  }
  function restoreSession(session: SessionSummary) {
    const { [session.id]: _removed, ...rest } = userPreferences.hiddenSessionIds;
    updateUserPreferences({ hiddenSessionIds: rest });
  }

  function renderAgent(session: SessionSummary) {
    const hidden = !!userPreferences.hiddenSessionIds[session.id];
    const live = isLive(session.state);
    const recruited = recruits.get(session.id);
    return <ContextMenu key={session.id}><ContextMenuTrigger asChild><SidebarMenuSubItem className={cn("group/agent-row relative", ROW_OPEN)}>
      <SidebarMenuButton title={`${recruited !== undefined ? `${orchestratorLabel(recruited)} · ` : ""}${session.title} · ${session.provider} · ${session.state}${session.role ? ` · ${session.role}` : ""}`} isActive={((view === "terminal" || view === "session") && session.id === (view === "terminal" ? selectedTerminalId : selectedId)) || (view === "canvas" && session.id === selectedId)} className={cn("h-7 gap-1.5 pr-7 text-[13px] font-normal", recruited !== undefined && "bg-violet-500/10 shadow-[inset_2px_0_0_0_rgb(139_92_246)] hover:bg-violet-500/15")} onClick={() => focusOnCanvas(session)}>
        <span className="flex h-3 w-4 shrink-0 items-center justify-center">{agentActivity(session) ? <ActivityIndicator session={session} /> : <StateDot state={session.state} />}</span><span className="shrink-0 [&_svg]:size-3.5"><ProviderIcon provider={session.provider} /></span><span className="min-w-0 truncate">{session.title}</span>{recruited !== undefined && <IconCrown className={cn("size-3.5 shrink-0", ORCHESTRATOR_TEXT)} aria-label={orchestratorLabel(recruited)} />}
      </SidebarMenuButton>
      <DropdownMenu><DropdownMenuTrigger asChild><SidebarMenuAction className="top-1 text-muted-foreground md:opacity-0 md:group-hover/agent-row:opacity-100 md:group-focus-within/agent-row:opacity-100 md:aria-expanded:opacity-100" aria-label={`Actions for ${session.title}`}><IconDots /></SidebarMenuAction></DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className={MENU}>
          {!isLive(session.state) && <DropdownMenuItem onClick={() => void resume(session)}><IconPlayerPlay />Resume</DropdownMenuItem>}
          {session.state === "running" && <DropdownMenuItem onClick={() => void sleep(session)}><IconMoon />Sleep</DropdownMenuItem>}
          <DropdownMenuSeparator /><DropdownMenuItem onClick={() => { setRenaming(session); setRenameTitle(session.title); setRenameError(null); }}><IconPencil />Rename conversation</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyText(session.id).then(() => toast.success("Agent ID copied")).catch(() => toast.error("Could not copy the agent ID"))}><IconCopy />Copy agent ID</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(session)}><IconTrash />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuSubItem></ContextMenuTrigger>
      <ContextMenuContent className={CTX}>
        <ContextMenuItem onClick={() => focusOnCanvas(session, { dialog: true })}><IconExternalLink />Open</ContextMenuItem>
        {session.projectId && <ContextMenuItem onClick={() => focusOnCanvas(session)}><IconLayoutKanban />Open in canvas</ContextMenuItem>}
        {!live && <ContextMenuItem onClick={() => void resume(session)}><IconPlayerPlay />{session.state === "sleeping" ? "Resume" : "Restart"}</ContextMenuItem>}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => { setRenaming(session); setRenameTitle(session.title); setRenameError(null); }}><IconPencil />Rename conversation</ContextMenuItem>
        {isOrchestrator(session)
          ? <ContextMenuItem onClick={() => client && void setOrchestrator(client, session, false, upsertSession, toast)}><IconCrown />Remove orchestrator role</ContextMenuItem>
          : <ContextMenuItem title={ORCHESTRATOR_HINT} onClick={() => client && void setOrchestrator(client, session, true, upsertSession, toast)}><IconCrown />Set as orchestrator</ContextMenuItem>}
        <ContextMenuItem onClick={() => copy(session.title, "Title")}><IconCopy />Copy title</ContextMenuItem>
        <ContextMenuItem onClick={() => copy(session.id, "Agent ID")}><IconCopy />Copy agent ID</ContextMenuItem>
        <ContextMenuSeparator />
        {hidden
          ? <ContextMenuItem onClick={() => restoreSession(session)}><IconEye />Restore to sidebar</ContextMenuItem>
          : <ContextMenuItem disabled={live} onClick={() => hideSession(session)}><IconEyeOff />{live ? "Hide (agent is running)" : "Hide from sidebar"}</ContextMenuItem>}
        <ContextMenuItem variant="destructive" onClick={() => setDeleting(session)}><IconTrash />Delete</ContextMenuItem>
      </ContextMenuContent></ContextMenu>;
  }

  function renderProject(project: RuntimeProject) {
    const workspaces = project.workspaces ?? [];
    const projectExpanded = userPreferences.projectNavExpanded[project.id] ?? true;
    return <SidebarMenuItem key={project.id}>
      <Collapsible open={projectExpanded} onOpenChange={(open) => updateUserPreferences({ projectNavExpanded: { ...userPreferences.projectNavExpanded, [project.id]: open } })} className="group/project">
        <ContextMenu><ContextMenuTrigger asChild><div className={cn("group/project-row relative", ROW_OPEN)}>
          <SidebarMenuButton isActive={canvasProjectId === project.id} className="h-8 pr-14! text-[13px] font-medium" title={`${project.cwd} · open canvas`} onClick={() => openCanvas(project.id)}>
            <ProjectMark project={project} className="text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{project.displayName?.trim() || project.name}</span>
          </SidebarMenuButton>
          <CollapsibleTrigger asChild><SidebarMenuAction className="top-1/2! -translate-y-1/2 right-7! text-muted-foreground md:opacity-0 md:group-hover/project-row:opacity-100 md:focus-visible:opacity-100" aria-label={`Toggle ${project.displayName || project.name}`}><IconChevronRight className="transition-transform motion-reduce:transition-none group-data-[state=open]/project:rotate-90" /></SidebarMenuAction></CollapsibleTrigger>
          <DropdownMenu><DropdownMenuTrigger asChild><SidebarMenuAction className="top-1/2! -translate-y-1/2 right-1.5 transition-opacity md:opacity-0 md:group-hover/project-row:opacity-100 md:focus-visible:opacity-100 md:aria-expanded:opacity-100" aria-label={`Actions for ${project.displayName || project.name}`}><IconDots /></SidebarMenuAction></DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className={MENU}>
              <DropdownMenuItem onClick={() => openProjectEdit(project)}><IconPencil />Project settings</DropdownMenuItem>
              <DropdownMenuItem onClick={() => { selectProject(project.id); setNewAgentOpen(true); }}><IconPlus />New agent here</DropdownMenuItem>
              {folders.filter((folder) => folder.id !== folderByProject.get(project.id)).map((folder) => <DropdownMenuItem key={folder.id} onClick={() => updateCanonicalProjectMeta(project.id, { folderId: folder.id }, scope)}><IconFolder />Move to {folder.name}</DropdownMenuItem>)}
              {!!folderByProject.get(project.id) && <DropdownMenuItem onClick={() => updateCanonicalProjectMeta(project.id, { folderId: null }, scope)}><IconFolder />Move to root</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div></ContextMenuTrigger>
          <ContextMenuContent className={CTX}>
            <ContextMenuItem onClick={() => openCanvas(project.id)}><IconLayoutKanban />Open canvas</ContextMenuItem>
            <ContextMenuItem onClick={() => { selectProject(project.id); setNewAgentOpen(true); }}><IconPlus />New agent in this project</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => openProjectEdit(project)}><IconPencil />Rename / project settings</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(project.displayName?.trim() || project.name, "Project name")}><IconCopy />Copy project name</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(project.cwd, "Path")}><IconCopy />Copy path</ContextMenuItem>
            <ContextMenuItem disabled={!isTauri()} onClick={() => reveal(project.cwd)}><IconFolderOpen />{isTauri() ? "Reveal in file explorer" : "Reveal (desktop app only)"}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={workspaces.length === 0} onClick={() => setAllWorkspaces(project, true)}><IconChevronsDown />Expand all workspaces</ContextMenuItem>
            <ContextMenuItem disabled={workspaces.length === 0} onClick={() => setAllWorkspaces(project, false)}><IconChevronsUp />Collapse all workspaces</ContextMenuItem>
            <ContextMenuItem disabled={projectsLoading} onClick={() => void retryProjects().catch(() => {})}><IconRefresh />Refresh projects</ContextMenuItem>
            {(folders.filter((folder) => folder.id !== folderByProject.get(project.id)).length > 0 || !!folderByProject.get(project.id)) && <>
              <ContextMenuSeparator />
              <ContextMenuSub><ContextMenuSubTrigger><IconFolder />Move to folder</ContextMenuSubTrigger><ContextMenuSubContent>
                {folders.filter((folder) => folder.id !== folderByProject.get(project.id)).map((folder) => <ContextMenuItem key={folder.id} onClick={() => updateCanonicalProjectMeta(project.id, { folderId: folder.id }, scope)}><IconFolder />{folder.name}</ContextMenuItem>)}
                {!!folderByProject.get(project.id) && <ContextMenuItem onClick={() => updateCanonicalProjectMeta(project.id, { folderId: null }, scope)}><IconX />Root</ContextMenuItem>}
              </ContextMenuSubContent></ContextMenuSub>
            </>}
          </ContextMenuContent></ContextMenu>
        <CollapsibleContent>
          <SidebarMenuSub className="mx-0 translate-x-0 gap-0 border-0 py-0 pl-2 pr-0">
            {workspaces.map((workspace) => {
              const agents = sessionsForWorkspace(project.id, workspace, sessions).filter((session) => session.provider !== "shell" && (!userPreferences.hiddenSessionIds[session.id] || isLive(session.state) || openedIds.includes(session.id)));
              const label = workspace.branch || workspace.name || "Main";
              const workspaceKey = `${project.id}:${workspace.id}`;
              const workspaceExpanded = userPreferences.workspaceNavExpanded[workspaceKey] ?? true;
              return <SidebarMenuSubItem key={workspace.id} className="relative">
                <Collapsible open={workspaceExpanded} onOpenChange={(open) => updateUserPreferences({ workspaceNavExpanded: { ...userPreferences.workspaceNavExpanded, [workspaceKey]: open } })} className="group/workspace">
                  <ContextMenu><ContextMenuTrigger asChild><div className={cn("group/workspace-row relative", ROW_OPEN)}>
                    <CollapsibleTrigger asChild><SidebarMenuButton className={cn("h-8 gap-1.5 text-[13px] text-muted-foreground", workspace.isWorktree ? "pr-20!" : "pr-14!")} title={`${label} · ${workspace.cwd}`}>
                      <IconGitBranch /><span className="min-w-0 truncate">{label}</span>
                    </SidebarMenuButton></CollapsibleTrigger>
                    <Tooltip><TooltipTrigger asChild><SidebarMenuAction className={cn("top-1.5 text-muted-foreground md:opacity-0 md:group-hover/workspace-row:opacity-100 md:group-focus-within/workspace-row:opacity-100 md:aria-expanded:opacity-100", workspace.isWorktree ? "right-14!" : "right-7!")} aria-label={`New agent in ${label}`} onClick={() => { selectProject(project.id, workspace.id); setNewAgentOpen(true); }}><IconPlus /></SidebarMenuAction></TooltipTrigger><TooltipContent>New agent in {label}</TooltipContent></Tooltip>
                    <CollapsibleTrigger asChild><SidebarMenuAction className={cn("top-1.5 text-muted-foreground md:opacity-0 md:group-hover/workspace-row:opacity-100 md:focus-visible:opacity-100", workspace.isWorktree && "right-7!")} aria-label={`Toggle agents in ${label}`}><IconChevronRight className="transition-transform motion-reduce:transition-none group-data-[state=open]/workspace:rotate-90" /></SidebarMenuAction></CollapsibleTrigger>
                    {workspace.isWorktree && <DropdownMenu><DropdownMenuTrigger asChild><SidebarMenuAction className="top-1.5 text-muted-foreground md:opacity-0 md:group-hover/workspace-row:opacity-100 md:group-focus-within/workspace-row:opacity-100 md:aria-expanded:opacity-100" aria-label={`Actions for worktree ${label}`}><IconDots /></SidebarMenuAction></DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" className={MENU}>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeletingWorktree({ project, workspace })}><IconTrash />Delete worktree</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>}
                  </div></ContextMenuTrigger>
                    <ContextMenuContent className={CTX}>
                      <ContextMenuItem onClick={() => { selectProject(project.id, workspace.id); setNewAgentOpen(true); }}><IconPlus />New agent here</ContextMenuItem>
                      <ContextMenuItem disabled={!client} onClick={() => void openTerminalHere(project.id, workspace.id)}><IconTerminal2 />Open terminal here</ContextMenuItem>
                      <ContextMenuItem onClick={() => { selectProject(project.id, workspace.id); navigate("home"); }}><IconExternalLink />Open workspace</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => { selectProject(project.id, workspace.id); openRightSidebar("changes"); }}><IconGitCompare />Show changes</ContextMenuItem>
                      <ContextMenuItem onClick={() => { selectProject(project.id, workspace.id); openRightSidebar("files"); }}><IconFiles />Show files</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={!workspace.branch} onClick={() => copy(workspace.branch ?? "", "Branch name")}><IconGitBranch />{workspace.branch ? "Copy branch name" : "Copy branch name (no branch)"}</ContextMenuItem>
                      <ContextMenuItem onClick={() => copy(workspace.cwd, "Path")}><IconCopy />Copy path</ContextMenuItem>
                      <ContextMenuItem disabled={!isTauri()} onClick={() => reveal(workspace.cwd)}><IconFolderOpen />{isTauri() ? "Reveal in file explorer" : "Reveal (desktop app only)"}</ContextMenuItem>
                      {workspace.isWorktree && <><ContextMenuSeparator /><ContextMenuItem variant="destructive" onClick={() => setDeletingWorktree({ project, workspace })}><IconTrash />Delete worktree</ContextMenuItem></>}
                    </ContextMenuContent></ContextMenu>
                  <CollapsibleContent>
                    <SidebarMenuSub className="mx-0 translate-x-0 gap-1 border-0 py-1 pl-3 pr-0">{agents.length ? agents.map(renderAgent) : <SidebarMenuSubItem><span className="block px-2 py-1 text-xs text-muted-foreground">No agents</span></SidebarMenuSubItem>}</SidebarMenuSub>
                  </CollapsibleContent>
                </Collapsible>
              </SidebarMenuSubItem>;
            })}
            {workspaces.length === 0 && <SidebarMenuSubItem><span className="block px-2 py-1 text-xs text-muted-foreground">No workspaces</span></SidebarMenuSubItem>}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>;
  }

  const rootProjects = projectsByFolder.get(null) ?? [];
  return <>
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <div className="flex h-8 items-center justify-between gap-2 px-2 mb-1">
      <h2 className="text-xs font-medium text-muted-foreground">Projects</h2>
      <div className="flex items-center gap-0.5">
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="Refresh projects" disabled={projectsLoading} onClick={() => void retryProjects().catch(() => {})}><IconRefresh className={cn("size-3.5", projectsLoading && "animate-spin motion-reduce:animate-none")} /></Button></TooltipTrigger><TooltipContent>Refresh projects</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="New folder" onClick={() => openFolderEdit({ kind: "folder-new" })}><IconFolderPlus className="size-3.5" /></Button></TooltipTrigger><TooltipContent>New folder</TooltipContent></Tooltip>
      <DropdownMenu><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="Add to projects"><IconPlus className="size-3.5" /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>Add to projects</TooltipContent></Tooltip>
        <DropdownMenuContent align="start" side="right" className={MENU}>
          <DropdownMenuItem onClick={() => setNewAgentOpen(true)}><IconPlus />New agent</DropdownMenuItem>
          <DropdownMenuItem onClick={() => openFolderEdit({ kind: "folder-new" })}><IconFolderPlus />New folder</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRepoOpen(true)}><IconGitBranch />Import repository</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
      </div>
      <SidebarGroupContent>
        {projects.length === 0 && projectsError ? null : (!loaded || projectsLoading) && projects.length === 0 ? <p className="px-2 py-4 text-xs text-muted-foreground">Loading projects…</p> : projects.length === 0 ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">No projects found</p> :
          <SidebarMenu>
            {rootProjects.map(renderProject)}
            {folders.map((folder) => <SidebarMenuItem key={folder.id}><Collapsible open={userPreferences.folderNavExpanded[folder.id] ?? true} onOpenChange={(open) => updateUserPreferences({ folderNavExpanded: { ...userPreferences.folderNavExpanded, [folder.id]: open } })} className="group/folder">
              <div className="group/folder-row relative"><CollapsibleTrigger asChild><SidebarMenuButton className="h-8 pr-10 text-[13px] font-medium"><IconFolder className="text-muted-foreground" /><span className="truncate">{folder.name}</span><IconChevronRight className="ml-auto text-muted-foreground transition-transform motion-reduce:transition-none group-data-[state=open]/folder:rotate-90 md:opacity-0 md:group-hover/folder-row:opacity-100 md:group-focus-visible/menu-button:opacity-100" /></SidebarMenuButton></CollapsibleTrigger>
                <DropdownMenu><DropdownMenuTrigger asChild><SidebarMenuAction className="top-1/2! -translate-y-1/2 right-1.5 transition-opacity md:opacity-0 md:group-hover/folder-row:opacity-100 md:focus-visible:opacity-100 md:aria-expanded:opacity-100" aria-label={`Actions for ${folder.name}`}><IconDots /></SidebarMenuAction></DropdownMenuTrigger>
                  <DropdownMenuContent side="right" align="start" className={MENU}><DropdownMenuItem onClick={() => openFolderEdit({ kind: "folder-edit", folder })}><IconPencil />Rename folder</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => setRemoveFolder(folder)}><IconTrash />Remove folder</DropdownMenuItem></DropdownMenuContent>
                </DropdownMenu>
              </div>
              <CollapsibleContent><SidebarMenuSub className="mx-0 translate-x-0 gap-0 border-0 py-0 pl-2 pr-0">{(projectsByFolder.get(folder.id) ?? []).length ? (projectsByFolder.get(folder.id) ?? []).map(renderProject) : <SidebarMenuSubItem><span className="block px-2 py-2 text-xs text-muted-foreground">No projects in this folder</span></SidebarMenuSubItem>}</SidebarMenuSub></CollapsibleContent>
            </Collapsible></SidebarMenuItem>)}
          </SidebarMenu>}
        {projectsError && <div role="status" className="mt-2 flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground"><span className="min-w-0">{projects.length ? "Projects may be out of date" : "Could not load projects"}</span><Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs" disabled={projectsLoading} onClick={() => void retryProjects().catch(() => {})}>Retry</Button></div>}
      </SidebarGroupContent>
    </SidebarGroup>

    <CloneDialog open={repoOpen} onOpenChange={setRepoOpen} onClone={async (repo) => { await createProject({ gitUrl: repo.url, name: repo.label }); await refreshProjects(); }} />
    <AppDialog open={edit !== null} onOpenChange={(open) => !open && setEdit(null)} icon={edit?.kind.startsWith("folder") ? <IconFolderPlus /> : <IconPencil />} title={edit?.kind === "folder-new" ? "Create folder" : edit?.kind === "folder-edit" ? "Rename folder" : "Project settings"} description={edit?.kind === "project" ? "These details are shared with your other Floq sessions. Image URLs load directly in your browser." : "Folders organize projects in this sidebar. Removing a folder keeps its projects."} footer={<><Button variant="outline" disabled={saving || imageValidating} onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" form="canonical-project-edit" disabled={saving || imageValidating}>{imageValidating ? "Preparing image…" : saving ? "Saving…" : "Save"}</Button></>}>
      <form id="canonical-project-edit" onSubmit={(event) => void saveEdit(event)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-2"><Label htmlFor="canonical-project-name">{edit?.kind.startsWith("folder") ? "Name" : "Project name"}</Label><Input id="canonical-project-name" autoFocus maxLength={60} value={name} onChange={(event) => { setName(event.target.value); setEditError(null); }} /></div>
        {edit?.kind === "project" && <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="project-image-kind">Project image</Label>
            <Select value={imageKind} onValueChange={(value) => {
              setImageKind(value as "direct" | "favicon" | "file");
              setImage("");
              setImageData(null);
              setImageFileName("");
              setEditError(null);
            }}>
              <SelectTrigger id="project-image-kind" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">Direct image URL</SelectItem>
                <SelectItem value="favicon">Website favicon</SelectItem>
                <SelectItem value="file">Choose image file</SelectItem>
              </SelectContent>
            </Select>
            {imageKind === "file" ? <>
              <Label htmlFor="project-image-file">Choose an image</Label>
              <Input id="project-image-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-describedby="project-image-help" disabled={imageValidating || saving} onChange={(event) => void chooseImage(event)} />
              {imageFileName && <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="min-w-0 truncate" title={imageFileName}>{imageFileName}</span>{imageData && <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2" disabled={imageValidating || saving} onClick={() => { setImageData(null); setImageFileName(""); setEditError(null); }}>Remove image</Button>}</div>}
            </> : <Input aria-label={imageKind === "direct" ? "Image URL" : "Website URL"} placeholder={imageKind === "direct" ? "https://example.com/project.png" : "https://example.com"} value={image} onChange={(event) => { setImage(event.target.value); setEditError(null); }} />}
            {((imageKind === "file" && imageData) || (imageKind !== "file" && image.trim())) && <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"><span>Preview</span><img key={`${imageKind}:${imageData ?? image}`} src={imageKind === "file" ? imageData ?? undefined : imageKind === "favicon" ? projectFaviconUrl(image) ?? undefined : normalizeProjectImageUrl(image) ?? undefined} alt="" referrerPolicy="no-referrer" className="size-6 rounded object-cover" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /></div>}
            <p id="project-image-help" className="text-xs text-muted-foreground">Leave blank to clear. Files are reduced to 128 × 128 WebP thumbnails (32 KiB max). URL images must use HTTP or HTTPS.</p>
          </div>
        </>}
        {editError && <ErrorBanner>{editError}</ErrorBanner>}
      </form>
    </AppDialog>

    <AppDialog size="sm" open={renaming !== null} onOpenChange={(open) => { if (!open && !renameSaving) { setRenaming(null); setRenameError(null); } }} icon={renaming ? <ProviderIcon provider={renaming.provider} /> : <IconPencil />} title="Rename conversation" description="The agent ID and terminal session stay the same." footer={<><Button variant="outline" disabled={renameSaving} onClick={() => setRenaming(null)}>Cancel</Button><Button type="submit" form="rename-agent-form" disabled={renameSaving}>{renameSaving ? "Saving…" : "Save title"}</Button></>}>
      <form id="rename-agent-form" noValidate onSubmit={(event) => void saveRename(event)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-2"><Label htmlFor="rename-agent-title">Conversation title</Label><Input id="rename-agent-title" autoFocus maxLength={120} value={renameTitle} onChange={(event) => { setRenameTitle(event.target.value); setRenameError(null); }} /></div>
        {renameError && <ErrorBanner>{renameError}</ErrorBanner>}
      </form>
    </AppDialog>

    <AlertDialog open={removeFolder !== null} onOpenChange={(open) => !open && setRemoveFolder(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogMedia className="bg-destructive/10 text-destructive"><IconTrash /></AlertDialogMedia><AlertDialogTitle>Remove this folder?</AlertDialogTitle><AlertDialogDescription>Projects in “{removeFolder?.name}” stay in Floq and move to the root of the Projects list. No sessions or repository files are deleted.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (removeFolder) removeProjectFolder(scope, removeFolder.id); setRemoveFolder(null); }}>Remove folder</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <WorktreeDeleteDialog target={deletingWorktree} onClose={() => setDeletingWorktree(null)} />
    <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogMedia className="bg-destructive/10 text-destructive"><IconTrash /></AlertDialogMedia><AlertDialogTitle>Delete this agent?</AlertDialogTitle><AlertDialogDescription>“{deleting?.title}” and its terminal session will be removed. This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
