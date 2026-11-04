import { Button } from "@/components/ui/button";
import { memo, useMemo, type CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, Position, useInternalNode, useStore, type Edge, type EdgeProps } from "@xyflow/react";
import { IconArrowsExchange, IconMessage, IconPlugConnected, IconRoute, IconX } from "@tabler/icons-react";
import { cn } from "cn";
import type { CanvasLink, LinkKind } from "./canvas-data";
import { useCanvasCtx } from "./canvas-context";

export const KIND_COLOR: Record<LinkKind, string> = {
  recruit: "var(--muted-foreground)",
  message: "color-mix(in oklab, var(--muted-foreground) 72%, var(--primary) 28%)",
  manual: "var(--muted-foreground)",
};
export const KIND_LABEL: Record<LinkKind, string> = { recruit: "delegates", message: "talks", manual: "linked" };
export const KIND_ICON = { recruit: IconRoute, message: IconMessage, manual: IconPlugConnected } as const;

export type WireEdge = Edge<{ link: CanvasLink }, "wire">;

export function useRect(id: string) {
  const node = useInternalNode(id);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  return { x, y, width, height };
}

/** Floating endpoints: leave each node from the side that faces the other one. */
export function anchor(from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }) {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const horizontal = Math.abs(dx) * from.height > Math.abs(dy) * from.width;
  if (horizontal) return dx > 0 ? { x: from.x + from.width, y: from.y + from.height / 2, position: Position.Right } : { x: from.x, y: from.y + from.height / 2, position: Position.Left };
  return dy > 0 ? { x: from.x + from.width / 2, y: from.y + from.height, position: Position.Bottom } : { x: from.x + from.width / 2, y: from.y, position: Position.Top };
}

type Rect = { x: number; y: number; width: number; height: number };
type Pt = { x: number; y: number };
type Anchor = Pt & { position: Position };
type Curve = { a: Anchor; c1: Pt; c2: Pt; b: Anchor };

const PAD = 16;
const SAMPLES = 28;
const DIR: Record<Position, Pt> = { [Position.Top]: { x: 0, y: -1 }, [Position.Bottom]: { x: 0, y: 1 }, [Position.Left]: { x: -1, y: 0 }, [Position.Right]: { x: 1, y: 0 } };

function at(curve: Curve, t: number): Pt {
  const u = 1 - t;
  const { a, c1, c2, b } = curve;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}
const inside = (point: Pt, rect: Rect, pad: number) => point.x > rect.x - pad && point.x < rect.x + rect.width + pad && point.y > rect.y - pad && point.y < rect.y + rect.height + pad;
function collisions(curve: Curve, obstacles: Rect[]) {
  let hits = 0;
  for (let i = 1; i < SAMPLES; i++) {
    const point = at(curve, i / SAMPLES);
    if (obstacles.some((rect) => inside(point, rect, PAD))) hits++;
  }
  return hits;
}
function length(curve: Curve) {
  let total = 0, prev = at(curve, 0);
  for (let i = 1; i <= 12; i++) { const point = at(curve, i / 12); total += Math.hypot(point.x - prev.x, point.y - prev.y); prev = point; }
  return total;
}

/** Control points push each end out along its side's normal by `reach` (like getBezierPath). */
function curveOf(a: Anchor, b: Anchor, reachA: number, reachB = reachA): Curve {
  const da = DIR[a.position], db = DIR[b.position];
  return { a, b, c1: { x: a.x + da.x * reachA, y: a.y + da.y * reachA }, c2: { x: b.x + db.x * reachB, y: b.y + db.y * reachB } };
}
const side = (rect: Rect, position: Position, shift = 0): Anchor => {
  if (position === Position.Top) return { x: rect.x + rect.width / 2 + shift, y: rect.y, position };
  if (position === Position.Bottom) return { x: rect.x + rect.width / 2 + shift, y: rect.y + rect.height, position };
  if (position === Position.Left) return { x: rect.x, y: rect.y + rect.height / 2 + shift, position };
  return { x: rect.x + rect.width, y: rect.y + rect.height / 2 + shift, position };
};

