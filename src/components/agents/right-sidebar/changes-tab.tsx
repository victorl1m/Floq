import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChevronRight, IconChevronsDown, IconChevronsUp, IconGitBranch, IconGitCompare, IconRefresh, IconTextWrap } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "cn";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { GitChange, GitChanges, GitFileDiff } from "@/lib/runtime/git-review";
import { errorMessage } from "@/lib/runtime/store";
import { FileDiffBody, useParsedDiff } from "../git-diff";
import { GROUP_LABEL, GROUP_LETTER, GROUP_ORDER, changeGroup, parseDiff, type ChangeGroup } from "./diff-parse";
import { PanelEmpty, PanelError, RowSkeletons } from "./panel-states";

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
        className="sticky top-0 z-[1] flex h-7 w-full min-w-0 items-center gap-1.5 bg-background px-2 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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

/** Git changes of the active session's workspace: a reviewable, per-file collapsible unified diff. */
export default function ChangesTab({ client, sessionId, onCount }: { client: RuntimeClient; sessionId: string; onCount?: (count: number | null) => void }) {
  const [summary, setSummary] = useState<GitChanges | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [diffs, setDiffs] = useState<Record<string, DiffEntry>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [wrap, setWrap] = useState(false);
  const generation = useRef(0);
  const requested = useRef(new Set<string>());

  const loadDiff = useCallback(async (path: string, force = false) => {
    if (!force && requested.current.has(path)) return;
    requested.current.add(path);
    const gen = generation.current;
    setDiffs((current) => ({ ...current, [path]: { state: "loading" } }));
    try {
      const diff = await client.gitDiff(sessionId, path);
      if (gen === generation.current) setDiffs((current) => ({ ...current, [path]: { state: "ready", diff } }));
    } catch (cause) {
      if (gen === generation.current) setDiffs((current) => ({ ...current, [path]: { state: "error", message: errorMessage(cause) } }));
    }
  }, [client, sessionId]);

  useEffect(() => {
    const gen = ++generation.current;
    requested.current = new Set();
    setLoadingList(true);
    setError(null);
    setDiffs({});
    void client.gitChanges(sessionId).then((result) => {
      if (gen !== generation.current) return;
      setSummary(result);
      setOpen(Object.fromEntries(result.changes.map((change, index) => [change.path, index < INITIAL_OPEN])));
      // Prefetch diffs a few at a time so per-file +/- counts fill in without hammering the runtime.
      const queue = result.changes.slice(0, PREFETCH_LIMIT).map((change) => change.path);
      const worker = async () => { while (queue.length && gen === generation.current) await loadDiff(queue.shift()!); };
      void Promise.all([worker(), worker(), worker()]);
    }).catch((cause) => {
      if (gen === generation.current) setError(errorMessage(cause));
    }).finally(() => {
      if (gen === generation.current) setLoadingList(false);
    });
    return () => { generation.current++; };
  }, [client, sessionId, version, loadDiff]);

  // A different workspace must not show the previous one's list while loading.
  useEffect(() => { setSummary(null); }, [sessionId]);

  const groups = useMemo(() => {
    const result = new Map<ChangeGroup, GitChange[]>();
    for (const change of summary?.changes ?? []) {
      const group = changeGroup(change);
      result.set(group, [...(result.get(group) ?? []), change]);
    }
    return GROUP_ORDER.filter((group) => result.has(group)).map((group) => ({ group, items: result.get(group)! }));
  }, [summary]);

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const entry of Object.values(diffs)) {
      if (entry.state !== "ready" || entry.diff.binary || entry.diff.tooLarge) continue;
      const parsed = parseDiff(entry.diff.patch);
      added += parsed.added;
      removed += parsed.removed;
    }
    return { added, removed };
  }, [diffs]);

  const count = summary?.changes.length ?? 0;
  useEffect(() => { onCount?.(summary ? count : null); }, [onCount, summary, count]);
  const allOpen = count > 0 && summary!.changes.every((change) => open[change.path]);

  function setAll(value: boolean) {
    if (!summary) return;
    setOpen(Object.fromEntries(summary.changes.map((change) => [change.path, value])));
    if (value) for (const change of summary.changes) void loadDiff(change.path);
  }
  function toggle(path: string) {
    const next = !open[path];
    setOpen((current) => ({ ...current, [path]: next }));
    if (next) void loadDiff(path);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2 text-xs">
            {summary ? (
              <>
                <span className="shrink-0 font-medium">{count}{summary.truncated ? "+" : ""} {count === 1 ? "file" : "files"} changed</span>
                {(totals.added > 0 || totals.removed > 0) && (
                  <span className="flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
                    <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>
                    <span className="text-destructive">−{totals.removed}</span>
                  </span>
                )}
              </>
            ) : <span className="text-muted-foreground">Changes</span>}
          </div>
          <div className="flex h-4 min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            {summary && <><IconGitBranch className="size-3 shrink-0" /><span className="truncate">{summary.branch ?? "Detached HEAD"}</span></>}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Button type="button" variant="ghost" size="icon-xs" aria-label={wrap ? "Disable word wrap" : "Enable word wrap"} aria-pressed={wrap} title="Word wrap" className={cn(wrap && "bg-muted text-foreground")} onClick={() => setWrap((value) => !value)}><IconTextWrap /></Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={allOpen ? "Collapse all files" : "Expand all files"} title={allOpen ? "Collapse all" : "Expand all"} disabled={count === 0} onClick={() => setAll(!allOpen)}>{allOpen ? <IconChevronsUp /> : <IconChevronsDown />}</Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh changes" title="Refresh changes" disabled={loadingList} onClick={() => setVersion((value) => value + 1)}>{loadingList ? <Spinner /> : <IconRefresh />}</Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <PanelError message={error} onRetry={() => setVersion((value) => value + 1)} />
          : !summary ? <RowSkeletons count={7} rowClass="h-7" />
          : count === 0 ? <PanelEmpty icon={<IconGitCompare />} title="No uncommitted changes" hint="Edits made by the agent in this workspace will show up here." />
          : (
            <>
              {groups.map(({ group, items }) => (
                <section key={group} aria-label={GROUP_LABEL[group]}>
                  <h3 className="flex h-6 items-center gap-1.5 border-b border-border bg-muted/40 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {GROUP_LABEL[group]}
                    <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums normal-case">{items.length}</span>
                  </h3>
                  {items.map((change) => (
                    <FileCard key={change.path} change={change} entry={diffs[change.path]} open={!!open[change.path]} wrap={wrap} onToggle={() => toggle(change.path)} onRetry={() => void loadDiff(change.path, true)} />
                  ))}
                </section>
              ))}
              {summary.truncated && <p className="px-3 py-2 text-xs text-muted-foreground">Showing the first 1,000 files.</p>}
            </>
          )}
      </div>
    </div>
  );
}
