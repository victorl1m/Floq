import { memo } from "react";
import { Handle, NodeResizer, Position, useConnection, type Node, type NodeProps } from "@xyflow/react";
import { IconChevronDown, IconChevronRight, IconEye, IconFocus2, IconLink, IconPlayerPlay } from "@tabler/icons-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ActivityIndicator } from "@/components/agents/activity-indicator";
import { ProviderIcon } from "@/components/agents/provider";
import type { SessionState, SessionSummary } from "@/lib/runtime/types";
import { useCanvasCtx } from "./canvas-context";
import SessionMirror, { getMirrorTail } from "./session-mirror";

const DOT: Record<SessionState, string> = { running: "bg-emerald-500", starting: "bg-amber-400 animate-pulse", sleeping: "bg-muted-foreground/40", exited: "bg-muted-foreground/40", failed: "bg-destructive" };

export interface AgentNodeData extends Record<string, unknown> {
  session: SessionSummary;
}
export type AgentNode = Node<AgentNodeData, "agent">;

export const MIN_SIZE = { width: 280, height: 160 };
export const MAX_SIZE = { width: 1400, height: 1000 };
export const HEADER_HEIGHT = 40;

const SIDES = [
  { id: "top", position: Position.Top },
  { id: "right", position: Position.Right },
  { id: "bottom", position: Position.Bottom },
  { id: "left", position: Position.Left },
] as const;

const HANDLE_CLASS =
  "size-4! rounded-full! border-2! border-background! bg-primary! opacity-0 transition-opacity group-hover/node:opacity-100 data-[active=true]:opacity-100 hover:scale-125 [&.connectingto]:bg-emerald-500! [&.connectingto]:opacity-100 [&.valid]:bg-emerald-500!";

export default memo(function AgentNodeCard({ id, data, selected }: NodeProps<AgentNode>) {
  const ctx = useCanvasCtx();
  const connection = useConnection();
  const { session } = data;
  const inactive = session.state === "exited" || session.state === "failed";
  const collapsed = ctx.collapsed.has(id);
  const live = ctx.liveIds.has(id) && !collapsed;
  const connecting = connection.inProgress;
  const linkPicking = ctx.linkMode !== null;
  const isLinkSource = ctx.linkMode?.from === id;
  const tail = getMirrorTail(id);

  return (
    <div
      className={cn(
        "group/node flex size-full flex-col overflow-visible rounded-lg border bg-card text-card-foreground shadow-md transition-[border-color,box-shadow]",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border",
        isLinkSource && "border-violet-500 ring-2 ring-violet-500/40",
        linkPicking && !isLinkSource && "cursor-crosshair hover:border-violet-500 hover:ring-2 hover:ring-violet-500/30",
        inactive && "opacity-70",
      )}
    >
      <NodeResizer isVisible={selected && !collapsed} minWidth={MIN_SIZE.width} minHeight={MIN_SIZE.height} maxWidth={MAX_SIZE.width} maxHeight={MAX_SIZE.height} onResizeEnd={(_, rect) => ctx.savePlacement(id, rect)} lineClassName="border-primary!" handleClassName="size-2.5! rounded-sm! border-primary! bg-background!" />
      {SIDES.map((side) => (
        <Handle key={side.id} id={side.id} type="source" position={side.position} isConnectableStart isConnectableEnd data-active={connecting} className={HANDLE_CLASS} />
      ))}

      <div className="flex h-10 shrink-0 items-center gap-2 rounded-t-lg border-b bg-muted/40 px-2.5" style={collapsed ? { borderBottomWidth: 0 } : undefined}>
        <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan -ml-1" aria-label={collapsed ? "Expand" : "Collapse"} title={collapsed ? "Expand mirror" : "Collapse mirror"} onClick={() => ctx.toggleCollapse(id)}>
          {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
        </Button>
        <ProviderIcon provider={session.provider} className="size-4 shrink-0" />
        <span className={cn("size-2 shrink-0 rounded-full", DOT[session.state])} title={session.state} />
        <span className="min-w-0 truncate text-[13px] font-medium" title={session.title}>{session.title}</span>
        {session.role && <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] font-normal">{session.role}</Badge>}
        <ActivityIndicator session={session} className="mr-auto" />
        <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan" aria-label={`Link ${session.title} to another agent`} title="Link to…" onClick={() => ctx.startLink(id)}>
          <IconLink size={14} />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan" aria-label={`Open ${session.title}`} title="Open full terminal" onClick={() => ctx.focus(session)}>
          <IconFocus2 size={14} />
        </Button>
      </div>

      {!collapsed && (
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-lg bg-[#0c0c0e]">
          {live ? (
            <SessionMirror session={session} />
          ) : (
            <div className="flex size-full flex-col gap-2 p-2 font-mono text-[11px] text-zinc-400">
              <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-all opacity-70">{tail || `${session.state}${session.branch ? ` · ${session.branch}` : ""}${session.model ? ` · ${session.model}` : ""}`}</pre>
              {!inactive && session.state !== "sleeping" && (
                <Button type="button" size="xs" variant="secondary" className="nodrag nopan self-start" onClick={() => ctx.activate(id)}>
                  <IconPlayerPlay size={12} />
                  Activate live view
                </Button>
              )}
            </div>
          )}
          {live && (
            <span className="pointer-events-none absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] text-zinc-300" title="Mirror only: open the full terminal to type">
              <IconEye size={10} />
              view-only
            </span>
          )}
        </div>
      )}
    </div>
  );
});
