import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useOnViewportChange,
  useReactFlow,
  useStore,
  useViewport,
  type Connection,
  type FitViewOptions,
  type Node,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  IconActivity, IconArrowsMaximize, IconHandStop, IconNote, IconNotes, IconKey, IconLayoutDistributeHorizontal, IconLink, IconFocus2, IconMinus, IconPlayerPlay, IconPlus, IconPointer, IconX, IconTopologyStar3,
} from "@tabler/icons-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { CrossProjectWires } from "./cross-project-wires";
import { cn } from "cn";
import { ProjectMark } from "@/components/projects/project-identity";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { copyText } from "@/lib/clipboard";
import { errorMessage, useRuntime } from "@/lib/runtime/store";
import { recruitCounts, setOrchestrator } from "@/lib/runtime/orchestrator";
import type { SessionSummary } from "@/lib/runtime/types";
import AgentNodeCard, { HEADER_HEIGHT, MAX_SIZE, MIN_SIZE, type AgentNode } from "./agent-node";
import ActivityPanel from "./activity-panel";
import { Keys } from "./canvas-kbd";
import KeychainDialog from "./keychain-dialog";
import VaultPopover from "./vault-popover";
import { KC_DEFAULT, KC_AMBER, KC_PREFIX, KeychainProvider, KeychainWireCtx, isKeychainId, isKeychainLinkId, kcLinkId, keychainEdgeTypes, keychainNodeTypes, useCanvasKeychains, type KeychainWireEdge } from "./canvas-keychains";
import { NOTE_DEFAULT, NOTE_PREFIX, NOTE_TEAL, NoteProvider, NoteWireCtx, isNoteId, isNoteLinkId, noteEdgeTypes, noteLinkId, noteNodeTypes, useCanvasNotes, type NoteWireEdge } from "./canvas-notes";
import CanvasComposer from "./canvas-composer";
import TerminalDialog from "./terminal-dialog";
import { sendToTargets, type Attachment } from "./canvas-send";
import CanvasMenuContent, { type MenuApi, type MenuTarget, type SizePreset } from "./canvas-menu";
import { CanvasCtx, type CanvasCtxValue, type LiveWire } from "./canvas-context";
import { takeKeychainFocus, createLinkRequest, deleteLinkRequest, useAgentEvents, useProjectLinks, type AgentMessageEvent, type CanvasLink } from "./canvas-data";
import { DEFAULT_NODE_SIZE, layoutFloors } from "./layout";
import FloorBands, { type FloorInfo } from "./floor-band";
import BranchSwitcher from "./branch-switcher";
import { sessionsForWorkspace } from "@/lib/runtime/projects";
import { getMirrorText } from "./session-mirror";
import WireEdgeView, { anchor, KIND_COLOR, type WireEdge } from "./wire-edge";
import { setCanvasSidebarSession } from "@/lib/right-sidebar";

const NO_PROJECT_MARK = { imageUrl: null, gitUrl: null } as const;

// Defined once outside the components so React Flow does not remount nodes/edges on every render.
const nodeTypes = { agent: AgentNodeCard, ...noteNodeTypes, ...keychainNodeTypes };
const edgeTypes = { wire: WireEdgeView, ...keychainEdgeTypes, ...noteEdgeTypes };
const MAX_LIVE = 8;
const SIZE_PRESETS: Record<Exclude<SizePreset, "fit">, { width: number; height: number }> = {
  small: { width: 360, height: 220 },
  medium: DEFAULT_NODE_SIZE,
  large: { width: 860, height: 540 },
};

function ShortcutTip({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}{keys && <Keys keys={keys} className="ml-2 pl-0" />}</TooltipContent>
    </Tooltip>
  );
}

