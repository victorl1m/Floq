import { randomUUID } from "node:crypto";
import { SkillsService, loadRemovedSkills } from "./skills.js";
import { mergeGlobalCodexMcp } from "./mcpConfig.js";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type pg from "pg";
import type { Config, ModelEntry } from "./config.js";
import { badRequest, conflict, notFound, tooMany } from "./errors.js";
import { log } from "./logger.js";
import { stripAnsi } from "./orchestrator.js";
import { validCredential, type CredentialBroker, type CredentialData, type OAuthProvider } from "./credentials.js";
import { buildSessionEnv, forcedSessionEnv, getProviderDefinition, resolveModel } from "./providers.js";
import { CodexModelCatalog, fetchCodexModelList } from "./codexModels.js";
import { Session } from "./session.js";
import { CapacityReservations, ClosingGate, coalesce } from "./lifecycleGate.js";
import { createWorktree } from "./worktree.js";
import { codexTrustArgs, managedTrustDirectories } from "./codexTrust.js";
import { claudeProjectTrust, claudeStartupSettings, readClaudeProjectConfig } from "./claudeSettings.js";
import { isAllowedProjectImage } from "./projectImage.js";
import { listProjectBranches, switchProjectBranch, type GitCommandResult } from "./projectBranches.js";
import { assertCanDelete, deleteWorktree, inspectWorktree, type WorktreeDeleteResult, type WorktreeStatus } from "./worktreeDelete.js";
import { readClaudeNativeTitle, readCodexNativeTitle } from "./nativeTitle.js";
import { syncCodexManagedGuidance, syncProtectedCodexSkill } from "./codexGuidance.js";
import { mkdirOwned, safeRelative, type ShardHandle } from "./shard.js";
import type { ShardService } from "./shards.js";
import type { Vault } from "./vault.js";
import type { RuntimeProfile } from "./settings.js";
import { PROVIDER_IDS, type CreateSessionInput, type ProviderId, type RuntimeProject, type ProjectWorkspace, type SessionState, type SessionSummary } from "./types.js";

const GIT_URL = /^(https:\/\/|ssh:\/\/|git@)[\w.@:/~+-]+$/;
const REAP_INTERVAL_MS = 15_000;
/** If a resumed agent dies this fast with an error, there was nothing to resume: start fresh. */
const RESUME_FALLBACK_MS = 8_000;
const CODEX_ID_POLL_MS = 3_000;
const CODEX_MODEL_TIMEOUT_MS = 20_000;
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
}