/** Natural floating route first; if it crosses another node, try detours over/under the row and keep the least-crossing one. */
export function route(from: Rect, to: Rect, obstacles: Rect[], fan: number): Curve {
  const natural = (() => {
    const a = anchor(from, to), b = anchor(to, from);
    const horizontal = a.position === Position.Left || a.position === Position.Right;
    const reach = Math.max(40, (horizontal ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y)) * 0.35);
    const shifted = (p: Anchor): Anchor => (horizontal ? { ...p, y: p.y + fan } : { ...p, x: p.x + fan });
    return curveOf(shifted(a), shifted(b), reach);
  })();
  const candidates = [natural];
  if (collisions(natural, obstacles) > 0) {
    const left = Math.min(from.x, to.x), right = Math.max(from.x + from.width, to.x + to.width);
    const between = obstacles.filter((rect) => rect.x < right && rect.x + rect.width > left);
    for (const position of [Position.Bottom, Position.Top] as const) {
      const a = side(from, position, fan), b = side(to, position, fan);
      const edgeY = position === Position.Bottom
        ? Math.max(a.y, b.y, ...between.map((rect) => rect.y + rect.height)) + 36
        : Math.min(a.y, b.y, ...between.map((rect) => rect.y)) - 36;
      candidates.push(curveOf(a, b, Math.max(70, Math.abs(edgeY - a.y) / 0.75), Math.max(70, Math.abs(edgeY - b.y) / 0.75)));
    }
  }
  let best = natural, bestScore = Infinity;
  for (const [index, candidate] of candidates.entries()) {
    const score = collisions(candidate, obstacles) * 10000 + length(candidate) + index * 5;
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}

export const pathOf = (c: Curve) => `M ${c.a.x},${c.a.y} C ${c.c1.x},${c.c1.y} ${c.c2.x},${c.c2.y} ${c.b.x},${c.b.y}`;

