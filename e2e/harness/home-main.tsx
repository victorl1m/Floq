// Test harness: the real HomeView with a stub runtime context (Playwright only; not part of the app bundle).
// ?theme=dark  ?material=solid  ?data=empty|filled  ?providers=none
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import "./font-shim";
import HomeView from "@/components/home/home-view";
import { RuntimeContext } from "@/lib/runtime/store";
import { RuntimeError } from "@/lib/runtime/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const q = new URLSearchParams(location.search);
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
if (q.get("material")) document.documentElement.dataset.material = q.get("material")!;
const long = q.get("data") === "long";
const filled = q.get("data") === "filled" || long;
const noProviders = q.get("providers") === "none";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ws = (id: string, branch: string) => ({ id, name: branch, branch, isWorktree: false });
const projects = filled ? [
  { id: "p1", name: "floq", displayName: "Floq", imageUrl: null, iconName: null, iconColor: null, gitUrl: null, cwd: "/p/floq", createdAt: ago(9000), workspaces: [ws("w1", "main")] },
  { id: "p2", name: "api-gateway", displayName: null, imageUrl: null, iconName: null, iconColor: null, gitUrl: null, cwd: "/p/api", createdAt: ago(9000), workspaces: [ws("w2", long ? "feature/very-long-branch-name-for-the-rate-limiting-rollout-in-the-public-api-gateway-2026" : "feat/rate-limits")] },
  { id: "p3", name: "marketing-site", displayName: "Marketing site", imageUrl: null, iconName: null, iconColor: null, gitUrl: null, cwd: "/p/site", createdAt: ago(9000), workspaces: [ws("w3", "main")] },
] : [];
const session = (id: string, title: string, provider: "claude" | "codex", state: string, projectId: string, min: number, role: string | null = null) =>
  ({ id, title, provider, state, projectId, role, cwd: "/p", cols: 80, rows: 24, createdAt: ago(min), startedAt: ago(min), endedAt: null, exitCode: null, signal: null, pid: 1, seq: 0, bufferedBytes: 0, droppedBytes: 0, resumeCount: 0, sleepReason: null });
const sessions = filled ? [
  session("3f2c1b9a-7d4e-4a10-9c55-0b1f6e2a8d11", "Orchestrator", "claude", "running", "p1", 3, "orchestrator"),
  session("a91e5c22-12f0-4b7b-8f3a-6d0c4e9b7a02", long ? "Haiku exploration, Sonnet implementer, Opus advisor orchestration across the whole monorepo with a very long title" : "Add rate limiting to the public API", "codex", "running", "p2", 12),
  session("c0de0000-0000-4000-8000-00000000f00d", "Fix flaky login test", "claude", "sleeping", "p1", 95),
  session("b7a1f0e2-3c4d-4e5f-8a9b-0c1d2e3f4a5b", "Redesign pricing page hero", "claude", "exited", "p3", 60 * 26),
] : [];

const calls: Array<{ name: string; args: unknown }> = [];
(window as unknown as { __calls: typeof calls }).__calls = calls;
const client = {
  providersStatus: async () => {
    if (noProviders) return { claude: { connected: false }, codex: { connected: false } };
    throw new RuntimeError(404, "not_found", "no status endpoint");
  },
  settings: async () => ({ autoApproveAcknowledged: true }),
  sessions: async () => sessions,
  createSession: async (input: unknown) => { calls.push({ name: "createSession", args: input }); return session(`new-${calls.length}`, "New", "claude", "running", "p1", 0); },
};
const info = {
  server: { providers: ["claude", "codex"] },
  providers: [
    { id: "claude", available: true, models: [{ id: "default", label: "Default" }, { id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
    { id: "codex", available: true, models: [{ id: "default", label: "Default" }] },
  ],
  githubConfigured: false,
};

function App() {
  const [active, setActive] = useState<{ p: string | null; w: string | null }>({ p: filled ? "p1" : null, w: filled ? "w1" : null });
  const value = {
    client, info, sessions, projects, projectsLoading: false,
    user: { id: "u1", name: "Victor Lima", email: "victor@example.test" },
    activeProjectId: active.p, activeWorkspaceId: active.w,
    selectProject: (p: string | null, w?: string | null) => { calls.push({ name: "selectProject", args: [p, w] }); setActive({ p, w: w ?? null }); },
    openCanvas: (p: string, w?: string | null) => calls.push({ name: "openCanvas", args: [p, w] }),
    focusOnCanvas: (s: { id: string }) => calls.push({ name: "focusOnCanvas", args: s.id }),
    upsertSession: () => {}, refresh: async () => true, createProject: async () => projects[0],
  } as never;
  return (
    <RuntimeContext.Provider value={value}>
      <TooltipProvider>
        <div style={{ position: "fixed", inset: 0, background: "var(--background)" }}><HomeView /></div>
        <Toaster />
      </TooltipProvider>
    </RuntimeContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
