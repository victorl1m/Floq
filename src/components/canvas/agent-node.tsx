import { memo, useRef } from "react";
import { Handle, NodeResizer, Position, useConnection, type Node, type NodeProps } from "@xyflow/react";
import { RoleGlyph, roleLabel } from "@/lib/role-icons";
import { ORCHESTRATOR_TEXT, orchestratorLabel } from "@/lib/runtime/orchestrator";
import { IconChevronDown, IconChevronRight, IconLink, IconNote, IconPlayerPlay, IconRefresh, IconWindowMaximize } from "@tabler/icons-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { FallbackBadge } from "./fallback-badge";
import { ConversationHistoryMenu } from "./conversation-history-menu";
import { FallbackPolicyMenu } from "./fallback-policy-menu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ActivityIndicator } from "@/components/agents/activity-indicator";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { providerThemeProps } from "@/lib/provider-theme";
import type { SessionState, SessionSummary } from "@/lib/runtime/types";
import { useRuntime } from "@/lib/runtime/store";
import { useCanvasCtx } from "./canvas-context";
import { RESIZER_ABOVE, SIDE_STRIP_CLASS, SIDE_STRIP_STYLE } from "./wire-edge";
import NodeMessageBar from "./node-message-bar";
import SessionMirror, { getMirrorTail } from "./session-mirror";

/** State label (replaces the old status dot): colored text so running, starting and failed stay distinguishable. */
const STATE_LABEL: Record<SessionState, { text: string; className: string }> = {
  running: { text: "Running", className: "text-emerald-700 dark:text-emerald-400" },
  starting: { text: "Starting", className: "text-amber-700 dark:text-amber-400" },
  sleeping: { text: "Sleeping", className: "text-muted-foreground" },
  exited: { text: "Exited", className: "text-muted-foreground" },
  failed: { text: "Failed", className: "border-destructive/50 text-destructive" },
};


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
  // Halo feedback (see "canvas node halo" in index.css): source of the wire in progress, valid target, just linked, end of a hovered/selected wire.
  const isSource = isLinkSource || (connecting && connection.fromNode?.id === id);
  const flash = ctx.flashIds.has(id) || ctx.highlightId === id || ctx.sentIds.has(id);
  const linkState = isSource ? "source" : flash ? "flash" : linkPicking || connecting ? "candidate" : ctx.hotIds.has(id) ? "linked" : undefined;

  return (
    <div
      {...providerThemeProps(session.provider)}
      role="group" aria-label={`${session.title}, ${STATE_LABEL[session.state].text}`}
      data-link-state={linkState}
      data-selected={selected ? "true" : undefined}
      className="canvas-node-wrap group/node relative size-full"
    >
      <span aria-hidden="true" className="canvas-node-halo rounded-xl" />
      <NodeResizer lineStyle={RESIZER_ABOVE} handleStyle={RESIZER_ABOVE} isVisible={selected && !collapsed} minWidth={MIN_SIZE.width} minHeight={MIN_SIZE.height} maxWidth={MAX_SIZE.width} maxHeight={MAX_SIZE.height} onResizeEnd={(_, rect) => ctx.savePlacement(id, rect)} lineClassName="border-(--provider-accent)!" handleClassName="size-2.5! rounded-sm! border-(--provider-accent)! bg-background!" />
      {SIDES.map((side) => (
        <Handle key={side.id} id={side.id} type="source" position={side.position} style={SIDE_STRIP_STYLE[side.position]} isConnectable isConnectableStart isConnectableEnd className={SIDE_STRIP_CLASS} />
      ))}

      <div
          data-selected={selected ? "true" : undefined}
          className={cn(
          "canvas-agent-card-material flex size-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-md transition-[border-color,box-shadow]",
          selected ? "border-(--provider-accent)" : "border-border",
          isLead && !selected && "border-border",
          linkPicking && !isLinkSource && "cursor-connect",
          (inactive || sleeping) && "opacity-70",
        )}
      >
      <div className="@container/head flex h-10 shrink-0 items-center gap-1 rounded-t-lg border-b bg-muted/40 px-2" style={collapsed ? { borderBottomWidth: 0 } : undefined}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7 shrink-0" aria-label={collapsed ? "Expand" : "Collapse"} title={collapsed ? "Expand mirror" : "Collapse mirror"} onClick={() => ctx.toggleCollapse(id)}>
            {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
          </Button>
          <span className="inline-flex shrink-0" title={STATE_LABEL[session.state].text}><AgentAvatar session={session} size={20} /></span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={session.title}>{session.title}</span>
          <ActivityIndicator session={session} />
          {session.state === "failed" && <span data-testid="agent-state" className="shrink-0 text-[10px] font-medium text-destructive">Failed</span>}
          {session.fallback && <FallbackBadge sessionId={session.id} fallback={session.fallback} />}
          {session.parentSessionId && (
            <Badge variant="outline" className="h-4 shrink-0 gap-0.5 px-1.5 text-[10px] font-normal text-muted-foreground" title={`Subagent of ${sessions.find((item) => item.id === session.parentSessionId)?.title ?? "its parent"}`} aria-label={`Subagent of ${sessions.find((item) => item.id === session.parentSessionId)?.title ?? "its parent"}`}>
              <RoleGlyph roleId="subagent" size={10} />{roleLabel("subagent")}
            </Badge>
          )}
          {isLead && (
            <Badge variant="outline" className={cn("h-4 shrink-0 gap-0.5 px-1.5 text-[10px] font-normal", ORCHESTRATOR_TEXT)} title={orchestratorLabel(lead)} aria-label={`Orchestrator (lead), ${orchestratorLabel(lead)}`}>
              <RoleGlyph roleId="orchestrator" size={10} />{roleLabel("orchestrator")}
            </Badge>
          )}
          {session.role && !isLead && <Badge variant="secondary" className="hidden h-4 shrink-0 gap-0.5 px-1.5 text-[10px] font-normal @[420px]/head:inline-flex"><RoleGlyph roleId={session.role} size={10} />{roleLabel(session.role)}</Badge>}
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
          {(ctx.noteCounts[id] ?? 0) > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums" title={`${ctx.noteCounts[id]} note${ctx.noteCounts[id] === 1 ? "" : "s"} in this agent's context`} aria-label={`${ctx.noteCounts[id]} note${ctx.noteCounts[id] === 1 ? "" : "s"} in context`}>
              <IconNote size={12} />{ctx.noteCounts[id]}
            </span>
          )}
          {session.provider !== "shell" && (selected || session.sleepReason === "resume_failed") && <ConversationHistoryMenu session={session} />}
          {session.provider === "claude" && (selected || session.fallbackOverride) && <FallbackPolicyMenu sessionId={session.id} value={session.fallbackOverride} />}
          <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7" aria-label={`Open ${session.title}`} title="Open terminal" onClick={() => ctx.focus(session)}>
            <IconWindowMaximize size={14} />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="relative min-h-0 flex-1 overflow-hidden terminal-surface" onDoubleClick={() => barRef.current?.focus()}>
          {live ? (
            <SessionMirror session={session} interactive={!!selected && !linkPicking} />
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
      {session.state === "failed" && session.sleepReason === "resume_failed" && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-t bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          <span className="min-w-0 flex-1 truncate">Couldn't resume, conversation kept</span>
          <Button type="button" size="xs" variant="secondary" className="nodrag nopan" onClick={() => ctx.wake(session)}>Retry</Button>
          <ConversationHistoryMenu session={session} />
        </div>
      )}
      {!collapsed && <NodeMessageBar session={session} inputRef={barRef} send={ctx.sendMessage} />}
      </div>
    </div>
  );
});