/** Replaces React Flow's <Controls>: zoom out, live percentage (click = 100%), zoom in, fit view. */
function CanvasControls() {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const button = "size-6 rounded-lg";
  return (
    <Panel position="bottom-left" className="canvas-zoom m-2! flex h-8 items-center gap-0.5 rounded-[10px] border border-[var(--canvas-card-border,var(--border))] bg-card/90 px-1 text-foreground shadow-[var(--shadow-elev-1)]">
      <ShortcutTip label="Zoom out" keys="Ctrl -">
        <Button type="button" variant="ghost" size="icon-sm" className={button} aria-label="Zoom out" disabled={zoom <= minZoom + 0.001} onClick={() => void zoomOut({ duration: 200 })}><IconMinus size={14} /></Button>
      </ShortcutTip>
      <ShortcutTip label="Reset zoom to 100%" keys="Ctrl 0">
        <Button type="button" variant="ghost" size="sm" className="h-6 min-w-10 rounded-lg px-1 text-xs tabular-nums" aria-label="Reset zoom to 100%" onClick={() => void zoomTo(1, { duration: 200 })}>{Math.round(zoom * 100)}%</Button>
      </ShortcutTip>
      <ShortcutTip label="Zoom in" keys="Ctrl +">
        <Button type="button" variant="ghost" size="icon-sm" className={button} aria-label="Zoom in" disabled={zoom >= maxZoom - 0.001} onClick={() => void zoomIn({ duration: 200 })}><IconPlus size={14} /></Button>
      </ShortcutTip>
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
      <ShortcutTip label="Fit view" keys="F">
        <Button type="button" variant="ghost" size="icon-sm" className={button} aria-label="Fit view" onClick={() => void fitView({ padding: 0.2, duration: 300 })}><IconFocus2 size={14} /></Button>
      </ShortcutTip>
    </Panel>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const UNASSIGNED_FLOOR = "__unassigned__";

function AgentCanvas() {
  // Single canvas theme switch: follows the app theme (light/dark/system resolved by next-themes).
  const { resolvedTheme } = useTheme();
  const canvasTheme: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark";
  const {
    sessions, deleteSessions, projects, canvasProjectId, selectProject, setNewAgentOpen, activateSession, navigate, userPreferences, updateUserPreferences,
    client, upsertSession, canvasFocus, consumeCanvasFocus, refreshProjects,
  } = useRuntime();
  const { fitView, getViewport, setViewport, zoomTo, zoomIn, zoomOut, screenToFlowPosition } = useReactFlow();
  // Fit options: with floors, leave room above the top band's label for the floating toolbar. Updated once the floors are known.
  const fitOptsRef = useRef<FitViewOptions>({});
  // The canvas is always bound to the project it was opened for, never to a possibly-null active project.
  const activeProjectId = canvasProjectId;
  const project = projects.find((item) => item.id === activeProjectId);
  const projectName = project ? project.displayName?.trim() || project.name : "Project";
  const wrapRef = useRef<HTMLDivElement>(null);

  // Each branch has its own canvas: ground-workspace sessions tagged with another branch are hidden (untagged ones belong to the current branch).
  const groundWorkspace = useMemo(() => project?.workspaces.find((workspace) => workspace.cwd === project.cwd), [project?.workspaces, project?.cwd]);
  const currentBranch = groundWorkspace?.branch || null;
  const branchTags = activeProjectId ? userPreferences.canvasBranchSessions[activeProjectId] : undefined;
  const projectSessions = useMemo(() => {
    if (!activeProjectId) return [];
    const all = sessions.filter((session) => session.projectId === activeProjectId);
    if (!groundWorkspace || !currentBranch || !branchTags) return all;
    const hidden = new Set<string>();
    for (const session of sessionsForWorkspace(activeProjectId, groundWorkspace, all)) {
      const tag = branchTags[session.id];
      if (tag && tag.branch !== currentBranch) hidden.add(session.id);
    }
    return hidden.size ? all.filter((session) => !hidden.has(session.id)) : all;
  }, [sessions, activeProjectId, groundWorkspace, currentBranch, branchTags]);
  const sessionById = useCallback((id: string) => projectSessions.find((session) => session.id === id), [projectSessions]);
  const titleOf = useCallback((id: string) => sessionById(id)?.title ?? "agent", [sessionById]);

  // The terminal opens in a dialog on the canvas; `focus` (full view) is the old navigation, kept for the dialog's "Open in full view".
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composerFocus = useRef<(() => void) | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const markSent = useCallback((ids: string[], _preview: string) => {
    setSentIds((current) => new Set([...current, ...ids]));
    setTimeout(() => setSentIds((current) => { const next = new Set(current); for (const id of ids) next.delete(id); return next; }), 1600);
  }, []);

  const focus = useCallback((session: SessionSummary) => {
    activateSession(session, "agent");
    navigate("session", session.id);
  }, [activateSession, navigate]);

  const openTerminal = useCallback((session: SessionSummary) => setTerminalId(session.id), []);

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

  const persistMany = useCallback((positions: Record<string, { x: number; y: number }>) => {
    if (!activeProjectId) return;
    const prefs = prefsRef.current;
    const next = { canvasPositions: { ...prefs.canvasPositions, [activeProjectId]: { ...prefs.canvasPositions[activeProjectId], ...positions } } };
    prefsRef.current = { ...prefs, ...next };
    updateUserPreferences(next);
  }, [activeProjectId, updateUserPreferences]);

  // The viewport is saved shortly after each move and flushed on unmount / page hide, so reopening restores what the user saw.
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewportPending = useRef<{ projectId: string; view: { x: number; y: number; zoom: number } } | null>(null);
  const flushViewport = useCallback(() => {
    clearTimeout(viewportTimer.current);
    const pending = viewportPending.current;
    viewportPending.current = null;
    if (!pending) return;
    const prefs = prefsRef.current;
    const next = { canvasViewports: { ...prefs.canvasViewports, [pending.projectId]: pending.view } };
    prefsRef.current = { ...prefs, ...next };
    updateUserPreferences(next);
  }, [updateUserPreferences]);
  const saveViewport = useCallback((view: { x: number; y: number; zoom: number }) => {
    if (!activeProjectId) return;
    viewportPending.current = { projectId: activeProjectId, view };
    clearTimeout(viewportTimer.current);
    viewportTimer.current = setTimeout(flushViewport, 300);
  }, [activeProjectId, flushViewport]);
  useEffect(() => {
    window.addEventListener("pagehide", flushViewport);
    return () => { window.removeEventListener("pagehide", flushViewport); flushViewport(); };
  }, [flushViewport]);
  const savedViewport = activeProjectId ? userPreferences.canvasViewports[activeProjectId] : undefined;
  const savedViewportRef = useRef(savedViewport);
  savedViewportRef.current = savedViewport;

  // ---- notes ----
  const keychains = useCanvasKeychains(client, activeProjectId, titleOf);

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
    } catch (error) {
      // Roll back the optimistic removal only when the server did not delete it.
      setRemoved((set) => { const next = new Set(set); next.delete(link.id); return next; });
      toast.error("Could not delete the link", { description: errorMessage(error) });
      return false;
    }
    // Keep the id hidden: an in-flight poll that started before the delete must not resurrect the wire.
    try { await refreshLinks(); } catch { /* the poll will catch up */ }
    return true;
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

  // Floors: one per git workspace. Ground floor = the main checkout (workspace cwd === project cwd); sessions matching no workspace sit on an "Unassigned" floor on top.
  const orderedWorkspaces = useMemo(() => {
    const workspaces = project?.workspaces ?? [];
    const ground = workspaces.find((workspace) => workspace.cwd === project?.cwd);
    return ground ? [ground, ...workspaces.filter((workspace) => workspace !== ground)] : workspaces;
  }, [project?.workspaces, project?.cwd]);
  const groundWorkspaceId = orderedWorkspaces.find((workspace) => workspace.cwd === project?.cwd)?.id;
  const floorOf = useMemo(() => {
    const map = new Map<string, string>();
    if (!activeProjectId || orderedWorkspaces.length === 0) return map;
    for (const workspace of [...orderedWorkspaces].reverse()) {
      for (const session of sessionsForWorkspace(activeProjectId, workspace, projectSessions)) map.set(session.id, workspace.id);
    }
    for (const session of projectSessions) if (!map.has(session.id)) map.set(session.id, UNASSIGNED_FLOOR);
    return map;
  }, [orderedWorkspaces, projectSessions, activeProjectId]);
  const floorOrder = useMemo(() => [...orderedWorkspaces.map((workspace) => workspace.id), UNASSIGNED_FLOOR], [orderedWorkspaces]);
  const floorFallback = UNASSIGNED_FLOOR;

  const auto = useMemo(() => {
    const parents = new Map<string, string>();
    for (const link of allLinks) if (!parents.has(link.toSessionId)) parents.set(link.toSessionId, link.fromSessionId);
    const linkedIds = new Set<string>();
    for (const link of allLinks) { linkedIds.add(link.fromSessionId); linkedIds.add(link.toSessionId); }
    return layoutFloors(projectSessions.map((session) => ({ id: session.id, floorId: floorOf.get(session.id) ?? floorFallback, parentId: parents.get(session.id) ?? null, linked: linkedIds.has(session.id) || !!session.parentSessionId })), floorOrder).positions;
  }, [allLinks, projectSessions, floorOf, floorOrder, floorFallback]);

  const buildNodes = useCallback((useSaved: boolean): AgentNode[] => {
    const saved = useSaved ? savedRef.current.positions : undefined;
    const rects = new Map<string, { x: number; y: number; bottom: number }[]>();
    const size = (id: string) => (useSaved ? savedRef.current.sizes?.[id] : undefined) ?? DEFAULT_NODE_SIZE;
    for (const session of projectSessions) {
      const at = saved?.[session.id];
      if (!at) continue;
      const floor = floorOf.get(session.id) ?? floorFallback;
      rects.set(floor, [...(rects.get(floor) ?? []), { x: at.x, y: at.y, bottom: at.y + size(session.id).height }]);
    }
    return projectSessions.map((session) => {
      const { width, height } = size(session.id);
      let position = saved?.[session.id];
      if (!position) {
        // New agent: land inside its own floor, under that floor's existing agents, rather than at the global auto slot.
        const floor = floorOf.get(session.id) ?? floorFallback;
        const peers = rects.get(floor);
        if (useSaved && peers?.length) {
          position = { x: Math.min(...peers.map((peer) => peer.x)), y: Math.max(...peers.map((peer) => peer.bottom)) + 80 };
          rects.set(floor, [...peers, { x: position.x, y: position.y, bottom: position.y + height }]);
        } else position = auto[session.id] ?? { x: 0, y: 0 };
      }
      return { id: session.id, type: "agent", position, width, height, data: { session } } as AgentNode;
    });
  }, [projectSessions, auto, floorOf, floorFallback]);

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(buildNodes(true));
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const notes = useCanvasNotes(client, activeProjectId, titleOf, {
    ready: linksLoaded,
    occupied: () => [
      ...nodesRef.current.map((node) => ({ x: node.position.x, y: node.position.y, w: node.width ?? node.measured?.width ?? 360, h: node.height ?? node.measured?.height ?? 220 })),
      ...keychains.nodes.map((node) => ({ x: node.position.x, y: node.position.y, w: node.width ?? KC_DEFAULT.width, h: node.height ?? KC_DEFAULT.height })),
      ...notesNodesRef.current.filter((node) => node.data.note.placed !== false).map((node) => ({ x: node.position.x, y: node.position.y, w: node.width ?? NOTE_DEFAULT.width, h: node.height ?? NOTE_DEFAULT.height })),
    ],
    agentRect: (sessionId) => {
      const node = nodesRef.current.find((item) => item.id === sessionId);
      return node ? { x: node.position.x, y: node.position.y, w: node.width ?? node.measured?.width ?? 360, h: node.height ?? node.measured?.height ?? 220 } : undefined;
    },
    reveal: (nodeId) => void fitView({ nodes: [{ id: nodeId }], duration: 300, padding: 0.6, maxZoom: 1 }),
  });
  const notesNodesRef = useRef(notes.nodes);
  notesNodesRef.current = notes.nodes;
  useEffect(() => {
    const selectedId = nodes.find((node) => node.selected && projectSessions.some((session) => session.id === node.id))?.id ?? null;
    setCanvasSidebarSession(selectedId);
  }, [nodes, projectSessions]);
  useEffect(() => () => setCanvasSidebarSession(null), []);

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

  // Agents without a saved position get their computed one persisted once (after links settled), so they never jump on the next open.
  useEffect(() => {
    if (!linksLoaded || !activeProjectId) return;
    const fresh: Record<string, { x: number; y: number }> = {};
    for (const node of nodesRef.current) if (!savedRef.current.positions?.[node.id]) fresh[node.id] = { x: node.position.x, y: node.position.y };
    if (Object.keys(fresh).length) persistMany(fresh);
  }, [nodes, linksLoaded, activeProjectId, persistMany]);

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
    const frame = requestAnimationFrame(() => {
      const saved = savedViewportRef.current;
      if (saved) void setViewport(saved);
      else void fitView({ duration: 200, ...fitOptsRef.current });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeProjectId, fitView, setViewport]);

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
    markerEnd: { type: MarkerType.ArrowClosed, color: link.id === selectedEdgeId ? "var(--primary-text)" : KIND_COLOR[link.kind], width: 18, height: 18 },
  })), [allLinks, selectedEdgeId]);

  const kcEdges = useMemo(() => {
    const ids = new Set(projectSessions.map((session) => session.id));
    return keychains.keychains.flatMap((kc) => kc.linkedSessionIds.filter((sid) => ids.has(sid)).map<KeychainWireEdge>((sid) => ({
      id: kcLinkId(kc.id, sid),
      type: "keychain-wire",
      source: KC_PREFIX + kc.id,
      target: sid,
      data: { keychainId: kc.id, sessionId: sid, name: kc.name },
      selected: kcLinkId(kc.id, sid) === selectedEdgeId,
      markerEnd: { type: MarkerType.ArrowClosed, color: KC_AMBER, width: 16, height: 16 },
    })));
  }, [keychains.keychains, projectSessions, selectedEdgeId]);
  const noteEdges = useMemo(() => {
    const ids = new Set(projectSessions.map((session) => session.id));
    return notes.notes.flatMap((note) => note.linkedSessionIds.filter((sid) => ids.has(sid)).map<NoteWireEdge>((sid) => ({
      id: noteLinkId(note.id, sid),
      type: "note-wire",
      source: NOTE_PREFIX + note.id,
      target: sid,
      data: { noteId: note.id, sessionId: sid },
      selected: noteLinkId(note.id, sid) === selectedEdgeId,
      markerEnd: { type: MarkerType.ArrowClosed, color: NOTE_TEAL, width: 16, height: 16 },
    })));
  }, [notes.notes, projectSessions, selectedEdgeId]);
  const allEdges = useMemo(() => [...edges, ...kcEdges, ...noteEdges] as Edge[], [edges, kcEdges, noteEdges]);
  const hotIds = useMemo(() => {
    const edge = allEdges.find((item) => item.id === (hoverEdgeId ?? selectedEdgeId));
    return edge ? new Set([edge.source, edge.target]) : new Set<string>();
  }, [allEdges, hoverEdgeId, selectedEdgeId]);
  const noteCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const note of notes.notes) for (const sid of note.linkedSessionIds) counts[sid] = (counts[sid] ?? 0) + 1;
    return counts;
  }, [notes.notes]);
  const keychainCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const kc of keychains.keychains) for (const sid of kc.linkedSessionIds) counts[sid] = (counts[sid] ?? 0) + 1;
    return counts;
  }, [keychains.keychains]);

  // Focus requested from the Secrets screen ("Open on canvas").
  useEffect(() => {
    const id = takeKeychainFocus((value) => keychains.keychains.some((kc) => kc.id === value));
    if (!id) return;
    keychains.onNodesChange([{ type: "select", id: KC_PREFIX + id, selected: true }]);
    setTimeout(() => void fitView({ nodes: [{ id: KC_PREFIX + id }], duration: 300, padding: 0.5, maxZoom: 1 }), 120);
  }, [keychains.keychains]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ---- wake sleeping agents ----
  const [waking, setWaking] = useState<Set<string>>(new Set());
  const wakingRef = useRef(waking);
  const wake = useCallback(async (session: SessionSummary): Promise<void> => {
    if (!client || wakingRef.current.has(session.id)) return;
    wakingRef.current = new Set(wakingRef.current).add(session.id);
    setWaking(wakingRef.current);
    try { upsertSession(await client.resumeSession(session.id)); }
    catch (error) { toast.error(`Could not ${session.state === "sleeping" ? "wake" : "restart"} ${session.title}`, { description: errorMessage(error) }); }
    finally {
      const next = new Set(wakingRef.current);
      next.delete(session.id);
      wakingRef.current = next;
      setWaking(next);
    }
  }, [client, upsertSession]);
  const sleepingCount = projectSessions.filter((session) => session.state === "sleeping").length;
  const wakeAll = useCallback(async () => {
    const queue = projectSessions.filter((session) => session.state === "sleeping");
    if (queue.length === 0) return;
    if (queue.length > 5 && !window.confirm(`Wake ${queue.length} sleeping agents?`)) return;
    const worker = async () => { for (let next = queue.shift(); next; next = queue.shift()) await wake(next); };
    await Promise.all([worker(), worker()]);
  }, [projectSessions, wake]);

  const sendMessage = useCallback(async (session: SessionSummary, text: string, attachments: Attachment[], onProgress: (id: string, fraction: number) => void) => {
    if (!client) return false;
    const result = await sendToTargets({ client, targets: [session], text, attachments, wake, getSession: (id) => sessionsRef.current.find((item) => item.id === id), onProgress });
    if (result.delivered.length) markSent(result.delivered, text);
    return result.delivered.length > 0;
  }, [client, wake, markSent]);

  const recruits = useMemo(
    () => recruitCounts(projectSessions, allLinks.filter((link) => link.kind === "recruit").map((link) => ({ from: link.fromSessionId, to: link.toSessionId }))),
    [projectSessions, allLinks],
  );

  const linkInfo = useMemo(() => {
    const info: CanvasCtxValue["linkInfo"] = {};
    const rects = new Map(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y, width: node.width ?? DEFAULT_NODE_SIZE.width, height: node.height ?? DEFAULT_NODE_SIZE.height }]));
    const touch = (id: string, side: string) => { const entry = (info[id] ??= { count: 0, sides: new Set() }); entry.count += 1; entry.sides.add(side); };
    for (const link of allLinks) {
      const a = rects.get(link.fromSessionId), b = rects.get(link.toSessionId);
      if (!a || !b) continue;
      touch(link.fromSessionId, anchor(a, b).position);
      touch(link.toSessionId, anchor(b, a).position);
    }
    return info;
  }, [nodes, allLinks]);

  // Re-layout changes POSITIONS only: sizes and collapsed state stay, and the result is persisted for every agent right away.
  const relayout = useCallback(() => {
    const current = nodesRef.current;
    const widest = current.reduce((max, node) => Math.max(max, node.width ?? DEFAULT_NODE_SIZE.width), DEFAULT_NODE_SIZE.width);
    const tallest = current.reduce((max, node) => Math.max(max, node.height ?? DEFAULT_NODE_SIZE.height), DEFAULT_NODE_SIZE.height);
    const parents = new Map<string, string>();
    for (const link of linksRef.current) if (!parents.has(link.toSessionId)) parents.set(link.toSessionId, link.fromSessionId);
    const linkedIds = new Set<string>();
    for (const link of linksRef.current) { linkedIds.add(link.fromSessionId); linkedIds.add(link.toSessionId); }
    const layout = layoutFloors(current.map((node) => ({ id: node.id, floorId: floorOf.get(node.id) ?? floorFallback, parentId: parents.get(node.id) ?? null, linked: linkedIds.has(node.id) || !!node.data.session.parentSessionId })), floorOrder, { width: widest, height: tallest }).positions;
    savedRef.current = { ...savedRef.current, positions: { ...savedRef.current.positions, ...layout } };
    setNodes((items) => items.map((node) => layout[node.id] ? { ...node, position: layout[node.id] } : node));
    persistMany(layout);
    requestAnimationFrame(() => void fitView({ duration: 200, ...fitOptsRef.current }));
  }, [setNodes, persistMany, fitView, floorOf, floorOrder, floorFallback]);

  // ---- branch canvases ----
  type BranchTag = { branch: string; resume?: boolean };
  const writeBranchTags = useCallback((projectId: string, update: (tags: Record<string, BranchTag>) => Record<string, BranchTag>) => {
    const prefs = prefsRef.current;
    const next = { canvasBranchSessions: { ...prefs.canvasBranchSessions, [projectId]: update({ ...prefs.canvasBranchSessions[projectId] }) } };
    prefsRef.current = { ...prefs, ...next };
    updateUserPreferences(next);
  }, [updateUserPreferences]);

  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);

  // Untagged ground sessions belong to the branch checked out now; tag them once so a later switch can tell them apart.
  useEffect(() => {
    if (!activeProjectId || !groundWorkspace || !currentBranch || switchingRef.current) return;
    const tags = prefsRef.current.canvasBranchSessions[activeProjectId] ?? {};
    const untagged = sessionsForWorkspace(activeProjectId, groundWorkspace, sessions.filter((session) => session.projectId === activeProjectId)).filter((session) => !tags[session.id]);
    if (untagged.length === 0) return;
    writeBranchTags(activeProjectId, (current) => {
      for (const session of untagged) current[session.id] ??= { branch: currentBranch };
      return current;
    });
  }, [sessions, activeProjectId, groundWorkspace, currentBranch, branchTags, writeBranchTags]);

  // Branches held by other worktrees cannot be checked out in the main checkout.
  const inWorktreeBranches = useMemo(
    () => new Set(orderedWorkspaces.filter((workspace) => workspace.id !== groundWorkspaceId && workspace.branch).map((workspace) => workspace.branch as string)),
    [orderedWorkspaces, groundWorkspaceId],
  );
  const loadBranches = useCallback(async () => {
    if (!client || !activeProjectId || !groundWorkspaceId) throw new Error("The runtime is not connected");
    return client.projectBranches(activeProjectId, groundWorkspaceId);
  }, [client, activeProjectId, groundWorkspaceId]);

  const switchBranch = async (target: string) => {
    const projectId = activeProjectId;
    const leaving = currentBranch;
    if (!client || !projectId || !groundWorkspace || !leaving || target === leaving || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    const isRunning = (session: SessionSummary) => session.state === "running" || session.state === "starting";
    const projectAll = () => sessionsRef.current.filter((session) => session.projectId === projectId);
    const groundIds = new Set(sessionsForWorkspace(projectId, groundWorkspace, projectSessions).map((session) => session.id));
    const wasRunning = new Set(projectAll().filter(isRunning).map((session) => session.id));

    // a. Remember which branch each visible ground agent belongs to, and which ones were live.
    writeBranchTags(projectId, (tags) => {
      for (const id of groundIds) tags[id] = wasRunning.has(id) ? { branch: leaving, resume: true } : { branch: leaving };
      return tags;
    });

    const slept: SessionSummary[] = [];
    const resumeOne = async (session: SessionSummary): Promise<boolean> => {
      try { upsertSession(await client.resumeSession(session.id)); return true; }
      catch (error) { toast.error(`Could not wake ${session.title}`, { description: errorMessage(error) }); return false; }
    };
    try {
      // b. Sleep every live agent of the project (the server refuses to switch otherwise).
      for (const session of projectAll().filter(isRunning)) {
        const updated = await client.sleepSession(session.id);
        slept.push(session);
        upsertSession(updated);
      }
      // c. Check the branch out.
      await client.switchProjectBranch(projectId, groundWorkspace.id, target);
      await refreshProjects(true);
    } catch (error) {
      for (const session of slept) await resumeOne(session);
      writeBranchTags(projectId, (tags) => {
        for (const id of groundIds) if (tags[id]) tags[id] = { branch: tags[id].branch };
        return tags;
      });
      toast.error(`Could not switch to ${target}`, { description: errorMessage(error) });
      switchingRef.current = false;
      setSwitching(false);
      return;
    }

    // d. Wake what was live on the target branch, plus the worktree agents slept for the switch.
    const targetTags = prefsRef.current.canvasBranchSessions[projectId] ?? {};
    const toWake = projectAll().filter((session) => targetTags[session.id]?.branch === target && targetTags[session.id]?.resume);
    writeBranchTags(projectId, (tags) => {
      for (const session of toWake) tags[session.id] = { branch: target };
      return tags;
    });
    const woken = new Set(toWake.map((session) => session.id));
    for (const session of [...toWake, ...slept.filter((item) => !groundIds.has(item.id) && !woken.has(item.id))]) await resumeOne(session);
    toast.success(`Switched to ${target}`);
    switchingRef.current = false;
    setSwitching(false);
    // e. The canvas is new (possibly empty): refit once its nodes are in.
    setTimeout(() => requestAnimationFrame(() => void fitView({ duration: 200, ...fitOptsRef.current })), 150);
  };

  const openNewAgent = useCallback(() => {
    selectProject(activeProjectId, groundWorkspaceId ?? project?.workspaces[0]?.id);
    setNewAgentOpen(true);
  }, [selectProject, activeProjectId, project, groundWorkspaceId, setNewAgentOpen]);

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

  // ---- notes, secrets, deleting agents ----
  const [kcDeleteAsk, setKcDeleteAsk] = useState<{ id: string; name: string } | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<SessionSummary | null>(null);
  const floors = useMemo<FloorInfo[]>(() => {
    const list: FloorInfo[] = orderedWorkspaces.map((workspace) => ({
      id: workspace.id,
      label: workspace.branch || workspace.name || "Main",
      nodeIds: projectSessions.filter((session) => floorOf.get(session.id) === workspace.id).map((session) => session.id),
    }));
    list.push({ id: UNASSIGNED_FLOOR, label: "Unassigned", nodeIds: projectSessions.filter((session) => floorOf.get(session.id) === UNASSIGNED_FLOOR).map((session) => session.id) });
    const used = list.filter((floor) => floor.nodeIds.length > 0);
    return used.length > 1 ? used : [];
  }, [orderedWorkspaces, projectSessions, floorOf]);
  const fitViewOptions = useMemo<FitViewOptions>(
    () => floors.length > 1 ? { padding: { top: "150px", right: "70px", bottom: "70px", left: "70px" } } : {},
    [floors.length],
  );
  fitOptsRef.current = fitViewOptions;

  const allNodes = useMemo(() => [...notes.nodes, ...keychains.nodes, ...nodes] as Node[], [notes.nodes, keychains.nodes, nodes]);
  const onNodesChangeAll = useCallback((changes: NodeChange<Node>[]) => {
    const forNote = (change: NodeChange<Node>) => "id" in change && isNoteId(change.id);
    const forKeychain = (change: NodeChange<Node>) => "id" in change && isKeychainId(change.id);
    const agentChanges = changes.filter((change) => !forNote(change) && !forKeychain(change));
    const noteChanges = changes.filter(forNote);
    const keychainChanges = changes.filter(forKeychain);
    if (keychainChanges.length) keychains.onNodesChange(keychainChanges);
    if (agentChanges.length) onNodesChange(agentChanges as NodeChange<AgentNode>[]);
    if (noteChanges.length) notes.onNodesChange(noteChanges);
  }, [onNodesChange, notes.onNodesChange, keychains.onNodesChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const addNoteAt = notes.add;
  const addKeychainCenter = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const center = screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 600) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 400) / 2 });
    void keychains.add({ x: Math.round(center.x - KC_DEFAULT.width / 2), y: Math.round(center.y - KC_DEFAULT.height / 2) });
  }, [keychains.add, screenToFlowPosition]); // eslint-disable-line react-hooks/exhaustive-deps
  const addNoteCenter = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    const center = screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 600) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 400) / 2 });
    void addNoteAt({ x: Math.round(center.x - NOTE_DEFAULT.width / 2), y: Math.round(center.y - NOTE_DEFAULT.height / 2) });
  }, [addNoteAt, screenToFlowPosition]);

  /** Deletes agent sessions at once (no confirmation) as a soft delete: hidden now, one Undo toast, real delete after the grace period. Layout is kept for Undo and dropped by the store on the real delete. */
  const deleteAgents = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setTerminalId((current) => (current && ids.includes(current) ? null : current));
    deleteSessions(ids);
  }, [deleteSessions]);

  const KCLINK_PREFIX_LEN = kcLinkId("", "").length - 1;
  const NOTELINK_PREFIX_LEN = noteLinkId("", "").length - 1;
  const menuApi: MenuApi = {
    sessionById,
    linkById: (id) => allLinks.find((link) => link.id === id),
    linksOf: (id) => allLinks.filter((link) => link.fromSessionId === id || link.toSessionId === id),
    titleOf,
    collapsed: (id) => collapsed.has(id),
    hasMirrorText: (id) => getMirrorText(id) !== null,
    showActivity,
    linkMode: linkMode !== null,
    nodeCount: nodes.length,
    addNoteHere: (flow) => void addNoteAt({ x: Math.round(flow.x), y: Math.round(flow.y) }),
    keychainName: (id) => keychains.keychains.find((kc) => KC_PREFIX + kc.id === id)?.name,
    addKeychainHere: (flow) => void keychains.add({ x: Math.round(flow.x), y: Math.round(flow.y) }),
    renameKeychain: (id) => keychains.rename(id.slice(KC_PREFIX.length)),
    manageKeychain: (id) => keychains.setManaging(id.slice(KC_PREFIX.length)),
    deleteKeychain: (id) => { const kc = keychains.keychains.find((item) => KC_PREFIX + item.id === id); if (kc) setKcDeleteAsk({ id: kc.id, name: kc.name }); },
    recolorKeychain: (id, color) => keychains.patch(id.slice(KC_PREFIX.length), { color }),
    keychainEdge: (edgeId) => {
      const [kcId, sid] = edgeId.slice(KCLINK_PREFIX_LEN).split(":");
      const kc = keychains.keychains.find((item) => item.id === kcId);
      return kc ? { keychain: kc.name, agent: titleOf(sid) } : undefined;
    },
    unlinkKeychain: (edgeId) => { const [kcId, sid] = edgeId.slice(KCLINK_PREFIX_LEN).split(":"); keychains.unlink(kcId, sid); },
    noteInfo: (id) => { const note = notes.notes.find((item) => NOTE_PREFIX + item.id === id); return note ? { linked: note.linkedSessionIds.length } : undefined; },
    deleteNote: (id) => notes.remove(id.slice(NOTE_PREFIX.length)),
    unlinkNoteAgents: (id) => notes.unlinkAll(id.slice(NOTE_PREFIX.length)),
    noteEdge: (edgeId) => { const [, sid] = edgeId.slice(NOTELINK_PREFIX_LEN).split(":"); return { agent: titleOf(sid) }; },
    unlinkNote: (edgeId) => { const [noteId, sid] = edgeId.slice(NOTELINK_PREFIX_LEN).split(":"); notes.unlink(noteId, sid); },
    deleteAgent: (session) => setDeleteAsk(session),
    setOrchestrator: (session, on) => { if (client) void setOrchestrator(client, session, on, upsertSession, toast); },
    newAgentHere: (flow) => {
      pendingRef.current = { x: flow.x, y: flow.y, known: new Set(projectSessions.map((session) => session.id)), at: Date.now() };
      openNewAgent();
    },
    toggleLinkMode: () => setLinkMode((mode) => mode ? null : { from: null }),
    relayout,
    fit: () => void fitView({ duration: 200, ...fitOptsRef.current }),
    selectAll: () => selectNodes("all"),
    toggleActivity: () => setShowActivity((value) => !value),
    resetZoom: () => void zoomTo(1, { duration: 200 }),
    focus: openTerminal,
    startLink,
    rename: (session) => setRenaming({ session, title: session.title }),
    resume: (session) => void wake(session),
    copyId: (id) => void copyText(id).then(() => toast.success("Session id copied"), (error) => toast.error("Could not copy", { description: errorMessage(error) })),
    copyOutput: (id) => {
      const text = getMirrorText(id);
      if (!text) return;
      void copyText(text).then(() => toast.success("Last output copied"), (error) => toast.error("Could not copy", { description: errorMessage(error) }));
    },
    toggleCollapse,
    resize,
    bringToFront,
    deleteLink: (link) => void deleteLink(link),
    reverseLink: (link) => void reverseLink(link),
    showWire: (link) => { setActivityFilter(link.id); setShowActivity(true); },
  };

  const ctx: CanvasCtxValue = {
    recruits,
    liveIds, collapsed, linkMode, live, reducedMotion, titleOf, focus: openTerminal, terminalId, sentIds, highlightId, sendMessage, startLink, toggleCollapse, activate, savePlacement, wake: (session) => void wake(session), waking, linkInfo,
    deleteLink: (link) => void deleteLink(link),
    keychainCounts,
    noteCounts,
    hotIds,
    flashIds,
  };

  // A sidebar click lands here: select + center the agent's node, flash it, and (for "Open") open its terminal dialog. Never resumes.
  useEffect(() => {
    if (!canvasFocus) return;
    const session = sessionById(canvasFocus.id);
    if (!session || !nodes.some((node) => node.id === canvasFocus.id)) return;
    const request = canvasFocus;
    consumeCanvasFocus(request.seq);
    selectNodes(new Set([request.id]));
    setSelectedEdgeId(null);
    setHighlightId(request.id);
    const timers = [
      setTimeout(() => void fitView({ nodes: [{ id: request.id }], duration: 400, padding: 0.35, maxZoom: 1 }), 120),
      setTimeout(() => setHighlightId((current) => (current === request.id ? null : current)), 1800),
    ];
    if (request.dialog) setTerminalId(request.id);
    return () => { /* timers intentionally outlive the effect: the request is already consumed */ void timers; };
  }, [canvasFocus, nodes, sessionById, consumeCanvasFocus, selectNodes, fitView]);

  // Agent-to-agent drags create AgentLinks; a keychain or note and an agent create that kind of link (either direction); anything else is refused.
  const connectNodes = useCallback((a: string, b: string) => {
    // One-shot halo pulse on both ends (cleared after the animation).
    setFlashIds(new Set([a, b]));
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashIds(new Set()), 600);
    const aKey = isKeychainId(a), bKey = isKeychainId(b);
    const aNote = isNoteId(a), bNote = isNoteId(b);
    if (aKey || bKey || aNote || bNote) {
      const kind = aKey || bKey ? "Keychains" : "Notes";
      const agent = aKey || aNote ? b : a;
      if (!sessionsRef.current.some((item) => item.id === agent)) { toast.error(`${kind} can only be linked to agents`); return; }
      if (aKey || bKey) keychains.link((aKey ? a : b).slice(KC_PREFIX.length), agent);
      else notes.link((aNote ? a : b).slice(NOTE_PREFIX.length), agent);
      return;
    }
    void createLink(a, b);
  }, [createLink, keychains.link, notes.link]); // eslint-disable-line react-hooks/exhaustive-deps
  const onConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target) connectNodes(connection.source, connection.target);
  }, [connectNodes]);

  // Releasing a wire anywhere over a card (not just on a handle) links to that card.
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: { isValid: boolean | null; fromNode: { id: string } | null }) => {
    if (state.isValid || !state.fromNode) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return;
    const hit = document.elementsFromPoint(point.clientX, point.clientY).find((el) => el.classList.contains("react-flow__node"));
    const target = hit?.getAttribute("data-id");
    if (target && target !== state.fromNode.id) connectNodes(state.fromNode.id, target);
  }, [connectNodes]);

  const isValidConnection = useCallback((connection: { source: string; target: string }) => connection.source !== connection.target, []);

  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true], .xterm, [role=dialog], [data-radix-popper-content-wrapper]")) return;
    if (event.key === "Escape") { setLinkMode(null); setSelectedEdgeId(null); return; }
    if (event.key === "Delete" || event.key === "Backspace") {
      const agentIds = nodesRef.current.filter((node) => node.selected).map((node) => node.id);
      const noteIds = notes.nodes.filter((node) => node.selected).map((node) => node.data.note.id);
      const kcSelected = keychains.keychains.find((kc) => keychains.nodes.some((node) => node.selected && node.data.keychain.id === kc.id));
      const anyNodeSelected = agentIds.length > 0 || noteIds.length > 0 || !!kcSelected;
      // A selected node (e.g. box-selected after clicking a wire) wins over a stale edge selection.
      if (selectedEdgeId && !anyNodeSelected) {
        event.preventDefault();
        setSelectedEdgeId(null);
        if (isKeychainLinkId(selectedEdgeId)) {
          const [kcId, sid] = selectedEdgeId.slice(KCLINK_PREFIX_LEN).split(":");
          keychains.unlink(kcId, sid);
        } else if (isNoteLinkId(selectedEdgeId)) {
          const [noteId, sid] = selectedEdgeId.slice(NOTELINK_PREFIX_LEN).split(":");
          notes.unlink(noteId, sid);
        } else {
          const link = linksRef.current.find((item) => item.id === selectedEdgeId);
          if (link) void deleteLink(link);
        }
        return;
      }
      if (selectedEdgeId) setSelectedEdgeId(null);
      if (anyNodeSelected) {
        event.preventDefault();
        for (const id of noteIds) notes.remove(id);
        void deleteAgents(agentIds);
        if (kcSelected) setKcDeleteAsk({ id: kcSelected.id, name: kcSelected.name });
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); composerFocus.current?.(); return; }
    if (event.ctrlKey || event.metaKey) {
      const key = event.key;
      if (key.toLowerCase() === "a") { event.preventDefault(); selectNodes("all"); }
      else if (key === "+" || key === "=") { event.preventDefault(); void zoomIn({ duration: 200 }); }
      else if (key === "-") { event.preventDefault(); void zoomOut({ duration: 200 }); }
      else if (key === "0") { event.preventDefault(); void zoomTo(1, { duration: 200 }); }
      return;
    }
    if (event.altKey) return;
    if (event.key === "/") { event.preventDefault(); composerFocus.current?.(); return; }
    if (event.key.toLowerCase() === "l") setLinkMode((mode) => mode ? null : { from: null });
    else if (event.key.toLowerCase() === "n") addNoteCenter();
    else if (event.key.toLowerCase() === "k") addKeychainCenter();
    else if (event.key.toLowerCase() === "f") void fitView({ padding: 0.2, duration: 300, ...fitOptsRef.current });
  }

  // After a delete the focused element is removed and focus falls back to <body>, where the wrapper's
  // onKeyDown never fires. Route Delete/Backspace from <body> to the same handler so the next delete works.
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  useEffect(() => {
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.target !== document.body || (event.key !== "Delete" && event.key !== "Backspace")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu]")) return;
      onKeyDownRef.current(event as unknown as React.KeyboardEvent);
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, []);

  const branchSwitcher = currentBranch && groundWorkspaceId ? (
    <BranchSwitcher currentBranch={currentBranch} inWorktree={inWorktreeBranches} busy={switching} load={loadBranches} onSwitch={(branch) => void switchBranch(branch)} />
  ) : null;

  if (projectSessions.length === 0) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <IconTopologyStar3 size={28} stroke={1.5} />
        <p className="text-sm font-medium text-foreground">{projectName} has no agents yet</p>
        <p className="text-xs">Start an agent and the sessions it recruits will appear here.</p>
        <Button type="button" size="sm" className="mt-1" disabled={!activeProjectId} onClick={openNewAgent}>
          <IconPlus size={14} />
          New agent
        </Button>
        {branchSwitcher && <div className="absolute right-0 bottom-0">{branchSwitcher}</div>}
      </div>
    );
  }

  const toolButton = (active: boolean, label: string, onClick: () => void, icon: React.ReactNode, cursor?: "add-note" | "add-keychain") => (
    <Button type="button" data-cursor={cursor} variant={active ? "secondary" : "ghost"} size="icon-sm" aria-label={label} aria-pressed={active} onClick={onClick}>{icon}</Button>
  );

  return (
    <CanvasCtx.Provider value={ctx}>
      <NoteProvider value={notes.ctxValue}>
      <KeychainProvider value={keychains.ctxValue}>
      <KeychainWireCtx.Provider value={{ unlink: keychains.unlink }}>
      <NoteWireCtx.Provider value={{ unlink: notes.unlink }}>
      <TooltipProvider>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={wrapRef}
            data-canvas-theme={canvasTheme}
            data-canvas-tool={linkMode ? "link" : tool}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onContextMenuCapture={(event) => setMenuTarget({ kind: "pane", flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }) })}
            className={cn("canvas-chrome size-full outline-none", canvasTheme === "dark" ? "canvas-chrome-dark" : "canvas-chrome-light")}
          >
            <ReactFlow
              nodes={allNodes}
              edges={allEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChangeAll}
              onNodeDragStart={(_, node) => { if (isNoteId(node.id)) notes.dragStart(node); else if (isKeychainId(node.id)) keychains.dragStart(node); }}
              onMoveEnd={(_, view) => saveViewport(view)}
              defaultViewport={savedViewport}
              onNodeDragStop={(_, node) => { if (isNoteId(node.id)) { notes.dragEnd(node); return; } if (isKeychainId(node.id)) { keychains.dragEnd(node); return; } persistNode(node.id, { position: { x: node.position.x, y: node.position.y } }); computeLive(); }}
              onNodeDoubleClick={(_, node) => { if (node.type === "agent") openTerminal((node as AgentNode).data.session); }}
              onNodeClick={(_, node) => {
                setSelectedEdgeId(null);
                if (!linkMode) return;
                if (linkMode.from === null) setLinkMode({ from: node.id });
                else if (linkMode.from !== node.id) { connectNodes(linkMode.from, node.id); setLinkMode(null); }
              }}
              onNodeContextMenu={(_, node) => { setMenuTarget({ kind: "node", id: node.id }); setSelectedEdgeId(null); selectNodes(new Set([node.id])); }}
              onEdgeMouseEnter={(_, edge) => setHoverEdgeId(edge.id)}
              onEdgeMouseLeave={() => setHoverEdgeId(null)}
              onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); selectNodes(new Set()); }}
              onEdgeContextMenu={(_, edge) => { setMenuTarget({ kind: "edge", id: edge.id }); setSelectedEdgeId(edge.id); selectNodes(new Set()); }}
              onPaneClick={() => setSelectedEdgeId(null)}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={40}
              connectionLineStyle={{ stroke: "var(--primary-text)", strokeWidth: 2.5, strokeDasharray: "6 4", strokeLinecap: "round", filter: "drop-shadow(0 0 3px color-mix(in oklab, var(--primary-text) 45%, transparent))" }}
              nodesConnectable
              edgesFocusable={false}
              deleteKeyCode={null}
              selectionOnDrag={tool === "select"}
              panOnDrag={tool === "select" ? [1] : true}
              onlyRenderVisibleElements
              fitView={!savedViewport}
              fitViewOptions={fitViewOptions}
              minZoom={0.1}
              colorMode={canvasTheme}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} />
              <FloorBands floors={floors} />
              <CanvasControls />
              {branchSwitcher && <Panel position="bottom-right" className="m-0!">{branchSwitcher}</Panel>}

              <Panel position="top-left" className="m-2! w-[calc(100%-1rem)]">
                <div className="canvas-topbar w-full rounded-2xl border border-border/70 p-1.5 shadow-sm">
                  <div className="canvas-topbar-layout grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
                    <div className="canvas-topbar-identity order-1 flex min-w-0 items-center gap-2 pl-1">
                      <span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center">
                        <ProjectMark key={project?.id ?? "none"} project={project ?? NO_PROJECT_MARK} className="size-[18px] text-muted-foreground" />
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium" title={project?.cwd}>{projectName}</span>
                    </div>

                    <div className="canvas-topbar-actions order-2 flex shrink-0 items-center gap-1">
                      <ShortcutTip label={sleepingCount ? `Wake all sleeping agents (${sleepingCount})` : "No sleeping agents"}>
                        <span tabIndex={sleepingCount === 0 ? 0 : undefined} className="inline-flex">
                          <Button type="button" variant="ghost" size="icon-sm" className="relative" aria-label="Wake all sleeping agents" disabled={sleepingCount === 0} onClick={() => void wakeAll()}>
                            <IconPlayerPlay size={16} />
                            {sleepingCount > 0 && <span className="absolute -top-0.5 -right-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-3.5 font-medium text-primary-foreground tabular-nums">{sleepingCount}</span>}
                          </Button>
                        </span>
                      </ShortcutTip>
                      <VaultPopover />
                      <Button type="button" className="shrink-0" disabled={!activeProjectId} onClick={openNewAgent}>
                        <IconPlus size={15} />
                        New agent
                      </Button>
                    </div>

                    <div role="group" aria-label="Canvas tools" className="canvas-topbar-tools order-3 col-span-2 row-start-2 flex min-w-0 items-center justify-center gap-1">
                      <div role="group" aria-label="Canvas modes" className="flex shrink-0 items-center gap-0.5">
                        <ShortcutTip label="Select (drag to box-select)">{toolButton(tool === "select", "Select (drag to box-select)", () => setTool("select"), <IconPointer size={16} />)}</ShortcutTip>
                        <ShortcutTip label="Pan (drag to move canvas)">{toolButton(tool === "pan", "Pan (drag to move canvas)", () => setTool("pan"), <IconHandStop size={16} />)}</ShortcutTip>
                        <ShortcutTip label="Link mode" keys="L">{toolButton(linkMode !== null, "Link mode (L)", () => setLinkMode((mode) => mode ? null : { from: null }), <IconLink size={16} />)}</ShortcutTip>
                      </div>
                      <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border/80" />
                      <div role="group" aria-label="Add to canvas" className="flex shrink-0 items-center gap-0.5">
                        <ShortcutTip label="Add note" keys="N">{toolButton(false, "Add note (N)", addNoteCenter, <IconNote size={16} />, "add-note")}</ShortcutTip>
                        <ShortcutTip label="Add keychain" keys="K">{toolButton(false, "Add keychain (K)", addKeychainCenter, <IconKey size={16} />, "add-keychain")}</ShortcutTip>
                      </div>
                      <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border/80" />
                      <div role="group" aria-label="Canvas view" className="flex shrink-0 items-center gap-0.5">
                        <ShortcutTip label="Re-layout">{toolButton(false, "Re-layout", relayout, <IconLayoutDistributeHorizontal size={16} />)}</ShortcutTip>
                        <ShortcutTip label="Show all notes">{toolButton(false, "Show all notes", () => { if (notes.nodes.length) void fitView({ nodes: notes.nodes.map((node) => ({ id: node.id })), duration: 300, padding: 0.3, maxZoom: 1 }); else toast.info("No notes on this canvas yet"); }, <IconNotes size={16} />)}</ShortcutTip>
                        <ShortcutTip label="Fit view" keys="F">{toolButton(false, "Fit view (F)", () => void fitView({ duration: 200, ...fitOptsRef.current }), <IconArrowsMaximize size={16} />)}</ShortcutTip>
                        <ShortcutTip label="Activity">{toolButton(showActivity, "Activity", () => { setActivityFilter(null); setShowActivity((value) => !value); }, <IconActivity size={16} />)}</ShortcutTip>
                      </div>
                    </div>
                  </div>
                </div>
              </Panel>

              {linkMode && (
                <Panel position="top-center" className="canvas-link-mode-panel mt-12! flex items-center gap-1.5 rounded-full border border-violet-500/60 bg-card/90 py-0.5 pr-1 pl-2 text-[11px] shadow-sm">
                  <IconLink size={12} className="text-violet-500" />
                  <span className="max-w-72 truncate">{linkMode.from ? `Link ${titleOf(linkMode.from)} to…` : "Pick the agent to link from"}</span>
                  <Button type="button" variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label="Cancel link mode (Esc)" title="Cancel (Esc)" onClick={() => setLinkMode(null)}><IconX size={11} /></Button>
                </Panel>
              )}

              <CanvasComposer
                key={activeProjectId ?? "none"}
                projectId={activeProjectId ?? ""}
                client={client}
                sessions={projectSessions}
                selectedIds={nodes.filter((node) => node.selected).map((node) => node.id)}
                wake={wake}
                onSent={markSent}
                focusRef={composerFocus}
              />

              <CrossProjectWires links={runtimeLinks} titleOf={titleOf} />

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
      </TooltipProvider>

      <TerminalDialog
        session={terminalId ? sessionById(terminalId) ?? null : null}
        waking={terminalId ? waking.has(terminalId) : false}
        onClose={() => setTerminalId(null)}
        onFullView={(session) => { setTerminalId(null); focus(session); }}
        onWake={(session) => void wake(session)}
        onCloseFocus={() => wrapRef.current?.focus()}
      />

      {keychains.managing && keychains.keychains.find((kc) => kc.id === keychains.managing) && (
        <KeychainDialog key={keychains.managing} keychain={keychains.keychains.find((kc) => kc.id === keychains.managing)!} client={client} onClose={() => keychains.setManaging(null)} onChanged={keychains.refresh} />
      )}

      <AlertDialog open={kcDeleteAsk !== null} onOpenChange={(open) => { if (!open) setKcDeleteAsk(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete keychain {kcDeleteAsk?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This permanently destroys its secrets and unlinks it from every agent.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { const target = kcDeleteAsk; setKcDeleteAsk(null); if (target) keychains.remove(target.id); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteAsk !== null} onOpenChange={(open) => { if (!open) setDeleteAsk(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteAsk?.title}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the session and its conversation. Tip: select agents and press Del to delete without asking.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { const target = deleteAsk; setDeleteAsk(null); if (target) void deleteAgents([target.id]); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename agent</DialogTitle><DialogDescription>Choose a name you can recognize in the workspace.</DialogDescription></DialogHeader>
          <form noValidate onSubmit={(event) => { event.preventDefault(); void submitRename(); }} className="flex flex-col gap-3">
            <label htmlFor="rename-agent-title" className="text-sm font-medium">Agent name</label>
            <Input id="rename-agent-title" autoFocus value={renaming?.title ?? ""} maxLength={120} onChange={(event) => setRenaming((current) => current && { ...current, title: event.target.value })} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
              <Button type="submit" disabled={!renaming?.title.trim()}>Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      </NoteWireCtx.Provider>
      </KeychainWireCtx.Provider>
      </KeychainProvider>
      </NoteProvider>
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
