import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronRight, IconChevronsDown, IconChevronsUp, IconFolder, IconGitBranch, IconGitCompare, IconRefresh, IconTextWrap } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "cn";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { GitChange, GitChanges, GitFileDiff } from "@/lib/runtime/git-review";
import { errorMessage } from "@/lib/runtime/store";
import { FileDiffBody, useParsedDiff } from "../git-diff";
import { GROUP_LABEL, GROUP_LETTER, GROUP_ORDER, changeGroup, parseDiff, type ChangeGroup } from "./diff-parse";
import { publishGitChanges } from "./git-status";
import { PanelEmpty, PanelError, RowSkeletons } from "./panel-states";

/** One folder / git worktree of the active project, reachable through a session that runs in it. */
export interface WorkspaceTarget { id: string; label: string; branch: string | null; sessionId: string }

type ListEntry = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; summary: GitChanges };
type DiffEntry = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; diff: GitFileDiff };

const LETTER_TONE: Record<ChangeGroup, string> = {
  modified: "text-amber-600 dark:text-amber-400",
  added: "text-emerald-600 dark:text-emerald-400",
  deleted: "text-destructive",
  renamed: "text-sky-600 dark:text-sky-400",
  untracked: "text-muted-foreground",
};
const PREFETCH_LIMIT = 60;
const INITIAL_OPEN = 8;

function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { name: path, dir: "" } : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

function FileCard({ change, entry, open, wrap, onToggle, onRetry }: {
  change: GitChange;
  entry: DiffEntry | undefined;
  open: boolean;
  wrap: boolean;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const group = changeGroup(change);
  const { name, dir } = splitPath(change.path);
  const diff = entry?.state === "ready" ? entry.diff : null;
  const parsed = useParsedDiff(diff);
  return (
    <div className="border-b border-border">
      <button
        type="button"
        aria-expanded={open}
        title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}
        onClick={onToggle}
        className="sticky top-8 z-[1] flex h-7 w-full min-w-0 items-center gap-1.5 bg-background px-2 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <IconChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <span aria-label={GROUP_LABEL[group]} className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", LETTER_TONE[group])}>{GROUP_LETTER[group]}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{name}</span>
          {dir && <span className="ml-1.5 text-muted-foreground">{dir}</span>}
        </span>
        {parsed && (parsed.added > 0 || parsed.removed > 0) && (
          <span className="flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
            {parsed.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{parsed.added}</span>}
            {parsed.removed > 0 && <span className="text-destructive">−{parsed.removed}</span>}
          </span>
        )}
        {!parsed && entry?.state === "loading" && <Spinner className="size-3 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div className="border-t border-border/60 bg-muted/20">
          {!entry || entry.state === "loading" ? <div className="h-16"><RowSkeletons count={2} rowClass="h-3.5" /></div>
            : entry.state === "error" ? <PanelError message={entry.message} onRetry={onRetry} className="py-4" />
            : parsed && <FileDiffBody diff={entry.diff} parsed={parsed} wrap={wrap} />}
        </div>
      )}
    </div>
  );
}

const diffKey = (targetId: string, path: string) => `${targetId}\n${path}`;

function sumDiffs(diffs: Record<string, DiffEntry>, prefix: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const [key, entry] of Object.entries(diffs)) {
    if (!key.startsWith(prefix) || entry.state !== "ready" || entry.diff.binary || entry.diff.tooLarge) continue;
    const parsed = parseDiff(entry.diff.patch);
    added += parsed.added;
    removed += parsed.removed;
  }
  return { added, removed };
}

function Counts({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      <span className="text-destructive">−{removed}</span>
    </span>
  );
}

