// Sticky notes on the canvas: a React Flow node type plus the hook that keeps them in sync with the runtime.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, BaseEdge, EdgeLabelRenderer, Handle, NodeResizer, Position, useNodesState, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { IconBrain, IconLink, IconNote, IconPencil, IconShieldLock, IconTrash, IconX } from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import { createNoteRequest, deleteNoteRequest, fetchNotes, linkNote, unlinkNote, updateNoteRequest, type CanvasNote, type NoteColor, type NoteKind, type NotePatch } from "./canvas-data";
import { findFreeSpot, type Rect } from "./note-placement";
import { pathOf, RESIZER_ABOVE, route, SIDE_STRIP_CLASS, SIDE_STRIP_STYLE, useRect } from "./wire-edge";

export type NoteNode = Node<{ note: CanvasNote }, "note">;
// The runtime rejects sizes under 120, so the resizer minimum stays above it.
export const NOTE_MIN = { width: 180, height: 120 };
export const NOTE_MAX = 2000;
export const NOTE_DEFAULT = { width: 240, height: 180 };
export const NOTE_PREFIX = "note:";
export const NOTELINK_PREFIX = "notelink:";
export const NOTE_TEAL = "#14b8a6";
export const isNoteId = (id: string) => id.startsWith(NOTE_PREFIX);
export const isNoteLinkId = (id: string) => id.startsWith(NOTELINK_PREFIX);
export const noteLinkId = (noteId: string, sessionId: string) => `${NOTELINK_PREFIX}${noteId}:${sessionId}`;
export type NoteWireEdge = Edge<{ noteId: string; sessionId: string }, "note-wire">;

export const COLORS: Record<NoteColor, { tint: string; border: string; dot: string; label: string }> = {
  yellow: { tint: "bg-amber-400/20", border: "border-amber-500/40", dot: "bg-amber-400", label: "Yellow" },
  blue: { tint: "bg-sky-400/20", border: "border-sky-500/40", dot: "bg-sky-400", label: "Blue" },
  green: { tint: "bg-emerald-400/20", border: "border-emerald-500/40", dot: "bg-emerald-400", label: "Green" },
  pink: { tint: "bg-pink-400/20", border: "border-pink-500/40", dot: "bg-pink-400", label: "Pink" },
  purple: { tint: "bg-violet-400/20", border: "border-violet-500/40", dot: "bg-violet-400", label: "Purple" },
  gray: { tint: "bg-zinc-400/20", border: "border-zinc-500/40", dot: "bg-zinc-400", label: "Gray" },
};
export const COLOR_KEYS = Object.keys(COLORS) as NoteColor[];

/** What each kind means for agents; the header icon, badge and menu all come from here. */
export const KINDS: Record<NoteKind, { label: string; icon: Icon; hint: string; badge: string | null }> = {
  note: { label: "Note", icon: IconNote, hint: "Only agents you wire to it can read and edit it.", badge: null },
  memory: { label: "Memory", icon: IconBrain, hint: "Project memory: every agent in this project reads it and can edit it.", badge: "text-violet-700 bg-violet-500/15 dark:text-violet-300" },
  system: { label: "System", icon: IconShieldLock, hint: "Project rules: every agent in this project follows them. Agents can read them but only you can edit or delete them.", badge: "text-amber-700 bg-amber-500/15 dark:text-amber-300" },
};
export const KIND_KEYS = Object.keys(KINDS) as NoteKind[];

const toNode = (note: CanvasNote): NoteNode => ({
  id: NOTE_PREFIX + note.id,
  type: "note",
  position: { x: note.x, y: note.y },
  width: note.w,
  height: note.h,
  dragHandle: ".note-drag",
  data: { note },
});

