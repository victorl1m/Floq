// Test harness: xyflow with the wheel hook of agent-canvas-page.tsx, a plain node and a nowheel "terminal" node.
import React, { useRef } from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider, useOnViewportChange, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import { useCanvasWheel } from "@/components/canvas/use-canvas-wheel";

function Plain() { return <div style={{ width: 200, height: 120, background: "#223" }}>plain</div>; }
function Term({ }: NodeProps) {
  return <div className="nowheel" data-testid="term" style={{ width: 200, height: 120, overflow: "auto", background: "#232" }}><div style={{ height: 1000 }}>terminal</div></div>;
}
const nodeTypes = { plain: Plain, term: Term };
const nodes: Node[] = [
  { id: "a", type: "plain", position: { x: 100, y: 100 }, width: 200, height: 120, data: {} },
  { id: "t", type: "term", position: { x: 400, y: 100 }, width: 200, height: 120, data: {} },
];

function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  useCanvasWheel(ref);
  useOnViewportChange({ onChange: (v) => { (window as unknown as { __vp: unknown }).__vp = v; } });
  return (
    <div ref={ref} style={{ height: "100vh" }}>
      <ReactFlow nodes={nodes} nodeTypes={nodeTypes} defaultViewport={{ x: 0, y: 0, zoom: 1 }} minZoom={0.1} panOnDrag={[1]} selectionOnDrag proOptions={{ hideAttribution: true }} />
    </div>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><Canvas /></ReactFlowProvider>);
