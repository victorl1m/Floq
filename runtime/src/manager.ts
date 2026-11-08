import { randomUUID } from "node:crypto";
import { SkillsService, loadRemovedSkills } from "./skills.js";
import { mergeGlobalCodexMcp } from "./mcpConfig.js";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type pg from "pg";
import type { Config, ModelEntry } from "./config.js";
import { badRequest, conflict, notFound, tooMany, unavailable } from "./errors.js";
import { log } from "./logger.js";
import { stripAnsi } from "./orchestrator.js";
import { streamToFile, validAttachmentName } from "./attachments.js";
import type { Readable } from "node:stream";
import type { Keychains } from "./keychains.js";
import { buildWiredNotice, type WireRef, type WiredContext } from "./wiredContext.js";
import { parseRoleId as parseRoleIdForPatch } from "./roles.js";
import { validCredential, type CredentialBroker, type CredentialData, type OAuthProvider } from "./credentials.js";
import { nativeSubagentBlockArgs } from "./nativeSubagentBlock.js";
import { DisplayAllocator, displayEnv } from "./display.js";
import { buildSessionEnv, detectVersion, forcedSessionEnv, getProviderDefinition, resolveModel } from "./providers.js";
import { CodexModelCatalog, fetchCodexModelList } from "./codexModels.js";
import { Session } from "./session.js";
import { CapacityReservations, ClosingGate, coalesce } from "./lifecycleGate.js";
import { createWorktree } from "./worktree.js";
import { codexTrustArgs, managedTrustDirectories } from "./codexTrust.js";
import { claudeProjectTrust, claudeStartupSettings, readClaudeProjectConfig } from "./claudeSettings.js";
import { isAllowedProjectIconColor, isAllowedProjectIconName, isAllowedProjectImage } from "./projectImage.js";
import { checkProjectBranchSwitch, listProjectBranches, switchProjectBranch, type GitCommandResult } from "./projectBranches.js";
import { countPlainFiles, countPorcelain, planCheckouts, removeManagedCheckout, type CheckoutReport, type ProjectDeleteResult, type ProjectDeleteStatus } from "./projectDelete.js";
import { pruneProjectFromFolders } from "./projectFolders.js";
import { assertCanDelete, deleteWorktree, inspectWorktree, type WorktreeDeleteResult, type WorktreeStatus } from "./worktreeDelete.js";
import { claudeTranscriptPath, readClaudeNativeTitle, readCodexNativeTitle, readTranscriptTail } from "./nativeTitle.js";
import { agentStatus, analyzeTranscript, endsWithAssistantText, type TranscriptTurn } from "./turn.js";
import { composeRolePrompt, parseRoleId, pickModelForCapability } from "./roles.js";
import { buildRecruitSkillsBlock, storedRecruitSkills } from "./recruitSkills.js";
import { MANAGED_FILE, promoteUserPlugins } from "./claudeManagedPlugins.js";

/** The image's Claude Code managed settings (native-subagent deny): the base of every user's own copy. */
const IMAGE_MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";
import { syncCodexManagedGuidance, syncProtectedFloqSkill } from "./codexGuidance.js";
import { composeSystemBlocks } from "./subagents.js";
import { NETNS_GATEWAY } from "./netns.js";
import { mkdirOwned, mkdirOwnedSegment, ownTree, safeRelative, writeFileOwned, type ShardHandle } from "./shard.js";
import { GIT_HARDENING_ARGS, GIT_HARDENING_ENV } from "./worktree.js";
import { HOME_CWD, wantsHomeShell } from "./homeShell.js";
import type { ShardService } from "./shards.js";
import type { Vault } from "./vault.js";
import type { RuntimeProfile } from "./settings.js";
import { PROVIDER_IDS, type CreateSessionInput, type ProviderId, type RuntimeProject, type ProjectWorkspace, type SessionState, type SessionSummary } from "./types.js";
import { serialPerTarget, typeMessage } from "./messageDelivery.js";

const GIT_URL = /^(https:\/\/|ssh:\/\/|git@)[\w.@:/~+-]+$/;
/** GIT_URL plus: no option-like host or user (`ssh://-oProxyCommand=...`, `git@-host:x`) that ssh could parse as a flag. */
export function isAllowedGitUrl(url: string): boolean {
  const match = GIT_URL.exec(url);
  if (!match) return false;
  const rest = url.slice(match[1].length);
  const authority = match[1] === "git@" ? "git@" + rest.split(":")[0] : rest.split("/")[0];
  return !authority.split("@").some((part) => part.startsWith("-"));
}
const MAX_UPLOADS_PER_USER = 3;
const uploadsInFlight = new Map<string, number>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REAP_INTERVAL_MS = 15_000;
/** If a resumed agent dies this fast with an error, there was nothing to resume: start fresh. */
const RESUME_FALLBACK_MS = 8_000;
const CODEX_ID_POLL_MS = 3_000;
const CODEX_MODEL_TIMEOUT_MS = 20_000;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Every Codex session gets a private CODEX_HOME, so the only rollout file in it belongs to that session. */
const codexHomeRel = (id: string) => ".floq/codex/" + id;

function findRollout(dir: string): string | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findRollout(join(dir, entry.name));
      if (found) return found;
    } else {
      const match = ROLLOUT.exec(entry.name);
      if (match) return match[1];
    }
  }
  return null;
}

function findRolloutFile(dir: string): string | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findRolloutFile(join(dir, entry.name));
      if (found) return found;
    } else if (ROLLOUT.test(entry.name)) return join(dir, entry.name);
  }
  return null;
}

const MAX_TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;

interface Row {
  id: string;
  user_id: string;
  provider: ProviderId;
  title: string;
  cwd: string;
  project_cwd: string | null;
  project_id: string | null;
  workspace_id: string | null;
  branch: string | null;
  git_url: string | null;
  state: SessionState;
  cols: number;
  rows: number;
  last_seq: string;
  resume_count: number;
  sleep_reason: string | null;
  created_at: Date;
  last_active_at: Date;
  slept_at: Date | null;
  provider_session_id: string | null;
  title_locked: boolean;
  lead: boolean;
  model: string | null;
  role?: string | null;
  parent_session_id?: string | null;
  recruit_skills?: string[] | null;
  archived_at?: Date | null;
}

function summaryFromRow(row: Row): SessionSummary {
  return {
    id: row.id,
    provider: row.provider,
    title: row.title,
    state: row.state,
    cwd: row.cwd,
    projectCwd: row.project_cwd,
    projectId: row.project_id,
    worktreeId: row.workspace_id,
    branch: row.branch,
    gitUrl: row.git_url,
    cols: row.cols,
    rows: row.rows,
    createdAt: row.created_at.toISOString(),
    startedAt: null,
    endedAt: row.slept_at ? row.slept_at.toISOString() : null,
    exitCode: null,
    signal: null,
    pid: null,
    seq: Number(row.last_seq),
    bufferedBytes: 0,
    droppedBytes: 0,
    resumeCount: row.resume_count,
    sleepReason: row.sleep_reason,
    model: row.model ?? null,
    role: row.role ?? null,
    parentSessionId: row.parent_session_id ?? null,
    archived: row.archived_at != null,
  };
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_COLS = 400;
const FLOQ_PR_ATTRIBUTION = "\u{1F916} Generated with [Floq](https://floq.flowless.app)";

function normalizeGitUrl(value: string): string {
  const raw = value.trim();
  if (!GIT_URL.test(raw) || /https?:\/\/[^/]*@/.test(raw)) throw badRequest("Unsupported git URL", "invalid_git_url");
  let host: string;
  let path: string;
  const scp = /^git@([^:]+):(.+)$/.exec(raw);
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw badRequest("Unsupported git URL", "invalid_git_url"); }
    if (!(["https:", "ssh:"].includes(parsed.protocol)) || parsed.password || (parsed.protocol === "https:" && parsed.username) || (parsed.protocol === "ssh:" && parsed.username && parsed.username !== "git")) {
      throw badRequest("Unsupported git URL", "invalid_git_url");
    }
    host = parsed.host.toLowerCase();
    path = parsed.pathname;
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!host || !path || path === "/") throw badRequest("Unsupported git URL", "invalid_git_url");
  if (host === "github.com") path = path.toLowerCase();
  return host + "/" + path.replace(/^\/+/, "");
}

function projectNameFromUrl(value: string): string {
  const segment = value.replace(/[?#].*$/, "").replace(/\/$/, "").split(/[/:]/).filter(Boolean).at(-1) ?? "Project";
  return segment.replace(/\.git$/i, "").slice(0, 120) || "Project";
}

function validateProjectName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest("name must be a non-empty string of at most 120 characters", "invalid_project");
  const name = value.trim();
  if (!name || name.length > 120) throw badRequest("name must be a non-empty string of at most 120 characters", "invalid_project");
  return name;
}

function branchFromCheckout(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match?.[1] ?? null;
  } catch { return null; }
}

function insidePath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function safeWorkspaceBranch(home: string, cwd: string): { ok: boolean; branch: string | null } {
  try {
    const root = realpathSync(home);
    const checkout = realpathSync(join(home, safeRelative(cwd)));
    if (!insidePath(root, checkout)) return { ok: false, branch: null };
    const gitMeta = join(checkout, ".git");
    let headPath: string;
    if (statSync(gitMeta).isDirectory()) headPath = join(gitMeta, "HEAD");
    else {
      const marker = readFileSync(gitMeta, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/.exec(marker);
      if (!match) return { ok: false, branch: null };
      const gitDir = realpathSync(resolve(checkout, match[1]));
      if (!insidePath(root, gitDir)) return { ok: false, branch: null };
      headPath = join(gitDir, "HEAD");
    }
    const realHead = realpathSync(headPath);
    if (!insidePath(root, realHead)) return { ok: false, branch: null };
    const head = readFileSync(realHead, "utf8").trim();
    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
    if (ref) return { ok: true, branch: ref[1] };
    if (/^[0-9a-f]{40,64}$/i.test(head)) return { ok: true, branch: null };
    return { ok: false, branch: null };
  } catch { return { ok: false, branch: null }; }
}

function safePlainProjectRoot(home: string, cwd: string, projectId: string): string | null {
  const expected = `.floq/projects/${projectId}`;
  try {
    if (safeRelative(cwd) !== expected) return null;
    const root = realpathSync(home);
    let current = root;
    for (const part of expected.split("/")) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      current = realpathSync(current);
      if (!insidePath(root, current)) return null;
    }
    try {
      lstatSync(join(current, ".git"));
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? current : null;
    }
  } catch { return null; }
}

interface LoginState {
  userId: string;
  provider: OAuthProvider;
  timers: NodeJS.Timeout[];
  poll?: NodeJS.Timeout;
  dir: string;
  finishing: boolean;
  /** ANSI-stripped tail of the terminal output, for diagnostics only (scrubbed before logging). */
  tail: string;
  startedAt: number;
  session: Session;
}

export interface CreateSessionOptions {
  /** Trusted logical project identity supplied by the authenticated recruiter. */
  projectCwd?: string | null;
  /** Source repository metadata; used for grouping but never to clone this session again. */
  projectGitUrl?: string | null;
  isolated?: boolean;
  /** Session that recruited this one (floq CLI orchestration); drives the canvas edges. */
  parentSessionId?: string | null;
  /** Skills the recruiter asked this agent to use (`--skill`); repeated in its system-level instructions on every start. */
  skills?: string[];
}

/** The TUI counts as ready once it was quiet this long after its first output, or after READY_TIMEOUT_MS regardless. */
const READY_QUIET_MS = 1_500;
const READY_TIMEOUT_MS = 30_000;
const BOOT_RESUME_CONCURRENCY = 3;
/** Typed (trusted) into agents that were mid-turn when the runtime stopped. */
export const BOOT_RESUME_NOTICE = "[Floq] The runtime restarted while you were working. Your last tool call may not have finished and background tasks/native subagents were stopped. Check what actually happened (files, git status, processes), then continue your task.";

