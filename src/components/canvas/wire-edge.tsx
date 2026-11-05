import { Button } from "@/components/ui/button";
import { memo, useMemo, type CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, Position, useInternalNode, useStore, type Edge, type EdgeProps } from "@xyflow/react";
import { IconArrowsExchange, IconMessage, IconPlugConnected, IconRoute, IconX } from "@tabler/icons-react";
import { cn } from "cn";
import type { CanvasLink, LinkKind } from "./canvas-data";
import { useCanvasCtx } from "./canvas-context";
import { at, inside, pathOf, route, type Pt, type Rect } from "./wire-routing";
export { anchor, pathOf, route } from "./wire-routing";

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
    const curve = route(from, to, obstacles, fan, link.kind === "recruit");
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
