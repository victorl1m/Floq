import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, Position, getBezierPath, useInternalNode, type Edge, type EdgeProps } from "@xyflow/react";
import { IconArrowsExchange, IconMessage, IconPlugConnected, IconRoute, IconX } from "@tabler/icons-react";
import { cn } from "cn";
import type { CanvasLink, LinkKind } from "./canvas-data";
import { useCanvasCtx } from "./canvas-context";

export const KIND_COLOR: Record<LinkKind, string> = {
  recruit: "#8b5cf6",
  message: "#0ea5e9",
  manual: "var(--muted-foreground)",
};
export const KIND_LABEL: Record<LinkKind, string> = { recruit: "delegates", message: "talks", manual: "linked" };
export const KIND_ICON = { recruit: IconRoute, message: IconMessage, manual: IconPlugConnected } as const;

export type WireEdge = Edge<{ link: CanvasLink }, "wire">;

function useRect(id: string) {
  const node = useInternalNode(id);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;
  return { x, y, width, height };
}

/** Floating endpoints: leave each node from the side that faces the other one. */
function anchor(from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }) {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const horizontal = Math.abs(dx) * from.height > Math.abs(dy) * from.width;
  if (horizontal) return dx > 0 ? { x: from.x + from.width, y: from.y + from.height / 2, position: Position.Right } : { x: from.x, y: from.y + from.height / 2, position: Position.Left };
  return dy > 0 ? { x: from.x + from.width / 2, y: from.y + from.height, position: Position.Bottom } : { x: from.x + from.width / 2, y: from.y, position: Position.Top };
}

export default memo(function WireEdgeView({ id, source, target, data, selected, markerEnd }: EdgeProps<WireEdge>) {
  const ctx = useCanvasCtx();
  const from = useRect(source);
  const to = useRect(target);
  if (!data || !from || !to) return null;
  const link = data.link;
  const a = anchor(from, to);
  const b = anchor(to, from);
  const [path, labelX, labelY] = getBezierPath({ sourceX: a.x, sourceY: a.y, sourcePosition: a.position, targetX: b.x, targetY: b.y, targetPosition: b.position, curvature: 0.35 });
  const color = KIND_COLOR[link.kind];
  const Icon = KIND_ICON[link.kind];
  const live = ctx.live[link.id];

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={28}
        style={{ stroke: color, strokeWidth: selected ? 3 : 2, strokeDasharray: link.kind === "manual" ? "6 5" : undefined, opacity: selected || live ? 1 : 0.8 }}
      />
      {!ctx.reducedMotion && live?.pulses.map((pulse) => (
        <circle key={pulse.key} r={5} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}>
          <animateMotion dur="1.4s" repeatCount="1" fill="freeze" path={path} keyPoints={pulse.reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
        </circle>
      ))}
      <EdgeLabelRenderer>
        <div className="nodrag nopan absolute z-10 flex flex-col items-center gap-1" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}>
          <div
            className={cn("flex items-center gap-1 rounded-full border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm", selected ? "border-primary" : "border-border")}
            title={`${ctx.titleOf(link.fromSessionId)} → ${ctx.titleOf(link.toSessionId)} (${KIND_LABEL[link.kind]})${link.synthetic ? " - inferred" : ""}`}
          >
            <Icon size={11} style={{ color }} />
            <span className="tabular-nums">{link.messageCount > 0 ? link.messageCount : KIND_LABEL[link.kind]}</span>
            {selected && !link.synthetic && (
              <button type="button" aria-label="Delete link" title="Delete link (Del)" className="ml-0.5 rounded-full p-0.5 text-destructive hover:bg-destructive/10" onClick={(event) => { event.stopPropagation(); ctx.deleteLink(link); }}>
                <IconX size={11} />
              </button>
            )}
          </div>
          {live?.bubbles.map((bubble) => (
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
      </EdgeLabelRenderer>
    </>
  );
});
