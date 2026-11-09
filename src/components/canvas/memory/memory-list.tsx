import { memo, useEffect, useRef } from "react";
import { IconPin } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import type { Memory } from "@/lib/runtime/types";
import { relativeTime, titleOf, typeColor } from "./memory-meta";

interface RowProps { m: Memory; active: boolean; open: boolean; score: boolean; reduceMotion: boolean; onOpen: (id: string) => void }

const Row = memo(function Row({ m, active, open, score, reduceMotion, onOpen }: RowProps) {
  const invalid = m.invalidatedAt !== null;
  const body = m.title.trim() ? m.text : m.text.split("\n").slice(1).join(" ").trim() || m.text;
  return (
    <li role="option" aria-selected={open} data-id={m.id} data-active={active || undefined} data-open={open || undefined}
      className={`memory-row relative cursor-pointer rounded-lg border px-3 py-2 ${reduceMotion ? "" : "transition-colors"} ${open ? "border-primary/60 bg-accent" : active ? "border-ring/60 bg-muted" : "border-border/70 hover:bg-muted"} ${invalid ? "opacity-60" : ""}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 78px" }}
      onClick={() => onOpen(m.id)}>
      <span aria-hidden className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full" style={{ background: typeColor(m.type) }} />
      <div className="flex items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium capitalize" style={{ color: typeColor(m.type) }}>{m.type}</span>
        <span className={`min-w-0 flex-1 truncate text-sm font-medium ${invalid ? "line-through decoration-muted-foreground/60" : ""}`}>{titleOf(m)}</span>
        {m.pinned && <IconPin aria-label="Pinned" className="size-3.5 shrink-0 text-primary-text" />}
        {invalid && <Badge variant="destructive" className="shrink-0">forgotten</Badge>}
        {score && typeof m.score === "number" && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{m.score.toFixed(3)}</span>}
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs break-words text-muted-foreground">{body}</p>
      <p className="mt-1 text-xs text-muted-foreground">{m.author ?? "you"} · {relativeTime(m.updatedAt)}{m.scope === "user" ? " · all projects" : ""}</p>
    </li>
  );
});

interface Props { items: Memory[]; activeId: string | null; openId: string | null; searching: boolean; reduceMotion?: boolean; onOpen: (id: string) => void; onActive: (id: string) => void }

/** Listbox with a roving cursor: arrows move, Enter opens. Rows use content-visibility so hundreds stay cheap. */
export function MemoryList({ items, activeId, openId, searching, reduceMotion = false, onOpen, onActive }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!activeId) return;
    ref.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "instant" : "smooth" });
  }, [activeId, reduceMotion]);
  const move = (delta: number) => {
    if (!items.length) return;
    const i = Math.max(0, items.findIndex((m) => m.id === activeId));
    const next = activeId ? Math.min(Math.max(i + delta, 0), items.length - 1) : 0;
    onActive(items[next].id);
  };
  return (
    <ul ref={ref} role="listbox" aria-label="Memories" tabIndex={0} data-testid="memory-list"
      className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-lg p-0.5 pr-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        else if (e.key === "Home") { e.preventDefault(); if (items[0]) onActive(items[0].id); }
        else if (e.key === "End") { e.preventDefault(); if (items.length) onActive(items[items.length - 1].id); }
        else if (e.key === "Enter" && activeId) { e.preventDefault(); onOpen(activeId); }
      }}>
      {items.map((m) => <Row key={m.id} m={m} active={m.id === activeId} open={m.id === openId} score={searching} reduceMotion={reduceMotion} onOpen={onOpen} />)}
    </ul>
  );
}