export default memo(function WireEdgeView({ id, source, target, data, selected, markerEnd }: EdgeProps<WireEdge>) {
  const ctx = useCanvasCtx();
  const from = useRect(source);
  const to = useRect(target);
  // Signature of every node's rect, so only real geometry changes re-route this wire.
  const sig = useStore((state) => {
    const parts: string[] = [];
    state.nodeLookup.forEach((node, nodeId) => {
      const { x, y } = node.internals.positionAbsolute;
      parts.push(`${nodeId}@${Math.round(x)},${Math.round(y)},${Math.round(node.measured.width ?? node.width ?? 0)},${Math.round(node.measured.height ?? node.height ?? 0)}`);
    });
    return parts.join("|");
  });
  // Parallel wires between the same two agents are fanned out instead of stacking.
  const fanKey = useStore((state) => {
    const pair = [source, target].sort().join("|");
    const same = state.edges.filter((edge) => [edge.source, edge.target].sort().join("|") === pair).map((edge) => edge.id).sort();
    return `${same.indexOf(id)}/${same.length}`;
  });
  const targetWorking = useStore((state) => {
    const session = (state.nodeLookup.get(target)?.data as { session?: { state: string; activity?: string | null } } | undefined)?.session;
    return session?.state === "running" && session.activity === "working";
  });
  const geometry = useMemo(() => {
    if (!from || !to) return null;
    const others = sig.split("|").filter(Boolean).map((entry) => {
      const [nodeId, nums] = entry.split("@");
      const [x, y, width, height] = nums.split(",").map(Number);
      return { id: nodeId, rect: { x, y, width, height } as Rect };
    });
    const obstacles = others.filter((item) => item.id !== source && item.id !== target).map((item) => item.rect);
    const [index, count] = fanKey.split("/").map(Number);
    const fan = (index - (count - 1) / 2) * 16;
    const curve = route(from, to, obstacles, fan);
    // Label: first sample along the wire that is not painted over any node; null = hide it.
    let label: Pt | null = null;
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const point = at(curve, t);
      if (!others.some((item) => inside(point, item.rect, 12))) { label = point; break; }
    }
    return { curve, label, mid: at(curve, 0.5) };
  }, [from, to, sig, fanKey, source, target]);
  if (!data || !geometry) return null;
  const link = data.link;
  const path = pathOf(geometry.curve);
  const Icon = KIND_ICON[link.kind];
  const live = ctx.live[link.id];
  // Resting relationships stay quiet; active and selected wires use the high-contrast semantic accent.
  const color = selected || live || targetWorking ? "var(--primary-text)" : KIND_COLOR[link.kind];
  const labelAt = geometry.label ?? (selected ? geometry.mid : null);
  const bubbleAt = labelAt ?? geometry.mid;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={28}
        style={{ stroke: color, strokeWidth: selected ? 3 : 2, strokeDasharray: link.kind === "manual" ? "6 5" : undefined, opacity: selected || live ? 1 : 0.8, filter: selected ? `drop-shadow(0 0 3px color-mix(in oklab, ${color} 45%, transparent))` : undefined }}
      />
      {!ctx.reducedMotion && live?.pulses.map((pulse) => (
        <circle key={pulse.key} r={5} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
          <animateMotion dur="1.4s" repeatCount="1" fill="freeze" path={path} keyPoints={pulse.reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
        </circle>
      ))}
      <EdgeLabelRenderer>
        {/* The label layer has no z-index, so it paints below the nodes: a pill can never cover a node body. */}
        {labelAt && (
          <div className="nodrag nopan absolute" style={{ transform: `translate(-50%, -50%) translate(${labelAt.x}px, ${labelAt.y}px)`, pointerEvents: "all" }}>
            <div
              className={cn("flex items-center gap-1 rounded-full border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm", selected ? "border-primary" : "border-border")}
              title={`${ctx.titleOf(link.fromSessionId)} → ${ctx.titleOf(link.toSessionId)} (${KIND_LABEL[link.kind]})${link.synthetic ? " - inferred" : ""}`}
            >
              <Icon size={11} style={{ color }} />
              <span className="tabular-nums">{link.messageCount > 0 ? link.messageCount : KIND_LABEL[link.kind]}</span>
              {selected && !link.synthetic && (
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Delete link" title="Delete link (Del)" className="ml-0.5 size-4 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={(event) => { event.stopPropagation(); ctx.deleteLink(link); }}>
                  <IconX size={11} />
                </Button>
              )}
            </div>
          </div>
        )}
        {!!live?.bubbles.length && (
          <div className="nodrag nopan pointer-events-none absolute z-10 flex flex-col items-center gap-1" style={{ transform: `translate(-50%, 14px) translate(${bubbleAt.x}px, ${bubbleAt.y}px)` }}>
            {live.bubbles.map((bubble) => (
              <div key={bubble.key} className="max-w-64 animate-in fade-in zoom-in-95 rounded-lg border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md" style={{ borderColor: color }}>
                <div className="flex items-center gap-1 font-medium">
                  <span className="max-w-24 truncate">{bubble.from}</span>
                  <IconArrowsExchange size={10} className="shrink-0 text-muted-foreground" />
                  <span className="max-w-24 truncate">{bubble.to}</span>
                </div>
                <p className="line-clamp-3 break-words text-muted-foreground">{bubble.text}</p>
              </div>
            ))}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
});

/** Connection strips run along a whole side but sit entirely outside the border, so they never overlap the resize edge; hovering one (peer/h) makes the card itself glow, so the glow follows its rounded corners. */
export const SIDE_STRIP_STYLE: Record<Position, CSSProperties> = {
  top: { top: 0, bottom: "auto", left: 10, right: "auto", width: "calc(100% - 20px)", height: 14, transform: "translateY(-100%)" },
  bottom: { bottom: 0, top: "auto", left: 10, right: "auto", width: "calc(100% - 20px)", height: 14, transform: "translateY(100%)" },
  left: { left: 0, right: "auto", top: 10, bottom: "auto", height: "calc(100% - 20px)", width: 14, transform: "translateX(-100%)" },
  right: { right: 0, left: "auto", top: 10, bottom: "auto", height: "calc(100% - 20px)", width: 14, transform: "translateX(100%)" },
};
export const SIDE_STRIP_CLASS = "canvas-side-strip peer/h cursor-connect rounded-none! border-0! bg-transparent! min-h-0! min-w-0!";
/** Keeps the resize edges and corners above the connection strips. */
export const RESIZER_ABOVE = { zIndex: 10 } as const;
