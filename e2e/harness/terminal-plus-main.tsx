// Terminal view harness: the real TerminalPanel under RuntimeProvider with a titlebar slot; the runtime is mocked by Playwright.
import React, { useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import { RuntimeProvider, useRuntime } from "@/lib/runtime/store";
import { setTitlebarSlot } from "@/lib/titlebar-slot";
import { TooltipProvider } from "@/components/ui/tooltip";
import TerminalPanel from "@/components/agents/terminal-panel";

function Go() {
  const { navigate, loaded } = useRuntime();
  const done = useRef(false);
  useEffect(() => { if (loaded && !done.current) { done.current = true; navigate("terminal"); } }, [loaded, navigate]);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RuntimeProvider><TooltipProvider>
    <div className="dark flex h-screen flex-col bg-background text-foreground">
      <div ref={setTitlebarSlot} data-testid="titlebar" className="flex h-9 items-center gap-1 border-b px-2" />
      <div className="relative min-h-0 flex-1"><TerminalPanel /></div>
    </div>
    <Go />
  </TooltipProvider></RuntimeProvider>,
);
