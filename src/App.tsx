import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { AppSidebar } from "./components/app-sidebar";
import LoginScreen from "./components/auth/login-screen";
import NewAgentDialog from "./components/agents/new-agent-dialog";
import TerminalPanel from "./components/agents/terminal-panel";
import HomeView from "./components/home/home-view";
import SettingsDialog from "./components/settings/settings-dialog";
import { useRuntime } from "./lib/runtime/store";
import SkillsPage from "./components/skills/skills-page";
import SecretsPage from "./components/secrets/secrets-page";
import TasksPage from "./components/tasks/tasks-page";
import { useEffect } from "react";
import { usePerformancePrefs } from "@/lib/prefs";

function App() {
  const { ready, user, view } = useRuntime();
  const [performancePrefs] = usePerformancePrefs();

  useEffect(() => {
    document.title = view === "tasks" ? "Tasks — Floq" : view === "skills" ? "Skills — Floq" : view === "secrets" ? "Secrets — Floq" : view === "terminal" ? "Terminal — Floq" : view === "session" ? "Agent — Floq" : "Floq";
  }, [view]);

  useEffect(() => {
    document.documentElement.classList.toggle("floq-reduced-motion", performancePrefs.reduceMotion);
    return () => document.documentElement.classList.remove("floq-reduced-motion");
  }, [performancePrefs.reduceMotion]);

  return (
    <TooltipProvider>
      {user && <AppSidebar />}
      <main className="relative mt-[48px]! min-w-0 flex-1 overflow-hidden">
        {!ready ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        ) : user ? (
          <>
            {view === "home" && <HomeView />}
            {view === "tasks" && <div className="absolute inset-0 overflow-hidden"><TasksPage /></div>}
            {view === "skills" && <div className="absolute inset-0 overflow-y-auto"><SkillsPage /></div>}
            {view === "secrets" && <div className="absolute inset-0 overflow-y-auto"><SecretsPage /></div>}
            {/* Kept mounted so xterm scrollback survives switching views. */}
            <div className={view === "home" || view === "tasks" || view === "skills" || view === "secrets" ? "hidden" : "absolute inset-0"}>
              <TerminalPanel />
            </div>
          </>
        ) : null}
      </main>
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
