import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { IconArrowLeft, IconCheck, IconChevronRight, IconCopy, IconFiles, IconFoldersOff, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "cn";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { FileContent, FileEntry, FileListing } from "@/lib/runtime/workspace-files";
import { errorMessage } from "@/lib/runtime/store";
import { FileIcon, FolderIcon } from "./file-icons";
import { useHighlighter } from "@/hooks/use-highlighter";
import { languageForPath } from "@/lib/runtime/language";
import { buildTreeStatus, hasGitChanges, publishGitChanges, STATUS_BADGE_TONE, STATUS_NAME_TONE, useGitChanges } from "./git-status";
import { GROUP_LETTER, type ChangeGroup } from "./diff-parse";
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
const SPLIT_MIN_WIDTH = 560;
const MAX_PREVIEW_LINES = 5000;
const MAX_HIGHLIGHT_BYTES = 300 * 1024;
const MAX_HIGHLIGHT_LINE = 2000;

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(node);
    setWidth(Math.round(node.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <ol aria-label="File path" className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-xs text-muted-foreground" title={path}>
      {parts.map((part, index) => {
        const last = index === parts.length - 1;
        return (
          <li key={index} className={cn("flex items-center", last ? "min-w-0 shrink-0 text-foreground" : "min-w-0 shrink")}>
            {index > 0 && <IconChevronRight aria-hidden className="mx-0.5 size-3 shrink-0 opacity-60" />}
            <span className={cn("truncate", last && "font-medium")}>{part}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Preview({ client, sessionId, path, label, onBack }: { client: RuntimeClient; sessionId: string; path: string; label?: string; onBack?: () => void }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    client.readFile(sessionId, path)
      .then((result) => { if (!cancelled) setFile(result); })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [client, sessionId, path, version]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const lines = useMemo(() => (file && !file.binary && !file.tooLarge ? file.content.replace(/\n$/, "").split("\n") : null), [file]);
  const shown = lines && lines.length > MAX_PREVIEW_LINES ? lines.slice(0, MAX_PREVIEW_LINES) : lines;

  const highlightable = !!shown && !!file && file.size <= MAX_HIGHLIGHT_BYTES && shown.every((line) => line.length <= MAX_HIGHLIGHT_LINE);
  const highlighter = useHighlighter(languageForPath(path), highlightable);
  const colored = useMemo(() => {
    if (!highlighter || !shown) return null;
    try { return highlighter.highlight(shown.join("\n")).lines; } catch { return null; }
  }, [highlighter, shown]);

  async function copyPath() {
    try { await navigator.clipboard.writeText(path); setCopied(true); } catch { /* clipboard may be unavailable */ }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        {onBack && <Button type="button" variant="ghost" size="icon-xs" aria-label="Back to file tree" title="Back to file tree" onClick={onBack}><IconArrowLeft /></Button>}
        <Breadcrumb path={label ? `${label}/${path}` : path} />
        {file && !error && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatSize(file.size)}</span>}
        <Button type="button" variant="ghost" size="icon-xs" aria-label={copied ? "Path copied" : "Copy path"} title="Copy path" onClick={() => void copyPath()}>{copied ? <IconCheck className="text-emerald-600 dark:text-emerald-400" /> : <IconCopy />}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
        {error ? <PanelError message={error} onRetry={() => setVersion((value) => value + 1)} />
          : !file ? <RowSkeletons count={10} rowClass="h-3.5" />
          : file.binary ? <PanelEmpty icon={<IconFiles />} title="Binary file" hint="Text preview is not available." />
          : file.tooLarge ? <PanelEmpty icon={<IconFiles />} title="File too large to preview" hint={`This file is ${formatSize(file.size)}.`} />
          : shown && (
            <div className="flex w-max min-w-full font-mono text-[11px] leading-[18px]">
              <pre aria-hidden className="sticky left-0 shrink-0 select-none border-r border-border bg-background px-2 text-right text-muted-foreground/70 tabular-nums">{shown.map((_, index) => index + 1).join("\n")}</pre>
              <pre aria-label={`Contents of ${file.path}`} className="min-w-0 flex-1 px-3 whitespace-pre">{colored ? colored.map((line, index) => <span key={index}>{line}{"\n"}</span>) : (shown.join("\n") || " ")}{lines && lines.length > shown.length ? `\n\n… ${(lines.length - shown.length).toLocaleString()} more lines not shown` : ""}</pre>
            </div>
          )}
      </div>
    </div>
  );
}

/** Lazy file explorer of every folder / worktree in the active project (one top-level node each) with a read-only text preview. */
export default function FilesTab({ client, targets }: { client: RuntimeClient; targets: WorkspaceTarget[] }) {
  const [dirs, setDirs] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [treeFocused, setTreeFocused] = useState(false);
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const treeRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const generation = useRef(0);
  const split = width >= SPLIT_MIN_WIDTH;
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
    setCursor(null);
    setQuery("");
    setShowPreview(false);
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
    setShowPreview(true);
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

  function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (nodes.length === 0) return;
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
  const selectedTarget = selected ? targets.find((target) => target.id === splitTreePath(selected).id) : undefined;
  const previewVisible = selected !== null && (split || showPreview);
  const treeVisible = split || !previewVisible;
  const treeActiveId = treeFocused && cursorIndex >= 0 ? `files-row-${cursorIndex}` : undefined;

  const tree = (
    <div className={cn("flex min-h-0 flex-col", split ? "w-[42%] min-w-48 shrink-0 border-r border-border" : "flex-1")}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Filter loaded files" placeholder="Filter files" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); if (event.key === "ArrowDown") { event.preventDefault(); treeRef.current?.focus(); } }} className="h-7 pr-6 pl-7 text-xs" />
          {query && <button type="button" aria-label="Clear filter" onClick={() => setQuery("")} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><IconX className="size-3" /></button>}
        </div>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Collapse all folders" title="Collapse all" onClick={() => setExpanded({})}><IconFoldersOff /></Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh files" title="Refresh files" onClick={refresh}><IconRefresh /></Button>
      </div>
      <div
        ref={treeRef}
        role="tree"
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
                  <div key={item.path} id={`files-row-${index}`} role="treeitem" aria-selected={selected === item.path} title={splitTreePath(item.path).rel || item.name} onClick={() => activate(item)} className={cn("flex h-6 min-w-0 cursor-pointer items-center gap-1.5 px-2 text-xs hover:bg-muted/60", selected === item.path && "bg-accent text-accent-foreground", treeFocused && cursor === item.path && "ring-1 ring-ring ring-inset")}>
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
                    {row.retry !== undefined && <button type="button" onClick={() => load(row.retry!)} className="shrink-0 underline underline-offset-2 hover:text-foreground">Retry</button>}
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
    </div>
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0">
      {treeVisible && tree}
      {previewVisible && selected && selectedTarget && <Preview key={selected} client={client} sessionId={selectedTarget.sessionId} path={splitTreePath(selected).rel} label={multi ? selectedTarget.label : undefined} onBack={split ? undefined : () => setShowPreview(false)} />}
      {split && !previewVisible && (
        <div className="flex min-w-0 flex-1 items-center justify-center bg-muted/20">
          <PanelEmpty icon={<IconFiles />} title="Select a file to preview" hint="Use the arrow keys to browse and Enter to open." />
        </div>
      )}
    </div>
  );
}
