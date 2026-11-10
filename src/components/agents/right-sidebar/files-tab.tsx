import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { toast } from "sonner";
import { IconChevronRight, IconCopy, IconDownload, IconFiles, IconFolderOpen, IconFoldersOff, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import { canOpenInExplorer, downloadWorkspacePath, ejectProjectMount, hasOpenMount, openProjectInExplorer } from "@/lib/file-download";
import { cn } from "cn";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { FileEntry, FileListing } from "@/lib/runtime/workspace-files";
import { errorMessage } from "@/lib/runtime/store";
import { FileIcon, FolderIcon } from "./file-icons";
import { buildTreeStatus, hasGitChanges, publishGitChanges, STATUS_BADGE_TONE, STATUS_NAME_TONE, useGitChanges } from "./git-status";
import { GROUP_LETTER, type ChangeGroup } from "./diff-parse";
import FileDialog from "./files-tab-file-dialog";
import { PanelEmpty, PanelError, RowSkeletons } from "./panel-states";
import type { WorkspaceTarget } from "./changes-tab";

type Listing = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; listing: FileListing };

type Row =
  | { kind: "node"; item: FileEntry; depth: number }
  | { kind: "status"; key: string; depth: number; tone: "loading" | "error" | "empty" | "more"; text: string; retry?: string };

/** Tree paths are namespaced per project folder: "<target id>", a newline, then the path relative to that folder. */
const treePath = (targetId: string, rel: string) => `${targetId}\n${rel}`;
function splitTreePath(full: string): { id: string; rel: string } {
  const index = full.indexOf("\n");
  return { id: full.slice(0, index), rel: full.slice(index + 1) };
}

const INDENT = 12;
const BASE_PAD = 8;

/** Folders first, then files, each alphabetical. */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) : a.type === "dir" ? -1 : 1));
}

function nameTone(status: ChangeGroup | "dir" | null): string {
  return status === null ? "" : status === "dir" ? "text-amber-700/90 dark:text-amber-300/90" : STATUS_NAME_TONE[status];
}

function StatusMark({ status }: { status: ChangeGroup | "dir" | null }) {
  if (status === null) return null;
  if (status === "dir") return <span aria-label="Contains changes" title="Contains changes" className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />;
  return <span aria-hidden className={cn("w-3 shrink-0 text-center font-mono text-[10px] font-semibold", STATUS_BADGE_TONE[status])}>{GROUP_LETTER[status]}</span>;
}

