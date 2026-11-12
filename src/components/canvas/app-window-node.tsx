// App window canvas node: the agent's Linux GUI app (Xpra display) shown on the canvas while its display is running.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NodeResizer, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { IconAppWindow, IconGripHorizontal } from "@tabler/icons-react";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { SessionSummary } from "@/lib/runtime/types";
import { isLive } from "@/components/agents/provider";
import AppWindowTab from "@/components/agents/right-sidebar/app-window-tab";

export const APPWIN_PREFIX = "appwin:";
export const isAppWindowId = (id: string) => id.startsWith(APPWIN_PREFIX);
export const APPWIN_DEFAULT = { width: 640, height: 440 };
const POLL_MS = 3_000;

export type AppWindowNode = Node<{ sessionId: string; title: string }, "appwindow">;

interface AppWindowCtxValue { client: RuntimeClient | null; sessions: SessionSummary[] }
const AppWindowCtx = createContext<AppWindowCtxValue>({ client: null, sessions: [] });
export const AppWindowProvider = AppWindowCtx.Provider;

const AppWindowCard = memo(function AppWindowCard({ data, selected }: NodeProps<AppWindowNode>) {
  const { client, sessions } = useContext(AppWindowCtx);
  const session = sessions.find((item) => item.id === data.sessionId);
  return (
    <div data-testid="app-window-node" className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <NodeResizer isVisible={selected} minWidth={320} minHeight={240} />
      <div className="appwin-drag flex h-8 shrink-0 cursor-grab items-center gap-2 border-b border-border/70 px-3 text-xs font-medium">
        <IconAppWindow size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">App window · {data.title}</span>
        <IconGripHorizontal size={14} className="text-muted-foreground" />
      </div>
      <div className="nodrag nowheel nopan min-h-0 flex-1"><AppWindowTab client={client} session={session} active /></div>
    </div>
  );
});
export const appWindowNodeTypes = { appwindow: AppWindowCard };

/**
 * One node per live session of the project whose display is running (polled; older runtimes answering 404 just yield none).
 * Dragged/resized geometry is kept locally for this canvas view.
 */
export function useCanvasAppWindows(client: RuntimeClient | null, sessions: SessionSummary[], anchor: { x: number; y: number }) {
  const liveKey = sessions.filter((item) => isLive(item.state)).map((item) => item.id).join(",");
  const [running, setRunning] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Default spot per session, frozen when the window first appears so it does not jump while agents are dragged.
  const anchors = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [geometry, setGeometry] = useState<Record<string, { x?: number; y?: number; width?: number; height?: number }>>({});
  useEffect(() => {
    const ids = liveKey ? liveKey.split(",") : [];
    if (!client || ids.length === 0) { setRunning([]); return; }
    let stopped = false;
    const load = async () => {
      const found = (await Promise.all(ids.map((id) => client.sessionDisplay(id).then((d) => (d.running ? id : null), () => null)))).filter((id): id is string => !!id);
      if (!stopped) setRunning((prev) => (prev.join(",") === found.join(",") ? prev : found));
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [client, liveKey]);

  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const nodes = useMemo<AppWindowNode[]>(() => running.map((sessionId) => {
    const id = APPWIN_PREFIX + sessionId;
    const g = geometry[id];
    let spot = anchors.current.get(sessionId);
    if (!spot) {
      spot = { x: anchorRef.current.x, y: anchorRef.current.y + anchors.current.size * (APPWIN_DEFAULT.height + 40) };
      anchors.current.set(sessionId, spot);
    }
    return {
      id, type: "appwindow", dragHandle: ".appwin-drag", selected: selectedIds.has(id),
      position: { x: g?.x ?? spot.x, y: g?.y ?? spot.y },
      width: g?.width ?? APPWIN_DEFAULT.width, height: g?.height ?? APPWIN_DEFAULT.height,
      data: { sessionId, title: sessions.find((item) => item.id === sessionId)?.title ?? "agent" },
    };
  }), [running, geometry, selectedIds, sessions]);

  const onNodesChange = useCallback((changes: NodeChange<Node>[]) => {
    if (changes.some((change) => change.type === "select")) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const change of changes) if (change.type === "select") { if (change.selected) next.add(change.id); else next.delete(change.id); }
        return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
      });
    }
    setGeometry((prev) => {
      const next = { ...prev };
      for (const change of changes) {
        if (change.type === "position" && change.position) next[change.id] = { ...next[change.id], ...change.position };
        else if (change.type === "dimensions" && change.dimensions && change.setAttributes) next[change.id] = { ...next[change.id], ...change.dimensions };
      }
      return next;
    });
  }, []);
  return { nodes, onNodesChange };
}
