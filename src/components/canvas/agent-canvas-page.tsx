import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useOnViewportChange,
  useReactFlow,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  IconActivity, IconArrowsMaximize, IconHandStop, IconLayoutDistributeHorizontal, IconLink, IconMap, IconPlus, IconPointer, IconTopologyStar3,
} from "@tabler/icons-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { copyText } from "@/lib/clipboard";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import type { SessionSummary } from "@/lib/runtime/types";
import AgentNodeCard, { HEADER_HEIGHT, MAX_SIZE, MIN_SIZE, type AgentNode } from "./agent-node";
import ActivityPanel from "./activity-panel";
import CanvasMenuContent, { type MenuApi, type MenuTarget, type SizePreset } from "./canvas-menu";
import { CanvasCtx, type CanvasCtxValue, type LiveWire } from "./canvas-context";
import { createLinkRequest, deleteLinkRequest, useAgentEvents, useProjectLinks, type AgentMessageEvent, type CanvasLink } from "./canvas-data";
import { DEFAULT_NODE_SIZE, layoutTree } from "./layout";
import { getMirrorText } from "./session-mirror";
import WireEdgeView, { KIND_COLOR, type WireEdge } from "./wire-edge";

// Defined once outside the components so React Flow does not remount nodes/edges on every render.
const nodeTypes = { agent: AgentNodeCard };
const edgeTypes = { wire: WireEdgeView };
const MAX_LIVE = 8;
const SIZE_PRESETS: Record<Exclude<SizePreset, "fit">, { width: number; height: number }> = {
  small: { width: 360, height: 220 },
  medium: DEFAULT_NODE_SIZE,
  large: { width: 860, height: 540 },
};
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function AgentCanvas() {
  const {
    sessions, projects, canvasProjectId, selectProject, setNewAgentOpen, activateSession, navigate, userPreferences, updateUserPreferences,
    client, upsertSession, closeTab,
  } = useRuntime();
  const { resolvedTheme } = useTheme();
  const { fitView, getViewport, zoomTo, screenToFlowPosition } = useReactFlow();
  // The canvas is always bound to the project it was opened for, never to a possibly-null active project.
  const activeProjectId = canvasProjectId;
  const project = projects.find((item) => item.id === activeProjectId);
  const projectName = project ? project.displayName?.trim() || project.name : "Project";
  const wrapRef = useRef<HTMLDivElement>(null);

  const projectSessions = useMemo(
    () => activeProjectId ? sessions.filter((session) => session.projectId === activeProjectId) : [],
    [sessions, activeProjectId],
  );
  const sessionById = useCallback((id: string) => projectSessions.find((session) => session.id === id), [projectSessions]);
  const titleOf = useCallback((id: string) => sessionById(id)?.title ?? "agent", [sessionById]);

  const focus = useCallback((session: SessionSummary) => {
    activateSession(session, "agent");
    navigate("session", session.id);
  }, [activateSession, navigate]);

  // ---- persisted placement ----
  const prefsRef = useRef(userPreferences);
  prefsRef.current = userPreferences;
  const savedPositions = activeProjectId ? userPreferences.canvasPositions[activeProjectId] : undefined;
  const savedSizes = activeProjectId ? userPreferences.canvasSizes[activeProjectId] : undefined;
  const savedRef = useRef({ positions: savedPositions, sizes: savedSizes });
  savedRef.current = { positions: savedPositions, sizes: savedSizes };

  const persistNode = useCallback((id: string, patch: { position?: { x: number; y: number }; size?: { width: number; height: number } }) => {
    if (!activeProjectId) return;
    const prefs = prefsRef.current;
    const next: Partial<typeof prefs> = {};
    if (patch.position) next.canvasPositions = { ...prefs.canvasPositions, [activeProjectId]: { ...prefs.canvasPositions[activeProjectId], [id]: patch.position } };
    if (patch.size) next.canvasSizes = { ...prefs.canvasSizes, [activeProjectId]: { ...prefs.canvasSizes[activeProjectId], [id]: patch.size } };
    prefsRef.current = { ...prefs, ...next };
    updateUserPreferences(next);
  }, [activeProjectId, updateUserPreferences]);

  // ---- links ----
  const { links: runtimeLinks, loaded: linksLoaded, refresh: refreshLinks } = useProjectLinks(client, activeProjectId);
  const [optimistic, setOptimistic] = useState<CanvasLink[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const allLinks = useMemo(() => {
    const ids = new Set(projectSessions.map((session) => session.id));
    const seen = new Set<string>();
    const result: CanvasLink[] = [];
    const add = (link: CanvasLink) => {
      const key = `${link.fromSessionId}>${link.toSessionId}`;
      if (seen.has(key) || link.fromSessionId === link.toSessionId || !ids.has(link.fromSessionId) || !ids.has(link.toSessionId)) return;
      seen.add(key);
      result.push(link);
    };
    for (const link of runtimeLinks) if (!removed.has(link.id)) add(link);
    for (const link of optimistic) add(link);
    // Fallback until the runtime's links load: the recruiting parent is the wire's source.
    if (!linksLoaded) {
      for (const session of projectSessions) {
        if (!session.parentSessionId) continue;
        add({ id: `parent:${session.parentSessionId}>${session.id}`, projectId: activeProjectId ?? "", fromSessionId: session.parentSessionId, toSessionId: session.id, kind: "recruit", createdAt: session.createdAt, lastMessageAt: null, messageCount: 0, synthetic: true });
      }
    }
    return result;
  }, [runtimeLinks, optimistic, removed, linksLoaded, projectSessions, activeProjectId]);
  const linksRef = useRef(allLinks);
  linksRef.current = allLinks;

  const createLink = useCallback(async (from: string, to: string) => {
    if (!client || !activeProjectId) return;
    if (from === to) { toast.info("An agent cannot be linked to itself"); return; }
    if (linksRef.current.some((link) => (link.fromSessionId === from && link.toSessionId === to) || (link.fromSessionId === to && link.toSessionId === from))) {
      toast.info("Already linked", { description: `${titleOf(from)} and ${titleOf(to)} are connected.` });
      return;
    }
    const temp: CanvasLink = { id: `tmp:${from}>${to}`, projectId: activeProjectId, fromSessionId: from, toSessionId: to, kind: "manual", createdAt: new Date().toISOString(), lastMessageAt: null, messageCount: 0, synthetic: true };
    setOptimistic((list) => [...list, temp]);
    try {
      await createLinkRequest(client, from, to);
      await refreshLinks();
    } catch (error) {
      toast.error("Could not link agents", { description: errorMessage(error) });
    } finally {
      setOptimistic((list) => list.filter((link) => link.id !== temp.id));
    }
  }, [client, activeProjectId, refreshLinks, titleOf]);

  const deleteLink = useCallback(async (link: CanvasLink): Promise<boolean> => {
    if (!client) return false;
    if (link.synthetic) { toast.info("This wire is inferred from the recruiting parent and cannot be deleted yet"); return false; }
    setRemoved((set) => new Set(set).add(link.id));
    try {
      await deleteLinkRequest(client, link.id);
      await refreshLinks();
      return true;
    } catch (error) {
      toast.error("Could not delete the link", { description: errorMessage(error) });
      return false;
    } finally {
      setRemoved((set) => { const next = new Set(set); next.delete(link.id); return next; });
    }
  }, [client, refreshLinks]);

  const reverseLink = useCallback(async (link: CanvasLink) => {
    if (await deleteLink(link)) await createLink(link.toSessionId, link.fromSessionId);
  }, [deleteLink, createLink]);

  // ---- live events: pulses, bubbles, activity ----
  const [live, setLive] = useState<Record<string, LiveWire>>({});
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const onFresh = useCallback((event: AgentMessageEvent) => {
    void refreshLinks();
    const link = linksRef.current.find((item) => item.id === event.linkId);
    const key = `${event.linkId}${event.at}${Math.random()}`;
    const preview = event.preview.length > 120 ? `${event.preview.slice(0, 119)}…` : event.preview;
    const reverse = !!link && event.fromSessionId !== link.fromSessionId;
    setLive((current) => {
      const wire = current[event.linkId] ?? { pulses: [], bubbles: [] };
      return { ...current, [event.linkId]: { pulses: [...wire.pulses, { key, reverse }].slice(-3), bubbles: [...wire.bubbles, { key, text: preview, from: titleOf(event.fromSessionId), to: titleOf(event.toSessionId) }].slice(-2) } };
    });
    const drop = (field: "pulses" | "bubbles") => setLive((current) => {
      const wire = current[event.linkId];
      return wire ? { ...current, [event.linkId]: { ...wire, [field]: wire[field].filter((item) => item.key !== key) } } : current;
    });
    setTimeout(() => drop("pulses"), 1600);
    setTimeout(() => drop("bubbles"), 6000);
  }, [refreshLinks, titleOf]);
  const events = useAgentEvents(client, activeProjectId, onFresh);

  // ---- nodes ----
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [forced, setForced] = useState<Set<string>>(new Set());
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const prevHeights = useRef(new Map<string, number>());

  const auto = useMemo(() => {
    const parents = new Map<string, string>();
    for (const link of allLinks) if (!parents.has(link.toSessionId)) parents.set(link.toSessionId, link.fromSessionId);
    return layoutTree(projectSessions.map((session) => ({ id: session.id, parentId: parents.get(session.id) ?? null })));
  }, [allLinks, projectSessions]);

  const buildNodes = useCallback((useSaved: boolean): AgentNode[] => projectSessions.map((session) => {
    const size = (useSaved ? savedRef.current.sizes?.[session.id] : undefined) ?? DEFAULT_NODE_SIZE;
    return {
      id: session.id,
      type: "agent",
      position: (useSaved ? savedRef.current.positions?.[session.id] : undefined) ?? auto[session.id] ?? { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      data: { session },
    };
  }), [projectSessions, auto]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(buildNodes(true));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Session updates refresh node data in place; positions and sizes of existing nodes (dragged, resized or not) are kept.
  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return buildNodes(true).map((node) => {
        const existing = byId.get(node.id);
        return existing ? { ...existing, data: node.data } : node;
      });
    });
  }, [buildNodes, setNodes]);

  // "New agent here": the first session that appears afterwards lands at the clicked spot.
  const pendingRef = useRef<{ x: number; y: number; known: Set<string>; at: number } | null>(null);
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (Date.now() - pending.at > 120_000) { pendingRef.current = null; return; }
    const fresh = projectSessions.find((session) => !pending.known.has(session.id));
    if (!fresh) return;
    pendingRef.current = null;
    setNodes((current) => current.map((node) => node.id === fresh.id ? { ...node, position: { x: pending.x, y: pending.y } } : node));
    persistNode(fresh.id, { position: { x: pending.x, y: pending.y } });
  }, [projectSessions, setNodes, persistNode]);

  // A different project is a different graph: refit once its nodes are in.
  useEffect(() => {
    const frame = requestAnimationFrame(() => void fitView({ duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [activeProjectId, fitView]);

  // ---- live mirror budget: visible, expanded, nearest to the viewport centre, at most MAX_LIVE ----
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const forcedRef = useRef(forced);
  forcedRef.current = forced;
  const computeLive = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { x, y, zoom } = getViewport();
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    const left = -x / zoom, top = -y / zoom, right = (width - x) / zoom, bottom = (height - y) / zoom;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const next = new Set<string>();
    if (zoom >= 0.3) {
      const candidates = nodesRef.current
        .filter((node) => {
          const session = node.data.session;
          if (collapsedRef.current.has(node.id) || session.state === "sleeping") return false;
          const w = node.width ?? DEFAULT_NODE_SIZE.width, h = node.height ?? DEFAULT_NODE_SIZE.height;
          return node.position.x < right && node.position.x + w > left && node.position.y < bottom && node.position.y + h > top;
        })
        .map((node) => ({ id: node.id, distance: Math.hypot(node.position.x + (node.width ?? 0) / 2 - cx, node.position.y + (node.height ?? 0) / 2 - cy) }))
        .sort((a, b) => a.distance - b.distance);
      for (const candidate of candidates.slice(0, MAX_LIVE)) next.add(candidate.id);
    }
    for (const id of forcedRef.current) if (!collapsedRef.current.has(id)) next.add(id);
    setLiveIds((current) => current.size === next.size && [...next].every((id) => current.has(id)) ? current : next);
  }, [getViewport]);
  useOnViewportChange({ onEnd: computeLive });
  useEffect(() => {
    const timer = setTimeout(computeLive, 60);
    return () => clearTimeout(timer);
  }, [projectSessions, collapsed, forced, computeLive]);

  // ---- tools / chrome ----
  const [tool, setTool] = useState<"pan" | "select">("pan");
  const [linkMode, setLinkMode] = useState<{ from: string | null } | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [showActivity, setShowActivity] = useState(false);
  const [activityFilter, setActivityFilter] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<MenuTarget>({ kind: "pane", flow: { x: 0, y: 0 } });
  const [renaming, setRenaming] = useState<{ session: SessionSummary; title: string } | null>(null);

  const edges = useMemo(() => allLinks.map<WireEdge>((link) => ({
    id: link.id,
    type: "wire",
    source: link.fromSessionId,
    target: link.toSessionId,
    data: { link },
    selected: link.id === selectedEdgeId,
    markerEnd: { type: MarkerType.ArrowClosed, color: link.kind === "manual" ? "#71717a" : KIND_COLOR[link.kind], width: 18, height: 18 },
  })), [allLinks, selectedEdgeId]);

  const startLink = useCallback((id: string | null) => { setLinkMode({ from: id }); setSelectedEdgeId(null); }, []);
  const toggleCollapse = useCallback((id: string) => {
    const isCollapsed = collapsedRef.current.has(id);
    setCollapsed((set) => { const next = new Set(set); if (isCollapsed) next.delete(id); else next.add(id); return next; });
    setNodes((current) => current.map((node) => {
      if (node.id !== id) return node;
      if (isCollapsed) return { ...node, height: prevHeights.current.get(id) ?? DEFAULT_NODE_SIZE.height };
      prevHeights.current.set(id, node.height ?? DEFAULT_NODE_SIZE.height);
      return { ...node, height: HEADER_HEIGHT };
    }));
  }, [setNodes]);
  const activate = useCallback((id: string) => setForced((set) => new Set(set).add(id)), []);
  const savePlacement = useCallback((id: string, rect: { x: number; y: number; width: number; height: number }) => {
    persistNode(id, { position: { x: rect.x, y: rect.y }, size: { width: rect.width, height: rect.height } });
    computeLive();
  }, [persistNode, computeLive]);

  const relayout = useCallback(() => {
    if (activeProjectId) {
      const { [activeProjectId]: _positions, ...positions } = prefsRef.current.canvasPositions;
      const { [activeProjectId]: _sizes, ...sizes } = prefsRef.current.canvasSizes;
      prefsRef.current = { ...prefsRef.current, canvasPositions: positions, canvasSizes: sizes };
      updateUserPreferences({ canvasPositions: positions, canvasSizes: sizes });
    }
    savedRef.current = { positions: undefined, sizes: undefined };
    setCollapsed(new Set());
    setNodes(buildNodes(false));
    requestAnimationFrame(() => void fitView({ duration: 200 }));
  }, [activeProjectId, updateUserPreferences, setNodes, buildNodes, fitView]);

  const openNewAgent = useCallback(() => {
    selectProject(activeProjectId, project?.workspaces[0]?.id);
    setNewAgentOpen(true);
  }, [selectProject, activeProjectId, project, setNewAgentOpen]);

  const resize = useCallback((id: string, preset: SizePreset) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    let size = preset === "fit" ? { width: 560, height: 0 } : SIZE_PRESETS[preset];
    if (preset === "fit") {
      const { cols, rows } = node.data.session;
      size.height = HEADER_HEIGHT + size.width * ((rows || 30) * 2) / (cols || 120);
    }
    size = { width: clamp(size.width, MIN_SIZE.width, MAX_SIZE.width), height: clamp(size.height, MIN_SIZE.height, MAX_SIZE.height) };
    setCollapsed((set) => { const next = new Set(set); next.delete(id); return next; });
    setNodes((current) => current.map((item) => item.id === id ? { ...item, ...size } : item));
    persistNode(id, { size });
  }, [setNodes, persistNode]);

  const bringToFront = useCallback((id: string) => {
    const top = Math.max(0, ...nodesRef.current.map((node) => node.zIndex ?? 0)) + 1;
    setNodes((current) => current.map((node) => node.id === id ? { ...node, zIndex: top } : node));
  }, [setNodes]);

  const selectNodes = useCallback((ids: Set<string> | "all") => {
    setNodes((current) => current.map((node) => ({ ...node, selected: ids === "all" || ids.has(node.id) })));
  }, [setNodes]);

  const focusNodes = useCallback((ids: string[]) => {
    void fitView({ nodes: ids.map((id) => ({ id })), duration: 300, padding: 0.3, maxZoom: 1 });
  }, [fitView]);

  async function submitRename() {
    if (!renaming || !client) return;
    const title = renaming.title.trim();
    const target = renaming.session;
    setRenaming(null);
    if (!title || title === target.title) return;
    try { upsertSession(await client.renameSession(target.id, title)); }
    catch (error) { toast.error("Could not rename the agent", { description: errorMessage(error) }); }
  }

  const menuApi: MenuApi = {
    sessionById,
    linkById: (id) => allLinks.find((link) => link.id === id),
    linksOf: (id) => allLinks.filter((link) => link.fromSessionId === id || link.toSessionId === id),
    titleOf,
    collapsed: (id) => collapsed.has(id),
    hasMirrorText: (id) => getMirrorText(id) !== null,
    showMiniMap,
    showActivity,
    linkMode: linkMode !== null,
    newAgentHere: (flow) => {
      pendingRef.current = { x: flow.x, y: flow.y, known: new Set(projectSessions.map((session) => session.id)), at: Date.now() };
      openNewAgent();
    },
    toggleLinkMode: () => setLinkMode((mode) => mode ? null : { from: null }),
    relayout,
    fit: () => void fitView({ duration: 200 }),
    selectAll: () => selectNodes("all"),
    toggleMiniMap: () => setShowMiniMap((value) => !value),
    toggleActivity: () => setShowActivity((value) => !value),
    resetZoom: () => void zoomTo(1, { duration: 200 }),
    focus,
    startLink,
    rename: (session) => setRenaming({ session, title: session.title }),
    resume: async (session) => {
      if (!client) return;
      try { upsertSession(await client.resumeSession(session.id)); }
      catch (error) { toast.error("Could not resume the agent", { description: errorMessage(error) }); }
    },
    copyId: (id) => void copyText(id).then(() => toast.success("Session id copied"), (error) => toast.error("Could not copy", { description: errorMessage(error) })),
    copyOutput: (id) => {
      const text = getMirrorText(id);
      if (!text) return;
      void copyText(text).then(() => toast.success("Last output copied"), (error) => toast.error("Could not copy", { description: errorMessage(error) }));
    },
    toggleCollapse,
    resize,
    bringToFront,
    hide: (session) => {
      updateUserPreferences({ hiddenSessionIds: { ...prefsRef.current.hiddenSessionIds, [session.id]: true } });
      closeTab(session.id, "agent");
    },
    deleteLink: (link) => void deleteLink(link),
    reverseLink: (link) => void reverseLink(link),
    showWire: (link) => { setActivityFilter(link.id); setShowActivity(true); },
  };

  const ctx: CanvasCtxValue = {
    liveIds, collapsed, linkMode, live, reducedMotion, titleOf, focus, startLink, toggleCollapse, activate, savePlacement,
    deleteLink: (link) => void deleteLink(link),
  };

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target) void createLink(connection.source, connection.target);
  }, [createLink]);

  const isValidConnection = useCallback((connection: { source: string; target: string }) => connection.source !== connection.target, []);

  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    if (event.key === "Escape") { setLinkMode(null); setSelectedEdgeId(null); return; }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedEdgeId) {
      const link = linksRef.current.find((item) => item.id === selectedEdgeId);
      if (link) void deleteLink(link);
      setSelectedEdgeId(null);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === "a") { event.preventDefault(); selectNodes("all"); }
      return;
    }
    if (event.altKey) return;
    if (event.key.toLowerCase() === "l") setLinkMode((mode) => mode ? null : { from: null });
    else if (event.key.toLowerCase() === "f") void fitView({ duration: 200 });
  }

  if (projectSessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <IconTopologyStar3 size={28} stroke={1.5} />
        <p className="text-sm font-medium text-foreground">{projectName} has no agents yet</p>
        <p className="text-xs">Start an agent and the sessions it recruits will appear here.</p>
        <Button type="button" size="sm" className="mt-1" disabled={!activeProjectId} onClick={openNewAgent}>
          <IconPlus size={14} />
          New agent
        </Button>
      </div>
    );
  }

  const toolButton = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode) => (
    <Button type="button" variant={active ? "secondary" : "ghost"} size="icon-sm" aria-label={label} aria-pressed={active} title={label} onClick={onClick}>{icon}</Button>
  );

  return (
    <CanvasCtx.Provider value={ctx}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={wrapRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onContextMenuCapture={(event) => setMenuTarget({ kind: "pane", flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }) })}
            className={cn("size-full outline-none", linkMode && "[&_.react-flow__pane]:cursor-crosshair")}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={(_, node) => { persistNode(node.id, { position: { x: node.position.x, y: node.position.y } }); computeLive(); }}
              onNodeDoubleClick={(_, node) => focus((node as AgentNode).data.session)}
              onNodeClick={(_, node) => {
                setSelectedEdgeId(null);
                if (!linkMode) return;
                if (linkMode.from === null) setLinkMode({ from: node.id });
                else if (linkMode.from !== node.id) { void createLink(linkMode.from, node.id); setLinkMode(null); }
              }}
              onNodeContextMenu={(_, node) => { setMenuTarget({ kind: "node", id: node.id }); setSelectedEdgeId(null); selectNodes(new Set([node.id])); }}
              onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); selectNodes(new Set()); }}
              onEdgeContextMenu={(_, edge) => { setMenuTarget({ kind: "edge", id: edge.id }); setSelectedEdgeId(edge.id); selectNodes(new Set()); }}
              onPaneClick={() => setSelectedEdgeId(null)}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={40}
              connectionLineStyle={{ stroke: "#8b5cf6", strokeWidth: 2.5, strokeDasharray: "6 4" }}
              nodesConnectable
              edgesFocusable={false}
              deleteKeyCode={null}
              selectionOnDrag={tool === "select"}
              panOnDrag={tool === "select" ? [1] : true}
              onlyRenderVisibleElements
              fitView
              minZoom={0.1}
              colorMode={resolvedTheme === "dark" ? "dark" : "light"}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} />
              <Controls showInteractive={false} />
              {showMiniMap && <MiniMap pannable zoomable className="bg-card!" />}

              <Panel position="top-left" className="flex items-center gap-2">
                <span className="max-w-60 truncate rounded-md border border-border bg-card px-2.5 py-1 text-sm font-medium" title={project?.cwd}>{projectName}</span>
                <Button type="button" variant="outline" size="sm" onClick={openNewAgent}>
                  <IconPlus size={14} />
                  New agent
                </Button>
              </Panel>

              <Panel position="top-center" className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-md">
                {toolButton(tool === "select", "Select (drag to box-select)", () => setTool("select"), <IconPointer size={16} />)}
                {toolButton(tool === "pan", "Pan (drag to move canvas)", () => setTool("pan"), <IconHandStop size={16} />)}
                <span className="mx-1 h-5 w-px bg-border" />
                {toolButton(linkMode !== null, "Link mode (L)", () => setLinkMode((mode) => mode ? null : { from: null }), <IconLink size={16} />)}
                {toolButton(false, "Re-layout", relayout, <IconLayoutDistributeHorizontal size={16} />)}
                {toolButton(false, "Fit view (F)", () => void fitView({ duration: 200 }), <IconArrowsMaximize size={16} />)}
                <span className="mx-1 h-5 w-px bg-border" />
                {toolButton(showMiniMap, "Mini map", () => setShowMiniMap((value) => !value), <IconMap size={16} />)}
                {toolButton(showActivity, "Activity", () => { setActivityFilter(null); setShowActivity((value) => !value); }, <IconActivity size={16} />)}
              </Panel>

              {linkMode && (
                <Panel position="bottom-center" className="flex items-center gap-2 rounded-lg border border-violet-500/60 bg-card px-3 py-1.5 text-xs shadow-md">
                  <IconLink size={14} className="text-violet-500" />
                  {linkMode.from ? `Click another agent to connect it to ${titleOf(linkMode.from)}` : "Click the agent to link from, then the one to link to"}
                  <span className="text-muted-foreground">· Esc to cancel</span>
                  <Button type="button" variant="ghost" size="xs" onClick={() => setLinkMode(null)}>Cancel</Button>
                </Panel>
              )}

              {showActivity && (
                <ActivityPanel
                  events={events}
                  titleOf={titleOf}
                  filterLinkId={activityFilter}
                  onClearFilter={() => setActivityFilter(null)}
                  onSelect={(event) => { focusNodes([event.fromSessionId, event.toSessionId].filter((id) => sessionById(id))); setSelectedEdgeId(event.linkId); }}
                  onClose={() => setShowActivity(false)}
                />
              )}
            </ReactFlow>
          </div>
        </ContextMenuTrigger>
        <CanvasMenuContent target={menuTarget} api={menuApi} />
      </ContextMenu>

      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename agent</DialogTitle></DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void submitRename(); }} className="flex flex-col gap-3">
            <Input autoFocus value={renaming?.title ?? ""} maxLength={120} onChange={(event) => setRenaming((current) => current && { ...current, title: event.target.value })} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" disabled={!renaming?.title.trim()}>Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </CanvasCtx.Provider>
  );
}

export default function AgentCanvasPage() {
  return (
    <ReactFlowProvider>
      <AgentCanvas />
    </ReactFlowProvider>
  );
}
