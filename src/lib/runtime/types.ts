// Mirrors runtime/src/types.ts and the REST payloads in runtime/src/server.ts.

export type ProviderId = "claude" | "codex" | "shell";

export type SessionState = "starting" | "running" | "sleeping" | "exited" | "failed";

export interface SessionSummary {
  id: string;
  provider: ProviderId;
  title: string;
  state: SessionState;
  cwd: string;
  organizationId?: string;
  /** Isolated project worktree's underlying checkout, when this session uses one. */
  projectCwd?: string | null;
  projectId?: string | null;
  worktreeId?: string | null;
  branch?: string | null;
  /** Source URL for sessions created by cloning a repository, if any. */
  gitUrl?: string | null;
  cols: number;
  rows: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: number | null;
  pid: number | null;
  seq: number;
  bufferedBytes: number;
  droppedBytes: number;
  resumeCount: number;
  sleepReason: string | null;
  model?: string | null;
  /** Agent role preset id, or null/absent for a generalist. "orchestrator" = the only role that can recruit. */
  role?: string | null;
  /** Number of per-agent secrets attached (session list only). */
  secretCount?: number;
  /** Session that recruited this one via the floq CLI, or null. */
  /** True once the agent was removed: its conversation is kept and listed under Conversations, not on the canvas. */
  archived?: boolean;
  parentSessionId?: string | null;
  /** Turn status of a running agent; only present on polled session lists. */
  activity?: "working" | "idle" | "waiting-for-input";
}

export interface AgentRole {
  id: string;
  label: string;
  summary: string;
  icon: string;
  capability: string;
  readOnly: boolean;
  whenToUse: string;
}

export interface ProjectWorkspace {
  id: string;
  cwd: string;
  name: string;
  branch: string | null;
  isWorktree: boolean;
  /** Sidebar collapse state, stored on the server with the workspace. */
  navExpanded: boolean;
  sessionIds: string[];
}

export interface RuntimeProject {
  id: string;
  name: string;
  displayName: string | null;
  imageUrl: string | null;
  /** Catalog icon (kebab-case Tabler name) and #rrggbb tint; when iconName is set it wins over imageUrl. */
  iconName: string | null;
  iconColor: string | null;
  gitUrl: string | null;
  cwd: string;
  organizationId?: string;
  createdAt: string;
  workspaces: ProjectWorkspace[];
}

export interface TaskCard { id: string; title: string; description: string; position: number; assigneeId: string | null; dueAt: string | null; createdAt: string; updatedAt: string }
export interface TaskList { id: string; title: string; position: number; cards: TaskCard[] }
export interface TaskBoard { id: string; organizationId: string; title: string; createdAt: string; lists: TaskList[] }
export type SlugReason = "invalid" | "reserved" | "taken";
export interface SlugAvailability { slug: string; normalized: string; available: boolean; reason?: SlugReason }
export type OrganizationRole = "owner" | "admin" | "member";
export interface OrganizationMember { id: string; name: string; email: string; role: OrganizationRole }
export interface Organization { id: string; name: string; slug: string; role: OrganizationRole; /** The user's own always-present organization: cannot be deleted, left or invited to. */ personal?: boolean; /** Relative runtime URL of the uploaded image (versioned), or null. Fetch it with RuntimeClient.organizationImage. */ imageUrl?: string | null; createdAt?: string; members: OrganizationMember[] }
/** Pending invitation as the organization's owners and admins see it. */
export interface OrganizationInvitation { id: string; email: string; role: "admin" | "member"; invitedBy: string; createdAt: string; expiresAt: string; status: "pending" | "expired" }
/** Returned once when an invitation is created or resent. The runtime has no email transport, so delivery is always "manual". */
export interface IssuedOrganizationInvitation extends OrganizationInvitation { token: string; delivery: "manual" }
/** An invitation addressed to the signed-in user's email. */
export interface IncomingOrganizationInvitation { id: string; organization: { id: string; name: string; slug: string }; role: "admin" | "member"; invitedBy: string; expiresAt: string }

