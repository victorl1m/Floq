// Sticky notes on the canvas: a React Flow node type plus the hook that keeps them in sync with the runtime.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NodeResizer, useNodesState, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { IconPin, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RuntimeClient } from "@/lib/runtime/client";
import { errorMessage } from "@/lib/runtime/store";
import { createNoteRequest, deleteNoteRequest, fetchNotes, updateNoteRequest, type CanvasNote, type NoteColor, type NotePatch } from "./canvas-data";

export type NoteNode = Node<{ note: CanvasNote }, "note">;
export const NOTE_MIN = { width: 160, height: 100 };
export const NOTE_DEFAULT = { width: 220, height: 160 };
export const NOTE_PREFIX = "note:";
export const isNoteId = (id: string) => id.startsWith(NOTE_PREFIX);

export const COLORS: Record<NoteColor, { tint: string; border: string; dot: string; label: string }> = {
  yellow: { tint: "bg-amber-400/20", border: "border-amber-500/40", dot: "bg-amber-400", label: "Yellow" },
  blue: { tint: "bg-sky-400/20", border: "border-sky-500/40", dot: "bg-sky-400", label: "Blue" },
  green: { tint: "bg-emerald-400/20", border: "border-emerald-500/40", dot: "bg-emerald-400", label: "Green" },
  pink: { tint: "bg-pink-400/20", border: "border-pink-500/40", dot: "bg-pink-400", label: "Pink" },
  purple: { tint: "bg-violet-400/20", border: "border-violet-500/40", dot: "bg-violet-400", label: "Purple" },
  gray: { tint: "bg-zinc-400/20", border: "border-zinc-500/40", dot: "bg-zinc-400", label: "Gray" },
};
export const COLOR_KEYS = Object.keys(COLORS) as NoteColor[];

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
}
const NoteCtx = createContext<NoteCtxValue | null>(null);
export const NoteProvider = NoteCtx.Provider;

const NoteCard = memo(function NoteCard({ data, selected }: NodeProps<NoteNode>) {
  const ctx = useContext(NoteCtx)!;
  const note = data.note;
  const palette = COLORS[note.color] ?? COLORS.yellow;
  const [text, setText] = useState(note.text);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef(note.id);
  idRef.current = note.id;

  useEffect(() => { if (!focused.current && dirty.current === null) setText(note.text); }, [note.text]);
  useEffect(() => { if (ctx.isNew(note.id)) areaRef.current?.focus(); }, [ctx, note.id]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (dirty.current === null) return;
    const value = dirty.current;
    dirty.current = null;
    ctx.patch(idRef.current, { text: value });
  }, [ctx]);
  useEffect(() => () => flush(), [flush]);

  const onChange = (value: string) => {
    setText(value);
    dirty.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };

  return (
    <div className={cn("relative flex size-full flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm", palette.border, selected && "ring-2 ring-primary/40")}>
      <NodeResizer
        isVisible={selected}
        minWidth={NOTE_MIN.width}
        minHeight={NOTE_MIN.height}
        onResizeStart={() => ctx.setEditing(note.id, true)}
        onResizeEnd={(_, rect) => { ctx.patch(note.id, { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }); ctx.setEditing(note.id, false); }}
        lineClassName="border-primary!"
        handleClassName="size-2.5! rounded-sm! border-primary! bg-background!"
      />
      <div aria-hidden className={cn("pointer-events-none absolute inset-0", palette.tint)} />
      <div className={cn("note-drag relative flex h-7 shrink-0 cursor-grab items-center gap-1 border-b px-1.5 active:cursor-grabbing", palette.border)}>
        <IconPin size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="nodrag nopan flex size-5 items-center justify-center rounded hover:bg-foreground/10" aria-label="Note color" title="Color">
              <span className={cn("size-3 rounded-full", palette.dot)} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="flex w-auto gap-1.5 p-2" side="bottom" align="start">
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
        <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan ml-auto size-5" aria-label="Delete note" title="Delete note" onClick={() => ctx.remove(note.id)}>
          <IconTrash size={13} />
        </Button>
      </div>
      <textarea
        ref={areaRef}
        value={text}
        placeholder="Write a note…"
        maxLength={20000}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => { focused.current = true; ctx.setEditing(note.id, true); }}
        onBlur={() => { focused.current = false; flush(); ctx.setEditing(note.id, false); }}
        onKeyDown={(event) => event.stopPropagation()}
        className="nodrag nopan nowheel relative min-h-0 flex-1 resize-none bg-transparent p-2 text-[13px] leading-snug outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
});

