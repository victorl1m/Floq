import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconBrain, IconDatabaseOff, IconGraph, IconList, IconPlus, IconRefresh, IconSearch } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePerformancePrefs } from "@/lib/prefs";
import { buildGraph } from "@/lib/memory-graph";
import { RuntimeError, type RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import type { Memory, MemoryGraph, MemoryStatus, MemoryType } from "@/lib/runtime/types";
import { MemoryDetail, MemoryForm, type Related } from "./memory/memory-detail";
import { MemoryGraphView } from "./memory/memory-graph-view";
import { MemoryList } from "./memory/memory-list";
import { MEMORY_TYPES, readView, sortMemories, titleOf, typeColor, writeView } from "./memory/memory-meta";

export { sortMemories };

interface Props {
  projectId: string;
  projectName: string;
  client: RuntimeClient | null;
  onClose: () => void;
}

type Panel = { kind: "view"; id: string } | { kind: "edit"; id: string } | { kind: "new" } | null;

function statusLabel(status: MemoryStatus | null, mode: string): string {
  if (!status) return "Status unknown";
  if (!status.redis) return "Offline";
  const backend = status.backend ?? "redis";
  if (status.embeddings === "off") return `${backend} · full-text`;
  return `${backend} · ${mode === "fulltext" ? "full-text" : "hybrid"} · ${status.embeddings}${status.ready ? "" : " (loading)"}`;
}

function statusTitle(status: MemoryStatus | null): string {
  if (!status) return "Memory status is not available from this runtime.";
  return `backend: ${status.backend ?? "unknown"} (${status.redis ? "connected" : "unavailable"})\nembeddings: ${status.embeddings}${status.model ? ` (${status.model})` : ""}\nready: ${status.ready ? "yes" : "no"}`;
}

/** Per-project agent memory: a searchable list and an interactive similarity graph, with one shared detail pane. */
export default function MemoryDialog({ projectId, projectName, client, onClose }: Props) {
  const [view, setView] = useState<"list" | "graph">(readView);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryType | "">("");
  const [showInvalid, setShowInvalid] = useState(false);
  const [all, setAll] = useState<Memory[]>([]);
  const [hits, setHits] = useState<Memory[] | null>(null);
  const [mode, setMode] = useState("fulltext");
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [graph, setGraph] = useState<{ data: MemoryGraph | null; source: "runtime" | "local"; loading: boolean }>({ data: null, source: "runtime", loading: false });
  const [{ reduceMotion }] = usePerformancePrefs();
  const searchRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const searchSeq = useRef(0);
  const graphSeq = useRef(0);
  const q = query.trim();

  const loadAll = useCallback(async () => {
    if (!client) return;
    const s = ++seq.current;
    try {
      const res = await client.projectMemories(projectId, { includeInvalid: showInvalid });
      if (s !== seq.current) return;
      setAll(res.memories); setMode(res.mode); setError(null); setDisabled(false);
    } catch (err) {
      if (s !== seq.current) return;
      if (err instanceof RuntimeError && err.status === 503) { setDisabled(true); setAll([]); setError(null); }
      else setError(errorMessage(err));
    } finally { if (s === seq.current) setLoading(false); }
  }, [client, projectId, showInvalid]);

  const loadSearch = useCallback(async () => {
    if (!client || !q) { setHits(null); return; }
    const s = ++searchSeq.current;
    try {
      const res = await client.projectMemories(projectId, { q, includeInvalid: showInvalid });
      if (s !== searchSeq.current) return;
      setHits(res.memories); setMode(res.mode);
    } catch (err) { if (s === searchSeq.current) { setHits([]); setError(errorMessage(err)); } }
  }, [client, projectId, q, showInvalid]);

  const loadGraph = useCallback(async (memories: Memory[]) => {
    if (!client) return;
    const s = ++graphSeq.current;
    setGraph((g) => ({ ...g, loading: true }));
    try {
      // Low floor: the slider filters client-side, top-k is already applied per node.
      const data = await client.projectMemoryGraph(projectId, { includeInvalid: showInvalid, k: 3, min: 0.2 });
      if (s !== graphSeq.current) return;
      setGraph({ data, source: "runtime", loading: false });
    } catch {
      if (s !== graphSeq.current) return;
      const local = buildGraph(memories.map((m) => ({ id: m.id, title: m.title, text: m.text, supersededBy: m.supersededBy })), { k: 3, min: 0.2 });
      setGraph({ data: local, source: "local", loading: false });
    }
  }, [client, projectId, showInvalid]);

  useEffect(() => { void loadAll(); }, [loadAll]);
  useEffect(() => { const t = setTimeout(() => void loadSearch(), q ? 250 : 0); return () => clearTimeout(t); }, [loadSearch, q]);
  // The graph needs the memories (for the local fallback); refetch it when the set of ids changes, not on every text edit.
  const idsKey = useMemo(() => all.map((m) => m.id + ":" + m.supersededBy + ":" + m.updatedAt).join("|"), [all]);
  useEffect(() => { if (view === "graph" && !loading && !disabled && !error) void loadGraph(all); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view, idsKey, loadGraph, loading, disabled, error]);

  useEffect(() => {
    let alive = true;
    client?.memoryStatus().then((s) => { if (alive) setStatus(s); }).catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
  }, [client]);

  const changeView = (v: "list" | "graph") => { setView(v); writeView(v); };
  const refresh = useCallback(() => { void loadAll(); void loadSearch(); }, [loadAll, loadSearch]);

  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all]);
  const source = q && hits ? hits : all;
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const m of source) c[m.type] = (c[m.type] ?? 0) + 1; return c; }, [source]);
  const deferredSource = useDeferredValue(source);
  const shown = useMemo(() => sortMemories(type ? deferredSource.filter((m) => m.type === type) : deferredSource, q !== ""), [deferredSource, type, q]);
  const matches = useMemo(() => (q || type ? new Set(shown.map((m) => m.id)) : null), [shown, q, type]);

  const openId = panel && panel.kind !== "new" ? panel.id : null;
  const openMemory = openId ? byId.get(openId) ?? hits?.find((m) => m.id === openId) ?? null : null;
  const open = (id: string) => { setActiveId(id); setPanel({ kind: "view", id }); };

  const related = useMemo<Related[]>(() => {
    if (!openId || !graph.data) return [];
    const out: Related[] = [];
    for (const e of graph.data.edges) {
      if (e.kind === "supersedes") { if (e.target === openId) { const m = byId.get(e.source); if (m) out.push({ memory: m, weight: 1, kind: "supersedes" }); } continue; }
      const other = e.source === openId ? e.target : e.target === openId ? e.source : null;
      const m = other ? byId.get(other) : undefined;
      if (m) out.push({ memory: m, weight: e.weight, kind: e.kind });
    }
    return out.sort((a, b) => b.weight - a.weight).slice(0, 6);
  }, [openId, graph.data, byId]);

  // "/" focuses search anywhere in the dialog (not while typing in a field).
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
  };

  const tooMany = all.length > 0 && !!client;
  const hasPanel = panel !== null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="flex h-[min(88vh,820px)] max-h-[88vh] flex-col gap-3 overflow-hidden sm:max-w-[min(1180px,calc(100vw-3rem))]"
        data-testid="memory-dialog"
        onKeyDownCapture={onKeyDownCapture}
        onEscapeKeyDown={(e) => { if (panel) { e.preventDefault(); setPanel(null); } }}>
        <DialogHeader className="gap-1">
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <DialogTitle>Memory</DialogTitle>
            <Badge variant="secondary" title={statusTitle(status)} data-testid="memory-status">{statusLabel(status, mode)}</Badge>
            <span className="text-xs text-muted-foreground">{projectName} · {all.length} {all.length === 1 ? "memory" : "memories"}</span>
            <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={view} aria-label="View" className="ml-auto"
              onValueChange={(v) => { if (v === "list" || v === "graph") changeView(v); }}>
              {([["list", "List", IconList], ["graph", "Graph", IconGraph]] as const).map(([v, label, Icon]) => (
                <ToggleGroupItem key={v} value={v} data-testid={`view-${v}`}><Icon aria-hidden />{label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <DialogDescription className="sr-only">What agents in {projectName} remember. Pinned memories are injected into every agent.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchRef} aria-label="Search memories" placeholder="Search memories  ( / )" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} aria-label="Filter by type" className="flex-wrap"
            value={type} onValueChange={(v) => setType(v as MemoryType | "")}>
            {MEMORY_TYPES.map((t) => (
              <ToggleGroupItem key={t} value={t} data-testid={`chip-${t}`} className="capitalize">
                <span aria-hidden className="size-2 rounded-full" style={{ background: typeColor(t) }} />{t}
                <span className="tabular-nums opacity-70" data-testid={`count-${t}`}>{counts[t] ?? 0}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex items-center gap-1.5">
            <Checkbox id="memory-show-forgotten" checked={showInvalid} onCheckedChange={(c) => setShowInvalid(c === true)} />
            <Label htmlFor="memory-show-forgotten" className="text-xs font-normal text-muted-foreground">Show forgotten</Label>
          </div>
          <Button type="button" size="sm" disabled={disabled || !tooMany && !client} onClick={() => setPanel({ kind: "new" })}><IconPlus aria-hidden />New</Button>
        </div>

        {loading && (
          <div className="flex min-h-0 flex-1 flex-col gap-1.5" role="status" aria-label="Loading memories">
            {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} rows={3} className="h-[78px] shrink-0 rounded-lg" />)}
          </div>
        )}
        {!loading && disabled && (
          <Empty role="status" className="bg-card">
            <EmptyHeader>
              <EmptyMedia variant="icon"><IconDatabaseOff aria-hidden /></EmptyMedia>
              <EmptyTitle>Memory is disabled</EmptyTitle>
              <EmptyDescription>The runtime cannot reach Redis (FLOQ_REDIS_URL is not set or the server is unreachable). It reconnects automatically.</EmptyDescription>
            </EmptyHeader>
            <Button type="button" size="sm" variant="outline" onClick={refresh}><IconRefresh aria-hidden />Retry</Button>
          </Empty>
        )}
        {!loading && !disabled && error && (
          <Empty role="alert" className="flex-none bg-card py-3">
            <EmptyHeader>
              <EmptyMedia variant="icon"><IconAlertTriangle aria-hidden /></EmptyMedia>
              <EmptyTitle>Memory request failed</EmptyTitle>
              <EmptyDescription className="text-destructive">{error}</EmptyDescription>
            </EmptyHeader>
            <Button type="button" size="sm" variant="outline" onClick={refresh}><IconRefresh aria-hidden />Retry</Button>
          </Empty>
        )}

        {!loading && !disabled && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
            <div className={`flex min-h-0 min-w-0 flex-col gap-2 ${hasPanel ? "md:basis-3/5" : ""} ${hasPanel ? "max-md:h-1/2" : ""} flex-1`}>
              {view === "list" ? (
                shown.length === 0 && !error ? (
                  <Empty data-testid="memory-empty" className="bg-card">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">{q || type ? <IconSearch aria-hidden /> : <IconBrain aria-hidden />}</EmptyMedia>
                      <EmptyTitle>{q || type ? "No memories match." : "No memories yet."}</EmptyTitle>
                      {!(q || type) && <EmptyDescription>Agents save them with floq memory add, or add one here.</EmptyDescription>}
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <MemoryList items={shown} activeId={activeId} openId={openId} searching={q !== ""} onOpen={open} onActive={setActiveId} reduceMotion={reduceMotion} />
                )
              ) : (
                <MemoryGraphView memories={all} graph={graph.data} loading={graph.loading && !graph.data} source={graph.source} matches={matches} selectedId={openId} onSelect={open} />
              )}
            </div>

            {hasPanel && client && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-card md:basis-2/5 md:flex-none md:w-[min(420px,40%)]" data-testid="memory-side">
                {panel.kind === "new" && <MemoryForm client={client} projectId={projectId} onDone={(id) => { if (id) { refresh(); setPanel({ kind: "view", id }); setActiveId(id); } else setPanel(null); }} />}
                {panel.kind === "edit" && openMemory && <MemoryForm initial={openMemory} client={client} projectId={projectId} onDone={() => { refresh(); setPanel({ kind: "view", id: panel.id }); }} />}
                {panel.kind === "view" && openMemory && (
                  <MemoryDetail memory={openMemory} client={client} related={related} supersededBy={openMemory.supersededBy ? byId.get(openMemory.supersededBy) ?? null : null}
                    onClose={() => setPanel(null)} onEdit={() => setPanel({ kind: "edit", id: openMemory.id })} onChanged={refresh} onDeleted={() => { setPanel(null); refresh(); }} onOpen={open} />
                )}
                {panel.kind !== "new" && !openMemory && <Empty className="m-3 border-0 bg-card"><EmptyHeader><EmptyTitle>This memory is no longer available.</EmptyTitle></EmptyHeader></Empty>}
              </div>
            )}
          </div>
        )}
        <span className="sr-only" aria-live="polite">{!loading && !disabled ? `${shown.length} memories shown${openMemory ? `, ${titleOf(openMemory)} open` : ""}` : ""}</span>
      </DialogContent>
    </Dialog>
  );
}