/** Lazy file explorer of every folder / worktree in the active project (one top-level node each) that opens files in a read-only dialog. */
export default function FilesTab({ client, targets, projectId }: { client: RuntimeClient; targets: WorkspaceTarget[]; projectId?: string | null }) {
  const [dirs, setDirs] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [dialogPath, setDialogPath] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [treeFocused, setTreeFocused] = useState(false);
  const [menuItem, setMenuItem] = useState<FileEntry | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTarget = useRef<FileEntry | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const generation = useRef(0);
  const gitChanges = useGitChanges();
  const statusByTarget = useMemo(() => new Map(targets.map((target) => [target.id, buildTreeStatus(gitChanges.get(target.id))])), [targets, gitChanges]);
  /** Git status of a tree node: file group, or "dir" when a folder contains changes. */
  const statusOf = (item: FileEntry): ChangeGroup | "dir" | null => {
    const { id, rel } = splitTreePath(item.path);
    const status = statusByTarget.get(id);
    if (!status) return null;
    return item.type === "dir" ? (status.dirs.has(rel) ? "dir" : null) : status.files.get(rel) ?? null;
  };

  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const signature = targets.map((target) => `${target.id}:${target.sessionId}`).join("|");
  const multi = targets.length > 1;

  const load = useCallback((path: string, silent = false) => {
    const gen = generation.current;
    const { id, rel } = splitTreePath(path);
    const target = targetsRef.current.find((item) => item.id === id);
    if (!target) return;
    setDirs((current) => (silent && current[path]?.state === "ready" ? current : { ...current, [path]: { state: "loading" } }));
    client.listFiles(target.sessionId, rel)
      .then((listing) => {
        // Namespace entry paths so the same relative path in two folders stays distinct.
        const entries = sortEntries(listing.entries.map((entry) => ({ ...entry, path: treePath(id, entry.path) })));
        if (gen === generation.current) setDirs((current) => ({ ...current, [path]: { state: "ready", listing: { ...listing, entries } } }));
      })
      .catch((cause) => { if (gen === generation.current) setDirs((current) => ({ ...current, [path]: { state: "error", message: errorMessage(cause) } })); });
  }, [client]);

  // A different workspace starts from a fresh tree.
  useEffect(() => {
    generation.current++;
    setDirs({});
    setExpanded({});
    setSelected(null);
    setDialogPath(null);
    setCursor(null);
    setQuery("");
    const roots = targetsRef.current.map((target) => treePath(target.id, ""));
    // Several project folders: each is a top-level node, opened by default.
    setExpanded(roots.length > 1 ? Object.fromEntries(roots.map((root) => [root, true])) : {});
    for (const root of roots) load(root);
    for (const target of targetsRef.current) {
      if (hasGitChanges(target.id)) continue;
      client.gitChanges(target.sessionId).then((result) => publishGitChanges(target.id, result)).catch(() => { /* not a git repository: no status colors */ });
    }
  }, [load, signature, client]);

  function toggle(path: string, force?: boolean) {
    const open = force ?? !expandedRef.current[path];
    setExpanded((current) => ({ ...current, [path]: open }));
    if (open && dirs[path]?.state !== "ready") load(path);
  }

  function refresh() {
    const open = Object.keys(expandedRef.current).filter((path) => expandedRef.current[path]);
    const roots = targets.map((target) => treePath(target.id, ""));
    for (const path of new Set([...roots, ...open])) load(path, true);
    for (const target of targets) client.gitChanges(target.sessionId).then((result) => publishGitChanges(target.id, result)).catch(() => {});
  }

  function openFile(path: string) {
    setSelected(path);
    setDialogPath(path);
  }

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    const walk = (path: string, depth: number) => {
      const entry = dirs[path];
      if (!entry || entry.state === "loading") {
        if (splitTreePath(path).rel !== "") result.push({ kind: "status", key: `${path}:loading`, depth, tone: "loading", text: "Loading…" });
        return;
      }
      if (entry.state === "error") { result.push({ kind: "status", key: `${path}:error`, depth, tone: "error", text: entry.message, retry: path }); return; }
      if (entry.listing.entries.length === 0 && splitTreePath(path).rel !== "") { result.push({ kind: "status", key: `${path}:empty`, depth, tone: "empty", text: "Empty folder" }); return; }
      for (const item of entry.listing.entries) {
        result.push({ kind: "node", item, depth });
        if (item.type === "dir" && expanded[item.path]) walk(item.path, depth + 1);
      }
      if (entry.listing.truncated) result.push({ kind: "status", key: `${path}:more`, depth, tone: "more", text: "Showing the first 2,000 entries." });
    };
    for (const target of targets) {
      const rootPath = treePath(target.id, "");
      if (!multi) { walk(rootPath, 0); continue; }
      result.push({ kind: "node", item: { name: target.label, path: rootPath, type: "dir" }, depth: 0 });
      if (expanded[rootPath]) walk(rootPath, 1);
    }
    return result;
  }, [dirs, expanded, targets, multi]);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo<FileEntry[]>(() => {
    if (!needle) return [];
    const matches: FileEntry[] = [];
    for (const entry of Object.values(dirs)) {
      if (entry.state !== "ready") continue;
      for (const item of entry.listing.entries) if (item.name.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle)) matches.push(item);
    }
    return sortEntries(matches).slice(0, 300);
  }, [dirs, needle]);

  const nodes = useMemo(() => (needle ? filtered.map((item) => ({ item, depth: 0 })) : rows.flatMap((row) => (row.kind === "node" ? [{ item: row.item, depth: row.depth }] : []))), [needle, filtered, rows]);
  const cursorIndex = cursor ? nodes.findIndex((node) => node.item.path === cursor) : -1;

  useEffect(() => {
    if (cursorIndex >= 0) document.getElementById(`files-row-${cursorIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [cursorIndex]);

  function activate(item: FileEntry) {
    setCursor(item.path);
    if (item.type === "dir") {
      if (needle) { setQuery(""); toggle(item.path, true); } else toggle(item.path);
    } else openFile(item.path);
  }

  const itemTarget = (item: FileEntry) => {
    const { id, rel } = splitTreePath(item.path);
    return { target: targets.find((candidate) => candidate.id === id), rel };
  };

  function downloadItem(item: FileEntry) {
    const { target, rel } = itemTarget(item);
    if (!target) return;
    void downloadWorkspacePath(client, target.sessionId, rel, item.type === "dir" ? "dir" : "file", rel ? rel.split("/").pop()! : target.label);
  }

  function copyItemPath(item: FileEntry, relative: boolean) {
    const { target, rel } = itemTarget(item);
    const text = relative || !multi ? rel || "." : [target?.label, rel].filter(Boolean).join("/");
    void copyText(text).then(() => toast.success(relative ? "Relative path copied" : "Path copied")).catch(() => toast.error("Could not copy to the clipboard"));
  }

  /** Right-click, or the ContextMenu key / Shift+F10 on the focused row (the native event is re-dispatched at the row so Radix opens it). */
  function onTreeContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tree-path]");
    const item = row ? nodes.find((node) => node.item.path === row.dataset.treePath)?.item : undefined;
    // Radix opens its menu after this handler regardless; onOpenChange below refuses when no row was hit.
    menuTarget.current = item ?? null;
    if (!item) return;
    setCursor(item.path);
    setMenuItem(item);
  }

  function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (nodes.length === 0) return;
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const row = document.getElementById(`files-row-${cursorIndex >= 0 ? cursorIndex : 0}`);
      if (row) {
        event.preventDefault();
        const box = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.bottom }));
      }
      return;
    }
    const index = cursorIndex >= 0 ? cursorIndex : 0;
    const current = nodes[index];
    const move = (next: number) => { event.preventDefault(); setCursor(nodes[Math.max(0, Math.min(nodes.length - 1, next))].item.path); };
    switch (event.key) {
      case "ArrowDown": return move(cursorIndex < 0 ? 0 : index + 1);
      case "ArrowUp": return move(index - 1);
      case "Home": return move(0);
      case "End": return move(nodes.length - 1);
      case "ArrowRight":
        if (needle || current.item.type !== "dir") return;
        event.preventDefault();
        if (!expanded[current.item.path]) toggle(current.item.path, true);
        else if (nodes[index + 1] && nodes[index + 1].depth > current.depth) setCursor(nodes[index + 1].item.path);
        return;
      case "ArrowLeft": {
        if (needle) return;
        event.preventDefault();
        if (current.item.type === "dir" && expanded[current.item.path]) { toggle(current.item.path, false); return; }
        for (let i = index - 1; i >= 0; i--) if (nodes[i].depth < current.depth) { setCursor(nodes[i].item.path); return; }
        return;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        activate(current.item);
        return;
    }
  }

  const root = multi ? undefined : dirs[treePath(targets[0]?.id ?? "", "")];
  const dialogTarget = dialogPath ? targets.find((target) => target.id === splitTreePath(dialogPath).id) : undefined;
  const treeActiveId = treeFocused && cursorIndex >= 0 ? `files-row-${cursorIndex}` : undefined;

  const tree = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 bg-background/20 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Filter loaded files" placeholder="Filter files" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); if (event.key === "ArrowDown") { event.preventDefault(); treeRef.current?.focus(); } }} className="h-7 pr-6 pl-7 text-xs" />
          {query && <Button variant="ghost" size="icon-xs" type="button" aria-label="Clear filter" onClick={() => setQuery("")} className="absolute inset-y-0 right-1.5 my-auto size-5 text-muted-foreground"><IconX className="size-3" /></Button>}
        </div>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Collapse all folders" title="Collapse all" onClick={() => setExpanded({})}><IconFoldersOff /></Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh files" title="Refresh files" onClick={refresh}><IconRefresh /></Button>
      </div>
      <ContextMenu open={menuOpen} onOpenChange={(open) => {
        if (open && !menuTarget.current) return;
        setMenuOpen(open);
        if (!open) { menuTarget.current = null; window.setTimeout(() => treeRef.current?.focus({ preventScroll: true }), 0); }
      }}>
      <ContextMenuTrigger asChild>
      <div
        ref={treeRef}
        role="tree"
        onContextMenu={onTreeContextMenu}
        aria-label="Workspace files"
        tabIndex={0}
        aria-activedescendant={treeActiveId}
        onKeyDown={onTreeKeyDown}
        onFocus={() => setTreeFocused(true)}
        onBlur={() => setTreeFocused(false)}
        className="min-h-0 flex-1 overflow-auto py-1 focus-visible:outline-none"
      >
        {targets.length === 0 ? <PanelEmpty icon={<IconFiles />} title="No folders to browse" hint="Start an agent in this project to browse its files." />
          : !multi && (!root || root.state === "loading") ? <RowSkeletons count={9} />
          : root?.state === "error" ? <PanelError message={root.message} onRetry={() => load(treePath(targets[0].id, ""))} />
          : needle ? (
            filtered.length === 0 ? <PanelEmpty icon={<IconSearch />} title="No matching files" hint="Only folders you have expanded are searched." />
              : filtered.map((item, index) => {
                const { rel: itemRel } = splitTreePath(item.path);
                const dir = itemRel.includes("/") ? itemRel.slice(0, itemRel.lastIndexOf("/")) : "";
                return (
                  <div key={item.path} id={`files-row-${index}`} data-tree-path={item.path} role="treeitem" aria-selected={selected === item.path} title={splitTreePath(item.path).rel || item.name} onClick={() => activate(item)} className={cn("flex h-6 min-w-0 cursor-pointer items-center gap-1.5 px-2 text-xs hover:bg-muted/60", selected === item.path && "bg-accent text-accent-foreground", treeFocused && cursor === item.path && "ring-1 ring-ring ring-inset")}>
                    {item.type === "dir" ? <FolderIcon /> : <FileIcon name={item.name} />}
                    <span className={cn("min-w-0 truncate", nameTone(statusOf(item)))}>{item.name}</span>
                    {dir && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>}
                  </div>
                );
              })
          ) : rows.length === 0 ? <PanelEmpty icon={<IconFiles />} title="This workspace is empty" />
          : (() => {
            let nodeIndex = -1;
            return rows.map((row) => {
              const pad = BASE_PAD + row.depth * INDENT;
              if (row.kind === "status") {
                return (
                  <div key={row.key} style={{ paddingLeft: pad + 16 }} className={cn("flex h-6 items-center gap-2 pr-2 text-xs", row.tone === "error" ? "text-destructive" : "text-muted-foreground")}>
                    {row.tone === "loading" ? <span className="h-2.5 w-24 animate-pulse rounded-sm bg-muted" /> : <span className="min-w-0 truncate">{row.text}</span>}
                    {row.retry !== undefined && <Button variant="link" size="xs" type="button" onClick={() => load(row.retry!)} className="h-auto shrink-0 p-0 text-inherit underline">Retry</Button>}
                  </div>
                );
              }
              nodeIndex++;
              const { item, depth } = row;
              const isDir = item.type === "dir";
              const open = isDir && !!expanded[item.path];
              return (
                <div
                  key={item.path}
                  id={`files-row-${nodeIndex}`}
                  data-tree-path={item.path}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={isDir ? open : undefined}
                  aria-selected={selected === item.path}
                  title={splitTreePath(item.path).rel || item.name}
                  onClick={() => activate(item)}
                  style={{ paddingLeft: pad }}
                  className={cn("relative flex h-6 cursor-pointer items-center gap-1 pr-2 text-xs hover:bg-muted/60", selected === item.path && "bg-accent text-accent-foreground", treeFocused && cursor === item.path && "ring-1 ring-ring ring-inset")}
                >
                  {Array.from({ length: depth }, (_, guide) => <span key={guide} aria-hidden className="absolute inset-y-0 border-l border-border/60" style={{ left: BASE_PAD + guide * INDENT + 6 }} />)}
                  {isDir ? <IconChevronRight aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} /> : <span aria-hidden className="size-3 shrink-0" />}
                  {isDir ? <FolderIcon open={open} /> : <FileIcon name={item.name} />}
                  <span className={cn("min-w-0 flex-1 truncate", nameTone(statusOf(item)))}>{item.name}</span>
                  <StatusMark status={statusOf(item)} />
                </div>
              );
            });
          })()}
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {menuItem && (
          <>
            <ContextMenuItem onSelect={() => downloadItem(menuItem)}><IconDownload />{menuItem.type === "dir" ? "Download as zip" : "Download"}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => copyItemPath(menuItem, false)}><IconCopy />Copy path</ContextMenuItem>
            <ContextMenuItem onSelect={() => copyItemPath(menuItem, true)}><IconCopy />Copy relative path</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={refresh}><IconRefresh />Refresh</ContextMenuItem>
            {projectId && canOpenInExplorer(client) && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void openProjectInExplorer(client, projectId)}><IconFolderOpen />Open in Explorer</ContextMenuItem>
                {navigator.userAgent.includes("Windows") && <ContextMenuItem onSelect={() => void openProjectInExplorer(client, projectId, true)}><IconFolderOpen />Map as network drive</ContextMenuItem>}
                {hasOpenMount(projectId) && <ContextMenuItem onSelect={() => void ejectProjectMount(client, projectId)}><IconX />Stop Explorer access</ContextMenuItem>}
              </>
            )}
          </>
        )}
      </ContextMenuContent>
      </ContextMenu>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      {tree}
      {dialogPath && dialogTarget && <FileDialog key={dialogPath} client={client} sessionId={dialogTarget.sessionId} path={splitTreePath(dialogPath).rel} label={multi ? dialogTarget.label : undefined} onClose={() => { setDialogPath(null); window.setTimeout(() => treeRef.current?.focus({ preventScroll: true }), 0); }} />}
    </div>
  );
}