/** What deleting a Floq-created worktree would lose (read-only; GET .../delete-status). */
export interface WorktreeDeleteStatus {
  path: string;
  branch: string | null;
  /** The local floq/<id> branch that would also be deleted, or null. */
  floqBranch: string | null;
  baseBranch: string | null;
  missing: boolean;
  uncommittedFiles: number;
  commitsNotOnBase: number;
  unpushedCommits: number;
  /** Commits that exist on no other branch or remote: lost if the worktree is deleted. */
  unsavedCommits: number;
  sessions: { live: Array<{ id: string; title: string }>; idle: number };
}

export interface WorktreeDeleteResult {
  alreadyGone: boolean;
  branchDeleted: string | null;
  branchNote: string | null;
  idleSessions: number;
}

/** One checkout (main or worktree) a project owns; part of the delete-project confirmation. */
export interface ProjectCheckoutReport {
  workspaceId: string;
  path: string;
  kind: "project" | "worktree";
  branch: string | null;
  /** Floq created this directory and will delete it. False: outside Floq's directories, left untouched. */
  managed: boolean;
  state: "ok" | "missing" | "unreadable" | "unmanaged";
  uncommittedFiles: number | null;
}

/** What deleting a project would remove (read-only; GET /v1/projects/:id/delete-status). */
export interface ProjectDeleteStatus {
  project: { id: string; name: string };
  sessions: { total: number; live: number };
  notes: number;
  keychains: number;
  checkouts: ProjectCheckoutReport[];
  worktrees: number;
  dirtyWorktrees: number;
  dirtyMainCheckout: boolean;
  unmanagedCheckouts: number;
  unreadableCheckouts: number;
}

export interface ProjectDeleteResult {
  deleted: true;
  sessionsDeleted: number;
  removedCheckouts: number;
  leftovers: Array<{ path: string; reason: string }>;
}

/** Per-user sidebar folder layout stored on the runtime (GET/PUT /v1/project-folders). */
export interface ProjectFoldersDoc {
  folders: Array<{ id: string; name: string }>;
  root: Array<{ kind: "project" | "folder"; id: string }>;
  membership: Record<string, string[]>;
  expanded: Record<string, boolean>;
}
export interface ProjectFoldersState { version: number; doc: ProjectFoldersDoc | null; updatedAt: string | null }

