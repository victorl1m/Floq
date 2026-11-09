import { useEffect, useState } from "react";
import { IconArrowRight, IconBan, IconPencil, IconPin, IconPinnedOff, IconRestore, IconTrash, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import type { Memory, MemoryEvent, MemoryScope, MemoryType } from "@/lib/runtime/types";
import { MAX_TEXT, MEMORY_TYPES, relativeTime, titleOf, typeColor } from "./memory-meta";

export interface Related { memory: Memory; weight: number; kind: "semantic" | "keyword" | "supersedes" }

export function TypeBadge({ type }: { type: MemoryType }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium capitalize" style={{ color: typeColor(type) }}>
      <span aria-hidden className="size-2 rounded-full" style={{ background: typeColor(type) }} />{type}
    </span>
  );
}

interface FormProps {
  initial?: Memory;
  client: RuntimeClient;
  projectId: string;
  onDone: (id: string | null) => void;
}

/** Create (no `initial`) or edit a memory. */
export function MemoryForm({ initial, client, projectId, onDone }: FormProps) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const [type, setType] = useState<MemoryType>(initial?.type ?? "fact");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [scope, setScope] = useState<MemoryScope>("project");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      if (initial) { await client.updateMemory(initial.id, { text, title, type, pinned }); onDone(initial.id); }
      else { const r = await client.createMemory(projectId, { text, title: title || undefined, type, pinned, scope }); onDone(r.id); }
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };
  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4" data-testid="memory-form">
      <h3 className="text-sm font-semibold">{initial ? "Edit memory" : "New memory"}</h3>
      <Input aria-label="Title" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Textarea aria-label="Memory text" placeholder="One durable fact, decision or procedure. No secrets." rows={8} className="min-h-40 max-h-72" maxLength={MAX_TEXT} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onValueChange={(v) => setType(v as MemoryType)}>
          <SelectTrigger size="sm" aria-label="Type" className="capitalize"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">{MEMORY_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
        </Select>
        {!initial && (
          <Select value={scope} onValueChange={(v) => setScope(v as MemoryScope)}>
            <SelectTrigger size="sm" aria-label="Scope"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="project">This project</SelectItem>
              <SelectItem value="user">All my projects</SelectItem>
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center gap-1.5">
          <Checkbox id="memory-form-pinned" checked={pinned} onCheckedChange={(c) => setPinned(c === true)} />
          <Label htmlFor="memory-form-pinned" className="text-xs font-normal">Pinned</Label>
        </div>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{text.length}/{MAX_TEXT}</span>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone(null)}>Cancel</Button>
        <Button type="button" size="sm" disabled={saving || !text.trim()} onClick={() => void save()}>{saving ? <Spinner /> : null}{initial ? "Save" : "Add"}</Button>
      </div>
    </div>
  );
}

interface DetailProps {
  memory: Memory;
  client: RuntimeClient;
  related: Related[];
  supersededBy: Memory | null;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onOpen: (id: string) => void;
}

