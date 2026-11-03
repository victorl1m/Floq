// Mirrors runtime/src/types.ts and the REST payloads in runtime/src/server.ts.

export type ProviderId = "claude" | "codex" | "shell";

export type SessionState = "starting" | "running" | "sleeping" | "exited" | "failed";

export interface SessionSummary {
  id: string;
  provider: ProviderId;
  title: string;
  state: SessionState;
  cwd: string;
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
  sessionIds: string[];
}

export interface RuntimeProject {
  id: string;
  name: string;
  displayName: string | null;
  imageUrl: string | null;
  gitUrl: string | null;
  cwd: string;
  createdAt: string;
  workspaces: ProjectWorkspace[];
}

export interface TaskCard { id: string; title: string; description: string; position: number; assigneeId: string | null; dueAt: string | null; createdAt: string; updatedAt: string }
export interface TaskList { id: string; title: string; position: number; cards: TaskCard[] }
export interface TaskBoard { id: string; organizationId: string; title: string; createdAt: string; lists: TaskList[] }
export interface OrganizationMember { id: string; name: string; email: string; role: "owner" | "member" }
export interface Organization { id: string; name: string; role: "owner" | "member"; members: OrganizationMember[] }

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
}

export interface SettingsPatch {
  claudeAutoApprove?: boolean;
  codexAutoApprove?: boolean;
  gitName?: string | null;
  gitEmail?: string | null;
  gitCoauthor?: boolean;
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
}

// --- canvas notes + agent secrets (runtime/src/notes.ts, secrets.ts) ---
export type NoteColor = "yellow" | "blue" | "green" | "pink" | "purple" | "gray";
export interface CanvasNote {
  id: string;
  projectId: string | null;
  text: string;
  color: NoteColor;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: string;
  updatedAt: string;
}
export interface CanvasNoteInput { text?: string; color?: NoteColor; x?: number; y?: number; w?: number; h?: number }
/**
 * A canvas wallet of secrets, linked to agents with wires. Names only: values are write-only and never returned.
 * Mutations (secret set/delete, link/unlink) return the updated Keychain with appliesOnNextStart = true when a live
 * session is affected (its env changes on next start; files for `floq secret get` update immediately).
 */
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
}

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
