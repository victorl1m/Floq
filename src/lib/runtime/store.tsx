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
import { runViewTransition } from "@/lib/view-transition";
import { useUndoDelete } from "@/lib/use-undo-delete";
import { loadUserPreferences, saveUserPreferences, userPreferenceKey, USER_PREFERENCE_DEFAULTS, type UserPreferencePatch, type UserPreferences } from "@/lib/user-preferences";
import type { AuthUser, RuntimeInfo, RuntimeProject, SessionSummary, Organization } from "./types";

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

export type View = "home" | "tasks" | "skills" | "secrets" | "canvas" | "terminal" | "session";

function canTransitionViewChange(from: View, to: View): boolean {
  const simpleView = (view: View) => view === "home" || view === "tasks" || view === "skills" || view === "secrets";
  return from !== to && simpleView(from) && simpleView(to);
}

interface HistoryEntry {
  view: View;
  /** Session id for the "session" view, project id for the "canvas" view. */
  arg: string | null;
}

export interface SignInInput {
  baseUrl: string;
  email: string;
  password: string;
  /** Kept in login state only; accepted with the new session before it is saved. */
  invitationToken?: string;
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
  setupAdmin: (input: SignInInput & { name?: string; companyName?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  organizations: Organization[];
  organizationsLoading: boolean;
  organizationsError: string | null;
  refreshOrganizations: (preferredOrganizationId?: string) => Promise<void>;
  activeOrganizationId: string | null;
  selectOrganization: (organizationId: string) => void;
  userPreferences: UserPreferences;
  updateUserPreferences: (patch: UserPreferencePatch) => void;
  refresh: () => Promise<boolean>;
  upsertSession: (session: SessionSummary) => void;
  /** Select a session and make sure its terminal is opened. */
  openSession: (session: Pick<SessionSummary, "id" | "provider"> & Partial<Pick<SessionSummary, "projectId" | "worktreeId" | "cwd">>, area?: "agent" | "terminal") => void;
  /**
   * A deliberate click on a session (sidebar row or tab). Same as openSession, plus: when the
   * "resume on click" preference is on and the session is asleep, asks its terminal to resume it.
   */
  activateSession: (session: Pick<SessionSummary, "id" | "provider" | "state"> & Partial<Pick<SessionSummary, "projectId" | "worktreeId" | "cwd">>, area?: "agent" | "terminal", options?: { resume?: boolean }) => void;
  /** One-shot resume request raised by activateSession; the session's terminal consumes it. */
  resumeRequest: { id: string; seq: number } | null;
  consumeResumeRequest: (seq: number) => void;
  /** Show a session on its project's Agent Canvas: selects and highlights its node (never resumes it). `dialog` also opens its terminal dialog. */
  focusOnCanvas: (session: Pick<SessionSummary, "id" | "projectId" | "worktreeId" | "provider" | "state"> & Partial<Pick<SessionSummary, "cwd">>, options?: { dialog?: boolean }) => void;
  /** One-shot request raised by focusOnCanvas; the canvas consumes it. */
  canvasFocus: { id: string; seq: number; dialog: boolean } | null;
  consumeCanvasFocus: (seq: number) => void;
  closeTab: (id: string, area?: "agent" | "terminal") => void;
  agentTabIds: string[];
  terminalTabIds: string[];
  selectedTerminalId: string | null;
  selectShell: (id: string | null) => void;
  selectSession: (id: string | null) => void;
  /** Soft delete with Undo (grace period, then the real DELETE). Resolves at once; failures surface as a toast and the session reappears. */
  deleteSession: (id: string) => Promise<void>;
  deleteSessions: (ids: string[]) => void;
  /** Restore the most recent soft delete (Ctrl/Cmd+Z). */
  undoLastDelete: () => void;
  /** Ids hidden while their delete is pending. `sessions`, tabs and selection already exclude them. */
  pendingDeleteIds: ReadonlySet<string>;
  newAgentOpen: boolean;
  newAgentOrigin: "agent" | "terminal";
  setNewAgentOpen: (open: boolean, origin?: "agent" | "terminal") => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  /** True while the last poll of the runtime succeeded. */
  online: boolean;
  view: View;
  /** Project whose Agent Canvas is showing, or null when another view is. */
  canvasProjectId: string | null;
  /** Select a project and open its Agent Canvas. */
  openCanvas: (projectId: string, workspaceId?: string | null) => void;
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
  const [allSessions, setSessions] = useState<SessionSummary[]>([]);
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
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(() => connection !== null);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const organizationsRequest = useRef(0);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  const activeOrganizationIdRef = useRef(activeOrganizationId);
  activeOrganizationIdRef.current = activeOrganizationId;
  const [preferencesState, setPreferencesState] = useState<{ scope: string | null; value: UserPreferences }>({ scope: null, value: USER_PREFERENCE_DEFAULTS });
  const [history, setHistory] = useState<{ stack: HistoryEntry[]; index: number }>({
    stack: [{ view: "home", arg: null }],
    index: 0,
  });
  const view = history.stack[history.index].view;
  /** Project whose canvas is showing (null in every other view). Single source of truth for the canvas's active state. */
  const canvasProjectId = view === "canvas" ? history.stack[history.index].arg : null;
  const historyRef = useRef(history);
  historyRef.current = history;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const navigate = useCallback((next: View, arg?: string | null) => {
    const h = historyRef.current;
    const entry: HistoryEntry = {
      view: next,
      arg: next === "session" ? (arg ?? selectedRef.current) : next === "canvas" ? (arg ?? activeProjectIdRef.current) : null,
    };
    const current = h.stack[h.index];
    if (current.view === entry.view && current.arg === entry.arg) return;
    const stack = [...h.stack.slice(0, h.index + 1), entry];
    const update = () => setHistory({ stack, index: stack.length - 1 });
    if (canTransitionViewChange(current.view, entry.view)) runViewTransition(update, performancePrefs.reduceMotion);
    else update();
  }, [performancePrefs.reduceMotion]);

  const go = useCallback((delta: number) => {
    const h = historyRef.current;
    const index = h.index + delta;
    if (index < 0 || index >= h.stack.length) return;
    const entry = h.stack[index];
    const update = () => {
      if (entry.view === "session") setSelectedId(entry.arg);
      if (entry.view === "canvas" && entry.arg) setActiveProjectId(entry.arg);
      setHistory({ ...h, index });
    };
    const current = h.stack[h.index];
    if (canTransitionViewChange(current.view, entry.view)) runViewTransition(update, performancePrefs.reduceMotion);
    else update();
  }, [performancePrefs.reduceMotion]);
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
    setOrganizations([]);
    setOrganizationsLoading(false);
    setOrganizationsError(null);
    setActiveOrganizationId(null);
    activeOrganizationIdRef.current = null;
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
  const preferenceBaseUrl = connection?.baseUrl ?? null;
  const preferenceUserId = connection?.user.id ?? null;
  const preferenceScope = userPreferenceKey(preferenceBaseUrl, preferenceUserId);
  const userPreferences = preferenceScope && preferencesState.scope === preferenceScope
    ? preferencesState.value
    : loadUserPreferences(preferenceBaseUrl, preferenceUserId);
  const userPreferencesRef = useRef(userPreferences);
  userPreferencesRef.current = userPreferences;
  const updateUserPreferences = useCallback((patch: UserPreferencePatch) => {
    const next = saveUserPreferences(preferenceBaseUrl, preferenceUserId, patch, userPreferencesRef.current);
    userPreferencesRef.current = next;
    setPreferencesState({ scope: preferenceScope, value: next });
  }, [preferenceBaseUrl, preferenceUserId, preferenceScope]);

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

  /** Select a project and show its Agent Canvas. */
  const openCanvas = useCallback((projectId: string, workspaceId?: string | null) => {
    selectProject(projectId, workspaceId);
    navigate("canvas", projectId);
  }, [selectProject, navigate]);

  // Restore the canvas that was open before a reload (once projects are known), then keep the preference in sync.
  const canvasRestored = useRef(false);
  useEffect(() => {
    if (canvasRestored.current || projects.length === 0) return;
    canvasRestored.current = true;
    const id = userPreferencesRef.current.lastCanvasProjectId;
    if (id && historyRef.current.stack[historyRef.current.index].view === "home" && projects.some((project) => project.id === id)) openCanvas(id);
  }, [projects, openCanvas]);
  useEffect(() => {
    if (!canvasRestored.current) return;
    if (userPreferencesRef.current.lastCanvasProjectId !== canvasProjectId) updateUserPreferences({ lastCanvasProjectId: canvasProjectId });
  }, [canvasProjectId, updateUserPreferences]);

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

  const refreshOrganizations = useCallback(async (preferredOrganizationId?: string) => {
    const requestedClient = client;
    const requestedBaseUrl = preferenceBaseUrl;
    const requestedUserId = preferenceUserId;
    const requestId = ++organizationsRequest.current;
    if (!requestedClient || !signedIn) {
      setOrganizations([]); setOrganizationsError(null); setOrganizationsLoading(false);
      setActiveOrganizationId(null); activeOrganizationIdRef.current = null;
      return;
    }
    setOrganizationsLoading(true);
    setOrganizationsError(null);
    try {
      const loaded = await requestedClient.organizations();
      if (organizationsRequest.current !== requestId || clientRef.current !== requestedClient) return;
      setOrganizations(loaded);
      const savedOrganizationId = loadUserPreferences(requestedBaseUrl, requestedUserId).activeOrganizationId;
      const currentOrganizationId = activeOrganizationIdRef.current;
      const nextOrganizationId = preferredOrganizationId && loaded.some((organization) => organization.id === preferredOrganizationId)
        ? preferredOrganizationId
        : loaded.some((organization) => organization.id === currentOrganizationId)
          ? currentOrganizationId
          : loaded.some((organization) => organization.id === savedOrganizationId)
            ? savedOrganizationId
            : loaded[0]?.id ?? null;
      activeOrganizationIdRef.current = nextOrganizationId;
      setActiveOrganizationId(nextOrganizationId);
      if (nextOrganizationId !== savedOrganizationId) updateUserPreferences({ activeOrganizationId: nextOrganizationId });
    } catch (reason) {
      if (organizationsRequest.current === requestId && clientRef.current === requestedClient) setOrganizationsError(errorMessage(reason));
    } finally {
      if (organizationsRequest.current === requestId && clientRef.current === requestedClient) setOrganizationsLoading(false);
    }
  }, [client, preferenceBaseUrl, preferenceUserId, signedIn, updateUserPreferences]);

  const selectOrganization = useCallback((organizationId: string) => {
    if (!organizations.some((organization) => organization.id === organizationId)) return;
    activeOrganizationIdRef.current = organizationId;
    setActiveOrganizationId(organizationId);
    updateUserPreferences({ activeOrganizationId: organizationId });
  }, [organizations, updateUserPreferences]);

  useEffect(() => {
    if (!signedIn) {
      setOrganizations([]); setOrganizationsError(null); setOrganizationsLoading(false);
      setActiveOrganizationId(null); activeOrganizationIdRef.current = null;
      return;
    }
    void refreshOrganizations();
  }, [signedIn, client, refreshOrganizations]);

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
    const runtime = new RuntimeClient(baseUrl);
    const { token, user } = await runtime.signIn(input.email, input.password);
    if (input.invitationToken) await runtime.withToken(token).acceptOrganizationInvitation(input.invitationToken);
    const next: Connection = { baseUrl, token, user };
    saveConnection(next);
    try {
      localStorage.setItem(LAST_URL_KEY, baseUrl);
    } catch {
      /* ignore */
    }
    setOrganizations([]);
    setOrganizationsLoading(true);
    setOrganizationsError(null);
    setActiveOrganizationId(null);
    activeOrganizationIdRef.current = null;
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
    async (input: SignInInput & { name?: string; companyName?: string }) => {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      if (!baseUrl) throw new Error("Enter the runtime URL");
      await new RuntimeClient(baseUrl).setupAdmin(input.email, input.password, input.name, input.companyName);
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
      list.some((s) => s.id === session.id) ? list.map((s) => (s.id === session.id ? { ...session, activity: session.activity ?? (session.state === "running" ? s.activity : undefined) } : s)) : [session, ...list],
    );
  }, []);