export class SessionManager {
  /** Owner of the Claude / Codex subscription credentials (set at startup). */
  credentials!: CredentialBroker;
  /** Keychains linked to agents (set at startup); absent in tests that do not need them. */
  keychains?: Keychains;
  /** Notes, keychains and agents wired to each agent, persisted so every start and resume re-injects them (set at startup). */
  wired?: WiredContext;
  /** Fixed always-recruit-subagents policy block, injected for every agent start and resume (set at startup). */
  subagents?: { blockFor(userId: string, sessionId: string): Promise<string> };
  private readonly logins = new Map<string, LoginState>();
  /** mtime of credential files we wrote or last read, to detect a CLI refreshing on its own. */
  private readonly credMtime = new Map<string, number>();
  private readonly live = new Map<string, Session>();
  /** Runtime-wide X display / Xpra port slots, one per live session (display.ts). */
  readonly displays = new DisplayAllocator();
  private readonly stoppingSessions = new Map<string, Session>();
  private readonly intentionalSleep = new Set<string>();
  private readonly lockTimers = new Map<string, NodeJS.Timeout>();
  private readonly codexPollers = new Map<string, NodeJS.Timeout>();
  private readonly nativeTitleSessions = new Map<string, {
    userId: string;
    provider: "claude" | "codex";
    fallback: string;
    providerSessionId: string | null;
    handle: ShardHandle;
    checkedAt: number;
    lastNativeTitle: string | null;
    checking: boolean;
  }>();
  private readonly codexModelCatalog: CodexModelCatalog;
  private readonly specKitTasks = new Map<string, Promise<void>>();
  private readonly capacityReservations = new CapacityReservations();
  private readonly lifecycle = new ClosingGate();
  private readonly resumeTasks = new Map<string, Promise<SessionSummary>>();
  private readonly restartTasks = new Map<string, Promise<SessionSummary>>();
  private readonly loginTasks = new Map<string, Promise<SessionSummary>>();
  private readonly projectCreates = new Map<string, Promise<RuntimeProject>>();
  private readonly projectBranchLocks = new Map<string, Promise<void>>();
  private readonly shardActivityCounts = new Map<string, number>();
  private readonly shardActivities = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private readyListeners?: Array<(userId: string, sessionId: string) => void>;
  private bootNotices?: Map<string, string>;
  /** Test hook: overrides the TUI-ready detection timing. */
  readyTiming?: { quietMs: number; timeoutMs: number };
  private readonly reaper: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly pool: pg.Pool,
    private readonly shards: ShardService,
    private readonly vault: Vault,
  ) {
    this.codexModelCatalog = new CodexModelCatalog((userId) => this.discoverCodexModels(userId), config.models.codex);
    this.reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  get activeCount(): number {
    return this.countActiveProcesses();
  }

  activeCountFor(userId: string): number {
    return this.countActiveProcesses(userId);
  }

  private countActiveProcesses(userId?: string): number {
    const sessions = new Map(this.live);
    for (const [id, session] of this.stoppingSessions) sessions.set(id, session);
    return [...sessions.values()].filter((session) => (!userId || session.userId === userId) && session.isAlive && !session.hasExited).length;
  }

  private hasActiveProcess(userId: string): boolean {
    return this.activeCountFor(userId) > 0;
  }

  /** Discover models with this user's refreshed subscription credential and private Codex home. */
  async codexModels(userId: string): Promise<ModelEntry[]> {
    if (this.config.codexModelsOverridden) return this.config.models.codex;
    return this.codexModelCatalog.get(userId);
  }

  invalidateCodexModels(userId: string): void {
    this.codexModelCatalog.invalidate(userId);
  }

  private async discoverCodexModels(userId: string): Promise<ModelEntry[]> {
    await this.credentials.refresh(userId, "codex");
    const credential = await this.credentials.get(userId, "codex");
    if (!credential || !validCredential("codex", credential)) return this.config.models.codex;

    this.cancelLock(userId);
    let handle: ShardHandle;
    try {
      handle = await this.shards.wake(userId);
    } catch (error) {
      if (this.shards.isAwake(userId) && !this.hasActiveProcess(userId)) {
        this.scheduleLock(userId);
      }
      throw error;
    }
    const rel = ".floq-codex-model-discovery-" + randomUUID();
    const home = this.shards.driver.hostPath(handle, rel);
    try {
      mkdirOwned(handle.mountPath, home, handle.uid);
      this.shards.seed(home, ".codex", handle.uid);
      const authFile = join(home, "auth.json");
      writeFileOwned(authFile, JSON.stringify(credential), handle.uid, 0o600);

      const profile: RuntimeProfile = {
        claudeAutoApprove: false,
        codexAutoApprove: false,
        gitName: null,
        gitEmail: null,
        gitCoauthor: "",
        githubToken: null,
      };
      const env = buildSessionEnv(this.config, "codex", profile, "model-discovery");
      env.CODEX_HOME = this.shards.driver.homePath(handle) + "/" + rel;
      return await this.queryCodexModels(handle, env);
    } finally {
      const root = resolve(handle.mountPath);
      const target = resolve(home);
      const fromRoot = relative(root, target);
      if (fromRoot && fromRoot !== ".." && !fromRoot.startsWith(".." + sep)) {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          log.warn("codex.models_temp_cleanup_failed", { userId });
        }
      }
      if (!this.hasActiveProcess(userId)) this.scheduleLock(userId);
    }
  }

  private async queryCodexModels(handle: ShardHandle, env: Record<string, string>): Promise<ModelEntry[]> {
    const child = this.shards.driver.spawn(handle, {
      file: this.config.providers.codex,
      args: ["app-server"],
      env,
      cwd: ".",
      cols: 4096,
      rows: 100,
    });
    let nextId = 1;
    let buffer = "";
    let receivedBytes = 0;
    let exited = false;
    let fatalError: Error | null = null;
    const deadline = Date.now() + 45_000;
    let exitResolve!: () => void;
    const exitedPromise = new Promise<void>((resolveExit) => { exitResolve = resolveExit; });
    const waiters = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    const onData = child.onData((data) => {
      receivedBytes += Buffer.byteLength(data);
      if (receivedBytes > 2 * 1024 * 1024) {
        fatalError = new Error("Codex app-server output exceeded limit");
        for (const waiter of waiters.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("Codex app-server output exceeded limit"));
        }
        waiters.clear();
        child.kill();
        return;
      }
      buffer += data;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const text = stripAnsi(line).trim();
        if (!text.startsWith("{")) continue;
        try {
          const message = JSON.parse(text) as Record<string, unknown>;
          if (typeof message.id !== "number") continue;
          if (!("result" in message) && !("error" in message)) continue;
          const waiter = waiters.get(message.id);
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          waiters.delete(message.id);
          if (message.error) waiter.reject(new Error("Codex app-server JSON-RPC error"));
          else waiter.resolve((message.result ?? {}) as Record<string, unknown>);
        } catch {
          // Ignore terminal diagnostics and PTY echo; only a matching JSON-RPC response is used.
        }
      }
    });
    const onExit = child.onExit(() => {
      exited = true;
      exitResolve();
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Codex app-server exited before replying"));
      }
      waiters.clear();
    });
    const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (exited) return Promise.reject(new Error("Codex app-server has exited"));
      if (fatalError) return Promise.reject(fatalError);
      const timeoutMs = Math.min(CODEX_MODEL_TIMEOUT_MS, deadline - Date.now());
      if (timeoutMs <= 0) return Promise.reject(new Error("Codex app-server total timeout exceeded"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error("Codex app-server request timed out"));
        }, timeoutMs);
        waiters.set(id, { resolve, reject, timer });
        child.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };
    try {
      return await fetchCodexModelList(
        {
          request,
          notify: (method, params) => child.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
        },
        this.config.version,
        this.config.models.codex,
      );
    } finally {
      onData.dispose();
      child.kill();
      if (!exited) await Promise.race([exitedPromise, new Promise<void>((resolveExit) => setTimeout(resolveExit, 1_000))]);
      onExit.dispose();
      for (const waiter of waiters.values()) clearTimeout(waiter.timer);
      waiters.clear();
    }
  }

  findLive(id: string, userId: string): Session | undefined {
    const session = this.live.get(id);
    return session && session.userId === userId ? session : undefined;
  }

  /**
   * Last turn of a live Claude/Codex agent from its native transcript: whether a turn is open and its full final reply.
   * Null when there is no transcript (shell session, not started yet, unreadable); callers fall back to terminal output.
   */
  readAgentTurn(id: string, userId: string): (TranscriptTurn & { mtimeMs: number; trailingAssistantText: boolean }) | null {
    const state = this.nativeTitleSessions.get(id);
    if (!state || state.userId !== userId) return null;
    const path = state.provider === "claude"
      ? claudeTranscriptPath(this.hostHome(state.handle), id)
      : findRolloutFile(this.shards.driver.hostPath(state.handle, codexHomeRel(id) + "/sessions"));
    if (!path) return null;
    const tail = readTranscriptTail(path, MAX_TRANSCRIPT_TAIL_BYTES);
    if (!tail) return null;
    return { ...analyzeTranscript(state.provider, tail.text), mtimeMs: tail.mtimeMs, trailingAssistantText: state.provider === "claude" && endsWithAssistantText(tail.text) };
  }

  /** uid the user's sandboxed processes run as, while their shard is awake; null when unknown. */
  sessionUid(userId: string): number | null {
    const handle = this.shards.awakeHandle(userId);
    if (!handle) return null;
    // The local (dev) driver spawns sessions as the runtime's own uid, not the shard's.
    return this.shards.driver.name === "local" ? process.getuid?.() ?? null : handle.uid;
  }

  /** True when the user's sandboxes run in their own network namespace (FLOQ_NETNS), so ports live there, not on the host. */
  inNetns(userId: string): boolean {
    return Boolean(this.shards.awakeHandle(userId)?.netns);
  }

  /** Path of the user's network namespace while their shard is awake; null without FLOQ_NETNS. */
  netnsPath(userId: string): string | null {
    return this.shards.awakeHandle(userId)?.netns ?? null;
  }

  /** Live session for a user; throws 404 for anyone else's. */
  getLive(id: string, userId: string): Session {
    const session = this.live.get(id);
    if (!session || session.userId !== userId) throw notFound("Session " + id + " is not running");
    return session;
  }

  private async row(id: string, userId: string): Promise<Row> {
    const result = await this.pool.query("SELECT * FROM agent_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!result.rows[0]) throw notFound("Session " + id + " not found");
    return result.rows[0] as Row;
  }

  async createProject(userId: string, profile: RuntimeProfile, gitUrlValue?: string, requestedName?: string): Promise<RuntimeProject> {
    const name = validateProjectName(requestedName);
    if (gitUrlValue === undefined) {
      if (!name) throw badRequest("name is required when gitUrl is not provided", "invalid_project");
      return this.createNamedProject(userId, name);
    }
    if (typeof gitUrlValue !== "string" || !gitUrlValue.trim()) throw badRequest("gitUrl must be a non-empty string", "invalid_project");
    const gitUrl = gitUrlValue.trim();
    const normalized = normalizeGitUrl(gitUrl);
    const key = userId + "\0" + normalized;
    const pending = this.projectCreates.get(key);
    if (pending) return pending;
    const task = this.withShardActivity(userId, async () => {
      const existing = await this.pool.query("SELECT id FROM floq_projects WHERE user_id=$1 AND normalized_git_url=$2", [userId, normalized]);
      if (existing.rows[0]) return (await this.project(userId, String(existing.rows[0].id)))!;
      const handle = await this.shards.wake(userId);
      const id = randomUUID();
      const workspaceId = randomUUID();
      const cwd = ".floq/projects/" + id;
      const target = this.shards.driver.hostPath(handle, cwd);
      this.ensureProjectParent(handle);
      let commitAttempted = false;
      let loserClone = false;
      try {
        await this.clone(gitUrl, target, profile, handle);
        this.assertLifecycleOpen();
        const projectName = name ?? projectNameFromUrl(gitUrl);
        const branch = branchFromCheckout(target);
        const client = await this.pool.connect();
        let projectId: string = id;
        try {
          await client.query("BEGIN");
          const inserted = await client.query(
            `INSERT INTO floq_projects(id,user_id,name,git_url,normalized_git_url,cwd)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT (user_id,normalized_git_url) WHERE normalized_git_url IS NOT NULL DO NOTHING
             RETURNING id`, [id,userId,projectName,gitUrl,normalized,cwd],
          );
          if (!inserted.rows[0]) {
            const winner = await client.query("SELECT id FROM floq_projects WHERE user_id=$1 AND normalized_git_url=$2 FOR UPDATE", [userId, normalized]);
            projectId = String(winner.rows[0]?.id ?? "");
            if (!projectId) throw new Error("Project registration race");
          } else {
            await client.query(
              `INSERT INTO floq_project_workspaces(id,user_id,project_id,cwd,name,branch,is_worktree)
               VALUES($1,$2,$3,$4,'Main',$5,FALSE)`, [workspaceId,userId,id,cwd,branch],
            );
          }
          commitAttempted = true;
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally { client.release(); }
        if (projectId !== id) {
          const resolved = resolve(target);
          const home = resolve(handle.mountPath);
          if (!insidePath(home, resolved)) throw new Error("Project path escaped user home");
          loserClone = true;
          rmSync(resolved, { recursive: true, force: true });
        }
        return (await this.project(userId, projectId))!;
      } catch (error) {
        const resolved = resolve(target);
        const home = resolve(handle.mountPath);
        if ((!commitAttempted || loserClone) && insidePath(home, resolved)) rmSync(resolved, { recursive: true, force: true });
        throw error;
      }
    }).finally(() => this.projectCreates.delete(key));
    this.projectCreates.set(key, task);
    return task;
  }

  private async createNamedProject(userId: string, name: string): Promise<RuntimeProject> {
    return this.withShardActivity(userId, async () => {
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      const id = randomUUID();
      const workspaceId = randomUUID();
      const cwd = ".floq/projects/" + id;
      const target = this.shards.driver.hostPath(handle, cwd);
      this.ensureProjectParent(handle);
      let targetCreated = false;
      let commitAttempted = false;
      let rollbackConfirmed = false;
      let discardClient: Error | undefined;
      try {
        mkdirSync(target);
        targetCreated = true;
        lchownSync(target, handle.uid, handle.uid);
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO floq_projects(id,user_id,name,git_url,normalized_git_url,cwd)
             VALUES($1,$2,$3,NULL,NULL,$4)`, [id,userId,name,cwd],
          );
          await client.query(
            `INSERT INTO floq_project_workspaces(id,user_id,project_id,cwd,name,branch,is_worktree)
             VALUES($1,$2,$3,$4,'Main',$5,FALSE)`, [workspaceId,userId,id,cwd,null],
          );
          commitAttempted = true;
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
            rollbackConfirmed = true;
          } catch (rollbackError) {
            discardClient = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          }
          throw error;
        } finally { client.release(discardClient); }
        const project = await this.project(userId, id);
        if (!project) throw new Error("Created project could not be loaded");
        return project;
      } catch (error) {
        const resolved = resolve(target);
        const home = resolve(handle.mountPath);
        if (targetCreated && insidePath(home, resolved)) {
          if (!commitAttempted) rmSync(resolved, { recursive: true, force: true });
          else {
            // COMMIT can fail after the database accepted it. A missing row is safe to act on only after
            // ROLLBACK was confirmed; otherwise a fresh lookup may race a still-unresolved commit.
            try {
              const registered = await this.pool.query("SELECT id FROM floq_projects WHERE id=$1 AND user_id=$2", [id, userId]);
              if (!registered.rows[0]) {
                if (rollbackConfirmed) rmSync(resolved, { recursive: true, force: true });
              }
              else {
                const project = await this.project(userId, id);
                if (project) return project;
              }
            } catch { /* Database state is uncertain, so keep the files rather than risk deleting a registered project. */ }
          }
        }
        throw error;
      }
    });
  }

  async listProjects(userId: string): Promise<RuntimeProject[]> {
    const projects = await this.pool.query("SELECT * FROM floq_projects WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    const workspaces = await this.pool.query(
      `SELECT w.*, COALESCE(array_agg(s.id::text) FILTER (WHERE s.id IS NOT NULL), ARRAY[]::text[]) AS session_ids
       FROM floq_project_workspaces w LEFT JOIN agent_sessions s ON s.user_id=w.user_id AND s.workspace_id=w.id
       WHERE w.user_id=$1 GROUP BY w.id ORDER BY w.created_at`, [userId],
    );
    const awake = this.shards.awakeHandle(userId);
    if (awake) {
      for (const row of workspaces.rows as Array<Record<string, unknown>>) {
        const head = safeWorkspaceBranch(awake.mountPath, String(row.cwd));
        // Do not expose a removed isolated checkout as a selectable workspace. The shard must
        // already be unlocked before interpreting a missing checkout; sleeping homes cannot
        // distinguish a removed worktree from an unavailable mount. Keep the DB row and session
        // history intact so old sessions remain recoverable.
        if (!head.ok && row.is_worktree === true && row.available !== false) {
          await this.pool.query("UPDATE floq_project_workspaces SET available=FALSE WHERE id=$1 AND user_id=$2", [row.id, userId]);
          row.available = false;
          continue;
        }
        if (head.ok && (head.branch !== row.branch || row.available === false)) {
          await this.pool.query("UPDATE floq_project_workspaces AS w SET branch=$1::text,name=CASE WHEN $1::text IS NULL THEN 'Detached HEAD' ELSE CASE WHEN w.cwd=(SELECT p.cwd FROM floq_projects p WHERE p.id=w.project_id) THEN 'Main' ELSE 'Worktree' END END,available=TRUE WHERE w.id=$2 AND w.user_id=$3", [head.branch, row.id, userId]);
          row.branch = head.branch;
          row.available = true;
          row.name = head.branch === null ? "Detached HEAD" : row.is_worktree ? "Worktree" : "Main";
        }
      }
    }
    const byProject = new Map<string, ProjectWorkspace[]>();
    for (const row of workspaces.rows as Array<Record<string, unknown>>) {
      if (row.available === false) continue;
      const projectId = String(row.project_id);
      const list = byProject.get(projectId) ?? [];
      list.push({ id: String(row.id), cwd: String(row.cwd), name: String(row.name), branch: row.branch ? String(row.branch) : null, isWorktree: Boolean(row.is_worktree), navExpanded: row.nav_expanded !== false, sessionIds: (row.session_ids as string[]).map(String) });
      byProject.set(projectId, list);
    }
    return projects.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id), name: String(row.name), displayName: row.display_name ? String(row.display_name) : null,
      imageUrl: row.image_url ? String(row.image_url) : null, iconName: row.icon_name ? String(row.icon_name) : null, iconColor: row.icon_color ? String(row.icon_color) : null, gitUrl: row.git_url ? String(row.git_url) : null,
      cwd: String(row.cwd), createdAt: new Date(String(row.created_at)).toISOString(), workspaces: byProject.get(String(row.id)) ?? [],
    }));
  }

  async project(userId: string, id: string): Promise<RuntimeProject | null> {
    const projects = await this.listProjects(userId);
    return projects.find((project) => project.id === id) ?? null;
  }

  /** Sidebar collapse state of one workspace, saved with the workspace so it follows the user across clients. */
  async setWorkspaceNavExpanded(userId: string, projectId: string, workspaceId: string, expanded: unknown): Promise<{ id: string; navExpanded: boolean }> {
    if (typeof expanded !== "boolean") throw badRequest("navExpanded must be a boolean", "invalid_workspace");
    if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(workspaceId)) throw notFound("Workspace not found");
    const result = await this.pool.query("UPDATE floq_project_workspaces SET nav_expanded=$4 WHERE id=$1 AND project_id=$2 AND user_id=$3 RETURNING id", [workspaceId, projectId, userId, expanded]);
    if (!result.rows[0]) throw notFound("Workspace not found");
    return { id: workspaceId, navExpanded: expanded };
  }

  /** Collapse or expand every workspace of a project in one write. */
  async setProjectNavExpanded(userId: string, projectId: string, expanded: unknown): Promise<{ navExpanded: boolean }> {
    if (typeof expanded !== "boolean") throw badRequest("navExpanded must be a boolean", "invalid_workspace");
    if (!UUID_PATTERN.test(projectId)) throw notFound("Project not found");
    const owned = await this.pool.query("SELECT 1 FROM floq_projects WHERE id=$1 AND user_id=$2", [projectId, userId]);
    if (!owned.rows[0]) throw notFound("Project not found");
    await this.pool.query("UPDATE floq_project_workspaces SET nav_expanded=$3 WHERE project_id=$1 AND user_id=$2", [projectId, userId, expanded]);
    return { navExpanded: expanded };
  }

  async updateProject(userId: string, id: string, patch: { displayName?: unknown; imageUrl?: unknown; iconName?: unknown; iconColor?: unknown }): Promise<RuntimeProject> {
    if (patch.displayName !== undefined && patch.displayName !== null && (typeof patch.displayName !== "string" || patch.displayName.length > 120)) throw badRequest("displayName must be at most 120 characters", "invalid_project");
    if (patch.imageUrl !== undefined && patch.imageUrl !== null) {
      if (typeof patch.imageUrl !== "string" || !isAllowedProjectImage(patch.imageUrl)) throw badRequest("imageUrl must be an HTTP(S) URL or a small WebP project image", "invalid_project");
      if (!patch.imageUrl.startsWith("data:image/webp;base64,")) try {
        const parsed = new URL(patch.imageUrl);
        if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) throw new Error("invalid image URL");
      } catch { throw badRequest("imageUrl must be a valid HTTP(S) URL without credentials", "invalid_project"); }
    }
    if (patch.iconName !== undefined && patch.iconName !== null && !isAllowedProjectIconName(patch.iconName)) throw badRequest("iconName must be a lowercase catalog icon name", "invalid_project");
    if (patch.iconColor !== undefined && patch.iconColor !== null && !isAllowedProjectIconColor(patch.iconColor)) throw badRequest("iconColor must be a #rrggbb color", "invalid_project");
    const fields: string[] = [];
    const values: unknown[] = [id, userId];
    if (patch.displayName !== undefined) { values.push(patch.displayName); fields.push(`display_name=$${values.length}`); }
    if (patch.imageUrl !== undefined) { values.push(patch.imageUrl); fields.push(`image_url=$${values.length}`); }
    if (patch.iconName !== undefined) { values.push(patch.iconName); fields.push(`icon_name=$${values.length}::text`); }
    if (patch.iconColor !== undefined) { values.push(patch.iconColor); fields.push(`icon_color=$${values.length}::text`); }
    if (!fields.length) throw badRequest("No project fields supplied", "invalid_project");
    const result = await this.pool.query(`UPDATE floq_projects SET ${fields.join(",")} WHERE id=$1 AND user_id=$2 RETURNING id`, values);
    if (!result.rows[0]) throw notFound("Project not found");
    return (await this.project(userId, id))!;
  }

  /**
   * Read-only: what deleting this project would remove (sessions, canvas data, Floq-managed checkouts) and which
   * checkouts have uncommitted work. Mirrors exactly what `deleteProject` acts on.
   */
  async projectDeleteStatus(userId: string, projectId: string): Promise<ProjectDeleteStatus> {
    return this.withShardActivity(userId, async () => {
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      return this.projectDeleteSnapshot(userId, projectId, handle);
    });
  }

  private async projectDeleteSnapshot(userId: string, projectId: string, handle: ShardHandle): Promise<ProjectDeleteStatus> {
    if (!UUID_PATTERN.test(projectId)) throw notFound("Project not found");
    const project = (await this.pool.query("SELECT id,name,display_name FROM floq_projects WHERE id=$1 AND user_id=$2", [projectId, userId])).rows[0] as Record<string, unknown> | undefined;
    if (!project) throw notFound("Project not found");
    const workspaces = (await this.pool.query("SELECT id,cwd,is_worktree FROM floq_project_workspaces WHERE project_id=$1 AND user_id=$2 ORDER BY created_at", [projectId, userId])).rows as Array<Record<string, unknown>>;
    const sessions = (await this.pool.query(
      `SELECT id,state FROM agent_sessions WHERE user_id=$1 AND (project_id=$2 OR workspace_id IN (SELECT id FROM floq_project_workspaces WHERE project_id=$2))`, [userId, projectId],
    )).rows as Array<Record<string, unknown>>;
    const count = async (table: "canvas_notes" | "keychains") => Number((await this.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1 AND project_id=$2`, [userId, projectId])).rows[0]?.n ?? 0);
    const plan = planCheckouts(projectId, workspaces.map((row) => ({ id: String(row.id), cwd: String(row.cwd), isWorktree: row.is_worktree === true })));
    const checkouts: CheckoutReport[] = [];
    for (const item of plan) {
      const report: CheckoutReport = { workspaceId: item.workspaceId, path: item.cwd, kind: item.kind, branch: null, managed: item.managed, state: item.managed ? "ok" : "unmanaged", uncommittedFiles: null };
      if (item.managed) {
        let present = true;
        try { lstatSync(join(handle.mountPath, item.cwd)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false; }
        if (!present) report.state = "missing";
        else {
          const head = safeWorkspaceBranch(handle.mountPath, item.cwd);
          if (!head.ok) {
            const plainRoot = item.kind === "project" ? safePlainProjectRoot(handle.mountPath, item.cwd, projectId) : null;
            if (plainRoot) {
              const fileCount = countPlainFiles(plainRoot);
              if (fileCount === null) report.state = "unreadable";
              else { report.uncommittedFiles = fileCount; report.state = "ok"; }
            } else report.state = "unreadable";
          }
          else {
            report.branch = head.branch;
            try {
              const result = await this.runWorkspaceGit(handle, item.cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
              if (result.exitCode === 0) report.uncommittedFiles = countPorcelain(result.stdout);
              else report.state = "unreadable";
            } catch { report.state = "unreadable"; }
          }
        }
      }
      checkouts.push(report);
    }
    return {
      project: { id: projectId, name: String(project.display_name ?? "").trim() || String(project.name) },
      sessions: { total: sessions.length, live: sessions.filter((row) => row.state === "running" || row.state === "starting" || this.live.get(String(row.id))?.isAlive).length },
      notes: await count("canvas_notes"),
      keychains: await count("keychains"),
      checkouts,
      worktrees: checkouts.filter((item) => item.kind === "worktree" && item.state !== "missing").length,
      dirtyWorktrees: checkouts.filter((item) => item.kind === "worktree" && (item.uncommittedFiles ?? 0) > 0).length,
      dirtyMainCheckout: checkouts.some((item) => item.kind === "project" && (item.uncommittedFiles ?? 0) > 0),
      unmanagedCheckouts: checkouts.filter((item) => !item.managed).length,
      unreadableCheckouts: checkouts.filter((item) => item.state === "unreadable").length,
    };
  }

  /**
   * Irreversibly delete a project: stop and remove its sessions, delete its canvas data in one transaction, then remove the
   * Floq-managed checkouts from the user's volume. Never touches the remote repository or any path outside
   * `.floq/projects/<id>` and `.floq/worktrees/<uuid>` (see removeManagedCheckout).
   */
  async deleteProject(userId: string, projectId: string): Promise<ProjectDeleteResult> {
    return this.withShardActivity(userId, () => this.withProjectBranchLock(projectId, async () => {
      if (!UUID_PATTERN.test(projectId)) throw notFound("Project not found");
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      const owned = await this.pool.query("SELECT id FROM floq_projects WHERE id=$1 AND user_id=$2", [projectId, userId]);
      if (!owned.rows[0]) throw notFound("Project not found");
      const workspaces = (await this.pool.query("SELECT id,cwd,is_worktree FROM floq_project_workspaces WHERE project_id=$1 AND user_id=$2 ORDER BY created_at", [projectId, userId])).rows as Array<Record<string, unknown>>;
      const plan = planCheckouts(projectId, workspaces.map((row) => ({ id: String(row.id), cwd: String(row.cwd), isWorktree: row.is_worktree === true })));
      const sessionIds = (await this.pool.query(
        `SELECT id FROM agent_sessions WHERE user_id=$1 AND (project_id=$2 OR workspace_id IN (SELECT id FROM floq_project_workspaces WHERE project_id=$2))`, [userId, projectId],
      )).rows.map((row: Record<string, unknown>) => String(row.id));

      // 1. Stop live agents/terminals first so nothing writes into the checkouts or the rows while they are removed.
      for (const id of sessionIds) {
        try { rmSync(this.secretDir(handle, id), { recursive: true, force: true }); } catch { /* best effort */ }
        const session = this.live.get(id);
        if (session) {
          this.intentionalSleep.add(id);
          this.live.delete(id);
          this.vault.revokeSession(id);
          session.dispose();
        }
      }

      // 2. All database state in one transaction; sessions cascade to links, inbox, wired memory and note/keychain links.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM agent_approvals WHERE user_id=$1 AND (requester_project_id=$2 OR target_project_id=$2)", [userId, projectId]);
        await client.query("DELETE FROM agent_links WHERE project_id=$1", [projectId]);
        await client.query("DELETE FROM canvas_notes WHERE user_id=$1 AND project_id=$2", [userId, projectId]);
        await client.query("DELETE FROM keychains WHERE user_id=$1 AND project_id=$2", [userId, projectId]);
        await client.query(`DELETE FROM agent_sessions WHERE user_id=$1 AND (project_id=$2 OR workspace_id IN (SELECT id FROM floq_project_workspaces WHERE project_id=$2))`, [userId, projectId]);
        await pruneProjectFromFolders(client, userId, projectId);
        const removed = await client.query("DELETE FROM floq_projects WHERE id=$1 AND user_id=$2 RETURNING id", [projectId, userId]);
        if (!removed.rows[0]) throw notFound("Project not found");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }

      // 3. Files. The project is already gone, so failures are reported (and logged), not thrown.
      const leftovers: ProjectDeleteResult["leftovers"] = [];
      let removedCheckouts = 0;
      const ordered = [...plan.filter((item) => item.kind === "worktree"), ...plan.filter((item) => item.kind === "project")];
      for (const item of ordered) {
        if (!item.managed) { leftovers.push({ path: item.cwd, reason: "Not created by Floq; left untouched." }); continue; }
        try {
          const outcome = removeManagedCheckout(handle.mountPath, item.cwd, item.kind);
          if (outcome !== "missing") removedCheckouts += 1;
        } catch (error) {
          log.error("project.delete_files_failed", { userId, projectId, workspaceId: item.workspaceId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
          leftovers.push({ path: item.cwd, reason: error instanceof Error ? error.message.slice(0, 200) : "Could not remove this directory." });
        }
      }
      log.info("project.deleted", { userId, projectId, sessions: sessionIds.length, checkouts: removedCheckouts, leftovers: leftovers.length });
      return { deleted: true as const, sessionsDeleted: sessionIds.length, removedCheckouts, leftovers };
    }));
  }

  async projectBranches(userId: string, projectId: string, workspaceId: string): Promise<{ currentBranch: string | null; branches: string[] }> {
    return this.withShardActivity(userId, async () => {
      const { cwd } = await this.getRegisteredWorkspace(userId, projectId, workspaceId);
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      this.assertSafeRegisteredCheckout(handle, cwd);
      return listProjectBranches((args) => this.runWorkspaceGit(handle, cwd, args));
    });
  }

  /** Read-only: throws what `switchProjectBranch` would refuse with, changing nothing (no checkout, no DB write). */
  async checkProjectBranchSwitch(userId: string, projectId: string, workspaceId: string, branch: unknown): Promise<{ ok: true; needsSwitch: boolean }> {
    return this.withShardActivity(userId, async () => {
      const workspace = await this.getRegisteredWorkspace(userId, projectId, workspaceId);
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      this.assertSafeRegisteredCheckout(handle, workspace.cwd);
      const checked = await checkProjectBranchSwitch((args) => this.runWorkspaceGit(handle, workspace.cwd, args), branch);
      return { ok: true as const, needsSwitch: checked.needsSwitch };
    });
  }

  async switchProjectBranch(userId: string, projectId: string, workspaceId: string, branch: unknown): Promise<RuntimeProject> {
    return this.withShardActivity(userId, () => this.withProjectBranchLock(projectId, async () => {
      const workspace = await this.getRegisteredWorkspace(userId, projectId, workspaceId);
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      this.assertSafeRegisteredCheckout(handle, workspace.cwd);
      const run = (args: string[]) => this.runWorkspaceGit(handle, workspace.cwd, args);
      const current = await listProjectBranches(run);
      if (typeof branch !== "string" || !current.branches.includes(branch)) {
        throw badRequest("Choose a branch available in this project.", "invalid_branch");
      }
      if (current.currentBranch !== branch) {
        // Live agents are deliberately NOT a blocker: their terminals keep running (files change under them, like any
        // checkout). Local changes travel with the switch; git itself refuses (atomically) when they would be overwritten.
        await switchProjectBranch(run, branch);
      }
      const branchName = workspace.cwd === workspace.projectCwd ? "Main" : "Worktree";
      const result = await this.pool.query(
        `UPDATE floq_project_workspaces SET branch=$1::text,name=CASE WHEN $1::text IS NULL THEN 'Detached HEAD' ELSE $2::text END
         WHERE id=$3 AND project_id=$4 AND user_id=$5 RETURNING id`,
        [branch, branchName, workspaceId, projectId, userId],
      );
      if (!result.rows[0]) throw notFound("Project workspace not found");
      return (await this.project(userId, projectId))!;
    }));
  }

  /** Read-only: what deleting a Floq-created worktree would lose, plus the sessions tied to it. */
  async worktreeDeleteStatus(userId: string, projectId: string, workspaceId: string): Promise<WorktreeStatus & { sessions: { live: Array<{ id: string; title: string }>; idle: number } }> {
    return this.withShardActivity(userId, async () => {
      const target = await this.worktreeDeleteTarget(userId, projectId, workspaceId);
      const sessions = await this.worktreeSessions(userId, workspaceId);
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      this.assertSafeRegisteredCheckout(handle, target.projectCwd);
      const inspection = await inspectWorktree({ home: handle.mountPath, projectCwd: target.projectCwd, cwd: target.cwd, run: (cwd, args) => this.runWorkspaceGit(handle, cwd, args) });
      const { id: _id, removeArg: _removeArg, linked: _linked, protectedBranches: _protected, ...status } = inspection;
      return { ...status, sessions };
    });
  }

  /**
   * Delete a Floq-created worktree (and its Floq-created local branch). Refuses while an agent in it is live, and
   * refuses uncommitted/unsaved work unless `force`. Sleeping/exited sessions keep their history; the workspace row is
   * marked unavailable (the same state a hand-removed worktree gets) and those sessions can no longer be resumed.
   */
  async deleteWorktree(userId: string, projectId: string, workspaceId: string, force: boolean): Promise<WorktreeDeleteResult & { idleSessions: number }> {
    return this.withShardActivity(userId, () => this.withProjectBranchLock(projectId, async () => {
      const target = await this.worktreeDeleteTarget(userId, projectId, workspaceId);
      this.assertNoLiveWorktreeSessions(await this.worktreeSessions(userId, workspaceId));
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      this.assertSafeRegisteredCheckout(handle, target.projectCwd);
      const context = { home: handle.mountPath, projectCwd: target.projectCwd, cwd: target.cwd, run: (cwd: string, args: string[]) => this.runWorkspaceGit(handle, cwd, args) };
      const inspection = await inspectWorktree(context);
      assertCanDelete(inspection, force);
      // A session may have started while Git was inspecting; check again right before removing anything.
      const sessions = await this.worktreeSessions(userId, workspaceId);
      this.assertNoLiveWorktreeSessions(sessions);
      const result = await deleteWorktree(context, inspection, force);
      await this.pool.query("UPDATE floq_project_workspaces SET available=FALSE WHERE id=$1 AND project_id=$2 AND user_id=$3", [workspaceId, projectId, userId]);
      log.info("worktree.deleted", { userId, projectId, workspaceId, force, branchDeleted: result.branchDeleted !== null });
      return { ...result, idleSessions: sessions.idle };
    }));
  }

  private async worktreeDeleteTarget(userId: string, projectId: string, workspaceId: string): Promise<{ cwd: string; projectCwd: string }> {
    const result = await this.pool.query(
      `SELECT w.cwd,w.is_worktree,p.cwd AS project_cwd FROM floq_project_workspaces w
       JOIN floq_projects p ON p.id=w.project_id AND p.user_id=w.user_id
       WHERE w.id=$1 AND w.project_id=$2 AND w.user_id=$3`,
      [workspaceId, projectId, userId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw notFound("Project workspace not found");
    if (row.is_worktree !== true) throw conflict("The primary checkout cannot be deleted.", "primary_workspace");
    try { return { cwd: safeRelative(String(row.cwd)), projectCwd: safeRelative(String(row.project_cwd)) }; }
    catch { throw badRequest("Project workspace path is invalid.", "invalid_project_workspace"); }
  }

  private async worktreeSessions(userId: string, workspaceId: string): Promise<{ live: Array<{ id: string; title: string }>; idle: number }> {
    const result = await this.pool.query("SELECT id,title,state FROM agent_sessions WHERE user_id=$1 AND workspace_id=$2", [userId, workspaceId]);
    const live: Array<{ id: string; title: string }> = [];
    let idle = 0;
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const id = String(row.id);
      if (row.state === "running" || row.state === "starting" || this.live.get(id)?.isAlive) live.push({ id, title: String(row.title) });
      else idle += 1;
    }
    return { live, idle };
  }

  private assertNoLiveWorktreeSessions(sessions: { live: Array<{ id: string; title: string }> }): void {
    if (!sessions.live.length) return;
    const names = sessions.live.slice(0, 5).map((session) => `"${session.title}"`).join(", ") + (sessions.live.length > 5 ? ` and ${sessions.live.length - 5} more` : "");
    throw conflict(`Sleep or delete the running ${sessions.live.length === 1 ? "agent" : "agents"} in this worktree first: ${names}.`, "worktree_agents_active");
  }

  private async getRegisteredWorkspace(userId: string, projectId: string, workspaceId: string): Promise<{ cwd: string; projectCwd: string }> {
    const result = await this.pool.query(
      `SELECT w.cwd,p.cwd AS project_cwd FROM floq_project_workspaces w
       JOIN floq_projects p ON p.id=w.project_id AND p.user_id=w.user_id
       WHERE w.id=$1 AND w.project_id=$2 AND w.user_id=$3 AND w.available IS DISTINCT FROM FALSE`,
      [workspaceId, projectId, userId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw notFound("Project workspace not found");
    let cwd: string;
    let projectCwd: string;
    try {
      cwd = safeRelative(String(row.cwd));
      projectCwd = safeRelative(String(row.project_cwd));
    } catch {
      throw badRequest("Project workspace path is invalid.", "invalid_project_workspace");
    }
    return { cwd, projectCwd };
  }

  private assertSafeRegisteredCheckout(handle: ShardHandle, cwd: string): void {
    if (!safeWorkspaceBranch(handle.mountPath, cwd).ok) throw badRequest("This workspace is not a valid Git checkout inside your project home.", "invalid_project_workspace");
  }

  private async runWorkspaceGit(handle: ShardHandle, cwd: string, args: string[]): Promise<GitCommandResult> {
    const nullPath = this.shards.driver.name === "local" && process.platform === "win32" ? "NUL" : "/dev/null";
    const child = this.shards.driver.spawn(handle, {
      file: "git",
      args: ["-c", `core.hooksPath=${nullPath}`, "-c", "core.fsmonitor=false", ...args],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: this.shards.driver.homePath(handle),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: nullPath,
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        TERM: "dumb",
      },
      cwd,
      cols: 80,
      rows: 24,
    });
    return await new Promise<GitCommandResult>((resolveCommand, rejectCommand) => {
      const output: string[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (result?: GitCommandResult, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        data.dispose();
        exit.dispose();
        if (error) rejectCommand(error);
        else resolveCommand(result!);
      };
      const data = child.onData((chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 256 * 1024) {
          child.kill("SIGKILL");
          finish(undefined, badRequest("Git returned too much branch information.", "git_output_too_large"));
          return;
        }
        output.push(chunk);
      });
      const exit = child.onExit(({ exitCode }) => finish({ stdout: output.join(""), exitCode }));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(undefined, conflict("Git took too long to switch or inspect this workspace.", "git_branch_timeout"));
      }, 30_000);
      timer.unref();
    });
  }

  private async withProjectBranchLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.projectBranchLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    this.projectBranchLocks.set(projectId, current);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (this.projectBranchLocks.get(projectId) === current) this.projectBranchLocks.delete(projectId);
    }
  }

  async list(userId: string): Promise<SessionSummary[]> {
    const result = await this.pool.query(
      "SELECT * FROM agent_sessions WHERE user_id = $1 ORDER BY (archived_at IS NOT NULL), last_active_at DESC LIMIT 500",
      [userId],
    );
    // ONE grouped query for the node badges (no N+1).
    const counts = new Map<string, number>();
    try {
      const grouped = await this.pool.query("SELECT l.session_id, count(DISTINCT s.name)::int AS n FROM keychain_links l JOIN keychain_secrets s ON s.keychain_id = l.keychain_id WHERE l.user_id = $1 GROUP BY l.session_id", [userId]);
      for (const g of grouped.rows) counts.set(g.session_id as string, g.n as number);
    } catch { /* badge only */ }
    return result.rows.map((row: Row) => {
      const live = this.live.get(row.id);
      if (!live) return { ...summaryFromRow(row), secretCount: counts.get(row.id) ?? 0 };
      const summary = { ...live.toSummary(), secretCount: counts.get(row.id) ?? 0 };
      // Turn status only for live agents (not shells); reads a bounded transcript tail.
      if (live.state === "running" && live.provider !== "shell") {
        const turn = this.readAgentTurn(live.id, userId);
        const status = agentStatus({ alive: live.isAlive, sessionState: live.state, turn, outputQuietMs: Date.now() - live.lastActivity, transcriptQuietMs: turn ? Date.now() - turn.mtimeMs : Infinity });
        if (status === "working" || status === "idle" || status === "waiting-for-input") summary.activity = status;
      }
      return summary;
    });
  }

  async renameSession(userId: string, id: string, titleValue: unknown): Promise<SessionSummary> {
    if (typeof titleValue !== "string") throw badRequest("Title must be text.", "invalid_session_title");
    const title = titleValue.trim().replace(/\s+/g, " ");
    if (!title) throw badRequest("Title cannot be empty.", "invalid_session_title");
    if ([...title].length > 120) throw badRequest("Title must be 120 characters or fewer.", "invalid_session_title");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(title)) throw badRequest("Title contains unsupported control characters.", "invalid_session_title");

    const result = await this.pool.query(
      "UPDATE agent_sessions SET title=$3,title_locked=TRUE WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId, title],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) throw notFound("Session " + id + " not found");
    // Invalidates any best-effort native-title read already in flight as well as future checks.
    this.nativeTitleSessions.delete(id);
    this.live.get(id)?.setTitle(title);
    return summaryFromRow(row);
  }

  async get(id: string, userId: string): Promise<SessionSummary> {
    const live = this.live.get(id);
    if (live && live.userId === userId) return live.toSummary();
    return summaryFromRow(await this.row(id, userId));
  }

  /** Save an explicitly selected terminal attachment outside the checkout and return its container path. */
  async uploadSessionAttachment(id: string, userId: string, name: unknown, encoded: unknown): Promise<{ path: string; size: number }> {
    this.getLive(id, userId);
    if (!validAttachmentName(name)) {
      throw badRequest("Choose a file with a valid name", "invalid_attachment_name");
    }
    if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw badRequest("File data is invalid or exceeds the 4 MiB limit", "invalid_attachment");
    }
    const contents = Buffer.from(encoded, "base64");
    if (!contents.length || contents.length > MAX_ATTACHMENT_BYTES || contents.toString("base64") !== encoded) {
      throw badRequest("File must be between 1 byte and 4 MiB", "invalid_attachment");
    }
    return this.withUserShardActivity(userId, async (handle) => {
      const { hostDirectory, relativeDirectory } = this.prepareAttachmentDirectory(handle);
      const destination = join(hostDirectory, name);
      writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
      lchownSync(destination, handle.uid, handle.uid);
      return { path: join(this.shards.driver.homePath(handle), relativeDirectory, name), size: contents.length };
    });
  }

  /** Create a fresh private `.floq/attachments/<uuid>` directory owned by the user, refusing symlinked parents. */
  private prepareAttachmentDirectory(handle: ShardHandle): { hostDirectory: string; relativeDirectory: string; directoryPath: string } {
    const directoryId = randomUUID();
    const relativeDirectory = `.floq/attachments/${directoryId}`;
    const hostDirectory = this.shards.driver.hostPath(handle, relativeDirectory);
    const home = resolve(handle.mountPath);
    let current = home;
    for (const part of [".floq", "attachments", directoryId]) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw badRequest("Attachment storage is unsafe", "unsafe_attachment_path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirOwnedSegment(handle.mountPath, current, handle.uid, 0o700);
      }
    }
    return { hostDirectory, relativeDirectory, directoryPath: current };
  }

  /** Stream a raw request body into the same attachment location without buffering it in memory. */
  async uploadSessionAttachmentStream(id: string, userId: string, name: unknown, source: Readable, options: { maxBytes: number; contentLength: number | null }): Promise<{ path: string; size: number }> {
    this.getLive(id, userId);
    if (!validAttachmentName(name)) throw badRequest("Choose a file with a valid name", "invalid_attachment_name");
    // Uploads land on the shared shards volume: bound how many one user can stream at once.
    const inFlight = uploadsInFlight.get(userId) ?? 0;
    if (inFlight >= MAX_UPLOADS_PER_USER) throw tooMany("Too many uploads in progress, wait for one to finish");
    uploadsInFlight.set(userId, inFlight + 1);
    const release = () => { const left = (uploadsInFlight.get(userId) ?? 1) - 1; if (left <= 0) uploadsInFlight.delete(userId); else uploadsInFlight.set(userId, left); };
    return this.withUserShardActivity(userId, async (handle) => {
      const { hostDirectory, relativeDirectory, directoryPath } = this.prepareAttachmentDirectory(handle);
      const destination = join(hostDirectory, name);
      const partial = join(hostDirectory, `.upload-${randomUUID()}.part`);
      try {
        const size = await streamToFile(source, partial, options.maxBytes, options.contentLength);
        lchownSync(partial, handle.uid, handle.uid);
        renameSync(partial, destination);
        return { path: join(this.shards.driver.homePath(handle), relativeDirectory, name), size };
      } catch (error) {
        rmSync(partial, { force: true });
        rmSync(directoryPath, { recursive: true, force: true });
        throw error;
      }
    }).finally(release);
  }

  /** Run a helper as the user's uid (setpriv) so what it creates in the mounted home is theirs. */
  private asUser(handle: ShardHandle, file: string, args: string[]): [string, string[]] {
    if (this.shards.driver.name !== "linux") return [file, args];
    return ["setpriv", ["--reuid=" + handle.uid, "--regid=" + handle.uid, "--clear-groups", file, ...args]];
  }

  private clone(url: string, destination: string, profile: RuntimeProfile, handle: ShardHandle): Promise<void> {
    if (!isAllowedGitUrl(url)) throw badRequest("Unsupported git URL", "invalid_git_url");
    return new Promise((done, fail) => {
      const rel = relative(handle.mountPath, destination);
      // Cloned inside the sandbox (netns egress rules apply; a hostile repo's config cannot run on the host).
      const child = this.shards.driver.spawnPipe(handle, {
        file: "git",
        args: [...GIT_HARDENING_ARGS, "clone", "--depth", "50", "--", url, this.shards.driver.homePath(handle) + "/" + rel],
        cwd: ".",
        env: { ...buildSessionEnv(this.config, "claude", profile, "clone"), HOME: "/tmp" },
      });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        if (stderr.length < 2000) stderr += chunk.toString();
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        fail(badRequest("git clone failed: " + error.message, "clone_failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) done();
        else fail(badRequest("git clone failed: " + (stderr.trim() || "exit " + code), "clone_failed"));
      });
    });
  }

  private ensureProjectParent(handle: ShardHandle): void {
    const root = realpathSync(handle.mountPath);
    let current = root;
    for (const part of [".floq", "projects"]) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw badRequest("Project storage path is unsafe", "unsafe_project_path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(current);
        lchownSync(current, handle.uid, handle.uid);
      }
      const actual = realpathSync(current);
      if (!insidePath(root, actual)) throw badRequest("Project storage path escaped the user's home", "unsafe_project_path");
      current = actual;
    }
  }

  /** Scaffold GitHub Spec Kit in the project. Best effort: a failure never blocks the terminal. */
  private specifyInit(dir: string, provider: ProviderId, profile: RuntimeProfile, handle: ShardHandle): Promise<void> {
    const key = resolve(dir);
    if (existsSync(join(dir, ".specify"))) return Promise.resolve();
    const pending = this.specKitTasks.get(key);
    if (pending) return pending;
    const task = this.runSpecifyInit(dir, provider, profile, handle).finally(() => this.specKitTasks.delete(key));
    this.specKitTasks.set(key, task);
    return task;
  }

  private runSpecifyInit(dir: string, provider: ProviderId, profile: RuntimeProfile, handle: ShardHandle): Promise<void> {
    mkdirOwned(handle.mountPath, dir, handle.uid);
    const agent = provider === "claude" ? ["--ai", "claude"] : ["--ai", "codex", "--ai-skills"];
    return new Promise((done) => {
      const [file, args] = this.asUser(handle, "specify", ["init", "--here", "--force", ...agent]);
      const child = spawn(file, args, {
        cwd: dir,
        stdio: "ignore",
        env: { ...buildSessionEnv(this.config, provider, profile, "specify"), HOME: "/tmp" },
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        log.warn("specify.failed", { error: error.message });
        done();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) log.warn("specify.failed", { code });
        done();
      });
    });
  }

  /** Start (or restart) the PTY for a session row inside the user's shard. */
  private async launch(row: Row, profile: RuntimeProfile, handle: ShardHandle, resume: boolean, prompt?: string, strictResume = false): Promise<Session> {
    const definition = getProviderDefinition(row.provider, this.config);
    // Claude's conversation id is the Floq session id; Codex's is discovered and stored.
    const providerId = row.provider === "claude" ? row.id : row.provider_session_id;
    const resumeArgs = resume ? definition.resumeArgs(profile, providerId, row.model) : null;
    const resuming = resumeArgs !== null;
    const args = resumeArgs ?? definition.buildArgs(profile, row.id, row.model);
    if (row.provider === "codex") {
      const trustArgs = codexTrustArgs(
        this.shards.driver.homePath(handle),
        this.shards.driver.name === "linux" ? handle.mountPath : null,
        [row.cwd, row.project_cwd],
      );
      args.unshift(...trustArgs);
    }
    // Provider-native subagents are always disabled (start and resume, any role, regardless of the recruit setting); Floq recruiting is the only path.
    if (row.provider === "codex") args.unshift(...nativeSubagentBlockArgs("codex"));
    if (row.provider === "claude") args.push(...nativeSubagentBlockArgs("claude", { version: detectVersion(definition.bin).version, warn: (message) => log.warn("subagent.native_block_degraded", { sessionId: row.id, message }) }));
    // Wired context rides in the provider's system-level instructions on EVERY start and resume, so it survives compaction and restarts.
    const wiredBlock0 = this.wired && row.provider !== "shell" ? await this.wired.blockFor(row.user_id, row.id) : "";
    // The fixed Floq subagent policy rides in the same system-level text (one flag: a second --append-system-prompt would not combine), first and always present for agents.
    const skillsBlock = row.provider === "shell" ? "" : buildRecruitSkillsBlock(storedRecruitSkills(row.recruit_skills), row.provider);
    const wiredBlock = row.provider === "shell" ? "" : composeSystemBlocks(this.subagents ? await this.subagents.blockFor(row.user_id, row.id) : "", skillsBlock, wiredBlock0);
    if (wiredBlock && row.provider === "claude") args.push("--append-system-prompt", wiredBlock);
    // Initial prompt: fresh starts only, as its own argv element after all flags (no shell involved).
    if (!resuming && prompt) args.push("--", prompt);
    const env = buildSessionEnv(this.config, row.provider, profile, row.id);
    // Secrets the user marked "env" are injected; the rest are only reachable through `floq-vault`.
    Object.assign(env, await this.vault.reveal(row.user_id, null, "env", row.id));
    Object.assign(env, forcedSessionEnv(row.provider)); // a vault entry must not undo the renderer pin
    // Keychain secrets are NOT injected into the environment or written to files any more: an agent pulls each one with
    // `floq secret get NAME`, which the runtime logs so the user sees which keys were used. Clear files left by older versions.
    try { this.syncSecretFiles(handle, row.id, {}); } catch (error) { log.warn("secret.sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); }
    // Per-user netns (FLOQ_NETNS): the runtime is reached through the namespace gateway, which pasta maps to the runtime's loopback.
    env.FLOQ_API_URL = "http://" + (handle.netns ? NETNS_GATEWAY : "127.0.0.1") + ":" + this.config.port;
    env.FLOQ_AGENT_TOKEN = this.vault.issueToken(row.user_id, row.id);
    env.FLOQ_AGENT_NAME = row.title;
    if (row.provider === "codex") {
      env.CODEX_HOME = this.shards.driver.homePath(handle) + "/" + codexHomeRel(row.id);
      const codexHome = this.shards.driver.hostPath(handle, codexHomeRel(row.id));
      mkdirOwned(handle.mountPath, codexHome, handle.uid);
      this.shards.seed(codexHome, ".codex", handle.uid, await loadRemovedSkills(this.pool, row.user_id).catch(() => null));
      this.syncGlobalCodexMcp(handle, codexHome);
      try {
        syncProtectedFloqSkill(codexHome, join(this.config.skelDir, ".codex/skills/floq-orchestrate"), handle.uid);
      } catch (error) {
        log.warn("codex.protected_skill_sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      try {
        syncCodexManagedGuidance(codexHome, handle.uid, wiredBlock);
      } catch (error) {
        log.warn("codex.managed_guidance_sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      const cred = await this.freshCredential(row.user_id, "codex");
      if (cred) this.writeCredFile(handle, this.codexAuthPath(handle, row.id), JSON.stringify(cred));
    }
    if (row.provider === "claude") {
      const claudeHome = this.shards.driver.hostPath(handle, ".claude");
      mkdirOwned(handle.mountPath, claudeHome, handle.uid);
      // Anything root left behind in ~/.claude (or ~/.claude.json) makes Claude Code's transcript/todo/snapshot
      // writes fail with EACCES. Repair a shallow slice (config dir, projects/<slug>, ...) on every start.
      try {
        ownTree(claudeHome, handle.uid, 2);
        for (const name of [".claude.json", ".claude.json.backup"]) ownTree(this.shards.driver.hostPath(handle, name), handle.uid, 0);
      } catch (error) {
        log.warn("claude.ownership_repair_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      try {
        syncProtectedFloqSkill(claudeHome, join(this.config.skelDir, ".claude/skills/floq-orchestrate"), handle.uid);
      } catch (error) {
        log.warn("claude.protected_skill_sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      const cred = await this.freshCredential(row.user_id, "claude");
      if (cred) this.writeClaude(handle, cred);
      this.enforceClaudeSettings(handle, profile);
      // The user's enabled plugins become managed plugins in their own sandbox, so protected hooks (session.compact) reach them.
      const managedDir = this.shards.driver.claudeManagedDir?.(handle) ?? null;
      if (managedDir) {
        try {
          const base = JSON.parse(readFileSync(IMAGE_MANAGED_SETTINGS, "utf8")) as Record<string, unknown>;
          const promoted = promoteUserPlugins({ home: this.shards.driver.hostPath(handle, "."), managedDir, base });
          if (promoted.length) log.info("claude.user_plugins_managed", { sessionId: row.id, plugins: promoted.map((p) => p.id) });
        } catch (error) {
          // Without the image's base file there is nothing to extend: the sandbox falls back to the image's settings.
          rmSync(join(managedDir, MANAGED_FILE), { force: true });
          log.warn("claude.user_plugins_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        }
      }
      if (profile.claudeAutoApprove) {
        const path = this.shards.driver.hostPath(handle, ".claude.json");
        const config = readClaudeProjectConfig(path);
        const directories = managedTrustDirectories(
          this.shards.driver.homePath(handle),
          this.shards.driver.name === "linux" ? handle.mountPath : null,
          [row.cwd, row.project_cwd],
        );
        const temporary = path + "." + randomUUID() + ".tmp";
        try {
          writeFileSync(temporary, JSON.stringify(claudeProjectTrust(config, directories), null, 2), { mode: 0o600, flag: "wx" });
          lchownSync(temporary, handle.uid, handle.uid);
          renameSync(temporary, path);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
    }
    this.assertLifecycleOpen();
    // Virtual display for GUI apps (`floq display start`): set last so neither a vault secret nor a keychain can repoint it.
    const displayLease = this.displays.acquire(row.id);
    // No inherited X display either (host env, vault secret): GUI apps get one only via `floq display env`.
    delete env.DISPLAY;
    delete env.XAUTHORITY;
    delete env.WAYLAND_DISPLAY;
    if (displayLease) Object.assign(env, displayEnv(displayLease));
    else log.warn("display.slots_exhausted", { sessionId: row.id });
    let pty: ReturnType<typeof this.shards.driver.spawn>;
    try {
      pty = this.shards.driver.spawn(handle, {
        file: definition.bin,
        args,
        env,
        cwd: row.cwd,
        cols: row.cols,
        rows: row.rows,
      });
    } catch (error) {
      if (displayLease) this.displays.release(row.id, displayLease.token);
      throw error;
    }

    const resumeCount = row.resume_count + (resuming ? 1 : 0);
    const session = new Session({
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      title: row.title,
      cwd: row.cwd,
      projectCwd: row.project_cwd,
      projectId: row.project_id,
      worktreeId: row.workspace_id,
      branch: row.branch,
      gitUrl: row.git_url,
      cols: row.cols,
      rows: row.rows,
      outputBufferBytes: this.config.outputBufferBytes,
      pty,
      createdAt: row.created_at.getTime(),
      resumeCount,
      model: row.model ?? null,
      role: row.role ?? null,
      parentSessionId: row.parent_session_id ?? null,
    });
    this.live.set(row.id, session);
    // Free the display slot only once the sandbox has really exited (its pid namespace, and with it xpra/Xvfb, is gone),
    // on every path: exit, sleep, remove, project delete, shutdown. whenExited() resolves even after dispose() dropped
    // the frame listeners. The token guard ignores this when a relaunch of the same session already holds a new lease.
    if (displayLease) void session.whenExited().then(() => this.displays.release(row.id, displayLease.token));
    if (row.provider === "claude" || row.provider === "codex") {
      this.nativeTitleSessions.set(row.id, {
        userId: row.user_id,
        provider: row.provider,
        fallback: row.title,
        providerSessionId: row.provider === "claude" ? row.id : providerId,
        handle,
        checkedAt: 0,
        lastNativeTitle: null,
        checking: false,
      });
    }
    this.cancelLock(row.user_id);

    const launchedAt = Date.now();
    session.subscribe((frame) => {
      if (frame.type === "output") {
        void this.updateNativeTitle(row.id);
        return;
      }
      if (frame.type === "exit") void this.onExit(session, frame.session.state, !strictResume && resuming && Date.now() - launchedAt < RESUME_FALLBACK_MS, profile, handle);
    });

    await this.pool.query(
      "UPDATE agent_sessions SET state = 'running', resume_count = $2, sleep_reason = NULL, slept_at = NULL, last_active_at = now(), resume_on_boot = FALSE, interrupted_turn = FALSE, archived_at = NULL WHERE id = $1",
      [row.id, resumeCount],
    );
    void this.readyFlow(session);
    void this.updateNativeTitle(row.id);
    if (row.provider === "claude" || row.provider === "codex") this.pollNativeTitleSoon(row.id);
    if (row.provider === "codex" && !providerId) this.pollCodexId(row.id, handle);
    return session;
  }

  /** Read the uuid Codex assigned (from its rollout filename) so resume targets exactly this conversation. */
  private async captureCodexId(id: string, handle: ShardHandle): Promise<boolean> {
    const found = findRollout(this.shards.driver.hostPath(handle, codexHomeRel(id) + "/sessions"));
    if (!found) return false;
    await this.pool.query("UPDATE agent_sessions SET provider_session_id = $2 WHERE id = $1", [id, found]);
    const titleState = this.nativeTitleSessions.get(id);
    if (titleState) titleState.providerSessionId = found;
    void this.updateNativeTitle(id, true);
    return true;
  }

  /** A fresh session gets its native title shortly after the first reply: poll quickly for a minute, then reap() takes over. */
  private pollNativeTitleSoon(id: string): void {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!this.nativeTitleSessions.has(id) || Date.now() - startedAt > 60_000) return clearInterval(timer);
      void this.updateNativeTitle(id, true);
    }, 3_000);
    timer.unref();
  }

  /** Host-side path of the user's home. driver.homePath() is the sandbox view (/home/agent) and does not exist on the host. */
  private hostHome(handle: ShardHandle): string {
    return this.shards.driver.hostPath(handle, ".");
  }

  private async updateNativeTitle(id: string, force = false): Promise<void> {
    const now = Date.now();
    const state = this.nativeTitleSessions.get(id);
    if (!state || state.checking || (!force && now - state.checkedAt < 5_000)) return;
    state.checkedAt = now;
    state.checking = true;
    try {
      const title = state.provider === "claude"
        ? readClaudeNativeTitle(this.hostHome(state.handle), id)
        : state.providerSessionId
          ? readCodexNativeTitle(this.hostHome(state.handle), this.shards.driver.hostPath(state.handle, codexHomeRel(id)), state.providerSessionId)
          : null;
      const previousTitle = state.lastNativeTitle ?? state.fallback;
      if (!title || title === previousTitle) return;
      const updated = await this.pool.query(
        // No `title = previous` guard: a stale in-memory fallback (restart, role/preset flows) used to make the
        // update match nothing and silently end title sync. Only a manual rename (title_locked) is protected.
        "UPDATE agent_sessions SET title=$2 WHERE id=$1 AND user_id=$3 AND title_locked=FALSE RETURNING id",
        [id, title, state.userId],
      );
      // A manual rename may have completed while this native metadata write was waiting on the DB.
      if (this.nativeTitleSessions.get(id) !== state) return;
      if (updated.rows[0]) {
        state.lastNativeTitle = title;
        this.live.get(id)?.setTitle(title);
      } else if (updated.rows.length === 0) {
        // Another edit changed the title; preserve it instead of overwriting it.
        this.nativeTitleSessions.delete(id);
      }
    } catch {
      // Native metadata is best-effort; CLI startup and session recovery do not depend on it.
    } finally {
      state.checking = false;
    }
  }

  private pollCodexId(id: string, handle: ShardHandle): void {
    this.stopCodexPoll(id);
    const timer = setInterval(() => {
      if (!this.live.has(id)) return this.stopCodexPoll(id);
      void this.captureCodexId(id, handle)
        .then((done) => done && this.stopCodexPoll(id))
        .catch(() => undefined);
    }, CODEX_ID_POLL_MS);
    timer.unref();
    this.codexPollers.set(id, timer);
  }

  private stopCodexPoll(id: string): void {
    const timer = this.codexPollers.get(id);
    if (timer) clearInterval(timer);
    this.codexPollers.delete(id);
  }

  private async onExit(
    session: Session,
    state: SessionState,
    resumeFailedFast: boolean,
    profile: RuntimeProfile,
    handle: ShardHandle,
  ): Promise<void> {
    const current = this.live.get(session.id);
    // A delayed exit from an older PTY must not revoke a resumed replacement's token or title state.
    if (current && current !== session) return;
    if (!current && !this.intentionalSleep.has(session.id)) return;
    this.stopCodexPoll(session.id);
    this.vault.revokeSession(session.id);
    if (this.intentionalSleep.delete(session.id)) {
      this.nativeTitleSessions.delete(session.id);
      if (this.stoppingSessions.get(session.id) === session) this.stoppingSessions.delete(session.id);
      return;
    }
    if (session.provider === "codex") await this.captureCodexId(session.id, handle).catch(() => false);
    await this.updateNativeTitle(session.id, true);
    this.nativeTitleSessions.delete(session.id);

    if (resumeFailedFast && state === "failed") {
      // Nothing to continue (e.g. the conversation was never saved): start a fresh agent instead.
      log.info("session.resume_fallback", { sessionId: session.id });
      this.live.delete(session.id);
      try {
        const row = await this.row(session.id, session.userId);
        const fresh = await this.launch({ ...row, resume_count: session.resumeCount - 1 }, profile, handle, false);
        fresh.broadcast({ type: "state", session: fresh.toSummary() });
      } catch (error) {
        log.error("session.fallback_failed", { sessionId: session.id, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    await this.pool.query(
      "UPDATE agent_sessions SET state = $2, last_seq = $3, last_active_at = now(), slept_at = now() WHERE id = $1",
      [session.id, state, session.toSummary().seq],
    );
    this.scheduleLock(session.userId);
  }

  async create(userId: string, profile: RuntimeProfile, input: CreateSessionInput, options: CreateSessionOptions = {}): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    if (!PROVIDER_IDS.includes(input.provider)) {
      throw badRequest("provider must be one of: " + PROVIDER_IDS.join(", "), "invalid_provider");
    }
    if (input.provider === "shell" && (input.prompt !== undefined || input.specKit)) {
      throw badRequest("prompt and specKit are not supported for shell sessions");
    }
    let homeShell = false;
    try { homeShell = wantsHomeShell(input); } catch (error) { throw badRequest(error instanceof Error ? error.message : "invalid home", "invalid_home"); }
    const codexModels = input.provider === "codex" && typeof input.model === "string" && input.model
      ? await this.codexModels(userId)
      : undefined;
    const requestedRole = parseRoleId(input.role);
    // model "auto" = let the role's capability hint choose from the configured list (CLI default when nothing fits).
    const requestedModel = input.model === "auto"
      ? (requestedRole ? pickModelForCapability(requestedRole.capability, codexModels ?? (input.provider === "shell" ? [] : this.config.models[input.provider])) : null)
      : input.model;
    const model = resolveModel(this.config, input.provider, requestedModel, codexModels);
    if (model === "invalid") {
      const available = input.provider === "shell" ? "" : (codexModels ?? this.config.models[input.provider]).map((entry) => entry.id).join(", ");
      throw badRequest("model is not available for this provider; configured model ids: default" + (available ? ", " + available : ""), "invalid_model");
    }
    let prompt: string | undefined;
    if (input.prompt !== undefined) {
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 20000 || input.prompt.includes("\u0000")) {
        throw badRequest("prompt must be a non-empty string of at most 20000 characters", "invalid_prompt");
      }
      prompt = input.prompt.trim();
    }
    const role = requestedRole;
    if (role && input.provider === "shell") throw badRequest("role is not supported for shell sessions", "invalid_role");
    // The role prompt rides in the first message (fresh start only); the provider conversation keeps it on resume.
    prompt = composeRolePrompt(role, prompt);
    const releaseCapacity = this.capacityReservations.reserve(userId, this.activeCountFor(userId), this.config.maxSessions);
    if (!releaseCapacity) throw tooMany("Session limit reached (" + this.config.maxSessions + ")");
    try {
    const id = randomUUID();
    let cwd: string;
    let projectId: string | null = null;
    let workspaceId: string | null = null;
    let projectCwd = options.projectCwd ?? null;
    let projectGitUrl = input.gitUrl ?? options.projectGitUrl ?? null;
    let branch: string | null = null;
    if (input.projectId || input.workspaceId) {
      const projectResult = await this.pool.query("SELECT * FROM floq_projects WHERE id=$1 AND user_id=$2", [input.projectId, userId]);
      const project = projectResult.rows[0] as Record<string, unknown> | undefined;
      if (!project) throw notFound("Project not found");
      const selected = input.workspaceId
        ? await this.pool.query("SELECT * FROM floq_project_workspaces WHERE id=$1 AND project_id=$2 AND user_id=$3 AND available IS DISTINCT FROM FALSE", [input.workspaceId, input.projectId, userId])
        : await this.pool.query("SELECT * FROM floq_project_workspaces WHERE project_id=$1 AND user_id=$2 AND available IS DISTINCT FROM FALSE ORDER BY (cwd=$3) DESC,created_at LIMIT 1", [input.projectId, userId, project.cwd]);
      const workspace = selected.rows[0] as Record<string, unknown> | undefined;
      if (!workspace) throw notFound("Project workspace not found");
      cwd = safeRelative(String(workspace.cwd));
      projectId = String(project.id);
      workspaceId = String(workspace.id);
      projectCwd = String(project.cwd);
      projectGitUrl = project.git_url ? String(project.git_url) : null;
      branch = workspace.branch ? String(workspace.branch) : null;
    } else if (input.gitUrl) {
      const project = await this.createProject(userId, profile, input.gitUrl);
      const workspace = project.workspaces[0];
      if (!workspace) throw new Error("Imported project has no workspace");
      cwd = workspace.cwd;
      projectId = project.id;
      workspaceId = workspace.id;
      projectCwd = project.cwd;
      projectGitUrl = project.gitUrl;
      branch = workspace.branch;
    } else if (homeShell) {
      cwd = HOME_CWD;
    } else {
    try {
      cwd = safeRelative(input.cwd?.trim() || "workspace/" + id.slice(0, 8));
    } catch {
      throw badRequest("cwd must stay inside your home directory", "invalid_cwd");
    }
    }
    const handle = await this.shards.wake(userId);
    this.assertLifecycleOpen();

    if ((options.isolated || input.isolated) && !projectId) throw badRequest("isolated requires a registered project", "invalid_worktree_project");
    if (options.isolated || input.isolated) {
      const worktreeRel = ".floq/worktrees/" + id;
      const target = this.shards.driver.hostPath(handle, worktreeRel);
      const source = this.shards.driver.hostPath(handle, cwd);
      const worktree = await createWorktree({
        home: handle.mountPath,
        source,
        target,
        branch: "floq/" + id,
        uid: this.shards.driver.name === "linux" ? handle.uid : undefined,
        runAsUser: async (args) => {
          const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
          // Same bwrap sandbox and netns as the agent: filter drivers from the agent's .git config cannot run on the host.
          const child = this.shards.driver.spawnPipe(handle, {
            file: "git",
            args,
            cwd: ".",
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.platform === "win32" ? process.env.TEMP ?? "C:\\Temp" : "/tmp",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: nullDevice,
              ...GIT_HARDENING_ENV,
            },
          });
          return await new Promise<string>((resolveRun, rejectRun) => {
            let stderr = "";
            let stdout = "";
            child.stdout!.on("data", (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk.toString(); });
            child.stderr!.on("data", (chunk) => { if (stderr.length < 2000) stderr += chunk.toString(); });
            const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
            child.on("error", (error) => { clearTimeout(timer); rejectRun(error); });
            child.on("close", (code) => {
              clearTimeout(timer);
              if (code === 0) resolveRun(stdout.trim());
              else rejectRun(new Error(stderr.trim() || "git exited " + code));
            });
          });
        },
      });
      cwd = worktree.cwd;
      branch = "floq/" + id;
      if (projectId) {
        workspaceId = randomUUID();
        await this.pool.query(
          `INSERT INTO floq_project_workspaces(id,user_id,project_id,cwd,name,branch,is_worktree)
           VALUES($1,$2,$3,$4,$5,$6,TRUE)`, [workspaceId,userId,projectId,cwd,"Worktree",branch],
        );
      }
      this.assertLifecycleOpen();
    }

    if (input.gitUrl && !projectId) {
      if (existsSync(this.shards.driver.hostPath(handle, cwd))) {
        throw conflict("cwd already exists; cannot clone into it", "cwd_exists");
      }
      const target = this.shards.driver.hostPath(handle, cwd);
      mkdirOwned(handle.mountPath, dirname(target), handle.uid);
      await this.clone(input.gitUrl, target, profile, handle);
      this.assertLifecycleOpen();
    }

    if (input.specKit) {
      await this.specifyInit(this.shards.driver.hostPath(handle, cwd), input.provider, profile, handle);
      this.assertLifecycleOpen();
    }

    const definition = getProviderDefinition(input.provider as ProviderId, this.config);
    const cols = clamp(input.cols, this.config.defaultCols, 20, 500);
    const rows = clamp(input.rows, this.config.defaultRows, 5, 200);
    const title = input.title?.trim().slice(0, 120) || definition.label;

    const inserted = await this.pool.query(
      `INSERT INTO agent_sessions (id, user_id, provider, title, cwd, git_url, state, cols, rows, lead, model, project_cwd, project_id, workspace_id, branch, role, parent_session_id, recruit_skills)
       VALUES ($1,$2,$3,$4,$5,$6,'sleeping',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [id, userId, input.provider, title, cwd, projectGitUrl, cols, rows, input.lead === true, model, projectCwd ?? (projectId ? null : input.gitUrl ? cwd : null), projectId, workspaceId, branch, role?.id ?? null, options.parentSessionId ?? null, options.skills?.length ? options.skills : null],
    );
    try {
      const session = await this.launch(inserted.rows[0] as Row, profile, handle, false, prompt);
      log.info("session.create", { sessionId: id, userId, provider: input.provider, promptLength: prompt?.length ?? 0 });
      return session.toSummary();
    } catch (error) {
      await this.pool.query("DELETE FROM agent_sessions WHERE id = $1", [id]);
      throw badRequest(
        "Failed to start " + definition.label + ": " + (error instanceof Error ? error.message : String(error)),
        "spawn_failed",
      );
    }
    } finally {
      releaseCapacity();
    }
  }

  /** Wake the shard and continue the provider's last conversation in this session's directory. */
  async resume(userId: string, profile: RuntimeProfile, id: string, options: { strict?: boolean } = {}): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    const key = userId + ":" + id;
    const restart = this.restartTasks.get(key);
    if (restart) return restart;
    return coalesce(this.resumeTasks, key, () => this.resumeOnce(userId, profile, id, options.strict === true));
  }

  private async resumeOnce(userId: string, profile: RuntimeProfile, id: string, strictResume = false): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    const stopping = this.stoppingSessions.get(id);
    if (stopping && stopping.userId !== userId) throw notFound("Session " + id + " not found");
    if (stopping && !stopping.hasExited) throw unavailable("The previous process is still stopping; try resuming again after it exits.", "session_stopping");
    if (stopping) this.stoppingSessions.delete(id);
    const existing = this.live.get(id);
    if (existing && existing.userId === userId && existing.isAlive) return existing.toSummary();

    const row = await this.row(id, userId);
    if (row.workspace_id) {
      const gone = await this.pool.query("SELECT 1 FROM floq_project_workspaces WHERE id=$1 AND user_id=$2 AND is_worktree=TRUE AND available=FALSE", [row.workspace_id, userId]);
      if (gone.rows[0]) throw conflict("This agent's worktree was deleted or removed, so it cannot be resumed. You can still delete the conversation.", "worktree_deleted");
    }
    const releaseCapacity = this.capacityReservations.reserve(userId, this.activeCountFor(userId), this.config.maxSessions);
    if (!releaseCapacity) throw tooMany("Session limit reached (" + this.config.maxSessions + ")");
    try {
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      const session = await this.launch(row, profile, handle, true, undefined, strictResume);
      log.info("session.resume", { sessionId: id, userId, count: session.resumeCount });
      return session.toSummary();
    } finally {
      releaseCapacity();
    }
  }

  /** Validate that this live agent can be restarted without losing its provider conversation. */
  async assertSelfRestartable(userId: string, id: string): Promise<void> {
    const session = this.getLive(id, userId);
    if (!session.isAlive) throw conflict("This session is already stopping. Wait for it to finish before restarting.", "restart_not_ready");
    if (session.provider === "shell") throw notFound("Calling session not found");
    const row = await this.row(id, userId);
    if (row.provider !== session.provider) throw conflict("Session provider changed; try again", "restart_not_ready");
    if (session.provider === "codex" && !row.provider_session_id) {
      const titleState = this.nativeTitleSessions.get(id);
      const captured = titleState ? await this.captureCodexId(id, titleState.handle).catch(() => false) : false;
      if (!captured) throw conflict("Codex has not saved a resumable conversation yet. Wait a moment and try again.", "restart_not_ready");
    }
  }

  /** Restart only the caller's own session, preserving its row and provider conversation. */
  async restartSelf(userId: string, profile: RuntimeProfile, id: string): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    return coalesce(this.restartTasks, userId + ":" + id, async () => {
      await this.assertSelfRestartable(userId, id);
      try {
        await this.sleepSession(id, "self-restart", { waitForExit: true });
        return await this.resumeOnce(userId, profile, id, true);
      } catch (error) {
        await this.pool.query(
          "UPDATE agent_sessions SET state='failed', sleep_reason='self-restart-failed', last_active_at=now(), slept_at=now() WHERE id=$1 AND user_id=$2 AND state IN ('running','sleeping')",
          [id, userId],
        ).catch((updateError) => log.error("agent.self_restart_state_failed", { userId, sessionId: id, error: updateError instanceof Error ? updateError.message.slice(0, 160) : "unknown" }));
        throw error;
      } finally {
        this.intentionalSleep.delete(id);
      }
    });
  }

  isLogin(id: string): boolean {
    return this.logins.has(id);
  }

  private async freshCredential(userId: string, provider: OAuthProvider): Promise<CredentialData | null> {
    await this.credentials.refresh(userId, provider);
    return this.credentials.get(userId, provider);
  }

  private writeCredFile(handle: ShardHandle, path: string, content: string): void {
    mkdirOwned(handle.mountPath, dirname(path), handle.uid);
    writeFileOwned(path, content, handle.uid, 0o600);
    this.credMtime.set(path, statSync(path).mtimeMs);
  }

  private claudeCredPath(handle: ShardHandle): string {
    return this.shards.driver.hostPath(handle, ".claude/.credentials.json");
  }

  /**
   * Codex sessions use a private CODEX_HOME, so MCP servers the user installed globally (~/.codex/config.toml, via the
   * Skills page or `floq mcp add`) would not reach them. At every start or resume, append the global servers the session
   * config does not define yet. Only `mcp_servers` is copied. Never fatal: a failure just leaves the session as it was.
   */
  private syncGlobalCodexMcp(handle: ShardHandle, codexHome: string): void {
    try {
      const root = realpathSync(handle.mountPath);
      const globalRaw = SkillsService.readSafeConfig(this.shards.driver.hostPath(handle, ".codex/config.toml"), root);
      if (globalRaw === null) return;
      const target = join(codexHome, "config.toml");
      const exists = existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })();
      const sessionRaw = exists ? SkillsService.readSafeConfig(target, root) : null;
      if (exists && sessionRaw === null) return; // unreadable or unsafe: do not replace it
      const merged = mergeGlobalCodexMcp(globalRaw, sessionRaw);
      if (merged === null) return;
      const temporary = target + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(temporary, merged, { mode: 0o600, flag: "wx" });
        lchownSync(temporary, handle.uid, handle.uid);
        renameSync(temporary, target);
      } finally { rmSync(temporary, { force: true }); }
    } catch (error) {
      log.warn("codex.mcp_sync_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }

  private codexAuthPath(handle: ShardHandle, sessionId: string): string {
    return this.shards.driver.hostPath(handle, codexHomeRel(sessionId) + "/auth.json");
  }

  private writeClaude(handle: ShardHandle, data: CredentialData): void {
    const path = this.claudeCredPath(handle);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      /* first write */
    }
    this.writeCredFile(handle, path, JSON.stringify({ ...existing, claudeAiOauth: data }));
  }

  /** Replace Claude Code's own commit/PR attribution with Floq's, keeping the user's other settings. */
  private enforceClaudeSettings(handle: ShardHandle, profile: RuntimeProfile): void {
    const path = this.shards.driver.hostPath(handle, ".claude/settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      /* none yet */
    }
    settings.attribution = { commit: "", pr: profile.gitCoauthor ? FLOQ_PR_ATTRIBUTION : "" };
    settings.includeCoAuthoredBy = false;
    settings = claudeStartupSettings(settings, profile.claudeAutoApprove);
    mkdirOwned(handle.mountPath, dirname(path), handle.uid);
    writeFileOwned(path, JSON.stringify(settings, null, 2), handle.uid, 0o644);
  }

  /** Hand a fresh credential to the user's running CLIs. */
  async distribute(userId: string, provider: OAuthProvider, data: CredentialData): Promise<void> {
    if (!this.shards.isAwake(userId)) return;
    const handle = await this.shards.wake(userId);
    if (provider === "claude") return this.writeClaude(handle, data);
    for (const session of this.live.values()) {
      if (session.userId === userId && session.provider === "codex" && !this.logins.has(session.id)) {
        this.writeCredFile(handle, this.codexAuthPath(handle, session.id), JSON.stringify(data));
      }
    }
  }

  /** If a CLI refreshed its own copy, adopt that into the database so the server never uses a rotated-out refresh token. */
  private async syncBack(): Promise<void> {
    const seenClaude = new Set<string>();
    for (const s of [...this.live.values()]) {
      if (!s.isAlive || this.logins.has(s.id) || (s.provider !== "claude" && s.provider !== "codex")) continue;
      if (!this.shards.isAwake(s.userId)) continue;
      const handle = await this.shards.wake(s.userId);
      let path: string;
      if (s.provider === "claude") {
        if (seenClaude.has(s.userId)) continue;
        seenClaude.add(s.userId);
        path = this.claudeCredPath(handle);
      } else {
        path = this.codexAuthPath(handle, s.id);
      }
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (this.credMtime.get(path) === mtime) continue;
      this.credMtime.set(path, mtime);
      let data: unknown;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        data = s.provider === "claude" ? parsed.claudeAiOauth : parsed;
      } catch {
        continue;
      }
      if (validCredential(s.provider, data) && (await this.credentials.adopt(s.userId, s.provider, data))) {
        await this.distribute(s.userId, s.provider, data);
      }
    }
  }

  /**
   * Start a subscription login terminal (claude auth login / codex login --device-auth) in the user's
   * shard and sandbox, with a throwaway config dir. It is never stored in agent_sessions, so it is not
   * listed or resumed; it ends when the credential file appears (it is then imported into the database),
   * the process exits, or after 10 minutes. The temp dir and the session's replay buffer are destroyed.
   */
  async startLogin(userId: string, provider: ProviderId, profile: RuntimeProfile): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    if (provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex", "invalid_provider");
    const key = userId + ":" + provider;
    return coalesce(this.loginTasks, key, () => this.startLoginOnce(userId, provider, profile));
  }

  private async startLoginOnce(userId: string, provider: ProviderId, profile: RuntimeProfile): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    if (provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex", "invalid_provider");
    // A second concurrent start (e.g. the client firing twice) must not kill the first: the OAuth state/PKCE
    // verifier belongs to the running CLI, so return the live login instead of starting another.
    for (const state of this.logins.values()) {
      if (state.userId === userId && state.provider === provider && !state.finishing && state.session.isAlive) {
        return state.session.toSummary();
      }
    }
    const handle = await this.shards.wake(userId);
    this.assertLifecycleOpen();
    this.cancelLock(userId);
    const id = randomUUID();
    const definition = getProviderDefinition(provider, this.config);
    const env = buildSessionEnv(this.config, provider, profile, id);
    const rel = ".floq/login-" + provider + "-" + id;
    const dir = this.shards.driver.hostPath(handle, rel);
    mkdirOwned(handle.mountPath, dir, handle.uid);
    const home = this.shards.driver.homePath(handle);
    let args: string[];
    if (provider === "claude") {
      env.CLAUDE_CONFIG_DIR = home + "/" + rel;
      args = ["auth", "login"];
    } else {
      env.CODEX_HOME = home + "/" + rel;
      args = ["login", "--device-auth"];
    }
    // Where the CLI may leave its credential: the throwaway config dir (CLAUDE_CONFIG_DIR / CODEX_HOME), or,
    // if it ignores that, the user's real config dir. The latter only counts if written after this login began.
    const name = provider === "claude" ? ".credentials.json" : "auth.json";
    const candidates = [
      { path: join(dir, name), fresh: false },
      ...(provider === "claude" ? [{ path: join(dir, ".claude", name), fresh: false }] : []),
      { path: this.shards.driver.hostPath(handle, (provider === "claude" ? ".claude/" : ".codex/") + name), fresh: true },
    ];
    let pty;
    try {
      pty = this.shards.driver.spawn(handle, { file: definition.bin, args, env, cwd: "", cols: LOGIN_COLS, rows: 40 });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      this.scheduleLock(userId);
      throw badRequest("Failed to start login: " + (error instanceof Error ? error.message : String(error)), "spawn_failed");
    }
    const session = new Session({
      id,
      userId,
      provider,
      title: definition.label + " login",
      cwd: "",
      cols: LOGIN_COLS,
      rows: 40,
      outputBufferBytes: this.config.outputBufferBytes,
      pty,
    });
    session.fixedSize = true;
    this.live.set(id, session);
    const state: LoginState = { userId, provider, timers: [], dir, finishing: false, tail: "", startedAt: Date.now(), session };
    this.logins.set(id, state);
    state.timers.push(setTimeout(() => this.endLogin(id), LOGIN_TIMEOUT_MS));

    const readCred = (): CredentialData | null => {
      for (const candidate of candidates) {
        try {
          if (candidate.fresh && statSync(candidate.path).mtimeMs < state.startedAt) continue;
          const parsed = JSON.parse(readFileSync(candidate.path, "utf8")) as Record<string, unknown>;
          const data = provider === "claude" ? parsed.claudeAiOauth : parsed;
          if (validCredential(provider, data)) return data;
        } catch {
          /* not there yet */
        }
      }
      return null;
    };
    const scrub = (text: string) => text.replace(/[A-Za-z0-9_\-+/=.:%]{24,}/g, "[redacted]");
    const lastLines = () =>
      scrub(state.tail)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3);
    const finish = (data: CredentialData) => {
      if (state.finishing) return;
      state.finishing = true;
      void this.credentials
        .save(userId, provider, data)
        .then(() => provider === "codex" && this.invalidateCodexModels(userId))
        .then(() => this.distribute(userId, provider, data))
        .then(() => log.info("login.connected", { userId, provider }))
        .catch((error) => log.error("login.save_failed", { userId, provider, error: error instanceof Error ? error.message : String(error) }))
        .finally(() => this.endLogin(id));
    };
    state.poll = setInterval(() => {
      const data = state.finishing ? null : readCred();
      if (data) finish(data);
    }, 2000);
    session.subscribe((frame) => {
      if (frame.type === "output") {
        state.tail = stripAnsi(state.tail + frame.data).slice(-2000);
        return;
      }
      if (frame.type !== "exit") return;
      const data = state.finishing ? null : readCred();
      if (data) {
        finish(data);
        return;
      }
      if (!state.finishing) {
        let present: string[] = [];
        try {
          present = readdirSync(dir);
        } catch {
          /* dir gone */
        }
        log.warn("login.cred_missing", { userId, provider, exitCode: frame.session.exitCode, checked: candidates.map((c) => c.path), configDirEntries: present });
        log.warn("login.output_tail", { userId, provider, lines: lastLines() });
      }
      state.timers.push(setTimeout(() => this.endLogin(id), 5000));
    });
    log.info("login.start", { userId, provider });
    return session.toSummary();
  }

  private endLogin(id: string): void {
    const state = this.logins.get(id);
    if (!state) return;
    this.logins.delete(id);
    for (const timer of state.timers) clearTimeout(timer);
    if (state.poll) clearInterval(state.poll);
    rmSync(state.dir, { recursive: true, force: true });
    const session = this.live.get(id);
    this.live.delete(id);
    session?.dispose();
    this.scheduleLock(state.userId);
  }

  async disconnectProvider(userId: string, provider: ProviderId): Promise<void> {
    if (provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex", "invalid_provider");
    for (const [id, state] of this.logins) if (state.userId === userId && state.provider === provider) this.endLogin(id);
    await this.credentials.remove(userId, provider);
    if (provider === "codex") this.invalidateCodexModels(userId);
    const handle = await this.shards.wake(userId);
    if (provider === "claude") {
      rmSync(this.claudeCredPath(handle), { force: true });
    } else {
      rmSync(this.shards.driver.hostPath(handle, ".codex/auth.json"), { force: true });
      for (const session of this.live.values()) {
        if (session.userId === userId && session.provider === "codex") rmSync(this.codexAuthPath(handle, session.id), { force: true });
      }
    }
    this.scheduleLock(userId);
  }

  /** Save state to the DB and stop the PTY. The conversation stays in the user's encrypted home. */
  async sleepSession(id: string, reason: string, options: { waitForExit?: boolean; resumeOnBoot?: boolean; interruptedTurn?: boolean } = {}): Promise<void> {
    if (this.logins.has(id)) return this.endLogin(id);
    const session = this.live.get(id);
    if (!session) return;
    const summary = session.toSummary();
    this.stopCodexPoll(id);
    this.vault.revokeSession(id);
    if (session.provider === "codex") {
      const handle = await this.shards.wake(session.userId);
      await this.captureCodexId(id, handle).catch(() => false);
    }
    this.intentionalSleep.add(id);
    if (options.waitForExit) this.stoppingSessions.set(id, session);
    this.live.delete(id);
    this.nativeTitleSessions.delete(id);
    await this.pool.query(
      "UPDATE agent_sessions SET state = 'sleeping', sleep_reason = $2, last_seq = $3, last_active_at = now(), slept_at = now(), resume_on_boot = $4, interrupted_turn = $5 WHERE id = $1",
      [id, reason, summary.seq, options.resumeOnBoot === true, options.resumeOnBoot === true && options.interruptedTurn === true],
    );
    session.broadcast({ type: "state", session: { ...summary, state: "sleeping", sleepReason: reason, pid: null } });
    if (options.waitForExit) {
      if (!(await session.disposeAndWait())) {
        this.intentionalSleep.delete(id);
        void session.whenExited().then(() => {
          if (this.stoppingSessions.get(id) === session) {
            this.stoppingSessions.delete(id);
            if (!this.hasActiveProcess(session.userId)) this.scheduleLock(session.userId);
          }
        });
        throw unavailable("The old process did not stop; the session was left sleeping to protect its conversation.", "restart_stop_failed");
      }
      if (this.stoppingSessions.get(id) === session) this.stoppingSessions.delete(id);
    } else {
      session.dispose();
      this.intentionalSleep.delete(id);
    }
    log.info("session.sleep", { sessionId: id, userId: session.userId, reason });
    this.scheduleLock(session.userId);
  }

  async sleepUser(userId: string, reason: string): Promise<void> {
    const mine = [...this.live.values()].filter((s) => s.userId === userId);
    await Promise.all(mine.map((s) => (s.isAlive ? this.sleepSession(s.id, reason) : Promise.resolve())));
    if (this.hasActiveProcess(userId)) {
      log.warn("logout.shard_kept_awake_for_stopping_session", { userId });
      return;
    }
    this.cancelLock(userId);
    await this.shards.sleep(userId);
  }

  private secretDir(handle: ShardHandle, sessionId: string): string {
    return this.shards.driver.hostPath(handle, ".floq/secrets/" + sessionId);
  }

  /** Replace <home>/.floq/secrets/<sessionId>/ with exactly these secrets (dir 0700, files 0400, owned by the shard uid). */
  private syncSecretFiles(handle: ShardHandle, sessionId: string, secrets: Record<string, string>): void {
    const dir = this.secretDir(handle, sessionId);
    rmSync(dir, { recursive: true, force: true });
    if (!Object.keys(secrets).length) return;
    mkdirOwned(handle.mountPath, dir, handle.uid);
    chmodSync(dir, 0o700);
    for (const [name, value] of Object.entries(secrets)) this.writeSecretFile(handle, sessionId, name, value);
  }

  private writeSecretFile(handle: ShardHandle, sessionId: string, name: string, value: string | null): void {
    const dir = this.secretDir(handle, sessionId);
    const path = join(dir, name);
    rmSync(path, { force: true });
    if (value === null) return;
    mkdirOwned(handle.mountPath, dir, handle.uid);
    chmodSync(dir, 0o700);
    writeFileSync(path, value, { mode: 0o400, flag: "wx" });
    chmodSync(path, 0o400);
    lchownSync(path, handle.uid, handle.uid);
  }

  /**
   * Refresh <home>/.floq/secrets/<sessionId>/ of a running session from its linked keychains so floq secret get sees
   * changes. Returns true when the session is live: its process env cannot change, so env applies on the next start.
   * Never logs values.
   */
  async syncSessionSecrets(userId: string, sessionId: string): Promise<boolean> {
    // Pull model: agents read keychains on demand through the API, so a change applies immediately and nothing needs refreshing.
    void userId; void sessionId;
    return false;
  }

  /** Tell a running agent its wires changed (typed like `floq ask`). Returns false when it is not live. Never throws. */
  async notifyWired(userId: string, sessionId: string, added: WireRef[], removed: WireRef[], block: string, updated: WireRef[] = []): Promise<boolean> {
    const live = this.findLive(sessionId, userId);
    if (!live || !live.isAlive || live.provider === "shell") return false;
    const text = buildWiredNotice(added, removed, block, updated);
    if (!text) return false;
    try {
      await serialPerTarget(sessionId, () => typeMessage((d) => live.write(d), text, { bracketed: live.provider === "claude" || live.provider === "codex" }));
      return true;
    } catch { return false; }
  }

  /** Set or clear the role preset of an existing session (user-initiated only; the HTTP layer enforces who may call). */
  async setRole(userId: string, id: string, roleValue: unknown): Promise<SessionSummary> {
    const role = parseRoleIdForPatch(roleValue);
    const result = await this.pool.query("UPDATE agent_sessions SET role=$3 WHERE id=$1 AND user_id=$2 RETURNING *", [id, userId, role?.id ?? null]);
    const row = result.rows[0] as Row | undefined;
    if (!row) throw notFound("Session " + id + " not found");
    const live = this.live.get(id);
    if (live && live.userId === userId) {
      live.role = role?.id ?? null;
      return live.toSummary();
    }
    return summaryFromRow(row);
  }

  async remove(id: string, userId: string): Promise<void> {
    if (this.logins.get(id)?.userId === userId) return this.endLogin(id);
    const row = await this.row(id, userId);
    const awake = this.shards.awakeHandle(userId);
    if (awake) { try { rmSync(this.secretDir(awake, id), { recursive: true, force: true }); } catch { /* best effort */ } }
    const session = this.live.get(id);
    if (session) {
      this.intentionalSleep.add(id);
      this.live.delete(id);
      this.vault.revokeSession(id);
      session.dispose();
    }
    // An agent's conversation is never deleted by removing it: it is archived (hidden from the canvas, listed in
    // Conversations, restorable). Only terminals, which have no conversation, are deleted for good.
    const kept = row.provider !== "shell";
    if (kept) await this.pool.query("UPDATE agent_sessions SET archived_at = COALESCE(archived_at, now()), state = 'sleeping', slept_at = COALESCE(slept_at, now()), resume_on_boot = FALSE, interrupted_turn = FALSE WHERE id = $1 AND user_id = $2", [id, userId]);
    else await this.pool.query("DELETE FROM agent_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
    this.scheduleLock(userId);
  }

  private withShardActivity<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    this.assertLifecycleOpen();
    this.cancelLock(userId);
    this.shardActivityCounts.set(userId, (this.shardActivityCounts.get(userId) ?? 0) + 1);
    const task = Promise.resolve().then(operation);
    this.shardActivities.add(task);
    return task.finally(() => {
      this.shardActivities.delete(task);
      const remaining = (this.shardActivityCounts.get(userId) ?? 1) - 1;
      if (remaining <= 0) this.shardActivityCounts.delete(userId);
      else this.shardActivityCounts.set(userId, remaining);
      if (remaining <= 0 && !this.shuttingDown && !this.hasActiveProcess(userId)) {
        this.scheduleLock(userId);
      }
    });
  }

  /** Hold the encrypted home unlocked for a bounded management operation without creating a session. */
  withUserShardActivity<T>(userId: string, operation: (handle: ShardHandle) => Promise<T>): Promise<T> {
    return this.withShardActivity(userId, async () => operation(await this.shards.wake(userId)));
  }

  private scheduleLock(userId: string): void {
    this.cancelLock(userId);
    if (this.shuttingDown || (this.shardActivityCounts.get(userId) ?? 0) > 0) return;
    const timer = setTimeout(() => {
      this.lockTimers.delete(userId);
      if ((this.shardActivityCounts.get(userId) ?? 0) > 0) return;
      const busy = this.hasActiveProcess(userId);
      if (!busy) void this.shards.sleep(userId).catch((error) => log.error("shard.lock_failed", { userId, error: String(error) }));
    }, this.config.shardLockDelayMs);
    timer.unref();
    this.lockTimers.set(userId, timer);
  }

  private cancelLock(userId: string): void {
    const timer = this.lockTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.lockTimers.delete(userId);
  }

  private async reap(): Promise<void> {
    await this.syncBack().catch((error) => log.error("credentials.sync_failed", { error: error instanceof Error ? error.message : String(error) }));
    await Promise.all([...this.nativeTitleSessions.keys()].map((id) => this.updateNativeTitle(id)));
    const now = Date.now();
    for (const session of [...this.live.values()]) {
      if (!session.isAlive || this.logins.has(session.id)) continue;
      const idle = this.config.idleTimeoutMs > 0 && now - session.lastActivity > this.config.idleTimeoutMs;
      const old = this.config.maxLifetimeMs > 0 && now - session.startedAtMs > this.config.maxLifetimeMs;
      if (idle || old) {
        await this.sleepSession(session.id, idle ? "idle" : "lifetime").catch((error) =>
          log.error("session.sleep_failed", { sessionId: session.id, error: String(error) }),
        );
      }
    }
  }

  /** Register a callback fired once a created / resumed / restarted session's TUI is ready to receive typed input. */
  onSessionReady(cb: (userId: string, sessionId: string) => void): void {
    (this.readyListeners ??= []).push(cb);
  }

  /**
   * Ready = first output followed by a quiet period (the TUI finished painting), or the timeout, or the process exiting.
   * Never rejects.
   */
  private waitReady(session: Session): Promise<void> {
    const quietMs = this.readyTiming?.quietMs ?? READY_QUIET_MS;
    const timeoutMs = this.readyTiming?.timeoutMs ?? READY_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      let unsubscribe: (() => void) | undefined;
      const done = () => {
        clearTimeout(quiet);
        clearTimeout(limit);
        unsubscribe?.();
        resolve();
      };
      const limit = setTimeout(done, timeoutMs);
      unsubscribe = session.subscribe((frame) => {
        if (frame.type === "exit") return done();
        if (frame.type !== "output") return;
        clearTimeout(quiet);
        quiet = setTimeout(done, quietMs);
      });
    });
  }

  /** After a launch: wait for the TUI, type the boot-resume notice (if one is queued), then tell the ready listeners. */
  private async readyFlow(session: Session): Promise<void> {
    try {
      await this.waitReady(session);
      const notice = this.bootNotices?.get(session.id);
      if (notice !== undefined) {
        this.bootNotices?.delete(session.id);
        if (session.isAlive && session.provider !== "shell") {
          await serialPerTarget(session.id, () => typeMessage((d) => session.write(d), notice, { bracketed: session.provider === "claude" || session.provider === "codex", trusted: true }));
        }
      }
    } catch (error) {
      log.warn("session.ready_flow_failed", { sessionId: session.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
    if (!session.isAlive) return;
    for (const cb of [...(this.readyListeners ?? [])]) {
      try { cb(session.userId, session.id); } catch (error) { log.warn("session.ready_listener_failed", { sessionId: session.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }); }
    }
  }

  /**
   * After the runtime is listening: resume every session the previous runtime put to sleep at shutdown (resume_on_boot),
   * a few at a time. Sessions the user slept (or that exited) never carry the flag. Mid-turn agents also get a trusted notice.
   */
  async resumeAfterBoot(profileFor: (userId: string) => Promise<RuntimeProfile>, concurrency = BOOT_RESUME_CONCURRENCY): Promise<{ resumed: number; skipped: number }> {
    const result = { resumed: 0, skipped: 0 };
    const found = await this.pool.query(
      `SELECT s.id, s.user_id, s.provider, s.project_id, s.interrupted_turn, (s.project_id IS NOT NULL AND p.id IS NULL) AS project_gone
         FROM agent_sessions s LEFT JOIN floq_projects p ON p.id = s.project_id AND p.user_id = s.user_id
        WHERE s.resume_on_boot = TRUE AND s.state = 'sleeping'
        ORDER BY s.last_active_at DESC`,
    );
    const rows = found.rows as Array<{ id: string; user_id: string; provider: ProviderId; interrupted_turn: boolean; project_gone: boolean }>;
    // Flags on rows that are not sleeping any more (a user resumed them first, or they exited) are stale.
    await this.pool.query("UPDATE agent_sessions SET resume_on_boot = FALSE, interrupted_turn = FALSE WHERE resume_on_boot = TRUE AND state <> 'sleeping'").catch(() => undefined);
    const queue = [...rows];
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        if (this.shuttingDown) return;
        const skip = async (reason: string, error?: unknown) => {
          result.skipped++;
          log.warn("session.boot_resume_skipped", { sessionId: row!.id, userId: row!.user_id, reason, error: error instanceof Error ? error.message.slice(0, 160) : undefined });
          await this.pool.query("UPDATE agent_sessions SET resume_on_boot = FALSE, interrupted_turn = FALSE WHERE id = $1", [row!.id]).catch(() => undefined);
        };
        if (row.project_gone) { await skip("project_deleted"); continue; }
        if (this.live.has(row.id)) { await skip("already_running"); continue; }
        const notice = row.interrupted_turn && row.provider !== "shell";
        const bootNotices = (this.bootNotices ??= new Map());
        if (notice) bootNotices.set(row.id, BOOT_RESUME_NOTICE);
        try {
          const profile = await profileFor(row.user_id);
          await this.resume(row.user_id, profile, row.id);
          result.resumed++;
          log.info("session.boot_resumed", { sessionId: row.id, userId: row.user_id, interrupted: row.interrupted_turn });
        } catch (error) {
          bootNotices.delete(row.id);
          const code = (error as { code?: string } | null)?.code;
          await skip(code === "worktree_deleted" ? "worktree_deleted" : "resume_failed", error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));
    return result;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.lifecycle.close();
    clearInterval(this.reaper);
    for (const timer of this.lockTimers.values()) clearTimeout(timer);
    await Promise.allSettled([...this.shardActivities]);
    await Promise.allSettled([...this.restartTasks.values()]);
    // Fast first: flag every live session in one UPDATE, so even a shutdown cut short by SIGKILL leaves the flags
    // (reconcile() on the next boot additionally treats rows left 'running' as mid-turn). The per-session sleeps below refine it.
    const liveIds = [...this.live.values()].filter((s) => s.isAlive).map((s) => s.id);
    if (liveIds.length) await this.pool.query("UPDATE agent_sessions SET resume_on_boot = TRUE WHERE id = ANY($1::uuid[])", [liveIds]).catch((error) => log.error("runtime.shutdown_flag_failed", { error: String(error).slice(0, 160) }));
    for (const session of [...this.live.values()]) {
      if (!session.isAlive) continue;
      // Record that the runtime (not the user) stopped this session, and whether it was mid-turn, so the next boot resumes it.
      let interruptedTurn = false;
      try { interruptedTurn = this.readAgentTurn(session.id, session.userId)?.status === "working"; } catch { /* unreadable transcript: treat as idle */ }
      await this.sleepSession(session.id, "shutdown", { resumeOnBoot: true, interruptedTurn }).catch(() => undefined);
    }
    if (this.countActiveProcesses() > 0) {
      log.error("runtime.shutdown_shard_sleep_skipped", { reason: "session_process_still_stopping", count: this.countActiveProcesses() });
      return;
    }
    await this.shards.sleepAll();
  }

  private assertLifecycleOpen(): void {
    this.lifecycle.assertOpen(badRequest("Runtime is shutting down", "runtime_shutting_down"));
  }
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
