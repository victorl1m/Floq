import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RuntimeClient, RuntimeError, normalizeBaseUrl } from "./client";
import { ProjectRefreshCoordinator } from "./project-refresh";
import { loadAutoResumeOnClick, runtimePollInterval, usePerformancePrefs } from "@/lib/prefs";
import type { AuthUser, RuntimeInfo, RuntimeProject, SessionSummary } from "./types";

const STORAGE_KEY = "floq.connection";

interface Connection {
  baseUrl: string;
  token: string;
  user: AuthUser;
}

function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Connection>;
    if (value.baseUrl && value.token && value.user?.email) return value as Connection;
  } catch {
    /* storage unavailable or corrupt */
  }
  return null;
}

function saveConnection(connection: Connection | null) {
  try {
    if (connection) localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

const LAST_URL_KEY = "floq.lastUrl";

/** Runtime URL to prefill: build-time default, else the last one used. */
export function defaultBaseUrl(): string {
  const env = import.meta.env.VITE_FLOQ_RUNTIME_URL?.trim();
  if (env) return env;
  try {
    return localStorage.getItem(LAST_URL_KEY) ?? "";
  } catch {
    return "";
  }
}

export type View = "home" | "tasks" | "skills" | "secrets" | "terminal" | "session";

interface HistoryEntry {
  view: View;
  /** Session id for the "session" view. */
  arg: string | null;
}

export interface SignInInput {
  baseUrl: string;
  email: string;
  password: string;
}

interface RuntimeContextValue {
  /** False while a stored token is being validated at startup. */
  ready: boolean;
  baseUrl: string | null;
  client: RuntimeClient | null;
  user: AuthUser | null;
  info: RuntimeInfo | null;
  sessions: SessionSummary[];
  projects: RuntimeProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  retryProjects: () => Promise<void>;
  activeProjectId: string | null;
  activeWorkspaceId: string | null;
  activeWorkspaceCwd: string | null;
  refreshProjects: (force?: boolean) => Promise<void>;
  createProject: (input: { gitUrl: string; name?: string }) => Promise<RuntimeProject>;
  updateProject: (id: string, patch: { displayName?: string | null; imageUrl?: string | null }) => Promise<RuntimeProject>;
  selectProject: (id: string | null, workspaceId?: string | null) => void;
  /** Selected agent session (shown in the "session" view). */
  selectedId: string | null;
  /** Selected shell session (shown in the "terminal" view). */
  shellId: string | null;
  /** True once the first session list has been fetched. */
  loaded: boolean;
  openedIds: string[];
  signIn: (input: SignInInput) => Promise<void>;
  lookup: (baseUrl: string, email: string) => Promise<"setup" | "password">;
  setupAdmin: (input: SignInInput & { name?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<boolean>;
  upsertSession: (session: SessionSummary) => void;
  /** Select a session and make sure its terminal is opened. */
  openSession: (session: Pick<SessionSummary, "id" | "provider"> & Partial<Pick<SessionSummary, "projectId" | "worktreeId" | "cwd">>, area?: "agent" | "terminal") => void;
  /**
   * A deliberate click on a session (sidebar row or tab). Same as openSession, plus: when the
   * "resume on click" preference is on and the session is asleep, asks its terminal to resume it.
   */
  activateSession: (session: Pick<SessionSummary, "id" | "provider" | "state"> & Partial<Pick<SessionSummary, "projectId" | "worktreeId" | "cwd">>, area?: "agent" | "terminal") => void;
  /** One-shot resume request raised by activateSession; the session's terminal consumes it. */
  resumeRequest: { id: string; seq: number } | null;
  consumeResumeRequest: (seq: number) => void;
  closeTab: (id: string, area?: "agent" | "terminal") => void;
  agentTabIds: string[];
  terminalTabIds: string[];
  selectedTerminalId: string | null;
  selectShell: (id: string | null) => void;
  selectSession: (id: string | null) => void;
  deleteSession: (id: string) => Promise<void>;
  newAgentOpen: boolean;
  newAgentOrigin: "agent" | "terminal";
  setNewAgentOpen: (open: boolean, origin?: "agent" | "terminal") => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  /** True while the last poll of the runtime succeeded. */
  online: boolean;
  view: View;
  navigate: (view: View, arg?: string | null) => void;
  openSettings: (section?: string) => void;
  settingsSection: string;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  patchUser: (patch: Partial<AuthUser>) => void;
  /** Set by "Change server": the login screen opens with the URL field editable. */
  changeServer: boolean;
  requestServerChange: () => Promise<void>;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export function useRuntime(): RuntimeContextValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("useRuntime must be used inside <RuntimeProvider>");
  return value;
}

/** Client for components that only render while signed in. */
export function useClient(): RuntimeClient {
  const { client } = useRuntime();
  if (!client) throw new Error("Not signed in");
  return client;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [performancePrefs] = usePerformancePrefs();
  const [connection, setConnection] = useState<Connection | null>(loadConnection);
  const [ready, setReady] = useState(() => connection === null);
  const [info, setInfo] = useState<RuntimeInfo | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<RuntimeProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const projectsLoaded = useRef(false);
  const projectsRefresh = useRef(new ProjectRefreshCoordinator<RuntimeClient>());
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shellId, setShellId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openedIds, setOpenedIds] = useState<string[]>([]);
  const [agentTabIds, setAgentTabIds] = useState<string[]>([]);
  const [terminalTabIds, setTerminalTabIds] = useState<string[]>([]);
  const [newAgentOrigin, setNewAgentOrigin] = useState<"agent" | "terminal">("agent");
  const [changeServer, setChangeServer] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const [history, setHistory] = useState<{ stack: HistoryEntry[]; index: number }>({
    stack: [{ view: "home", arg: null }],
    index: 0,
  });
  const view = history.stack[history.index].view;
  const historyRef = useRef(history);
  historyRef.current = history;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const navigate = useCallback((next: View, arg?: string | null) => {
    const h = historyRef.current;
    const entry: HistoryEntry = {
      view: next,
      arg: next === "session" ? (arg ?? selectedRef.current) : null,
    };
    const current = h.stack[h.index];
    if (current.view === entry.view && current.arg === entry.arg) return;
    const stack = [...h.stack.slice(0, h.index + 1), entry];
    setHistory({ stack, index: stack.length - 1 });
  }, []);

  const go = useCallback((delta: number) => {
    const h = historyRef.current;
    const index = h.index + delta;
    if (index < 0 || index >= h.stack.length) return;
    const entry = h.stack[index];
    if (entry.view === "session") setSelectedId(entry.arg);
    setHistory({ ...h, index });
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("account");
  const openSettings = useCallback((section?: string) => {
    if (section === "skills" || section === "secrets" || section === "vault") {
      setSettingsOpen(false);
      navigate(section === "skills" ? "skills" : "secrets");
      return;
    }
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  }, [navigate]);
  const goBack = useCallback(() => go(-1), [go]);
  const goForward = useCallback(() => go(1), [go]);

  // Bumped on every local mutation so an in-flight poll cannot overwrite fresher data.
  const mutation = useRef(0);

  const signOutLocal = useCallback(() => {
    saveConnection(null);
    mutation.current++;
    setConnection(null);
    setInfo(null);
    setSessions([]);
    setProjects([]);
    projectsLoaded.current = false;
    projectsRefresh.current.reset();
    setProjectsLoading(false);
    setProjectsError(null);
    setActiveProjectId(null);
    setActiveWorkspaceId(null);
    setSelectedId(null);
    setShellId(null);
    setLoaded(false);
    setOpenedIds([]);
    setAgentTabIds([]);
    setTerminalTabIds([]);
    setNewAgentOpen(false);
    setSearchOpen(false);
    setSettingsOpen(false);
    setHistory({ stack: [{ view: "home", arg: null }], index: 0 });
    setReady(true);
  }, []);
  const signOutLocalRef = useRef(signOutLocal);
  signOutLocalRef.current = signOutLocal;

  const client = useMemo(
    () =>
      connection
        ? new RuntimeClient(connection.baseUrl, connection.token, () => signOutLocalRef.current())
        : null,
    [connection?.baseUrl, connection?.token], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const clientRef = useRef(client);
  clientRef.current = client;

  // Validate the stored token once at startup.
  useEffect(() => {
    if (!client || ready) return;
    let cancelled = false;
    client
      .currentUser()
      .then((user) => {
        if (cancelled) return;
        if (!user) signOutLocal();
        else {
          setConnection((c) => (c ? { ...c, user } : c));
          setReady(true);
        }
      })
      .catch(() => {
        // 401 already signed out; on network errors stay signed in and let polling recover.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, ready, signOutLocal]);

  const applySessions = useCallback((list: SessionSummary[]) => {
    setSessions(list);
    const ids = new Set(list.map((s) => s.id));
    setOpenedIds((opened) => (opened.every((id) => ids.has(id)) ? opened : opened.filter((id) => ids.has(id))));
    setAgentTabIds((opened) => opened.filter((id) => ids.has(id)));
    setTerminalTabIds((opened) => opened.filter((id) => ids.has(id)));
    setSelectedId((id) => (id && !ids.has(id) ? null : id));
    setShellId((id) => (id && !ids.has(id) ? null : id));
    setLoaded(true);
  }, []);

  const failures = useRef(0);
  const pollInFlight = useRef(false);

  const refreshProjects = useCallback(async (force = false) => {
    if (!client) { setProjects([]); return; }
    await projectsRefresh.current.refresh({
      client,
      force,
      isCurrentClient: (requestClient) => clientRef.current === requestClient,
      fetch: () => client.projects(),
      onStart: () => { if (!projectsLoaded.current) setProjectsLoading(true); },
      onSuccess: (list) => {
        projectsLoaded.current = true;
        setProjectsError(null);
        setProjects(list);
        const selectedProject = list.find((project) => project.id === activeProjectIdRef.current) ?? null;
        setActiveProjectId(selectedProject?.id ?? null);
        setActiveWorkspaceId((workspaceId) => selectedProject && selectedProject.workspaces.some((workspace) => workspace.id === workspaceId)
          ? workspaceId
          : selectedProject?.workspaces.find((workspace) => !workspace.isWorktree)?.id ?? selectedProject?.workspaces[0]?.id ?? null);
      },
      onError: (error) => setProjectsError(errorMessage(error)),
      onSettled: () => setProjectsLoading(false),
    });
  }, [client]);

  const retryProjects = useCallback(() => refreshProjects(true), [refreshProjects]);

  const createProject = useCallback(async (input: { gitUrl: string; name?: string }) => {
    if (!client) throw new Error("Not signed in");
    const project = await client.createProject(input);
    projectsRefresh.current.markMutation();
    projectsLoaded.current = true;
    setProjectsLoading(false);
    setProjectsError(null);
    setProjects((list) => [project, ...list.filter((item) => item.id !== project.id)]);
    setActiveProjectId(project.id);
    setActiveWorkspaceId(project.workspaces[0]?.id ?? null);
    return project;
  }, [client]);

  const updateProject = useCallback(async (id: string, patch: { displayName?: string | null; imageUrl?: string | null }) => {
    if (!client) throw new Error("Not signed in");
    const project = await client.updateProject(id, patch);
    projectsRefresh.current.markMutation();
    setProjectsLoading(false);
    setProjects((list) => list.map((item) => item.id === id ? project : item));
    return project;
  }, [client]);

  const selectProject = useCallback((id: string | null, workspaceId?: string | null) => {
    setActiveProjectId(id);
    setActiveWorkspaceId(workspaceId ?? (id ? projects.find((project) => project.id === id)?.workspaces[0]?.id ?? null : null));
  }, [projects]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!client) return true;
    const stamp = mutation.current;
    try {
      void refreshProjects().catch(() => {});
      const list = await client.sessions();
      failures.current = 0;
      setOnline(true);
      if (stamp === mutation.current) applySessions(list);
      return true;
    } catch {
      failures.current++;
      setOnline(false); // transient; 401 is handled by the client callback
      return false;
    }
  }, [client, applySessions, refreshProjects]);

  const signedIn = client !== null && ready;

  useEffect(() => {
    if (!client || !signedIn) return;
    let cancelled = false;
    const refreshInfo = () => {
      void client
        .info()
        .then((value) => {
          if (!cancelled) setInfo(value);
        })
        .catch(() => {});
    };
    refreshInfo();
    const infoTimer = setInterval(refreshInfo, 5 * 60_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (cancelled) return;
      clearTimeout(timer);
      const base = runtimePollInterval(document.hidden, performancePrefs.reduceBackgroundRefresh);
      timer = setTimeout(() => void tick(), Math.min(30_000, base * 2 ** Math.min(failures.current, 3)));
    };
    // Foreground defaults to 5s. The device-only preference backs hidden-window metadata polling off to 30s.
    const tick = async () => {
      if (cancelled) return;
      if (pollInFlight.current) {
        schedule();
        return;
      }
      pollInFlight.current = true;
      try {
        await refresh();
      } finally {
        pollInFlight.current = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) schedule();
      else {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(infoTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, signedIn, refresh, performancePrefs.reduceBackgroundRefresh]);

  const signIn = useCallback(async (input: SignInInput) => {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    if (!baseUrl) throw new Error("Enter the runtime URL");
    const { token, user } = await new RuntimeClient(baseUrl).signIn(input.email, input.password);
    const next: Connection = { baseUrl, token, user };
    saveConnection(next);
    try {
      localStorage.setItem(LAST_URL_KEY, baseUrl);
    } catch {
      /* ignore */
    }
    setConnection(next);
    setChangeServer(false);
    setReady(true);
  }, []);

  const lookup = useCallback(async (rawUrl: string, email: string) => {
    const baseUrl = normalizeBaseUrl(rawUrl);
    if (!baseUrl) throw new Error("Enter the runtime URL");
    return (await new RuntimeClient(baseUrl).setupLookup(email)).step;
  }, []);

  const setupAdmin = useCallback(
    async (input: SignInInput & { name?: string }) => {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      if (!baseUrl) throw new Error("Enter the runtime URL");
      await new RuntimeClient(baseUrl).setupAdmin(input.email, input.password, input.name);
      await signIn(input);
    },
    [signIn],
  );

  const signOut = useCallback(async () => {
    try {
      await client?.signOut();
    } catch {
      /* best effort */
    }
    signOutLocal();
  }, [client, signOutLocal]);

  const patchUser = useCallback((patch: Partial<AuthUser>) => {
    setConnection((c) => {
      if (!c) return c;
      const next = { ...c, user: { ...c.user, ...patch } };
      saveConnection(next);
      return next;
    });
  }, []);

  const requestServerChange = useCallback(async () => {
    await signOut();
    setChangeServer(true);
  }, [signOut]);

  const upsertSession = useCallback((session: SessionSummary) => {
    mutation.current++;
    setSessions((list) =>
      list.some((s) => s.id === session.id) ? list.map((s) => (s.id === session.id ? session : s)) : [session, ...list],
    );
  }, []);

  const selectSession = useCallback((id: string | null) => setSelectedId(id), []);

  const openSession = useCallback(
    (session: Pick<SessionSummary, "id" | "provider"> & Partial<Pick<SessionSummary, "projectId" | "worktreeId" | "cwd">>, area?: "agent" | "terminal") => {
      // Only a shell can open in the Terminal view. Anywhere else it joins the project's tab strip
      // next to its agents (and stays listed in the Terminal view too).
      const targetArea = area === "terminal" && session.provider === "shell" ? "terminal" : "agent";
      const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
      if (project) {
        setActiveProjectId(project.id);
        const workspace = project.workspaces.find((item) => item.id === session.worktreeId || item.cwd === session.cwd);
        setActiveWorkspaceId(workspace?.id ?? project.workspaces[0]?.id ?? null);
      } else {
        setActiveProjectId(null);
        setActiveWorkspaceId(null);
      }
      setOpenedIds((opened) => (opened.includes(session.id) ? opened : [...opened, session.id]));
      if (targetArea === "terminal") {
        setTerminalTabIds((opened) => opened.includes(session.id) ? opened : [...opened, session.id]);
        setShellId(session.id);
        navigate("terminal");
      } else {
        setAgentTabIds((opened) => opened.includes(session.id) ? opened : [...opened, session.id]);
        if (session.provider === "shell") {
          setTerminalTabIds((opened) => opened.includes(session.id) ? opened : [...opened, session.id]);
          setShellId(session.id);
        }
        setSelectedId(session.id);
        navigate("session", session.id);
      }
    },
    [navigate, projects],
  );
  const [resumeRequest, setResumeRequest] = useState<{ id: string; seq: number } | null>(null);
  const resumeSeq = useRef(0);
  const consumeResumeRequest = useCallback((seq: number) => setResumeRequest((r) => (r && r.seq === seq ? null : r)), []);
  const activateSession = useCallback<RuntimeContextValue["activateSession"]>(
    (session, area) => {
      openSession(session, area);
      // Only a sleeping session, and only when the user opted in. Failed/exited sessions are left alone.
      if (session.state === "sleeping" && loadAutoResumeOnClick()) setResumeRequest({ id: session.id, seq: ++resumeSeq.current });
    },
    [openSession],
  );
  // Read through refs so a close that finishes after an await (agent tabs sleep first) never
  // writes back a tab list from before the await.
  const agentTabsRef = useRef(agentTabIds);
  agentTabsRef.current = agentTabIds;
  const terminalTabsRef = useRef(terminalTabIds);
  terminalTabsRef.current = terminalTabIds;
  const closeTab = useCallback((id: string, area?: "agent" | "terminal") => {
    const agentTabIds = agentTabsRef.current;
    const terminalTabIds = terminalTabsRef.current;
    const nextAgents = area === "terminal" ? agentTabIds : agentTabIds.filter((tabId) => tabId !== id);
    const nextTerminals = area === "agent" ? terminalTabIds : terminalTabIds.filter((tabId) => tabId !== id);
    setAgentTabIds(nextAgents);
    setTerminalTabIds(nextTerminals);
    if (!selectedRef.current || !nextAgents.includes(selectedRef.current)) setSelectedId(nextAgents[nextAgents.length - 1] ?? null);
    setShellId((current) => current && nextTerminals.includes(current) ? current : nextTerminals[nextTerminals.length - 1] ?? null);
    setOpenedIds([...new Set([...nextAgents, ...nextTerminals])]);
  }, []);
  const selectShell = useCallback((id: string | null) => {
    setShellId(id);
    if (id) setTerminalTabIds((opened) => opened.includes(id) ? opened : [...opened, id]);
  }, []);

  const setNewAgentDialog = useCallback((open: boolean, origin?: "agent" | "terminal") => {
    if (open) setNewAgentOrigin(origin ?? "agent");
    setNewAgentOpen(open);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      if (!client) return;
      await client.deleteSession(id);
      mutation.current++;
      setSessions((list) => list.filter((s) => s.id !== id));
      setAgentTabIds((opened) => opened.filter((o) => o !== id));
      setTerminalTabIds((opened) => opened.filter((o) => o !== id));
      setOpenedIds((opened) => opened.filter((o) => o !== id));
      setSelectedId((current) => (current === id ? null : current));
      setShellId((current) => (current === id ? null : current));
      void refresh();
    },
    [client, refresh],
  );

  const value = useMemo<RuntimeContextValue>(
    () => ({
      ready,
      baseUrl: connection?.baseUrl ?? null,
      client: signedIn ? client : null,
      user: signedIn ? (connection?.user ?? null) : null,
      info,
      sessions,
      projects,
      projectsLoading,
      projectsError,
      retryProjects,
      activeProjectId,
      activeWorkspaceId,
      activeWorkspaceCwd: projects.find((p) => p.id === activeProjectId)?.workspaces.find((w) => w.id === activeWorkspaceId)?.cwd ?? null,
      refreshProjects,
      createProject,
      updateProject,
      selectProject,
      selectedId,
      shellId,
      loaded,
      openedIds,
      agentTabIds,
      terminalTabIds,
      selectedTerminalId: shellId,
      signIn,
      lookup,
      setupAdmin,
      signOut,
      refresh,
      upsertSession,
      openSession,
      activateSession,
      resumeRequest,
      consumeResumeRequest,
      closeTab,
      selectShell,
      selectSession,
      deleteSession,
      newAgentOpen,
      newAgentOrigin,
      setNewAgentOpen: setNewAgentDialog,
      searchOpen,
      setSearchOpen,
      online,
      view,
      navigate,
      openSettings,
      settingsSection,
      settingsOpen,
      setSettingsOpen,
      patchUser,
      changeServer,
      requestServerChange,
      canGoBack: history.index > 0,
      canGoForward: history.index < history.stack.length - 1,
      goBack,
      goForward,
    }),
    [
      ready,
      connection,
      signedIn,
      client,
      info,
      sessions,
      projects,
      projectsLoading,
      projectsError,
      activeProjectId,
      activeWorkspaceId,
      refreshProjects,
      createProject,
      updateProject,
      selectProject,
      selectedId,
      shellId,
      loaded,
      openedIds,
      agentTabIds,
      terminalTabIds,
      signIn,
      lookup,
      setupAdmin,
      signOut,
      refresh,
      upsertSession,
      openSession,
      activateSession,
      resumeRequest,
      consumeResumeRequest,
      closeTab,
      selectShell,
      selectSession,
      deleteSession,
      newAgentOpen,
      newAgentOrigin,
      setNewAgentDialog,
      searchOpen,
      online,
      history,
      navigate,
      openSettings,
      settingsSection,
      settingsOpen,
      setSettingsOpen,
      patchUser,
      changeServer,
      requestServerChange,
      goBack,
      goForward,
    ],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof RuntimeError && error.status === 401;
}
