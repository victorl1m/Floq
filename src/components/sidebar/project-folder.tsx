import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type Announcements, type CollisionDetection, type DragMoveEvent, type DragEndEvent, type DragStartEvent, type KeyboardCoordinateGetter, type UniqueIdentifier } from "@dnd-kit/core";
import { IconGripVertical } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { applyDrop, layoutEvent, layoutsEqual, parseLayout, readLayoutRaw, type DragKey, type DropEdge, type DropTarget, type ProjectLayout } from "@/lib/project-folders";

/** Subscribe to the persisted layout (raw string so the snapshot is referentially stable). */
export function useProjectLayoutRaw(scope: string): string | null {
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener(layoutEvent(), callback);
    window.addEventListener("storage", callback);
    return () => { window.removeEventListener(layoutEvent(), callback); window.removeEventListener("storage", callback); };
  }, []);
  return useSyncExternalStore(subscribe, useCallback(() => readLayoutRaw(scope), [scope]), () => null);
}
export function useSavedLayout(scope: string): ProjectLayout | null {
  const raw = useProjectLayoutRaw(scope);
  return useMemo(() => parseLayout(raw), [raw]);
}

/* ---------- ids ---------- */
export const dndId = (kind: "project" | "folder", id: string) => `${kind}:${id}`;
const EMPTY_PREFIX = "empty:";
const ROOT_END = "root-end";
function parseId(id: UniqueIdentifier): { type: "project" | "folder" | "empty-folder" | "root-end"; id: string } {
  const text = String(id);
  if (text === ROOT_END) return { type: "root-end", id: "" };
  if (text.startsWith(EMPTY_PREFIX)) return { type: "empty-folder", id: text.slice(EMPTY_PREFIX.length) };
  if (text.startsWith("folder:")) return { type: "folder", id: text.slice(7) };
  return { type: "project", id: text.slice(8) };
}

interface Hint { overId: string; edge: DropEdge | "empty" | "end" }
interface DndUi { hint: Hint | null; activeId: string | null }
const UiContext = createContext<DndUi>({ hint: null, activeId: null });

/* ---------- collision + keyboard ---------- */
const centerCollision: CollisionDetection = ({ collisionRect, pointerCoordinates, droppableRects, droppableContainers }) => {
  // Pointer drags use the real pointer (the DragOverlay's measured rect is offset); keyboard drags use the moved rect.
  const cx = pointerCoordinates ? pointerCoordinates.x : collisionRect.left + collisionRect.width / 2;
  const cy = pointerCoordinates ? pointerCoordinates.y : collisionRect.top + collisionRect.height / 2;
  let best: { id: UniqueIdentifier; distance: number } | null = null;
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const inside = cy >= rect.top && cy <= rect.bottom && cx >= rect.left && cx <= rect.right;
    const distance = inside ? 0 : Math.hypot(Math.max(rect.left - cx, 0, cx - rect.right), Math.max(rect.top - cy, 0, cy - rect.bottom));
    if (!best || distance < best.distance) best = { id: container.id, distance };
  }
  return best ? [{ id: best.id }] : [];
};

/** Arrow keys hop between rows: Down lands in the lower half of the next row, Up in the upper half of the previous one. */
const rowKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context: { collisionRect, droppableRects, droppableContainers }, currentCoordinates }) => {
  if (!collisionRect || (event.code !== "ArrowDown" && event.code !== "ArrowUp")) return undefined;
  event.preventDefault();
  const rows = droppableContainers.getEnabled().map((container) => ({ id: container.id, rect: droppableRects.get(container.id) })).filter((row): row is { id: UniqueIdentifier; rect: NonNullable<typeof row.rect> } => !!row.rect).sort((a, b) => a.rect.top - b.rect.top);
  const cy = collisionRect.top + collisionRect.height / 2;
  let current = rows.findIndex((row) => cy >= row.rect.top && cy <= row.rect.bottom);
  if (current < 0) current = event.code === "ArrowDown" ? -1 : rows.length;
  const next = rows[current + (event.code === "ArrowDown" ? 1 : -1)];
  if (!next) return undefined;
  const fraction = parseId(next.id).type === "folder" ? (event.code === "ArrowDown" ? 0.5 : 0.1) : event.code === "ArrowDown" ? 0.75 : 0.25;
  return { x: currentCoordinates.x, y: next.rect.top + next.rect.height * fraction - collisionRect.height / 2 };
};