interface NoteCtxValue {
  patch: (id: string, patch: NotePatch) => void;
  remove: (id: string) => void;
  /** Marks a note as being edited/dragged/resized so polling never overwrites it. */
  setEditing: (id: string, editing: boolean) => void;
  /** True once for a freshly created note (so it takes focus). */
  isNew: (id: string) => boolean;
  titleOf: (sessionId: string) => string;
  /** Id of a note being pointed at ("Show on canvas"); its card pulses. */
  highlight: string | null;
}
// Inert default so a card rendered outside (or out of sync with) its provider degrades instead of crashing the canvas.
const NoteCtx = createContext<NoteCtxValue>({ patch: () => {}, remove: () => {}, setEditing: () => {}, isNew: () => false, titleOf: () => "agent", highlight: null });
export const NoteProvider = NoteCtx.Provider;

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

const NoteCard = memo(function NoteCard({ data, selected }: NodeProps<NoteNode>) {
  const ctx = useContext(NoteCtx);
  const note = data.note;
  const connecting = useConnection().inProgress;
  const palette = COLORS[note.color] ?? COLORS.yellow;
  const [text, setText] = useState(note.text);
  const [flash, setFlash] = useState(false);
  // Controlled so we can close it on any outside click: React Flow's pane/node drag handling stops the
  // pointer events Radix relies on for its own outside-click dismissal.
  const [colorOpen, setColorOpen] = useState(false);
  const [kindOpen, setKindOpen] = useState(false);
  const kind = KINDS[note.kind ?? "note"] ?? KINDS.note;
  const KindIcon = kind.icon;
  useEffect(() => {
    if (!colorOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-note-color-picker]")) return;
      setColorOpen(false);
    };
    // Capture phase so nothing in the canvas can swallow the event before we see it.
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [colorOpen]);
  // Deselecting the note (clicking the pane or another node) also closes it.
  useEffect(() => { if (!selected) setColorOpen(false); }, [selected]);
  // Title editing: double-click the note (anywhere but the text), F2, or Enter on the title button.
  const [editingTitle, setEditingTitle] = useState(false);
  const [draft, setDraft] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const titleDone = useRef(false);
  const restoreFocus = useRef(false);
  const startTitleEdit = useCallback(() => {
    titleDone.current = false;
    setDraft(note.title ?? "");
    setEditingTitle(true);
    ctx.setEditing(note.id, true);
  }, [ctx, note.id, note.title]);
  const finishTitleEdit = (save: boolean, refocus: boolean) => {
    if (titleDone.current) return;
    titleDone.current = true;
    restoreFocus.current = refocus;
    const next = draft.trim();
    if (save && next !== (note.title ?? "")) {
      if (!next && note.agentNoteName) toast.error("This note needs a name", { description: "Agents read it with floq note, so type a new name instead of clearing it." });
      else ctx.patch(note.id, { title: next || null });
    }
    setEditingTitle(false);
    ctx.setEditing(note.id, false);
  };
  useEffect(() => {
    if (editingTitle) { titleInput.current?.focus(); titleInput.current?.select(); return; }
    if (restoreFocus.current) { restoreFocus.current = false; titleButton.current?.focus(); }
  }, [editingTitle]);
  useEffect(() => {
    if (!selected || editingTitle) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F2") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      startTitleEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editingTitle, startTitleEdit]);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(note.id);
  idRef.current = note.id;
  const shown = useRef(note.text);

  useEffect(() => {
    if (focused.current || dirty.current !== null) return;
    setText(note.text);
    // An edit that arrived from outside (an agent) gets a brief highlight.
    if (note.text === shown.current) return;
    shown.current = note.text;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [note.text]);
  useEffect(() => { if (ctx.isNew(note.id)) areaRef.current?.focus(); }, [ctx, note.id]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (dirty.current === null) return;
    const value = dirty.current;
    dirty.current = null;
    shown.current = value;
    ctx.patch(idRef.current, { text: value });
  }, [ctx]);
  useEffect(() => () => flush(), [flush]);

  const onChange = (value: string) => {
    setText(value);
    dirty.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };
  const linked = note.linkedSessionIds;

  return (
    <div className="group/note nopan relative size-full" onDoubleClick={(event) => {
      const target = event.target as Element;
      if (editingTitle || target.closest("textarea, input, [data-note-color-picker], button:not([data-note-title])")) return;
      event.stopPropagation();
      startTitleEdit();
    }}>
      <NodeResizer
        isVisible={selected}
        minWidth={NOTE_MIN.width}
        minHeight={NOTE_MIN.height}
        maxWidth={NOTE_MAX}
        maxHeight={NOTE_MAX}
        onResizeStart={() => ctx.setEditing(note.id, true)}
        onResizeEnd={(_, rect) => { ctx.patch(note.id, { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }); ctx.setEditing(note.id, false); }}
        lineStyle={RESIZER_ABOVE}
        handleStyle={RESIZER_ABOVE}
        lineClassName="border-primary/70! after:absolute after:-inset-1 after:content-['']"
        handleClassName="size-3! rounded-sm! border-2! border-primary! bg-background! after:absolute after:-inset-1 after:content-['']"
      />
      {SIDES.map((position) => (
        <Handle key={position} id={position} type="source" position={position} isConnectable isConnectableStart isConnectableEnd
          style={SIDE_STRIP_STYLE[position]}
          className={SIDE_STRIP_CLASS} />
      ))}
      <div className={cn("relative flex size-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow", palette.border, selected && "border-primary/60 shadow-md ring-2 ring-primary/30", (flash || ctx.highlight === note.id) && "ring-2 ring-teal-500 shadow-[0_0_18px_0_var(--color-teal-500)]", "peer-hover/h:border-teal-500 peer-hover/h:ring-2 peer-hover/h:ring-teal-500/50 peer-hover/h:shadow-[0_0_16px_0_var(--color-teal-500)]", connecting && "group-hover/note:border-emerald-500 group-hover/note:ring-2 group-hover/note:ring-emerald-500/50 group-hover/note:shadow-[0_0_16px_0_var(--color-emerald-500)]")}>
        <div aria-hidden className={cn("pointer-events-none absolute inset-0", palette.tint)} />
        <div className={cn("note-drag relative flex h-8 shrink-0 cursor-grab items-center gap-1 border-b px-1.5 active:cursor-grabbing", palette.border)}>
          <Popover open={kindOpen} onOpenChange={setKindOpen}>
            <PopoverTrigger asChild>
              <button type="button" data-note-color-picker className="nodrag nopan flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10" aria-label={`Note kind: ${kind.label}. Change kind`} title={`${kind.label}: ${kind.hint}`}>
                <KindIcon size={14} aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent data-note-color-picker className="flex w-64 flex-col gap-0.5 p-1" side="bottom" align="start">
              {KIND_KEYS.map((key) => {
                const Item = KINDS[key].icon;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setKindOpen(false); if (key !== (note.kind ?? "note")) ctx.patch(note.id, { kind: key }); }}
                    className={cn("flex items-start gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent", key === (note.kind ?? "note") && "bg-accent/60")}
                  >
                    <Item size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span><span className="block font-medium">{KINDS[key].label}</span><span className="block text-muted-foreground">{KINDS[key].hint}</span></span>
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>
          <Popover open={colorOpen} onOpenChange={setColorOpen}>
            <PopoverTrigger asChild>
              <button type="button" data-note-color-picker className="nodrag nopan flex size-6 items-center justify-center rounded hover:bg-foreground/10" aria-label="Note color" title="Color">
                <span className={cn("size-3 rounded-full", palette.dot)} />
              </button>
            </PopoverTrigger>
            <PopoverContent data-note-color-picker className="flex w-auto gap-1.5 p-2" side="bottom" align="start">
              {COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-label={COLORS[key].label}
                  title={COLORS[key].label}
                  onClick={() => ctx.patch(note.id, { color: key })}
                  className={cn("size-5 rounded-full ring-offset-2 ring-offset-popover", COLORS[key].dot, note.color === key && "ring-2 ring-foreground/60")}
                />
              ))}
            </PopoverContent>
          </Popover>
          {editingTitle ? (
            <input
              ref={titleInput}
              value={draft}
              maxLength={80}
              aria-label="Note title"
              placeholder="Add a title"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => finishTitleEdit(true, false)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishTitleEdit(true, true); }
                else if (event.key === "Escape") { event.preventDefault(); finishTitleEdit(false, true); }
              }}
              className="nodrag nopan nowheel h-6 min-w-0 flex-1 rounded border border-primary/50 bg-background/80 px-1.5 text-[12px] font-medium outline-none focus:ring-2 focus:ring-primary/40"
            />
          ) : (
            <button
              ref={titleButton}
              type="button"
              data-note-title
              aria-keyshortcuts="F2"
              aria-label={note.title ? `Note title: ${note.title}. Press Enter to rename` : "Add a title"}
              title={note.title ? (note.agentNoteName ? `Agent note: ${note.title} (double-click to rename)` : "Note title (double-click to rename)") : "Add a title (double-click the note or press F2)"}
              onClick={(event) => { if (event.detail === 0) startTitleEdit(); }}
              className={cn("flex h-6 min-w-0 items-center gap-1 rounded px-1 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/50", !note.title && "text-muted-foreground/70 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/note:opacity-100")}
            >
              <span className="min-w-0 truncate">{note.title || "Add a title"}</span>
              <IconPencil size={11} aria-hidden="true" className="shrink-0 opacity-0 transition-opacity group-hover/note:opacity-60" />
            </button>
          )}
          {kind.badge && (
            <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", kind.badge)} title={kind.hint + (note.author ? ` Created by agent ${note.author}.` : "")}>
              {note.kind === "system" ? "System · agents read-only" : "Memory · all agents"}
            </span>
          )}
          {linked.length > 0 && note.kind !== "system" && note.kind !== "memory" && (
            <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-teal-500/15 px-1.5 py-0.5 text-[10px] text-teal-700 tabular-nums dark:text-teal-300" title={`Agents that can read and edit this note: ${linked.map(ctx.titleOf).join(", ")}`}>
              <IconLink size={11} />{linked.length}
            </span>
          )}
          <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan ml-auto size-6 text-muted-foreground hover:text-destructive" aria-label="Delete note" title="Delete note" onClick={() => ctx.remove(note.id)}>
            <IconTrash size={14} />
          </Button>
        </div>
        <textarea
          ref={areaRef}
          value={text}
          aria-label={note.title ? `Note ${note.title}` : "Note text"}
          placeholder="Write a note… Drag from a side dot to an agent to share it."
          maxLength={20000}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => { focused.current = true; ctx.setEditing(note.id, true); }}
          onBlur={() => { focused.current = false; flush(); ctx.setEditing(note.id, false); }}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") event.currentTarget.blur(); }}
          className="nodrag nopan nowheel relative min-h-0 flex-1 resize-none bg-transparent p-2.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
      </div>
    </div>
  );
});

