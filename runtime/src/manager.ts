import { randomUUID } from "node:crypto";
import { SkillsService, loadRemovedSkills } from "./skills.js";
import { mergeGlobalCodexMcp } from "./mcpConfig.js";
import { FLOQ_RULES_GUIDANCE, agyTokenValid, antigravityPrompt, antigravitySettings, opencodeConfigContent, opencodeHomeRel, parseAntigravityConversationId, parseOpencodeSessionId } from "./cliProviders.js";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type pg from "pg";
import type { Config, ModelEntry } from "./config.js";
import { HttpError, badRequest, conflict, notFound, tooMany, unavailable } from "./errors.js";
import { log } from "./logger.js";
import { stripAnsi } from "./orchestrator.js";
import { streamToFile, validAttachmentName } from "./attachments.js";
import type { Readable } from "node:stream";
import { buildWiredNotice, type WireRef, type WiredContext } from "./wiredContext.js";
import { parseRoleId as parseRoleIdForPatch } from "./roles.js";
import { specKitIntegrationArgs } from "./specKit.js";
import { assertProviderConnected, providerConnected, type ProviderGuardDeps } from "./providerGuard.js";
import { validCredential, type CredentialBroker, type CredentialData, type OAuthProvider } from "./credentials.js";
import { nativeSubagentBlockArgs } from "./nativeSubagentBlock.js";
import { DisplayAllocator, displayEnv } from "./display.js";
import { artifactsGuidance, artifactsRel, ensureArtifactsDir } from "./artifacts.js";
import { buildSessionEnv, detectVersion, forcedSessionEnv, withUserBin, mkcertEnv, getProviderDefinition, resolveModel } from "./providers.js";
import { CodexModelCatalog, fetchCodexModelList } from "./codexModels.js";
import { Session } from "./session.js";
import { CheckpointScheduler, checkpointTranscript, sweepCheckpoints, findCodexRolloutPath, readCheckpointText, restoreFromCheckpoint as restoreCheckpointFile } from "./checkpoints.js";
import { buildResumeSummary } from "./resumeSummary.js";
import { CapacityReservations, ClosingGate, coalesce } from "./lifecycleGate.js";
import { createWorktree } from "./worktree.js";
import { codexTrustArgs, managedTrustDirectories } from "./codexTrust.js";
import { claudeProjectTrust, claudeStartupSettings, readClaudeProjectConfig } from "./claudeSettings.js";
import { isAllowedProjectIconColor, isAllowedProjectIconName, isAllowedProjectImage } from "./projectImage.js";
import { checkProjectBranchSwitch, listProjectBranches, switchProjectBranch, type GitCommandResult } from "./projectBranches.js";
import { countPlainFiles, countPorcelain, planCheckouts, removeManagedCheckout, type CheckoutReport, type ProjectDeleteResult, type ProjectDeleteStatus } from "./projectDelete.js";
import { moveProjectsInFolders, pruneProjectFromFolders } from "./projectFolders.js";
import type { StorageSenseHost } from "./storageSense/service.js";
import { statfs } from "node:fs/promises";
import { assertCanDelete, deleteWorktree, inspectWorktree, type WorktreeDeleteResult, type WorktreeStatus } from "./worktreeDelete.js";
import { CLAUDE_CONVERSATION_SQL, canSwitchTo, endConversation, listConversations, planFreshStart, recordConversation, resolveClaudeConversationId, type ConversationRow } from "./agentConversations.js";
import { classifyResumeExit, resumeRetryDelay, bootRetryDelay, isTransientBootError, claudeProjectSlug, RESUME_FAILED_REASON, RESUME_FAILED_TITLE, BOOT_PAUSED_TITLE, type ResumeExitKind } from "./resumeRecovery.js";
import { claudeTranscriptPath, readClaudeNativeTitle, readCodexNativeTitle, readTranscriptHead, readTranscriptTail } from "./nativeTitle.js";
import { fallbackBadge, type FallbackState } from "./fallback.js";
import { agentStatus, analyzeTranscript, endsWithAssistantText, type TranscriptTurn } from "./turn.js";
import { composeRolePrompt, parseRoleId, pickModelForCapability } from "./roles.js";
import { buildRecruitSkillsBlock, storedRecruitSkills } from "./recruitSkills.js";
import { MANAGED_FILE, promoteUserPlugins } from "./claudeManagedPlugins.js";

/** The image's Claude Code managed settings (native-subagent deny): the base of every user's own copy. */
const IMAGE_MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";
import { syncCodexManagedGuidance, syncProtectedFloqSkill } from "./codexGuidance.js";
import { buildMemoryPolicy, composeSystemBlocks } from "./subagents.js";
import { NETNS_GATEWAY } from "./netns.js";
import { chmodHomeDir, lstatHome, mkdirOwned, mkdirOwnedSegment, openChildDir, openHomeDir, ownHomeTree, pruneHomeFiles, readHomeFile, removeHomeTree, safeRelative, UnsafeHomePathError, writeFileOwned, type HomeDir, type ShardHandle } from "./shard.js";
import { GIT_HARDENING_ARGS, GIT_HARDENING_ENV } from "./worktree.js";
import { HOME_CWD, wantsHomeShell } from "./homeShell.js";
import type { ShardService } from "./shards.js";
import type { Vault } from "./vault.js";
import type { RuntimeProfile } from "./settings.js";
import { PROVIDER_IDS, type CreateSessionInput, type ProviderId, type RuntimeProject, type ProjectWorkspace, type SessionState, type SessionSummary } from "./types.js";
import { serialPerTarget, typeMessage } from "./messageDelivery.js";
import { AgySwarmMirror } from "./agySwarmMirror.js";

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
/** Retention sweep of last-good checkpoints of deleted agents: hourly, first run a minute after boot. */
const CHECKPOINT_SWEEP_INTERVAL_MS = 3600_000;
const CHECKPOINT_SWEEP_FIRST_MS = 60_000;
/** If a resumed agent dies this fast with an error, there was nothing to resume: start fresh. */
const RESUME_FALLBACK_MS = 8_000;
const CODEX_ID_POLL_MS = 3_000;
const CODEX_MODEL_TIMEOUT_MS = 20_000;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Every Codex session gets a private CODEX_HOME, so the only rollout file in it belongs to that session. */
const codexHomeRel = (id: string) => ".floq/codex/" + id;
/** Every agent TUI (not the plain shell) takes bracketed paste. */
interface CliProbe {
  provider: "opencode" | "antigravity";
  userId: string;
  cwd: string;
  cwds: string[];
  baseline: string | null;
  env: Record<string, string>;
  inFlight: boolean;
  misses: number;
  nextAt: number;
}
const AGY_GATE_MS = 45_000;
/** agy output that means its Google login is missing, expired or revoked. */
const AGY_LOGIN_LOST = /Select login method|Authentication expired|log back in/i;
const bracketedProvider = (provider: ProviderId) => provider !== "shell";
/** OpenCode only creates its session on the first message, so its id probe (a CLI spawn) polls slower than codex's file scan. */
const CLI_ID_POLL_MS: Record<string, number> = { opencode: 10_000, antigravity: 3_000 };

/**
 * Walk a Codex sessions tree (agent-writable) with every directory pinned by descriptor and never entered through a symlink,
 * and hand the first rollout file to `fn` while the descriptors are still open (`path` addresses it through them). A planted
 * link at or above `sessions` makes root see nothing instead of another tenant's rollouts.
 */
function withRollout<T>(home: string, sessionsDir: string, fn: (path: string, sessionId: string) => T): T | null {
  const walk = (dir: HomeDir, depth: number): T | null => {
    let entries;
    try { entries = readdirSync(dir.path, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth >= 6) continue;
        let child: HomeDir | null = null;
        try { child = openChildDir(dir, entry.name); } catch { continue; }
        if (!child) continue;
        try {
          const found = walk(child, depth + 1);
          if (found !== null) return found;
        } finally { child.close(); }
      } else if (entry.isFile()) {
        const match = ROLLOUT.exec(entry.name);
        if (match) return fn(join(dir.path, entry.name), match[1]);
      }
    }
    return null;
  };
  let root: HomeDir | null;
  try { root = openHomeDir(home, sessionsDir); } catch { return null; }
  if (!root) return null;
  try { return walk(root, 0); } finally { root.close(); }
}

/** The uuid in the first rollout filename under a confined sessions dir. */
function findRollout(home: string, sessionsDir: string): string | null {
  return withRollout(home, sessionsDir, (_path, id) => id);
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
  /** Claude only: current conversation from agent_conversations (absent = the agent id, for agents that predate it). */
  claude_conversation_id?: string | null;
  title_locked: boolean;
  lead: boolean;
  model: string | null;
  role?: string | null;
  parent_session_id?: string | null;
  recruit_skills?: string[] | null;
  archived_at?: Date | null;
  fallback_state?: FallbackState | null;
  fallback_override?: { mode?: string } | null;
}