/* ---------- provider ---------- */
export interface ProjectDndProps {
  layout: ProjectLayout;
  onLayout: (next: ProjectLayout) => void;
  isFolderExpanded: (folderId: string) => boolean;
  onExpandFolder: (folderId: string) => void;
  labelOf: (kind: "project" | "folder", id: string) => string;
  renderOverlay: (kind: "project" | "folder", id: string) => ReactNode;
  children: ReactNode;
}

function edgeFor(_active: DragKey, over: ReturnType<typeof parseId>, fraction: number, expanded: boolean): Hint["edge"] | null {
  if (over.type === "root-end") return "end";
  if (over.type === "empty-folder") return "empty";
  if (over.type === "project") return fraction < 0.5 ? "before" : "after";
  if (fraction < 0.28) return "before";
  if (fraction > 0.72 && !expanded) return "after";
  return "into";
}

export function ProjectDnd({ layout, onLayout, isFolderExpanded, onExpandFolder, labelOf, renderOverlay, children }: ProjectDndProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: rowKeyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );
  const [ui, setUi] = useState<DndUi>({ hint: null, activeId: null });
  const [liveMessage, setLiveMessage] = useState("");
  const activeIdRef = useRef<string | null>(null);
  const hintRef = useRef<Hint | null>(null);
  const expandTimer = useRef<number | null>(null);
  const clearTimer = () => { if (expandTimer.current !== null) { window.clearTimeout(expandTimer.current); expandTimer.current = null; } };
  useEffect(() => clearTimer, []);
  useEffect(() => {
    const root = document.documentElement;
    if (ui.activeId) root.setAttribute("data-dnd-dragging", "");
    else root.removeAttribute("data-dnd-dragging");
    return () => root.removeAttribute("data-dnd-dragging");
  }, [ui.activeId]);

  const setHint = useCallback((hint: Hint | null) => {
    const prev = hintRef.current;
    if (prev?.overId === hint?.overId && prev?.edge === hint?.edge) return;
    hintRef.current = hint;
    setUi((state) => ({ ...state, hint }));
    const mover = activeIdRef.current ? keyOf(activeIdRef.current) : null;
    if (mover && hint) {
      const over = parseId(hint.overId);
      const who = labelOf(mover.kind, mover.id);
      setLiveMessage(over.type === "root-end" ? `${who} will move to the end of the list.`
        : over.type === "empty-folder" || hint.edge === "into" ? `${who} will move into folder ${labelOf("folder", over.id)}.`
        : `${who} will move ${hint.edge === "before" ? "before" : "after"} ${labelOf(over.type === "folder" ? "folder" : "project", over.id)}.`);
    }
    clearTimer();
    if (hint?.edge === "into") {
      const folderId = parseId(hint.overId).id;
      if (!isFolderExpanded(folderId)) expandTimer.current = window.setTimeout(() => onExpandFolder(folderId), 600);
    }
  }, [isFolderExpanded, onExpandFolder]);

  const keyOf = (id: UniqueIdentifier): DragKey => { const p = parseId(id); return { kind: p.type === "folder" ? "folder" : "project", id: p.id }; };

  function toTarget(overId: string, edge: Hint["edge"]): DropTarget | null {
    const over = parseId(overId);
    if (over.type === "root-end") return { type: "root-end" };
    if (over.type === "empty-folder") return { type: "empty-folder", id: over.id };
    if (edge === "empty" || edge === "end") return null;
    return { type: over.type, id: over.id, edge };
  }

  function computeHint(event: Pick<DragMoveEvent, "active" | "over" | "delta" | "activatorEvent">): Hint | null {
    const { active, over, activatorEvent, delta } = event;
    const rect = active.rect.current.translated;
    if (!over || !rect) return null;
    const parsed = parseId(over.id);
    const pointer = activatorEvent as Partial<PointerEvent>;
    const y = typeof pointer.clientY === "number" ? pointer.clientY + delta.y : rect.top + rect.height / 2;
    const fraction = (y - over.rect.top) / Math.max(over.rect.height, 1);
    const activeKey = keyOf(active.id);
    const edge = edgeFor(activeKey, parsed, Math.min(Math.max(fraction, 0), 1), parsed.type === "folder" ? isFolderExpanded(parsed.id) : false);
    if (!edge) return null;
    const hint = { overId: String(over.id), edge };
    const target = toTarget(hint.overId, edge);
    // Hide the indicator for drops that would not change anything.
    return target && !layoutsEqual(applyDrop(layout, activeKey, target), layout) ? hint : null;
  }
  const onMove = (event: DragMoveEvent) => setHint(computeHint(event));

  function onEnd(event: DragEndEvent) {
    const hint = hintRef.current;
    clearTimer();
    hintRef.current = null;
    activeIdRef.current = null;
    setUi({ hint: null, activeId: null });
    if (!event.over || !hint) return;
    const target = toTarget(hint.overId, hint.edge);
    if (!target) return;
    const next = applyDrop(layout, keyOf(event.active.id), target);
    if (next !== layout && !layoutsEqual(next, layout)) onLayout(next);
  }

  const cancel = () => { activeIdRef.current = null; clearTimer(); hintRef.current = null; setUi({ hint: null, activeId: null }); };
  const start = (event: DragStartEvent) => { activeIdRef.current = String(event.active.id); setUi({ hint: null, activeId: String(event.active.id) }); };

  const announcements: Announcements = {
    onDragStart: ({ active }) => { const k = keyOf(active.id); return `Picked up ${k.kind} ${labelOf(k.kind, k.id)}. Use arrow keys to move, Space to drop, Escape to cancel.`; },
    onDragOver: () => undefined,
    onDragEnd: ({ active }) => { const k = keyOf(active.id); return `Dropped ${labelOf(k.kind, k.id)}.`; },
    onDragCancel: ({ active }) => { const k = keyOf(active.id); return `Cancelled. ${labelOf(k.kind, k.id)} stays where it was.`; },
  };

  const activeKey = ui.activeId ? keyOf(ui.activeId) : null;
  return <DndContext sensors={sensors} collisionDetection={centerCollision} autoScroll={{ acceleration: 6, threshold: { x: 0, y: 0.15 } }} accessibility={{ announcements, screenReaderInstructions: { draggable: "Press Space to pick up. Use the up and down arrow keys to choose a position, Space to drop, Escape to cancel." } }} onDragStart={start} onDragMove={onMove} onDragEnd={onEnd} onDragCancel={cancel}>
    <UiContext.Provider value={ui}>{children}</UiContext.Provider>
    <div role="status" aria-live="polite" className="sr-only">{ui.activeId ? liveMessage : ""}</div>
    {createPortal(<DragOverlay dropAnimation={null} zIndex={60}>{activeKey ? renderOverlay(activeKey.kind, activeKey.id) : null}</DragOverlay>, document.body)}
  </DndContext>;
}

