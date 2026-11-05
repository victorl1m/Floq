import type {
  AgentLink,
  Keychain,
  KeychainInput,
  CanvasNote,
  CanvasNoteInput,
  AgentMessageEvent,
  AgentRole,
  AuthUser,
  CreateSessionInput,
  DeviceFlow,
  ClaudeOAuthResult,
  ClaudeOAuthStart,
  DevicePoll,
  PortRequest,
  ApprovalRequest,
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
  SubagentPolicy,
  UserSettings,
  Organization,
  OrganizationInvitation,
  IssuedOrganizationInvitation,
  IncomingOrganizationInvitation,
  TaskBoard,
} from "./types";
import type { GitChanges, GitFileDiff } from "./git-review";
import type { FileContent, FileListing } from "./workspace-files";
import type { AdminUser, UpdateResult, UpdatesStatus, UpdateTarget, UserRole } from "./admin-types";

function skillFileParams(skill: { scope: string; projectId?: string | null; provider: string; source: string; location: string }, path?: string): URLSearchParams {
  const params = new URLSearchParams({ scope: skill.scope, provider: skill.provider, source: skill.source, location: skill.location });
  if (skill.projectId) params.set("projectId", skill.projectId);
  if (path !== undefined) params.set("path", path);
  return params;
}

export class RuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  if (value && !/^https?:\/\//i.test(value)) value = "https://" + value;
  return value;
}

/** Thin REST client for floq-runtime. Auth is a better-auth bearer token. */
export class RuntimeClient {
  private readonly createSessionKeys = new Map<string, string>();

  constructor(
    readonly baseUrl: string,
    readonly token: string | null = null,
    /** Called when an authenticated request comes back 401 (token expired/revoked). */
    readonly onUnauthorized?: () => void,
  ) {}

  withToken(token: string | null): RuntimeClient {
    return new RuntimeClient(this.baseUrl, token, this.onUnauthorized);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; headers?: Record<string, string>; keepalive?: boolean } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = "Bearer " + this.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
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
      const payload = data as { error?: { code?: string; message?: string } | string; message?: string; code?: string } | null;
      const error = typeof payload?.error === "object" ? payload.error : null;
      throw new RuntimeError(
        response.status,
        error?.code ?? payload?.code ?? "http_" + response.status,
        error?.message ?? payload?.message ?? (typeof payload?.error === "string" ? payload.error : response.statusText || "Request failed"),
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
  async setupLookup(email: string): Promise<{ step: "setup" | "password" }> {
    return (await this.request<{ step: "setup" | "password" }>("POST", "/v1/setup/lookup", { email })).data;
  }

  /** Unauthenticated: creates the first administrator. 409 setup_unavailable if already done. */
  async setupAdmin(email: string, password: string, name?: string, companyName?: string): Promise<void> {
    await this.request("POST", "/v1/setup/admin", { email, password, ...(name ? { name } : {}), ...(companyName ? { companyName } : {}) });
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

  async organizationSlugAvailable(slug: string): Promise<{ slug: string; available: boolean }> {
    return this.call("GET", `/v1/organization-slugs/${encodeURIComponent(slug)}`);
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

  async renameOrganization(organizationId: string, name: string): Promise<void> {
    await this.call("PATCH", `/v1/organizations/${encodeURIComponent(organizationId)}`, { name });
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

  async createProject(input: { gitUrl: string; name?: string }): Promise<RuntimeProject> {
    return (await this.call<{ project: RuntimeProject }>("POST", "/v1/projects", input, { timeoutMs: 5 * 60_000 })).project;
  }

  async updateProject(id: string, patch: { displayName?: string | null; imageUrl?: string | null }): Promise<RuntimeProject> {
    return (await this.call<{ project: RuntimeProject }>("PATCH", `/v1/projects/${encodeURIComponent(id)}`, patch)).project;
  }

  projectBranches(projectId: string, workspaceId: string): Promise<{ currentBranch: string | null; branches: string[] }> {
    return this.call("GET", `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/branches`, undefined, { timeoutMs: 30_000 });
  }

  /** Checks out a local branch in the workspace. Fails if agents are live, the tree is dirty or the branch is held by another worktree. */
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

  readFile = (sessionId: string, path: string) =>
    this.call<FileContent>("GET", `/v1/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}`);

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

  providersUsage = () => this.call<ProvidersUsage>("GET", "/v1/providers/usage");

  claudeOAuthStart = () => this.call<ClaudeOAuthStart>("POST", "/v1/providers/claude/oauth/start", {});

  claudeOAuthFinish = (flowId: string, code: string) =>
    this.call<ClaudeOAuthResult>("POST", "/v1/providers/claude/oauth/finish", { flowId, code });

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

  // Keychains (wallets of secrets linked to agents). Values are write-only.
  /** All of the user's keychains across projects (Secrets screen). */
  keychains(): Promise<Keychain[]>;
  /** Keychains of one project (UUID, or "none" for the scratch canvas). */
  keychains(projectId: string): Promise<Keychain[]>;
  async keychains(projectId?: string): Promise<Keychain[]> {
    const path = projectId === undefined ? "/v1/keychains" : `/v1/projects/${encodeURIComponent(projectId)}/keychains`;
    return (await this.call<{ keychains: Keychain[] }>("GET", path)).keychains;
  }
  async createKeychain(projectId: string, input: KeychainInput & { name: string; x: number; y: number }): Promise<Keychain> {
    return this.call<Keychain>("POST", `/v1/projects/${encodeURIComponent(projectId)}/keychains`, input);
  }
  async updateKeychain(id: string, patch: KeychainInput): Promise<Keychain> {
    return this.call<Keychain>("PATCH", `/v1/keychains/${encodeURIComponent(id)}`, patch);
  }
  async deleteKeychain(id: string): Promise<void> {
    await this.call("DELETE", `/v1/keychains/${encodeURIComponent(id)}`);
  }
  /** Create or replace one secret (name A-Z0-9_). */
  async setKeychainSecret(id: string, name: string, value: string): Promise<Keychain> {
    return this.call<Keychain>("PUT", `/v1/keychains/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { value });
  }
  async deleteKeychainSecret(id: string, name: string): Promise<Keychain> {
    return this.call<Keychain>("DELETE", `/v1/keychains/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`);
  }
  /** Idempotent; the agent must be in the keychain's project. */
  async linkKeychain(id: string, sessionId: string): Promise<Keychain> {
    return this.call<Keychain>("POST", `/v1/keychains/${encodeURIComponent(id)}/links`, { sessionId });
  }
  async unlinkKeychain(id: string, sessionId: string): Promise<Keychain> {
    return this.call<Keychain>("DELETE", `/v1/keychains/${encodeURIComponent(id)}/links/${encodeURIComponent(sessionId)}`);
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
