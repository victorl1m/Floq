import type { BrowserData, BrowserEgress, BrowserImportPreview, BrowserImportResult, BrowserStatus } from "./browser-types";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  PluginRepoPreview,
  PluginUpdateNotice,
  AgentLink,
  BrowserLink,
  CanvasNote,
  Memory,
  MemoryEvent,
  MemoryGraph,
  MemoryInput,
  MemoryPatch,
  MemoryStatus,
  MemoryType,
  CanvasNoteInput,
  AgentMessageEvent,
  AgentRole,
  AuthUser,
  CreateSessionInput,
  DeviceFlow,
  ClaudeOAuthResult,
  ClaudeConnectors,
  ClaudeOAuthStart,
  DevicePoll,
  PortRequest,
  ApprovalRequest,
  DecisionView,
  DecisionAnswer,
  GithubRepoPage,
  Exposure,
  RuntimeInfo,
  RuntimeProject,
  WorktreeDeleteResult,
  WorktreeDeleteStatus,
  ProjectDeleteResult,
  ProjectDeleteStatus,
  ProjectFoldersDoc,
  ProjectFoldersState,
  RuntimeSkill,
  McpProviderChoice,
  McpNewSecret,
  McpServerDraft,
  RuntimeMcpServer,
  RuntimeSkillCatalogItem,
  RuntimeSkillFile,
  RuntimeSkillCatalogPreview,
  SecretInfo,
  LoginProviderId,
  ProvidersStatus,
  ProvidersUsage,
  SessionPort,
  SessionDisplay,
  SessionDebugLink,
  SessionSummary,
  SettingsPatch,
  ClaudeAccount,
  FallbackActionResult,
  SubagentPolicy,
  UserSettings,
  Organization,
  SlugAvailability,
  OrganizationInvitation,
  IssuedOrganizationInvitation,
  IncomingOrganizationInvitation,
  TaskBoard,
  PluginInfo,
  PluginSecretMigration,
  PluginSecretStatus,
  PluginSettingValues,
  TaskSourceInfo,
  ExternalTask,
  ExternalTaskPage,
  PluginCatalogItem,
  AgentConversation,
} from "./types";
import type { GitChanges, GitFileDiff } from "./git-review";
import type { ArtifactListing, FileContent, FileListing } from "./workspace-files";
import type { AdminUser, UpdateResult, UpdatesStatus, UpdateTarget, UserRole } from "./admin-types";

function skillFileParams(skill: { scope: string; projectId?: string | null; provider: string; source: string; location: string }, path?: string): URLSearchParams {
  const params = new URLSearchParams({ scope: skill.scope, provider: skill.provider, source: skill.source, location: skill.location });
  if (skill.projectId) params.set("projectId", skill.projectId);
  if (path !== undefined) params.set("path", path);
  return params;
}

import type { CatchUp, ProjectAutomation, ProjectTask, ProjectTaskEvent, ProjectTaskSettings, Schedule, TaskPriority } from "@/lib/project-tasks";

export class RuntimeError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields the runtime sent with the error (e.g. project_in_other_org carries the existing project's org). */
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  if (value && !/^https?:\/\//i.test(value)) value = "https://" + value;
  return value;
}

/** Thin REST client for floq-runtime. Auth is a better-auth bearer token. */
/** Tell the desktop shell which runtime the signed-in user talks to; Rust checks download, upload and share URLs against it, not against the request. */
function registerRuntimeOrigin(baseUrl: string): void {
  if (!isTauri()) return;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return;
  }
  void invoke("set_runtime_origin", { origin }).catch(() => undefined);
}

export class RuntimeClient {
  private readonly createSessionKeys = new Map<string, string>();

  readonly baseUrl: string;
  readonly token: string | null;
  /** Called when an authenticated request comes back 401 (token expired/revoked). */
  readonly onUnauthorized?: () => void;