/** Git changes of every folder / worktree in the active project: a reviewable, per-file collapsible unified diff grouped by folder. */
export default function ChangesTab({ client, targets, onCount }: { client: RuntimeClient; targets: WorkspaceTarget[]; onCount?: (count: number | null) => void }) {
  const [lists, setLists] = useState<Record<string, ListEntry>>({});
  const [version, setVersion] = useState(0);
  const [diffs, setDiffs] = useState<Record<string, DiffEntry>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [folderClosed, setFolderClosed] = useState<Record<string, boolean>>({});
  const [wrap, setWrap] = useState(false);
  const generation = useRef(0);
  const requested = useRef(new Set<string>());
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const signature = targets.map((target) => `${target.id}:${target.sessionId}`).join("|");

  const loadDiff = useCallback(async (targetId: string, path: string, force = false) => {
    const key = diffKey(targetId, path);
    const target = targetsRef.current.find((item) => item.id === targetId);
    if (!target || (!force && requested.current.has(key))) return;
    requested.current.add(key);
    const gen = generation.current;
    setDiffs((current) => ({ ...current, [key]: { state: "loading" } }));
    try {
      const diff = await client.gitDiff(target.sessionId, path);
      if (gen === generation.current) setDiffs((current) => ({ ...current, [key]: { state: "ready", diff } }));
    } catch (cause) {
      if (gen === generation.current) setDiffs((current) => ({ ...current, [key]: { state: "error", message: errorMessage(cause) } }));
    }
  }, [client]);

  /** Fetch one folder's change list (tolerating its failure) and prefetch its first diffs a few at a time. */
  const loadList = useCallback(async (target: WorkspaceTarget, gen: number) => {
    setLists((current) => ({ ...current, [target.id]: { state: "loading" } }));
    try {
      const result = await client.gitChanges(target.sessionId);
      if (gen !== generation.current) return;
      publishGitChanges(target.id, result);
      setLists((current) => ({ ...current, [target.id]: { state: "ready", summary: result } }));
      setOpen((current) => ({ ...current, ...Object.fromEntries(result.changes.map((change, index) => [diffKey(target.id, change.path), index < INITIAL_OPEN])) }));
      const queue = result.changes.slice(0, PREFETCH_LIMIT).map((change) => change.path);
      const worker = async () => { while (queue.length && gen === generation.current) await loadDiff(target.id, queue.shift()!); };
      void Promise.all([worker(), worker(), worker()]);
    } catch (cause) {
      if (gen === generation.current) setLists((current) => ({ ...current, [target.id]: { state: "error", message: errorMessage(cause) } }));
    }
  }, [client, loadDiff]);

  useEffect(() => {
    const gen = ++generation.current;
    requested.current = new Set();
    setDiffs({});
    setOpen({});
    setLists(Object.fromEntries(targetsRef.current.map((target) => [target.id, { state: "loading" } as ListEntry])));
    for (const target of targetsRef.current) void loadList(target, gen);
    return () => { generation.current++; };
  }, [client, signature, version, loadList]);

  const loading = targets.some((target) => !lists[target.id] || lists[target.id].state === "loading");
  const folders = useMemo(() => targets.map((target) => {
    const entry = lists[target.id];
    const summary = entry?.state === "ready" ? entry.summary : null;
    const byGroup = new Map<ChangeGroup, GitChange[]>();
    for (const change of summary?.changes ?? []) {
      const group = changeGroup(change);
      byGroup.set(group, [...(byGroup.get(group) ?? []), change]);
    }
    return { target, entry, summary, groups: GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({ group, items: byGroup.get(group)! })) };
  }), [targets, lists]);

  const totals = useMemo(() => sumDiffs(diffs, ""), [diffs]);
  const readyFolders = folders.filter((folder) => folder.summary);
  const count = readyFolders.reduce((sum, folder) => sum + folder.summary!.changes.length, 0);
  const truncated = readyFolders.some((folder) => folder.summary!.truncated);
  const anyReady = readyFolders.length > 0;
  useEffect(() => { onCount?.(anyReady ? count : null); }, [onCount, anyReady, count]);
  const allKeys = readyFolders.flatMap((folder) => folder.summary!.changes.map((change) => diffKey(folder.target.id, change.path)));
  const allOpen = count > 0 && allKeys.every((key) => open[key]);

  function setAll(value: boolean) {
    setOpen(Object.fromEntries(allKeys.map((key) => [key, value])));
    if (value) for (const folder of readyFolders) for (const change of folder.summary!.changes) void loadDiff(folder.target.id, change.path);
  }
  function toggle(targetId: string, path: string) {
    const key = diffKey(targetId, path);
    const next = !open[key];
    setOpen((current) => ({ ...current, [key]: next }));
    if (next) void loadDiff(targetId, path);
  }

  const singleBranch = targets.length === 1 ? readyFolders[0]?.summary?.branch : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2 text-xs">
            {anyReady ? (
              <>
                <span className="shrink-0 font-medium">{count}{truncated ? "+" : ""} {count === 1 ? "file" : "files"} changed</span>
                <Counts added={totals.added} removed={totals.removed} />
              </>
            ) : <span className="text-muted-foreground">Changes</span>}
          </div>
          <div className="flex h-4 min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            {anyReady && targets.length > 1 && <><IconFolder className="size-3 shrink-0" /><span className="truncate">{targets.length} folders in this project</span></>}
            {anyReady && targets.length === 1 && <><IconGitBranch className="size-3 shrink-0" /><span className="truncate">{singleBranch ?? "Detached HEAD"}</span></>}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Button type="button" variant="ghost" size="icon-xs" aria-label={wrap ? "Disable word wrap" : "Enable word wrap"} aria-pressed={wrap} title="Word wrap" className={cn(wrap && "bg-muted text-foreground")} onClick={() => setWrap((value) => !value)}><IconTextWrap /></Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={allOpen ? "Collapse all files" : "Expand all files"} title={allOpen ? "Collapse all" : "Expand all"} disabled={count === 0} onClick={() => setAll(!allOpen)}>{allOpen ? <IconChevronsUp /> : <IconChevronsDown />}</Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh changes" title="Refresh changes" disabled={loading} onClick={() => setVersion((value) => value + 1)}>{loading ? <Spinner /> : <IconRefresh />}</Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {targets.length === 0 ? <PanelEmpty icon={<IconGitCompare />} title="No folders to review" hint="Start an agent in this project to review its changes." />
          : !anyReady && loading ? <RowSkeletons count={7} rowClass="h-7" />
          : anyReady && count === 0 && folders.every((folder) => folder.entry?.state !== "error") ? <PanelEmpty icon={<IconGitCompare />} title="No uncommitted changes" hint="Edits made by agents in this project will show up here." />
          : folders.map(({ target, entry, summary, groups }) => {
            const closed = !!folderClosed[target.id];
            const folderTotals = sumDiffs(diffs, `${target.id}\n`);
            const branch = summary?.branch ?? target.branch;
            return (
              <section key={target.id} aria-label={target.label} className="border-b border-border">
                <button
                  type="button"
                  aria-expanded={!closed}
                  onClick={() => setFolderClosed((current) => ({ ...current, [target.id]: !closed }))}
                  className="sticky top-0 z-[2] flex h-8 w-full min-w-0 items-center gap-1.5 border-b border-border bg-muted px-2 text-left text-xs hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <IconChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", !closed && "rotate-90")} />
                  <IconFolder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-medium" title={target.label}>{target.label}</span>
                  {branch && <span className="flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground"><IconGitBranch className="size-3 shrink-0" /><span className="truncate">{branch}</span></span>}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {summary && <span className="rounded-full bg-background px-1.5 text-[10px] tabular-nums">{summary.changes.length}{summary.truncated ? "+" : ""}</span>}
                    <Counts added={folderTotals.added} removed={folderTotals.removed} />
                    {(!entry || entry.state === "loading") && <Spinner className="size-3 text-muted-foreground" />}
                  </span>
                </button>
                {!closed && (
                  entry?.state === "error" ? (
                    /not a git repository/i.test(entry.message)
                      ? <p className="px-3 py-2 text-xs text-muted-foreground">Not a Git repository.</p>
                      : <PanelError message={entry.message} onRetry={() => void loadList(target, generation.current)} className="py-4" />
                  ) : !summary ? <div className="h-16"><RowSkeletons count={2} rowClass="h-7" /></div>
                    : summary.changes.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">No uncommitted changes.</p>
                    : (
                      <>
                        {groups.map(({ group, items }) => (
                          <div key={group} role="group" aria-label={GROUP_LABEL[group]}>
                            <h3 className="flex h-6 items-center gap-1.5 border-b border-border bg-muted/40 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                              {GROUP_LABEL[group]}
                              <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums normal-case">{items.length}</span>
                            </h3>
                            {items.map((change) => {
                              const key = diffKey(target.id, change.path);
                              return <FileCard key={key} change={change} entry={diffs[key]} open={!!open[key]} wrap={wrap} onToggle={() => toggle(target.id, change.path)} onRetry={() => void loadDiff(target.id, change.path, true)} />;
                            })}
                          </div>
                        ))}
                        {summary.truncated && <p className="px-3 py-2 text-xs text-muted-foreground">Showing the first 1,000 files.</p>}
                      </>
                    )
                )}
              </section>
            );
          })}
      </div>
    </div>
  );
}
