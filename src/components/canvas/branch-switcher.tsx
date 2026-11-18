import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconChevronUp, IconCloud, IconGitBranch, IconLoader2, IconSearch } from "@tabler/icons-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/runtime/store";

const SEARCH_THRESHOLD = 6;

interface BranchSwitcherProps {
  /** Branch currently checked out in the project's main checkout. */
  currentBranch: string;
  /** Branches checked out in other worktrees: shown disabled. */
  inWorktree: ReadonlySet<string>;
  /** True while a switch is running: the pill is disabled and shows a spinner. */
  busy: boolean;
  /** `fetch` = update remote branches first (slower); the popover loads without it, then refreshes with it. */
  load: (fetch?: boolean) => Promise<{ currentBranch: string | null; branches: string[]; remoteOnly?: string[]; fetchError?: string }>;
  onSwitch: (branch: string) => void;
  className?: string;
}

/** Compact pill (branch icon + name) that lists the project's local and remote branches and switches the main checkout. */
export default function BranchSwitcher({ currentBranch, inWorktree, busy, load, onSwitch, className }: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; branches: string[]; remoteOnly: ReadonlySet<string>; error: string; fetching: boolean; fetchError: string }>({ status: "idle", branches: [], remoteOnly: new Set(), error: "", fetching: false, fetchError: "" });
  const [query, setQuery] = useState("");
  const loadSeq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Two phases: what is known locally right away, then the same list after fetching from the remote (new remote branches appear).
  const fetchBranches = useCallback(async () => {
    const seq = ++loadSeq.current;
    setState((current) => ({ ...current, status: "loading", error: "", fetching: true, fetchError: "" }));
    const apply = (result: Awaited<ReturnType<typeof load>>, fetching: boolean) => setState({ status: "ready", branches: result.branches, remoteOnly: new Set(result.remoteOnly ?? []), error: "", fetching, fetchError: result.fetchError ?? "" });
    try {
      const local = await load(false);
      if (seq !== loadSeq.current) return;
      apply(local, true);
    } catch (error) {
      if (seq === loadSeq.current) setState((current) => ({ ...current, status: "error", error: errorMessage(error), fetching: false }));
      return;
    }
    try {
      const fetched = await load(true);
      if (seq === loadSeq.current) apply(fetched, false);
    } catch (error) {
      if (seq === loadSeq.current) setState((current) => ({ ...current, fetching: false, fetchError: errorMessage(error) }));
    }
  }, [load]);

  useEffect(() => {
    if (!open) { loadSeq.current++; return; }
    setQuery("");
    void fetchBranches();
    // Fetch only when the popover opens; `load` identity changes every render of the page.
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchable = state.branches.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle ? state.branches.filter((branch) => branch.toLowerCase().includes(needle)) : state.branches;
    // Current branch first, then the rest in server order.
    return [...list.filter((branch) => branch === currentBranch), ...list.filter((branch) => branch !== currentBranch)];
  }, [state.branches, query, currentBranch]);

  const options = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[role=option]:not(:disabled)") ?? []);
  const onListKeyDown = (event: React.KeyboardEvent) => {
    const items = options();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(items.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = index <= 0 ? 0 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const choose = (branch: string) => {
    if (busy || branch === currentBranch || inWorktree.has(branch)) return;
    setOpen(false);
    onSwitch(branch);
  };

  return (
    <Popover open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={busy ? `Switching branch, current branch ${currentBranch}` : `Current branch ${currentBranch}. Switch branch`}
          aria-haspopup="listbox"
          aria-busy={busy}
          title={`Branch: ${currentBranch}`}
          className={cn(
            "canvas-topbar pointer-events-auto m-2! flex h-8 max-w-64 items-center gap-1.5 rounded-2xl border border-border/70 bg-card/95 px-2.5 text-xs font-medium text-foreground shadow-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-wait disabled:opacity-80 motion-reduce:transition-none",
            open && "bg-accent",
            className,
          )}
        >
          {busy ? <IconLoader2 size={14} className="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden /> : <IconGitBranch size={14} className="shrink-0 text-muted-foreground" aria-hidden />}
          <span className="min-w-0 truncate">{currentBranch}</span>
          {!busy && <IconChevronUp size={12} className={cn("shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72 gap-1.5 rounded-2xl border border-border/70 bg-card/95 p-1.5 shadow-sm">
        <div className="flex items-center justify-between px-2 pt-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          <span>Switch branch</span>
          {(state.status === "loading" || state.fetching) && <IconLoader2 size={12} className="animate-spin motion-reduce:animate-none" aria-label={state.fetching ? "Fetching branches from the remote" : "Loading branches"} />}
        </div>
        {searchable && (
          <div className="relative px-1">
            <IconSearch size={13} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); options()[0]?.focus(); } }}
              placeholder="Search branches"
              aria-label="Search branches"
              className="h-8 w-full rounded-lg border border-border/70 bg-background/60 pr-2 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            />
          </div>
        )}
        {state.status === "error" && (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-lg px-2 py-2 text-xs text-muted-foreground">
            <span className="flex items-start gap-1.5"><IconAlertTriangle size={14} className="mt-px shrink-0 text-destructive" aria-hidden /><span className="min-w-0 break-words">{state.error || "Could not load branches"}</span></span>
            <Button type="button" size="sm" variant="outline" onClick={() => void fetchBranches()}>Retry</Button>
          </div>
        )}
        {state.status === "loading" && state.branches.length === 0 && (
          <div className="flex flex-col gap-1 px-1 py-1" aria-hidden>
            {[0, 1, 2].map((row) => <div key={row} className="h-7 animate-pulse rounded-lg bg-muted/60 motion-reduce:animate-none" />)}
          </div>
        )}
        {state.branches.length > 0 && (
          <div ref={listRef} role="listbox" aria-label="Branches" onKeyDown={onListKeyDown} className="flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain">
            {visible.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No branches match "{query}"</p>}
            {visible.map((branch) => {
              const current = branch === currentBranch;
              const held = !current && inWorktree.has(branch);
              const remote = state.remoteOnly.has(branch);
              return (
                <button
                  key={branch}
                  type="button"
                  role="option"
                  aria-selected={current}
                  disabled={held}
                  title={held ? `${branch} is checked out in another worktree` : remote ? `${branch} exists only on the remote: switching creates a local branch that tracks it` : branch}
                  autoFocus={!searchable && current}
                  onClick={() => choose(branch)}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent motion-reduce:transition-none",
                    current && "font-medium",
                  )}
                >
                  <IconCheck size={13} className={cn("shrink-0 text-primary-text", !current && "invisible")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {held && <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">in worktree</span>}
                  {remote && <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground"><IconCloud size={10} aria-hidden />remote</span>}
                </button>
              );
            })}
          </div>
        )}
        {state.status === "ready" && state.branches.length === 0 && !state.fetching && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No branches</p>}
        {state.fetchError && <p role="status" className="px-2 text-[10px] leading-snug text-muted-foreground">{state.fetchError}</p>}
        <p className="px-2 pb-1 text-[10px] leading-snug text-muted-foreground">Switching sleeps running agents and checks the branch out. Each branch keeps its own canvas.</p>
      </PopoverContent>
    </Popover>
  );
}
