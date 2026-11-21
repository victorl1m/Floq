import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconBrain, IconDatabaseOff, IconGraph, IconList, IconPlus, IconRefresh, IconSearch } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePerformancePrefs } from "@/lib/prefs";
import { buildGraph } from "@/lib/memory-graph";
import { RuntimeError, type RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import type { Memory, MemoryGraph, MemoryStatus, MemoryType } from "@/lib/runtime/types";
import { MemoryDetail, MemoryForm, type Related } from "./memory/memory-detail";
import { MemoryGraphView } from "./memory/memory-graph-view";
import { MemoryList } from "./memory/memory-list";
import { MEMORY_TYPES, readView, sortMemories, titleOf, TYPE_META, typeColor, writeView } from "./memory/memory-meta";
import "./memory/memory.css";

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

/** ok = connected and ready, busy = loading the embedding model, off = unreachable, unknown = no status endpoint. */
function statusTone(status: MemoryStatus | null): "ok" | "busy" | "off" | "unknown" {
  if (!status) return "unknown";
  if (!status.redis) return "off";
  return status.embeddings !== "off" && !status.ready ? "busy" : "ok";
}
const TONE_COLOR = { ok: "var(--mem-procedure)", busy: "var(--mem-decision)", off: "var(--destructive)", unknown: "var(--muted-foreground)" } as const;

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

  const tone = statusTone(status);
  const pinnedCount = useMemo(() => all.reduce((n, m) => n + (m.pinned && !m.invalidatedAt ? 1 : 0), 0), [all]);
  const filtering = q !== "" || type !== "";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="mem-dialog flex h-[min(90vh,880px)] max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1280px,calc(100vw-3rem))]"
        data-testid="memory-dialog"
        onKeyDownCapture={onKeyDownCapture}
        onEscapeKeyDown={(e) => { if (panel) { e.preventDefault(); setPanel(null); } }}>
        <DialogHeader className="flex-row flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4 pr-14 pb-3">
          <span aria-hidden className="mem-type-tile flex size-9 shrink-0 items-center justify-center rounded-[10px]" style={{ ["--mem-tint" as string]: "var(--mem-decision)", ["--mem-tint-ink" as string]: "var(--mem-decision-ink)" }}><IconBrain size={19} stroke={1.75} /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base leading-6">Memory</DialogTitle>
              <span className="inline-flex h-5 items-center gap-1.5 rounded-full border border-[var(--mem-pane-border)] px-2 text-[11px] text-muted-foreground" title={statusTitle(status)} data-testid="memory-status" data-tone={tone}>
                <span aria-hidden className="size-1.5 rounded-full" style={{ background: TONE_COLOR[tone] }} />{statusLabel(status, mode)}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground" data-testid="memory-summary">{projectName} · {all.length} {all.length === 1 ? "memory" : "memories"}{pinnedCount ? ` · ${pinnedCount} pinned` : ""}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={view} aria-label="View"
              onValueChange={(v) => { if (v === "list" || v === "graph") changeView(v); }}>
              {([["list", "List", IconList], ["graph", "Graph", IconGraph]] as const).map(([v, label, Icon]) => (
                <ToggleGroupItem key={v} value={v} data-testid={`view-${v}`} className="px-3"><Icon aria-hidden />{label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button type="button" size="sm" disabled={disabled || !tooMany && !client} onClick={() => setPanel({ kind: "new" })}><IconPlus aria-hidden />New</Button>
          </div>
          <DialogDescription className="sr-only">What agents in {projectName} remember. Pinned memories are injected into every agent.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          <div className="relative min-w-56 flex-1">
            <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchRef} aria-label="Search memories" placeholder="Search memories" className="h-9 rounded-[10px] pr-10 pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
            <kbd aria-hidden className="mem-kbd pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2">/</kbd>
          </div>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} aria-label="Filter by type" className="flex-wrap"
            value={type} onValueChange={(v) => setType(v as MemoryType | "")}>
            {MEMORY_TYPES.map((t) => (
              <ToggleGroupItem key={t} value={t} data-testid={`chip-${t}`} className="h-9 gap-1.5 rounded-[10px] px-2.5 text-xs" title={TYPE_META[t].hint}>
                <span aria-hidden className="size-2 rounded-full" style={{ background: typeColor(t) }} />{TYPE_META[t].label}
                <span className="mem-count" data-testid={`count-${t}`}>{counts[t] ?? 0}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex h-9 items-center gap-2 px-1">
            <Checkbox id="memory-show-forgotten" checked={showInvalid} onCheckedChange={(c) => setShowInvalid(c === true)} />
            <Label htmlFor="memory-show-forgotten" className="text-xs font-normal whitespace-nowrap text-muted-foreground">Show forgotten</Label>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
          {loading && (
            <LoadingState label="Loading memories…" className="mem-pane min-h-0 flex-1 rounded-xl p-1.5" />
          )}
          {!loading && disabled && (
            <Empty role="status" className="mem-pane flex-1 rounded-xl border-solid">
              <EmptyHeader>
                <EmptyMedia variant="icon"><IconDatabaseOff aria-hidden /></EmptyMedia>
                <EmptyTitle>Memory is disabled</EmptyTitle>
                <EmptyDescription>The runtime cannot reach Redis (FLOQ_REDIS_URL is not set or the server is unreachable). It reconnects automatically.</EmptyDescription>
              </EmptyHeader>
              <Button type="button" size="sm" variant="outline" onClick={refresh}><IconRefresh aria-hidden />Retry</Button>
            </Empty>
          )}
          {!loading && !disabled && error && (
            <div role="alert" className="mb-3 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-2">
              <IconAlertTriangle aria-hidden className="size-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">Memory request failed</p>
                <p className="truncate text-xs text-destructive" title={error}>{error}</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={refresh}><IconRefresh aria-hidden />Retry</Button>
            </div>
          )}

          {!loading && !disabled && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
              <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${hasPanel ? "max-md:h-1/2" : ""}`}>
                {view === "list" ? (
                  shown.length === 0 && !error ? (
                    <Empty data-testid="memory-empty" className="mem-pane flex-1 rounded-xl border-solid">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">{filtering ? <IconSearch aria-hidden /> : <IconBrain aria-hidden />}</EmptyMedia>
                        <EmptyTitle>{filtering ? "No memories match." : "No memories yet."}</EmptyTitle>
                        <EmptyDescription>{filtering ? "Try other words, or clear the type filter." : "Agents save them with floq memory add, or add one here."}</EmptyDescription>
                      </EmptyHeader>
                      {!filtering && client && <Button type="button" size="sm" variant="outline" onClick={() => setPanel({ kind: "new" })}><IconPlus aria-hidden />New memory</Button>}
                    </Empty>
                  ) : (
                    <MemoryList items={shown} activeId={activeId} openId={openId} searching={q !== ""} onOpen={open} onActive={setActiveId} reduceMotion={reduceMotion} />
                  )
                ) : (
                  <MemoryGraphView memories={all} graph={graph.data} loading={graph.loading && !graph.data} source={graph.source} matches={matches} selectedId={openId} onSelect={open} />
                )}
              </div>

              {hasPanel && client && (
                <aside className={`mem-pane-strong flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl md:w-[clamp(320px,34%,420px)] md:flex-none ${reduceMotion ? "" : "mem-anim animate-in fade-in-0 slide-in-from-right-2 duration-200"}`} data-testid="memory-side">
                  {panel.kind === "new" && <MemoryForm client={client} projectId={projectId} onDone={(id) => { if (id) { refresh(); setPanel({ kind: "view", id }); setActiveId(id); } else setPanel(null); }} />}
                  {panel.kind === "edit" && openMemory && <MemoryForm initial={openMemory} client={client} projectId={projectId} onDone={() => { refresh(); setPanel({ kind: "view", id: panel.id }); }} />}
                  {panel.kind === "view" && openMemory && (
                    <MemoryDetail memory={openMemory} client={client} related={related} supersededBy={openMemory.supersededBy ? byId.get(openMemory.supersededBy) ?? null : null}
                      onClose={() => setPanel(null)} onEdit={() => setPanel({ kind: "edit", id: openMemory.id })} onChanged={refresh} onDeleted={() => { setPanel(null); refresh(); }} onOpen={open} />
                  )}
                  {panel.kind !== "new" && !openMemory && <Empty className="m-3 border-0"><EmptyHeader><EmptyTitle>This memory is no longer available.</EmptyTitle></EmptyHeader></Empty>}
                </aside>
              )}
            </div>
          )}
        </div>
        <span className="sr-only" aria-live="polite">{!loading && !disabled ? `${shown.length} memories shown${openMemory ? `, ${titleOf(openMemory)} open` : ""}` : ""}</span>
      </DialogContent>
    </Dialog>
  );
}
