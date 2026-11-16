// Test harness: the real useVirtualAgents hook + virtual-agent node on a bare xyflow canvas, with a mocked RuntimeClient and a mocked events WebSocket (no Tauri/runtime).
// Query: ?old=1 simulates a runtime without the routes (404). window.__push(frame) delivers an events frame; window.__sent collects messageVirtualAgent calls.
import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import VirtualAgentCard, { VirtualAgentProvider } from "@/components/canvas/virtual-agent-node";
import { useShowKilled, useVirtualAgentNodes, useVirtualAgents } from "@/components/canvas/use-virtual-agents";
import { publishConnect, publishFrame } from "@/lib/runtime/event-frames";
import type { RuntimeClient } from "@/lib/runtime/client";
import type { VirtualAgent, VirtualAgentStep } from "@/lib/runtime/types";

const w = window as unknown as { __push: (frame: unknown) => void; __connect: () => void; __sent: { id: string; text: string }[]; __seeds: number };
w.__sent = []; w.__seeds = 0;
w.__push = (frame) => publishFrame(frame);
w.__connect = () => publishConnect();

const params = new URLSearchParams(location.search);
const old = params.get("old") === "1";
const slow = Number(params.get("slow") ?? 0);
const mk = (o: Partial<VirtualAgent> & { id: string; name: string }): VirtualAgent => ({ hostSessionId: "host", projectId: "p1", parentId: "host", role: "worker", kind: "swarm", model: "gemini-3", status: "working", activity: null, steps: 2, lastAt: null, swarmTitle: "Refactor", unread: 0, ...o });
const seed: VirtualAgent[] = [
  mk({ id: "agy:1", name: "parser", activity: "Reading parser.ts", steps: 2 }),
  mk({ id: "agy:2", name: "tester", status: "waiting", role: "subagent", kind: "subagent", parentId: "agy:1" }),
  mk({ id: "agy:3", name: "old-worker", status: "killed" }),
];
const steps: VirtualAgentStep[] = [
  { index: 0, type: "USER_INPUT", status: "DONE", createdAt: null, text: "Parse the grammar", tools: [], error: null },
  { index: 1, type: "PLANNER_RESPONSE", status: "DONE", createdAt: null, text: "Reading the file", tools: [{ name: "view_file", summary: "Viewing parser.ts" }], error: null },
];
const notFound = () => Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
const client = {
  virtualAgents: async () => { w.__seeds++; if (slow) await new Promise((r) => setTimeout(r, slow)); return old ? notFound() : seed.concat(params.get("dup") ? [{ ...seed[0], hostSessionId: "host2" }] : []); },
  virtualAgentTranscript: async () => ({ steps, next: null }),
  messageVirtualAgent: async (id: string, text: string) => { w.__sent.push({ id, text }); },
} as unknown as RuntimeClient;

const nodeTypes = { "virtual-agent": VirtualAgentCard };
const hostRect = (id: string) => (id === "host" || id === "host2" ? { x: 0, y: 0, width: 300, height: 120 } : undefined);
const blocker = { x: 0, y: 190, width: 300, height: 260 };
function App() {
  const agents = useVirtualAgents(client, "p1");
  const [showKilled, setShowKilled] = useShowKilled();
  const v = useVirtualAgentNodes(agents, showKilled, hostRect, "k", () => (params.get("block") ? [blocker] : []));
  const host = useMemo<Node>(() => ({ id: "host", position: { x: 0, y: 0 }, width: 300, height: 120, data: {}, type: "default" }), []);
  const ctx = useMemo(() => ({ client, resize: v.resize }), [v.resize]);
  return (
    <VirtualAgentProvider value={ctx}>
      <button data-testid="virtual-toggle-killed" onClick={() => setShowKilled(!showKilled)} style={{ position: "absolute", zIndex: 10, right: 8, top: 8 }}>{showKilled ? "Hide" : "Show"} killed ({v.killedCount})</button>
      <ReactFlow nodes={[host, ...(params.get("block") ? [{ id: "blocker", position: blocker, width: blocker.width, height: blocker.height, data: { label: "floq subagent" }, type: "default" } as Node] : []), ...v.nodes]} nodeTypes={nodeTypes} onNodesChange={v.onNodesChange} defaultViewport={{ x: 20, y: 20, zoom: 0.8 }} deleteKeyCode={["Delete", "Backspace"]} proOptions={{ hideAttribution: true }} />
    </VirtualAgentProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
