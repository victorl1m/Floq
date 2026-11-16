// Canvas node for an agy swarm worker / subagent ("virtual agent"): agent-node chrome, but the body is a compact transcript (REST), not a PTY mirror.
import { createContext, memo, useCallback, useContext, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { IconChevronDown, IconChevronRight, IconSend } from "@tabler/icons-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { providerThemeProps } from "@/lib/provider-theme";
import { RoleGlyph } from "@/lib/role-icons";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { VirtualAgent, VirtualAgentStatus, VirtualAgentStep } from "@/lib/runtime/types";
import { RESIZER_ABOVE } from "./wire-edge";
import type { VirtualAgentNode } from "./use-virtual-agents";

interface VirtualCtxValue { client: RuntimeClient | null; resize: (id: string, rect: { x: number; y: number; width: number; height: number }) => void }
const VirtualCtx = createContext<VirtualCtxValue>({ client: null, resize: () => {} });
export const VirtualAgentProvider = VirtualCtx.Provider;

const STATUS: Record<VirtualAgentStatus, { text: string; className: string }> = {
  working: { text: "Working", className: "text-sky-700 dark:text-sky-400" },
  waiting: { text: "Waiting", className: "text-amber-700 dark:text-amber-400" },
  done: { text: "Done", className: "text-emerald-700 dark:text-emerald-400" },
  killed: { text: "Killed", className: "text-muted-foreground" },
  error: { text: "Error", className: "text-destructive" },
  stopped: { text: "Stopped", className: "text-muted-foreground" },
};
const TAIL = 12;
const MIN = { width: 260, height: 160 };

function useTranscript(client: RuntimeClient | null, agent: VirtualAgent, enabled: boolean) {
  const [steps, setSteps] = useState<VirtualAgentStep[]>([]);
  const refresh = useCallback(async () => {
    if (!client) return;
    try { setSteps((await client.virtualAgentTranscript(agent.id, Math.max(0, agent.steps - TAIL), TAIL)).steps.slice(-TAIL)); } catch { /* 404 / offline: keep what we have */ }
  }, [client, agent.id, agent.steps]);
  // Refetch whenever the host reports new steps; a working agent is also polled in case a frame is missed.
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh, agent.lastAt]);
  useEffect(() => {
    if (!enabled || agent.status !== "working") return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [enabled, agent.status, refresh]);
  return steps;
}

function StepRow({ step }: { step: VirtualAgentStep }) {
  return (
    <li data-testid="virtual-step" className="flex flex-col gap-0.5 border-b border-border/40 pb-1 last:border-0">
      {step.error && <span className="whitespace-pre-wrap break-words text-destructive">{step.error}</span>}
      {step.text && <span className="line-clamp-4 whitespace-pre-wrap break-words text-foreground/90">{step.text}</span>}
      {step.tools.map((tool, index) => <span key={index} className="truncate text-muted-foreground" title={tool.summary ?? tool.name}>▸ {tool.summary ?? tool.name}</span>)}
    </li>
  );
}

const VirtualAgentCard = memo(function VirtualAgentCard({ id, data, selected }: NodeProps<VirtualAgentNode>) {
  const { client, resize } = useContext(VirtualCtx);
  const agent = data.agent;
  const [collapsed, setCollapsed] = useState(false);
  const steps = useTranscript(client, agent, !collapsed);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const logRef = useRef<HTMLUListElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [steps]);
  const inactive = agent.status === "killed" || agent.status === "stopped";
  const status = STATUS[agent.status];
  const send = async () => {
    const value = text.trim();
    if (!value || !client) return;
    setNote(null);
    try { await client.messageVirtualAgent(agent.id, value); setText(""); setNote("Sent via the coordinator"); } catch { setNote("Could not send"); }
  };
  return (
    <div {...providerThemeProps("antigravity")} role="group" aria-label={`${agent.name}, ${status.text}`} data-testid="virtual-agent-node" data-vstatus={agent.status}
      data-selected={selected ? "true" : undefined} className="canvas-node-wrap group/node relative size-full">
      <span aria-hidden="true" className="canvas-node-halo rounded-xl" />
      <NodeResizer lineStyle={RESIZER_ABOVE} handleStyle={RESIZER_ABOVE} isVisible={selected && !collapsed} minWidth={MIN.width} minHeight={MIN.height} maxWidth={900} maxHeight={800}
        onResizeEnd={(_, rect) => resize(id, rect)} lineClassName="border-(--provider-accent)!" handleClassName="size-2.5! rounded-sm! border-(--provider-accent)! bg-background!" />
      <div className={cn("canvas-agent-card-material flex size-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-md transition-[border-color,box-shadow]", selected ? "border-(--provider-accent)" : "border-border", inactive && "opacity-70")}>
        <div className="@container/head flex h-10 shrink-0 items-center gap-1 rounded-t-lg border-b bg-muted/40 px-2" style={collapsed ? { borderBottomWidth: 0 } : undefined}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan size-7 shrink-0" aria-label={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((v) => !v)}>
              {collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
            </Button>
            <span className="inline-flex shrink-0"><AgentAvatar session={{ id: agent.id, provider: "antigravity" }} size={20} /></span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={agent.name}>{agent.name}</span>
            {agent.status === "working" && (
              <span role="status" aria-label="Working" className="inline-flex shrink-0 items-center gap-[2px]">
                {[0, 1, 2].map((i) => <span key={i} className="size-1 animate-bounce rounded-full bg-sky-500 motion-reduce:animate-none" style={{ animationDelay: `${i * 150}ms`, animationDuration: "900ms" }} />)}
              </span>
            )}
            <span data-testid="virtual-status" className={cn("shrink-0 text-[10px] font-medium", status.className)}>{status.text}</span>
            <Badge data-testid="virtual-kind" variant="outline" className="h-4 shrink-0 gap-0.5 px-1.5 text-[10px] font-normal text-muted-foreground" title={agent.swarmTitle ?? undefined}>
              <RoleGlyph roleId="subagent" size={10} />{agent.kind}
            </Badge>
            {agent.unread > 0 && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground" title="Unread board posts">{agent.unread}</span>}
          </div>
        </div>
        {!collapsed && (
          <>
            <div className="shrink-0 truncate border-b px-2 py-1 text-[11px] text-muted-foreground" data-testid="virtual-activity" title={agent.activity ?? undefined}>
              {agent.activity ?? `${agent.role}${agent.model ? ` · ${agent.model}` : ""}`}
            </div>
            <ul ref={logRef} className="nodrag nopan nowheel terminal-surface min-h-0 flex-1 space-y-1 overflow-y-auto p-2 font-mono text-[11px]">
              {steps.length === 0 ? <li className="text-muted-foreground">{agent.steps} steps</li> : steps.map((step) => <StepRow key={step.index} step={step} />)}
            </ul>
            <form className="nodrag nopan flex shrink-0 items-center gap-1 border-t p-1.5" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input aria-label={`Message ${agent.name}`} value={text} onChange={(e) => setText(e.target.value)} disabled={inactive} placeholder={inactive ? agent.status : "Ask via the coordinator…"}
                className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:border-(--provider-accent) disabled:opacity-50" />
              <Button type="submit" size="icon-xs" variant="secondary" className="size-7" aria-label="Send" disabled={inactive || !text.trim()}><IconSend size={13} /></Button>
            </form>
            {note && <div role="status" className="shrink-0 px-2 pb-1 text-[10px] text-muted-foreground">{note}</div>}
          </>
        )}
      </div>
    </div>
  );
});

export default VirtualAgentCard;
export const virtualAgentNodeTypes = { "virtual-agent": VirtualAgentCard };