export class SessionManager {
  /** Owner of the Claude / Codex subscription credentials (set at startup). */
  credentials!: CredentialBroker;
  private readonly logins = new Map<string, LoginState>();
  /** mtime of credential files we wrote or last read, to detect a CLI refreshing on its own. */
  private readonly credMtime = new Map<string, number>();
  private readonly live = new Map<string, Session>();
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
  private readonly loginTasks = new Map<string, Promise<SessionSummary>>();
  private readonly projectCreates = new Map<string, Promise<RuntimeProject>>();
  private readonly projectBranchLocks = new Map<string, Promise<void>>();
  private readonly shardActivityCounts = new Map<string, number>();
  private readonly shardActivities = new Set<Promise<unknown>>();
  private shuttingDown = false;
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
    let count = 0;
    for (const session of this.live.values()) if (session.isAlive) count++;
    return count;
  }

  activeCountFor(userId: string): number {
    let count = 0;
    for (const session of this.live.values()) if (session.userId === userId && session.isAlive) count++;
    return count;
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
      if (this.shards.isAwake(userId) && ![...this.live.values()].some((session) => session.userId === userId && session.isAlive)) {
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
      writeFileSync(authFile, JSON.stringify(credential), { mode: 0o600 });
      chmodSync(authFile, 0o600);
      lchownSync(authFile, handle.uid, handle.uid);

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
      if (![...this.live.values()].some((session) => session.userId === userId && session.isAlive)) this.scheduleLock(userId);
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

  async createProject(userId: string, profile: RuntimeProfile, gitUrlValue: string, requestedName?: string): Promise<RuntimeProject> {
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
        const name = requestedName?.trim().slice(0, 120) || projectNameFromUrl(gitUrl);
        const branch = branchFromCheckout(target);
        const client = await this.pool.connect();
        let projectId: string = id;
        try {
          await client.query("BEGIN");
          const inserted = await client.query(
            `INSERT INTO floq_projects(id,user_id,name,git_url,normalized_git_url,cwd)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT (user_id,normalized_git_url) WHERE normalized_git_url IS NOT NULL DO NOTHING
             RETURNING id`, [id,userId,name,gitUrl,normalized,cwd],
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
      list.push({ id: String(row.id), cwd: String(row.cwd), name: String(row.name), branch: row.branch ? String(row.branch) : null, isWorktree: Boolean(row.is_worktree), sessionIds: (row.session_ids as string[]).map(String) });
      byProject.set(projectId, list);
    }
    return projects.rows.map((row: Record<string, unknown>) => ({
      id: String(row.id), name: String(row.name), displayName: row.display_name ? String(row.display_name) : null,
      imageUrl: row.image_url ? String(row.image_url) : null, gitUrl: row.git_url ? String(row.git_url) : null,
      cwd: String(row.cwd), createdAt: new Date(String(row.created_at)).toISOString(), workspaces: byProject.get(String(row.id)) ?? [],
    }));
  }

  async project(userId: string, id: string): Promise<RuntimeProject | null> {
    const projects = await this.listProjects(userId);
    return projects.find((project) => project.id === id) ?? null;
  }

  async updateProject(userId: string, id: string, patch: { displayName?: unknown; imageUrl?: unknown }): Promise<RuntimeProject> {
    if (patch.displayName !== undefined && patch.displayName !== null && (typeof patch.displayName !== "string" || patch.displayName.length > 120)) throw badRequest("displayName must be at most 120 characters", "invalid_project");
    if (patch.imageUrl !== undefined && patch.imageUrl !== null) {
      if (typeof patch.imageUrl !== "string" || !isAllowedProjectImage(patch.imageUrl)) throw badRequest("imageUrl must be an HTTP(S) URL or a small WebP project image", "invalid_project");
      if (!patch.imageUrl.startsWith("data:image/webp;base64,")) try {
        const parsed = new URL(patch.imageUrl);
        if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) throw new Error("invalid image URL");
      } catch { throw badRequest("imageUrl must be a valid HTTP(S) URL without credentials", "invalid_project"); }
    }
    const fields: string[] = [];
    const values: unknown[] = [id, userId];
    if (patch.displayName !== undefined) { values.push(patch.displayName); fields.push(`display_name=$${values.length}`); }
    if (patch.imageUrl !== undefined) { values.push(patch.imageUrl); fields.push(`image_url=$${values.length}`); }
    if (!fields.length) throw badRequest("No project fields supplied", "invalid_project");
    const result = await this.pool.query(`UPDATE floq_projects SET ${fields.join(",")} WHERE id=$1 AND user_id=$2 RETURNING id`, values);
    if (!result.rows[0]) throw notFound("Project not found");
    return (await this.project(userId, id))!;
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
        const active = await this.pool.query(
          "SELECT id FROM agent_sessions WHERE user_id=$1 AND project_id=$2 AND state IN ('running','starting') LIMIT 1",
          [userId, projectId],
        );
        if (active.rows[0]) throw conflict("Sleep the active agents in this project before switching branches.", "project_agents_active");
        await switchProjectBranch(run, branch);
      }
      const branchName = workspace.cwd === workspace.projectCwd ? "Main" : "Worktree";
      const result = await this.pool.query(
        `UPDATE floq_project_workspaces SET branch=$1,name=CASE WHEN $1 IS NULL THEN 'Detached HEAD' ELSE $2 END
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
      "SELECT * FROM agent_sessions WHERE user_id = $1 ORDER BY last_active_at DESC LIMIT 200",
      [userId],
    );
    return result.rows.map((row: Row) => {
      const live = this.live.get(row.id);
      return live ? live.toSummary() : summaryFromRow(row);
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

  /** Run a helper as the user's uid (setpriv) so what it creates in the mounted home is theirs. */
  private asUser(handle: ShardHandle, file: string, args: string[]): [string, string[]] {
    if (this.shards.driver.name !== "linux") return [file, args];
    return ["setpriv", ["--reuid=" + handle.uid, "--regid=" + handle.uid, "--clear-groups", file, ...args]];
  }

  private clone(url: string, destination: string, profile: RuntimeProfile, handle: ShardHandle): Promise<void> {
    if (!GIT_URL.test(url)) throw badRequest("Unsupported git URL", "invalid_git_url");
    return new Promise((done, fail) => {
      const [file, args] = this.asUser(handle, "git", ["clone", "--depth", "50", "--", url, destination]);
      const child = spawn(file, args, {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...buildSessionEnv(this.config, "claude", profile, "clone"), HOME: "/tmp" },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
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
  private async launch(row: Row, profile: RuntimeProfile, handle: ShardHandle, resume: boolean, prompt?: string): Promise<Session> {
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
    // Initial prompt: fresh starts only, as its own argv element after all flags (no shell involved).
    if (!resuming && prompt) args.push("--", prompt);
    const env = buildSessionEnv(this.config, row.provider, profile, row.id);
    // Secrets the user marked "env" are injected; the rest are only reachable through `floq-vault`.
    Object.assign(env, await this.vault.reveal(row.user_id, null, "env", row.id));
    Object.assign(env, forcedSessionEnv(row.provider)); // a vault entry must not undo the renderer pin
    env.FLOQ_API_URL = "http://127.0.0.1:" + this.config.port;
    env.FLOQ_AGENT_TOKEN = this.vault.issueToken(row.user_id, row.id);
    env.FLOQ_AGENT_NAME = row.title;
    if (row.provider === "codex") {
      env.CODEX_HOME = this.shards.driver.homePath(handle) + "/" + codexHomeRel(row.id);
      const codexHome = this.shards.driver.hostPath(handle, codexHomeRel(row.id));
      mkdirOwned(handle.mountPath, codexHome, handle.uid);
      this.shards.seed(codexHome, ".codex", handle.uid, await loadRemovedSkills(this.pool, row.user_id).catch(() => null));
      this.syncGlobalCodexMcp(handle, codexHome);
      try {
        syncProtectedCodexSkill(codexHome, join(this.config.skelDir, ".codex/skills/floq-orchestrate"), handle.uid);
      } catch (error) {
        log.warn("codex.protected_skill_sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      try {
        syncCodexManagedGuidance(codexHome, handle.uid);
      } catch (error) {
        log.warn("codex.managed_guidance_sync_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      }
      const cred = await this.freshCredential(row.user_id, "codex");
      if (cred) this.writeCredFile(handle, this.codexAuthPath(handle, row.id), JSON.stringify(cred));
    }
    if (row.provider === "claude") {
      const cred = await this.freshCredential(row.user_id, "claude");
      if (cred) this.writeClaude(handle, cred);
      this.enforceClaudeSettings(handle, profile);
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
    const pty = this.shards.driver.spawn(handle, {
      file: definition.bin,
      args,
      env,
      cwd: row.cwd,
      cols: row.cols,
      rows: row.rows,
    });

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
    });
    this.live.set(row.id, session);
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
      if (frame.type === "exit") void this.onExit(session, frame.session.state, resuming && Date.now() - launchedAt < RESUME_FALLBACK_MS, profile, handle);
    });

    await this.pool.query(
      "UPDATE agent_sessions SET state = 'running', resume_count = $2, sleep_reason = NULL, slept_at = NULL, last_active_at = now() WHERE id = $1",
      [row.id, resumeCount],
    );
    void this.updateNativeTitle(row.id);
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

  private async updateNativeTitle(id: string, force = false): Promise<void> {
    const now = Date.now();
    const state = this.nativeTitleSessions.get(id);
    if (!state || state.checking || (!force && now - state.checkedAt < 5_000)) return;
    state.checkedAt = now;
    state.checking = true;
    try {
      const title = state.provider === "claude"
        ? readClaudeNativeTitle(this.shards.driver.homePath(state.handle), id)
        : state.providerSessionId
          ? readCodexNativeTitle(this.shards.driver.homePath(state.handle), this.shards.driver.hostPath(state.handle, codexHomeRel(id)), state.providerSessionId)
          : null;
      const previousTitle = state.lastNativeTitle ?? state.fallback;
      if (!title || title === previousTitle) return;
      const updated = await this.pool.query(
        "UPDATE agent_sessions SET title=$2 WHERE id=$1 AND user_id=$3 AND title=$4 AND title_locked=FALSE RETURNING id",
        [id, title, state.userId, previousTitle],
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
    this.stopCodexPoll(session.id);
    this.vault.revokeSession(session.id);
    if (this.intentionalSleep.delete(session.id)) {
      await this.updateNativeTitle(session.id, true);
      this.nativeTitleSessions.delete(session.id);
      return;
    }
    if (this.live.get(session.id) !== session) {
      this.nativeTitleSessions.delete(session.id);
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
    const codexModels = input.provider === "codex" && typeof input.model === "string" && input.model
      ? await this.codexModels(userId)
      : undefined;
    const model = resolveModel(this.config, input.provider, input.model, codexModels);
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
          const [file, commandArgs] = this.asUser(handle, "git", args);
          const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
          return await new Promise<string>((resolveRun, rejectRun) => {
            const child = spawn(file, commandArgs, {
              cwd: handle.mountPath,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: process.platform === "win32" ? process.env.TEMP ?? "C:\\Temp" : "/tmp",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: nullDevice,
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stderr = "";
            let stdout = "";
            child.stdout.on("data", (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk.toString(); });
            child.stderr.on("data", (chunk) => { if (stderr.length < 2000) stderr += chunk.toString(); });
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
      `INSERT INTO agent_sessions (id, user_id, provider, title, cwd, git_url, state, cols, rows, lead, model, project_cwd, project_id, workspace_id, branch)
       VALUES ($1,$2,$3,$4,$5,$6,'sleeping',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, userId, input.provider, title, cwd, projectGitUrl, cols, rows, input.lead === true, model, projectCwd ?? (projectId ? null : input.gitUrl ? cwd : null), projectId, workspaceId, branch],
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
  async resume(userId: string, profile: RuntimeProfile, id: string): Promise<SessionSummary> {
    this.assertLifecycleOpen();
    return coalesce(this.resumeTasks, userId + ":" + id, () => this.resumeOnce(userId, profile, id));
  }

  private async resumeOnce(userId: string, profile: RuntimeProfile, id: string): Promise<SessionSummary> {
    this.assertLifecycleOpen();
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
      const session = await this.launch(row, profile, handle, true);
      log.info("session.resume", { sessionId: id, userId, count: session.resumeCount });
      return session.toSummary();
    } finally {
      releaseCapacity();
    }
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
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    lchownSync(path, handle.uid, handle.uid);
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
    writeFileSync(path, JSON.stringify(settings, null, 2));
    lchownSync(path, handle.uid, handle.uid);
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
  async sleepSession(id: string, reason: string): Promise<void> {
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
    this.live.delete(id);
    await this.pool.query(
      "UPDATE agent_sessions SET state = 'sleeping', sleep_reason = $2, last_seq = $3, last_active_at = now(), slept_at = now() WHERE id = $1",
      [id, reason, summary.seq],
    );
    session.broadcast({ type: "state", session: { ...summary, state: "sleeping", sleepReason: reason, pid: null } });
    session.dispose();
    log.info("session.sleep", { sessionId: id, userId: session.userId, reason });
    this.scheduleLock(session.userId);
  }

  async sleepUser(userId: string, reason: string): Promise<void> {
    const mine = [...this.live.values()].filter((s) => s.userId === userId);
    await Promise.all(mine.map((s) => (s.isAlive ? this.sleepSession(s.id, reason) : Promise.resolve())));
    this.cancelLock(userId);
    await this.shards.sleep(userId);
  }

  async remove(id: string, userId: string): Promise<void> {
    if (this.logins.get(id)?.userId === userId) return this.endLogin(id);
    await this.row(id, userId);
    const session = this.live.get(id);
    if (session) {
      this.intentionalSleep.add(id);
      this.live.delete(id);
      this.vault.revokeSession(id);
      session.dispose();
    }
    await this.pool.query("DELETE FROM agent_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
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
      if (remaining <= 0 && !this.shuttingDown && ![...this.live.values()].some((session) => session.userId === userId && session.isAlive)) {
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
      const busy = [...this.live.values()].some((s) => s.userId === userId && s.isAlive);
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

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.lifecycle.close();
    clearInterval(this.reaper);
    for (const timer of this.lockTimers.values()) clearTimeout(timer);
    await Promise.allSettled([...this.shardActivities]);
    for (const session of [...this.live.values()]) {
      if (session.isAlive) await this.sleepSession(session.id, "shutdown").catch(() => undefined);
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