/* ---------- row + handle ---------- */
interface HandleCtx { setActivatorNodeRef: (node: HTMLElement | null) => void; attributes: Record<string, unknown>; onKeyDown?: (event: ReactKeyboardEvent) => void }
const HandleContext = createContext<HandleCtx | null>(null);

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => { for (const ref of refs) { if (typeof ref === "function") ref(node); else if (ref) (ref as { current: T | null }).current = node; } };
}

interface DndRowProps extends HTMLAttributes<HTMLDivElement> { kind: "project" | "folder"; itemId: string }

/** Draggable + droppable row frame. Pointer drags start anywhere on the row; keyboard drags start from the row button (DndButton). */
export const DndRow = forwardRef<HTMLDivElement, DndRowProps>(function DndRow({ kind, itemId, className, children, onPointerDown, ...rest }, ref) {
  const id = dndId(kind, itemId);
  const drag = useDraggable({ id });
  const drop = useDroppable({ id });
  const { hint, activeId } = useContext(UiContext);
  const mine = hint?.overId === id ? hint.edge : null;
  const handle = useMemo<HandleCtx>(() => ({ setActivatorNodeRef: drag.setActivatorNodeRef, attributes: { "aria-roledescription": "draggable row", "aria-describedby": drag.attributes["aria-describedby"] }, onKeyDown: drag.listeners?.onKeyDown as HandleCtx["onKeyDown"] }), [drag.setActivatorNodeRef, drag.attributes, drag.listeners?.onKeyDown]);
  return <HandleContext.Provider value={handle}>
    <div ref={mergeRefs(ref, drag.setNodeRef, drop.setNodeRef)} {...rest} data-dnd-kind={kind} data-dnd-id={itemId} data-dnd-drop={mine ?? undefined} data-dragging={activeId === id ? "" : undefined}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => { onPointerDown?.(event); (drag.listeners?.onPointerDown as ((e: ReactPointerEvent<HTMLDivElement>) => void) | undefined)?.(event); }}
      className={cn("group/dnd relative touch-manipulation data-[dragging]:opacity-40", mine === "into" && "rounded-md bg-sidebar-accent/70 ring-1 ring-sidebar-ring/70", className)}>
      <IconGripVertical aria-hidden className="pointer-events-none absolute top-1/2 left-0 z-10 size-3 -translate-y-1/2 text-muted-foreground/70 opacity-0 transition-opacity motion-reduce:transition-none md:group-hover/dnd:opacity-100" />
      {children}
      {(mine === "before" || mine === "after") && <span aria-hidden className={cn("pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-sidebar-ring", mine === "before" ? "-top-px" : "-bottom-px")} />}
    </div>
  </HandleContext.Provider>;
});

