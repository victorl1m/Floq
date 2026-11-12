import { useEffect, useState } from "react";
import { IconArrowRight, IconBan, IconPencil, IconPin, IconPinnedOff, IconRestore, IconTrash, IconWorld, IconX } from "@tabler/icons-react";
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
import { dateParts, eventTime } from "@/lib/memory-dates";
import { MAX_TEXT, MEMORY_TYPES, titleOf, TYPE_META, typeColor, typeInk } from "./memory-meta";

export interface Related { memory: Memory; weight: number; kind: "semantic" | "keyword" | "supersedes" }

const tint = (type: MemoryType) => ({ ["--mem-tint" as string]: typeColor(type), ["--mem-tint-ink" as string]: typeInk(type) }) as React.CSSProperties;

export function TypeBadge({ type }: { type: MemoryType }) {
  const meta = TYPE_META[type] ?? TYPE_META.fact, Icon = meta.icon;
  return (
    <span className="mem-type-pill inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium" style={tint(type)} title={meta.hint}>
      <Icon aria-hidden size={13} stroke={2} />{meta.label}
    </span>
  );
}

/** A date with the relative form visible and the absolute one on hover; "—" when the runtime sent nothing usable. */
export function When({ value, prefix = "" }: { value: unknown; prefix?: string }) {
  const d = dateParts(value);
  return <time dateTime={d.iso} title={d.valid ? `${prefix}${d.absolute}` : "Unknown time"} className="tabular-nums">{d.relative}</time>;
}

const ACTION_LABEL: Record<string, string> = { add: "Added", update: "Edited", invalidate: "Forgotten", pin: "Pinned", unpin: "Unpinned", delete: "Deleted", restore: "Restored" };
const ACTION_DOT: Record<string, string> = { add: "var(--mem-procedure)", invalidate: "var(--destructive)", delete: "var(--destructive)", pin: "var(--mem-decision)" };

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
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="memory-form">
      <div>
        <h3 className="text-[15px] font-semibold">{initial ? "Edit memory" : "New memory"}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{initial ? "Agents see the change on their next search." : "One durable fact, decision or procedure. Every agent in the project can find it."}</p>
      </div>
      <Input aria-label="Title" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Textarea aria-label="Memory text" placeholder="One durable fact, decision or procedure. No secrets." rows={8} className="min-h-40 max-h-72" maxLength={MAX_TEXT} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onValueChange={(v) => setType(v as MemoryType)}>
          <SelectTrigger size="sm" aria-label="Type" className="capitalize"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">{MEMORY_TYPES.map((t) => <SelectItem key={t} value={t}><span aria-hidden className="size-2 rounded-full" style={{ background: typeColor(t) }} />{TYPE_META[t].label}</SelectItem>)}</SelectContent>
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
      <div className="mt-auto flex justify-end gap-2 pt-1">
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

  const maxWeight = Math.max(0.0001, ...related.filter((r) => r.kind !== "supersedes").map((r) => r.weight));
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Memory detail" data-testid="memory-detail" style={tint(m.type)}>
      <header className="flex items-start gap-2 px-4 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <TypeBadge type={m.type} />
            {m.pinned && <Badge variant="secondary" className="h-6 rounded-full"><IconPin aria-hidden />Pinned</Badge>}
            {m.scope === "user" && <Badge variant="outline" className="h-6 rounded-full"><IconWorld aria-hidden />All projects</Badge>}
            {invalid && <Badge variant="destructive" className="h-6 rounded-full">Forgotten</Badge>}
          </div>
          <h3 className={`mt-2.5 text-[17px] leading-snug font-semibold tracking-[-0.01em] break-words ${invalid ? "text-muted-foreground line-through decoration-muted-foreground/50" : ""}`}>{titleOf(m)}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{m.author ?? "you"} · updated <When value={m.updatedAt} prefix="Updated " /></p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close detail" className="-mt-1 -mr-1" onClick={onClose}><IconX aria-hidden /></Button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
        <p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">{m.text}</p>

        <section aria-label="Details">
          <h4 className="mem-eyebrow mb-2">Details</h4>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--mem-pane-border)] bg-[var(--mem-pane-border)] text-xs">
            {([
              ["Created", <When key="c" value={m.createdAt} prefix="Created " />],
              ["Updated", <When key="u" value={m.updatedAt} prefix="Updated " />],
              ["Author", m.author ?? "you"],
              ["Scope", m.scope === "user" ? "All my projects" : "This project"],
            ] as const).map(([k, v]) => (
              <div key={k} className="bg-[var(--mem-pane-strong)] px-3 py-2">
                <dt className="text-[11px] text-muted-foreground">{k}</dt>
                <dd className="mt-0.5 truncate font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          {invalid && <p className="mt-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive">Forgotten <When value={m.invalidatedAt} prefix="Forgotten " />: {m.invalidReason ?? "no reason given"}</p>}
          <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={m.id}>{m.id}</p>
        </section>

        {(supersededBy || related.length > 0) && (
          <section aria-label="Related">
            <h4 className="mem-eyebrow mb-1.5">Related</h4>
            <ul className="-mx-1.5 space-y-0.5 text-[13px]">
              {supersededBy && (
                <li><button type="button" className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--mem-row-hover)]" onClick={() => onOpen(supersededBy.id)}>
                  <IconArrowRight aria-hidden className="size-3.5 shrink-0 text-[var(--mem-decision-ink)]" /><span className="truncate">Superseded by {titleOf(supersededBy)}</span></button></li>
              )}
              {related.map((r) => (
                <li key={r.memory.id}><button type="button" className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--mem-row-hover)]" style={tint(r.memory.type)} onClick={() => onOpen(r.memory.id)}>
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: typeColor(r.memory.type) }} />
                  <span className="min-w-0 flex-1 truncate">{titleOf(r.memory)}</span>
                  {r.kind === "supersedes"
                    ? <span className="text-[11px] text-muted-foreground">replaces</span>
                    : <span className="flex items-center gap-1.5" title={`Similarity ${r.weight.toFixed(2)}`}><span aria-hidden className="mem-meter"><span style={{ width: `${Math.round((r.weight / maxWeight) * 100)}%` }} /></span><span className="w-7 text-right font-mono text-[11px] text-muted-foreground tabular-nums">{r.weight.toFixed(2)}</span></span>}
                </button></li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="History">
          <h4 className="mem-eyebrow mb-2">History</h4>
          <ol className="mem-timeline space-y-2.5 text-xs">
            {events === null && <li aria-label="Loading history"><Skeleton rows={2} className="h-8 w-full" /></li>}
            {events?.length === 0 && <li className="text-muted-foreground">No history recorded.</li>}
            {events?.map((ev, i) => {
              const at = eventTime(ev as MemoryEvent & { at?: unknown });
              return (
                <li key={`${ev.id ?? "e"}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5" style={{ ["--mem-dot" as string]: ACTION_DOT[ev.action] ?? "var(--muted-foreground)" }} data-testid="history-item">
                  <span className="font-medium">{ACTION_LABEL[ev.action] ?? ev.action}</span>
                  <span className="text-muted-foreground">by {ev.actor ?? "unknown"}</span>
                  <span className="ml-auto text-muted-foreground"><When value={at} /></span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      <footer className="space-y-2 border-t border-[var(--mem-pane-border)] px-4 py-3">
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
            : <Button type="button" size="icon-sm" variant="ghost" aria-label="Delete" title="Delete" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}><IconTrash aria-hidden /></Button>}
        </div>
      </footer>
    </section>
  );
}