  constructor(baseUrl: string, token: string | null = null, onUnauthorized?: () => void) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.onUnauthorized = onUnauthorized;
    // Only an authenticated client (after sign-in or a restored session) becomes the runtime the shell trusts.
    if (token) registerRuntimeOrigin(baseUrl);
  }

  withToken(token: string | null): RuntimeClient {
    const next = new RuntimeClient(this.baseUrl, token, this.onUnauthorized);
    next.organizationId = this.organizationId;
    return next;
  }

  /** Active organization: sent as X-Floq-Organization on every request so project-scoped lists follow the switcher. */
  private organizationId: string | null = null;
  setOrganization(id: string | null): void { this.organizationId = id; }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; headers?: Record<string, string>; keepalive?: boolean } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = "Bearer " + this.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.organizationId) headers["X-Floq-Organization"] = this.organizationId;
    Object.assign(headers, options.headers);
    let response: Response;
    let text: string;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 90_000);
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        ...(options.keepalive ? { keepalive: true } : {}),
      });
      text = await response.text();
    } catch {
      if (controller.signal.aborted) {
        throw new RuntimeError(408, "timeout", "The runtime took too long to respond. Retry the same action to check whether it completed.");
      }
      throw new RuntimeError(0, "network", "Runtime unreachable");
    } finally {
      clearTimeout(timeout);
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      if (response.status === 401 && this.token) this.onUnauthorized?.();
      const payload = data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } | string; message?: string; code?: string } | null;
      const error = typeof payload?.error === "object" ? payload.error : null;
      throw new RuntimeError(
        response.status,
        error?.code ?? payload?.code ?? "http_" + response.status,
        error?.message ?? payload?.message ?? (typeof payload?.error === "string" ? payload.error : response.statusText || "Request failed"),
        // Both shapes: top-level fields, or {error:{code,message,details:{...}}} as the runtime sends.
        { ...(data && typeof data === "object" ? data : {}), ...(error ?? {}), ...(error && typeof error.details === "object" && error.details ? error.details : {}) } as Record<string, unknown>,
      );
    }
    return { data: data as T, headers: response.headers };
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number; headers?: Record<string, string> },
  ): Promise<T> {
    return (await this.request<T>(method, path, body, options)).data;
  }

  // --- auth (better-auth) ---

  async signIn(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const { data, headers } = await this.request<{ token?: string; user: AuthUser }>("POST", "/api/auth/sign-in/email", {
      email,
      password,
    });
    const token = headers.get("set-auth-token") ?? data.token;
    if (!token) throw new RuntimeError(500, "no_token", "The runtime did not return a session token");
    return { token, user: data.user };
  }

  /** Unauthenticated: tells the login flow whether the account needs first-run setup. */
  async setupLookup(email: string, setupToken?: string): Promise<{ step: "setup" | "password" }> {
    return (await this.request<{ step: "setup" | "password" }>("POST", "/v1/setup/lookup", { email, ...(setupToken ? { setupToken } : {}) })).data;
  }

  /** Unauthenticated: creates the first administrator; needs the one-time setup token from the runtime logs. 403 setup_unavailable if unavailable or the token is wrong/used. */
  async setupAdmin(email: string, password: string, setupToken: string, name?: string, companyName?: string): Promise<void> {
    await this.request("POST", "/v1/setup/admin", { email, password, setupToken, ...(name ? { name } : {}), ...(companyName ? { companyName } : {}) });
  }

  async signUp(name: string, email: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const { data, headers } = await this.request<{ token?: string; user: AuthUser }>("POST", "/api/auth/sign-up/email", {
      name,
      email,
      password,
    });
    const token = headers.get("set-auth-token") ?? data.token;
    if (!token) throw new RuntimeError(500, "no_token", "The runtime did not return a session token");
    return { token, user: data.user };
  }

  async currentUser(): Promise<AuthUser | null> {
    const data = await this.call<{ user: AuthUser } | null>("GET", "/api/auth/get-session");
    return data?.user ?? null;
  }

  async updateName(name: string): Promise<void> {
    await this.call("POST", "/api/auth/update-user", { name });
  }

  async organizations(): Promise<Organization[]> {
    return (await this.call<{ organizations: Organization[] }>("GET", "/v1/organizations")).organizations;
  }

  async createOrganization(name: string, slug?: string): Promise<Organization> {
    return (await this.call<{ organization: Organization }>("POST", "/v1/organizations", { name, ...(slug ? { slug } : {}) })).organization;
  }

  /** Live URL-name check. `excludeId` is the organization being edited so its own slug reads as available. */
  async organizationSlugAvailable(slug: string, excludeId?: string): Promise<SlugAvailability> {
    const query = new URLSearchParams({ slug });
    if (excludeId) query.set("excludeId", excludeId);
    return this.call("GET", `/v1/organizations/slug-available?${query}`);
  }

  async deleteOrganization(organizationId: string, confirm: string): Promise<void> {
    await this.call("DELETE", `/v1/organizations/${encodeURIComponent(organizationId)}`, { confirm });
  }

  async leaveOrganization(organizationId: string): Promise<void> {
    await this.call("POST", `/v1/organizations/${encodeURIComponent(organizationId)}/leave`, {});
  }

  async transferOrganization(organizationId: string, userId: string): Promise<void> {
    await this.call("POST", `/v1/organizations/${encodeURIComponent(organizationId)}/transfer`, { userId });
  }

  async setOrganizationMemberRole(organizationId: string, userId: string, role: "admin" | "member"): Promise<void> {
    await this.call("PATCH", `/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`, { role });
  }

  async removeOrganizationMember(organizationId: string, userId: string): Promise<void> {
    await this.call("DELETE", `/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`);
  }

  async organizationInvitations(organizationId: string): Promise<OrganizationInvitation[]> {
    return (await this.call<{ invitations: OrganizationInvitation[] }>("GET", `/v1/organizations/${encodeURIComponent(organizationId)}/invitations`)).invitations;
  }

  async resendOrganizationInvitation(organizationId: string, invitationId: string): Promise<IssuedOrganizationInvitation> {
    return (await this.call<{ invitation: IssuedOrganizationInvitation }>("POST", `/v1/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/resend`, {})).invitation;
  }

  async cancelOrganizationInvitation(organizationId: string, invitationId: string): Promise<void> {
    await this.call("DELETE", `/v1/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`);
  }

  async incomingOrganizationInvitations(): Promise<IncomingOrganizationInvitation[]> {
    return (await this.call<{ invitations: IncomingOrganizationInvitation[] }>("GET", "/v1/me/organization-invitations")).invitations;
  }

  async acceptIncomingOrganizationInvitation(invitationId: string): Promise<{ organizationId: string }> {
    return this.call("POST", `/v1/organization-invitations/${encodeURIComponent(invitationId)}/accept`, {});
  }

  async declineIncomingOrganizationInvitation(invitationId: string): Promise<void> {
    await this.call("POST", `/v1/organization-invitations/${encodeURIComponent(invitationId)}/decline`, {});
  }

  async updateOrganization(organizationId: string, patch: { name?: string; slug?: string }): Promise<void> {
    await this.call("PATCH", `/v1/organizations/${encodeURIComponent(organizationId)}`, patch);
  }

  /** Uploads the (already cropped and resized) image as the raw request body. */
  async setOrganizationImage(organizationId: string, image: Blob): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": image.type };
    if (this.token) headers.Authorization = "Bearer " + this.token;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/organizations/${encodeURIComponent(organizationId)}/image`, { method: "PUT", headers, body: image });
    } catch {
      throw new RuntimeError(0, "network", "Runtime unreachable");
    }
    if (response.ok) return;
    if (response.status === 401 && this.token) this.onUnauthorized?.();
    let message = response.statusText || "Upload failed";
    let code = "http_" + response.status;
    try { const payload = await response.json() as { error?: { code?: string; message?: string } }; message = payload.error?.message ?? message; code = payload.error?.code ?? code; } catch { /* keep defaults */ }
    throw new RuntimeError(response.status, code, message);
  }

  async removeOrganizationImage(organizationId: string): Promise<void> {
    await this.call("DELETE", `/v1/organizations/${encodeURIComponent(organizationId)}/image`);
  }

  /** The image endpoint needs the bearer token, which an <img src> cannot send: fetch it as a Blob. `imageUrl` comes from the organization. */
  async organizationImage(imageUrl: string): Promise<Blob> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = "Bearer " + this.token;
    const response = await fetch(this.baseUrl + imageUrl, { headers });
    if (!response.ok) throw new RuntimeError(response.status, "http_" + response.status, "Could not load the image");
    return response.blob();
  }

  async createOrganizationInvitation(organizationId: string, email: string, role: "admin" | "member" = "member"): Promise<IssuedOrganizationInvitation> {
    return (await this.call<{ invitation: IssuedOrganizationInvitation }>("POST", `/v1/organizations/${encodeURIComponent(organizationId)}/invitations`, { email, role })).invitation;
  }

  async acceptOrganizationInvitation(token: string): Promise<{ organizationId: string }> {
    return this.call("POST", "/v1/organization-invitations/accept", { token });
  }

  async registerWithOrganizationInvitation(input: { token: string; email: string; name: string; password: string }): Promise<{ organizationId: string }> {
    return this.call("POST", "/v1/organization-invitations/register", input);
  }

  async organizationBoards(organizationId: string): Promise<Omit<TaskBoard, "lists">[]> {
    return (await this.call<{ boards: Omit<TaskBoard, "lists">[] }>("GET", `/v1/organizations/${encodeURIComponent(organizationId)}/boards`)).boards;
  }

  async createTaskBoard(organizationId: string, title: string): Promise<TaskBoard> {
    return (await this.call<{ board: TaskBoard }>("POST", `/v1/organizations/${encodeURIComponent(organizationId)}/boards`, { title })).board;
  }

  async taskBoard(boardId: string): Promise<TaskBoard> {
    return (await this.call<{ board: TaskBoard }>("GET", `/v1/task-boards/${encodeURIComponent(boardId)}`)).board;
  }

  async saveTaskBoard(boardId: string, title: string): Promise<void> {
    await this.call("PATCH", `/v1/task-boards/${encodeURIComponent(boardId)}`, { title });
  }

  async deleteTaskBoard(boardId: string): Promise<void> {
    await this.call("DELETE", `/v1/task-boards/${encodeURIComponent(boardId)}`);
  }

  async createTaskList(boardId: string, title: string): Promise<void> {
    await this.call("POST", `/v1/task-boards/${encodeURIComponent(boardId)}/lists`, { title });
  }

  async saveTaskList(boardId: string, listId: string, input: { title: string; position: number }): Promise<void> {
    await this.call("PATCH", `/v1/task-boards/${encodeURIComponent(boardId)}/lists/${encodeURIComponent(listId)}`, input);
  }

  async deleteTaskList(boardId: string, listId: string): Promise<void> {
    await this.call("DELETE", `/v1/task-boards/${encodeURIComponent(boardId)}/lists/${encodeURIComponent(listId)}`);
  }

  async createTaskCard(boardId: string, input: { listId: string; title: string; description?: string; assigneeId?: string | null }): Promise<void> {
    await this.call("POST", `/v1/task-boards/${encodeURIComponent(boardId)}/cards`, input);
  }

  async saveTaskCard(boardId: string, cardId: string, input: { listId: string; title: string; description?: string; position: number; assigneeId?: string | null; dueAt?: string | null }): Promise<void> {
    await this.call("PATCH", `/v1/task-boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`, input);
  }

  async deleteTaskCard(boardId: string, cardId: string): Promise<void> {
    await this.call("DELETE", `/v1/task-boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`);
  }

  taskRealtimeUrl(boardId: string): string {
    if (!this.token) throw new RuntimeError(401, "unauthorized", "Sign in to join this board");
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/tasks/realtime";
    url.search = new URLSearchParams({ boardId, token: this.token }).toString();
    return url.toString();
  }

  /** Agent browser live stream (WebSocket) for one Browser node (one page per node); same auth as the other sockets. */
  browserStreamUrl(nodeId: string): string {
    if (!this.token) throw new RuntimeError(401, "unauthorized", "Sign in to use the browser");
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/browser/stream";
    url.search = new URLSearchParams({ token: this.token, node: nodeId }).toString();
    return url.toString();
  }
  /** The desktop app's egress relay dials this. No credentials in the URL: Rust sends the token in an Authorization header. */
  browserEgressUrl(): string {
    const url = new URL(this.baseUrl);
    // The bearer token travels in a header of this socket: never over plain ws:// to another machine.
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new RuntimeError(400, "insecure_server", "Use a secure (https) address to route the browser through this computer");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/browser/egress";
    url.search = "";
    return url.toString();
  }
  browserStatus = () => this.call<BrowserStatus>("GET", "/v1/browser");
  /** "Use the server connection this time": a transient runtime override, the saved egress mode is left alone. */
  browserEgressOverride = (server: boolean) => this.call<BrowserEgress>("POST", "/v1/browser/egress/override", { server });
  browserRestart = () => this.call<BrowserStatus>("POST", "/v1/browser/restart", {});
  browserImportPreview = (content: string) => this.call<BrowserImportPreview>("POST", "/v1/browser/import/preview", { content });
  browserImportCommit = (importId: string, domains: string[], bookmarks: boolean) => this.call<BrowserImportResult>("POST", "/v1/browser/import/commit", { importId, domains, bookmarks });
  browserData = () => this.call<BrowserData>("GET", "/v1/browser/data");
  browserRemoveDomain = (domain: string) => this.call<{ removed: number }>("POST", "/v1/browser/data/remove", { domain });
  browserClearData = () => this.call<BrowserStatus>("POST", "/v1/browser/clear-data", { confirm: "clear" });

  async changePassword(currentPassword: string, newPassword: string, revokeOtherSessions = false): Promise<void> {
    await this.call("POST", "/api/auth/change-password", { currentPassword, newPassword, revokeOtherSessions });
  }

  async signOut(): Promise<void> {
    await this.call("POST", "/api/auth/sign-out", {});
  }

  // --- runtime ---

  health = () => this.call<{ ok: boolean }>("GET", "/healthz");
  info = () => this.call<RuntimeInfo>("GET", "/v1/info");
  agentRoles = async () => (await this.call<{ roles: AgentRole[] }>("GET", "/v1/agent-roles")).roles;

  // --- administration (admin-only on the server) ---

  async myRole(): Promise<UserRole> {
    return (await this.call<{ role: UserRole }>("GET", "/v1/me/role")).role;
  }
  checkUpdates = (refresh = false) => this.call<UpdatesStatus>("GET", `/v1/admin/updates${refresh ? "?refresh=1" : ""}`, undefined, { timeoutMs: 90_000 });
  applyUpdate = (target: UpdateTarget, force = false) =>
    this.call<UpdateResult>("POST", "/v1/admin/updates/apply", { target, force }, { timeoutMs: 11 * 60_000 });
  async adminUsers(): Promise<AdminUser[]> {
    return (await this.call<{ users: AdminUser[] }>("GET", "/v1/admin/users")).users;
  }
  setUserRole = (id: string, role: UserRole) => this.call<{ id: string; role: UserRole }>("PATCH", `/v1/admin/users/${encodeURIComponent(id)}`, { role });

  async sessions(): Promise<SessionSummary[]> {
    return (await this.call<{ sessions: SessionSummary[] }>("GET", "/v1/sessions")).sessions;
  }

  async projects(): Promise<RuntimeProject[]> {
    return (await this.call<{ projects: RuntimeProject[] }>("GET", "/v1/projects")).projects;
  }

  async createProject(input: { gitUrl?: string; name?: string }): Promise<RuntimeProject> {
    return (await this.call<{ project: RuntimeProject }>("POST", "/v1/projects", input, { timeoutMs: 5 * 60_000 })).project;
  }

  async updateProject(id: string, patch: { displayName?: string | null; imageUrl?: string | null; iconName?: string | null; iconColor?: string | null }): Promise<RuntimeProject> {
    return (await this.call<{ project: RuntimeProject }>("PATCH", `/v1/projects/${encodeURIComponent(id)}`, patch)).project;
  }

  /** Move a project to another organization the user belongs to. */
  async moveProject(id: string, organizationId: string): Promise<RuntimeProject> {
    return (await this.call<{ project: RuntimeProject }>("PATCH", `/v1/projects/${encodeURIComponent(id)}`, { organizationId })).project;
  }

  /** `fetch` first updates remote branches from every remote (best effort; slower). */
  projectBranches(projectId: string, workspaceId: string, options: { fetch?: boolean } = {}): Promise<{ currentBranch: string | null; branches: string[]; remoteOnly?: string[]; fetchError?: string }> {
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/branches${options.fetch ? "?fetch=1" : ""}`, undefined, { timeoutMs: options.fetch ? 45_000 : 30_000 });
  }

  /** Pre-flight for `switchProjectBranch`: rejects with the same error, changes nothing. */
  async checkProjectBranchSwitch(projectId: string, workspaceId: string, branch: string): Promise<{ ok: true; needsSwitch: boolean }> {
    return this.call("POST", `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/branch`, { branch, dryRun: true }, { timeoutMs: 30_000 });
  }

  /** Checks out a local branch in the workspace. Live agents keep running; fails if the tree is dirty or the branch is held by another worktree. */
  async switchProjectBranch(projectId: string, workspaceId: string, branch: string): Promise<RuntimeProject> {
    return (await this.call<{ project: RuntimeProject }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/branch`, { branch }, { timeoutMs: 60_000 })).project;
  }

  async setWorkspaceNavExpanded(projectId: string, workspaceId: string, navExpanded: boolean): Promise<void> {
    await this.call("PATCH", `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, { navExpanded });
  }

  async setProjectNavExpanded(projectId: string, navExpanded: boolean): Promise<void> {
    await this.call("PATCH", `/v1/projects/${encodeURIComponent(projectId)}/workspaces`, { navExpanded });
  }

  projectDeleteStatus(projectId: string): Promise<ProjectDeleteStatus> {
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/delete-status`, undefined, { timeoutMs: 2 * 60_000 });
  }

  /** Irreversible: removes the project, its sessions and canvas data, and its Floq-managed checkouts. */
  deleteProject(projectId: string): Promise<ProjectDeleteResult> {
    return this.call("DELETE", `/v1/projects/${encodeURIComponent(projectId)}`, undefined, { timeoutMs: 5 * 60_000 });
  }

  // --- task sources (plugins) ---

  // --- project tasks + automations ---

  projectTasks(projectId?: string): Promise<{ tasks: ProjectTask[]; settings: Record<string, ProjectTaskSettings> }> {
    return this.call("GET", `/v1/tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  }
  async createProjectTask(projectId: string, input: { title: string; description?: string; priority?: TaskPriority; dueAt?: string | null; runAt?: string | null; assigneeSessionId?: string | null }): Promise<ProjectTask> {
    return (await this.call<{ task: ProjectTask }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/tasks`, input)).task;
  }
  async updateProjectTask(projectId: string, taskId: string, patch: Partial<Pick<ProjectTask, "title" | "description" | "status" | "priority" | "dueAt" | "runAt" | "assigneeSessionId" | "position">>): Promise<ProjectTask> {
    return (await this.call<{ task: ProjectTask }>("PATCH", `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, patch)).task;
  }
  async deleteProjectTask(projectId: string, taskId: string): Promise<void> {
    await this.call("DELETE", `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`);
  }
  async projectTaskEvents(projectId: string, taskId: string): Promise<ProjectTaskEvent[]> {
    return (await this.call<{ events: ProjectTaskEvent[] }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/events`)).events;
  }
  async commentProjectTask(projectId: string, taskId: string, text: string): Promise<ProjectTaskEvent[]> {
    return (await this.call<{ events: ProjectTaskEvent[] }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/events`, { text })).events;
  }
  async saveProjectTaskSettings(projectId: string, input: { autoAgent: boolean; agentSessionId?: string | null }): Promise<ProjectTaskSettings> {
    return (await this.call<{ settings: ProjectTaskSettings }>("PUT", `/v1/projects/${encodeURIComponent(projectId)}/task-settings`, input)).settings;
  }
  async automations(projectId?: string): Promise<ProjectAutomation[]> {
    return (await this.call<{ automations: ProjectAutomation[] }>("GET", `/v1/automations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`)).automations;
  }
  async previewSchedule(schedule: Schedule): Promise<string[]> {
    return (await this.call<{ upcoming: string[] }>("POST", "/v1/automations/preview", { schedule })).upcoming;
  }
  async createAutomation(projectId: string, input: { title: string; instructions: string; enabled: boolean; schedule: Schedule; catchUp: CatchUp }): Promise<ProjectAutomation> {
    return (await this.call<{ automation: ProjectAutomation }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/automations`, input)).automation;
  }
  async updateAutomation(projectId: string, id: string, patch: Partial<{ title: string; instructions: string; enabled: boolean; schedule: Schedule; catchUp: CatchUp }>): Promise<ProjectAutomation> {
    return (await this.call<{ automation: ProjectAutomation }>("PATCH", `/v1/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(id)}`, patch)).automation;
  }
  async deleteAutomation(projectId: string, id: string): Promise<void> {
    await this.call("DELETE", `/v1/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(id)}`);
  }
  async runAutomation(projectId: string, id: string): Promise<ProjectTask> {
    return (await this.call<{ task: ProjectTask }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/automations/${encodeURIComponent(id)}/run`)).task;
  }

  async taskSources(): Promise<TaskSourceInfo[]> {
    return (await this.call<{ sources: TaskSourceInfo[] }>("GET", "/v1/task-sources")).sources;
  }

  taskSourceItems(pluginId: string, sourceId: string, params: { query?: string; cursor?: string } = {}): Promise<ExternalTaskPage> {
    const q = new URLSearchParams();
    if (params.query) q.set("query", params.query);
    if (params.cursor) q.set("cursor", params.cursor);
    const suffix = q.size ? "?" + q.toString() : "";
    return this.call<ExternalTaskPage>("GET", `/v1/task-sources/${encodeURIComponent(pluginId)}/${encodeURIComponent(sourceId)}/items${suffix}`);
  }

  async taskSourceItem(pluginId: string, sourceId: string, externalId: string): Promise<ExternalTask> {
    return (await this.call<{ item: ExternalTask }>("GET", `/v1/task-sources/${encodeURIComponent(pluginId)}/${encodeURIComponent(sourceId)}/items/${encodeURIComponent(externalId)}`)).item;
  }

  // --- installable plugins (admin only) ---

  async pluginCatalog(): Promise<PluginCatalogItem[]> {
    return (await this.call<{ plugins: PluginCatalogItem[] }>("GET", "/v1/plugins/catalog", undefined, { timeoutMs: 60_000 })).plugins;
  }

  /** `confirm` is the plugin id the admin typed. */
  async installPlugin(id: string, confirm: string): Promise<PluginInfo> {
    return (await this.call<{ plugin: PluginInfo }>("POST", "/v1/plugins/install", { id, confirm }, { timeoutMs: 2 * 60_000 })).plugin;
  }

  /** `sha256` is the digest the admin reviewed: required for plugins installed from a repository, ignored for catalog plugins. */
  async updatePlugin(id: string, sha256?: string): Promise<PluginInfo> {
    return (await this.call<{ plugin: PluginInfo }>("POST", `/v1/plugins/${encodeURIComponent(id)}/update`, sha256 ? { sha256 } : {}, { timeoutMs: 2 * 60_000 })).plugin;
  }

  /** Fetches and verifies the newest release of a GitHub repository (any owner) without installing it. */
  async inspectPluginRepo(url: string): Promise<PluginRepoPreview> {
    return (await this.call<{ preview: PluginRepoPreview }>("POST", "/v1/plugins/inspect-url", { url }, { timeoutMs: 2 * 60_000 })).preview;
  }

  /** `sha256` is the digest from the preview, `confirm` the plugin id the admin typed. */
  async installPluginFromRepo(url: string, sha256: string, confirm: string): Promise<PluginInfo> {
    return (await this.call<{ plugin: PluginInfo }>("POST", "/v1/plugins/install-url", { url, sha256, confirm }, { timeoutMs: 2 * 60_000 })).plugin;
  }

  /** `id -> owner/repo` of plugins installed from a repository. */
  async pluginSources(): Promise<Record<string, string>> {
    return (await this.call<{ sources: Record<string, string> }>("GET", "/v1/plugins/sources")).sources;
  }

  /** Installed plugins with a newer version available (for the toast on app open). Read-only. */
  async pluginUpdates(): Promise<PluginUpdateNotice[]> {
    return (await this.call<{ updates: PluginUpdateNotice[] }>("GET", "/v1/plugins/updates", undefined, { timeoutMs: 60_000 })).updates;
  }

  async uninstallPlugin(id: string, confirm: string): Promise<void> {
    await this.call("DELETE", `/v1/plugins/${encodeURIComponent(id)}?confirm=${encodeURIComponent(confirm)}`);
  }

  /** "Delete data": drops the plugin's schema, settings and migration ledger. The plugin must be off. */
  async purgePluginData(id: string, confirm: string): Promise<void> {
    await this.call("POST", `/v1/plugins/${encodeURIComponent(id)}/purge`, { confirm });
  }

  /** The UI bundle of an installed plugin, with the sha256 the runtime reports for it (checked by the caller). */
  async pluginUiScript(id: string): Promise<{ text: string; sha256: string }> {
    const response = await fetch(`${this.baseUrl}/v1/plugins/${encodeURIComponent(id)}/ui.js`, { headers: this.token ? { Authorization: "Bearer " + this.token } : {} });
    if (!response.ok) throw new RuntimeError(response.status, "http_" + response.status, "The plugin UI could not be loaded.");
    return { text: await response.text(), sha256: response.headers.get("X-Floq-Plugin-Sha256") ?? "" };
  }

  // --- plugins ---

  async listPlugins(): Promise<PluginInfo[]> {
    return (await this.call<{ plugins: PluginInfo[] }>("GET", "/v1/plugins")).plugins;
  }

  /** `install` (admin) enables the plugin for the whole runtime; `user` is the signed-in user's own switch for user-scoped plugins. */
  async setPluginEnabled(id: string, enabled: boolean, level: "install" | "user" = "install"): Promise<{ plugin: PluginInfo; mcpProblems: string[] }> {
    const path = `/v1/plugins/${encodeURIComponent(id)}`;
    const res = level === "user"
      ? await this.call<{ plugin: PluginInfo; mcpProblems?: string[] }>("PUT", path + "/user", { enabled })
      : await this.call<{ plugin: PluginInfo; mcpProblems?: string[] }>("POST", path + (enabled ? "/enable" : "/disable"));
    return { plugin: res.plugin, mcpProblems: res.mcpProblems ?? [] };
  }

  async getPluginSettings(id: string): Promise<PluginSettingValues> {
    return (await this.call<{ settings: PluginSettingValues }>("GET", `/v1/plugins/${encodeURIComponent(id)}/settings`)).settings;
  }

  async savePluginSettings(id: string, settings: PluginSettingValues): Promise<PluginSettingValues> {
    return (await this.call<{ settings: PluginSettingValues }>("PUT", `/v1/plugins/${encodeURIComponent(id)}/settings`, { settings })).settings;
  }

  async getPluginSecrets(id: string): Promise<PluginSecretStatus[]> {
    return (await this.call<{ secrets: PluginSecretStatus[] }>("GET", `/v1/plugins/${encodeURIComponent(id)}/secrets`)).secrets;
  }

  /** Write-only: the value is sent once and never stored by the app. */
  async setPluginSecret(id: string, name: string, value: string): Promise<void> {
    await this.call<void>("PUT", `/v1/plugins/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { value });
  }

  async deletePluginSecret(id: string, name: string): Promise<void> {
    await this.call<void>("DELETE", `/v1/plugins/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`);
  }

  async getPluginSecretMigrations(): Promise<PluginSecretMigration[]> {
    return (await this.call<{ items: PluginSecretMigration[] }>("GET", "/v1/plugins/secret-migrations")).items;
  }

  async dismissPluginSecretMigrations(): Promise<void> {
    await this.call<void>("POST", "/v1/plugins/secret-migrations/dismiss");
  }

  /** Call a route the plugin registered under `/v1/plugins/<id>/api/`. `path` starts with `/`. */
  pluginFetch<T = unknown>(id: string, path: string, init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {}): Promise<T> {
    // Defense in depth: a plugin path must stay under /api/ and never reach core routes with the user's token.
    if (/(^|[/\\])\.\.?([/\\?#]|$)|%2e|%2f|%5c|\/\/|\\/i.test(path)) throw new Error("Invalid plugin path");
    return this.call<T>(init.method ?? "GET", `/v1/plugins/${encodeURIComponent(id)}/api${path.startsWith("/") ? path : "/" + path}`, init.body);
  }

  projectFolders(): Promise<ProjectFoldersState> {
    return this.call("GET", "/v1/project-folders");
  }

  /** Version-checked replace. A 409 `version_conflict` means another device saved first. `keepalive` survives page unload. */
  async saveProjectFolders(version: number, doc: ProjectFoldersDoc, options: { keepalive?: boolean } = {}): Promise<ProjectFoldersState> {
    return (await this.request<ProjectFoldersState>("PUT", "/v1/project-folders", { version, doc }, { timeoutMs: 20_000, keepalive: options.keepalive })).data;
  }

  worktreeDeleteStatus(projectId: string, workspaceId: string): Promise<WorktreeDeleteStatus> {
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/delete-status`);
  }

  deleteWorktree(projectId: string, workspaceId: string, force: boolean): Promise<WorktreeDeleteResult> {
    return this.call("DELETE", `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}?force=${force ? 1 : 0}`, undefined, { timeoutMs: 2 * 60_000 });
  }

  async renameSession(id: string, title: string): Promise<SessionSummary> {
    return (await this.call<{ session: SessionSummary }>("PATCH", `/v1/sessions/${encodeURIComponent(id)}`, { title })).session;
  }

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const fingerprint = JSON.stringify(input);
    const key = this.createSessionKeys.get(fingerprint) ?? crypto.randomUUID();
    this.createSessionKeys.set(fingerprint, key);
    const result = await this.call<{ session: SessionSummary }>("POST", "/v1/sessions", input, {
      timeoutMs: 5 * 60_000,
      headers: { "Idempotency-Key": key },
    });
    if (this.createSessionKeys.get(fingerprint) === key) this.createSessionKeys.delete(fingerprint);
    return result.session;
  }

  async resumeSession(id: string): Promise<SessionSummary> {
    return (await this.call<{ session: SessionSummary }>("POST", `/v1/sessions/${id}/resume`, {})).session;
  }

  /** Every provider conversation this agent has had (pointer history), newest first. */
  async listConversations(id: string): Promise<AgentConversation[]> {
    return (await this.call<{ conversations: AgentConversation[] }>("GET", `/v1/sessions/${id}/conversations`)).conversations;
  }

  /** Explicit, reversible fresh start: the current conversation stays in the history. `summary` makes the first prompt a handoff built from the old transcript (Claude and Codex). */
  async startFresh(id: string, options: { summary?: boolean } = {}): Promise<SessionSummary> {
    return (await this.call<{ session: SessionSummary }>("POST", `/v1/sessions/${id}/start-fresh`, options.summary ? { summary: true } : {})).session;
  }

  /** Make an earlier conversation current again and resume it. */
  async switchConversation(id: string, conversationId: string): Promise<SessionSummary> {
    return (await this.call<{ session: SessionSummary }>("POST", `/v1/sessions/${id}/conversations/${conversationId}/switch`, {})).session;
  }

  /** Usage-limit fallback actions from the agent badge: return to the original model now, keep the fallback, or set the per-agent policy. */
  async fallbackAction(id: string, action: "return" | "keep" | "override", override?: "default" | "model" | "pause"): Promise<FallbackActionResult> {
    return await this.call<FallbackActionResult>("POST", `/v1/sessions/${id}/fallback`, { action, ...(override ? { override } : {}) });
  }

  async sleepSession(id: string): Promise<SessionSummary> {
    return (await this.call<{ session: SessionSummary }>("POST", `/v1/sessions/${id}/sleep`, {})).session;
  }

  async deleteSession(id: string): Promise<void> {
    await this.call("DELETE", `/v1/sessions/${id}`);
  }

  /** DELETE that survives the page unloading (keepalive); fire and forget. */
  deleteSessionKeepalive(id: string): void {
    void this.request("DELETE", `/v1/sessions/${id}`, undefined, { keepalive: true }).catch(() => {});
  }

  gitChanges = (sessionId: string) => this.call<GitChanges>("GET", `/v1/sessions/${sessionId}/changes`);

  gitDiff = (sessionId: string, path: string) =>
    this.call<GitFileDiff>("GET", `/v1/sessions/${sessionId}/diff?path=${encodeURIComponent(path)}`);

  listFiles = (sessionId: string, path = "") =>
    this.call<FileListing>("GET", `/v1/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`);

  /** The project's shared Artifacts folder (agent deliverables), newest first; created on demand. */
  listArtifacts = (sessionId: string) => this.call<ArtifactListing>("GET", `/v1/sessions/${sessionId}/artifacts`);

  readArtifact = (sessionId: string, path: string) =>
    this.call<FileContent>("GET", `/v1/sessions/${sessionId}/artifacts/content?path=${encodeURIComponent(path)}`);

  async artifactDownloadUrl(sessionId: string, path: string): Promise<string> {
    const result = await this.call<{ url: string; expiresAt: number }>("POST", `/v1/sessions/${sessionId}/artifacts/link`, { path });
    return this.baseUrl + result.url;
  }

  readFile = (sessionId: string, path: string) =>
    this.call<FileContent>("GET", `/v1/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}`);

  /** Create an empty file or folder named `name` inside the workspace folder `path` ("" = root). Rejects with 409 if it exists. */
  createFileEntry = (sessionId: string, path: string, name: string, kind: "file" | "dir") =>
    this.call<{ path: string; type: "file" | "dir" }>("POST", `/v1/sessions/${sessionId}/files`, { path, name, kind });

  /**
   * Short-lived, single-use download URL for a file, or for a folder as a zip. Navigations and the Tauri downloader cannot send
   * the bearer header, so the runtime signs the link instead; the URL is only valid for about a minute.
   */
  async fileDownloadUrl(sessionId: string, path: string): Promise<string> {
    const result = await this.call<{ url: string; expiresAt: number }>("POST", `/v1/sessions/${sessionId}/files/link`, { path });
    return this.baseUrl + result.url;
  }

  /** Create a read-only WebDAV share of every folder of a project (valid 8h, or until ejected / signed out). */
  createFileMount = (projectId: string) =>
    this.call<{ token: string; path: string; expiresAt: number; folders: string[] }>("POST", `/v1/projects/${projectId}/files/mount`, {});

  /** Eject: revoke one share (by token) or all shares of the project. */
  async revokeFileMount(projectId: string, token?: string): Promise<void> {
    await this.call("DELETE", `/v1/projects/${projectId}/files/mount${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  }

  /** The session's virtual display (Xpra, `floq display start`). Older runtimes answer 404. */
  sessionDisplay = (sessionId: string) =>
    this.call<SessionDisplay>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/display`);

  stopSessionDisplay = (sessionId: string) =>
    this.call<{ stopped: boolean }>("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/display/stop`);

  sessionPorts = async (sessionId: string) =>
    (await this.call<{ ports: SessionPort[] }>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/ports`)).ports;

  /** Listening ports plus app preview / DevTools links detected in the session's output (older runtimes send no links). */
  sessionPortsAndLinks = async (sessionId: string) => {
    const result = await this.call<{ ports: SessionPort[]; links?: SessionDebugLink[] }>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/ports`);
    return { ports: result.ports, links: result.links ?? [] };
  };

  /** WebSocket URL for one TCP connection to a port the session listens on (one socket per connection). */
  /** `manual` asks the runtime to also allow a port it has not detected as listening (still loopback, unprivileged, non-internal). */
  portTunnelUrl(sessionId: string, port: number, manual = false): string {
    const url = new URL(this.baseUrl + `/v1/sessions/${encodeURIComponent(sessionId)}/ports/${port}/tunnel`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    if (manual) url.searchParams.set("manual", "1");
    return url.toString();
  }

  /** Plain input to the PTY (no bracketed paste). */
  async sendInput(id: string, data: string): Promise<void> {
    await this.call("POST", `/v1/sessions/${id}/input`, { data });
  }

  async uploadSessionAttachment(id: string, name: string, data: string): Promise<{ path: string; size: number }> {
    return this.call("POST", `/v1/sessions/${encodeURIComponent(id)}/attachments`, { name, data }, { timeoutMs: 90_000 });
  }

  /** Raw-body streaming upload endpoint (PUT); used for any size, with no JSON/base64 in memory. */
  attachmentStreamUrl(id: string, name: string): string {
    return `${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}/attachments?name=${encodeURIComponent(name)}`;
  }

  /** Upload a Blob/File with progress (XHR: fetch cannot report upload progress). Aborting `signal` cancels and the runtime deletes the partial file. */
  uploadSessionAttachmentStream(
    id: string,
    file: Blob,
    name: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<{ path: string; size: number }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RuntimeError(0, "aborted", "Upload cancelled"));
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", this.attachmentStreamUrl(id, name));
      if (this.token) xhr.setRequestHeader("Authorization", "Bearer " + this.token);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.responseType = "text";
      const onAbort = () => xhr.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      xhr.upload.onprogress = (event) => onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
      xhr.onerror = () => { done(); reject(new RuntimeError(0, "network", "Runtime unreachable or the connection dropped during upload")); };
      xhr.ontimeout = () => { done(); reject(new RuntimeError(408, "timeout", "The upload timed out")); };
      xhr.onabort = () => { done(); reject(new RuntimeError(0, "aborted", "Upload cancelled")); };
      xhr.onload = () => {
        done();
        let data: { path?: string; size?: number; error?: { code?: string; message?: string } | string; message?: string } | null = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300 && data?.path) {
          onProgress?.(file.size, file.size);
          return resolve({ path: data.path, size: data.size ?? file.size });
        }
        if (xhr.status === 401 && this.token) this.onUnauthorized?.();
        const error = typeof data?.error === "object" ? data.error : null;
        reject(new RuntimeError(xhr.status, error?.code ?? "http_" + xhr.status, error?.message ?? data?.message ?? (typeof data?.error === "string" ? data.error : xhr.status === 413 ? "File is too large for the server or its proxy" : xhr.statusText || "Upload failed")));
      };
      xhr.send(file);
    });
  }

  async interrupt(id: string): Promise<void> {
    await this.call("POST", `/v1/sessions/${id}/interrupt`, {});
  }

  streamUrl(id: string, since: number): string {
    const url = new URL(this.baseUrl + `/v1/sessions/${id}/stream`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    if (since > 0) url.searchParams.set("since", String(since));
    return url.toString();
  }

  // --- subscription logins (Claude / ChatGPT) ---

  providersStatus = () => this.call<ProvidersStatus>("GET", "/v1/providers/status");

  async providerLogin(id: LoginProviderId): Promise<SessionSummary> {
    return (await this.call<{ session: SessionSummary }>("POST", `/v1/providers/${id}/login`, {})).session;
  }

  claudeConnectors = (refresh = false) => this.call<ClaudeConnectors>("GET", "/v1/claude/connectors" + (refresh ? "?refresh=1" : ""));

  providersUsage = () => this.call<ProvidersUsage>("GET", "/v1/providers/usage");

  claudeOAuthStart = () => this.call<ClaudeOAuthStart>("POST", "/v1/providers/claude/oauth/start", {});

  claudeOAuthFinish = (flowId: string, code: string, extra?: { addAccount?: boolean; label?: string }) =>
    this.call<ClaudeOAuthResult>("POST", "/v1/providers/claude/oauth/finish", { flowId, code, ...(extra ?? {}) });

  claudeAccounts = async () => (await this.call<{ accounts: ClaudeAccount[] }>("GET", "/v1/providers/claude/accounts")).accounts;
  activateClaudeAccount = async (slot: string) => (await this.call<{ accounts: ClaudeAccount[] }>("POST", `/v1/providers/claude/accounts/${slot}/activate`, {})).accounts;
  renameClaudeAccount = async (slot: string, label: string) => (await this.call<{ accounts: ClaudeAccount[] }>("PATCH", `/v1/providers/claude/accounts/${slot}`, { label })).accounts;
  removeClaudeAccount = async (slot: string) => (await this.call<{ accounts: ClaudeAccount[] }>("DELETE", `/v1/providers/claude/accounts/${slot}`)).accounts;

  async providerLogout(id: LoginProviderId): Promise<void> {
    await this.call("DELETE", `/v1/providers/${id}/login`);
  }

  // --- settings ---

  async settings(): Promise<UserSettings> {
    return (await this.call<{ settings: UserSettings }>("GET", "/v1/settings")).settings;
  }

  async subagentPolicy(): Promise<SubagentPolicy> {
    return this.call<SubagentPolicy>("GET", "/v1/subagents/policy");
  }

  async updateSettings(patch: SettingsPatch): Promise<UserSettings> {
    return (await this.call<{ settings: UserSettings }>("PATCH", "/v1/settings", patch)).settings;
  }

  async skills(): Promise<{ skills: Array<{ name: string; description: string; source: "home" | "bundled"; provider: "claude" | "codex"; location: string }>; homeScanned: boolean }> {
    return this.call("GET", "/v1/skills");
  }

  async projectSkills(projectId: string | null, scope: "global" | "project", provider?: "claude" | "codex"): Promise<{ skills: RuntimeSkill[]; homeScanned?: boolean }> {
    if (scope === "global") {
      const result = await this.skills();
      return { skills: result.skills.filter((skill) => !provider || skill.provider === provider).map((skill) => ({ ...skill, scope: "global" })), homeScanned: result.homeScanned };
    }
    if (!projectId) throw new Error("Choose a project to view its skills.");
    const params = new URLSearchParams({ scope });
    if (provider) params.set("provider", provider);
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/skills?${params}`);
  }

  /** Read-only file list (no path) or one text file of a discovered skill. */
  async skillFiles(skill: { scope: "global" | "project"; projectId?: string | null; provider: "claude" | "codex"; source: string; location: string }): Promise<{ files: RuntimeSkillFile[] }> {
    return this.call("GET", `/v1/skills/files?${skillFileParams(skill)}`);
  }

  async skillFile(skill: { scope: "global" | "project"; projectId?: string | null; provider: "claude" | "codex"; source: string; location: string }, path: string): Promise<{ path: string; size: number; content: string }> {
    return this.call("GET", `/v1/skills/files?${skillFileParams(skill, path)}`);
  }

  /** Removes a global skill for this user (the runtime refuses the protected Floq skills). */
  async deleteSkill(provider: "claude" | "codex", location: string): Promise<{ removed: number; hidden: boolean }> {
    return this.call("DELETE", `/v1/skills?${new URLSearchParams({ provider, location })}`);
  }

  async createProjectSkill(projectId: string, input: { provider: "claude" | "codex"; name: string; description: string; instructions: string }): Promise<{ skill: RuntimeSkill }> {
    return this.call("POST", `/v1/projects/${encodeURIComponent(projectId)}/skills`, input);
  }

  async searchSkillCatalog(query: string, limit = 20): Promise<{ skills: RuntimeSkillCatalogItem[] }> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this.call("GET", `/v1/skills/catalog/search?${params}`);
  }

  async previewCatalogSkill(input: { source: string; skillId: string } | { url: string }): Promise<RuntimeSkillCatalogPreview> {
    const params = new URLSearchParams(input);
    return this.call("GET", `/v1/skills/catalog/preview?${params}`);
  }

  async importProjectSkill(projectId: string, input: { provider: "claude" | "codex"; source: string; skillId: string } | { provider: "claude" | "codex"; url: string }): Promise<{ skill: RuntimeSkill }> {
    return this.call("POST", `/v1/projects/${encodeURIComponent(projectId)}/skills/import`, input);
  }

  async mcpServers(scope: "global" | "project", projectId?: string | null, provider?: "claude" | "codex"): Promise<{ servers: RuntimeMcpServer[]; homeScanned?: boolean; malformedConfigs?: number }> {
    const params = new URLSearchParams({ scope });
    if (projectId) params.set("projectId", projectId);
    if (provider) params.set("provider", provider);
    return this.call("GET", `/v1/mcp?${params}`);
  }

  /** Installs one MCP server. The runtime stores env/header values in the provider config and never returns them. */
  async addMcpServer(input: { scope: "global" | "project"; projectId?: string | null; providers: McpProviderChoice; server: McpServerDraft; newSecrets?: McpNewSecret[]; allowPlaintext?: boolean }): Promise<{ servers: RuntimeMcpServer[]; restartRequired: boolean }> {
    return this.call("POST", "/v1/mcp", { ...input, projectId: input.projectId ?? undefined });
  }

  /** Removes exactly one named entry from one provider's config. Bundled servers are refused. */
  async removeMcpServer(input: { scope: "global" | "project"; projectId?: string | null; provider: "claude" | "codex"; name: string }): Promise<{ removed: number; restartRequired: boolean }> {
    const params = new URLSearchParams({ scope: input.scope, provider: input.provider, name: input.name });
    if (input.projectId) params.set("projectId", input.projectId);
    return this.call("DELETE", `/v1/mcp?${params}`);
  }

  // --- vault ---

  async secrets(): Promise<SecretInfo[]> {
    return (await this.call<{ secrets: SecretInfo[] }>("GET", "/v1/vault")).secrets;
  }

  async putSecret(name: string, input: { value?: string; description?: string; expose?: Exposure }): Promise<SecretInfo[]> {
    return (await this.call<{ secrets: SecretInfo[] }>("PUT", `/v1/vault/${name}`, input)).secrets;
  }

  async patchSecret(originalName: string, input: { name: string; description: string; expose?: Exposure; value?: string }): Promise<SecretInfo[]> {
    return (await this.call<{ secrets: SecretInfo[] }>("PATCH", `/v1/vault/${encodeURIComponent(originalName)}`, input)).secrets;
  }

  async deleteSecret(name: string): Promise<SecretInfo[]> {
    return (await this.call<{ secrets: SecretInfo[] }>("DELETE", `/v1/vault/${name}`)).secrets;
  }

  // --- canvas notes, agent secrets, orchestrator role (runtime block) ---

  /** Notes of a project (UUID, or "none" for the scratch canvas). */
  async projectNotes(projectId: string): Promise<CanvasNote[]> {
    return (await this.call<{ notes: CanvasNote[] }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/notes`)).notes;
  }
  async createNote(projectId: string, input: CanvasNoteInput & { x: number; y: number }): Promise<CanvasNote> {
    return this.call<CanvasNote>("POST", `/v1/projects/${encodeURIComponent(projectId)}/notes`, input);
  }
  async updateNote(noteId: string, patch: CanvasNoteInput): Promise<CanvasNote> {
    return this.call<CanvasNote>("PATCH", `/v1/notes/${encodeURIComponent(noteId)}`, patch);
  }
  async deleteNote(noteId: string): Promise<void> {
    await this.call("DELETE", `/v1/notes/${encodeURIComponent(noteId)}`);
  }
  /** Idempotent; the agent must be in the note's project. */
  async linkNote(noteId: string, sessionId: string): Promise<CanvasNote> {
    return this.call<CanvasNote>("POST", `/v1/notes/${encodeURIComponent(noteId)}/links`, { sessionId });
  }
  async unlinkNote(noteId: string, sessionId: string): Promise<CanvasNote> {
    return this.call<CanvasNote>("DELETE", `/v1/notes/${encodeURIComponent(noteId)}/links/${encodeURIComponent(sessionId)}`);
  }

  // --- agent memory ---
  async projectMemories(projectId: string, opts: { q?: string; type?: MemoryType; includeInvalid?: boolean } = {}): Promise<{ memories: Memory[]; mode: string }> {
    const qs = new URLSearchParams();
    if (opts.q) qs.set("q", opts.q);
    if (opts.type) qs.set("type", opts.type);
    if (opts.includeInvalid) qs.set("include_invalid", "1");
    const query = qs.toString();
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/memories${query ? `?${query}` : ""}`);
  }
  async projectMemoryGraph(projectId: string, opts: { includeInvalid?: boolean; k?: number; min?: number } = {}): Promise<MemoryGraph> {
    const qs = new URLSearchParams();
    if (opts.includeInvalid) qs.set("include_invalid", "1");
    if (opts.k !== undefined) qs.set("k", String(opts.k));
    if (opts.min !== undefined) qs.set("min", String(opts.min));
    const query = qs.toString();
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/memories/graph${query ? `?${query}` : ""}`);
  }
  async createMemory(projectId: string, input: MemoryInput & { text: string }): Promise<Memory> {
    return this.call<Memory>("POST", `/v1/projects/${encodeURIComponent(projectId)}/memories`, input);
  }
  async updateMemory(id: string, patch: MemoryPatch): Promise<Memory> {
    return this.call<Memory>("PATCH", `/v1/memories/${encodeURIComponent(id)}`, patch);
  }
  async deleteMemory(id: string): Promise<void> {
    await this.call("DELETE", `/v1/memories/${encodeURIComponent(id)}`);
  }
  async memoryEvents(id: string): Promise<MemoryEvent[]> {
    return (await this.call<{ events: MemoryEvent[] }>("GET", `/v1/memories/${encodeURIComponent(id)}/events`)).events;
  }
  memoryStatus(): Promise<MemoryStatus> {
    return this.call<MemoryStatus>("GET", "/v1/memory/status");
  }

  /** Mark/unmark an orchestrator ("orchestrator" | null). User-only; returns the updated summary. */
  async setSessionRole(sessionId: string, role: string | null): Promise<SessionSummary> {
    return this.call<SessionSummary>("PATCH", `/v1/sessions/${encodeURIComponent(sessionId)}/role`, { role });
  }

  // --- agent links ---

  /** Wires of one project (project UUID, or "none" for sessions outside a registered project). */
  async projectLinks(projectId: string): Promise<AgentLink[]> {
    return (await this.call<{ links: AgentLink[] }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/links`)).links;
  }

  /** Manual wire (idempotent). */
  async createLink(fromSessionId: string, toSessionId: string): Promise<AgentLink> {
    return this.call<AgentLink>("POST", "/v1/links", { fromSessionId, toSessionId });
  }

  // --- agent <-> Browser node wires ---

  /** Wires between agents and Browser nodes of one project ("none" for sessions outside a registered project). */
  async browserLinks(projectId: string): Promise<BrowserLink[]> {
    return (await this.call<{ links: BrowserLink[] }>("GET", `/v1/browser/links?project=${encodeURIComponent(projectId)}`)).links;
  }
  /** Idempotent. An agent drives one node at a time: `replacedNode` is the node it was moved away from. */
  async linkBrowser(nodeId: string, sessionId: string): Promise<{ link: BrowserLink; replacedNode: string | null }> {
    return this.call("POST", "/v1/browser/links", { nodeId, sessionId });
  }
  async unlinkBrowser(nodeId: string, sessionId: string): Promise<void> {
    await this.call("DELETE", `/v1/browser/links/${encodeURIComponent(nodeId)}/${encodeURIComponent(sessionId)}`);
  }
  /** Registers a Browser node on a project (idempotent). Rejects with status 409 when another project owns that node id. */
  async claimBrowserNode(nodeId: string, projectId: string): Promise<void> {
    await this.call("POST", "/v1/browser/nodes", { nodeId, projectId });
  }
  /** A node was closed: drop all its wires. */
  async removeBrowserNode(nodeId: string): Promise<void> {
    await this.call("DELETE", `/v1/browser/links/${encodeURIComponent(nodeId)}`);
  }

  async deleteLink(linkId: string): Promise<void> {
    await this.call("DELETE", `/v1/links/${encodeURIComponent(linkId)}`);
  }

  /** Recent agent-to-agent messages of a project, oldest first (server keeps ~200 in memory). */
  async projectEvents(projectId: string, limit = 50): Promise<AgentMessageEvent[]> {
    return (await this.call<{ events: AgentMessageEvent[] }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/events?limit=${limit}`)).events;
  }

  /** Port requests agents are waiting on (re-fetched after a reconnect). */
  portRequests = async () => (await this.call<{ requests: PortRequest[] }>("GET", "/v1/port-requests")).requests;

  /** Answer a port request. Rejects (404) once the runtime has expired or cancelled it. */
  resolvePortRequest = (id: string, body: { decision: "allow" | "deny" } | { decision: "error"; message: string }) =>
    this.call<{ status: string }>("POST", `/v1/port-requests/${encodeURIComponent(id)}/resolve`, body);

  /** Approvals agents are waiting on (re-fetched after a reconnect). */
  approvals = async () => (await this.call<{ approvals: ApprovalRequest[] }>("GET", "/v1/approvals")).approvals;

  /** The user's decision on an approval. Only the signed-in user can do this; rejects once it expired. */
  resolveApproval = (id: string, decision: "allow" | "deny") =>
    this.call<{ status: string }>("POST", `/v1/approvals/${encodeURIComponent(id)}/resolve`, { decision });

  decisions = async () => (await this.call<{ decisions: DecisionView[] }>("GET", "/v1/decisions")).decisions;
  resolveDecision = (id: string, answers: DecisionAnswer[]) => this.call<{ status: string }>("POST", `/v1/decisions/${encodeURIComponent(id)}/resolve`, { answers });
  decisionTerminal = (id: string) => this.call<{ status: string }>("POST", `/v1/decisions/${encodeURIComponent(id)}/terminal`, {});

  /** Notification Center (docs/design/notifications.md). The list body is assumed to be { notifications }. */
  notifications = async (query: { limit?: number } = {}) =>
    (await this.call<{ notifications: import("@/lib/notifications").AppNotification[] }>("GET", `/v1/notifications${query.limit ? `?limit=${query.limit}` : ""}`)).notifications;
  markNotificationsRead = (ids: string[] | "all") => this.call<unknown>("POST", "/v1/notifications/read", { ids });
  clearNotifications = (ids: string[] | "all") => this.call<unknown>("POST", "/v1/notifications/clear", { ids });

  // --- agy swarm mirror (virtual agents); older runtimes answer 404 ---
  virtualAgents = async (projectId: string) =>
    (await this.call<{ agents: import("./types").VirtualAgent[] }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/virtual-agents`)).agents;
  virtualAgentTranscript = (vid: string, since = 0, limit = 40) =>
    this.call<{ steps: import("./types").VirtualAgentStep[]; next: number | null }>("GET", `/v1/virtual-agents/${encodeURIComponent(vid)}/transcript?since=${since}&limit=${limit}`);
  messageVirtualAgent = (vid: string, text: string) =>
    this.call<unknown>("POST", `/v1/virtual-agents/${encodeURIComponent(vid)}/message`, { text });

  /** WebSocket of live AgentMessageEvent JSON frames for all of the user's sessions. */
  eventsUrl(): string {
    const url = new URL(this.baseUrl + "/v1/events");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    return url.toString();
  }

  // --- GitHub device flow ---

  githubStart = () => this.call<DeviceFlow>("POST", "/v1/github/device/start", {});
  githubPoll = (flowId: string) => this.call<DevicePoll>("POST", "/v1/github/device/poll", { flowId });

  githubRepos = (q: string, page: number) =>
    this.call<GithubRepoPage>("GET", `/v1/github/repos?q=${encodeURIComponent(q)}&page=${page}`);

  async githubDisconnect(): Promise<void> {
    await this.call("DELETE", "/v1/github");
  }
}