/** The row's main button: the keyboard drag activator. Use through `<SidebarMenuButton asChild>`. */
export const DndButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function DndButton({ onKeyDown, ...props }, ref) {
  const handle = useContext(HandleContext);
  return <button type="button" {...handle?.attributes} {...props} ref={mergeRefs(ref, handle?.setActivatorNodeRef as Ref<HTMLButtonElement>)}
    onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented) handle?.onKeyDown?.(event); }} />;
});

/** Droppable placeholder for an empty folder. */
export function EmptyFolderDrop({ folderId, className, children }: { folderId: string; className?: string; children: ReactNode }) {
  const id = `${EMPTY_PREFIX}${folderId}`;
  const { setNodeRef } = useDroppable({ id });
  const { hint } = useContext(UiContext);
  return <div ref={setNodeRef} data-dnd-drop={hint?.overId === id ? "empty" : undefined} className={cn("rounded-md data-[dnd-drop]:bg-sidebar-accent/70 data-[dnd-drop]:ring-1 data-[dnd-drop]:ring-sidebar-ring/70", className)}>{children}</div>;
}

/** Drop zone after the last root row: drop here to ungroup a project or move a folder to the end. */
export function RootEndDrop({ className }: { className?: string }) {
  const { setNodeRef } = useDroppable({ id: ROOT_END });
  const { hint, activeId } = useContext(UiContext);
  const over = hint?.overId === ROOT_END;
  return <li ref={setNodeRef as Ref<HTMLLIElement>} aria-hidden data-dnd-drop={over ? "end" : undefined} className={cn("relative h-6 list-none", className)}>
    {over && <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-sidebar-ring" />}
    {activeId && !over && <span className="pointer-events-none absolute inset-x-2 top-2 text-center text-[11px] text-muted-foreground/70">Drop here to move to the end</span>}
  </li>;
}

/** Inline folder-name editor: Enter/blur commit, Escape cancels. */
export function InlineRename({ initial, label, onCommit, onCancel }: { initial: string; label: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => { if (done.current) return; done.current = true; if (commit) onCommit(value); else onCancel(); };
  return <input
    autoFocus aria-label={label} value={value} maxLength={60} spellCheck={false}
    onFocus={(event) => event.currentTarget.select()}
    onChange={(event) => setValue(event.target.value)}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); finish(true); } else if (event.key === "Escape") { event.preventDefault(); finish(false); } }}
    onBlur={() => finish(true)}
    className="h-6 min-w-0 flex-1 rounded-sm border border-sidebar-ring/70 bg-background/60 px-1.5 text-[13px] font-medium text-sidebar-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/70"
  />;
}

/**
 * Trailing-column action. Every expandable/actionable row shares one grid, pinned to the row's right edge:
 *   [label (flex, truncates)] [slot 2: 24px] [slot 1: chevron 24px]   (slot 3, 24px, only on worktree rows)
 * `reveal` hides the button until the row is hovered/focused/open without moving anything (the slot stays reserved).
 */
export const ROW_SLOT = { chevron: "right-1", second: "right-7", third: "right-[52px]" } as const;
type RowActionProps = ButtonHTMLAttributes<HTMLButtonElement> & { slot: keyof typeof ROW_SLOT; reveal?: string };
export const RowAction = forwardRef<HTMLButtonElement, RowActionProps>(function RowAction({ slot, reveal, className, ...props }, ref) {
  return <Button ref={ref} variant="ghost" size="icon-xs" data-row-action={slot}
    className={cn("absolute top-1/2 z-10 size-6 -translate-y-1/2 border-transparent bg-transparent text-muted-foreground shadow-none [&_svg:not([class*='size-'])]:size-3.5", ROW_SLOT[slot], slot === "chevron" && "aria-expanded:bg-transparent aria-expanded:hover:bg-muted dark:aria-expanded:hover:bg-muted/50", reveal && `${reveal} md:opacity-0 md:focus-visible:opacity-100 md:aria-expanded:opacity-100`, className)} {...props} />;
});
