import { memo, useEffect, useRef } from "react";
import { IconPin, IconWorld } from "@tabler/icons-react";
import { dateParts } from "@/lib/memory-dates";
import type { Memory } from "@/lib/runtime/types";
import { bodyOf, titleOf, TYPE_META, typeColor, typeInk } from "./memory-meta";

interface RowProps { m: Memory; active: boolean; open: boolean; score: boolean; reduceMotion: boolean; onOpen: (id: string) => void }

const Row = memo(function Row({ m, active, open, score, reduceMotion, onOpen }: RowProps) {
  const invalid = m.invalidatedAt !== null;
  const meta = TYPE_META[m.type] ?? TYPE_META.fact;
  const TypeIcon = meta.icon;
  const when = dateParts(m.updatedAt);
  return (
    <li role="option" aria-selected={open} data-id={m.id} data-active={active || undefined} data-open={open || undefined}
      className={`memory-row mem-row relative grid cursor-pointer grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 rounded-xl px-3 py-2.5 ${reduceMotion ? "" : "transition-colors duration-150"} ${invalid ? "opacity-60" : ""}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 76px", ["--mem-tint" as string]: typeColor(m.type), ["--mem-tint-ink" as string]: typeInk(m.type) }}
      onClick={() => onOpen(m.id)}>
      <span aria-hidden className="mem-type-tile mt-0.5 flex size-8 items-center justify-center rounded-[10px]"><TypeIcon size={16} stroke={1.75} /></span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate text-[13px] leading-5 font-medium ${invalid ? "line-through decoration-muted-foreground/60" : ""}`}>{titleOf(m)}</span>
          {m.pinned && <IconPin aria-label="Pinned" className="size-3.5 shrink-0 text-primary-text" />}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-[18px] break-words text-muted-foreground">{bodyOf(m)}</p>
        <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
          <span className="font-medium" style={{ color: typeInk(m.type) }}>{meta.label}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{m.author ?? "you"}</span>
          {m.scope === "user" && <><span aria-hidden>·</span><span className="inline-flex shrink-0 items-center gap-0.5"><IconWorld aria-hidden size={11} />all projects</span></>}
          {invalid && <><span aria-hidden>·</span><span className="shrink-0 font-medium text-destructive">forgotten</span></>}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 pt-0.5">
        <time className="text-[11px] leading-5 whitespace-nowrap text-muted-foreground tabular-nums" dateTime={when.iso} title={when.valid ? `Updated ${when.absolute}` : "Update time unknown"} data-testid="row-time">{when.relative}</time>
        {score && typeof m.score === "number" && <span className="mem-count" title="Relevance">{m.score.toFixed(2)}</span>}
      </div>
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
      className="mem-pane min-h-0 flex-1 space-y-0.5 overflow-y-auto rounded-xl p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
