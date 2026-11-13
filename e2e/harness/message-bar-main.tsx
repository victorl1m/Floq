// NodeMessageBar harness: the real bar under RuntimeProvider; the runtime is mocked by Playwright.
import React, { useRef } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { RuntimeProvider } from "@/lib/runtime/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import NodeMessageBar from "@/components/canvas/node-message-bar";
import type { SessionSummary } from "@/lib/runtime/types";

const session = { id: "s1", provider: "claude", title: "Agent", state: "running", cwd: "/", projectId: null, worktreeId: null, branch: null, cols: 80, rows: 24, createdAt: "2026-11-12T00:00:00Z", startedAt: null, endedAt: null, exitCode: null, signal: null, pid: null, seq: 0, bufferedBytes: 0, droppedBytes: 0, resumeCount: 0 } as unknown as SessionSummary;

function Bar() {
  const ref = useRef<HTMLTextAreaElement>(null);
  return <div className="dark w-96 bg-background text-foreground"><NodeMessageBar session={session} inputRef={ref} send={async () => true} /></div>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<RuntimeProvider><TooltipProvider><Bar /></TooltipProvider></RuntimeProvider>);
