// Test harness: real agent canvas cards (header + avatars) with a stub canvas context and runtime. ?theme=dark, ?cards=1
import React from "react";
import ReactDOM from "react-dom/client";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "@/index.css";
import "./font-shim";
import AgentNodeCard from "@/components/canvas/agent-node";
import { CanvasCtx } from "@/components/canvas/canvas-context";
import { RuntimeContext } from "@/lib/runtime/store";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { TooltipProvider } from "@/components/ui/tooltip";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const base = { state: "running", cwd: "/w", createdAt: 0, model: "m" };
const sessions = [
  { ...base, id: "3f2c1b9a-7d4e-4a10-9c55-0b1f6e2a8d11", title: "Lead planner", provider: "claude", role: "orchestrator" },
  { ...base, id: "a91e5c22-12f0-4b7b-8f3a-6d0c4e9b7a02", title: "Builder", provider: "codex", role: "implementer", parentSessionId: "3f2c1b9a-7d4e-4a10-9c55-0b1f6e2a8d11", state: "sleeping" },
  { ...base, id: "c0de0000-0000-4000-8000-00000000f00d", title: "Generalist", provider: "claude", role: "generalist", state: "failed" },
] as never[];
const ctx = {
  recruits: new Map([[(sessions[0] as { id: string }).id, 1]]), liveIds: new Set(), collapsed: new Set(), linkMode: null, live: {}, reducedMotion: true,
  titleOf: () => "", focus() {}, terminalId: null, sentIds: new Set(), highlightId: null, startLink() {}, toggleCollapse() {}, activate() {}, wake() {},
  sendMessage: async () => true, waking: new Set(), linkInfo: { [(sessions[0] as { id: string }).id]: { count: 2, sides: new Set() } },
  deleteLink() {}, keychainCounts: {}, noteCounts: { [(sessions[0] as { id: string }).id]: 1 }, hotIds: new Set(), flashIds: new Set(), savePlacement() {},
} as never;
const runtime = { client: {}, sessions } as never;
const nodes: Node[] = sessions.map((s, i) => ({ id: (s as { id: string }).id, type: "agent", position: { x: 20 + (i % 2) * 480, y: 20 + Math.floor(i / 2) * 200 }, width: 450, height: 180, data: { session: s } }));
const nodeTypes = { agent: AgentNodeCard };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RuntimeContext.Provider value={runtime}><CanvasCtx.Provider value={ctx}><TooltipProvider>
    <ReactFlowProvider>
      <div style={{ width: 960, height: 420 }}><ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} proOptions={{ hideAttribution: true }} nodesDraggable={false} /></div>
    </ReactFlowProvider>
    <div id="avatars" style={{ display: "flex", gap: 12, padding: 12 }}>
      {(sessions as { id: string; provider: "claude" | "codex" }[]).map((s) => <AgentAvatar key={s.id} session={s} size={32} />)}
    </div>
  </TooltipProvider></CanvasCtx.Provider></RuntimeContext.Provider>,
);
