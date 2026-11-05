export type ProviderId = "claude" | "codex" | "shell";

export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "shell"];

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
  /** Number of per-agent secrets attached (never their values). Set on the session list. */
  secretCount?: number;
  /** Turn status of a running agent; only set on the session list (polled), absent otherwise. */
  activity?: "working" | "idle" | "waiting-for-input";
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
  gitUrl: string | null;
  cwd: string;
  createdAt: string;
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
}