export type SkillScope = "global" | "project";
export type SkillSource = "project" | "home" | "bundled";
export interface RuntimeSkill {
  name: string;
  description: string;
  provider: "claude" | "codex";
  scope: SkillScope;
  source: SkillSource;
  location: string;
}
export interface RuntimeSkillFile { path: string; size: number }
export interface RuntimeMcpServer {
  name: string;
  provider: "claude" | "codex";
  scope: SkillScope;
  source: "project" | "home" | "bundled";
  transport: "stdio" | "http" | "sse" | "unknown";
  command?: string;
  urlHost?: string;
  /** Shipped with the runtime image (for example context7): it cannot be removed. */
  protected?: boolean;
  /** Env or header values come from the vault; only the secret names are listed. */
  usesSecrets?: boolean;
  secretNames?: string[];
}
export type McpProviderChoice = "claude" | "codex" | "both";
export interface McpServerDraft {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}
export interface McpNewSecret { name: string; value: string; description?: string }
export interface RuntimeSkillCatalogItem {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs: number;
}
export interface RuntimeSkillCatalogPreview {
  skill: RuntimeSkillCatalogItem;
  files: Array<{ path: string; size: number }>;
  markdown: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  command: string;
  available: boolean;
  version: string | null;
  args: string[];
  /** Selectable models; absent on older runtimes. */
  models?: ModelOption[];
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface ServerInfo {
  name: "floq-runtime";
  version: string;
  startedAt: string;
  providers: ProviderId[];
  maxSessions: number;
  activeSessions: number;
  /** Optional features; absent on older runtimes. */
  capabilities?: string[];
}

export interface RuntimeInfo {
  server: ServerInfo;
  providers: ProviderInfo[];
  githubConfigured: boolean;
}

export interface CreateSessionInput {
  provider: ProviderId;
  title?: string;
  cwd?: string;
  /** Shell sessions only: open in the runtime user's home directory, no project. */
  home?: boolean;
  projectId?: string;
  workspaceId?: string;
  isolated?: boolean;
  gitUrl?: string;
  specKit?: boolean;
  lead?: boolean;
  /** Model id, or "auto" to let the role's capability choose. */
  model?: string;
  /** Agent role preset id from /v1/agent-roles. */
  role?: string;
  /** Initial prompt passed to the CLI at launch. */
  prompt?: string;
  cols?: number;
  rows?: number;
}

export interface UserSettings {
  claudeAutoApprove: boolean;
  codexAutoApprove: boolean;
  gitName: string | null;
  gitEmail: string | null;
  github: { login: string; connectedAt: string } | null;
  /** Absent on older runtimes. */
  gitCoauthor?: boolean;
  gitCoauthorAvailable?: boolean;
  /** Absent on older runtimes (treated as on). */
  alwaysRecruitSubagents?: boolean;
  /** Absent on older runtimes (treated as on). */
  allowCrossProjectAgents?: boolean;
  /** Max direct subagents per agent; null/absent = default (6). Absent on older runtimes. */
  subagentMaxChildren?: number | null;
  /** Max subagents in total; null/absent = default (24). Absent on older runtimes. */
  subagentMaxTotal?: number | null;
  /** Operator ceilings the two limits are clamped to. Absent on older runtimes (UI falls back to 32 / 200). */
  subagentCeilings?: { maxChildren: number; maxTotal: number };
  /** Absent on older runtimes (treated as acknowledged). */
  autoApproveAcknowledged?: boolean;
}

export interface SettingsPatch {
  claudeAutoApprove?: boolean;
  codexAutoApprove?: boolean;
  gitName?: string | null;
  gitEmail?: string | null;
  gitCoauthor?: boolean;
  alwaysRecruitSubagents?: boolean;
  allowCrossProjectAgents?: boolean;
  subagentMaxChildren?: number | null;
  subagentMaxTotal?: number | null;
  autoApproveAcknowledged?: true;
}

/** The fixed Floq subagent policy, read-only (GET /v1/subagents/policy). */
export interface SubagentPolicy {
  enabled: boolean;
  limits: { maxDepth: number; maxChildren: number; maxTotal: number };
  tools: Array<{ name: string; command: string; summary: string }>;
  instruction: string;
}

export type Exposure = "tool" | "env";

export interface SecretInfo {
  name: string;
  description: string;
  expose: Exposure;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

/** A wire between two agent sessions on the Canvas (directed from -> to). */
export interface AgentLink {
  id: string;
  projectId: string | null;
  fromSessionId: string;
  toSessionId: string;
  kind: "recruit" | "message" | "manual";
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  /** Wire to an agent of another project: the end outside the requested project. */
  foreign?: { sessionId: string; title: string; projectId: string | null; projectName: string; direction: "out" | "in" };
}

// --- canvas notes + agent secrets (runtime/src/notes.ts, secrets.ts) ---
export type NoteColor = "yellow" | "blue" | "green" | "pink" | "purple" | "gray";
/** note: wired agents only. memory: project memory every agent of the project reads and edits. system: project rules every agent follows; only the user can edit them. */
export type NoteKind = "note" | "memory" | "system";
export interface CanvasNote {
  id: string;
  projectId: string | null;
  text: string;
  color: NoteColor;
  /** Defaults to "note" for older runtimes. */
  kind?: NoteKind;
  /** Name of the agent that created the note; null/absent when the user did. */
  author?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Agents wired to the note; they can read and edit it and create notes with `floq sticky`. */
  linkedSessionIds: string[];
  /** Header title: the `floq note` name for a mirrored card, else what the user typed; null when none. */
  title?: string | null;
  /** Name of the `floq note` this card mirrors; null for plain canvas notes. */
  agentNoteName?: string | null;
  /** False until the canvas has picked and saved a spot for a note an agent created. */
  placed?: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface CanvasNoteInput { text?: string; color?: NoteColor; kind?: NoteKind; x?: number; y?: number; w?: number; h?: number; agentNoteName?: string; title?: string | null }
/**
 * A canvas wallet of secrets, linked to agents with wires. Names only: values are write-only and never returned.
 * Agents pull values with `floq secret get NAME`; each pull is recorded in `secrets`. Nothing is injected at start.
 */
export interface KeychainSecret {
  name: string;
  /** Agent session id that added it; null when the user typed it. */
  createdBy: string | null;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  uses: number;
}
export interface Keychain {
  id: string;
  projectId: string | null;
  projectName?: string | null;
  name: string;
  color: NoteColor;
  x: number;
  y: number;
  w: number;
  h: number;
  secretNames: string[];
  secrets: KeychainSecret[];
  linkedSessionIds: string[];
  linkedCount: number;
  createdAt: string;
  updatedAt: string;
  appliesOnNextStart?: boolean;
}
export interface KeychainInput { name?: string; color?: NoteColor; x?: number; y?: number; w?: number; h?: number }

/** Live frame on the `/v1/events` socket and items of GET /v1/projects/:id/events. */
export interface AgentMessageEvent {
  type: "agent-message";
  linkId: string;
  fromSessionId: string;
  toSessionId: string;
  projectId: string | null;
  kind: "ask" | "reply" | "recruit";
  preview: string;
  at: string;
  /** Set when the message crossed projects. */
  cross?: { fromTitle: string; toTitle: string; fromProject: string; toProject: string };
}

/** An agent's request (`floq port open`) to forward a port; the runtime waits for the user's answer for timeoutMs. */
export interface PortRequest {
  id: string;
  sessionId: string;
  agentName: string;
  port: number;
  protocol: "http" | "https" | "tcp";
  purpose: string;
  privileged: boolean;
  /** Time left on the runtime's own clock when this snapshot was taken. */
  remainingMs: number;
  timeoutMs: number;
}

/** Live frames for port requests on the `/v1/events` socket. */
export type PortRequestFrame =
  | { type: "port-request"; request: PortRequest }
  | { type: "port-request-resolved"; id: string; sessionId: string; status: "accepted" | "denied" | "timeout" | "cancelled" | "failed" };

export interface DeviceFlow {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePoll =
  | { status: "pending"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "connected"; login: string };

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export type ServerFrame =
  | { type: "hello"; server: ServerInfo; session: SessionSummary; truncated: number }
  | { type: "output"; seq: number; data: string; ts: number }
  | { type: "state"; session: SessionSummary }
  | { type: "exit"; session: SessionSummary }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; ts: number };

export type ClientFrame =
  | { type: "input"; data: string }
  | { type: "prompt"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "interrupt" }
  | { type: "ping" };

export type LoginProviderId = "claude" | "codex";

export interface ProviderLoginStatus {
  connected: boolean;
  detail?: string | null;
  expiresAt?: string | null;
  plan?: string | null;
}

export type ProvidersStatus = Record<LoginProviderId, ProviderLoginStatus>;

export interface GithubRepo {
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  cloneUrl: string;
  updatedAt: string;
}

export interface GithubRepoPage {
  repos: GithubRepo[];
  nextPage: number | null;
}

export interface ClaudeOAuthStart {
  flowId: string;
  authorizeUrl: string;
}

export interface ClaudeOAuthResult {
  connected: boolean;
  plan?: string | null;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  detail?: string;
}

export interface ProviderUsage {
  connected: boolean;
  plan?: string | null;
  windows: UsageWindow[];
  fetchedAt?: string | null;
  error?: string | null;
}

export type ProvidersUsage = Record<LoginProviderId, ProviderUsage | null>;

/** A TCP port a session's processes are listening on (runtime host side). */
export interface SessionPort {
  port: number;
  address: string;
}

/** Mirrors runtime/src/debugLinks.ts DebugLink: an app URL seen in the session's output whose port(s) it listens on. */
export interface SessionDebugLink {
  kind: "preview" | "devtools" | "vm-service";
  url: string;
  /** Local port == remote port once forwarded. */
  port: number;
  /** Also needs these forwarded (DevTools -> VM service). */
  extraPorts?: number[];
  label: string;
  detectedAt: number;
}

/** An agent asking the USER to approve an irreversible or outward-facing action (`floq approval request`). */
export interface ApprovalAgentRef { id: string; name: string; provider: "claude" | "codex"; projectId: string | null; projectName: string | null; /** "plugin" when a Floq plugin (not an agent session) is asking. */ kind?: "agent" | "plugin" }
export interface ApprovalRequest {
  id: string;
  requester: ApprovalAgentRef;
  target: ApprovalAgentRef;
  action: string;
  detail: string;
  irreversible: boolean;
  createdAt: string;
  expiresAt: string;
  /** Time left on the runtime's own clock when this snapshot was taken. */
  remainingMs: number;
  timeoutMs: number;
}
export type ApprovalFrame =
  | { type: "approval-request"; approval: ApprovalRequest }
  | { type: "approval-resolved"; id: string; status: "granted" | "denied" | "expired" | "cancelled" | "consumed"; requesterSessionId: string; targetSessionId: string };

/** GET /v1/sessions/:id/display: the session's Xpra display (runtime display.ts). token only while running. */
export interface SessionDisplay {
  running: boolean;
  port: number | null;
  token: string | null;
}

export interface DecisionQuestion { id: string; question: string; header?: string; options: { id: string; label: string; description?: string }[]; multiSelect: boolean; allowText: boolean }
export interface DecisionAnswer { questionId: string; optionIds: string[]; text: string }
export interface DecisionView { id: string; source: 'cli' | 'native'; sessionId: string; projectId: string; sessionName: string; provider: 'claude' | 'codex' | null; questions: DecisionQuestion[]; status: 'pending' | 'answered' | 'cancelled' | 'expired'; createdAt: string; expiresAt: string; answerMode: 'direction' | 'hook' | 'keys' | 'terminal'; response?: { answers: DecisionAnswer[] }; deliveryStatus?: 'pending' | 'delivered' | 'failed' }
export type DecisionFrame = { type: 'decision-request' | 'decision-updated'; decision: DecisionView } | { type: 'decision-resolved'; id: string; sessionId: string; status: 'answered' | 'cancelled' | 'expired'; response?: { answers: DecisionAnswer[] }; deliveryStatus?: 'pending' | 'delivered' | 'failed' };

// ---- Plugins (hand-mirrored from runtime/src/plugins/sdk.ts and host.ts; keep key lists identical) ----

export type PluginScope = "user" | "install";
export type PluginStatus = "available" | "enabled" | "disabled" | "failed" | "invalid";
export type PluginSettingType = "text" | "url" | "number" | "boolean" | "select" | "secretRef";

export interface PluginSettingDecl {
  key: string;
  type: PluginSettingType;
  label: string;
  description?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
}
export interface PluginViewDecl { id: string; label: string; icon?: string }
export interface PluginTaskSourceDecl { id: string; label: string; view: "generic" | "custom" }
export interface PluginRightSidebarTabDecl { id: string; label: string; icon?: string }

export interface PluginContributes {
  views: PluginViewDecl[];
  taskSources: PluginTaskSourceDecl[];
  rightSidebarTabs: PluginRightSidebarTabDecl[];
  settingsPanel: boolean;
}

/** `GET /v1/plugins` row: the public manifest subset plus install, user and status state. Secret values are never included. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: string;
  scope: PluginScope;
  status: PluginStatus;
  /** Install-wide switch. */
  enabled: boolean;
  /** This user's switch (always true for install scope when enabled). */
  userEnabled: boolean;
  error?: string;
  /** "installed" plugins come from a package and can be updated or uninstalled by an admin. */
  source: "builtin" | "installed";
  /** Present when the plugin ships a UI bundle: the sha256 the app checks before loading it. */
  ui: { sha256: string } | null;
  secrets: { name: string; description?: string; required: boolean; present: boolean }[];
  settings: PluginSettingDecl[];
  contributes: PluginContributes;
}
export type PluginSettingValues = Record<string, string | number | boolean>;

/** `GET /v1/plugins/:id/secrets` row. Values are write-only: the runtime never returns one. */
export interface PluginSecretStatus {
  name: string;
  description: string;
  required: boolean;
  present: boolean;
  updatedAt: string | null;
  scope: "user" | "install";
  /** Install scope: true only for an administrator. */
  editable: boolean;
}
/** `GET /v1/plugins/secret-migrations` item: names only. */
export interface PluginSecretMigration {
  pluginId: string;
  pluginName: string;
  name: string;
  movedAt: string;
  /** The vault copy was kept because another tool still references it. */
  keptInVault: boolean;
}

// ---- Task sources (mirrors runtime/src/plugins/taskSources.ts) ----

export type TaskStatusCategory = "todo" | "doing" | "done";
export interface ExternalTask {
  sourceId: string;
  externalId: string;
  title: string;
  status: string;
  statusCategory: TaskStatusCategory;
  assignee?: string;
  priority?: string;
  url: string;
  updatedAt: string;
  fields: { label: string; value: string }[];
}
export interface TaskSourceInfo { pluginId: string; sourceId: string; label: string; view: "generic" | "custom"; icon?: string; missingSecrets: string[] }
export interface ExternalTaskPage { items: ExternalTask[]; nextCursor?: string }

// ---- Plugin catalog (installable plugins) ----

/** What the runtime found in a GitHub repository's newest release: shown before an install or update, never stored by the preview. */
export interface PluginRepoPreview {
  repo: string; tag: string; id: string; name: string; version: string; description: string; scope: PluginScope;
  secrets: string[]; network: string[]; contributes: string[]; sha256: string; size: number; installedVersion: string | null; builtin: boolean;
}
export interface PluginUpdateNotice { id: string; name: string; installedVersion: string; availableVersion: string; repo: string | null }

export interface PluginCatalogItem {
  id: string; name: string; version: string; apiVersion: number; description: string; icon?: string; scope: PluginScope;
  secrets: string[]; network: string[]; contributes: string[]; minFloq?: string;
  /** Optional grouping label from the catalog, and the `owner/repo` the package is released from (for the avatar). */
  category?: string; repo?: string;
  /** Built into this runtime: listed, but cannot be installed or removed. */
  builtin: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
}

// --- agent memory (runtime/src/memories.ts) ---
export type MemoryType = "fact" | "decision" | "procedure" | "episode";
export type MemoryScope = "project" | "user";
export interface Memory {
  id: string;
  projectId: string | null;
  scope: MemoryScope;
  type: MemoryType;
  title: string;
  text: string;
  pinned: boolean;
  author: string | null;
  authorSession: string | null;
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  supersededBy: string | null;
  invalidReason: string | null;
  /** Only on search results. */
  score?: number;
}
export type MemorySearchMode = "hybrid" | "fulltext";
export interface MemoryInput { text?: string; title?: string; type?: MemoryType; pinned?: boolean; scope?: MemoryScope }
export interface MemoryPatch { text?: string; title?: string; type?: MemoryType; pinned?: boolean; invalidated?: boolean; /** with invalidated: true */ reason?: string }
export interface MemoryGraphEdge { source: string; target: string; weight: number; kind: "semantic" | "keyword" | "supersedes" }
export interface MemoryGraph { nodes: Array<{ id: string }>; edges: MemoryGraphEdge[]; mode: "semantic" | "keyword" }
export interface MemoryEvent {
  id: number | string;
  memoryId: string;
  sessionId: string | null;
  actor: "agent" | "user" | "system";
  action: "add" | "update" | "invalidate" | "pin" | "unpin" | "delete";
  before: Partial<Memory> | null;
  after: Partial<Memory> | null;
  createdAt: string;
}
export interface MemoryStatus { /** FLOQ_REDIS_URL is set (stable); redis = reachable now */ enabled?: boolean; redis: boolean; backend?: "redis" | "dragonfly" | null; embeddings: "local" | "openai" | "off"; model: string; ready: boolean; migration?: { done: boolean; notes: number; added: number; pinned: number; at: string | null } | null; vectors?: boolean }
