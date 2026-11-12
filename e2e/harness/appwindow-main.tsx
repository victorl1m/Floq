// Test harness: the canvas app-window node hook + card inside a bare ReactFlow, against a fake runtime client.
import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import { AppWindowProvider, appWindowNodeTypes, useCanvasAppWindows } from "@/components/canvas/app-window-node";

const running = new URLSearchParams(location.search).get("running") !== "0";
const client = { async sessionDisplay() { return { running, port: 14500, token: "t" }; } } as never;
const sessions = [{ id: "s1", title: "Builder", state: "running" }] as never[];
const anchor = { x: 100, y: 60 };

function App() {
  const ctx = React.useMemo(() => ({ client, sessions }), []);
  const { nodes, onNodesChange } = useCanvasAppWindows(client, sessions, anchor);
  return (
    <AppWindowProvider value={ctx}>
      <div style={{ width: 1000, height: 640 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={appWindowNodeTypes} onNodesChange={onNodesChange} fitView />
      </div>
    </AppWindowProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
