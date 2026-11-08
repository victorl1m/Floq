import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconBan, IconHistory, IconPencil, IconPin, IconPinnedOff, IconPlus, IconRestore, IconSearch, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { RuntimeError, type RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import type { Memory, MemoryEvent, MemoryScope, MemoryStatus, MemoryType } from "@/lib/runtime/types";

const TYPES: MemoryType[] = ["fact", "decision", "procedure", "episode"];
const MAX_TEXT = 4000;

interface Props {
  projectId: string;
  projectName: string;
  client: RuntimeClient | null;
  onClose: () => void;
}

interface Draft { id: string | null; title: string; text: string; type: MemoryType; pinned: boolean; scope: MemoryScope }
const emptyDraft = (): Draft => ({ id: null, title: "", text: "", type: "fact", pinned: false, scope: "project" });

/** Invalidated last, pinned first, then newest. Search results keep the server's relevance order. */
export function sortMemories(list: Memory[], searching: boolean): Memory[] {
  const rank = (m: Memory) => (m.invalidatedAt ? 1 : 0);
  return [...list].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (searching) return 0;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function statusLabel(status: MemoryStatus | null, mode: string): string {
  if (!status) return "Status unknown";
  if (!status.redis) return "Redis offline";
  if (status.embeddings === "off") return "Full-text search";
  return `${mode === "fulltext" ? "Full-text" : "Hybrid"} · ${status.embeddings}${status.ready ? "" : " (loading)"}`;
}

function statusTitle(status: MemoryStatus | null): string {
  if (!status) return "Memory status is not available from this runtime.";
  return `redis: ${status.redis ? "connected" : "unavailable"}\nembeddings: ${status.embeddings}${status.model ? ` (${status.model})` : ""}\nready: ${status.ready ? "yes" : "no"}`;
}

/** Per-project agent memory: search, filter, pin, edit, invalidate, delete and history. */
export default function MemoryDialog({ projectId, projectName, client, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MemoryType | "">("");
  const [showInvalid, setShowInvalid] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [mode, setMode] = useState("fulltext");
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; events: MemoryEvent[] | null } | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (!client) return;
    const seq = ++requestSeq.current;
    try {
      const res = await client.projectMemories(projectId, { q: query.trim() || undefined, type: type || undefined, includeInvalid: showInvalid });
      if (seq !== requestSeq.current) return;
      setMemories(res.memories);
      setMode(res.mode);
      setError(null);
      setDisabled(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (err instanceof RuntimeError && err.status === 503) { setDisabled(true); setMemories([]); setError(null); }
      else setError(errorMessage(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [client, projectId, query, type, showInvalid]);

  // Debounce typing; filter changes fire the same effect.
  useEffect(() => {
    const t = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  useEffect(() => {
    let alive = true;
    client?.memoryStatus().then((s) => { if (alive) setStatus(s); }).catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
  }, [client]);

  const shown = useMemo(() => sortMemories(memories, query.trim() !== ""), [memories, query]);

  const run = async (fn: () => Promise<unknown>, okMessage?: string) => {
    try {
      await fn();
      if (okMessage) toast.success(okMessage);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const save = async () => {
    if (!client || !draft || !draft.text.trim()) return;
    setSaving(true);
    try {
      if (draft.id) await client.updateMemory(draft.id, { text: draft.text, title: draft.title, type: draft.type, pinned: draft.pinned });
      else await client.createMemory(projectId, { text: draft.text, title: draft.title || undefined, type: draft.type, pinned: draft.pinned, scope: draft.scope });
      setDraft(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async (id: string) => {
    if (history?.id === id) { setHistory(null); return; }
    setHistory({ id, events: null });
    try {
      const events = await client!.memoryEvents(id);
      setHistory((h) => (h?.id === id ? { id, events } : h));
    } catch (err) {
      toast.error(errorMessage(err));
      setHistory(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-6">
            <DialogTitle>Memory</DialogTitle>
            <Badge variant="secondary" title={statusTitle(status)}>{statusLabel(status, mode)}</Badge>
          </div>
          <DialogDescription>What agents in {projectName} remember. Pinned memories are injected into every agent.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1">
            <IconSearch size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search memories" placeholder="Search memories" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <NativeSelect aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value as MemoryType | "")}>
            <NativeSelectOption value="">All types</NativeSelectOption>
            {TYPES.map((t) => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
          </NativeSelect>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={showInvalid} onChange={(e) => setShowInvalid(e.target.checked)} />
            Show invalidated
          </label>
          <Button type="button" size="sm" disabled={disabled} onClick={() => setDraft(emptyDraft())}><IconPlus size={14} />New</Button>
        </div>

        {draft && (
          <div className="flex flex-col gap-2 rounded-lg border border-border/80 p-3">
            <Input aria-label="Title" placeholder="Title (optional)" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <Textarea aria-label="Memory text" placeholder="One durable fact, decision or procedure. No secrets." rows={4} maxLength={MAX_TEXT} autoFocus value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect aria-label="Type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}>
                {TYPES.map((t) => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
              </NativeSelect>
              {!draft.id && (
                <NativeSelect aria-label="Scope" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as MemoryScope })}>
                  <NativeSelectOption value="project">This project</NativeSelectOption>
                  <NativeSelectOption value="user">All my projects</NativeSelectOption>
                </NativeSelect>
              )}
              <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />Pinned</label>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{draft.text.length}/{MAX_TEXT}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button type="button" size="sm" disabled={saving || !draft.text.trim()} onClick={() => void save()}>{saving ? <Spinner /> : null}{draft.id ? "Save" : "Add"}</Button>
            </div>
          </div>
        )}

        <div className="min-h-32 flex-1 space-y-2 overflow-y-auto pr-1" aria-live="polite">
          {loading && <div className="flex justify-center py-8"><Spinner /></div>}
          {!loading && disabled && (
            <p role="status" className="py-8 text-center text-sm text-muted-foreground">Memory is unavailable: the runtime cannot reach Redis (FLOQ_REDIS_URL). It reconnects automatically.</p>
          )}
          {!loading && !disabled && error && <p role="alert" className="py-6 text-center text-sm text-destructive">{error}</p>}
          {!loading && !disabled && !error && shown.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">{query || type ? "No memories match." : "No memories yet. Agents save them with floq memory add, or add one here."}</p>
          )}
          {shown.map((m) => {
            const invalid = m.invalidatedAt !== null;
            return (
              <article key={m.id} className={`rounded-lg border border-border/80 p-3 ${invalid ? "opacity-60" : ""}`}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {m.pinned && <IconPin size={13} aria-label="Pinned" className="text-primary" />}
                      <Badge variant="outline">{m.type}</Badge>
                      {m.scope === "user" && <Badge variant="outline">all projects</Badge>}
                      {invalid && <Badge variant="destructive">invalidated</Badge>}
                      {m.title && <span className="truncate text-sm font-medium">{m.title}</span>}
                      {typeof m.score === "number" && query && <span className="text-xs text-muted-foreground tabular-nums">{m.score.toFixed(3)}</span>}
                    </div>
                    <p className="mt-1 text-sm break-words whitespace-pre-wrap">{m.text}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{m.author ?? "you"} · {new Date(m.updatedAt).toLocaleString()}{invalid && m.invalidReason ? ` · ${m.invalidReason}` : ""}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={m.pinned ? "Unpin" : "Pin"} title={m.pinned ? "Unpin" : "Pin"} onClick={() => void run(() => client!.updateMemory(m.id, { pinned: !m.pinned }))}>{m.pinned ? <IconPinnedOff size={15} /> : <IconPin size={15} />}</Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit" title="Edit" onClick={() => setDraft({ id: m.id, title: m.title, text: m.text, type: m.type, pinned: m.pinned, scope: m.scope })}><IconPencil size={15} /></Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={invalid ? "Restore" : "Invalidate"} title={invalid ? "Restore" : "Invalidate (kept in history, hidden from agents)"} onClick={() => void run(() => client!.updateMemory(m.id, { invalidated: !invalid }))}>{invalid ? <IconRestore size={15} /> : <IconBan size={15} />}</Button>
                    <Button type="button" variant={history?.id === m.id ? "secondary" : "ghost"} size="icon-sm" aria-label="History" title="History" onClick={() => void openHistory(m.id)}><IconHistory size={15} /></Button>
                    {confirmDelete === m.id ? (
                      <Button type="button" variant="destructive" size="sm" onClick={() => { setConfirmDelete(null); void run(() => client!.deleteMemory(m.id), "Memory deleted"); }}>Delete?</Button>
                    ) : (
                      <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete" title="Delete permanently" onClick={() => setConfirmDelete(m.id)} onBlur={() => setConfirmDelete((c) => (c === m.id ? null : c))}><IconTrash size={15} /></Button>
                    )}
                  </div>
                </div>
                {history?.id === m.id && (
                  <ol className="mt-2 space-y-1 border-t border-border/60 pt-2 text-xs">
                    {history.events === null && <li><Spinner /></li>}
                    {history.events?.length === 0 && <li className="text-muted-foreground">No history.</li>}
                    {history.events?.map((ev) => (
                      <li key={ev.id} className="flex flex-wrap gap-x-2">
                        <span className="text-muted-foreground tabular-nums">{new Date(ev.createdAt).toLocaleString()}</span>
                        <span className="font-medium">{ev.action}</span>
                        <span className="text-muted-foreground">by {ev.actor}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </article>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
