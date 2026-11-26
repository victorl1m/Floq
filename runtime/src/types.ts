export type ProviderId = "claude" | "codex" | "opencode" | "antigravity" | "shell";

export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "opencode", "antigravity", "shell"];

/** Providers authenticated by an API key / env var from the vault (no subscription login broker). */
export type KeyProviderId = "opencode" | "antigravity";
/** Providers `floq recruit` / `floq subagent recruit` may start (never the plain shell). */
export const RECRUIT_PROVIDERS: readonly ProviderId[] = ["claude", "codex", "opencode", "antigravity"];
export const KEY_PROVIDER_IDS: readonly KeyProviderId[] = ["opencode", "antigravity"];

export type SessionState = "starting" | "running" | "sleeping" | "exited" | "failed";

export interface SessionSummary {
  id: string;
  provider: ProviderId;
  title: string;
  state: SessionState;
  cwd: string;
  /** Logical project root used to group and connect sessions with different working trees. */
  projectCwd?: string | null;
  projectId?: string | null;
  /** Organization of the session's project (personal organization for scratch sessions); set by the session list. */
  organizationId?: string | null;
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
  /** Chosen model id, or null for the CLI default. */
  model: string | null;
  /** Role preset id this agent was recruited with, or null (generalist). */
  role?: string | null;
  /** Session that recruited this one via the floq CLI, or null. */
  /** True once the agent was removed: the conversation is kept and listed under Conversations, not on the canvas. */
  archived?: boolean;
  parentSessionId?: string | null;
  /** Turn status of a running agent; only set on the session list (polled), absent otherwise. */
  activity?: "working" | "idle" | "waiting-for-input";
  /** Set while the agent runs on a usage-limit fallback (or is paused until the limit resets). */
  /** Per-agent usage-limit policy: "model" = model step only, "pause" = pause instead of any change; null/absent = the default chain. */
  fallbackOverride?: "model" | "pause" | null;
  fallback?: { kind: "model" | "account" | "codex" | "paused"; label: string; originLabel: string; resetsAt: string | null; keep: boolean; reason?: "no_step" | "pause_override" | "fallback_loop" | "steps_unavailable" } | null;
}

export interface ProjectWorkspace {
  id: string;
  cwd: string;
  name: string;
  branch: string | null;
  isWorktree: boolean;
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
  createdAt: string;
  /** Organization the project belongs to (a partition of the owner's own projects). */
  organizationId: string;
  workspaces: ProjectWorkspace[];
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface ProviderInfo {
  models: ModelOption[];
  id: ProviderId;
  label: string;
  command: string;
  available: boolean;
  version: string | null;
  args: string[];
  /** Env var (vault secret exposed as env) the provider cannot work without, when it has no login flow. */
  needsApiKey?: string;
  apiKeyConfigured?: boolean;
  /** Antigravity: a Google-account login (token file) exists, so no API key is needed. */
  oauthConnected?: boolean;
}

export interface CreateSessionInput {
  provider: ProviderId;
  title?: string;
  cwd?: string;
  /** Shell sessions only: start in the user's own home directory (no project). Mutually exclusive with cwd/project/workspace. */
  home?: boolean;
  projectId?: string;
  workspaceId?: string;
  /** Start in a new managed Git worktree; only valid for a registered project. */
  isolated?: boolean;
  gitUrl?: string;
  /** Run `specify init` (GitHub Spec Kit) in the project directory. */
  specKit?: boolean;
  /** Lead agents may connect, recruit and dismiss other agents. Set by the user, never by an agent. */
  lead?: boolean;
  /** First message for the agent. Fresh start only, never on resume; not stored. */
  prompt?: string;
  /** Agent role preset id (see roles.ts); omit or "generalist" for none. Fresh start only. */
  role?: string;
  /** Model id from the provider's list in /v1/info (omit or "default" for the CLI default). */
  model?: string;
  cols?: number;
  rows?: number;
}

/** Frames sent from the runtime to a client. */
export type ServerFrame =
  | { type: "hello"; server: ServerInfo; session: SessionSummary; truncated: number }
  | { type: "output"; seq: number; data: string; ts: number }
  | { type: "state"; session: SessionSummary }
  | { type: "exit"; session: SessionSummary }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; ts: number };

/** Frames sent from a client to the runtime. */
export type ClientFrame =
  | { type: "input"; data: string }
  | { type: "prompt"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "interrupt" }
  | { type: "ping" };

export interface ServerInfo {
  name: "floq-runtime";
  version: string;
  startedAt: string;
  providers: ProviderId[];
  maxSessions: number;
  activeSessions: number;
  /** Optional features (see capabilities.ts). */
  capabilities?: string[];
  /** Agent browser in this runtime's image: available, disabled (FLOQ_AGENT_BROWSER=off) or missing (older image). Absent on older runtimes. */
  browser?: "available" | "disabled" | "missing";
  /** The server's default IANA time zone and where it came from (FLOQ_TIMEZONE, TZ or the server's clock). Absent on older runtimes. */
  timeZone?: { zone: string; source: "FLOQ_TIMEZONE" | "TZ" | "system" };
}

/** A mirrored Antigravity swarm worker / core subagent (derived from agy's files, never persisted). Identical to src/lib/runtime/types.ts. */
export type VirtualAgentStatus = "working" | "waiting" | "done" | "killed" | "error" | "stopped";
export interface VirtualAgent {
  id: string;
  hostSessionId: string;
  projectId: string;
  parentId: string;
  name: string;
  role: string;
  kind: "swarm" | "subagent";
  model: string | null;
  status: VirtualAgentStatus;
  activity: string | null;
  steps: number;
  lastAt: string | null;
  swarmTitle: string | null;
  unread: number;
}
export interface VirtualAgentStep { index: number; type: string; status: string | null; createdAt: string | null; text: string | null; tools: { name: string; summary: string | null }[]; error: string | null }
