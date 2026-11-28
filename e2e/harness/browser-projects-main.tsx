// Test harness: the real useCanvasBrowsers hook on a canvas whose active project can be switched, to prove Browser nodes belong to the project they were created on.
// The "runtime" registry is localStorage (floq:test-owners): the first project to claim a node id owns it, others get a 409 like the real server.
import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import { BrowserProvider, browserNodeTypes, useCanvasBrowsers } from "@/components/canvas/browser-node";

class MockSocket {
  static OPEN = 1; readyState = 1;
  onopen: (() => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(url?: string) {
    // The runtime's rule: a socket shows the page of the node's OWNER. Every connection is recorded so a test can prove a project never attaches to a node it does not own.
    const node = new URL(String(url), "http://mock").searchParams.get("node") ?? "";
    const w = window as unknown as { __opened?: Array<{ node: string; owner: string | null; project: string }>; __project?: string };
    (w.__opened ??= []).push({ node, owner: owners()[node] ?? null, project: w.__project ?? "" });
    setTimeout(() => { this.onopen?.(); for (const m of [{ type: "state", state: "running" }, { type: "page", targetId: "t1", created: true }]) this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent); }, 30); }
  send() {}
  close() { this.onclose?.(); }
}
(window as unknown as { WebSocket: unknown }).WebSocket = MockSocket;

const AUTO = new URLSearchParams(location.search).has("auto"); // ?auto: an agent is connected to the browser and the hook may open a node itself
const FLAKY = new URLSearchParams(location.search).has("flaky"); // ?flaky: the first claims fail with a 503
let flakyLeft = 1;
const OWN = "floq:test-owners";
const owners = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(OWN) ?? "{}"); } catch { return {}; } };
const client = {
  browserStreamUrl: (nodeId: string) => `ws://mock/v1/browser/stream?node=${nodeId}`, browserStatus: async () => ({ state: "running", agents: AUTO ? 1 : 0 }), browserLinks: async () => [],
  claimBrowserNode: async (nodeId: string, projectId: string) => {
    if (FLAKY && flakyLeft-- > 0) throw Object.assign(new Error("offline"), { status: 503 });
    const o = owners();
    if (o[nodeId] && o[nodeId] !== projectId) throw Object.assign(new Error("other project"), { status: 409 });
    localStorage.setItem(OWN, JSON.stringify({ ...o, [nodeId]: projectId }));
  },
  removeBrowserNode: async () => undefined,
} as never;

const nodeTypes = { ...browserNodeTypes };
function App() {
  const [project, setProject] = React.useState("pA");
  (window as unknown as { __project?: string }).__project = project;
  const b = useCanvasBrowsers(client, project, { x: 40, y: 40 }, AUTO);
  const bctx = React.useMemo(() => ({ client, close: b.close, linkedAgents: () => [], newBrowser: () => { b.open(); } }), [b.close, b.open]);
  return (
    <BrowserProvider value={bctx}>
      <div style={{ position: "fixed", top: 0, left: 0, zIndex: 10, display: "flex", gap: 8, padding: 8 }}>
        <button data-testid="to-a" onClick={() => setProject("pA")}>Project A</button>
        <button data-testid="to-b" onClick={() => setProject("pB")}>Project B</button>
        <button data-testid="new-browser" onClick={() => b.open()}>New browser</button>
        <button data-testid="close-first" onClick={() => b.nodes[0] && b.close(b.nodes[0].id)}>Close</button>
        <span data-testid="project">{project}</span>
      </div>
      <div style={{ width: "100vw", height: "100vh" }}>
        <ReactFlow nodes={b.nodes as Node[]} nodeTypes={nodeTypes} onNodesChange={b.onNodesChange} defaultViewport={{ x: 0, y: 60, zoom: 0.5 }} proOptions={{ hideAttribution: true }} />
      </div>
    </BrowserProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