  const selectSession = useCallback((id: string | null) => setSelectedId(id), []);

  const openSession = useCallback(
    (session: Pick<SessionSummary, "id" | "provider"> & Partial<Pick<SessionSummary, "projectId" | "worktreeId" | "cwd">>, area?: "agent" | "terminal") => {
      // Only a shell can open in the Terminal view. Anywhere else it joins the project's tab strip
      // next to its agents (and stays listed in the Terminal view too).
      const targetArea = area === "terminal" && session.provider === "shell" ? "terminal" : "agent";
      const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
      if (targetArea === "terminal") {
        // The standalone Terminal view never selects (or clears) the active project.
      } else if (project) {
        setActiveProjectId(project.id);
        const workspace = project.workspaces.find((item) => item.id === session.worktreeId || item.cwd === session.cwd);
        setActiveWorkspaceId(workspace?.id ?? project.workspaces[0]?.id ?? null);
      } else {
        setActiveProjectId(null);
        setActiveWorkspaceId(null);
      }
      setOpenedIds((opened) => (opened.includes(session.id) ? opened : [...opened, session.id]));
      // Opening a session (new, resumed or restored) puts it back in the left sidebar.
      const hidden = userPreferencesRef.current.hiddenSessionIds;
      if (hidden[session.id]) {
        const { [session.id]: _removed, ...rest } = hidden;
        updateUserPreferences({ hiddenSessionIds: rest });
      }
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
    [navigate, projects, updateUserPreferences],
  );
  const [resumeRequest, setResumeRequest] = useState<{ id: string; seq: number } | null>(null);
  const resumeSeq = useRef(0);
  const consumeResumeRequest = useCallback((seq: number) => setResumeRequest((r) => (r && r.seq === seq ? null : r)), []);
  const activateSession = useCallback<RuntimeContextValue["activateSession"]>(
    (session, area, options) => {
      openSession(session, area);
      // Only a sleeping session, and only when the user opted in (or the caller restores it explicitly). Failed/exited sessions are left alone.
      if (session.state === "sleeping" && (options?.resume || loadAutoResumeOnClick())) setResumeRequest({ id: session.id, seq: ++resumeSeq.current });
    },
    [openSession],
  );
  const [canvasFocus, setCanvasFocus] = useState<{ id: string; seq: number; dialog: boolean } | null>(null);
  const canvasFocusSeq = useRef(0);
  const consumeCanvasFocus = useCallback((seq: number) => setCanvasFocus((request) => (request && request.seq === seq ? null : request)), []);
  const focusOnCanvas = useCallback<RuntimeContextValue["focusOnCanvas"]>((session, options) => {
    if (!session.projectId) { activateSession(session); return; }
    // A hidden session comes back into the sidebar, like any other open.
    const hidden = userPreferencesRef.current.hiddenSessionIds;
    if (hidden[session.id]) {
      const { [session.id]: _removed, ...rest } = hidden;
      updateUserPreferences({ hiddenSessionIds: rest });
    }
    setSelectedId(session.id);
    openCanvas(session.projectId, session.worktreeId);
    setCanvasFocus({ id: session.id, seq: ++canvasFocusSeq.current, dialog: !!options?.dialog });
  }, [activateSession, openCanvas, updateUserPreferences]);
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

  /** The real delete, run once the undo grace period is over. "Already gone" counts as success. */
  const performDelete = useCallback(
    async (id: string) => {
      const current = clientRef.current;
      if (!current) throw new Error("Not signed in");
      try {
        await current.deleteSession(id);
      } catch (error) {
        if (!(error instanceof RuntimeError && error.status === 404)) throw error;
      }
      mutation.current++;
      setSessions((list) => list.filter((s) => s.id !== id));
      setAgentTabIds((opened) => opened.filter((o) => o !== id));
      setTerminalTabIds((opened) => opened.filter((o) => o !== id));
      setOpenedIds((opened) => opened.filter((o) => o !== id));
      setSelectedId((current) => (current === id ? null : current));
      setShellId((current) => (current === id ? null : current));
      // Canvas layout is kept through the grace period so Undo restores it; drop it for good now.
      const prefs = userPreferencesRef.current;
      const strip = <T,>(byProject: Record<string, Record<string, T>> | undefined) => {
        if (!byProject) return byProject;
        return Object.fromEntries(Object.entries(byProject).map(([project, map]) => [project, Object.fromEntries(Object.entries(map ?? {}).filter(([key]) => key !== id))]));
      };
      if (Object.values(prefs.canvasPositions ?? {}).some((map) => id in (map ?? {})) || Object.values(prefs.canvasSizes ?? {}).some((map) => id in (map ?? {}))) {
        updateUserPreferences({ canvasPositions: strip(prefs.canvasPositions), canvasSizes: strip(prefs.canvasSizes) } as UserPreferencePatch);
      }
    },
    [updateUserPreferences],
  );
  const sendDeleteOnUnload = useCallback((id: string) => clientRef.current?.deleteSessionKeepalive(id), []);
  const { pendingDeleteIds, deleteSessions: softDeleteSessions, undoLastDelete, announcement } = useUndoDelete({
    performDelete,
    sendOnUnload: sendDeleteOnUnload,
    signedIn: client !== null && ready,
    allSessions,
  });
  const allSessionsRef = useRef(allSessions);
  allSessionsRef.current = allSessions;
  const deleteSessions = useCallback((ids: string[]) => {
    softDeleteSessions(ids.flatMap((id) => allSessionsRef.current.filter((session) => session.id === id)));
  }, [softDeleteSessions]);
  const deleteSession = useCallback(async (id: string) => deleteSessions([id]), [deleteSessions]);

  // Every consumer sees sessions, tabs and selection without the ids whose delete is pending.
  const visibleSessions = useMemo(() => pendingDeleteIds.size === 0 ? allSessions : allSessions.filter((s) => !pendingDeleteIds.has(s.id)), [allSessions, pendingDeleteIds]);
  const visibleOpenedIds = useMemo(() => openedIds.filter((id) => !pendingDeleteIds.has(id)), [openedIds, pendingDeleteIds]);
  const visibleAgentTabIds = useMemo(() => agentTabIds.filter((id) => !pendingDeleteIds.has(id)), [agentTabIds, pendingDeleteIds]);
  const visibleTerminalTabIds = useMemo(() => terminalTabIds.filter((id) => !pendingDeleteIds.has(id)), [terminalTabIds, pendingDeleteIds]);
  const visibleSelectedId = selectedId && pendingDeleteIds.has(selectedId) ? (visibleAgentTabIds[visibleAgentTabIds.length - 1] ?? null) : selectedId;
  const visibleShellId = shellId && pendingDeleteIds.has(shellId) ? (visibleTerminalTabIds[visibleTerminalTabIds.length - 1] ?? null) : shellId;

  const value = useMemo<RuntimeContextValue>(
    () => ({
      ready,
      baseUrl: connection?.baseUrl ?? null,
      client: signedIn ? client : null,
      user: signedIn ? (connection?.user ?? null) : null,
      info,
      sessions: visibleSessions,
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
      selectedId: visibleSelectedId,
      shellId: visibleShellId,
      loaded,
      openedIds: visibleOpenedIds,
      agentTabIds: visibleAgentTabIds,
      terminalTabIds: visibleTerminalTabIds,
      selectedTerminalId: visibleShellId,
      signIn,
      lookup,
      setupAdmin,
      signOut,
      organizations,
      organizationsLoading,
      organizationsError,
      refreshOrganizations,
      activeOrganizationId,
      selectOrganization,
      userPreferences,
      updateUserPreferences,
      refresh,
      upsertSession,
      openSession,
      activateSession,
      resumeRequest,
      consumeResumeRequest,
      focusOnCanvas,
      canvasFocus,
      consumeCanvasFocus,
      closeTab,
      selectShell,
      selectSession,
      deleteSession,
      deleteSessions,
      undoLastDelete,
      pendingDeleteIds,
      newAgentOpen,
      newAgentOrigin,
      setNewAgentOpen: setNewAgentDialog,
      searchOpen,
      setSearchOpen,
      online,
      view,
      canvasProjectId,
      openCanvas,
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
      visibleSessions,
      projects,
      projectsLoading,
      projectsError,
      activeProjectId,
      activeWorkspaceId,
      refreshProjects,
      createProject,
      updateProject,
      selectProject,
      visibleSelectedId,
      visibleShellId,
      loaded,
      visibleOpenedIds,
      visibleAgentTabIds,
      visibleTerminalTabIds,
      signIn,
      lookup,
      setupAdmin,
      signOut,
      organizations,
      organizationsLoading,
      organizationsError,
      refreshOrganizations,
      activeOrganizationId,
      selectOrganization,
      userPreferences,
      updateUserPreferences,
      refresh,
      upsertSession,
      openSession,
      activateSession,
      resumeRequest,
      consumeResumeRequest,
      focusOnCanvas,
      canvasFocus,
      consumeCanvasFocus,
      closeTab,
      selectShell,
      selectSession,
      deleteSession,
      deleteSessions,
      undoLastDelete,
      pendingDeleteIds,
      newAgentOpen,
      newAgentOrigin,
      setNewAgentDialog,
      searchOpen,
      online,
      history,
      canvasProjectId,
      openCanvas,
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

  return (
    <RuntimeContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>
    </RuntimeContext.Provider>
  );
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof RuntimeError && error.status === 401;
}
