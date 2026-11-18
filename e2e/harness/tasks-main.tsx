// Visual comparison harness for the canonical Tasks screen; API responses are supplied by Playwright.
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import BoardsView from "@/components/tasks/boards-view";
import { RuntimeProvider } from "@/lib/runtime/store";
import { PluginsProvider } from "@/plugins/host";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider>
      <RuntimeProvider>
        <PluginsProvider>
          <main className="h-screen min-h-0 bg-background"><BoardsView /></main>
          <Toaster />
        </PluginsProvider>
      </RuntimeProvider>
    </TooltipProvider>
  </React.StrictMode>,
);
