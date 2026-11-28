// Test harness: agent-style node + real Browser node + the real wire edge, wired with the same connect/link code paths as the canvas
// (useBrowserLinks, the standard "wire" edge, SIDE_STRIP handles). The "server" is localStorage (floq:test-links) so reloads prove persistence.
import React from "react";
import ReactDOM from "react-dom/client";
import { ConnectionMode, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import { BROWSER_PREFIX, BrowserProvider, browserNodeTypes, useCanvasBrowsers } from "@/components/canvas/browser-node";
import { browserWireId, useBrowserLinks } from "@/components/canvas/browser-links";
import WireEdgeView, { KIND_COLOR, RESIZER_ABOVE, SIDE_STRIP_CLASS, SIDE_STRIP_STYLE, type WireEdge } from "@/components/canvas/wire-edge";
import { CanvasCtx, type CanvasCtxValue } from "@/components/canvas/canvas-context";

const w = window as unknown as { __calls: unknown[]; __sent: unknown[] };
w.__calls = []; w.__sent = [];
const SRV = "floq:test-links";
const readSrv = (): Array<{ nodeId: string; sessionId: string; projectId: string }> => { try { return JSON.parse(localStorage.getItem(SRV) ?? "[]"); } catch { return []; } };
const writeSrv = (v: unknown) => localStorage.setItem(SRV, JSON.stringify(v));

class MockSocket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() { setTimeout(() => { this.onopen?.(); for (const m of [{ type: "state", state: "running" }, { type: "page", targetId: "t1", created: true }]) this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent); }, 30); }
  send(data: string) { w.__sent.push(JSON.parse(data)); }
  close() { this.onclose?.(); }
}
(window as unknown as { WebSocket: unknown }).WebSocket = MockSocket;

const client = {
  claimBrowserNode: async () => undefined, // the runtime registers each node to its project before a card connects
  browserStreamUrl: (nodeId: string) => `ws://mock/v1/browser/stream?node=${nodeId}`, browserStatus: async () => ({ state: "running", agents: 0 }),
  browserLinks: async () => readSrv(),
  linkBrowser: async (nodeId: string, sessionId: string) => { w.__calls.push(["link", nodeId, sessionId]); const rest = readSrv().filter((l) => l.sessionId !== sessionId); writeSrv([...rest, { nodeId, sessionId, projectId: "p1" }]); return { link: { nodeId, sessionId, projectId: "p1" }, replacedNode: null }; },
  unlinkBrowser: async (nodeId: string, sessionId: string) => { w.__calls.push(["unlink", nodeId, sessionId]); writeSrv(readSrv().filter((l) => !(l.nodeId === nodeId && l.sessionId === sessionId))); },
  removeBrowserNode: async (nodeId: string) => { w.__calls.push(["removeNode", nodeId]); writeSrv(readSrv().filter((l) => l.nodeId !== nodeId)); },
} as never;

const AGENT = "11111111-1111-4111-8111-111111111111";
const SIDES = [{ id: "top", position: Position.Top }, { id: "right", position: Position.Right }, { id: "bottom", position: Position.Bottom }, { id: "left", position: Position.Left }] as const;
function AgentStandIn({ selected }: NodeProps) {
  return (
    <div data-testid="agent-node" data-selected={selected ? "true" : undefined} className="canvas-node-wrap relative size-full">
      <div className="flex size-full items-center justify-center rounded-xl border bg-card">Agent</div>
      {SIDES.map((side) => <Handle key={side.id} id={side.id} type="source" position={side.position} style={SIDE_STRIP_STYLE[side.position]} isConnectable isConnectableStart isConnectableEnd className={SIDE_STRIP_CLASS} />)}
    </div>
  );
}
const nodeTypes = { ...browserNodeTypes, agent: AgentStandIn };
const edgeTypes = { wire: WireEdgeView };
const titleOf = (id: string) => (id.startsWith(BROWSER_PREFIX) ? "Browser" : "Agent One");

function App() {
  const b = useCanvasBrowsers(client, "p1", { x: 420, y: 20 }, false);
  const links = useBrowserLinks(client, "p1", titleOf);
  React.useEffect(() => { if (b.count === 0) b.open({ x: 420, y: 20 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [agent, setAgent] = React.useState<Node[]>([{ id: AGENT, type: "agent", position: { x: 20, y: 40 }, width: 260, height: 140, data: {} }]);
  const [selectedEdge, setSelectedEdge] = React.useState<string | null>(null);
  const ids = React.useMemo(() => new Set(b.nodes.map((n) => n.id)), [b.nodes]);
  const wires = links.wires(ids, new Set([AGENT]));
  const edges = wires.map<WireEdge>((link) => ({ id: link.id, type: "wire", source: link.fromSessionId, target: link.toSessionId, data: { link }, selected: link.id === selectedEdge, markerEnd: { type: MarkerType.ArrowClosed, color: KIND_COLOR[link.kind], width: 18, height: 18 } }));
  const ctx = React.useMemo(() => ({
    recruits: new Map(), liveIds: new Set(), collapsed: new Set(), linkMode: null, live: {}, reducedMotion: true, titleOf, focus: () => {}, terminalId: null, sentIds: new Set(), highlightId: null,
    startLink: () => {}, toggleCollapse: () => {}, activate: () => {}, wake: () => {}, sendMessage: async () => true, waking: new Set(), linkInfo: {}, noteCounts: {}, hotIds: new Set(), flashIds: new Set(), savePlacement: () => {},
    deleteLink: (link) => { const [nodeId, sessionId] = link.id.slice("bwire:".length).split(":"); links.unlink(nodeId, sessionId); },
  }) as CanvasCtxValue, [links.unlink]);
  const bctx = React.useMemo(() => ({ client, close: (id: string) => { b.close(id); links.dropNode(id); }, linkedAgents: links.linkedAgents, newBrowser: () => { b.open(); } }), [b.close, b.open, links.dropNode, links.linkedAgents]);
  const onConnect = (c: Connection) => {
    const a = c.source, d = c.target; if (!a || !d) return;
    const browser = a.startsWith(BROWSER_PREFIX) ? a : d.startsWith(BROWSER_PREFIX) ? d : null;
    const session = browser === a ? d : a;
    if (browser && session === AGENT) links.link(browser, session);
  };
  const onNodesChange = (changes: NodeChange<Node>[]) => {
    b.onNodesChange(changes.filter((c) => "id" in c && c.id.startsWith(BROWSER_PREFIX)));
    setAgent((n) => applyNodeChanges(changes.filter((c) => "id" in c && !c.id.startsWith(BROWSER_PREFIX)), n));
  };
  return (
    <CanvasCtx.Provider value={ctx}>
      <BrowserProvider value={bctx}>
        <div style={{ width: "100vw", height: "100vh" }}>
          <ReactFlow nodes={[...agent, ...b.nodes] as Node[]} edges={edges as Edge[]} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onConnect={onConnect}
            connectionMode={ConnectionMode.Loose} onEdgeClick={(_, e) => setSelectedEdge(e.id)} deleteKeyCode={null} defaultViewport={{ x: 0, y: 0, zoom: 1 }} proOptions={{ hideAttribution: true }} />
        </div>
      </BrowserProvider>
    </CanvasCtx.Provider>
  );
}
void RESIZER_ABOVE; void browserWireId;
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
