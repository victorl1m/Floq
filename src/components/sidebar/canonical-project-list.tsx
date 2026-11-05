import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  IconCheck,
  IconAlertTriangleFilled,
  IconChevronRight,
  IconCopy,
  IconChevronsDown,
  IconChevronsUp,
  IconDots,
  IconFolderOpen,
  IconLayoutKanban,
  IconX,
  IconFolder,
  IconFolderPlus,
  IconGitBranch,
  IconPencil,
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
import { SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import CloneDialog from "@/components/home/clone-dialog";
import WorktreeDeleteDialog, { type WorktreeDeleteTarget } from "@/components/sidebar/worktree-delete-dialog";
import { ProviderIcon } from "@/components/agents/provider";
import { advanceMemory, countByProject, projectStatus, type ProjectMemory, type ProjectStatus } from "@/lib/project-status";
import { ProjectMark } from "@/components/projects/project-identity";
import { canonicalProjectPrefsMigrationKey, legacyPrefsForProject, loadProjectFolders, projectScope, saveProjectFolders, updateCanonicalProjectMeta, useCanonicalProjectMeta, useProjectFolders, useRecentRepos, useWorkspaceProjectMeta, type ProjectFolder } from "@/lib/prefs";
import { projectFaviconUrl, normalizeProjectImageUrl } from "@/lib/runtime/project-appearance";
import { copyText } from "@/lib/clipboard";
import { isTauri } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { RuntimeProject, SessionSummary } from "@/lib/runtime/types";
import { cn } from "cn";
import { addFolder, applyDrop, containerOf, moveProjectInto, reconcileLayout, removeFolderFromLayout, saveLayout, type ProjectLayout } from "@/lib/project-folders";
import { DndButton, DndRow, EmptyFolderDrop, InlineRename, ProjectDnd, RootEndDrop, RowAction, useSavedLayout } from "@/components/sidebar/project-folder";
import { Skeleton } from "@/components/ui/skeleton";
import DeleteProjectDialog from "@/components/sidebar/delete-project-dialog";
import { setFolderExpanded as cacheFolderExpanded, useFolderExpanded } from "@/lib/project-folders-cache";
import { useProjectFoldersSync } from "@/lib/use-project-folders-sync";

const CTX = "w-56";
const ROW_OPEN = "rounded-md data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground";
const MENU = "w-48 min-w-[192px] whitespace-nowrap";
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 32 * 1024;
const SOURCE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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

type EditState = { kind: "project"; project: RuntimeProject } | null;

function ProjectStatusSlot({ status }: { status: ProjectStatus | null }) {
  // Fixed 16px slot, always rendered, so the label never shifts when a status appears or clears.
  return <span className="flex size-4 shrink-0 items-center justify-center">
    {status && <span role="status" title={status.label} aria-label={status.label} className="flex items-center justify-center">
      {status.kind === "errored" && <IconAlertTriangleFilled className="size-3.5 text-destructive" />}
      {status.kind === "running" && <span className="size-2 rounded-full bg-sky-500 animate-pulse motion-reduce:animate-none [.floq-reduced-motion_&]:animate-none" />}
      {status.kind === "finished" && <IconCheck className="size-3.5 text-emerald-500" stroke={3} />}
    </span>}
  </span>;
}

export default function CanonicalProjectList() {
  const { loaded, sessions, projects, projectsLoading, projectsError, retryProjects, canvasProjectId, openCanvas, client, upsertSession, deleteSession, setNewAgentOpen, selectProject, createProject, updateProject, refreshProjects, baseUrl, user, setProjectNavExpanded } = useRuntime();
  const scope = projectScope(baseUrl, user?.id ?? null);
  const folders = useProjectFolders(scope);
  useProjectFoldersSync();
  const folderExpanded = useFolderExpanded(scope);
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
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [deletingWorktree, setDeletingWorktree] = useState<WorktreeDeleteTarget | null>(null);
  const [deletingProject, setDeletingProject] = useState<RuntimeProject | null>(null);
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);

  const folderByProject = useMemo(() => {
    const knownFolders = new Set(folders.map((folder) => folder.id));
    return new Map(projectMeta.map((item) => [item.projectId, item.folderId && knownFolders.has(item.folderId) ? item.folderId : null]));
  }, [folders, projectMeta]);
  const savedLayout = useSavedLayout(scope);
  const layout = useMemo<ProjectLayout>(
    () => reconcileLayout(savedLayout, projects.map((project) => project.id), folders.map((folder) => folder.id), (id) => folderByProject.get(id)),
    [folderByProject, folders, projects, savedLayout],
  );
  const projectCounts = useMemo(() => countByProject(sessions), [sessions]);
  const [projectMemory, setProjectMemory] = useState<Map<string, ProjectMemory>>(() => new Map());
  useEffect(() => {
    setProjectMemory((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const id of new Set([...prev.keys(), ...projectCounts.keys()])) {
        const before = prev.get(id);
        const after = advanceMemory(before, projectCounts.get(id), id === canvasProjectId);
        if (!before || before.wasWorking !== after.wasWorking || before.finished !== after.finished) { next.set(id, after); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [projectCounts, canvasProjectId]);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const foldersById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const projectLabel = (project: RuntimeProject) => project.displayName?.trim() || project.name;

  function createFolder(withProjectId?: string, parentId?: string) {
    const id = crypto.randomUUID();
    let next = addFolder(layout, id);
    if (parentId) {
      const nested = applyDrop(next, { kind: "folder", id }, { type: "folder", id: parentId, edge: "into" });
      if (nested === next) { toast.error("A folder can be nested at most 8 levels deep."); return; }
      next = nested;
      setFolderExpanded(parentId, true);
    }
    saveProjectFolders(scope, [...loadProjectFolders(scope), { id, name: "New folder" }]);
    if (withProjectId) next = moveProjectInto(next, withProjectId, id);
    saveLayout(scope, next);
    cacheFolderExpanded(scope, id, true);
    setRenamingFolder(id);
  }
  function renameFolder(folder: ProjectFolder, value: string) {
    setRenamingFolder(null);
    const trimmed = value.trim();
    if (!trimmed || trimmed === folder.name) return;
    saveProjectFolders(scope, loadProjectFolders(scope).map((item) => item.id === folder.id ? { ...item, name: trimmed.slice(0, 60) } : item));
  }
  function deleteFolder(folder: ProjectFolder) {
    const count = layout.folders[folder.id]?.length ?? 0;
    const previous = layout;
    saveProjectFolders(scope, loadProjectFolders(scope).filter((item) => item.id !== folder.id));
    saveLayout(scope, removeFolderFromLayout(layout, folder.id));
    toast(`Folder “${folder.name}” removed`, {
      icon: <IconTrash className="size-4" aria-hidden="true" />,
      description: count ? "Its contents moved to the folder's previous location. Undo restores the folder." : "Undo restores the folder and its contents.",
      action: { label: "Undo", onClick: () => {
        const current = loadProjectFolders(scope);
        if (!current.some((item) => item.id === folder.id)) saveProjectFolders(scope, [...current, folder]);
        saveLayout(scope, previous);
      } },
    });
  }
  function moveProject(projectId: string, folderId: string | null) { saveLayout(scope, moveProjectInto(layout, projectId, folderId)); }
  function setFolderExpanded(folderId: string, open: boolean) { cacheFolderExpanded(scope, folderId, open); }

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

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 60) return setEditError("Enter a name between 1 and 60 characters.");
    if (!edit) return;
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

  async function confirmDelete() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    try { await deleteSession(target.id); }
    catch (error) { toast.error(`Could not delete ${target.title}`, { description: errorMessage(error) }); }
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
      toast.success("Conversation renamed", { description: "The new title shows in the sidebar." });
    } catch (error) { setRenameError(errorMessage(error)); }
    finally { setRenameSaving(false); }
  }

  function copy(text: string, label: string) {
    void copyText(text).then(() => toast.success(`${label} copied`, { description: "It is on your clipboard." })).catch(() => toast.error(`Could not copy ${label.toLowerCase()}`, { description: "The clipboard is not available. Select the text and copy it by hand." }));
  }
  function reveal(path: string) {
    revealItemInDir(path).catch((error) => toast.error("Could not open the folder", { description: errorMessage(error) }));
  }
  function renderProject(project: RuntimeProject) {
    const currentFolder = containerOf(layout, project.id) ?? null;
    return <SidebarMenuItem key={project.id}>
      <div className="group/project">
        <ContextMenu><ContextMenuTrigger asChild><DndRow kind="project" itemId={project.id} className={cn("group/project-row", ROW_OPEN)}>
          <SidebarMenuButton asChild isActive={canvasProjectId === project.id} className="h-8 pr-8! text-[13px] font-medium"><DndButton title={`${project.cwd} · open canvas`} onClick={() => openCanvas(project.id)}>
            <ProjectMark project={project} className="text-muted-foreground [&:is(img)]:bg-sidebar-accent/40 [&:is(img)]:ring-1 [&:is(img)]:ring-sidebar-border/70" /><span className="min-w-0 flex-1 truncate">{project.displayName?.trim() || project.name}</span>
            <ProjectStatusSlot status={projectStatus(projectCounts.get(project.id), projectMemory.get(project.id))} />
          </DndButton></SidebarMenuButton>
          <DropdownMenu><DropdownMenuTrigger asChild><RowAction slot="chevron" reveal="md:group-hover/project-row:opacity-100 md:group-focus-within/project-row:opacity-100" aria-label={`Actions for ${project.displayName || project.name}`}><IconDots /></RowAction></DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start" className={MENU}>
              <DropdownMenuItem onClick={() => openProjectEdit(project)}><IconPencil />Project settings</DropdownMenuItem>
              <DropdownMenuItem onClick={() => { selectProject(project.id); setNewAgentOpen(true); }}><IconPlus />New agent here</DropdownMenuItem>
              {currentFolder !== null && <DropdownMenuItem onClick={() => moveProject(project.id, null)}><IconX />Move out of folder</DropdownMenuItem>}
              <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => setDeletingProject(project)}><IconTrash />Delete project…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </DndRow></ContextMenuTrigger>
          <ContextMenuContent className={CTX}>
            <ContextMenuItem onClick={() => openCanvas(project.id)}><IconLayoutKanban />Open canvas</ContextMenuItem>
            <ContextMenuItem onClick={() => { selectProject(project.id); setNewAgentOpen(true); }}><IconPlus />New agent in this project</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => openProjectEdit(project)}><IconPencil />Rename / project settings</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(project.displayName?.trim() || project.name, "Project name")}><IconCopy />Copy project name</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(project.cwd, "Path")}><IconCopy />Copy path</ContextMenuItem>
            <ContextMenuItem disabled={!isTauri()} onClick={() => reveal(project.cwd)}><IconFolderOpen />{isTauri() ? "Reveal in file explorer" : "Reveal (desktop app only)"}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={project.workspaces.every((workspace) => workspace.navExpanded === false)} onClick={() => void setProjectNavExpanded(project.id, false)}><IconChevronsUp />Collapse all workspaces</ContextMenuItem>
            <ContextMenuItem disabled={project.workspaces.every((workspace) => workspace.navExpanded !== false)} onClick={() => void setProjectNavExpanded(project.id, true)}><IconChevronsDown />Expand all workspaces</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={projectsLoading} onClick={() => void retryProjects().catch(() => {})}><IconRefresh />Refresh projects</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuSub><ContextMenuSubTrigger><IconFolder />Move to folder</ContextMenuSubTrigger><ContextMenuSubContent>
              {folders.filter((folder) => folder.id !== currentFolder).map((folder) => <ContextMenuItem key={folder.id} onClick={() => moveProject(project.id, folder.id)}><IconFolder />{folder.name}</ContextMenuItem>)}
              {currentFolder !== null && <ContextMenuItem onClick={() => moveProject(project.id, null)}><IconX />Move out of folder</ContextMenuItem>}
              <ContextMenuItem onClick={() => createFolder(project.id)}><IconFolderPlus />New folder…</ContextMenuItem>
            </ContextMenuSubContent></ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => setDeletingProject(project)}><IconTrash />Delete project…</ContextMenuItem>
          </ContextMenuContent></ContextMenu>
      </div>
    </SidebarMenuItem>;
  }

  function renderFolder(folder: ProjectFolder) {
    const expanded = folderExpanded[folder.id] ?? true;
    const members = (layout.folders[folder.id] ?? []).flatMap((id) => projectsById.get(id) ?? []);
    const entries = layout.children?.[folder.id] ?? members.map((project) => ({ kind: "project" as const, id: project.id }));
    const menu = {
      rename: () => setRenamingFolder(folder.id),
      toggle: () => setFolderExpanded(folder.id, !expanded),
      remove: () => deleteFolder(folder),
    };
    return <SidebarMenuItem key={folder.id}>
      <Collapsible open={expanded} onOpenChange={(open) => setFolderExpanded(folder.id, open)} className="group/folder">
        <ContextMenu><ContextMenuTrigger asChild><DndRow kind="folder" itemId={folder.id} className={cn("group/folder-row", ROW_OPEN)}>
          {renamingFolder === folder.id
            ? <div className="flex h-8 items-center gap-2 px-2"><IconFolder className="size-4 shrink-0 text-muted-foreground" /><InlineRename initial={folder.name} label="Folder name" onCommit={(value) => renameFolder(folder, value)} onCancel={() => setRenamingFolder(null)} /></div>
            : <>
              <CollapsibleTrigger asChild><SidebarMenuButton asChild className="h-8 pr-14! text-[13px] font-medium"><DndButton title={`${folder.name} · ${members.length} ${members.length === 1 ? "project" : "projects"}`}>
                {expanded ? <IconFolderOpen className="text-muted-foreground" /> : <IconFolder className="text-muted-foreground" />}<span className="min-w-0 flex-1 truncate">{folder.name}</span>
              </DndButton></SidebarMenuButton></CollapsibleTrigger>
              <span aria-hidden className="pointer-events-none absolute top-1/2 right-7 flex size-6 -translate-y-1/2 items-center justify-center text-[11px] tabular-nums text-muted-foreground transition-opacity md:group-hover/folder-row:opacity-0 md:group-focus-within/folder-row:opacity-0 md:group-has-aria-expanded/folder-row:opacity-0">{members.length}</span>
              <DropdownMenu><DropdownMenuTrigger asChild><RowAction slot="second" reveal="md:group-hover/folder-row:opacity-100 md:group-focus-within/folder-row:opacity-100" aria-label={`Actions for ${folder.name}`}><IconDots /></RowAction></DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" className={MENU}><DropdownMenuItem onClick={() => createFolder(undefined, folder.id)}><IconFolderPlus />New subfolder</DropdownMenuItem><DropdownMenuItem onSelect={menu.rename}><IconPencil />Rename folder</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={menu.remove}><IconTrash />Delete folder</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
              <CollapsibleTrigger asChild><RowAction slot="chevron" aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`}><IconChevronRight className="transition-transform motion-reduce:transition-none group-data-[state=open]/folder:rotate-90" /></RowAction></CollapsibleTrigger>
            </>}
        </DndRow></ContextMenuTrigger>
          <ContextMenuContent className={CTX}>
            <ContextMenuItem onSelect={menu.rename}><IconPencil />Rename folder</ContextMenuItem>
            <ContextMenuItem onClick={menu.toggle}>{expanded ? <IconChevronsUp /> : <IconChevronsDown />}{expanded ? "Collapse" : "Expand"}</ContextMenuItem>
            <ContextMenuItem onClick={() => createFolder(undefined, folder.id)}><IconFolderPlus />New subfolder</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={menu.remove}><IconTrash />Delete folder (keep projects)</ContextMenuItem>
          </ContextMenuContent></ContextMenu>
        <CollapsibleContent>
          <ul className="ml-3 flex min-w-0 flex-col border-l border-sidebar-border/60">
            {entries.length ? entries.map((entry) => entry.kind === "project" ? (projectsById.get(entry.id) ? renderProject(projectsById.get(entry.id)!) : null) : (foldersById.get(entry.id) ? renderFolder(foldersById.get(entry.id)!) : null)) : <li><EmptyFolderDrop folderId={folder.id}><span className="flex h-8 items-center px-2 text-xs text-muted-foreground">Drop items here</span></EmptyFolderDrop></li>}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>;
  }

  return <>
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <div className="flex h-8 items-center justify-between gap-2 px-2 mb-1">
      <h2 className="text-xs font-medium text-muted-foreground">Projects</h2>
      <div className="flex items-center gap-0.5">
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="Refresh projects" disabled={projectsLoading} onClick={() => void retryProjects().catch(() => {})}><IconRefresh className={cn("size-3.5", projectsLoading && "animate-spin motion-reduce:animate-none")} /></Button></TooltipTrigger><TooltipContent>Refresh projects</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="New folder" onClick={() => createFolder()}><IconFolderPlus className="size-3.5" /></Button></TooltipTrigger><TooltipContent>New folder</TooltipContent></Tooltip>
      <DropdownMenu><Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label="Add to projects"><IconPlus className="size-3.5" /></Button></DropdownMenuTrigger></TooltipTrigger><TooltipContent>Add to projects</TooltipContent></Tooltip>
        <DropdownMenuContent align="start" side="right" className={MENU}>
          <DropdownMenuItem onClick={() => setNewAgentOpen(true)}><IconPlus />New agent</DropdownMenuItem>
          <DropdownMenuItem onClick={() => createFolder()}><IconFolderPlus />New folder</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRepoOpen(true)}><IconGitBranch />Import repository</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
      </div>
      <SidebarGroupContent>
        {projects.length === 0 && projectsError ? null : (!loaded || projectsLoading) && projects.length === 0 ? <div role="status" aria-label="Loading projects" aria-busy="true" className="space-y-1 px-2 py-2">{[0, 1, 2].map((row) => <div key={row} className="flex h-8 items-center gap-2"><Skeleton className="size-4 shrink-0" /><Skeleton className="h-3 flex-1" /></div>)}</div> : projects.length === 0 ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">No projects found</p> :
          <ProjectDnd layout={layout} onLayout={(next) => saveLayout(scope, next)} isFolderExpanded={(id) => folderExpanded[id] ?? true} onExpandFolder={(id) => setFolderExpanded(id, true)}
            labelOf={(kind, id) => kind === "folder" ? foldersById.get(id)?.name ?? "folder" : projectsById.get(id) ? projectLabel(projectsById.get(id)!) : "project"}
            renderOverlay={(kind, id) => <div className="flex h-8 w-56 items-center gap-2 rounded-md border border-sidebar-border bg-popover px-2 text-[13px] font-medium text-popover-foreground shadow-md">
              {kind === "folder" ? <IconFolder className="size-4 shrink-0 text-muted-foreground" /> : projectsById.get(id) ? <ProjectMark project={projectsById.get(id)!} className="text-muted-foreground" /> : null}
              <span className="min-w-0 flex-1 truncate">{kind === "folder" ? foldersById.get(id)?.name : projectsById.get(id) ? projectLabel(projectsById.get(id)!) : ""}</span></div>}>
          <SidebarMenu>
            {layout.root.map((entry) => {
              if (entry.kind === "project") { const project = projectsById.get(entry.id); return project ? renderProject(project) : null; }
              const folder = foldersById.get(entry.id);
              return folder ? renderFolder(folder) : null;
            })}
            <RootEndDrop />
          </SidebarMenu></ProjectDnd>}
        {projectsError && <div role="status" className="mt-2 flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground"><span className="min-w-0">{projects.length ? "Projects may be out of date" : "Could not load projects"}</span><Button variant="ghost" size="sm" className="h-6 shrink-0 px-1.5 text-xs" disabled={projectsLoading} onClick={() => void retryProjects().catch(() => {})}>Retry</Button></div>}
      </SidebarGroupContent>
    </SidebarGroup>

    <CloneDialog open={repoOpen} onOpenChange={setRepoOpen} onClone={async (repo) => { await createProject({ gitUrl: repo.url, name: repo.label }); await refreshProjects(); }} />
    <AppDialog open={edit !== null} onOpenChange={(open) => !open && setEdit(null)} icon={<IconPencil />} title="Project settings" description="These details are shared with your other Floq sessions. Image URLs load directly in your browser." footer={<><Button variant="outline" disabled={saving || imageValidating} onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" form="canonical-project-edit" disabled={saving || imageValidating}>{imageValidating ? "Preparing image…" : saving ? "Saving…" : "Save"}</Button></>}>
      <form id="canonical-project-edit" noValidate onSubmit={(event) => void saveEdit(event)} className="flex flex-col gap-3">
        <div className="flex flex-col gap-2"><Label htmlFor="canonical-project-name">Project name</Label><Input id="canonical-project-name" autoFocus maxLength={60} value={name} onChange={(event) => { setName(event.target.value); setEditError(null); }} /></div>
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

    <WorktreeDeleteDialog target={deletingWorktree} onClose={() => setDeletingWorktree(null)} />
    <DeleteProjectDialog project={deletingProject} onClose={() => setDeletingProject(null)} />
    <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogMedia className="bg-destructive/10 text-destructive"><IconTrash /></AlertDialogMedia><AlertDialogTitle>Delete this agent?</AlertDialogTitle><AlertDialogDescription>“{deleting?.title}” and its terminal session will be removed. You can undo for a few seconds afterwards.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