export const noteNodeTypes = { note: NoteCard };

export const NoteWireCtx = createContext<{ unlink: (noteId: string, sessionId: string) => void } | null>(null);

/** Teal, dotted wire from a note to an agent: the agent can read and edit the note. Unlink button when selected. */
export const NoteWireEdgeView = memo(function NoteWireEdgeView({ id, source, target, data, selected, markerEnd }: EdgeProps<NoteWireEdge>) {
  const ctx = useContext(NoteWireCtx);
  const from = useRect(source);
  const to = useRect(target);
  const geometry = useMemo(() => {
    if (!from || !to) return null;
    const curve = route(from, to, [], 0);
    const mid = {
      x: 0.125 * curve.a.x + 0.375 * curve.c1.x + 0.375 * curve.c2.x + 0.125 * curve.b.x,
      y: 0.125 * curve.a.y + 0.375 * curve.c1.y + 0.375 * curve.c2.y + 0.125 * curve.b.y,
    };
    return { path: pathOf(curve), mid };
  }, [from, to]);
  if (!data || !geometry) return null;
  return (
    <>
      <BaseEdge id={id} path={geometry.path} markerEnd={markerEnd} interactionWidth={28}
        style={{ stroke: NOTE_TEAL, strokeWidth: selected ? 3 : 2, strokeDasharray: "3 5", strokeLinecap: "round", opacity: selected ? 1 : 0.85 }} />
      <EdgeLabelRenderer>
        <div className="nodrag nopan absolute" style={{ transform: `translate(-50%, -50%) translate(${geometry.mid.x}px, ${geometry.mid.y}px)`, pointerEvents: "all" }}>
          <div className={cn("flex items-center gap-1 rounded-full border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm", selected ? "border-teal-500" : "border-border")} title="Note shared with this agent (read and edit)">
            <IconNote size={11} style={{ color: NOTE_TEAL }} />
            {selected && (
              <Button variant="ghost" size="icon-xs" type="button" aria-label="Unlink note" title="Unlink (Del)" className="ml-0.5 size-4 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={(event) => { event.stopPropagation(); ctx?.unlink(data.noteId, data.sessionId); }}>
                <IconX size={11} />
              </Button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
export const noteEdgeTypes = { "note-wire": NoteWireEdgeView };

const sameNote = (a: CanvasNote, b: CanvasNote) => a.updatedAt === b.updatedAt && a.linkedSessionIds.join("\n") === b.linkedSessionIds.join("\n");

/** Notes of one project: polled every 5s, optimistic edits with rollback, never clobbering a note being edited or dragged. */
export interface NotePlacement {
  /** Rects of everything on the canvas (agents, notes, keychains), in flow coordinates. */
  occupied: () => Rect[];
  agentRect: (sessionId: string) => Rect | undefined;
  /** False until the agent nodes are on the canvas, so placement can anchor next to the creating agent. */
  ready: boolean;
  /** Centres the canvas on a note node and is called by the "Show on canvas" toast action. */
  reveal: (nodeId: string) => void;
}

export function useCanvasNotes(client: RuntimeClient | null, projectId: string | null, titleOf: (sessionId: string) => string, placement?: NotePlacement) {
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const known = useRef<Set<string> | null>(null);
  const placing = useRef(new Set<string>());
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const titleOfRef = useRef(titleOf);
  titleOfRef.current = titleOf;
  const [nodes, setNodes, onNodesChange] = useNodesState<NoteNode>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const editing = useRef(new Set<string>());
  const pending = useRef(new Map<string, number>());
  const created = useRef(new Map<string, number>());
  const newId = useRef<string | null>(null);
  /** Ids deleted locally: an in-flight poll that began before the delete must not resurrect them. */
  const deleted = useRef(new Set<string>());

  const setEditing = useCallback((id: string, on: boolean) => { if (on) editing.current.add(id); else editing.current.delete(id); }, []);
  const isBusy = (id: string) => editing.current.has(id) || (pending.current.get(id) ?? 0) > 0;
  const track = <T,>(id: string, promise: Promise<T>) => {
    pending.current.set(id, (pending.current.get(id) ?? 0) + 1);
    return promise.finally(() => {
      const left = (pending.current.get(id) ?? 1) - 1;
      if (left > 0) pending.current.set(id, left); else pending.current.delete(id);
    });
  };

  const revealRef = useRef<(id: string) => void>(() => {});
  const refresh = useCallback(async () => {
    if (!client || !projectId) return;
    let server: CanvasNote[];
    try { server = await fetchNotes(client, projectId); } catch { return; }
    server = server.filter((note) => !deleted.current.has(note.id));
    // Notes agents created since the last poll: tell the user where they are. The first load only records what exists.
    if (known.current) {
      for (const note of server) {
        if (known.current.has(note.id) || created.current.has(note.id)) continue;
        if (!note.agentNoteName) continue;
        const who = note.linkedSessionIds[0] ? titleOfRef.current(note.linkedSessionIds[0]) : "An agent";
        toast(`${who} created note ${note.title}`, { icon: <IconNote className="size-4" aria-hidden="true" />, description: "Show it on the canvas to read or edit it.", action: { label: "Show on canvas", onClick: () => revealRef.current(note.id) } });
      }
    }
    known.current = new Set([...(known.current ?? []), ...server.map((note) => note.id)]);
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.data.note.id, node]));
      const next: NoteNode[] = server.map((note) => {
        const existing = byId.get(note.id);
        if (!existing) return toNode(note);
        if (isBusy(note.id) || sameNote(existing.data.note, note)) return existing;
        return { ...existing, position: { x: note.x, y: note.y }, width: note.w, height: note.h, data: { note } };
      });
      const have = new Set(server.map((note) => note.id));
      for (const node of current) {
        const id = node.data.note.id;
        if (!have.has(id) && Date.now() - (created.current.get(id) ?? 0) < 10_000) next.push(node);
      }
      return next;
    });
  }, [client, projectId, setNodes]);

  useEffect(() => {
    setNodes([]);
    editing.current.clear();
    known.current = null;
    placing.current.clear();
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh, setNodes]);

  const apply = useCallback((id: string, patch: Partial<CanvasNote>) => setNodes((current) => current.map((node) => {
    if (node.data.note.id !== id) return node;
    const note = { ...node.data.note, ...patch };
    return { ...node, position: { x: note.x, y: note.y }, width: note.w, height: note.h, data: { note } };
  })), [setNodes]);

  const patch = useCallback((id: string, change: NotePatch) => {
    if (!client) return;
    const before = nodesRef.current.find((node) => node.data.note.id === id)?.data.note;
    if (!before) return;
    apply(id, change);
    pending.current.set(id, (pending.current.get(id) ?? 0) + 1);
    updateNoteRequest(client, id, change)
      .then((saved) => {
        if (!saved?.updatedAt) return;
        apply(id, { updatedAt: saved.updatedAt, ...("title" in change ? { title: saved.title ?? null, agentNoteName: saved.agentNoteName ?? null } : {}) });
      })
      .catch((error) => {
        const revert: Partial<CanvasNote> = {};
        for (const key of Object.keys(change) as (keyof NotePatch)[]) Object.assign(revert, { [key]: before[key as keyof CanvasNote] });
        apply(id, revert);
        toast.error("Could not save the note", { description: errorMessage(error) });
      })
      .finally(() => {
        const left = (pending.current.get(id) ?? 1) - 1;
        if (left > 0) pending.current.set(id, left); else pending.current.delete(id);
      });
  }, [client, apply]);

  // Notes an agent created (or that predate canvas mirroring) have no spot yet: pick a free one near the creating agent and save it.
  useEffect(() => {
    const info = placementRef.current;
    if (!info?.ready || !client) return;
    const pendingNotes = nodes.filter((node) => node.data.note.placed === false && !placing.current.has(node.data.note.id));
    if (!pendingNotes.length) return;
    const occupied = info.occupied();
    for (const node of pendingNotes) {
      const note = node.data.note;
      placing.current.add(note.id);
      const anchor = note.linkedSessionIds.map((sid) => info.agentRect(sid)).find(Boolean);
      const spot = findFreeSpot({ w: note.w, h: note.h }, occupied, anchor);
      occupied.push({ ...spot, w: note.w, h: note.h });
      patch(note.id, { x: spot.x, y: spot.y });
      apply(note.id, { placed: true });
    }
  }, [nodes, client, patch, apply, placement?.ready]);

  const reveal = useCallback((id: string) => {
    clearTimeout(highlightTimer.current);
    setHighlight(id);
    setNodes((current) => current.map((node) => node.data.note.id === id ? { ...node, selected: true } : { ...node, selected: false }));
    setTimeout(() => placementRef.current?.reveal(NOTE_PREFIX + id), 60);
    highlightTimer.current = setTimeout(() => setHighlight(null), 3000);
  }, [setNodes]);
  revealRef.current = reveal;
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const add = useCallback(async (input: { x: number; y: number; text?: string; color?: NoteColor; kind?: NoteKind; w?: number; h?: number; agentNoteName?: string; title?: string }) => {
    if (!client || !projectId) return;
    try {
      const note = await createNoteRequest(client, projectId, { w: NOTE_DEFAULT.width, h: NOTE_DEFAULT.height, ...input });
      created.current.set(note.id, Date.now());
      newId.current = note.id;
      setNodes((current) => [...current.filter((node) => node.data.note.id !== note.id), { ...toNode(note), selected: true }]);
      return note;
    } catch (error) {
      toast.error("Could not add the note", { description: errorMessage(error) });
      return undefined;
    }
  }, [client, projectId, setNodes]);

  const remove = useCallback((id: string) => {
    if (!client) return;
    const gone = nodesRef.current.find((node) => node.data.note.id === id)?.data.note;
    if (!gone) return; // already removed: guards double-delete
    deleted.current.add(id);
    setNodes((current) => current.filter((node) => node.data.note.id !== id));
    deleteNoteRequest(client, id).then(() => {
      if (gone?.text.trim() || gone?.title) {
        toast(gone.title ? `Note ${gone.title} deleted` : "Note deleted", {
          icon: <IconTrash className="size-4" aria-hidden="true" />,
          description: gone.agentNoteName ? "Agents can no longer read it with floq note." : "Undo puts it back on the canvas.",
          action: {
            label: "Undo",
            onClick: () => void add({ x: gone.x, y: gone.y, w: gone.w, h: gone.h, text: gone.text, color: gone.color, kind: gone.kind, agentNoteName: gone.agentNoteName ?? undefined, title: gone.agentNoteName ? undefined : gone.title ?? undefined }).then((restored) => {
              if (restored && client) for (const sid of gone.linkedSessionIds) void linkNote(client, restored.id, sid).catch(() => {});
            }),
          },
        });
      }
    }).catch((error) => {
      deleted.current.delete(id);
      if (gone) setNodes((current) => [...current.filter((node) => node.data.note.id !== id), toNode(gone)]);
      toast.error("Could not delete the note", { description: errorMessage(error) });
    });
  }, [client, setNodes, add]);

  const link = useCallback((id: string, sessionId: string) => {
    if (!client) return;
    const note = nodesRef.current.find((node) => node.data.note.id === id)?.data.note;
    if (!note) return;
    if (note.linkedSessionIds.includes(sessionId)) { toast.info("Already linked", { description: `This note is linked to ${titleOf(sessionId)}.` }); return; }
    const before = note.linkedSessionIds;
    apply(id, { linkedSessionIds: [...before, sessionId] });
    track(id, linkNote(client, id, sessionId)).then(() => {
      toast.success(`Note linked to ${titleOf(sessionId)}`, { description: "It can read and edit this note with floq sticky." });
    }).catch((error) => {
      apply(id, { linkedSessionIds: before });
      toast.error("Could not link the note", { description: errorMessage(error) });
    });
  }, [client, apply, titleOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlink = useCallback((id: string, sessionId: string) => {
    if (!client) return;
    const note = nodesRef.current.find((node) => node.data.note.id === id)?.data.note;
    if (!note) return;
    const before = note.linkedSessionIds;
    apply(id, { linkedSessionIds: before.filter((item) => item !== sessionId) });
    track(id, unlinkNote(client, id, sessionId)).catch((error) => {
      apply(id, { linkedSessionIds: before });
      toast.error("Could not unlink the note", { description: errorMessage(error) });
    });
  }, [client, apply]); // eslint-disable-line react-hooks/exhaustive-deps

  const unlinkAll = useCallback((id: string) => {
    const note = nodesRef.current.find((node) => node.data.note.id === id)?.data.note;
    for (const sessionId of note?.linkedSessionIds ?? []) unlink(id, sessionId);
  }, [unlink]);

  const ctxValue = useMemo<NoteCtxValue>(() => ({
    patch,
    remove,
    setEditing,
    isNew: (id) => { if (newId.current !== id) return false; newId.current = null; return true; },
    titleOf,
    highlight,
  }), [patch, remove, setEditing, titleOf, highlight]);

  const notes = useMemo(() => nodes.map((node) => node.data.note), [nodes]);

  const dragStart = useCallback((node: Node) => setEditing(node.id.slice(NOTE_PREFIX.length), true), [setEditing]);
  const dragEnd = useCallback((node: Node) => {
    const id = node.id.slice(NOTE_PREFIX.length);
    patch(id, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
    setEditing(id, false);
  }, [patch, setEditing]);

  return { nodes, onNodesChange: onNodesChange as (changes: NodeChange<Node>[]) => void, notes, add, remove, patch, reveal, link, unlink, unlinkAll, ctxValue, dragStart, dragEnd };
}
