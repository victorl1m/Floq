import { Toaster } from "@/components/ui/sonner";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { AppSidebar } from "./components/app-sidebar";
import LoginScreen from "./components/auth/login-screen";
import NewAgentDialog from "./components/agents/new-agent-dialog";
import TerminalPanel from "./components/agents/terminal-panel";
import RightSidebar from "./components/agents/right-sidebar/right-sidebar";
import { ActivePortWatcher } from "./components/window/port-watcher";
import { PortRequestHost } from "./components/window/port-requests";
import { SubagentToaster } from "./components/canvas/subagent-toaster";
import { CrossProjectToaster } from "./components/window/cross-project-toaster";
import HomeView from "./components/home/home-view";
import SettingsDialog from "./components/settings/settings-dialog";
import { useRuntime } from "./lib/runtime/store";
import SkillsPage from "./components/skills/skills-page";
import SecretsPage from "./components/secrets/secrets-page";
import AgentCanvasPage from "./components/canvas/agent-canvas-page";
import TasksPage from "./components/tasks/tasks-page";
import { useEffect, useLayoutEffect } from "react";
import { useMaterialPreference } from "@/lib/material-preference";
import { usePerformancePrefs } from "@/lib/prefs";
import { Skeleton } from "@/components/ui/skeleton";

function App() {
  const { ready, user, view } = useRuntime();
  const [performancePrefs] = usePerformancePrefs();
  const [material] = useMaterialPreference();
  useLayoutEffect(() => { document.documentElement.dataset.material = material; }, [material]);

  useEffect(() => {
    document.title = view === "tasks" ? "Tasks — Floq" : view === "skills" ? "Skills — Floq" : view === "secrets" ? "Secrets — Floq" : view === "canvas" ? "Canvas — Floq" : view === "terminal" ? "Terminal — Floq" : view === "session" ? "Agent — Floq" : "Floq";
  }, [view]);

  useEffect(() => {
    document.documentElement.classList.toggle("floq-reduced-motion", performancePrefs.reduceMotion);
    return () => document.documentElement.classList.remove("floq-reduced-motion");
  }, [performancePrefs.reduceMotion]);

  return (
    <TooltipProvider>
      {user && <AppSidebar />}
      <main className="workspace-frame workspace-surface workspace-view relative min-w-0 flex-1 overflow-hidden">
        {!ready ? (
          <div className="absolute inset-0 overflow-y-auto px-5 py-8 sm:px-10 lg:px-14 lg:py-12" role="status" aria-label="Loading Floq workspace" aria-busy="true">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
              <div className="flex justify-between border-b border-border/60 pb-5"><Skeleton rows={1} className="h-4 w-20" /><Skeleton rows={1} className="h-7 w-24" /></div>
              <div className="space-y-3"><Skeleton rows={1} className="h-9 w-64 max-w-full" /><Skeleton rows={1} className="h-4 w-96 max-w-full" /></div>
              <div className="material-content space-y-5 rounded-2xl p-5"><Skeleton rows={1} className="h-4 w-12" /><Skeleton rows={1} className="h-3 w-3/4" /><div className="h-16" /><div className="flex justify-between border-t border-border/60 pt-4"><Skeleton rows={1} className="h-7 w-32" /><Skeleton rows={1} className="h-8 w-28" /></div></div>
              <div className="grid gap-8 md:grid-cols-2">{[0, 1].map((column) => <div key={column} className="space-y-5"><Skeleton rows={1} className="h-4 w-24" />{[0, 1, 2].map((row) => <Skeleton key={row} rows={1} className="h-4 w-3/4" />)}</div>)}</div>
              <span className="sr-only">Loading workspace?</span>
            </div>
          </div>
        ) : user ? (
          <>
            {view === "home" && <HomeView />}
            {view === "tasks" && <div className="absolute inset-0 overflow-hidden"><TasksPage /></div>}
            {view === "canvas" && <div className="absolute inset-0 overflow-hidden"><AgentCanvasPage /></div>}
            {view === "skills" && <div className="absolute inset-0 overflow-y-auto"><SkillsPage /></div>}
            {view === "secrets" && <div className="absolute inset-0 overflow-y-auto"><SecretsPage /></div>}
            {/* Kept mounted so xterm scrollback survives switching views. */}
            <div className={view === "home" || view === "tasks" || view === "canvas" || view === "skills" || view === "secrets" ? "hidden" : "absolute inset-0"}>
              <TerminalPanel />
            </div>
          </>
        ) : null}
      </main>
      {user && ready && <RightSidebar />}
      {user && ready && <ActivePortWatcher />}
      {user && ready && <PortRequestHost />}
      {user && ready && <SubagentToaster />}
      {user && ready && <CrossProjectToaster />}
      {ready && !user && <LoginScreen />}
      {user && (
        <>
          <NewAgentDialog />
          <SettingsDialog />
        </>
      )}
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