export const noteNodeTypes = { note: NoteCard };

/** Notes of one project: polled every 5s, optimistic edits with rollback, never clobbering a note being edited or dragged. */
export function useCanvasNotes(client: RuntimeClient | null, projectId: string | null) {
  const [nodes, setNodes, onNodesChange] = useNodesState<NoteNode>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const editing = useRef(new Set<string>());
  const pending = useRef(new Map<string, number>());
  const created = useRef(new Map<string, number>());
  const newId = useRef<string | null>(null);

  const setEditing = useCallback((id: string, on: boolean) => { if (on) editing.current.add(id); else editing.current.delete(id); }, []);
  const isBusy = (id: string) => editing.current.has(id) || (pending.current.get(id) ?? 0) > 0;

  const refresh = useCallback(async () => {
    if (!client || !projectId) return;
    let server: CanvasNote[];
    try { server = await fetchNotes(client, projectId); } catch { return; }
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.data.note.id, node]));
      const next: NoteNode[] = server.map((note) => {
        const existing = byId.get(note.id);
        if (!existing) return toNode(note);
        if (isBusy(note.id) || existing.data.note.updatedAt === note.updatedAt) return existing;
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
      .then((saved) => { if (saved?.updatedAt) apply(id, { updatedAt: saved.updatedAt }); })
      .catch((error) => {
        const revert: Partial<CanvasNote> = {};
        for (const key of Object.keys(change) as (keyof NotePatch)[]) Object.assign(revert, { [key]: before[key] });
        apply(id, revert);
        toast.error("Could not save the note", { description: errorMessage(error) });
      })
      .finally(() => {
        const left = (pending.current.get(id) ?? 1) - 1;
        if (left > 0) pending.current.set(id, left); else pending.current.delete(id);
      });
  }, [client, apply]);

  const add = useCallback(async (input: { x: number; y: number; text?: string; color?: NoteColor; w?: number; h?: number }) => {
    if (!client || !projectId) return;
    try {
      const note = await createNoteRequest(client, projectId, { w: NOTE_DEFAULT.width, h: NOTE_DEFAULT.height, ...input });
      created.current.set(note.id, Date.now());
      newId.current = note.id;
      setNodes((current) => [...current.filter((node) => node.data.note.id !== note.id), { ...toNode(note), selected: true }]);
    } catch (error) {
      toast.error("Could not add the note", { description: errorMessage(error) });
    }
  }, [client, projectId, setNodes]);

  const remove = useCallback((id: string) => {
    if (!client) return;
    const gone = nodesRef.current.find((node) => node.data.note.id === id)?.data.note;
    setNodes((current) => current.filter((node) => node.data.note.id !== id));
    deleteNoteRequest(client, id).then(() => {
      if (gone?.text.trim()) toast("Note deleted", { action: { label: "Undo", onClick: () => void add({ x: gone.x, y: gone.y, w: gone.w, h: gone.h, text: gone.text, color: gone.color }) } });
    }).catch((error) => {
      if (gone) setNodes((current) => [...current, toNode(gone)]);
      toast.error("Could not delete the note", { description: errorMessage(error) });
    });
  }, [client, setNodes, add]);

  const ctxValue = useMemo<NoteCtxValue>(() => ({
    patch,
    remove,
    setEditing,
    isNew: (id) => { if (newId.current !== id) return false; newId.current = null; return true; },
  }), [patch, remove, setEditing]);

  const dragStart = useCallback((node: Node) => setEditing(node.id.slice(NOTE_PREFIX.length), true), [setEditing]);
  const dragEnd = useCallback((node: Node) => {
    const id = node.id.slice(NOTE_PREFIX.length);
    patch(id, { x: Math.round(node.position.x), y: Math.round(node.position.y) });
    setEditing(id, false);
  }, [patch, setEditing]);

  return { nodes, onNodesChange: onNodesChange as (changes: NodeChange<Node>[]) => void, add, remove, ctxValue, dragStart, dragEnd };
}
