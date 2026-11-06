import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconExternalLink, IconSearch, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { openExternal } from "@/lib/open-external";
import { RuntimeError } from "@/lib/runtime/client";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { ExternalTask, TaskSourceInfo, TaskStatusCategory } from "@/lib/runtime/types";
import { PluginBoundary, usePlugins } from "@/plugins/host";
import { ExternalTaskRow, StatusCategoryBadge, STATUS_CATEGORY_LABEL } from "@/plugins/kit/external-task-row";
import { PluginState } from "@/plugins/kit/plugin-state";
import { cn } from "cn";

type Filter = "all" | TaskStatusCategory;
const FILTERS: Filter[] = ["all", "todo", "doing", "done"];

/** The generic view of a task source (`view:"generic"`): search, status-category filter, compact rows, detail sheet, "Open in <source>". */
export function ExternalTaskList({ source }: { source: TaskSourceInfo }) {
  const { client } = useRuntime();
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<ExternalTask[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "not-configured">("loading");
  const [notConfigured, setNotConfigured] = useState("");
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<ExternalTask | null>(null);
  const request = useRef(0);
  const missing = source.missingSecrets;

  const load = useCallback(async (q: string, next?: string) => {
    if (!client) return;
    const id = ++request.current;
    if (missing.length) { setPhase("not-configured"); return; }
    if (next) setMore(true); else setPhase("loading");
    try {
      const page = await client.taskSourceItems(source.pluginId, source.sourceId, { query: q || undefined, cursor: next });
      if (id !== request.current) return;
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setPhase("ready");
    } catch (reason) {
      if (id !== request.current) return;
      if (reason instanceof RuntimeError && reason.code === "not_configured") { setNotConfigured(reason.message); setPhase("not-configured"); }
      else { setError(errorMessage(reason)); setPhase("error"); }
    } finally { if (id === request.current) setMore(false); }
  }, [client, source.pluginId, source.sourceId, missing.length]);

  useEffect(() => { setItems([]); setCursor(undefined); setSelected(null); void load(applied); }, [load, applied]);
  // Search is debounced and goes to the source: it never touches native boards.
  useEffect(() => { const t = setTimeout(() => setApplied(query.trim()), 300); return () => clearTimeout(t); }, [query]);

  const visible = useMemo(() => (filter === "all" ? items : items.filter((i) => i.statusCategory === filter)), [items, filter]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="external-task-list" data-source={`${source.pluginId}/${source.sourceId}`}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-5">
        <div className="relative min-w-40 flex-1 sm:max-w-sm">
          <IconSearch aria-hidden="true" className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${source.label}…`} aria-label={`Search ${source.label}`} className="h-7 pr-8 pl-8 text-[13px]" />
          {query && <Button variant="ghost" size="icon-xs" aria-label="Clear search" className="absolute top-0.5 right-1" onClick={() => setQuery("")}><IconX /></Button>}
        </div>
        <div role="group" aria-label="Status filter" className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <Button key={f} size="xs" variant={filter === f ? "secondary" : "ghost"} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "All" : STATUS_CATEGORY_LABEL[f]}</Button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        {phase === "loading" ? <PluginState state="loading" label={source.label} />
          : phase === "not-configured" ? <PluginState state="not-configured" title={`Set up ${source.label}`} description={missing.length ? undefined : notConfigured || undefined} missingSecrets={missing} />
          : phase === "error" ? <PluginState state="error" title={`Could not load ${source.label}`} description={error} onRetry={() => void load(applied)} />
          : visible.length === 0 ? <PluginState state="empty" title={applied || filter !== "all" ? "No matching items" : `No items in ${source.label}`} description={applied || filter !== "all" ? "Try a different search or status." : "Items you can access will show up here."} />
          : (
            <div role="list" aria-label={`${source.label} items`} className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/30">
              {visible.map((task) => <div role="listitem" key={task.externalId}><ExternalTaskRow task={task} sourceLabel={source.label} selected={selected?.externalId === task.externalId} onSelect={setSelected} /></div>)}
            </div>
          )}
        {phase === "ready" && cursor && <div className="mt-3 flex justify-center"><Button variant="outline" size="sm" disabled={more} onClick={() => void load(applied, cursor)}>{more ? "Loading…" : "Load more"}</Button></div>}
      </div>
      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className={cn("w-full gap-0 sm:max-w-md")}>
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-6 text-base">{selected.title}</SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{selected.externalId}</span><StatusCategoryBadge category={selected.statusCategory} status={selected.status} /></SheetDescription>
              </SheetHeader>
              <dl className="flex-1 space-y-3 overflow-y-auto px-4 pb-4 text-sm">
                {selected.assignee && <div><dt className="text-xs text-muted-foreground">Assignee</dt><dd>{selected.assignee}</dd></div>}
                {selected.priority && <div><dt className="text-xs text-muted-foreground">Priority</dt><dd>{selected.priority}</dd></div>}
                <div><dt className="text-xs text-muted-foreground">Updated</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></div>
                {selected.fields.map((f) => <div key={f.label}><dt className="text-xs text-muted-foreground">{f.label}</dt><dd className="break-words whitespace-pre-wrap">{f.value}</dd></div>)}
              </dl>
              <div className="border-t p-4"><Button size="sm" onClick={() => void openExternal(selected.url)}><IconExternalLink /> Open in {source.label}</Button></div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The panel for an open source tab: the plugin's own component for `view:"custom"`, otherwise the generic list. */
export function TaskSourcePanel({ source }: { source: TaskSourceInfo }) {
  const { taskSources } = usePlugins();
  const custom = source.view === "custom" ? taskSources.find((s) => s.pluginId === source.pluginId && s.sourceId === source.sourceId)?.Component : null;
  if (custom) {
    const entry = taskSources.find((s) => s.pluginId === source.pluginId && s.sourceId === source.sourceId)!;
    return <PluginBoundary pluginId={source.pluginId}>{(() => { const Custom = custom; return <Custom plugin={entry.plugin} source={entry.decl} />; })()}</PluginBoundary>;
  }
  return <ExternalTaskList source={source} />;
}
