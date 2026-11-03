import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconFocus2, IconLayoutDistributeHorizontal, IconPlus, IconTopologyStar3 } from "@tabler/icons-react";
import { useTheme } from "next-themes";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ActivityIndicator } from "@/components/agents/activity-indicator";
import { useRuntime } from "@/lib/runtime/store";
import type { SessionState, SessionSummary } from "@/lib/runtime/types";
import { layoutTree } from "./layout";

const DOT: Record<SessionState, string> = { running: "bg-emerald-500", starting: "bg-amber-400 animate-pulse", sleeping: "bg-muted-foreground/40", exited: "bg-muted-foreground/40", failed: "bg-destructive" };

interface AgentNodeData extends Record<string, unknown> {
  session: SessionSummary;
  onFocus: (session: SessionSummary) => void;
}
type AgentNode = Node<AgentNodeData, "agent">;

function startedLabel(session: SessionSummary): string {
  const at = Date.parse(session.startedAt ?? session.createdAt);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just started";
  if (minutes < 60) return `started ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `started ${hours}h ago` : `started ${Math.round(hours / 24)}d ago`;
}

const AgentNodeCard = memo(function AgentNodeCard({ data, selected }: NodeProps<AgentNode>) {
  const { session, onFocus } = data;
  const inactive = session.state === "exited" || session.state === "failed";
  return (
    <div
      className={cn(
        "w-60 rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-colors",
        selected ? "border-primary" : "border-border",
        inactive && "opacity-60",
      )}
    >
      <Handle type="target" position={Position.Top} className="size-1.5! border-0! bg-muted-foreground!" />
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", DOT[session.state])} title={session.state} />
        <span className="min-w-0 truncate text-[13px] font-medium" title={session.title}>{session.title}</span>
        <ActivityIndicator session={session} className="mr-auto" />
        <Button type="button" variant="ghost" size="icon-xs" className="nodrag nopan" aria-label={`Focus ${session.title}`} title="Focus" onClick={() => onFocus(session)}>
          <IconFocus2 size={14} />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">{session.provider}</Badge>
        {session.role && <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">{session.role}</Badge>}
        <span className="text-[10px] text-muted-foreground">{session.state}</span>
      </div>
      <p className="mt-1.5 truncate text-[10px] text-muted-foreground" title={session.cwd}>
        {[session.branch, session.model, startedLabel(session)].filter(Boolean).join(" · ")}
      </p>
      <Handle type="source" position={Position.Bottom} className="size-1.5! border-0! bg-muted-foreground!" />
    </div>
  );
});

// Defined once outside the components so React Flow does not remount nodes on every render.
const nodeTypes = { agent: AgentNodeCard };

function AgentCanvas() {
  const { sessions, projects, canvasProjectId, selectProject, setNewAgentOpen, activateSession, navigate, userPreferences, updateUserPreferences } = useRuntime();
  const { resolvedTheme } = useTheme();
  const { fitView } = useReactFlow();
  // The canvas is always bound to the project it was opened for, never to a possibly-null active project.
  const activeProjectId = canvasProjectId;
  const project = projects.find((item) => item.id === activeProjectId);
  const projectName = project ? project.displayName?.trim() || project.name : "Project";

  const projectSessions = useMemo(
    () => activeProjectId ? sessions.filter((session) => session.projectId === activeProjectId) : [],
    [sessions, activeProjectId],
  );

  const focus = useCallback((session: SessionSummary) => {
    activateSession(session, "agent");
    navigate("session", session.id);
  }, [activateSession, navigate]);

  const saved = activeProjectId ? userPreferences.canvasPositions[activeProjectId] : undefined;
  const savedRef = useRef(saved);
  savedRef.current = saved;

  const { edges, auto } = useMemo(() => {
    const ids = new Set(projectSessions.map((session) => session.id));
    const links = projectSessions.filter((session) => session.parentSessionId && ids.has(session.parentSessionId) && session.parentSessionId !== session.id);
    return {
      auto: layoutTree(projectSessions.map((session) => ({ id: session.id, parentId: links.includes(session) ? session.parentSessionId! : null }))),
      edges: links.map<Edge>((session) => ({
        id: `${session.parentSessionId}->${session.id}`,
        source: session.parentSessionId!,
        target: session.id,
        animated: session.state === "running",
      })),
    };
  }, [projectSessions]);

  const buildNodes = useCallback((useSaved: boolean): AgentNode[] => projectSessions.map((session) => ({
    id: session.id,
    type: "agent",
    position: (useSaved ? savedRef.current?.[session.id] : undefined) ?? auto[session.id] ?? { x: 0, y: 0 },
    data: { session, onFocus: focus },
  })), [projectSessions, auto, focus]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(buildNodes(true));

  // Session updates refresh node data in place; positions of existing nodes (dragged or not) are kept.
  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return buildNodes(true).map((node) => {
        const existing = byId.get(node.id);
        return existing ? { ...existing, data: node.data } : node;
      });
    });
  }, [buildNodes, setNodes]);

  // A different project is a different graph: refit once its nodes are in.
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [activeProjectId, fitView]);

  function relayout() {
    if (activeProjectId) {
      const { [activeProjectId]: _removed, ...rest } = userPreferences.canvasPositions;
      updateUserPreferences({ canvasPositions: rest });
    }
    savedRef.current = undefined;
    setNodes(buildNodes(false));
    requestAnimationFrame(() => void fitView({ duration: 200 }));
  }

  function persist(node: Node) {
    if (!activeProjectId) return;
    const positions = { ...userPreferences.canvasPositions[activeProjectId], [node.id]: { x: node.position.x, y: node.position.y } };
    updateUserPreferences({ canvasPositions: { ...userPreferences.canvasPositions, [activeProjectId]: positions } });
  }

  if (projectSessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <IconTopologyStar3 size={28} stroke={1.5} />
        <p className="text-sm font-medium text-foreground">{projectName} has no agents yet</p>
        <p className="text-xs">Start an agent and the sessions it recruits will appear here.</p>
        <Button type="button" size="sm" className="mt-1" disabled={!activeProjectId} onClick={() => { selectProject(activeProjectId, project?.workspaces[0]?.id); setNewAgentOpen(true); }}>
          <IconPlus size={14} />
          New agent
        </Button>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={(_, node) => persist(node)}
      onNodeDoubleClick={(_, node) => focus((node as AgentNode).data.session)}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      onlyRenderVisibleElements
      fitView
      minZoom={0.2}
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="bg-card!" />
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        <span className="max-w-60 truncate rounded-md border border-border bg-card px-2.5 py-1 text-sm font-medium" title={project?.cwd}>{projectName}</span>
        <Button type="button" variant="outline" size="sm" onClick={relayout}>
          <IconLayoutDistributeHorizontal size={14} />
          Re-layout
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => { selectProject(activeProjectId, project?.workspaces[0]?.id); setNewAgentOpen(true); }}>
          <IconPlus size={14} />
          New agent
        </Button>
      </div>
    </ReactFlow>
  );
}

export default function AgentCanvasPage() {
  return (
    <ReactFlowProvider>
      <AgentCanvas />
    </ReactFlowProvider>
  );
}