/** Full text, metadata, relations, history and actions of one memory. */
export function MemoryDetail({ memory: m, client, related, supersededBy, onClose, onEdit, onChanged, onDeleted, onOpen }: DetailProps) {
  const [events, setEvents] = useState<MemoryEvent[] | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalid = m.invalidatedAt !== null;

  useEffect(() => {
    let alive = true;
    setEvents(null); setForgetting(false); setConfirmDelete(false); setReason("");
    client.memoryEvents(m.id).then((e) => { if (alive) setEvents(e); }).catch(() => { if (alive) setEvents([]); });
    return () => { alive = false; };
  }, [client, m.id, m.updatedAt]);

  const run = async (fn: () => Promise<unknown>, ok?: string, after: () => void = onChanged) => {
    try { await fn(); if (ok) toast.success(ok); after(); } catch (err) { toast.error(errorMessage(err)); }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Memory detail" data-testid="memory-detail">
      <div className="flex items-start gap-2 border-b border-border/70 p-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={m.type} />
            {m.pinned && <Badge variant="secondary"><IconPin aria-hidden />pinned</Badge>}
            {m.scope === "user" && <Badge variant="outline">all projects</Badge>}
            {invalid && <Badge variant="destructive">forgotten</Badge>}
          </div>
          <h3 className="mt-1 text-base leading-snug font-semibold break-words">{titleOf(m)}</h3>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close detail" onClick={onClose}><IconX aria-hidden /></Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <p className="text-sm break-words whitespace-pre-wrap">{m.text}</p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Author</dt><dd>{m.author ?? "you"}</dd>
          <dt className="text-muted-foreground">Created</dt><dd>{new Date(m.createdAt).toLocaleString()}</dd>
          <dt className="text-muted-foreground">Updated</dt><dd>{new Date(m.updatedAt).toLocaleString()} <span className="text-muted-foreground">({relativeTime(m.updatedAt)})</span></dd>
          {invalid && <><dt className="text-muted-foreground">Forgotten</dt><dd>{m.invalidReason ?? "no reason given"}</dd></>}
          <dt className="text-muted-foreground">Id</dt><dd className="font-mono break-all text-muted-foreground">{m.id}</dd>
        </dl>

        {(supersededBy || related.length > 0) && (
          <div>
            <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Related</h4>
            <ul className="space-y-0.5 text-sm">
              {supersededBy && (
                <li><button type="button" className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent" onClick={() => onOpen(supersededBy.id)}>
                  <IconArrowRight aria-hidden className="size-3.5 shrink-0" /><span className="truncate">Superseded by {titleOf(supersededBy)}</span></button></li>
              )}
              {related.map((r) => (
                <li key={r.memory.id}><button type="button" className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent" onClick={() => onOpen(r.memory.id)}>
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: typeColor(r.memory.type) }} />
                  <span className="min-w-0 flex-1 truncate">{titleOf(r.memory)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{r.kind === "supersedes" ? "replaces" : r.weight.toFixed(2)}</span></button></li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">History</h4>
          <ol className="space-y-1 text-xs">
            {events === null && <li aria-label="Loading history"><Skeleton rows={2} className="h-8 w-full" /></li>}
            {events?.length === 0 && <li className="text-muted-foreground">No history.</li>}
            {events?.map((ev) => (
              <li key={ev.id} className="flex flex-wrap gap-x-2">
                <span className="text-muted-foreground tabular-nums">{new Date(ev.createdAt).toLocaleString()}</span>
                <span className="font-medium">{ev.action}</span>
                <span className="text-muted-foreground">by {ev.actor}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="space-y-2 border-t border-border/70 p-3">
        {forgetting && (
          <div className="flex items-center gap-2">
            <Input aria-label="Reason" placeholder="Why is this no longer true? (optional)" autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void run(() => client.updateMemory(m.id, { invalidated: true, reason: reason.trim() || undefined }), "Memory forgotten"); } }} />
            <Button type="button" size="sm" variant="destructive" onClick={() => void run(() => client.updateMemory(m.id, { invalidated: true, reason: reason.trim() || undefined }), "Memory forgotten")}>Forget</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setForgetting(false)}>Cancel</Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={onEdit}><IconPencil aria-hidden />Edit</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void run(() => client.updateMemory(m.id, { pinned: !m.pinned }))}>{m.pinned ? <IconPinnedOff aria-hidden /> : <IconPin aria-hidden />}{m.pinned ? "Unpin" : "Pin"}</Button>
          {invalid
            ? <Button type="button" size="sm" variant="outline" onClick={() => void run(() => client.updateMemory(m.id, { invalidated: false }), "Memory restored")}><IconRestore aria-hidden />Restore</Button>
            : <Button type="button" size="sm" variant="outline" onClick={() => setForgetting((v) => !v)}><IconBan aria-hidden />Forget</Button>}
          <span className="flex-1" />
          {confirmDelete
            ? <Button type="button" size="sm" variant="destructive" onClick={() => void run(() => client.deleteMemory(m.id), "Memory deleted", onDeleted)} onBlur={() => setConfirmDelete(false)} autoFocus>Delete permanently?</Button>
            : <Button type="button" size="sm" variant="ghost" aria-label="Delete" onClick={() => setConfirmDelete(true)}><IconTrash aria-hidden />Delete</Button>}
        </div>
      </div>
    </section>
  );
}
