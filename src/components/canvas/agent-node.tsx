import { memo, useRef } from "react";
import { Handle, NodeResizer, Position, useConnection, type Node, type NodeProps } from "@xyflow/react";
import { orchestratorLabel } from "@/lib/runtime/orchestrator";
import { IconChevronDown, IconChevronRight, IconCrown, IconSubtask, IconKey, IconLink, IconNote, IconPlayerPlay, IconRefresh, IconWindowMaximize } from "@tabler/icons-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ActivityIndicator } from "@/components/agents/activity-indicator";
import { ProviderIcon } from "@/components/agents/provider";
import { providerThemeProps } from "@/lib/provider-theme";
import type { SessionState, SessionSummary } from "@/lib/runtime/types";
import { useRuntime } from "@/lib/runtime/store";
import { useCanvasCtx } from "./canvas-context";
import { RESIZER_ABOVE, SIDE_STRIP_CLASS, SIDE_STRIP_STYLE } from "./wire-edge";
import NodeMessageBar from "./node-message-bar";
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

export default memo(function AgentNodeCard({ id, data, selected }: NodeProps<AgentNode>) {
  const ctx = useCanvasCtx();
  const { sessions } = useRuntime();
  const connection = useConnection();
  const { session } = data;
  const isLead = ctx.recruits.has(id);
  const lead = ctx.recruits.get(id) ?? 0;
  const inactive = session.state === "exited" || session.state === "failed";
  const collapsed = ctx.collapsed.has(id);
  const live = ctx.liveIds.has(id) && !collapsed && ctx.terminalId !== id;
  const connecting = connection.inProgress;
  const linkPicking = ctx.linkMode !== null;
  const isLinkSource = ctx.linkMode?.from === id;
  const tail = getMirrorTail(id);
  const sleeping = session.state === "sleeping";
  const waking = ctx.waking.has(id);
  const links = ctx.linkInfo[id];
  const barRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div
      {...providerThemeProps(session.provider)}
      className="group/node relative size-full"
    >
      <NodeResizer lineStyle={RESIZER_ABOVE} handleStyle={RESIZER_ABOVE} isVisible={selected && !collapsed} minWidth={MIN_SIZE.width} minHeight={MIN_SIZE.height} maxWidth={MAX_SIZE.width} maxHeight={MAX_SIZE.height} onResizeEnd={(_, rect) => ctx.savePlacement(id, rect)} lineClassName="border-(--provider-accent)!" handleClassName="size-2.5! rounded-sm! border-(--provider-accent)! bg-background!" />
      {SIDES.map((side) => (
        <Handle key={side.id} id={side.id} type="source" position={side.position} style={SIDE_STRIP_STYLE[side.position]} isConnectable isConnectableStart isConnectableEnd className={SIDE_STRIP_CLASS} />
      ))}

      <div
          data-selected={selected ? "true" : undefined}
          className={cn(
          "canvas-agent-card-material flex size-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-md transition-[border-color,box-shadow]",
          selected ? "border-(--provider-accent) ring-2 ring-(--provider-accent)/30" : "border-border",
          isLead && !selected && "border-border",
          isLinkSource && "border-violet-500 ring-2 ring-violet-500/40",
          linkPicking && !isLinkSource && "cursor-crosshair hover:border-violet-500 hover:ring-2 hover:ring-violet-500/30",
          (inactive || sleeping) && "opacity-70",
          ctx.sentIds.has(id) && "ring-2 ring-emerald-500/60",
        "peer-hover/h:border-primary peer-hover/h:ring-2 peer-hover/h:ring-primary/50 peer-hover/h:shadow-[0_0_16px_0_var(--primary)]",
        connecting && !isLinkSource && "group-hover/node:border-emerald-500 group-hover/node:ring-2 group-hover/node:ring-emerald-500/50 group-hover/node:shadow-[0_0_16px_0_var(--color-emerald-500)]",
        ctx.highlightId === id && "ring-4 ring-primary/50 motion-safe:animate-pulse",
        )}
      >
      <div className="@container/head flex h-10 shrink-0 items-center gap-1 rounded-t-lg border-b bg-muted/40 px-2" style={collapsed ? { borderBottomWidth: 0 } : undefined}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7 shrink-0" aria-label={collapsed ? "Expand" : "Collapse"} title={collapsed ? "Expand mirror" : "Collapse mirror"} onClick={() => ctx.toggleCollapse(id)}>
            {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
          </Button>
          <ProviderIcon provider={session.provider} className="size-4 shrink-0" />
          <span className={cn("size-2 shrink-0 rounded-full", DOT[session.state])} title={session.state} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={session.title}>{session.title}</span>
          <ActivityIndicator session={session} />
          {isLead && (
            <span role="img" aria-label={`Lead orchestrator, ${lead} ${lead === 1 ? "agent" : "agents"}`} title={orchestratorLabel(lead)} className="grid size-6 shrink-0 place-items-center text-muted-foreground">
              <IconCrown size={14} aria-hidden="true" />
            </span>
          )}
          {sleeping && <Badge variant="outline" className="hidden h-4 shrink-0 px-1.5 text-[10px] font-normal text-muted-foreground @[300px]/head:inline-flex">Sleeping</Badge>}
          {session.parentSessionId && (
            <Badge variant="outline" className="h-4 shrink-0 gap-0.5 px-1.5 text-[10px] font-normal text-muted-foreground" title={`Subagent of ${sessions.find((item) => item.id === session.parentSessionId)?.title ?? "its parent"}`} aria-label={`Subagent of ${sessions.find((item) => item.id === session.parentSessionId)?.title ?? "its parent"}`}>
              <IconSubtask size={10} aria-hidden="true" />Subagent
            </Badge>
          )}
          {session.role && <Badge variant="secondary" className="hidden h-4 shrink-0 px-1.5 text-[10px] font-normal @[420px]/head:inline-flex">{session.role}</Badge>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {links && links.count > 0 && (
            <span className="hidden shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground @[340px]/head:flex" title={`${links.count} linked agent${links.count === 1 ? "" : "s"}, in this agent's context`} aria-label={`${links.count} linked agent${links.count === 1 ? "" : "s"} in context`}>
              <IconLink size={11} />{links.count}
            </span>
          )}
          {(sleeping || inactive) && (
            <Button type="button" variant="secondary" size="icon-xs" className="nodrag nopan size-7" aria-label={`${sleeping ? "Wake" : "Restart"} ${session.title}`} aria-busy={waking} title={sleeping ? "Wake agent" : "Restart agent"} disabled={waking} onClick={() => ctx.wake(session)}>
              {waking ? <Spinner /> : sleeping ? <IconPlayerPlay size={14} /> : <IconRefresh size={14} />}
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7" aria-label={`Link ${session.title} to another agent`} title="Link to…" onClick={() => ctx.startLink(id)}>
            <IconLink size={14} />
          </Button>
          {(ctx.keychainCounts[id] ?? 0) > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-amber-600 tabular-nums dark:text-amber-400" title={`${ctx.keychainCounts[id]} keychain${ctx.keychainCounts[id] === 1 ? "" : "s"} in this agent's context (names only, never values)`} aria-label={`${ctx.keychainCounts[id]} keychain${ctx.keychainCounts[id] === 1 ? "" : "s"} in context`}>
              <IconKey size={12} />{ctx.keychainCounts[id]}
            </span>
          )}
          {(ctx.noteCounts[id] ?? 0) > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums" title={`${ctx.noteCounts[id]} note${ctx.noteCounts[id] === 1 ? "" : "s"} in this agent's context`} aria-label={`${ctx.noteCounts[id]} note${ctx.noteCounts[id] === 1 ? "" : "s"} in context`}>
              <IconNote size={12} />{ctx.noteCounts[id]}
            </span>
          )}
          {((ctx.noteCounts[id] ?? 0) + (ctx.keychainCounts[id] ?? 0) + (links?.count ?? 0)) > 0 && (
            <span className="hidden shrink-0 rounded-sm border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground @[420px]/head:inline" data-testid="in-context-badge">in context</span>
          )}
          <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7" aria-label={`Open ${session.title}`} title="Open terminal" onClick={() => ctx.focus(session)}>
            <IconWindowMaximize size={14} />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="relative min-h-0 flex-1 overflow-hidden terminal-surface" onDoubleClick={() => barRef.current?.focus()}>
          {live ? (
            <SessionMirror session={session} />
          ) : (
            <div className="flex size-full flex-col gap-2 p-2 font-mono text-[11px] text-muted-foreground">
              <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-all">{tail || `${session.state}${session.branch ? ` · ${session.branch}` : ""}${session.model ? ` · ${session.model}` : ""}`}</pre>
              {!inactive && session.state !== "sleeping" && (
                <Button type="button" size="xs" variant="secondary" className="nodrag nopan self-start" onClick={() => ctx.activate(id)}>
                  <IconPlayerPlay size={12} />
                  Activate live view
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {!collapsed && <NodeMessageBar session={session} inputRef={barRef} send={ctx.sendMessage} />}
      </div>
    </div>
  );
});