function overrideOf(row: Row): "model" | "pause" | null {
  const mode = row.fallback_override?.mode;
  return mode === "model" || mode === "pause" ? mode : null;
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
    fallback: fallbackBadge(row.fallback_state),
    fallbackOverride: overrideOf(row),
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

function branchFromCheckout(home: string, dir: string): string | null {
  try {
    const head = readHomeFile(home, join(dir, ".git", "HEAD"), null, 4096)?.text.trim() ?? "";
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match?.[1] ?? null;
  } catch { return null; }
}

function insidePath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/**
 * Branch of a checkout inside a user home, read without trusting anything the agent controls: every path is opened by descriptor
 * with no symlinked component (readHomeFile), a FIFO or device where a file should be is refused instead of blocking, and a
 * `gitdir:` pointer must stay inside the home.
 */
function safeWorkspaceBranch(home: string, cwd: string): { ok: boolean; branch: string | null } {
  try {
    const root = resolve(home);
    const checkout = join(root, safeRelative(cwd));
    const gitMeta = join(checkout, ".git");
    const meta = lstatHome(root, gitMeta);
    if (!meta || meta.isSymbolicLink()) return { ok: false, branch: null };
    let headPath: string;
    if (meta.isDirectory()) headPath = join(gitMeta, "HEAD");
    else {
      const marker = readHomeFile(root, gitMeta, null, 4096)?.text.trim() ?? "";
      const match = /^gitdir:\s*(.+)$/.exec(marker);
      if (!match) return { ok: false, branch: null };
      const gitDir = resolve(checkout, match[1]);
      if (!insidePath(root, gitDir)) return { ok: false, branch: null };
      headPath = join(gitDir, "HEAD");
    }
    const head = readHomeFile(root, headPath, null, 4096)?.text.trim() ?? "";
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
    const root = resolve(home);
    const current = join(root, expected);
    const held = openHomeDir(root, current);
    if (!held) return null;
    try {
      // Checked through the pinned descriptor: a plain (non-git) project folder has no .git entry at all.
      try { lstatSync(join(held.path, ".git")); return null; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
      return current;
    } finally { held.close(); }
  } catch { return null; }
}

/** Providers with a login terminal. Antigravity's token lives in agy's own file (it refreshes it itself), never in the credential broker. */
export type LoginProvider = OAuthProvider | "antigravity";
export const AGY_TOKEN_REL = ".gemini/antigravity-cli/antigravity-oauth-token";
const AGY_SCOPE_REL = ".config/antigravity/credential-user-scope";

interface LoginState {
  userId: string;
  provider: LoginProvider;
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
  /** Organization the request acts in: a requested project must live in it, and an imported repository is created in it. */
  orgId?: string;
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
  /** Notes and agents wired to each agent, persisted so every start and resume re-injects them (set at startup). */
  wired?: WiredContext;
  /** Set when agent memory is enabled (FLOQ_REDIS_URL): the [FLOQ MEMORY v1] policy is composed in only when it is configured. */
  memories?: { enabled(): boolean };
  /** Fixed always-recruit-subagents policy block, injected for every agent start and resume (set at startup). */
  subagents?: { blockFor(userId: string, sessionId: string): Promise<string>; assertCanWake?(userId: string, sessionId: string): Promise<() => void> };
  private readonly logins = new Map<string, LoginState>();
  /** mtime of credential files we wrote or last read, to detect a CLI refreshing on its own. */
  private readonly credMtime = new Map<string, number>();
  /** Last known "agy has a Google-login token file" per user, for status while the shard sleeps. */
  private readonly agyConnected = new Map<string, boolean>();
  /** Users whose agy hit the login picker / expiry notice: the token file is not trusted until they sign in again. */
  private readonly agyExpired = new Set<string>();
  private readonly live = new Map<string, Session>();
  /** Runtime-wide X display / Xpra port slots, one per live session (display.ts). */
  readonly displays = new DisplayAllocator();
  /** Mirrors Antigravity swarm workers / subagents as virtual agents (agySwarmMirror.ts); one watcher per live agy session. */
  readonly agyMirror = new AgySwarmMirror();
  private readonly stoppingSessions = new Map<string, Session>();
  private readonly intentionalSleep = new Set<string>();
  private readonly lockTimers = new Map<string, NodeJS.Timeout>();
  private readonly codexPollers = new Map<string, NodeJS.Timeout>();
  /** How to read back the conversation id OpenCode / Antigravity chose for a live session (see captureCliId). */
  private readonly cliProbes = new Map<string, CliProbe>();
  /** Fresh agy starts are serialised per (user, cwd) until each one's conversation id is captured: the id cache is one map per cwd. */
  private readonly agyGates = new Map<string, Promise<void>>();
  private readonly agyRelease = new Map<string, () => void>();
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
  /** "Last-good" transcript checkpoints (checkpoints.ts): debounced per session, flushed on sleep. */
  private readonly checkpointStamps = new Map<string, string>();
  private readonly checkpoints = new CheckpointScheduler((id) => this.runCheckpoint(id), { onError: (id, error) => log.warn("checkpoint.failed", { sessionId: id, error: error instanceof Error ? error.message : String(error) }) });
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
  private readonly bootRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly resumeRetries = new Map<string, number>();
  private readonly userNoticeListeners: Array<(userId: string, n: { sessionId: string; projectId: string | null; title: string; body: string }) => void> = [];
  private readyListeners?: Array<(userId: string, sessionId: string) => void>;
  private bootNotices?: Map<string, string>;
  /** Usage-limit fallback (set by index.ts); fed every Claude PTY output frame. */
  fallback?: { onOutput(id: string, userId: string, data?: string): void; sweep?(live: Array<{ id: string; userId: string }>): void; beforeLaunch?(row: { id: string; user_id: string; provider: string; model: string | null }): Promise<{ model: string | null; notice?: string } | null> };
  /** Extra Claude logins (set by index.ts): attributes CLI-refreshed credentials to the right account and forgets extras on disconnect. */
  accounts?: { adoptAttributed(userId: string, data: CredentialData): Promise<"single" | "active" | "reserve" | "unmatched" | "retry">; reset(userId: string): Promise<void> };
  /** Test hook: overrides the TUI-ready detection timing. */
  readyTiming?: { quietMs: number; timeoutMs: number };
  /** Agent browser (set by index.ts): its daemon holds the shard awake and is stopped before the home locks. */
  browser?: { stop(userId: string, reason?: string): Promise<void>; onActivity?: (userId: string, running: boolean) => void };
  /** Per-user toggles the manager reads at launch (set by index.ts); absent = defaults. */
  settings?: { claudeAiConnectors(userId: string): Promise<boolean> };
  private readonly browserRunning = new Set<string>();
  private readonly reaper: NodeJS.Timeout;
  private readonly checkpointSweepTimers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: Config,
    private readonly pool: pg.Pool,
    private readonly shards: ShardService,
    private readonly vault: Vault,
  ) {
    this.codexModelCatalog = new CodexModelCatalog((userId) => this.discoverCodexModels(userId), config.models.codex);
    this.reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
    const first = setTimeout(() => void this.sweepCheckpointsOnce(), CHECKPOINT_SWEEP_FIRST_MS);
    const every = setInterval(() => void this.sweepCheckpointsOnce(), CHECKPOINT_SWEEP_INTERVAL_MS);
    first.unref(); every.unref();
    this.checkpointSweepTimers.push(first, every);
  }

  /**
   * Retention sweep over every awake shard: a checkpoint dir whose agent row is gone is removed 7 days after it was first seen
   * missing. Sleeping shards are not woken (swept when next awake). One user at a time, yielding to the event loop in between.
   */
  async sweepCheckpointsOnce(): Promise<number> {
    let removed = 0;
    for (const userId of this.shards.awakeUserIds()) {
      if (this.shuttingDown) break;
      try {
        const handle = this.shards.awakeHandle(userId);
        if (!handle) continue;
        const ids = new Set<string>((await this.pool.query("SELECT id FROM agent_sessions WHERE user_id = $1", [userId])).rows.map((r) => String(r.id)));
        removed += sweepCheckpoints({ home: this.hostHome(handle), uid: handle.uid }, ids);
      } catch (error) {
        log.warn("checkpoint.sweep_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      }
      await new Promise<void>((r) => setImmediate(r));
    }
    if (removed) log.info("checkpoint.swept", { removed });
    return removed;
  }

  /** Wire the agent browser: a running daemon counts as shard activity (no idle lock) until it has fully stopped. */
  attachBrowser(browser: NonNullable<SessionManager["browser"]>): void {
    this.browser = browser;
    browser.onActivity = (userId, running) => this.browserActivity(userId, running);
  }

  browserActivity(userId: string, running: boolean): void {
    if (running === this.browserRunning.has(userId)) return;
    if (running) {
      this.browserRunning.add(userId);
      this.cancelLock(userId);
      this.shardActivityCounts.set(userId, (this.shardActivityCounts.get(userId) ?? 0) + 1);
      return;
    }
    this.browserRunning.delete(userId);
    const remaining = (this.shardActivityCounts.get(userId) ?? 1) - 1;
    if (remaining <= 0) this.shardActivityCounts.delete(userId);
    else this.shardActivityCounts.set(userId, remaining);
    if (remaining <= 0 && !this.shuttingDown && !this.hasActiveProcess(userId)) this.scheduleLock(userId);
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
      this.shards.seed(home, ".codex", handle.uid, new Set(), handle.mountPath);
      const authFile = join(home, "auth.json");
      writeFileOwned(handle.mountPath, authFile, JSON.stringify(credential), handle.uid, 0o600);

      const profile: RuntimeProfile = {
        claudeAutoApprove: false,
        codexAutoApprove: false,
        opencodeAutoApprove: false,
        antigravityAutoApprove: false,
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
          removeHomeTree(handle.mountPath, target);
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
    const home = this.hostHome(state.handle);
    const confine = { home, uid: state.handle.uid };
    const tail = state.provider === "claude"
      ? (() => { const path = claudeTranscriptPath(home, state.providerSessionId ?? id); return path ? readTranscriptTail(path, MAX_TRANSCRIPT_TAIL_BYTES, confine) : null; })()
      : withRollout(home, this.shards.driver.hostPath(state.handle, codexHomeRel(id) + "/sessions"), (path) => readTranscriptTail(path, MAX_TRANSCRIPT_TAIL_BYTES, confine));
    if (!tail) return null;
    const turnNow = analyzeTranscript(state.provider, tail.text);
    if (turnNow.status !== "working") this.checkpoints.notify(id);
    return { ...turnNow, mtimeMs: tail.mtimeMs, trailingAssistantText: state.provider === "claude" && endsWithAssistantText(tail.text) };
  }

  /** Copy the new bytes of a live Claude/Codex agent's transcript into its last-good checkpoint (skipped when the file did not change). */
  private async runCheckpoint(id: string): Promise<void> {
    const state = this.nativeTitleSessions.get(id);
    if (!state || !state.providerSessionId) return;
    const home = this.hostHome(state.handle);
    const sourcePath = state.provider === "claude"
      ? claudeTranscriptPath(home, id)
      : findCodexRolloutPath(home, this.shards.driver.hostPath(state.handle, codexHomeRel(id) + "/sessions"), state.handle.uid);
    if (!sourcePath) return;
    const st = statSync(sourcePath);
    const stamp = st.mtimeMs + ":" + st.size;
    if (this.checkpointStamps.get(id) === stamp) return;
    await checkpointTranscript({ home, uid: state.handle.uid, sessionId: id, provider: state.provider, providerSessionId: state.providerSessionId, sourcePath });
    this.checkpointStamps.set(id, stamp);
  }

  /** Tail text of a live Claude agent's transcript (the usage-limit fallback reads it); null when unavailable. */
  readTranscriptText(id: string, userId: string): string | null {
    const state = this.nativeTitleSessions.get(id);
    if (!state || state.userId !== userId || state.provider !== "claude") return null;
    const path = claudeTranscriptPath(this.hostHome(state.handle), state.providerSessionId ?? id);
    return path ? readTranscriptTail(path, MAX_TRANSCRIPT_TAIL_BYTES, { home: this.hostHome(state.handle), uid: state.handle.uid })?.text ?? null : null;
  }

  /** ms since a live session last wrote terminal output (Infinity when it is not live). */
  outputQuietMs(id: string): number {
    const live = this.live.get(id);
    return live ? Date.now() - live.lastActivity : Infinity;
  }

  /** Change marker of a live Claude agent's transcript (mtime:size) for the usage-limit fallback's cheap pre-check. */
  transcriptStamp(id: string, userId: string): string | null {
    const state = this.nativeTitleSessions.get(id);
    if (!state || state.userId !== userId || state.provider !== "claude") return null;
    const path = claudeTranscriptPath(this.hostHome(state.handle), state.providerSessionId ?? id);
    if (!path) return null;
    try { const st = statSync(path); return st.mtimeMs + ":" + st.size; } catch { return null; }
  }

  /** Drop a queued boot notice (the launch it was meant for failed). */
  dropBootNotice(id: string): void {
    this.bootNotices?.delete(id);
  }

  /** Type a short trusted notice into a live Claude/Codex agent's terminal (used to tell a parent about a child's usage-limit fallback). False when it is not live. */
  async typeNotice(userId: string, id: string, text: string): Promise<boolean> {
    const session = this.live.get(id);
    if (!session || session.userId !== userId || !session.isAlive || session.provider === "shell" || this.logins.has(id)) return false;
    await serialPerTarget(id, () => typeMessage((d) => session.write(d), text, { bracketed: bracketedProvider(session.provider), trusted: true }));
    return true;
  }

  /** Queue a trusted notice typed once after the session's next launch is ready (used by the usage-limit fallback). */
  queueBootNotice(id: string, text: string): void {
    (this.bootNotices ??= new Map()).set(id, text);
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
    const result = await this.pool.query("SELECT s.*, " + CLAUDE_CONVERSATION_SQL + " AS claude_conversation_id FROM agent_sessions s WHERE s.id = $1 AND s.user_id = $2", [id, userId]);
    if (!result.rows[0]) throw notFound("Session " + id + " not found");
    return result.rows[0] as Row;
  }

  /** `orgId`: organization to create in (the request's active org); omitted = the owner's personal organization. */
  async createProject(userId: string, profile: RuntimeProfile, gitUrlValue?: string, requestedName?: string, orgId?: string): Promise<RuntimeProject> {
    const name = validateProjectName(requestedName);
    if (gitUrlValue === undefined) {
      if (!name) throw badRequest("name is required when gitUrl is not provided", "invalid_project");
      return this.createNamedProject(userId, name, orgId);
    }
    if (typeof gitUrlValue !== "string" || !gitUrlValue.trim()) throw badRequest("gitUrl must be a non-empty string", "invalid_project");
    const gitUrl = gitUrlValue.trim();
    const normalized = normalizeGitUrl(gitUrl);
    const key = userId + "\0" + (orgId ?? "") + "\0" + normalized;
    const pending = this.projectCreates.get(key);
    if (pending) return pending;
    const task = this.withShardActivity(userId, async () => {
      const existing = orgId
        ? await this.pool.query("SELECT id, organization_id FROM floq_projects WHERE user_id=$1 AND normalized_git_url=$2", [userId, normalized])
        : await this.pool.query("SELECT id FROM floq_projects WHERE user_id=$1 AND normalized_git_url=$2", [userId, normalized]);
      if (existing.rows[0]) {
        const found = existing.rows[0] as { id: string; organization_id?: string };
        if (orgId && found.organization_id && found.organization_id !== orgId) await this.throwInOtherOrg(String(found.id), String(found.organization_id));
        return (await this.project(userId, String(found.id)))!;
      }
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
        const branch = branchFromCheckout(handle.mountPath, target);
        const client = await this.pool.connect();
        let projectId: string = id;
        try {
          await client.query("BEGIN");
          // Without an explicit organization the database default places the project in the owner's personal one.
          const inserted = await client.query(
            `INSERT INTO floq_projects(id,user_id,name,git_url,normalized_git_url,cwd${orgId ? ",organization_id" : ""})
             VALUES($1,$2,$3,$4,$5,$6${orgId ? ",$7" : ""})
             ON CONFLICT (user_id,normalized_git_url) WHERE normalized_git_url IS NOT NULL DO NOTHING
             RETURNING id`, orgId ? [id,userId,projectName,gitUrl,normalized,cwd,orgId] : [id,userId,projectName,gitUrl,normalized,cwd],
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
          removeHomeTree(handle.mountPath, resolved);
        }
        return (await this.project(userId, projectId))!;
      } catch (error) {
        const resolved = resolve(target);
        const home = resolve(handle.mountPath);
        if ((!commitAttempted || loserClone) && insidePath(home, resolved)) { try { removeHomeTree(handle.mountPath, resolved); } catch { /* unsafe path: never follow it, leave it */ } }
        throw error;
      }
    }).finally(() => this.projectCreates.delete(key));
    this.projectCreates.set(key, task);
    return task;
  }

  private async throwInOtherOrg(projectId: string, organizationId: string): Promise<never> {
    let organizationName = "";
    try {
      organizationName = String((await this.pool.query("SELECT name FROM collaboration.organizations WHERE id=$1::uuid", [organizationId])).rows[0]?.name ?? "");
    } catch { /* name is a courtesy */ }
    throw new HttpError(409, "project_in_other_org", "This repository is already a project in another organization", { projectId, organizationId, organizationName });
  }

  private async createNamedProject(userId: string, name: string, orgId?: string): Promise<RuntimeProject> {
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
        mkdirOwnedSegment(handle.mountPath, target, handle.uid);
        targetCreated = true;
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO floq_projects(id,user_id,name,git_url,normalized_git_url,cwd${orgId ? ",organization_id" : ""})
             VALUES($1,$2,$3,NULL,NULL,$4${orgId ? ",$5" : ""})`, orgId ? [id,userId,name,cwd,orgId] : [id,userId,name,cwd],
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
          if (!commitAttempted) { try { removeHomeTree(handle.mountPath, resolved); } catch { /* unsafe path: never follow it, leave it */ } }
          else {
            // COMMIT can fail after the database accepted it. A missing row is safe to act on only after
            // ROLLBACK was confirmed; otherwise a fresh lookup may race a still-unresolved commit.
            try {
              const registered = await this.pool.query("SELECT id FROM floq_projects WHERE id=$1 AND user_id=$2", [id, userId]);
              if (!registered.rows[0]) {
                if (rollbackConfirmed) { try { removeHomeTree(handle.mountPath, resolved); } catch { /* unsafe path: never follow it, leave it */ } }
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

  /** The owner's projects; with `orgId`, only those in that organization. */
  async listProjects(userId: string, orgId?: string): Promise<RuntimeProject[]> {
    const projects = orgId
      ? await this.pool.query("SELECT * FROM floq_projects WHERE user_id=$1 AND organization_id=$2 ORDER BY created_at DESC", [userId, orgId])
      : await this.pool.query("SELECT * FROM floq_projects WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    const workspaces = await this.pool.query(
      `SELECT w.*, COALESCE(array_agg(s.id::text) FILTER (WHERE s.id IS NOT NULL), ARRAY[]::text[]) AS session_ids
       FROM floq_project_workspaces w LEFT JOIN agent_sessions s ON s.user_id=w.user_id AND s.workspace_id=w.id
       WHERE w.user_id=$1 ${orgId ? "AND w.project_id IN (SELECT id FROM floq_projects WHERE user_id=$1 AND organization_id=$2)" : ""}
       GROUP BY w.id ORDER BY w.created_at`, orgId ? [userId, orgId] : [userId],
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
      cwd: String(row.cwd), createdAt: new Date(String(row.created_at)).toISOString(), organizationId: row.organization_id ? String(row.organization_id) : "", workspaces: byProject.get(String(row.id)) ?? [],
    }));
  }

  /** Organization a session belongs to: its project's, else the owner's personal one. Null when organizations are unavailable. */
  private async sessionOrg(userId: string, projectId: string | null): Promise<string | null> {
    try {
      const result = projectId
        ? await this.pool.query("SELECT organization_id AS org FROM floq_projects WHERE id=$1 AND user_id=$2", [projectId, userId])
        : await this.pool.query("SELECT id AS org FROM collaboration.organizations WHERE personal_owner_id=$1", [userId]);
      return result.rows[0]?.org ? String(result.rows[0].org) : null;
    } catch { return null; }
  }

  /** 404 unless the project exists, belongs to `userId` AND lives in organization `orgId` (never 403: nothing leaks). */
  async requireProject(userId: string, orgId: string, projectId: string): Promise<void> {
    if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(orgId)) throw notFound("Project not found");
    const found = await this.pool.query("SELECT 1 FROM floq_projects WHERE id=$1 AND user_id=$2 AND organization_id=$3", [projectId, userId, orgId]);
    if (!found.rows[0]) throw notFound("Project not found");
  }

  /** Move a project to another organization of the same owner (the caller has verified membership of `targetOrgId`). */
  async moveProject(userId: string, projectId: string, targetOrgId: string): Promise<RuntimeProject> {
    if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(targetOrgId)) throw notFound("Project not found");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = (await client.query("SELECT organization_id FROM floq_projects WHERE id=$1 AND user_id=$2 FOR UPDATE", [projectId, userId])).rows[0] as { organization_id: string } | undefined;
      if (!current) throw notFound("Project not found");
      const from = String(current.organization_id);
      if (from !== targetOrgId) {
        await client.query("UPDATE floq_projects SET organization_id=$3 WHERE id=$1 AND user_id=$2", [projectId, userId, targetOrgId]);
        await moveProjectsInFolders(client, userId, [projectId], from, targetOrgId);
      }
      await client.query("COMMIT");
      for (const live of this.live.values()) if (live.userId === userId && live.projectId === projectId) live.organizationId = targetOrgId;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
    return (await this.project(userId, projectId))!;
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
    const count = async (table: "canvas_notes") => Number((await this.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1 AND project_id=$2`, [userId, projectId])).rows[0]?.n ?? 0);
    const plan = planCheckouts(projectId, workspaces.map((row) => ({ id: String(row.id), cwd: String(row.cwd), isWorktree: row.is_worktree === true })));
    const checkouts: CheckoutReport[] = [];
    for (const item of plan) {
      const report: CheckoutReport = { workspaceId: item.workspaceId, path: item.cwd, kind: item.kind, branch: null, managed: item.managed, state: item.managed ? "ok" : "unmanaged", uncommittedFiles: null };
      if (item.managed) {
        let present = true;
        try { present = lstatHome(handle.mountPath, join(handle.mountPath, item.cwd)) !== null; } catch { /* unsafe path: not missing, the branch check below refuses it */ }
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
        try { removeHomeTree(handle.mountPath, this.secretDir(handle, id)); } catch { /* best effort */ }
        const session = this.live.get(id);
        if (session) {
          this.intentionalSleep.add(id);
          this.live.delete(id);
          this.vault.revokeSession(id);
          session.dispose();
        }
      }

      // 2. All database state in one transaction; sessions cascade to links, inbox, wired memory and note links.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM agent_approvals WHERE user_id=$1 AND (requester_project_id=$2 OR target_project_id=$2)", [userId, projectId]);
        await client.query("DELETE FROM agent_links WHERE project_id=$1", [projectId]);
        await client.query("DELETE FROM canvas_notes WHERE user_id=$1 AND project_id=$2", [userId, projectId]);
        // Legacy: keychains no longer exist as a feature, but old rows (no FK on project_id) are removed with their project so no sealed secret is orphaned.
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

  async projectBranches(userId: string, projectId: string, workspaceId: string, options: { fetch?: boolean } = {}): Promise<{ currentBranch: string | null; branches: string[]; remoteOnly: string[]; fetchError?: string }> {
    return this.withShardActivity(userId, async () => {
      const { cwd } = await this.getRegisteredWorkspace(userId, projectId, workspaceId);
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      this.assertSafeRegisteredCheckout(handle, cwd);
      return listProjectBranches((args) => this.runWorkspaceGit(handle, cwd, args), options);
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

  /**
   * What Storage Sense needs from the runtime. Only awake shards are ever touched (a sleeping home is never woken for cleanup),
   * and git runs in the user's own sandbox through the same runner the worktree delete uses.
   */
  storageSenseHost(): StorageSenseHost {
    return {
      awakeUserIds: () => [...this.shards.awakeUserIds()],
      homeOf: (userId) => { const handle = this.shards.awakeHandle(userId); return handle ? this.hostHome(handle) : null; },
      sessions: async (userId) => (await this.pool.query("SELECT id, workspace_id, state, last_active_at FROM agent_sessions WHERE user_id = $1", [userId])).rows.map((r: Record<string, unknown>) => ({
        id: String(r.id), workspaceId: r.workspace_id ? String(r.workspace_id) : null,
        // A session still held in memory counts as live whatever its row says.
        state: this.live.get(String(r.id))?.isAlive ? "running" : String(r.state),
        lastActiveMs: r.last_active_at ? new Date(r.last_active_at as string).getTime() : 0,
      })),
      workspaces: async (userId) => (await this.pool.query(
        `SELECT w.id, w.project_id, w.cwd, w.is_worktree, w.available, w.created_at, p.cwd AS project_cwd
         FROM floq_project_workspaces w JOIN floq_projects p ON p.id = w.project_id AND p.user_id = w.user_id WHERE w.user_id = $1`, [userId])).rows.map((r: Record<string, unknown>) => ({
        id: String(r.id), projectId: String(r.project_id), cwd: String(r.cwd), projectCwd: String(r.project_cwd),
        isWorktree: r.is_worktree === true, available: r.available !== false, createdMs: new Date(r.created_at as string).getTime(),
      })),
      git: async (userId, cwd, args) => {
        const handle = this.shards.awakeHandle(userId);
        if (!handle) throw unavailable("Home is asleep");
        return this.runWorkspaceGit(handle, cwd, args);
      },
      withProject: (_userId, projectId, fn) => this.withProjectBranchLock(projectId, fn),
      withActivity: (userId, fn) => this.withShardActivity(userId, fn),
      markWorkspaceUnavailable: async (userId, projectId, workspaceId) => { await this.pool.query("UPDATE floq_project_workspaces SET available=FALSE WHERE id=$1 AND project_id=$2 AND user_id=$3", [workspaceId, projectId, userId]); },
      freePercent: async (userId) => {
        const handle = this.shards.awakeHandle(userId);
        if (!handle) return null;
        const st = await statfs(this.hostHome(handle));
        return st.blocks > 0 ? Math.round((st.bavail / st.blocks) * 1000) / 10 : null;
      },
    };
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

  /**
   * The user's sessions. With `orgId`, only sessions of that organization's projects, plus project-less (scratch/home)
   * sessions when `orgId` is the personal organization; each summary carries its `organizationId`.
   */
  async list(userId: string, orgId?: string): Promise<SessionSummary[]> {
    const result = orgId
      ? await this.pool.query(
        `SELECT s.*, p.organization_id AS org_id FROM agent_sessions s LEFT JOIN floq_projects p ON p.id = s.project_id AND p.user_id = s.user_id
         WHERE s.user_id = $1 AND (p.organization_id = $2::uuid OR (s.project_id IS NULL AND $2::uuid = (SELECT o.id FROM collaboration.organizations o WHERE o.personal_owner_id = $1)))
         ORDER BY (s.archived_at IS NOT NULL), s.last_active_at DESC LIMIT 500`,
        [userId, orgId],
      )
      : await this.pool.query(
        "SELECT * FROM agent_sessions WHERE user_id = $1 ORDER BY (archived_at IS NOT NULL), last_active_at DESC LIMIT 500",
        [userId],
      );
    return result.rows.map((row: Row) => {
      const live = this.live.get(row.id);
      const organizationId = orgId ? String((row as Row & { org_id?: string | null }).org_id ?? orgId) : undefined;
      if (!live) return { ...summaryFromRow(row), ...(organizationId ? { organizationId } : {}) };
      const summary = { ...live.toSummary(), ...(organizationId ? { organizationId } : {}), fallback: fallbackBadge(row.fallback_state), fallbackOverride: overrideOf(row) };
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
      // The directory is user-owned from creation on: write through a descriptor-pinned handle so a swapped parent cannot redirect root.
      const dir = openHomeDir(handle.mountPath, hostDirectory);
      if (!dir) throw badRequest("Attachment storage is unsafe", "unsafe_attachment_path");
      try {
        const destination = join(dir.path, name);
        if (existsSync(destination) || (() => { try { lstatSync(destination); return true; } catch { return false; } })()) throw badRequest("Attachment storage is unsafe", "unsafe_attachment_path");
        writeFileOwned(null, destination, contents, handle.uid, 0o600);
      } catch (error) {
        if (error instanceof UnsafeHomePathError) throw badRequest("Attachment storage is unsafe", "unsafe_attachment_path");
        throw error;
      } finally { dir.close(); }
      return { path: join(this.shards.driver.homePath(handle), relativeDirectory, name), size: contents.length };
    });
  }

  /** Create a fresh private `.floq/attachments/<uuid>` directory owned by the user, refusing symlinked parents. */
  private prepareAttachmentDirectory(handle: ShardHandle): { hostDirectory: string; relativeDirectory: string; directoryPath: string } {
    const directoryId = randomUUID();
    const relativeDirectory = `.floq/attachments/${directoryId}`;
    const hostDirectory = this.shards.driver.hostPath(handle, relativeDirectory);
    // Every segment is created through a descriptor pinned without following links, so a swapped parent cannot redirect root.
    try { mkdirOwned(handle.mountPath, hostDirectory, handle.uid, 0o700); } catch (error) {
      if (error instanceof UnsafeHomePathError) throw badRequest("Attachment storage is unsafe", "unsafe_attachment_path");
      throw error;
    }
    const current = hostDirectory;
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
      const dir = openHomeDir(handle.mountPath, hostDirectory);
      if (!dir) throw badRequest("Attachment storage is unsafe", "unsafe_attachment_path");
      const destination = join(dir.path, name);
      const partial = join(dir.path, `.upload-${randomUUID()}.part`);
      try {
        const size = await streamToFile(source, partial, options.maxBytes, options.contentLength);
        lchownSync(partial, handle.uid, handle.uid);
        renameSync(partial, destination);
        return { path: join(this.shards.driver.homePath(handle), relativeDirectory, name), size };
      } catch (error) {
        try { rmSync(partial, { force: true }); } catch { /* best effort */ }
        try { removeHomeTree(handle.mountPath, directoryPath); } catch { /* best effort */ }
        if (error instanceof UnsafeHomePathError) throw badRequest("Attachment storage is unsafe", "unsafe_attachment_path");
        throw error;
      } finally { dir.close(); }
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
        args: [...GIT_HARDENING_ARGS, "clone", "--depth", "50", "--no-single-branch", "--", url, this.shards.driver.homePath(handle) + "/" + rel],
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
    try { mkdirOwned(handle.mountPath, this.shards.driver.hostPath(handle, ".floq/projects"), handle.uid, 0o755); } catch (error) {
      if (error instanceof UnsafeHomePathError) throw badRequest("Project storage path is unsafe", "unsafe_project_path");
      throw error;
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
    const agent = specKitIntegrationArgs(provider);
    if (!agent) return Promise.resolve();
    return new Promise((done) => {
      const [file, args] = this.asUser(handle, "specify", ["init", "--here", "--force", "--non-interactive", "--ignore-agent-tools", ...agent]);
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
    // Usage-limit fallback, proactive: a full plan window is handled BEFORE the process starts (model or account step), so no turn is wasted.
    if (row.provider === "claude" && this.fallback?.beforeLaunch) {
      const pre = await this.fallback.beforeLaunch(row).catch(() => null);
      if (pre) {
        row = { ...row, model: pre.model };
        if (pre.notice) this.queueBootNotice(row.id, pre.notice);
      }
    }
    const definition = getProviderDefinition(row.provider, this.config);
    // Claude's conversation id is the Floq session id; Codex's is discovered and stored.
    const providerId = row.provider === "claude" ? resolveClaudeConversationId(row) : row.provider_session_id;
    const resumeArgs = resume ? definition.resumeArgs(profile, providerId, row.model) : null;
    const resuming = resumeArgs !== null;
    const args = resumeArgs ?? definition.buildArgs(profile, row.provider === "claude" ? resolveClaudeConversationId(row) : row.id, row.model);
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
    // OpenCode: its `task` tool is denied through the inline config below. Antigravity has no switch for native subagents: policy text only.
    if (row.provider === "claude") args.push(...nativeSubagentBlockArgs("claude", { version: detectVersion(definition.bin).version, warn: (message) => log.warn("subagent.native_block_degraded", { sessionId: row.id, message }) }));
    // Wired context rides in the provider's system-level instructions on EVERY start and resume, so it survives compaction and restarts.
    const wiredBlock0 = this.wired && row.provider !== "shell" ? await this.wired.blockFor(row.user_id, row.id) : "";
    // The fixed Floq subagent policy rides in the same system-level text (one flag: a second --append-system-prompt would not combine), first and always present for agents.
    const skillsBlock = row.provider === "shell" ? "" : buildRecruitSkillsBlock(storedRecruitSkills(row.recruit_skills), row.provider);
    // Shared deliverables folder (<home>/Artifacts/<project>): created best-effort; agents get its path in env and guidance.
    let artifactsDir: string | null = null;
    try {
      ensureArtifactsDir(handle, row.project_id);
      artifactsDir = this.shards.driver.homePath(handle) + "/" + artifactsRel(row.project_id);
    } catch (error) { log.warn("artifacts.dir_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); }
    const wiredBlock = row.provider === "shell" ? "" : composeSystemBlocks(this.subagents ? await this.subagents.blockFor(row.user_id, row.id) : "", this.memories?.enabled() ? buildMemoryPolicy() : "", skillsBlock, artifactsDir ? artifactsGuidance(artifactsDir, row.provider) : "", wiredBlock0);
    if (wiredBlock && row.provider === "claude") args.push("--append-system-prompt", wiredBlock);
    // Initial prompt: fresh starts only, as its own argv element after all flags (no shell involved).
    // Antigravity has no system-prompt flag: the Floq block rides in its first message on every start and resume instead.
    if (row.provider === "antigravity") {
      const text = antigravityPrompt(wiredBlock, resuming ? undefined : prompt, resuming);
      if (text) args.push(...(definition.promptArgs?.(text) ?? ["--", text]));
    } else if (!resuming && prompt) args.push(...(definition.promptArgs?.(prompt) ?? ["--", prompt]));
    const env = buildSessionEnv(this.config, row.provider, profile, row.id);
    // ~/.local/bin first: user-installed tools, including the launchers `apt install` (image/floq-apt) writes there.
    if (this.shards.driver.name === "linux") {
      env.PATH = withUserBin(this.shards.driver.homePath(handle), env.PATH);
      Object.assign(env, mkcertEnv(this.shards.driver.homePath(handle))); // per-user mkcert CA + NSS-only trust store (see mkcertEnv)
    }
    // Secrets the user marked "env" are injected; the rest are only reachable through `floq-vault`.
    Object.assign(env, await this.vault.reveal(row.user_id, null, "env", row.id));
    Object.assign(env, forcedSessionEnv(row.provider, { cacheDisable: this.config.cacheDisable, codeMode: this.config.claudeCodeMode })); // a vault entry must not undo the renderer pin or the FLOQ_CACHE_DISABLE kill switch
    // Clear secret files that older versions wrote under <home>/.floq/secrets/<sessionId>/ (nothing writes them any more).
    // Vault secrets marked "env" were injected above; the rest are reached through `floq secret get` / the floq-vault skill.
    try { this.syncSecretFiles(handle, row.id, {}); } catch (error) { log.warn("secret.sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); }
    // Per-user netns (FLOQ_NETNS): the runtime is reached through the namespace gateway, which pasta maps to the runtime's loopback.
    env.FLOQ_API_URL = "http://" + (handle.netns ? NETNS_GATEWAY : "127.0.0.1") + ":" + this.config.port;
    env.FLOQ_AGENT_TOKEN = this.vault.issueToken(row.user_id, row.id);
    env.FLOQ_AGENT_NAME = row.title;
    if (artifactsDir) env.FLOQ_ARTIFACTS_DIR = artifactsDir;
    if (row.provider === "codex") {
      env.CODEX_HOME = this.shards.driver.homePath(handle) + "/" + codexHomeRel(row.id);
      const codexHome = this.shards.driver.hostPath(handle, codexHomeRel(row.id));
      mkdirOwned(handle.mountPath, codexHome, handle.uid);
      this.shards.seed(codexHome, ".codex", handle.uid, await loadRemovedSkills(this.pool, row.user_id).catch(() => null), handle.mountPath);
      this.syncGlobalCodexMcp(handle, codexHome);
      try {
        syncProtectedFloqSkill(codexHome, join(this.config.skelDir, ".codex/skills/floq-orchestrate"), handle.uid, handle.mountPath);
      } catch (error) {
        log.warn("codex.protected_skill_sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      try {
        syncCodexManagedGuidance(codexHome, handle.uid, wiredBlock, handle.mountPath);
      } catch (error) {
        log.warn("codex.managed_guidance_sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      const cred = await this.freshCredential(row.user_id, "codex");
      if (cred) this.writeCredFile(handle, this.codexAuthPath(handle, row.id), JSON.stringify(cred));
    }
    if (row.provider === "opencode") {
      // Private per-session dir (the CODEX_HOME pattern): own session database, config dir with the protected Floq skill, instructions file.
      const rel = opencodeHomeRel(row.id);
      const home = this.shards.driver.homePath(handle) + "/" + rel;
      const dir = this.shards.driver.hostPath(handle, rel);
      mkdirOwned(handle.mountPath, dir, handle.uid);
      env.OPENCODE_DB = home + "/opencode.db";
      env.OPENCODE_CONFIG_DIR = home + "/config";
      let instructions: string | null = null;
      try {
        mkdirOwned(handle.mountPath, join(dir, "config"), handle.uid);
        if (wiredBlock) {
          writeFileOwned(handle.mountPath, join(dir, "instructions.md"), wiredBlock + "\n", handle.uid, 0o600);
          instructions = home + "/instructions.md";
        }
        syncProtectedFloqSkill(join(dir, "config"), join(this.config.skelDir, ".codex/skills/floq-orchestrate"), handle.uid, handle.mountPath);
      } catch (error) {
        log.warn("opencode.session_setup_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      env.OPENCODE_CONFIG_CONTENT = opencodeConfigContent(instructions);
    }
    let agyUsedOauth = false;
    if (row.provider === "antigravity") {
      // agy keeps everything under ~/.gemini (HOME cannot be repointed per session), so only session-agnostic files go there.
      try {
        const rules = this.shards.driver.hostPath(handle, ".gemini/config/rules");
        mkdirOwned(handle.mountPath, rules, handle.uid);
        writeFileOwned(handle.mountPath, join(rules, "floq.md"), FLOQ_RULES_GUIDANCE, handle.uid, 0o644);
        // First run shows a colour-scheme picker that swallows the -i message; this marker (only when missing) skips it.
        const cache = this.shards.driver.hostPath(handle, ".gemini/antigravity-cli/cache");
        mkdirOwned(handle.mountPath, cache, handle.uid);
        if (lstatHome(handle.mountPath, join(cache, "onboarding.json")) === null) {
          writeFileOwned(handle.mountPath, join(cache, "onboarding.json"), JSON.stringify({ onboardingComplete: true }), handle.uid, 0o600);
        }
        this.ensureAgySwarm(handle);
        syncProtectedFloqSkill(this.shards.driver.hostPath(handle, ".gemini/config"), join(this.config.skelDir, ".codex/skills/floq-orchestrate"), handle.uid, handle.mountPath);
      } catch (error) {
        log.warn("antigravity.session_setup_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      // A Google login (token file) wins over GEMINI_API_KEY; the key only drives agy when there is no login.
      const oauth = this.antigravityTokenPresent(handle) && !this.agyExpired.has(row.user_id);
      agyUsedOauth = oauth;
      if (oauth) delete env.GEMINI_API_KEY;
      for (const name of Object.keys(env)) if (name.startsWith("DBUS_")) delete env[name];
      const settings = antigravitySettings({
        oauth,
        hasApiKey: Boolean(env.GEMINI_API_KEY),
        trustedWorkspaces: managedTrustDirectories(this.shards.driver.homePath(handle), this.shards.driver.name === "linux" ? handle.mountPath : null, [row.cwd, row.project_cwd]),
      });
      if (settings) args.unshift("--settings", settings);
    }
    if (row.provider === "claude") {
      const claudeHome = this.shards.driver.hostPath(handle, ".claude");
      mkdirOwned(handle.mountPath, claudeHome, handle.uid);
      // Anything root left behind in ~/.claude (or ~/.claude.json) makes Claude Code's transcript/todo/snapshot
      // writes fail with EACCES. Repair a shallow slice (config dir, projects/<slug>, ...) on every start.
      try {
        ownHomeTree(handle.mountPath, claudeHome, handle.uid, 2);
        for (const name of [".claude.json", ".claude.json.backup"]) ownHomeTree(handle.mountPath, this.shards.driver.hostPath(handle, name), handle.uid, 0);
      } catch (error) {
        log.warn("claude.ownership_repair_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      try {
        syncProtectedFloqSkill(claudeHome, join(this.config.skelDir, ".claude/skills/floq-orchestrate"), handle.uid, handle.mountPath);
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
          const promoted = promoteUserPlugins({ home: this.shards.driver.hostPath(handle, "."), uid: handle.uid, managedDir, base, claudeAiConnectors: (await this.settings?.claudeAiConnectors(row.user_id)) ?? true });
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
        writeFileOwned(handle.mountPath, path, JSON.stringify(claudeProjectTrust(config, directories), null, 2), handle.uid, 0o600);
      }
    }
    // Antigravity: one fresh start at a time per (user, cwd) until its conversation id is captured (or 45 s pass), and the id
    // cache is read BEFORE the process exists so the baseline can never be this session's own conversation.
    let cliProbe: CliProbe | null = null;
    if ((row.provider === "opencode" || row.provider === "antigravity") && !providerId) {
      const cwds = managedTrustDirectories(this.shards.driver.homePath(handle), this.shards.driver.name === "linux" ? handle.mountPath : null, [row.cwd]);
      if (row.provider === "antigravity") await this.enterAgyGate(row.id, row.user_id, row.cwd);
      cliProbe = { provider: row.provider, userId: row.user_id, cwd: row.cwd, cwds, baseline: row.provider === "antigravity" ? this.readAntigravityId(handle, cwds) : null, env, inFlight: false, misses: 0, nextAt: 0 };
    }
    try {
      this.assertLifecycleOpen();
    } catch (error) {
      this.releaseAgyGate(row.id);
      throw error;
    }
    // Virtual display for GUI apps (`floq display start`): set last so a vault secret cannot repoint it.
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
      this.releaseAgyGate(row.id);
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
    try {
      session.organizationId = await this.sessionOrg(row.user_id, row.project_id);
    } catch (error) {
      log.warn("agy.gate_released_after_spawn_failure", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
      this.releaseAgyGate(row.id);
      throw error;
    }
    // Free the display slot only once the sandbox has really exited (its pid namespace, and with it xpra/Xvfb, is gone),
    // on every path: exit, sleep, remove, project delete, shutdown. whenExited() resolves even after dispose() dropped
    // the frame listeners. The token guard ignores this when a relaunch of the same session already holds a new lease.
    if (displayLease) void session.whenExited().then(() => this.displays.release(row.id, displayLease.token));
    if (row.provider === "claude" || row.provider === "codex") {
      this.nativeTitleSessions.set(row.id, {
        userId: row.user_id,
        provider: row.provider,
        fallback: row.title,
        providerSessionId: row.provider === "claude" ? resolveClaudeConversationId(row) : providerId,
        handle,
        checkedAt: 0,
        lastNativeTitle: null,
        checking: false,
      });
    }
    this.cancelLock(row.user_id);

    const launchedAt = Date.now();
    // A resume that outlives the fast-exit window succeeded: the retry counter starts over.
    if (resuming) setTimeout(() => { if (this.live.get(row.id) === session) this.resumeRetries.delete(row.id); }, RESUME_FALLBACK_MS + 1_000).unref();
    let agyTail = "";
    session.subscribe((frame) => {
      if (frame.type === "output") {
        if (row.provider === "antigravity" && agyUsedOauth) {
          // The login picker / an expiry notice means the Google login is dead: stop trusting it, so the next start keeps GEMINI_API_KEY.
          agyTail = stripAnsi(agyTail + frame.data).slice(-400);
          if (AGY_LOGIN_LOST.test(agyTail)) { agyTail = ""; this.markAgyLoginLost(row.user_id); }
        }
        void this.updateNativeTitle(row.id);
        if (row.provider === "claude") this.fallback?.onOutput(row.id, row.user_id, frame.data);
        return;
      }
      if (frame.type === "exit") void this.onExit(session, frame.session.state, !strictResume && resuming && Date.now() - launchedAt < RESUME_FALLBACK_MS, profile, handle);
    });

    if (cliProbe) this.cliProbes.set(row.id, cliProbe);
    await this.pool.query(
      "UPDATE agent_sessions SET state = 'running', resume_count = $2, sleep_reason = NULL, slept_at = NULL, last_active_at = now(), resume_on_boot = FALSE, interrupted_turn = FALSE, archived_at = NULL WHERE id = $1",
      [row.id, resumeCount],
    );
    void this.readyFlow(session);
    void this.updateNativeTitle(row.id);
    if (row.provider === "claude" || row.provider === "codex") this.pollNativeTitleSoon(row.id);
    if (row.provider === "codex" && !providerId) this.pollCodexId(row.id, handle);
    if (cliProbe) this.pollCodexId(row.id, handle);
    if (row.provider === "antigravity") this.trackAgySwarm(row, handle, providerId);
    return session;
  }

  /** Antigravity's native swarm stays on (its workers are mirrored on the canvas): set plugins.swarm.enabled=true only when the key is missing; an explicit user value is respected. */
  private ensureAgySwarm(handle: ShardHandle): void {
    try {
      const path = this.shards.driver.hostPath(handle, ".gemini/config/config.json");
      const exists = lstatHome(handle.mountPath, path) !== null;
      const raw = exists ? SkillsService.readSafeConfig(path, realpathSync(handle.mountPath)) : null;
      if (exists && raw === null) return; // unreadable or unsafe: leave it
      let config: Record<string, any> = {};
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        config = parsed as Record<string, any>;
      }
      const plugins = typeof config.plugins === "object" && config.plugins !== null && !Array.isArray(config.plugins) ? config.plugins : {};
      const swarm = typeof plugins.swarm === "object" && plugins.swarm !== null && !Array.isArray(plugins.swarm) ? plugins.swarm : {};
      if (swarm.enabled !== undefined) return;
      config.plugins = { ...plugins, swarm: { ...swarm, enabled: true } };
      writeFileOwned(handle.mountPath, path, JSON.stringify(config, null, 2) + "\n", handle.uid, 0o600);
    } catch (error) {
      log.warn("antigravity.swarm_enable_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }

  private agyReconcileTimer: NodeJS.Timeout | null = null;

  /** Forget mirror snapshots of sessions that no longer exist or were archived (deleted via any path, e.g. a project delete). */
  private async reconcileAgyMirror(): Promise<void> {
    const ids = this.agyMirror?.hostIds() ?? [];
    if (!ids.length) return;
    const result = await this.pool.query("SELECT id::text AS id FROM agent_sessions WHERE id = ANY($1::uuid[]) AND archived_at IS NULL", [ids]);
    const alive = new Set((result.rows as { id: string }[]).map((r) => r.id));
    for (const id of ids) if (!alive.has(id) && !this.live.has(id)) this.agyMirror.forget(id);
  }

  /** Start mirroring this agy session's swarm (root conversation may still be unknown; captureCliId sets it). */
  private trackAgySwarm(row: Row, handle: ShardHandle, rootConv: string | null): void {
    if (!this.agyReconcileTimer) {
      this.agyReconcileTimer = setInterval(() => { void this.reconcileAgyMirror().catch(() => undefined); }, 60_000);
      this.agyReconcileTimer.unref();
    }
    try {
      this.agyMirror.track({
        sessionId: row.id,
        userId: row.user_id,
        projectId: row.project_id ?? "",
        home: this.hostHome(handle),
        appData: this.shards.driver.hostPath(handle, ".gemini/antigravity-cli"),
        rootConv,
        // The hostile-prone SQLite read runs as the user's own uid inside their sandbox, never as the runtime.
        spawnDb: (command) => this.shards.driver.spawnPipe(handle, { file: command.file, args: command.args, cwd: ".", env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" } }),
        sandboxDbPath: this.shards.driver.homePath(handle) + "/.gemini/antigravity-cli/conversation_summaries.db",
      });
    } catch (error) {
      log.warn("antigravity.mirror_track_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }

  /** Ask the host agy session to relay a message to a mirrored worker (typed untrusted, through the normal message path). False when the host is not live. */
  async relayToAgyAgent(userId: string, vid: string, text: string): Promise<boolean> {
    const found = this.agyMirror.find(userId, vid);
    if (!found) return false;
    const session = this.live.get(found.state.host.sessionId);
    if (!session || session.userId !== userId || !session.isAlive) return false;
    const name = found.agent.name.replace(/[^\w.-]/g, "_").slice(0, 80);
    const body = "Please relay to @" + name + " via the swarm board: " + text.replace(/\s+/g, " ").trim().slice(0, 2000);
    await serialPerTarget(session.id, () => typeMessage((d) => session.write(d), body, { bracketed: bracketedProvider(session.provider), trusted: false }));
    return true;
  }

  private async enterAgyGate(sessionId: string, userId: string, cwd: string): Promise<void> {
    const key = userId + "\0" + cwd;
    // Chain synchronously (no await between reading and writing the map): N queued starters run strictly one after another.
    const previous = this.agyGates.get(key) ?? Promise.resolve();
    let release!: () => void;
    const own = new Promise<void>((resolve) => { release = resolve; });
    const gate = previous.then(() => own);
    this.agyGates.set(key, gate);
    // The slot is held from our turn until released (capture, exit, sleep, spawn failure) or AGY_GATE_MS after we got it.
    let timer: NodeJS.Timeout | null = null;
    this.agyRelease.set(sessionId, () => {
      if (timer) clearTimeout(timer);
      release();
      void gate.then(() => { if (this.agyGates.get(key) === gate) this.agyGates.delete(key); });
    });
    await previous;
    timer = setTimeout(release, AGY_GATE_MS);
    timer.unref();
  }

  private releaseAgyGate(sessionId: string): void {
    const release = this.agyRelease?.get(sessionId);
    this.agyRelease?.delete(sessionId);
    release?.();
  }

  private readAntigravityId(handle: ShardHandle, cwds: string[]): string | null {
    try {
      const raw = SkillsService.readSafeConfig(this.shards.driver.hostPath(handle, ".gemini/antigravity-cli/cache/last_conversations.json"), realpathSync(handle.mountPath));
      return raw === null ? null : parseAntigravityConversationId(raw, cwds);
    } catch { return null; }
  }

  /** `opencode session list` inside the sandbox, against the session's private database. */
  private probeOpencodeId(handle: ShardHandle, probe: { cwd: string; env: Record<string, string> }, timeoutMs = 15_000): Promise<string | null> {
    return new Promise((done) => {
      try {
        const child = this.shards.driver.spawnPipe(handle, { file: this.config.providers.opencode, args: ["session", "list", "--format", "json", "-n", "10"], cwd: probe.cwd, env: probe.env });
        let out = "";
        child.stdout!.on("data", (chunk) => { if (out.length < 1 << 20) out += chunk.toString(); });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.on("error", () => { clearTimeout(timer); done(null); });
        child.on("close", (code) => { clearTimeout(timer); done(code === 0 ? parseOpencodeSessionId(out) : null); });
      } catch { done(null); }
    });
  }

  /**
   * Read back the conversation id OpenCode / Antigravity chose, so resume targets exactly this conversation.
   * `final` (sleep/exit/restart check) skips the backoff. Never persists an id another agy row of this user already holds:
   * when it cannot tell, it stores nothing and the next start is a fresh conversation.
   */
  private async captureCliId(id: string, handle: ShardHandle, final = false): Promise<boolean> {
    const probe = this.cliProbes.get(id);
    if (!probe || probe.inFlight) return false;
    if (!final && Date.now() < probe.nextAt) return false;
    probe.inFlight = true;
    try {
      const found = probe.provider === "opencode"
        ? await this.probeOpencodeId(handle, probe, final ? 5_000 : 15_000)
        : ((value) => (value && value !== probe.baseline ? value : null))(this.readAntigravityId(handle, probe.cwds));
      if (!found) {
        probe.misses += 1;
        // An idle OpenCode (no message yet) has no session: back off 10 s -> 60 s instead of spawning the binary forever.
        if (probe.provider === "opencode") probe.nextAt = Date.now() + Math.min(60_000, 10_000 * 2 ** Math.min(probe.misses, 3));
        return false;
      }
      if (probe.provider === "antigravity") {
        const held = await this.pool.query("SELECT 1 FROM agent_sessions WHERE user_id = $1 AND provider = 'antigravity' AND provider_session_id = $2 AND id <> $3 LIMIT 1", [probe.userId, found, id]);
        if (held.rows.length > 0) return false; // another agent's conversation (the cache holds one id per cwd): keep waiting for our own
      }
      const claimed = await this.pool.query("UPDATE agent_sessions SET provider_session_id = $2 WHERE id = $1 AND provider_session_id IS NULL RETURNING 1", [id, found]);
      if (claimed.rows.length) await recordConversation(this.pool, id, probe.provider, found).catch(() => undefined);
      if (probe.provider === "antigravity") this.agyMirror?.setRoot(id, found);
      // A slow probe of an older launch must not tear down the probe or gate of a newer one.
      if (this.cliProbes.get(id) === probe) {
        this.cliProbes.delete(id);
        this.releaseAgyGate(id);
      }
      return true;
    } finally {
      probe.inFlight = false;
    }
  }

  /** Read the uuid Codex assigned (from its rollout filename) so resume targets exactly this conversation. */
  private async captureCodexId(id: string, handle: ShardHandle, final = false): Promise<boolean> {
    if (this.cliProbes.has(id)) return this.captureCliId(id, handle, final);
    const found = findRollout(this.hostHome(handle), this.shards.driver.hostPath(handle, codexHomeRel(id) + "/sessions"));
    if (!found) return false;
    await this.pool.query("UPDATE agent_sessions SET provider_session_id = $2 WHERE id = $1", [id, found]);
    await recordConversation(this.pool, id, "codex", found).catch(() => undefined);
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
        ? readClaudeNativeTitle(this.hostHome(state.handle), state.providerSessionId ?? id)
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
    }, CLI_ID_POLL_MS[this.cliProbes.get(id)?.provider ?? ""] ?? CODEX_ID_POLL_MS);
    timer.unref();
    this.codexPollers.set(id, timer);
  }

  private stopCodexPoll(id: string): void {
    const timer = this.codexPollers.get(id);
    if (timer) clearInterval(timer);
    this.codexPollers.delete(id);
  }

  /** Provider-side checkpoint restore hook (A.2 not-found). Wired by the checkpoint feature; false = nothing restored. */
  /** Copy the last-good checkpoint back where the provider reads it (only when the live transcript is missing or shorter). */
  async restoreFromCheckpoint(handle: ShardHandle, sessionId: string, provider: ProviderId, providerSessionId: string): Promise<boolean> {
    if (provider !== "claude" && provider !== "codex") return false; // OpenCode exports and agy dirs are not files the CLI reads back
    const restored = restoreCheckpointFile({ home: this.hostHome(handle), uid: handle.uid }, sessionId, provider, providerSessionId);
    if (restored) log.info("session.checkpoint_restored", { sessionId, provider });
    return restored;
  }

  private notifyUser(userId: string, n: { sessionId: string; projectId: string | null; title: string; body: string }): void {
    for (const cb of this.userNoticeListeners) {
      try { cb(userId, n); } catch (error) { log.warn("session.notice_listener_failed", { error: String(error).slice(0, 120) }); }
    }
  }

  /** Register a callback for user-facing notices raised by the manager (resume failures). */
  onUserNotice(cb: (userId: string, n: { sessionId: string; projectId: string | null; title: string; body: string }) => void): void {
    this.userNoticeListeners.push(cb);
  }

  /** Claude only: copy a transcript found under another project folder into the folder Claude will look in for this cwd. */
  private relocateClaudeTranscript(handle: ShardHandle, row: Row): boolean {
    const home = this.hostHome(handle);
    const convId = resolveClaudeConversationId(row);
    const found = claudeTranscriptPath(home, convId);
    if (!found) return false;
    const dest = join(home, ".claude", "projects", claudeProjectSlug(row.cwd), convId + ".jsonl");
    if (resolve(dest) === resolve(found)) return false; // already where Claude looks: it really cannot read it
    try {
      mkdirOwned(handle.mountPath, dirname(dest), handle.uid);
      writeFileOwned(handle.mountPath, dest, readFileSync(found), handle.uid, 0o600);
      return true;
    } catch (error) {
      log.warn("session.transcript_relocate_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      return false;
    }
  }

  private async giveUpResume(session: Session, kind: ResumeExitKind, projectId: string | null): Promise<void> {
    this.resumeRetries.delete(session.id);
    await this.pool.query(
      "UPDATE agent_sessions SET state = 'failed', sleep_reason = $2, last_seq = $3, last_active_at = now(), slept_at = now() WHERE id = $1 AND state = 'running'",
      [session.id, RESUME_FAILED_REASON, session.toSummary().seq],
    );
    this.notifyUser(session.userId, {
      sessionId: session.id,
      projectId,
      title: RESUME_FAILED_TITLE,
      body: kind === "not_found"
        ? "The provider could not find this conversation. It was not replaced; use Retry, switch to another conversation, or Start fresh."
        : "The agent could not be resumed after several tries. The conversation is untouched; use Retry or Start fresh.",
    });
  }

  /** A resume exited within RESUME_FALLBACK_MS. Keep the pointer; retry transient causes; never start a fresh conversation. */
  private async recoverFailedResume(session: Session, profile: RuntimeProfile): Promise<void> {
    const output = session.replaySince(0).chunks.map((c) => c.data).join("").slice(-8192);
    const kind = classifyResumeExit(output);
    const attempt = this.resumeRetries.get(session.id) ?? 0;
    log.info("session.resume_classified", { sessionId: session.id, provider: session.provider, kind, attempt });
    let row = await this.row(session.id, session.userId);
    if (kind === "not_found") {
      let restored = false;
      if (attempt < 1) {
        const providerId = row.provider === "claude" ? resolveClaudeConversationId(row) : row.provider_session_id;
        if (providerId) {
          try {
            const handle = await this.shards.wake(session.userId);
            restored = row.provider === "claude" && this.relocateClaudeTranscript(handle, row);
            if (!restored) restored = await this.restoreFromCheckpoint(handle, row.id, row.provider, providerId);
          } catch (error) { log.warn("session.resume_restore_failed", { sessionId: session.id, error: String(error).slice(0, 160) }); }
        }
      }
      if (!restored) return this.giveUpResume(session, kind, row.project_id);
      this.resumeRetries.set(session.id, attempt + 1);
      log.info("session.resume_restored", { sessionId: session.id, provider: row.provider });
    } else {
      const delay = resumeRetryDelay(attempt);
      if (delay === null) return this.giveUpResume(session, kind, row.project_id);
      this.resumeRetries.set(session.id, attempt + 1);
      await new Promise((r) => { const t = setTimeout(r, delay); t.unref(); });
    }
    if (this.shuttingDown || this.live.has(session.id)) return; // the user (or shutdown) got there first
    try {
      row = await this.row(session.id, session.userId);
      const handle = await this.shards.wake(session.userId); // includes the mount liveness check; launch() refreshes credentials
      const fresh = await this.launch({ ...row, resume_count: session.resumeCount - 1 }, profile, handle, true);
      fresh.broadcast({ type: "state", session: fresh.toSummary() });
    } catch (error) {
      log.warn("session.resume_retry_failed", { sessionId: session.id, attempt, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      if (this.shuttingDown) return;
      const next = resumeRetryDelay(attempt + 1);
      if (next === null) return this.giveUpResume(session, "transient", row.project_id);
      this.resumeRetries.set(session.id, attempt + 1);
      return this.recoverFailedResume(session, profile);
    }
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
    this.agyMirror?.stop(session.id);
    if (this.intentionalSleep.delete(session.id)) {
      this.nativeTitleSessions.delete(session.id);
      if (this.stoppingSessions.get(session.id) === session) this.stoppingSessions.delete(session.id);
      return;
    }
    if (session.provider === "codex" || this.cliProbes.has(session.id)) await this.captureCodexId(session.id, handle, true).catch(() => false);
    this.cliProbes.delete(session.id);
    this.releaseAgyGate(session.id);
    await this.updateNativeTitle(session.id, true);
    this.nativeTitleSessions.delete(session.id);

    if (resumeFailedFast && state === "failed") {
      // Never guess "conversation gone" from elapsed time: the pointer is kept and the exit is classified from its output.
      this.live.delete(session.id);
      void this.recoverFailedResume(session, profile).catch((error) => log.error("session.resume_recovery_failed", { sessionId: session.id, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
      return;
    }
    this.resumeRetries.delete(session.id);

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
    await this.assertProviderConnected(userId, input.provider);
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
      const projectResult = options.orgId
        ? await this.pool.query("SELECT * FROM floq_projects WHERE id=$1 AND user_id=$2 AND organization_id=$3", [input.projectId, userId, options.orgId])
        : await this.pool.query("SELECT * FROM floq_projects WHERE id=$1 AND user_id=$2", [input.projectId, userId]);
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
      const project = await this.createProject(userId, profile, input.gitUrl, undefined, options.orgId);
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
    if (input.provider === "claude") await recordConversation(this.pool, id, "claude", id).catch(() => undefined);
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
  async resume(userId: string, profile: RuntimeProfile, id: string, options: { strict?: boolean; boot?: boolean } = {}): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    const key = userId + ":" + id;
    const restart = this.restartTasks.get(key);
    if (restart) return restart;
    const releaseWake = !options.boot && !(this.live.get(id)?.isAlive) ? await this.subagents?.assertCanWake?.(userId, id) : undefined;
    try {
      return await coalesce(this.resumeTasks, key, () => this.resumeOnce(userId, profile, id, options.strict === true));
    } finally {
      releaseWake?.();
    }
  }

  private async resumeOnce(userId: string, profile: RuntimeProfile, id: string, strictResume = false, launchOpts: { fresh?: boolean; prompt?: string } = {}): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    const stopping = this.stoppingSessions.get(id);
    if (stopping && stopping.userId !== userId) throw notFound("Session " + id + " not found");
    if (stopping && !stopping.hasExited) throw unavailable("The previous process is still stopping; try resuming again after it exits.", "session_stopping");
    if (stopping) this.stoppingSessions.delete(id);
    const existing = this.live.get(id);
    if (existing && existing.userId === userId && existing.isAlive) return existing.toSummary();

    const row = await this.row(id, userId);
    // A session whose provider was logged out since it slept must fail clearly instead of running unauthenticated.
    await this.assertProviderConnected(userId, row.provider as ProviderId);
    if (row.workspace_id) {
      const gone = await this.pool.query("SELECT 1 FROM floq_project_workspaces WHERE id=$1 AND user_id=$2 AND is_worktree=TRUE AND available=FALSE", [row.workspace_id, userId]);
      if (gone.rows[0]) throw conflict("This agent's worktree was deleted or removed, so it cannot be resumed. You can still delete the conversation.", "worktree_deleted");
    }
    const releaseCapacity = this.capacityReservations.reserve(userId, this.activeCountFor(userId), this.config.maxSessions);
    if (!releaseCapacity) throw tooMany("Session limit reached (" + this.config.maxSessions + ")");
    try {
      const handle = await this.shards.wake(userId);
      this.assertLifecycleOpen();
      const session = await this.launch(row, profile, handle, launchOpts.fresh !== true, launchOpts.prompt, strictResume);
      log.info("session.resume", { sessionId: id, userId, count: session.resumeCount });
      return session.toSummary();
    } finally {
      releaseCapacity();
    }
  }

  /**
   * Usage-limit fallback: move an agent to another provider IN PLACE (same row, UUID, canvas node, wires, inbox). The old
   * process is stopped first (strict), then the new provider starts: `prompt` is the first message of a fresh conversation,
   * `notice` is typed after a resumed one is ready. Claude conversations resume by the row id; Codex ones by provider_session_id.
   */
  async switchProvider(userId: string, profile: RuntimeProfile, id: string, to: { provider: "claude" | "codex"; model: string | null; prompt?: string; notice?: string }): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    // Refuse before the old process is stopped: never leave an agent parked on a provider the user is not logged in to.
    await this.assertProviderConnected(userId, to.provider);
    return coalesce(this.restartTasks, userId + ":" + id, async () => {
      const row = await this.row(id, userId);
      if (row.provider !== "claude" && row.provider !== "codex") throw badRequest("Only Claude and Codex agents can switch provider", "invalid_provider");
      let stopped = false;
      try {
        await this.sleepSession(id, "usage-fallback", { waitForExit: true });
        stopped = true;
        await this.pool.query("UPDATE agent_sessions SET provider = $3, model = $4 WHERE id = $1 AND user_id = $2", [id, userId, to.provider, to.model]);
        if (row.provider !== to.provider) {
          const old = row.provider === "claude" ? resolveClaudeConversationId(row) : row.provider_session_id;
          if (old) await endConversation(this.pool, id, row.provider, old, "provider_switch").catch(() => undefined);
        }
        if (to.notice) this.queueBootNotice(id, to.notice);
        // A Codex conversation that already exists resumes; without one (or when starting Codex the first time) it is a fresh start with the prompt.
        const resumeCodex = to.provider === "codex" && Boolean((await this.row(id, userId)).provider_session_id);
        return await this.resumeOnce(userId, profile, id, true, { fresh: to.provider === "codex" && !resumeCodex, prompt: to.prompt });
      } catch (error) {
        this.dropBootNotice(id);
        // The row keeps the provider it had. It is only marked failed when the old process is really gone and the new one did not start;
        // if the old process could not be stopped, sleepSession already left the row sleeping and the process is still tracked.
        if (stopped) await this.pool.query("UPDATE agent_sessions SET provider = $3, model = $4, state = 'failed', sleep_reason = 'fallback-switch-failed', slept_at = now() WHERE id = $1 AND user_id = $2 AND state IN ('running','sleeping')", [id, userId, row.provider, row.model]).catch(() => undefined);
        throw error;
      } finally {
        this.intentionalSleep.delete(id);
      }
    });
  }

  /** The agent's conversation history (every provider pointer it has had), newest first. */
  async conversations(id: string, userId: string): Promise<ConversationRow[]> {
    await this.row(id, userId);
    return listConversations(this.pool, id);
  }

  private async stopForConversationChange(id: string, userId: string): Promise<void> {
    const live = this.live.get(id);
    if (live && live.userId === userId && live.isAlive) await this.sleepSession(id, "conversation-change", { waitForExit: true });
    this.resumeRetries.delete(id);
  }

  /**
   * Explicit, reversible "Start fresh": the current conversation stays in the history (ended_reason fresh_start) and can be
   * switched back to. Claude starts under a NEW id (never the old one, which would collide with "already in use").
   */
  async startFresh(userId: string, profile: RuntimeProfile, id: string, options: { summary?: boolean } = {}): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    return coalesce(this.restartTasks, userId + ":" + id, async () => {
      if ((await this.row(id, userId)).provider === "shell") throw badRequest("Shell sessions have no conversation", "invalid_provider");
      await this.stopForConversationChange(id, userId);
      const row = await this.row(id, userId); // after the stop: a Codex/OpenCode id may only have been captured while stopping
      try {
        const current = row.provider === "claude" ? resolveClaudeConversationId(row) : row.provider_session_id;
        // Built before any pointer changes, so a missing transcript leaves the agent exactly as it was.
        let prompt: string | undefined;
        if (options.summary && (row.provider === "claude" || row.provider === "codex")) {
          prompt = (await this.buildSummaryPrompt(userId, row, current)) ?? undefined;
          if (!prompt) throw conflict("Nothing to summarize: neither the transcript nor a checkpoint of this conversation could be read.", "no_summary_available");
        }
        const plan = planFreshStart(row.provider, current);
        if (plan.endCurrent) await endConversation(this.pool, id, plan.endCurrent.provider, plan.endCurrent.providerSessionId, plan.endCurrent.reason);
        if (plan.newClaudeId) await recordConversation(this.pool, id, "claude", plan.newClaudeId);
        else await this.pool.query("UPDATE agent_sessions SET provider_session_id = NULL WHERE id = $1 AND user_id = $2", [id, userId]);
        log.info("session.fresh_start", { sessionId: id, provider: row.provider, summary: prompt !== undefined });
        return await this.resumeOnce(userId, profile, id, true, { fresh: true, prompt });
      } finally {
        this.intentionalSleep.delete(id);
      }
    });
  }

  /**
   * Deterministic handoff prompt for "Start fresh with summary": from the live transcript when it is still readable, otherwise from the
   * last-good checkpoint. Null when neither gives anything. No model call.
   */
  private async buildSummaryPrompt(userId: string, row: Row, providerId: string | null): Promise<string | null> {
    if ((row.provider !== "claude" && row.provider !== "codex") || !providerId) return null;
    const handle = await this.shards.wake(userId);
    const home = this.hostHome(handle);
    const confine = { home, uid: handle.uid };
    let texts: { head: string; tail: string } | null = null;
    try {
      const path = row.provider === "claude"
        ? claudeTranscriptPath(home, providerId)
        : findCodexRolloutPath(home, this.shards.driver.hostPath(handle, codexHomeRel(row.id) + "/sessions"), handle.uid);
      if (path) {
        const tail = readTranscriptTail(path, 1024 * 1024, confine);
        if (tail && tail.text.trim()) texts = { head: readTranscriptHead(path, 256 * 1024, confine) ?? "", tail: tail.text };
      }
    } catch (error) { log.warn("session.summary_live_read_failed", { sessionId: row.id, error: String(error).slice(0, 120) }); }
    if (!texts) texts = readCheckpointText({ home, uid: handle.uid }, row.id, row.provider, providerId);
    if (!texts) return null;
    return buildResumeSummary({ provider: row.provider, tailText: texts.tail, headText: texts.head, cwd: row.cwd });
  }

  /** Make an earlier conversation of this agent current again and resume it. */
  async switchConversation(userId: string, profile: RuntimeProfile, id: string, conversationId: string): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    return coalesce(this.restartTasks, userId + ":" + id, async () => {
      const row = await this.row(id, userId);
      const target = (await listConversations(this.pool, id)).find((c) => c.id === conversationId);
      if (!target) throw notFound("Conversation not found");
      if (!canSwitchTo(row.provider, target)) throw badRequest("That conversation belongs to another provider", "invalid_conversation");
      await this.stopForConversationChange(id, userId);
      try {
        await this.pool.query("UPDATE agent_conversations SET ended_reason = 'switched' WHERE session_id = $1 AND provider = $2 AND ended_reason IS NULL AND id <> $3", [id, target.provider, conversationId]);
        await this.pool.query("UPDATE agent_conversations SET ended_reason = NULL WHERE id = $1 AND session_id = $2", [conversationId, id]);
        if (row.provider !== "claude") await this.pool.query("UPDATE agent_sessions SET provider_session_id = $3 WHERE id = $1 AND user_id = $2", [id, userId, target.providerSessionId]);
        log.info("session.conversation_switched", { sessionId: id, provider: row.provider });
        return await this.resumeOnce(userId, profile, id, true);
      } finally {
        this.intentionalSleep.delete(id);
      }
    });
  }

  /** First bytes of a live Claude agent's transcript (the original task is there); null when unavailable. */
  readTranscriptHeadText(id: string, userId: string, maxBytes: number): string | null {
    const state = this.nativeTitleSessions.get(id);
    if (!state || state.userId !== userId || state.provider !== "claude") return null;
    const path = claudeTranscriptPath(this.hostHome(state.handle), state.providerSessionId ?? id);
    return path ? readTranscriptHead(path, maxBytes, { home: this.hostHome(state.handle), uid: state.handle.uid }) : null;
  }

  /** Sandbox path of a live Claude agent's transcript (given to the Codex agent in the handoff). */
  transcriptSandboxPath(id: string, userId: string): string | null {
    const state = this.nativeTitleSessions.get(id);
    if (!state || state.userId !== userId || state.provider !== "claude") return null;
    const path = claudeTranscriptPath(this.hostHome(state.handle), state.providerSessionId ?? id);
    if (!path) return null;
    const home = realpathSync(this.hostHome(state.handle));
    const rel = relative(home, realpathSync(path));
    return rel.startsWith("..") ? null : this.shards.driver.homePath(state.handle) + "/" + rel;
  }

  /**
   * Write a handoff file as the user's uid, mode 0600, under ~/.floq/handoff (files older than 7 days are pruned on every write).
   * Returns the path as the sandbox sees it.
   */
  async writeHandoffFile(userId: string, name: string, content: string): Promise<string> {
    if (!/^[\w-]{1,80}\.md$/.test(name)) throw badRequest("invalid handoff name");
    const handle = await this.shards.wake(userId);
    const dir = this.shards.driver.hostPath(handle, ".floq/handoff");
    mkdirOwned(handle.mountPath, dir, handle.uid);
    try { pruneHomeFiles(handle.mountPath, dir, 7 * 86_400_000); } catch { /* first write, or an unsafe dir: the write below refuses it */ }
    writeFileOwned(handle.mountPath, join(dir, name), content, handle.uid, 0o600);
    return this.shards.driver.homePath(handle) + "/.floq/handoff/" + name;
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
    if ((session.provider === "opencode" || session.provider === "antigravity") && !row.provider_session_id) {
      const probe = this.cliProbes.get(id);
      const handle = probe ? await this.shards.wake(userId) : null;
      const captured = handle ? await this.captureCliId(id, handle, true).catch(() => false) : false;
      if (!captured) throw conflict("This agent has not saved a resumable conversation yet. Wait a moment and try again.", "restart_not_ready");
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

  /**
   * After a user's gocryptfs mount died and was remounted: every live sandbox of that user still points at the dead mount,
   * so restart each agent through the same sleep -> strict resume path as restartSelf (same conversation id) and queue a
   * notice telling it to re-check state. Shells and agents without a saved conversation are skipped, not restarted fresh.
   * Never throws per session; at most 3 restart at a time so the CPU is not saturated.
   */
  async restartLiveSessionsForUser(userId: string, profile: RuntimeProfile, notice: string): Promise<{ restarted: number; skipped: number; failed: number }> {
    const report = { restarted: 0, skipped: 0, failed: 0 };
    const targets = [...this.live.values()].filter((s) => s.userId === userId && s.isAlive && !this.logins.has(s.id));
    const queue = targets.filter((s) => {
      if (s.provider === "shell") { report.skipped++; return false; }
      return true;
    });
    const worker = async () => {
      for (let session = queue.shift(); session; session = queue.shift()) {
        const id = session.id;
        try {
          await this.assertSelfRestartable(userId, id);
        } catch (error) {
          report.skipped++;
          log.warn("session.mount_restart_skipped", { sessionId: id, userId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
          continue;
        }
        this.queueBootNotice(id, notice);
        try {
          await this.restartSelf(userId, profile, id);
          report.restarted++;
        } catch (error) {
          this.dropBootNotice(id);
          report.failed++;
          log.error("session.mount_restart_failed", { sessionId: id, userId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, worker));
    return report;
  }

  isLogin(id: string): boolean {
    return this.logins.has(id);
  }

  /** Refuse to start (or switch to) a provider the user is not logged in to. See providerGuard.ts for the per-provider rules. */
  async assertProviderConnected(userId: string, provider: ProviderId): Promise<void> {
    await assertProviderConnected(this.providerGuardDeps(), userId, provider);
  }

  /** Non-throwing form of assertProviderConnected (fallback planning, pickers). */
  providerConnected(userId: string, provider: ProviderId): Promise<boolean> {
    return providerConnected(this.providerGuardDeps(), userId, provider);
  }

  private providerGuardDeps(): ProviderGuardDeps {
    return {
      config: this.config,
      credential: (userId, provider) => this.credentials.get(userId, provider),
      antigravityLogin: (userId) => this.antigravityConnected(userId),
      vaultEnvNames: async (userId) => new Set((await this.vault.list(userId)).filter((secret) => secret.expose === "env").map((secret) => secret.name)),
    };
  }

  private async freshCredential(userId: string, provider: OAuthProvider): Promise<CredentialData | null> {
    await this.credentials.refresh(userId, provider);
    return this.credentials.get(userId, provider);
  }

  private writeCredFile(handle: ShardHandle, path: string, content: string): void {
    mkdirOwned(handle.mountPath, dirname(path), handle.uid);
    writeFileOwned(handle.mountPath, path, content, handle.uid, 0o600);
    this.credMtime.set(path, lstatHome(handle.mountPath, path)?.mtimeMs ?? 0);
  }

  /**
   * Read a file inside the agent's home without following planted symlinks or blocking on a FIFO (see readHomeFile). A missing
   * or poisoned file reads as null ("nothing there"), so it is never adopted or distributed.
   */
  private readHome(handle: ShardHandle, path: string): { text: string; mtimeMs: number } | null {
    try {
      return readHomeFile(handle.mountPath, path, handle.uid);
    } catch (error) {
      if (error instanceof UnsafeHomePathError) {
        log.warn("home.read_refused", { userId: handle.userId, file: relative(handle.mountPath, path), reason: error.message });
        return null;
      }
      throw error;
    }
  }

  private readHomeJson(handle: ShardHandle, path: string): { value: Record<string, unknown>; mtimeMs: number } | null {
    let file;
    try { file = this.readHome(handle, path); } catch { return null; }
    if (!file) return null;
    try {
      const value = JSON.parse(file.text) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? { value: value as Record<string, unknown>, mtimeMs: file.mtimeMs } : null;
    } catch { return null; }
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
      const exists = lstatHome(handle.mountPath, target) !== null;
      const sessionRaw = exists ? SkillsService.readSafeConfig(target, root) : null;
      if (exists && sessionRaw === null) return; // unreadable or unsafe: do not replace it
      const merged = mergeGlobalCodexMcp(globalRaw, sessionRaw);
      if (merged === null) return;
      writeFileOwned(handle.mountPath, target, merged, handle.uid, 0o600);
    } catch (error) {
      log.warn("codex.mcp_sync_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }

  private codexAuthPath(handle: ShardHandle, sessionId: string): string {
    return this.shards.driver.hostPath(handle, codexHomeRel(sessionId) + "/auth.json");
  }

  private writeClaude(handle: ShardHandle, data: CredentialData): void {
    const path = this.claudeCredPath(handle);
    const existing = this.readHomeJson(handle, path)?.value ?? {}; // first write, or a poisoned file: start clean
    this.writeCredFile(handle, path, JSON.stringify({ ...existing, claudeAiOauth: data }));
  }

  /** Replace Claude Code's own commit/PR attribution with Floq's, keeping the user's other settings. */
  private enforceClaudeSettings(handle: ShardHandle, profile: RuntimeProfile): void {
    const path = this.shards.driver.hostPath(handle, ".claude/settings.json");
    let settings: Record<string, unknown> = this.readHomeJson(handle, path)?.value ?? {};
    settings.attribution = { commit: "", pr: profile.gitCoauthor ? FLOQ_PR_ATTRIBUTION : "" };
    settings.includeCoAuthoredBy = false;
    settings = claudeStartupSettings(settings, profile.claudeAutoApprove, { ttl: this.config.cacheTtl, helperTtl: this.config.cacheHelperTtl });
    mkdirOwned(handle.mountPath, dirname(path), handle.uid);
    writeFileOwned(handle.mountPath, path, JSON.stringify(settings, null, 2), handle.uid, 0o644);
  }

  /**
   * Adopt a credential the CLI rotated in the user's sandbox file right now (used before an account switch, so the outgoing
   * account's rotated refresh token is stored with it). Same attribution rules as syncBack; failures are not fatal.
   */
  async syncClaudeNow(userId: string): Promise<void> {
    if (!this.shards.isAwake(userId)) return;
    const handle = await this.shards.wake(userId);
    const path = this.claudeCredPath(handle);
    const file = this.readHomeJson(handle, path);
    if (!file) return;
    const data: unknown = file.value.claudeAiOauth;
    this.credMtime.set(path, file.mtimeMs);
    if (!validCredential("claude", data)) return;
    if (this.accounts) {
      const where = await this.accounts.adoptAttributed(userId, data).catch(() => "retry" as const);
      if (where === "retry") { this.credMtime.delete(path); return; }
      if (where === "reserve" || where === "unmatched") return;
    }
    await this.credentials.adopt(userId, "claude", data);
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
      const file = this.readHomeJson(handle, path);
      if (!file) continue;
      if (this.credMtime.get(path) === file.mtimeMs) continue;
      this.credMtime.set(path, file.mtimeMs);
      const data: unknown = s.provider === "claude" ? file.value.claudeAiOauth : file.value;
      // Several Claude logins: only adopt a rewritten file into the account it belongs to (profile account uuid).
      if (s.provider === "claude" && this.accounts && validCredential("claude", data)) {
        const where = await this.accounts.adoptAttributed(s.userId, data).catch(() => "retry" as const);
        // "retry": the account could not be identified just now. Look at this file again next time instead of dropping its rotated token.
        if (where === "retry") { this.credMtime.delete(path); continue; }
        if (where === "reserve" || where === "unmatched") continue;
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
    if (provider !== "claude" && provider !== "codex" && provider !== "antigravity") throw badRequest("provider must be claude, codex or antigravity", "invalid_provider");
    const key = userId + ":" + provider;
    return coalesce(this.loginTasks, key, () => this.startLoginOnce(userId, provider, profile));
  }

  private async startLoginOnce(userId: string, provider: ProviderId, profile: RuntimeProfile): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    if (provider !== "claude" && provider !== "codex" && provider !== "antigravity") throw badRequest("provider must be claude, codex or antigravity", "invalid_provider");
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
    if (provider !== "antigravity") mkdirOwned(handle.mountPath, dir, handle.uid);
    const home = this.shards.driver.homePath(handle);
    let args: string[];
    if (provider === "antigravity") {
      // agy keeps its token under the real ~/.gemini and refreshes it itself: log in with the real HOME, no throwaway dir.
      // The sandbox has no D-Bus session, so agy stores the token in a file. Make sure nothing can send it to a keyring.
      // Limitation: the non-bwrap local driver shares the host /run/user/<uid>/bus, which agy probes even without DBUS_* env, so there
      // the token may go to the host keyring and the login is never detected. The bwrap (linux) driver mounts a tmpfs /run.
      for (const name of Object.keys(env)) if (name.startsWith("DBUS_") || name === "GEMINI_API_KEY") delete env[name];
      try { mkdirOwned(handle.mountPath, this.shards.driver.hostPath(handle, ".gemini/antigravity-cli"), handle.uid); } catch { /* agy creates it */ }
      args = ["acp", "--login"];
    } else if (provider === "claude") {
      env.CLAUDE_CONFIG_DIR = home + "/" + rel;
      args = ["auth", "login"];
    } else {
      env.CODEX_HOME = home + "/" + rel;
      args = ["login", "--device-auth"];
    }
    // Where the CLI may leave its credential: the throwaway config dir (CLAUDE_CONFIG_DIR / CODEX_HOME), or,
    // if it ignores that, the user's real config dir. The latter only counts if written after this login began.
    const name = provider === "claude" ? ".credentials.json" : "auth.json";
    const candidates = provider === "antigravity" ? [{ path: this.shards.driver.hostPath(handle, AGY_TOKEN_REL), fresh: true }] : [
      { path: join(dir, name), fresh: false },
      ...(provider === "claude" ? [{ path: join(dir, ".claude", name), fresh: false }] : []),
      { path: this.shards.driver.hostPath(handle, (provider === "claude" ? ".claude/" : ".codex/") + name), fresh: true },
    ];
    let pty;
    try {
      pty = this.shards.driver.spawn(handle, { file: definition.bin, args, env, cwd: "", cols: LOGIN_COLS, rows: 40 });
    } catch (error) {
      try { removeHomeTree(handle.mountPath, dir); } catch { /* best effort */ }
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

    const readAgy = (): boolean => {
      const file = this.readHome(handle, candidates[0]!.path);
      return Boolean(file && file.mtimeMs >= state.startedAt - 1000 && agyTokenValid(file.text));
    };
    // The token format is not verified: a clean exit (code 0) with a fresh, non-empty token file also counts as signed in.
    const readAgyOnExit = (code: number | null): boolean => {
      if (readAgy()) return true;
      if (code !== 0) return false;
      const file = this.readHome(handle, candidates[0]!.path);
      return Boolean(file && file.mtimeMs >= state.startedAt - 1000 && file.text.trim().length > 0);
    };
    const readCred = (): CredentialData | null => {
      if (provider === "antigravity") return null;
      for (const candidate of candidates) {
        const file = this.readHomeJson(handle, candidate.path);
        if (!file || (candidate.fresh && file.mtimeMs < state.startedAt)) continue; // not there yet, or unsafe
        const data = provider === "claude" ? file.value.claudeAiOauth : file.value;
        if (validCredential(provider, data)) return data;
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
    const finishAgy = () => {
      if (state.finishing) return;
      state.finishing = true;
      this.agyExpired.delete(userId);
      this.agyConnected.set(userId, true);
      log.info("login.connected", { userId, provider });
      // Let agy finish writing (projectID / tier) before the terminal goes away.
      state.timers.push(setTimeout(() => this.endLogin(id), 1500));
    };
    const finish = (data: CredentialData) => {
      if (provider === "antigravity") return;
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
      if (provider === "antigravity") { if (!state.finishing && readAgy()) finishAgy(); return; }
      const data = state.finishing ? null : readCred();
      if (data) finish(data);
    }, 2000);
    session.subscribe((frame) => {
      if (frame.type === "output") {
        state.tail = stripAnsi(state.tail + frame.data).slice(-2000);
        return;
      }
      if (frame.type !== "exit") return;
      if (provider === "antigravity" && !state.finishing && readAgyOnExit(frame.session.exitCode)) { finishAgy(); return; }
      const data = state.finishing ? null : readCred();
      if (data) {
        finish(data);
        return;
      }
      if (!state.finishing) {
        let present: string[] = [];
        try {
          const listed = openHomeDir(handle.mountPath, dir);
          if (listed) { try { present = readdirSync(listed.path); } finally { listed.close(); } }
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
    const awakeHome = this.shards.awakeHandle(state.userId);
    if (awakeHome) { try { removeHomeTree(awakeHome.mountPath, state.dir); } catch { /* best effort */ } }
    const session = this.live.get(id);
    this.live.delete(id);
    session?.dispose();
    this.scheduleLock(state.userId);
  }

  /**
   * True when agy has a usable Google-login token file in the user's home (agy refreshes it itself). Never wakes a shard:
   * while it sleeps this is the last known answer (refreshed on every wake, login, disconnect and agy start), false if unknown.
   * A token removed by agy's own /logout inside a session shows as connected until the next wake.
   */
  async antigravityConnected(userId: string): Promise<boolean> {
    if (this.agyExpired.has(userId)) return false;
    const handle = this.shards.awakeHandle(userId);
    if (handle) return this.antigravityTokenPresent(handle);
    return this.agyConnected.get(userId) ?? false;
  }

  /** Shard wake hook: learn the login state without a second wake. */
  noteShardAwake(userId: string): void {
    const handle = this.shards.awakeHandle(userId);
    if (handle) { try { this.antigravityTokenPresent(handle); } catch { /* best effort */ } }
  }

  private markAgyLoginLost(userId: string): void {
    this.agyExpired.add(userId);
    this.agyConnected.set(userId, false);
    log.warn("antigravity.login_lost", { userId });
  }

  private antigravityTokenPresent(handle: ShardHandle): boolean {
    const file = this.readHome(handle, this.shards.driver.hostPath(handle, AGY_TOKEN_REL));
    const ok = Boolean(file && agyTokenValid(file.text));
    this.agyConnected.set(handle.userId, ok);
    return ok;
  }

  async disconnectProvider(userId: string, provider: ProviderId): Promise<void> {
    if (provider !== "claude" && provider !== "codex" && provider !== "antigravity") throw badRequest("provider must be claude, codex or antigravity", "invalid_provider");
    for (const [id, state] of this.logins) if (state.userId === userId && state.provider === provider) this.endLogin(id);
    if (provider === "antigravity") {
      // Running agy sessions keep their in-memory token until they restart.
      const handle = await this.shards.wake(userId);
      this.removeHome(handle, this.shards.driver.hostPath(handle, AGY_TOKEN_REL));
      this.removeHome(handle, this.shards.driver.hostPath(handle, AGY_SCOPE_REL));
      this.agyConnected.set(userId, false);
      this.agyExpired.delete(userId);
      this.scheduleLock(userId);
      return;
    }
    await this.credentials.remove(userId, provider);
    if (provider === "claude") await this.accounts?.reset(userId);
    if (provider === "codex") this.invalidateCodexModels(userId);
    const handle = await this.shards.wake(userId);
    if (provider === "claude") {
      this.removeHome(handle, this.claudeCredPath(handle));
    } else {
      this.removeHome(handle, this.shards.driver.hostPath(handle, ".codex/auth.json"));
      for (const session of this.live.values()) {
        if (session.userId === userId && session.provider === "codex") this.removeHome(handle, this.codexAuthPath(handle, session.id));
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
    if (session.provider === "codex" || this.cliProbes.has(id)) {
      const handle = await this.shards.wake(session.userId);
      await this.captureCodexId(id, handle, true).catch(() => false);
    }
    await this.checkpoints.flush(id).catch(() => undefined);
    this.checkpoints.forget(id);
    this.checkpointStamps.delete(id);
    this.cliProbes.delete(id);
    this.releaseAgyGate(id);
    this.agyMirror?.stop(id);
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
    await this.browser?.stop(userId, "sleep").catch(() => undefined);
    await this.shards.sleep(userId);
  }

  private secretDir(handle: ShardHandle, sessionId: string): string {
    return this.shards.driver.hostPath(handle, ".floq/secrets/" + sessionId);
  }

  /** Replace <home>/.floq/secrets/<sessionId>/ with exactly these secrets (dir 0700, files 0400, owned by the shard uid). */
  private syncSecretFiles(handle: ShardHandle, sessionId: string, secrets: Record<string, string>): void {
    const dir = this.secretDir(handle, sessionId);
    removeHomeTree(handle.mountPath, dir);
    if (!Object.keys(secrets).length) return;
    mkdirOwned(handle.mountPath, dir, handle.uid);
    chmodHomeDir(handle.mountPath, dir, 0o700);
    for (const [name, value] of Object.entries(secrets)) this.writeSecretFile(handle, sessionId, name, value);
  }

  private writeSecretFile(handle: ShardHandle, sessionId: string, name: string, value: string | null): void {
    const dir = this.secretDir(handle, sessionId);
    const path = join(dir, name);
    removeHomeTree(handle.mountPath, path);
    if (value === null) return;
    mkdirOwned(handle.mountPath, dir, handle.uid);
    chmodHomeDir(handle.mountPath, dir, 0o700);
    // Fresh O_EXCL temp file inside the pinned directory, renamed into place: the agent cannot make root chmod/chown a link target.
    writeFileOwned(handle.mountPath, path, value, handle.uid, 0o400);
  }

  /** Remove one file or tree inside the agent's home (links are unlinked, never followed); an unsafe path is left alone. */
  private removeHome(handle: ShardHandle, path: string): void {
    try { removeHomeTree(handle.mountPath, path); } catch (error) {
      if (!(error instanceof UnsafeHomePathError)) throw error;
      log.warn("home.remove_refused", { userId: handle.userId, file: relative(handle.mountPath, path) });
    }
  }

  /** Tell a running agent its wires changed (typed like `floq ask`). Returns false when it is not live. Never throws. */
  async notifyWired(userId: string, sessionId: string, added: WireRef[], removed: WireRef[], block: string, updated: WireRef[] = []): Promise<boolean> {
    const live = this.findLive(sessionId, userId);
    if (!live || !live.isAlive || live.provider === "shell") return false;
    const text = buildWiredNotice(added, removed, block, updated);
    if (!text) return false;
    try {
      await serialPerTarget(sessionId, () => typeMessage((d) => live.write(d), text, { bracketed: bracketedProvider(live.provider) }));
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
    if (awake) { try { removeHomeTree(awake.mountPath, this.secretDir(awake, id)); } catch { /* best effort */ } }
    this.agyMirror?.forget(id);
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
      if (!busy) void (this.browser?.stop(userId, "sleep").catch(() => undefined) ?? Promise.resolve()).then(() => this.shards.sleep(userId)).catch((error) => {
        log.error("shard.lock_failed", { userId, error: String(error) });
        // The home is still unlocked: try again after the next delay instead of leaving it open until the next activity.
        if (this.shards.isAwake(userId) && !this.hasActiveProcess(userId)) this.scheduleLock(userId);
      });
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
    // Usage-limit fallback safety net: the CLI can write its limit record without any later terminal output, so look at every live Claude agent now and then (cheap: a stat unless the transcript changed).
    this.fallback?.sweep?.([...this.live.values()].filter((s) => s.isAlive && s.provider === "claude" && !this.logins.has(s.id)).map((s) => ({ id: s.id, userId: s.userId })));
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
          await serialPerTarget(session.id, () => typeMessage((d) => session.write(d), notice, { bracketed: bracketedProvider(session.provider), trusted: true }));
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
    const rows = found.rows as Array<{ id: string; user_id: string; provider: ProviderId; interrupted_turn: boolean; project_gone: boolean; project_id: string | null }>;
    // Flags on rows that are not sleeping any more (a user resumed them first, or they exited) are stale.
    await this.pool.query("UPDATE agent_sessions SET resume_on_boot = FALSE, interrupted_turn = FALSE WHERE resume_on_boot = TRUE AND state <> 'sleeping'").catch(() => undefined);
    const queue = [...rows];
    const pending = this.bootRetryTimers;
    const attempts = new Map<string, number>();
    const settle = async (row: (typeof rows)[number], reason: string, error?: unknown) => {
      log.warn("session.boot_resume_skipped", { sessionId: row.id, userId: row.user_id, reason, error: error instanceof Error ? error.message.slice(0, 160) : undefined });
      await this.pool.query("UPDATE agent_sessions SET resume_on_boot = FALSE, interrupted_turn = FALSE WHERE id = $1", [row.id]).catch(() => undefined);
    };
    // Returns true when resumed. A transient failure re-queues at 30 s and 120 s (resume_on_boot stays set) before giving up.
    const attemptResume = async (row: (typeof rows)[number]): Promise<boolean> => {
      if (this.shuttingDown) return false;
      if (row.project_gone) { result.skipped++; await settle(row, "project_deleted"); return false; }
      if (this.live.has(row.id)) { result.skipped++; await settle(row, "already_running"); return false; }
      const bootNotices = (this.bootNotices ??= new Map());
      if (row.interrupted_turn && row.provider !== "shell") bootNotices.set(row.id, BOOT_RESUME_NOTICE);
      try {
        const profile = await profileFor(row.user_id);
        await this.resume(row.user_id, profile, row.id, { boot: true });
        result.resumed++;
        log.info("session.boot_resumed", { sessionId: row.id, userId: row.user_id, interrupted: row.interrupted_turn });
        return true;
      } catch (error) {
        bootNotices.delete(row.id);
        const n = attempts.get(row.id) ?? 0;
        const delay = isTransientBootError(error) ? bootRetryDelay(n) : null;
        if (delay !== null && !this.shuttingDown) {
          attempts.set(row.id, n + 1);
          log.warn("session.boot_resume_requeued", { sessionId: row.id, attempt: n + 1, delayMs: delay, error: error instanceof Error ? error.message.slice(0, 160) : undefined });
          const timer = setTimeout(() => {
            pending.delete(timer);
            void this.pool.query("SELECT 1 FROM agent_sessions WHERE id = $1 AND resume_on_boot = TRUE AND state = 'sleeping'", [row.id])
              .then((r) => r.rows[0] ? attemptResume(row) : undefined)
              .catch(() => undefined);
          }, delay);
          timer.unref();
          pending.add(timer);
          return false;
        }
        result.skipped++;
        const code = (error as { code?: string } | null)?.code;
        await settle(row, code === "worktree_deleted" ? "worktree_deleted" : "resume_failed", error);
        if (code !== "worktree_deleted") this.notifyUser(row.user_id, { sessionId: row.id, projectId: row.project_id, title: BOOT_PAUSED_TITLE, body: "The agent could not be restarted automatically after the runtime restarted. Resume it from the canvas." });
        return false;
      }
    };
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        if (this.shuttingDown) return;
        await attemptResume(row);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));
    return result;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.lifecycle.close();
    this.agyMirror?.dispose();
    clearInterval(this.reaper);
    for (const timer of this.checkpointSweepTimers) { clearTimeout(timer); clearInterval(timer); }
    for (const timer of this.bootRetryTimers) clearTimeout(timer);
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
