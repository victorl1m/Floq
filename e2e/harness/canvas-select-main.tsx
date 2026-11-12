// Test harness: xyflow with the exact selection props of agent-canvas-page.tsx and the canvas-node-wrap halo markup, 3 plain nodes (no Tauri/runtime needed).
import React, { useCallback, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider, SelectionMode, applyNodeChanges, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";

function Card({ data, selected }: NodeProps) {
  return (
    <div data-selected={selected ? "true" : undefined} className="canvas-node-wrap relative size-full">
      <span aria-hidden="true" className="canvas-node-halo rounded-xl" />
      <div className="canvas-agent-card-material flex size-full items-center justify-center overflow-hidden rounded-xl border bg-card">{String((data as { label: string }).label)}</div>
    </div>
  );
}
const nodeTypes = { card: Card };
const init: Node[] = [
  { id: "a", type: "card", position: { x: 100, y: 100 }, width: 200, height: 120, data: { label: "A" } },
  { id: "b", type: "card", position: { x: 350, y: 100 }, width: 200, height: 120, data: { label: "B" } },
  { id: "c", type: "card", position: { x: 350, y: 350 }, width: 200, height: 120, data: { label: "C" } },
];

function App() {
  const [nodes, setNodes] = useState(init);
  const onNodesChange = useCallback((c: NodeChange<Node>[]) => setNodes((n) => applyNodeChanges(c, n)), []);
  const base = useRef<Set<string> | null>(null);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  (window as unknown as { __nodes: Node[] }).__nodes = nodes;
  return (
    <div style={{ height: "100vh" }} onKeyDown={(e) => { if (e.key === "Escape") setNodes((n) => n.map((x) => ({ ...x, selected: false }))); }} tabIndex={0}>
      <ReactFlow
        nodes={nodes} nodeTypes={nodeTypes} onNodesChange={onNodesChange} defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        selectionOnDrag selectionMode={SelectionMode.Partial} multiSelectionKeyCode={["Shift", "Meta", "Control"]} panOnDrag={[1]}
        onSelectionStart={(e) => { base.current = e.shiftKey || e.metaKey || e.ctrlKey ? new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id)) : null; }}
        onSelectionChange={({ nodes: picked }) => { const b = base.current; if (b && [...b].some((id) => !picked.some((n) => n.id === id))) setNodes((n) => n.map((x) => ({ ...x, selected: b.has(x.id) || picked.some((p) => p.id === x.id) }))); }}
        onSelectionEnd={() => { base.current = null; }}
        deleteKeyCode={null} onPaneClick={() => setNodes((n) => n.map((x) => ({ ...x, selected: false })))}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
