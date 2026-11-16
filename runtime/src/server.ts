import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_MAX_UPLOAD_BYTES } from "./attachments.js";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { WebSocketServer, type WebSocket } from "ws";
import type pg from "pg";
import type { ClaudeOAuth } from "./claudeOauth.js";
import type { UsageService } from "./usage.js";
import type { ClaudeConnectors } from "./claudeConnectors.js";
import type { FallbackService } from "./fallback.js";
import type { ClaudeAccounts } from "./claudeAccounts.js";
import type { SkillsService } from "./skills.js";
import { loadSkillFromCatalog, previewCatalogSkill, searchSkillCatalog } from "./skillCatalog.js";
import type { CredentialBroker } from "./credentials.js";
import { createBootstrapAdmin, setupLookupStep, type Auth } from "./auth.js";
import { SetupToken } from "./setupToken.js";
import { clientIp as clientIpFor, normalizeAuthForwardedHeaders } from "./clientIp.js";
import type { Config } from "./config.js";
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from "./errors.js";
import { log } from "./logger.js";
import type { SessionManager } from "./manager.js";
import type { GithubLinker } from "./github.js";
import { AGENT_ROLES, describeRole, getAgentRole, listAgentRoles } from "./roles.js";
import type { AgentLinks } from "./links.js";
import type { CanvasNotes } from "./notes.js";
import { defangMemories, type MemoryService, type MemoryCtx } from "./memories.js";
import type { WiredContext } from "./wiredContext.js";
import { selectableAgentModels, type Orchestrator, type PendingCounts } from "./orchestrator.js";
import { buildSubagentInstruction, TOOL_SPECS, type SubagentService } from "./subagents.js";
import type { PatchSecret, PutSecret, Vault } from "./vault.js";
import { listProviders } from "./providers.js";
import { IdempotencyCache } from "./idempotency.js";
import type { SettingsPatch, SettingsStore } from "./settings.js";
import type { Session } from "./session.js";
import type { GitReview } from "./gitReview.js";
import type { Artifacts } from "./artifacts.js";
import type { WorkspaceFiles } from "./workspaceFiles.js";
import { DownloadLinks } from "./downloadLinks.js";
import { DavMounts, mountLocations } from "./davMounts.js";
import { WebDav } from "./webdav.js";
import type { ShardService } from "./shards.js";
import { runtimeCapabilities } from "./capabilities.js";
import type { BrowserService, ViewerHandle } from "./browser.js";
import type { BrowserLinks } from "./browserLinks.js";
import { BrowserImportService } from "./browserImport.js";
import type { ClientFrame, CreateSessionInput, ProviderId, ServerFrame, ServerInfo } from "./types.js";
import { TasksService } from "./tasks.js";
import { OrganizationsService, organizationLimitsFromEnv, routeOrganizations } from "./organizations.js";
import { expireStaleCursors } from "./taskPresence.js";
import { registerWithInvitation } from "./invitationRegistration.js";
import { WEBHOOK_MAX_BYTES, type PluginHost } from "./plugins/host.js";
import { getRole, listUsers, requireAdmin, requireRoleValue, setUserRole } from "./admin.js";
import { PortRequests } from "./portRequests.js";
import { Approvals } from "./approvals.js";
import { Decisions } from "./decisions.js";
import { Notifications } from "./notifications.js";
import { ProjectFolders } from "./projectFolders.js";
import { neutralizeDeep } from "./approvalText.js";
import { visibleDebugLinks } from "./debugLinks.js";
import { displayStatus, portIsFreeInNetns, stopDisplayServer } from "./display.js";
import { acquireTunnelSlot, connectInNetns } from "./netns.js";
import { databasePort, listAllListeners, listSessionPorts, MANUAL_DENY_PORTS, manualPortOwned, pipeTunnel, tunnelTarget } from "./ports.js";
import { UpdateService, updatesConfigFromEnv } from "./updates.js";

const startedAt = new Date().toISOString();
const SESSION_PATH = /^\/v1\/sessions\/([\w-]+)(?:\/(stream|input|resize|interrupt|resume|sleep))?$/;
const MAX_WS_PAYLOAD = 256 * 1024;
const SELF_RESTART_DELAY_MS = 750;

interface Deps {
  config: Config;
  /** One-time setup token for the bootstrap admin; defaults to a DB-backed instance. */
  setupToken?: SetupToken;
  manager: SessionManager;
  auth: Auth;
  settings: SettingsStore;
  github: GithubLinker;
  vault: Vault;
  orchestrator: Orchestrator;
  links: AgentLinks;
  notes: CanvasNotes;
  /** Optional so existing callers keep working; absent = no wired-context feature. */
  wired?: WiredContext;
  subagents?: SubagentService;
  /** Agent memory (Redis); absent or unconfigured = memory endpoints answer 503 memory_unavailable. */
  memories?: MemoryService;
  pool: pg.Pool;
  credentials: CredentialBroker;
  claudeOauth: ClaudeOAuth;
  usage: UsageService;
  claudeConnectors: ClaudeConnectors;
  fallback?: FallbackService;
  claudeAccounts?: ClaudeAccounts;
  skills: SkillsService;
  gitReview: GitReview;
  workspaceFiles?: WorkspaceFiles;
  artifacts?: Artifacts;
  /** Enables the WebDAV mounts (Open in Explorer). */
  shards?: ShardService;
  tasks: TasksService;
  /** Optional so existing callers keep working; absent = the browser routes answer "unavailable". */
  plugins?: PluginHost;
  browser?: BrowserService;
  /** Agent <-> Browser node wires. */
  browserLinks?: BrowserLinks;
}

/** Skills and MCP config exist only for Claude and Codex: an OpenCode/Antigravity agent must name one with --provider. */
function toolkitProvider(provider: string): "claude" | "codex" {
  if (provider === "claude" || provider === "codex") return provider;
  throw badRequest("Skills and MCP servers are only managed for Claude and Codex; pass --provider claude or --provider codex");
}

export function createRuntimeServer({ config, setupToken: setupTokenDep, manager, auth, settings, github, vault, orchestrator, links, notes, wired, subagents, memories, pool, credentials, claudeOauth, usage, claudeConnectors, fallback, claudeAccounts, skills, gitReview, workspaceFiles, artifacts, tasks, shards, plugins, browser, browserLinks }: Deps) {
  const sessionCreates = new IdempotencyCache<Awaited<ReturnType<SessionManager["create"]>>>();
  const authHandler = toNodeHandler(auth);
  const organizations = new OrganizationsService(pool, { limits: organizationLimitsFromEnv(), inboxRequiresVerifiedEmail: config.allowSignup, reservedEmail: config.bootstrapAdminEmail });
  const setupHits = new Map<string, { count: number; resetAt: number }>();
  const scheduledAgentRestarts = new Set<string>();
  const projectFolders = new ProjectFolders(pool);
  // Agent "open a port" requests: the user answers in the app; the runtime enforces the 60s deadline itself.
  const portRequests = new PortRequests({
    isDenied: (port) => port === config.port || port === databasePort(config.databaseUrl) || MANUAL_DENY_PORTS.includes(port),
    isAlive: (userId, sessionId) => { try { manager.getLive(sessionId, userId); return true; } catch { return false; } },
  });
  // User approvals for irreversible actions. Agents can request/verify; ONLY the user's app session (GET/POST /v1/approvals) can grant.
  const approvals = new Approvals({
    pool,
    isAlive: (userId, sessionId) => { try { manager.getLive(sessionId, userId); return true; } catch { return false; } },
    // The runtime itself types the user's decision into the agent's terminal (trusted marker; agent text can never carry it).
    // Persisted first (agent_outbox): a target that is asleep or restarting gets the decision on its next ready.
    deliver: (userId, sessionId, text) => orchestrator.deliverApproval(userId, sessionId, text),
  });
  void approvals.init();
  plugins?.setApprovals(approvals);
  // A pinned memory changed: refresh the wired context of the agents that read it and tell the live ones.
  if (memories && wired) {
    memories.onPinnedChange = (userId, memory, exceptSessionId) => {
      void (async () => {
        for (const id of await memories.sessionIdsFor(userId, memory)) {
          try {
            const r = await wired.sync(userId, id);
            if (id !== exceptSessionId && (r.added.length || r.removed.length || r.updated.length)) await manager.notifyWired(userId, id, r.added, r.removed, r.block, r.updated);
          } catch (error) { log.warn("wired.touch_failed", { sessionId: id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); }
        }
      })().catch(() => undefined);
    };
  }
  const memoryOff = () => new HttpError(503, "memory_disabled", "Memory is disabled on this Floq server (set FLOQ_REDIS_URL)");
  const decisions = new Decisions({ pool, deliver: (userId, sessionId, text) => orchestrator.deliverApproval(userId, sessionId, text) });
  const decisionsReady = decisions.init();
  const notifications = new Notifications({ pool });
  plugins?.setAttention({ approvals, decisions });
  // Agent B's manager hook: whenever a session (re)starts and is ready, type what was queued for it while it was away.
  // Optional call: test harnesses build the server around partial fake managers.
  manager.onSessionReady?.((userId, sessionId) => { void orchestrator.deliverPending(userId, sessionId).catch((error) => log.warn("agent.outbox_ready_failed", { userId, sessionId, error: String(error).slice(0, 120) })); });
  const updates = new UpdateService(updatesConfigFromEnv(process.env, { version: config.version, providers: config.providers }), () => manager.activeCount);

  const setupToken = setupTokenDep ?? new SetupToken(pool);
  const clientIp = (req: IncomingMessage): string => clientIpFor(req);

  function rateLimitSetup(req: IncomingMessage): void {
    const ip = clientIp(req);
    const now = Date.now();
    for (const [key, hit] of setupHits) if (hit.resetAt <= now) setupHits.delete(key);
    const hit = setupHits.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    hit.count += 1;
    setupHits.set(ip, hit);
    if (hit.count > 10) throw new HttpError(429, "rate_limited", "Too many requests");
  }

  async function authFor(headers: IncomingMessage["headers"]): Promise<{ userId: string; authSessionId: string }> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!result) throw unauthorized();
    return { userId: result.user.id, authSessionId: result.session?.id ?? "" };
  }

  async function userFor(headers: IncomingMessage["headers"]): Promise<string> {
    return (await authFor(headers)).userId;
  }

  const davMounts = new DavMounts(pool);
  const webdav = shards ? new WebDav({ mounts: davMounts, shards, manager }) : null;

  /** Short-lived single-use links for native browser/WebView downloads, which cannot send an Authorization header. */
  const downloadLinks = new DownloadLinks(config.authSecret || randomBytes(32).toString("hex"));

  const info = (): ServerInfo => ({
    name: "floq-runtime",
    version: config.version,
    startedAt,
    providers: listProviders(config).filter((p) => p.available).map((p) => p.id),
    maxSessions: config.maxSessions,
    activeSessions: manager.activeCount,
    capabilities: runtimeCapabilities(browser?.capability() ?? "missing"),
    browser: browser?.capability() ?? "missing",
  });

  function originAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    return config.allowedOrigins.includes(origin);
  }

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, If-None-Match, X-Floq-Organization");
    res.setHeader("Access-Control-Expose-Headers", "set-auth-token, X-Floq-Plugin-Sha256");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    res.end(payload);
  }

  /** `--fallback default|model|pause` at recruit time: validated before anything starts, applied to the new agent only. */
  function recruitFallbackPolicy(value: unknown): "default" | "model" | "pause" | null {
    if (value === undefined || value === null) return null;
    if (value !== "default" && value !== "model" && value !== "pause") throw badRequest("fallback must be default, model or pause", "invalid_fallback");
    return value;
  }
  async function applyRecruitFallback(userId: string, recruited: unknown, policy: "default" | "model" | "pause" | null): Promise<void> {
    const id = (recruited as { id?: unknown } | null)?.id;
    if (!policy || policy === "default" || !fallback || typeof id !== "string") return;
    await fallback.act(userId, id, "override", policy);
  }
  const browserImport = browser ? new BrowserImportService(browser) : null;
  async function readJson<T>(req: IncomingMessage, limit = config.maxBodyBytes): Promise<T> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, "payload_too_large", "Request body too large");
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {} as T;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw badRequest("Body must be valid JSON", "invalid_json");
    }
  }

  /** Shared by the app route and `floq skills add`: downloads a catalog skill and writes it into one of the user's projects. */
  async function importCatalogSkill(userId: string, target: string | { scope: "global" | "project"; projectId?: string }, body: { provider?: unknown; source?: unknown; skillId?: unknown; url?: unknown }, dryRun = false) {
    if (body.provider !== "claude" && body.provider !== "codex") throw badRequest("provider must be claude or codex", "invalid_skill");
    const where = typeof target === "string" ? { scope: "project" as const, projectId: target } : target;
    if (where.scope === "project") await skills.listProject(userId, where.projectId as string); // Check project ownership before making an upstream request.
    const loaded = await loadSkillFromCatalog(body);
    const { files: _contents, ...metadata } = loaded;
    const projectFiles = Object.fromEntries(loaded.files.map((file) => [file.path, file.contents]));
    const result = await skills.addSkillPackage(userId, { scope: where.scope, projectId: where.projectId, provider: body.provider, files: projectFiles, dryRun });
    return { ...result, catalog: metadata };
  }

  /**
   * Installs an MCP server, first creating any new vault secrets the app asks for (create-only, tool exposure), and
   * checking every referenced secret exists. If writing the config fails, only the secrets created by this attempt are removed.
   */
  async function installMcp(userId: string, sessionId: string | null, body: Record<string, unknown>, mayCreateSecrets: boolean) {
    const known = (await vault.list(userId)).map((secret) => secret.name);
    const fresh = mayCreateSecrets && Array.isArray(body.newSecrets) ? (body.newSecrets as Array<Record<string, unknown>>) : [];
    if (fresh.length > 20) throw badRequest("Too many new secrets at once", "invalid_secret");
    const { newSecrets: _ignored, ...input } = body;
    // Validate the whole request before anything is created.
    await skills.addMcp(userId, { ...input, dryRun: true, knownSecrets: [...known, ...fresh.map((item) => item?.name)] });
    if (input.dryRun === true) return skills.addMcp(userId, { ...input, knownSecrets: [...known, ...fresh.map((item) => item?.name)] });
    const created: string[] = [];
    try {
      for (const item of fresh) {
        if (!item || typeof item !== "object") throw badRequest("newSecrets entries must be objects", "invalid_secret");
        await vault.create(userId, sessionId, { name: item.name, value: item.value, description: item.description });
        created.push(String(item.name)); known.push(String(item.name));
      }
      return await skills.addMcp(userId, { ...input, knownSecrets: known });
    } catch (error) {
      const left: string[] = [];
      for (const name of created.reverse()) { try { await vault.remove(userId, name); } catch { left.push(name); } }
      if (left.length && error instanceof HttpError) throw new HttpError(error.status, error.code, error.message + " These secrets were created for this attempt and could not be removed, delete them in Secrets if you don't want them: " + left.join(", ") + ".");
      throw error;
    }
  }

  plugins?.setMcp({
    install: (userId, body) => installMcp(userId, null, body, false),
    remove: (userId, name, provider) => skills.removeMcp(userId, { scope: "global", provider, name }),
  });

  /** `--project`/`--global` for `floq mcp`: an explicit choice wins; otherwise the calling session's own project, else global. */
  async function toolkitScope(userId: string, body: Record<string, unknown>, me: { projectId: string | null; orgId: string | null }): Promise<{ scope: "global" | "project"; projectId?: string }> {
    const callerProjectId = me.projectId;
    if (body.scope !== undefined && body.scope !== "global" && body.scope !== "project") throw badRequest("scope must be global or project");
    const scope = (body.scope as "global" | "project" | undefined) ?? (typeof body.projectId === "string" || callerProjectId ? "project" : "global");
    if (scope === "global") return { scope };
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : callerProjectId;
    if (!projectId) throw badRequest("This session is not in a registered project; pass --project <ID> or use --global", "no_project");
    await orchestrator.assertProjectInCallerOrg(userId, me, projectId);
    return { scope, projectId };
  }

  function projectCreateInput(body: Record<string, unknown>): { name?: string; gitUrl?: string } {
    let gitUrl: string | undefined;
    if (body.gitUrl !== undefined) {
      if (typeof body.gitUrl !== "string" || !body.gitUrl.trim()) throw badRequest("gitUrl must be a non-empty string", "invalid_project");
      gitUrl = body.gitUrl.trim();
    }
    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
        throw badRequest("name must be a non-empty string of at most 120 characters", "invalid_project");
      }
      name = body.name.trim();
    }
    if (!gitUrl && !name) throw badRequest("name is required when gitUrl is not provided", "invalid_project");
    return { name, gitUrl };
  }

  function requireSubagents(): SubagentService {
    if (!subagents) throw new HttpError(503, "subagents_unavailable", "Subagents are not configured");
    return subagents;
  }

  const sendPlain = send;

  /** Optional dependency: a manager without it (or one that throws) just reports "not connected". */
  async function agyConnected(userId: string): Promise<boolean> {
    try { return Boolean(await manager.antigravityConnected(userId)); } catch { return false; }
  }

  /** claude/codex come from the credential broker; Antigravity's Google login is agy's own token file (never stored by Floq). */
  async function providersStatus(userId: string) {
    const base = await credentials.status(userId);
    const connected = await agyConnected(userId);
    return { ...base, antigravity: { connected, detail: null, expiresAt: null, plan: null } };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://runtime");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/healthz") {
      return send(res, 200, { ok: true });
    }

    // Called from inside agent sandboxes by `floq` / `floq-vault`; authenticated by a per-session token.
    if (url.pathname.startsWith("/internal/")) {
      const scope = vault.authenticate(req.headers.authorization);
      const { userId, sessionId } = scope;
      // `floq skills create --from DIR` may carry a whole skill package (up to 512 KiB of text), so that one route gets a larger body limit.
      const body = method === "POST" ? await readJson<Record<string, unknown>>(req, url.pathname === "/internal/skills/create" ? 1.5 * 1024 * 1024 : config.maxBodyBytes) : {};
      const path = url.pathname.slice("/internal/".length);
      // Anything an agent receives from another agent (notes, replies, inbox, ...) is stripped of forged `[FLOQ APPROVAL` markers.
      // A shared note an agent wrote reaches other agents (memory: its project; system: every agent): refresh their wired context and tell the live ones.
      const touchProjectNote = async (note: { kind: string; projectId: string | null }): Promise<void> => {
        if (note.kind === "note" || !wired) return;
        for (const id of await notes.sharedNoteSessionIds(userId, note)) {
          if (id === sessionId) continue;
          try {
            const r = await wired.sync(userId, id);
            if (r.added.length || r.removed.length || r.updated.length) await manager.notifyWired(userId, id, r.added, r.removed, r.block, r.updated);
          } catch (error) { log.warn("wired.touch_failed", { sessionId: id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); }
        }
        try { await wired.sync(userId, sessionId); } catch { /* refreshed at next start */ }
      };
      // After an agent deletes a note: refresh the wired context of the sessions that had it and tell the live ones.
      const touchSessions = async (sessionIds: string[]): Promise<void> => {
        if (!wired) return;
        for (const id of new Set(sessionIds)) {
          try {
            const r = await wired.sync(userId, id);
            if (r.added.length || r.removed.length || r.updated.length) await manager.notifyWired(userId, id, r.added, r.removed, r.block, r.updated);
          } catch (error) { log.warn("wired.touch_failed", { sessionId: id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); }
        }
      };
      const send = (r: ServerResponse, status: number, payload: unknown): void => sendPlain(r, status, path.startsWith("vault/") || path.startsWith("secrets/") ? payload : neutralizeDeep(payload));
      if (plugins && path === "plugins/list") return send(res, 200, { plugins: await plugins.listInternal(userId) });
      const pluginCall = plugins ? /^plugins\/([a-z][a-z0-9-]*)\/(.*)$/.exec(path) : null;
      if (plugins && pluginCall) {
        // Aborted when the agent's request goes away, so long waits (a user approval) are withdrawn instead of completing unseen.
        const gone = new AbortController();
        res.once("close", () => { if (!res.writableEnded) gone.abort(); });
        return send(res, 200, await plugins.handleInternal({ userId, sessionId, pluginId: pluginCall[1], path: pluginCall[2], body, signal: gone.signal }));
      }
      switch (path) {
        case "vault/secrets":
          return send(res, 200, { secrets: (await vault.list(userId)).map((s) => ({ name: s.name, description: s.description })) });
        case "vault/reveal": {
          const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : null;
          // Bulk reveal never returns tool-only secrets and needs a lead. A named reveal of a tool-only secret
          // (the `floq-vault run` path) also needs a lead; env-exposed secrets are already in the sandbox environment.
          if (!names) {
            await orchestrator.toolkitCaller(userId, sessionId, true);
            return send(res, 200, { secrets: await vault.reveal(userId, null, "env", sessionId) });
          }
          const exposure = new Map((await vault.list(userId)).map((s) => [s.name, s.expose]));
          if (names.some((n) => exposure.get(n) !== "env")) await orchestrator.toolkitCaller(userId, sessionId, true);
          return send(res, 200, { secrets: await vault.reveal(userId, names, null, sessionId) });
        }
        // `floq-vault run`: the runtime launches the command in the caller's sandbox with the secrets injected; the cleartext is never returned.
        case "vault/run": {
          const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : null;
          const argv = Array.isArray(body.argv) && body.argv.length > 0 && body.argv.length <= 512 && body.argv.every((a) => typeof a === "string" && a.length <= 32768 && !a.includes("\0")) ? (body.argv as string[]) : null;
          if (!argv || argv[0] === "") throw badRequest("argv must be a non-empty list of strings", "invalid_argv");
          if (names && (names.length > 100 || names.some((n) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(n)))) throw badRequest("invalid secret names", "invalid_name");
          // Same authorization as a reveal: a lead for anything beyond secrets already in the sandbox environment.
          const exposure = new Map((await vault.list(userId)).map((s) => [s.name, s.expose]));
          if (!names || names.some((n) => exposure.get(n) !== "env")) await orchestrator.toolkitCaller(userId, sessionId, true);
          const handle = shards?.awakeHandle(userId);
          if (!shards || !handle) throw unavailable("Your sandbox is not running", "sandbox_unavailable");
          const given = body.env && typeof body.env === "object" && !Array.isArray(body.env) ? Object.entries(body.env as Record<string, unknown>) : [];
          const env: Record<string, string> = {};
          for (const [k, v] of given.slice(0, 512)) if (typeof v === "string" && v.length <= 32768 && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && !/^(FLOQ_AGENT_TOKEN|FLOQ_API_URL|LD_.*|NODE_OPTIONS)$/.test(k)) env[k] = v;
          const home = shards.driver.homePath(handle);
          let cwd = ".";
          if (typeof body.cwd === "string" && (body.cwd === home || body.cwd.startsWith(home + "/"))) {
            const rel = body.cwd.slice(home.length).replace(/^\/+/, "");
            if (rel && !rel.split("/").some((p) => p === ".." || p.includes("\0"))) cwd = rel;
          }
          const result = await vault.run(userId, sessionId, names, (secrets) => shards.driver.spawnPipe(handle, { file: argv[0], args: argv.slice(1), env: { ...env, ...secrets }, cwd }));
          return send(res, 200, result);
        }
        // Global vault secrets exposed as env (expose="env") for floq secret get/list; tool-only entries are never returned.
        case "secrets/global":
          return send(res, 200, { secrets: await vault.reveal(userId, null, "env", sessionId) });
        case "agents/list":
        {
          const detail = body.detail === true;
          const pending: PendingCounts = new Map();
          if (detail) {
            const bump = (id: string, key: "approvals" | "decisions") => pending.set(id, { approvals: 0, decisions: 0, ...pending.get(id), [key]: (pending.get(id)?.[key] ?? 0) + 1 });
            for (const a of approvals.list(userId)) bump(a.requester.id, "approvals");
            for (const d of decisions.list(userId)) bump(d.sessionId, "decisions");
          }
          return send(res, 200, { agents: await orchestrator.list(userId, sessionId, { project: body.project, here: body.here === true, detail, pending }) });
        }
        case "projects/create": {
          if (method !== "POST") return send(res, 405, { error: { code: "method_not_allowed", message: "Use POST" } });
          const me = await orchestrator.toolkitCaller(userId, sessionId, true);
          const input = projectCreateInput(body);
          // A project an agent creates lands in the caller's own organization (personal for scratch sessions).
          const project = await manager.createProject(userId, await settings.profile(userId), input.gitUrl, input.name, me.orgId ?? undefined);
          return send(res, 201, { project });
        }
        case "agents/link": {
          const r = await orchestrator.link(userId, sessionId, body.name);
          if (wired) for (const id of new Set(r.ids)) {
            try {
              const w = await wired.sync(userId, id);
              if (w.added.length || w.removed.length) await manager.notifyWired(userId, id, w.added, w.removed, w.block);
            } catch (error) {
              log.warn("wired.touch_failed", { sessionId: id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
            }
          }
          return send(res, 200, r);
        }
        case "ports/open": {
          // Blocks until the user answers or 60s pass. Nothing is opened here: the user's app opens the tunnel on Allow.
          const me = await orchestrator.toolkitCaller(userId, sessionId, false);
          const pendingRequest = portRequests.request(userId, { sessionId, agentName: me.name, port: body.port, protocol: body.protocol, purpose: body.purpose });
          res.once("close", () => { if (!res.writableEnded) pendingRequest.abandon(); });
          return send(res, 200, await pendingRequest.promise);
        }
        case "browser/ensure": {
          if (!browser) throw unavailable("This Floq server has no browser", "unavailable");
          const e = await browser.ensure(userId, { agentId: sessionId });
          // The one place the endpoint token leaves the runtime: to the user's own agent, over its own authenticated internal channel.
          return sendPlain(res, 200, e);
        }
        case "browser/status":
          return send(res, 200, browser ? await browser.status(userId, { profileBytes: true }) : { state: "unavailable", agents: 0, tabs: 0, version: null, profile: "~/.floq/browser/profile" });
        case "browser/restart": {
          if (!browser) throw unavailable("This Floq server has no browser", "unavailable");
          return send(res, 200, await browser.restart(userId));
        }
        case "display/status": {
          const status = displayStatus(manager.displays.get(sessionId), await listSessionPorts(manager.getLive(sessionId, userId).pid, manager.inNetns(userId)));
          return send(res, 200, { running: status.running, port: status.port });
        }
        case "display/prepare": {
          // Before `floq display start`: probe the display port (other users share the netns and may squat it) and
          // move this session's lease to a free spare port when needed. The CLI binds the port returned here.
          const liveSession = manager.getLive(sessionId, userId);
          const lease = manager.displays.get(sessionId);
          if (!lease) throw new HttpError(409, "display_unavailable", "This session has no display slot");
          // Per-user netns: probe INSIDE the user's namespace (the host's ports are irrelevant there).
          const port = await manager.displays.ensureFreePort(sessionId, manager.inNetns(userId) ? portIsFreeInNetns(liveSession.pid) : undefined);
          if (port === null) throw new HttpError(503, "display_port_unavailable", "No free display port on this server right now");
          return send(res, 200, { display: ":" + lease.display, port });
        }
        case "display/started": {
          // `floq display start` announces the running display; the user's app shows it in the App window panel.
          const lease = manager.displays.get(sessionId);
          if (!lease) throw new HttpError(409, "display_unavailable", "This session has no display slot");
          const status = displayStatus(lease, await listSessionPorts(manager.getLive(sessionId, userId).pid, manager.inNetns(userId)));
          if (!status.running) throw new HttpError(409, "display_not_running", "Nothing listens on the display port " + lease.port + " yet");
          manager.displays.announce(userId, sessionId);
          return send(res, 200, { announced: true, port: lease.port });
        }
        case "decisions/request": {
          await decisionsReady;
          const { requester } = await orchestrator.approvalParties(userId, sessionId, undefined);
          return send(res, 200, await decisions.request(userId, { sessionId, projectId: requester.projectId, sessionName: requester.name, questions: body.questions, ttlMs: body.ttlMs, wait: body.wait === true }));
        }
        case "decisions/native-request": {
          await decisionsReady;
          const { requester } = await orchestrator.approvalParties(userId, sessionId, undefined);
          if (requester.provider !== "claude" || typeof body.providerRequestId !== "string" || !body.providerRequestId || body.providerRequestId.length > 256) throw badRequest("Invalid native request");
          return send(res, 200, await decisions.request(userId, { sessionId, projectId: requester.projectId, sessionName: requester.name, questions: body.questions, ttlMs: body.ttlMs, wait: true, source: "native", provider: "claude", providerRequestId: body.providerRequestId, answerMode: "hook" }));
        }
        case "notifications/create": {
          // One-way: never waits for the user. Persisted and pushed to the user's app; returns the id immediately.
          const { requester } = await orchestrator.approvalParties(userId, sessionId, undefined);
          const n = await notifications.create(userId, { title: body.title, body: body.body, level: body.level, category: body.category, action: body.action, projectId: requester.projectId, sessionId, sessionName: requester.name });
          return send(res, 200, { id: n.id, notification: n });
        }
        case "decisions/status": return send(res, 200, await decisions.status(userId, sessionId, body.id, Math.max(0, Number(body.waitSec) || 0) * 1000));
        case "decisions/cancel": return send(res, 200, await decisions.cancel(userId, sessionId, body.id));
        case "approvals/request": {
          const parties = await orchestrator.approvalParties(userId, sessionId, body.target);
          return send(res, 200, await approvals.request(userId, { requester: parties.requester, target: parties.target, action: body.action, detail: body.detail, ttlSec: body.timeoutSec, waiting: body.wait === true }));
        }
        case "approvals/native-request": {
          // Claude Code's own permission prompt (safety checks that bypass mode does not skip), routed to the island by the PermissionRequest hook.
          const parties = await orchestrator.approvalParties(userId, sessionId, undefined);
          if (parties.requester.provider !== "claude") throw badRequest("Invalid native request");
          return send(res, 200, await approvals.request(userId, { requester: parties.requester, target: parties.target, action: body.action, detail: body.detail, waiting: true, silent: true }));
        }
        case "approvals/status":
          return send(res, 200, await approvals.status(userId, sessionId, body.id, Math.max(0, Number(body.waitSec) || 0) * 1000));
        case "approvals/verify":
          return send(res, 200, await approvals.verify(userId, sessionId, body.id, { consume: body.consume === true, action: body.action }));
        case "approvals/cancel":
          return send(res, 200, await approvals.cancel(userId, sessionId, body.id));
        case "agents/restart": {
          if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Session restart requires POST");
          if (Object.keys(body).length) throw badRequest("Session restart takes no target or options; it can only restart the calling agent", "invalid_restart");
          await orchestrator.toolkitCaller(userId, sessionId, false);
          await manager.assertSelfRestartable(userId, sessionId);
          const profile = await settings.profile(userId);
          const restartKey = userId + ":" + sessionId;
          if (scheduledAgentRestarts.has(restartKey)) return send(res, 202, { scheduled: true, restartDelayMs: SELF_RESTART_DELAY_MS });
          scheduledAgentRestarts.add(restartKey);
          let responseFinished = false;
          res.once("finish", () => {
            responseFinished = true;
            const timer = setTimeout(() => {
              void manager.restartSelf(userId, profile, sessionId)
                .then(() => log.info("agent.self_restart_complete", { userId, sessionId }))
                .catch((error) => log.error("agent.self_restart_failed", { userId, sessionId, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }))
                .finally(() => scheduledAgentRestarts.delete(restartKey));
            }, SELF_RESTART_DELAY_MS);
            timer.unref();
          });
          res.once("close", () => { if (!responseFinished) scheduledAgentRestarts.delete(restartKey); });
          return send(res, 202, { scheduled: true, restartDelayMs: SELF_RESTART_DELAY_MS });
        }
        case "agents/models": {
          const requested = body.provider;
          if (requested !== undefined && requested !== "claude" && requested !== "codex" && requested !== "opencode" && requested !== "antigravity") throw badRequest("provider must be claude, codex, opencode or antigravity");
          return send(res, 200, {
            models: await selectableAgentModels(config, (id) => manager.codexModels(id), userId, requested),
          });
        }
        case "agents/roles":
          return send(res, 200, { roles: listAgentRoles() });
        case "agents/role": {
          const role = typeof body.id === "string" ? getAgentRole(body.id) : undefined;
          if (!role) throw notFound("Unknown role; run `floq roles` for the list (" + AGENT_ROLES.map((r) => r.id).join(", ") + ")");
          return send(res, 200, { role, text: describeRole(role) });
        }
        case "agents/ask":
          return send(res, 200, await orchestrator.ask(userId, sessionId, body.name, body.prompt, Number(body.timeoutSec) || undefined, body.wait !== false, Number(body.chars) || undefined, body.full === true));
        case "inbox/list":
          return send(res, 200, await orchestrator.inboxList(userId, sessionId));
        case "inbox/read":
          return send(res, 200, await orchestrator.inboxRead(userId, sessionId, body.id));
        case "agents/check":
          return send(res, 200, await orchestrator.check(userId, sessionId, body.name, Number(body.chars) || undefined, body.full === true));
        case "agents/wait":
          return send(res, 200, await orchestrator.wait(userId, sessionId, body.name, Number(body.timeoutSec) || undefined, Number(body.chars) || undefined, body.full === true));
        case "agents/progress":
          return send(res, 200, await orchestrator.reportProgress(userId, sessionId, body));
        case "agents/watch":
          return send(res, 200, await orchestrator.watch(userId, sessionId, body.name, body.since, Number(body.waitSec) || undefined, body.reply === true));
        case "agents/connect":
          return send(res, 200, await orchestrator.connect(userId, sessionId, body.from, body.to));
        case "agents/recruit": {
          const policy = recruitFallbackPolicy(body.fallback);
          const recruited = await orchestrator.recruit(userId, sessionId, body);
          await applyRecruitFallback(userId, recruited, policy);
          return send(res, 200, recruited);
        }
        // Always-recruit subagents (`floq subagent ...`): any agent session may use them; limits are enforced in SubagentService.
        case "agents/subagent/recruit": {
          const policy = recruitFallbackPolicy(body.fallback);
          const recruited = await requireSubagents().recruit(userId, sessionId, body);
          await applyRecruitFallback(userId, recruited, policy);
          return send(res, 200, recruited);
        }
        case "agents/subagent/list":
          return send(res, 200, await requireSubagents().list(userId, sessionId));
        case "agents/subagent/ask":
          return send(res, 200, await requireSubagents().ask(userId, sessionId, body.id, body.prompt, Number(body.timeoutSec) || undefined, body.wait !== false));
        case "agents/subagent/result":
          return send(res, 200, await requireSubagents().result(userId, sessionId, body.id, Number(body.chars) || undefined, body.full === true));
        case "agents/subagent/dismiss":
          return send(res, 200, await requireSubagents().dismiss(userId, sessionId, body.id));
        case "agents/dismiss":
          return send(res, 200, await orchestrator.dismiss(userId, sessionId, body.name));
        // Skills, MCP servers and secrets (`floq skills|mcp|secrets`). Reading is open to any agent session of this user;
        // changing anything needs a lead session. Plain shell sessions are refused like for `floq list` (not an agent).
        case "skills/list": {
          const me = await orchestrator.toolkitCaller(userId, sessionId, false);
          if (body.scope === "project" || (body.scope === undefined && typeof body.projectId === "string")) {
            const projectId = typeof body.projectId === "string" ? body.projectId : me.projectId;
            if (!projectId) throw badRequest("This session is not in a registered project; pass --project <ID>", "no_project");
            await orchestrator.assertProjectInCallerOrg(userId, me, projectId);
            return send(res, 200, { scope: "project", projectId, ...(await skills.listProject(userId, projectId)) });
          }
          return send(res, 200, { scope: "global", ...(await skills.list(userId)) });
        }
        case "skills/search":
          await orchestrator.toolkitCaller(userId, sessionId, false);
          return send(res, 200, await searchSkillCatalog(body.query, 20));
        case "skills/preview":
          await orchestrator.toolkitCaller(userId, sessionId, false);
          return send(res, 200, await previewCatalogSkill({ source: body.source, skillId: body.skillId, url: body.url }));
        case "skills/add": {
          const me = await orchestrator.toolkitCaller(userId, sessionId, true);
          const target = await toolkitScope(userId, body, me);
          const result = await importCatalogSkill(userId, target, { provider: body.provider ?? toolkitProvider(me.provider), source: body.source, skillId: body.skillId, url: body.url });
          return send(res, 200, { ...result, ...target });
        }
        case "skills/create": {
          // A dry run only validates and describes, so any agent session may do it; creating needs a lead.
          const me = await orchestrator.toolkitCaller(userId, sessionId, body.dryRun !== true);
          const target = await toolkitScope(userId, body, me);
          const result = await skills.createSkill(userId, { ...target, provider: body.provider ?? toolkitProvider(me.provider), name: body.name, description: body.description, instructions: body.instructions, files: body.files, dryRun: body.dryRun });
          return send(res, 200, { ...result, ...target });
        }
        case "skills/remove":
          await orchestrator.toolkitCaller(userId, sessionId, true);
          return send(res, 200, await skills.removeSkillByName(userId, body.name, body.provider));
        case "mcp/list": {
          const me = await orchestrator.toolkitCaller(userId, sessionId, false);
          const target = await toolkitScope(userId, body, me);
          const provider = body.provider;
          if (provider !== undefined && provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex");
          return send(res, 200, { ...target, ...(await skills.listMcp(userId, target.scope, target.projectId, provider)) });
        }
        case "mcp/add": {
          // A dry run only validates and describes what would run, so it needs no lead.
          const me = await orchestrator.toolkitCaller(userId, sessionId, body.dryRun !== true);
          const target = await toolkitScope(userId, body, me);
          return send(res, 200, { ...target, ...(await installMcp(userId, sessionId, { ...target, providers: body.providers ?? toolkitProvider(me.provider), config: body.config, name: body.name, dryRun: body.dryRun, allowPlaintext: body.allowPlaintext }, false)) });
        }
        case "mcp/remove": {
          const me = await orchestrator.toolkitCaller(userId, sessionId, true);
          const target = await toolkitScope(userId, body, me);
          return send(res, 200, { ...target, ...(await skills.removeMcp(userId, { ...target, provider: body.provider ?? toolkitProvider(me.provider), name: body.name })) });
        }
        case "wired/get": {
          if (!wired) return send(res, 200, { block: "" });
          const { block } = await wired.sync(userId, sessionId);
          return send(res, 200, { block });
        }
        case "memory/add": case "memory/update": case "memory/forget": case "memory/search": case "memory/list": case "memory/get": {
          if (!memories?.enabled()) throw memoryOff();
          const ctx = await memories.ctxForSession(userId, sessionId);
          // Agent-facing: every free-text field is defanged so a memory cannot forge Floq's own markers.
          const reply = (payload: unknown) => send(res, 200, defangMemories(payload));
          switch (path) {
            case "memory/add": return reply(await memories.add(ctx, body));
            case "memory/update": return reply(await memories.update(ctx, body.id, { text: body.text, title: body.title, type: body.type, pinned: body.pinned }));
            case "memory/forget": return reply(await memories.forget(ctx, body.id, body.reason));
            case "memory/search": return reply(await memories.search(ctx, { query: body.query, type: body.type, k: body.k }));
            case "memory/list": return reply({ memories: await memories.list(ctx, { type: body.type, pinned: body.pinned, limit: body.limit }) });
            default: return reply(await memories.get(ctx, body.id));
          }
        }
        case "notes/list":
          return send(res, 200, await orchestrator.noteList(userId));
        case "notes/read":
          return send(res, 200, await orchestrator.noteRead(userId, body.name));
        case "sticky/list":
          return send(res, 200, { notes: await notes.agentList(userId, sessionId) });
        case "sticky/read":
          return send(res, 200, await notes.agentRead(userId, sessionId, body.id));
        case "sticky/write": {
          const note = await notes.agentWrite(userId, sessionId, body.id, body.text, body.append === true);
          await touchProjectNote(note);
          return send(res, 200, note);
        }
        case "sticky/create": {
          const note = await notes.agentCreate(userId, sessionId, body);
          await touchProjectNote(note);
          return send(res, 200, note);
        }
        case "sticky/delete": {
          const { note, sessionIds } = await notes.agentDelete(userId, sessionId, body.id);
          await touchSessions([...sessionIds, ...(note.kind === "note" ? [] : await notes.sharedNoteSessionIds(userId, note))]);
          return send(res, 200, { ok: true });
        }
        case "notes/delete": {
          await notes.requireAgentNoteAccess(userId, sessionId, body.name);
          const { sessionIds } = await notes.agentNoteDelete(userId, body.name);
          await touchSessions(sessionIds);
          return send(res, 200, { ok: true });
        }
        case "notes/write": {
          await notes.requireAgentNoteAccess(userId, sessionId, body.name);
          const written = await orchestrator.noteWrite(userId, body.name, body.content, body.append === true);
          // Show the note on the writing agent's project canvas, wired to it. Never fail the write over the mirror.
          if (typeof body.name === "string") await notes.mirrorAgentNote(userId, sessionId, body.name).catch((e) => log.warn("note.mirror.failed", { userId, error: String(e) }));
          return send(res, 200, written);
        }
        default:
          throw notFound();
      }
    }

    if (!originAllowed(req.headers.origin)) throw forbidden();

    if (url.pathname.startsWith("/api/auth/")) {
      // Logging out puts the user's terminals and shard to sleep.
      normalizeAuthForwardedHeaders(req);
      let signingOut: string | null = null;
      let signingOutSession = "";
      if (url.pathname === "/api/auth/sign-out") {
        const who = await authFor(req.headers).catch(() => null);
        signingOut = who?.userId ?? null;
        signingOutSession = who?.authSessionId ?? "";
        if (who) { downloadLinks.revokeSession(who.authSessionId); downloadLinks.revokeUser(who.userId); davMounts.revokeSession(who.authSessionId); davMounts.revokeUser(who.userId); }
      }
      await authHandler(req, res);
      if (signingOut) closeLivePeers((peer) => peer.authSessionId === signingOutSession || peer.userId === signingOut);
      else if (req.method === "POST") void revalidatePeers();
      if (signingOut) {
        void manager.sleepUser(signingOut, "logout").catch((error) =>
          log.error("logout.sleep_failed", { userId: signingOut, error: String(error) }),
        );
      }
      return;
    }

    if (method === "POST" && (url.pathname === "/v1/setup/lookup" || url.pathname === "/v1/setup/admin")) {
      rateLimitSetup(req);
      const body = await readJson<{ email?: unknown; password?: unknown; name?: unknown; companyName?: unknown; setupToken?: unknown }>(req);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (url.pathname === "/v1/setup/lookup") {
        // Claimable state is revealed only to someone who already holds the setup token.
        return send(res, 200, { step: await setupLookupStep(pool, config, setupToken, email, body.setupToken) });
      }
      const password = body.password;
      if (typeof password !== "string" || password.length < 12 || password.length > 128) {
        throw badRequest("password must be 12-128 characters");
      }
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Admin";
      if (name.length > 100) throw badRequest("Name must be 100 characters or fewer");
      if (body.companyName !== undefined && typeof body.companyName !== "string") throw badRequest("Company name must be text");
      const companyName = typeof body.companyName === "string" ? body.companyName.trim() : undefined;
      if ((companyName?.length ?? 0) > 80) throw badRequest("Company name must be 80 characters or fewer");
      if (!(await createBootstrapAdmin(auth, pool, config, email, password, name, companyName, setupToken, body.setupToken))) {
        // Same answer for: no such bootstrap account, already claimed, missing/wrong/used token.
        throw new HttpError(403, "setup_unavailable", "Setup is not available, or the setup token is missing, wrong or already used");
      }
      return send(res, 200, { ok: true });
    }

    if (method === "POST" && url.pathname === "/v1/organization-invitations/register") {
      rateLimitSetup(req);
      const body = await readJson<{ token?: unknown; email?: unknown; name?: unknown; password?: unknown }>(req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const password = body.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address");
      if (!name || name.length > 100) throw badRequest("Name must be 1-100 characters");
      if (typeof password !== "string" || password.length < 12 || password.length > 128) throw badRequest("Password must be 12-128 characters", "invalid_password");
      const context = await auth.$context;
      const registered = await registerWithInvitation(pool, { token, email, name, password }, (value) => context.password.hash(value), config.bootstrapAdminEmail);
      return send(res, 201, { ok: true, organizationId: registered.organizationId });
    }

    // Native downloads: authorised by a signed single-use link instead of a bearer header (see downloadLinks.ts).
    const downloadMatch = /^\/v1\/sessions\/([\w-]+)\/files\/download$/.exec(url.pathname);
    if (downloadMatch && method === "GET") {
      if (!workspaceFiles) throw notFound();
      const claims = downloadLinks.redeem(url.searchParams.get("t"), "ws");
      if (!claims || claims.s !== downloadMatch[1]) throw new HttpError(401, "invalid_download_link", "This download link has expired. Try again.");
      return workspaceFiles.download(claims.u, claims.s, claims.p, res, typeof req.headers.range === "string" ? req.headers.range : undefined);
    }

    const artifactDownload = /^\/v1\/sessions\/([\w-]+)\/artifacts\/download$/.exec(url.pathname);
    if (artifactDownload && method === "GET") {
      if (!artifacts) throw notFound();
      const claims = downloadLinks.redeem(url.searchParams.get("t"), "art");
      if (!claims || claims.s !== artifactDownload[1]) throw new HttpError(401, "invalid_download_link", "This download link has expired. Try again.");
      return artifacts.download(claims.u, claims.s, claims.p, res, typeof req.headers.range === "string" ? req.headers.range : undefined);
    }

    const hookMatch = plugins && method === "POST" ? /^\/v1\/plugins\/([a-z][a-z0-9-]*)\/hooks\/([a-z][a-z0-9-]*)\/([A-Za-z0-9_-]{16,128})$/.exec(url.pathname) : null;
    if (plugins && hookMatch) {
      // Unauthenticated by design: the install token in the path is the credential (see PluginHost.handleWebhook).
      const result = await plugins.handleWebhook({
        pluginId: hookMatch[1], name: hookMatch[2], token: hookMatch[3], ip: clientIp(req), query: url.searchParams, headers: req.headers,
        readRaw: async () => {
          const declared = Number(req.headers["content-length"]);
          if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large");
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { size += (chunk as Buffer).length; if (size > WEBHOOK_MAX_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large"); chunks.push(chunk as Buffer); }
          return Buffer.concat(chunks);
        },
      });
      return send(res, 200, result);
    }

    const { userId, authSessionId } = await authFor(req.headers);
    davMounts.touch(userId);
    // The organization this app request acts in (X-Floq-Organization, default: personal). Resolved lazily so organization
    // routes still work with a stale header; agent/CLI bearer-token routes never read it.
    const orgHeader = req.headers["x-floq-organization"];
    let activeOrgPromise: Promise<string> | undefined;
    const activeOrg = () => (activeOrgPromise ??= organizations.resolveActive(userId, Array.isArray(orgHeader) ? orgHeader[0] : orgHeader));

    if (plugins && (url.pathname === "/v1/plugins" || url.pathname.startsWith("/v1/plugins/") || url.pathname === "/v1/task-sources" || url.pathname.startsWith("/v1/task-sources/"))) {
      const result = await plugins.handle({
        userId, method, pathname: url.pathname, query: url.searchParams,
        readBody: (limit?: number) => (method === "POST" || method === "PUT" ? readJson<unknown>(req, limit) : Promise.resolve(undefined)),
        requireAdmin: () => requireAdmin(pool, config.bootstrapAdminEmail, userId),
      });
      if (result?.raw) {
        res.writeHead(result.status, { "Content-Type": result.raw.contentType, "Content-Length": Buffer.byteLength(result.raw.text), "Cache-Control": "no-store", ...(result.raw.headers ?? {}) });
        res.end(result.raw.text);
        return;
      }
      if (result?.status === 204) { res.writeHead(204, { "Cache-Control": "no-store" }); res.end(); return; }
      if (result) return send(res, result.status, result.body);
    }

    if (url.pathname.startsWith("/v1/admin/") || url.pathname === "/v1/me/role") {
      if (url.pathname === "/v1/me/role" && method === "GET") return send(res, 200, { role: await getRole(pool, config.bootstrapAdminEmail, userId) });
      await requireAdmin(pool, config.bootstrapAdminEmail, userId);
      if (url.pathname === "/v1/admin/updates" && method === "GET") return send(res, 200, await updates.check(url.searchParams.get("refresh") === "1"));
      if (url.pathname === "/v1/admin/updates/apply" && method === "POST") return send(res, 200, await updates.apply(userId, await readJson<{ target?: unknown; force?: unknown }>(req)));
      if (url.pathname === "/v1/admin/users" && method === "GET") return send(res, 200, { users: await listUsers(pool) });
      const userRoleMatch = /^\/v1\/admin\/users\/([\w-]+)$/.exec(url.pathname);
      if (userRoleMatch && method === "PATCH") {
        const body = await readJson<{ role?: unknown }>(req);
        return send(res, 200, await setUserRole(pool, userId, userRoleMatch[1], requireRoleValue(body.role)));
      }
      throw notFound();
    }

    if (method === "GET" && url.pathname === "/v1/info") {
      const providers = listProviders(config);
      if (!config.codexModelsOverridden) {
        const codex = providers.find((provider) => provider.id === "codex");
        if (codex) {
          codex.models = [
            { id: "default", label: "Default", description: "Uses the CLI's default model", default: true },
            ...(await manager.codexModels(userId)),
          ];
        }
      }
      // Antigravity authenticates with a Google login (token file agy keeps in the home) or GEMINI_API_KEY from the vault: tell the UI.
      const antigravity = providers.find((provider) => provider.id === "antigravity");
      if (antigravity) {
        const names = new Set((await vault.list(userId).catch(() => [])).filter((secret) => secret.expose === "env").map((secret) => secret.name));
        antigravity.needsApiKey = "GEMINI_API_KEY";
        antigravity.apiKeyConfigured = names.has("GEMINI_API_KEY");
        antigravity.oauthConnected = await agyConnected(userId);
      }
      return send(res, 200, {
        server: info(),
        providers,
        githubConfigured: Boolean(config.githubClientId),
      });
    }

    // Read-only preview of the fixed subagent policy for Settings (the text is not editable by design).
    if (method === "GET" && url.pathname === "/v1/subagents/policy") {
      const limits = await requireSubagents().limitsFor(userId);
      return send(res, 200, { enabled: (await settings.get(userId)).alwaysRecruitSubagents, limits, tools: TOOL_SPECS, instruction: buildSubagentInstruction({ enabled: true, depth: 0, limits, crossProject: (await settings.get(userId)).allowCrossProjectAgents }) });
    }
    // Agent browser (docs/design/agent-browser.md §A.5): status, restart, clear profile. Always about the caller's own browser.
    if (url.pathname === "/v1/browser" && method === "GET") {
      return send(res, 200, browser ? await browser.status(userId, { profileBytes: true }) : { state: "unavailable", agents: 0, tabs: 0, version: null, profile: "~/.floq/browser/profile" });
    }
    if (url.pathname === "/v1/browser/restart" && method === "POST") {
      if (!browser) throw unavailable("This Floq server has no browser", "unavailable");
      return send(res, 200, await browser.restart(userId, { wake: true }));
    }
    if (url.pathname === "/v1/browser/egress/override" && method === "POST") {
      if (!browser) throw unavailable("This Floq server has no browser", "unavailable");
      const body = await readJson<{ server?: unknown }>(req);
      if (typeof body.server !== "boolean") throw badRequest("server must be a boolean");
      await browser.setEgressOverride(userId, body.server);
      return send(res, 200, browser.egress ? await browser.egressStatus(userId) : {});
    }
    if (url.pathname === "/v1/browser/clear-data" && method === "POST") {
      if (!browser) throw unavailable("This Floq server has no browser", "unavailable");
      const body = await readJson<{ confirm?: unknown }>(req);
      if (body.confirm !== "clear") throw badRequest("Send {\"confirm\":\"clear\"} to remove the browser profile", "confirm_required");
      return send(res, 200, await browser.clearData(userId));
    }
    // Cookie / bookmark import and managed list (docs/design/agent-browser.md §A.13). Bodies hold cookie files: 7 MiB cap, never logged.
    if (url.pathname.startsWith("/v1/browser/import/") || url.pathname === "/v1/browser/data" || url.pathname === "/v1/browser/data/remove") {
      if (!browser || !browserImport) throw unavailable("This Floq server has no browser", "unavailable");
      await browser.assertAllowed(userId); // the toggle gates import, list and remove too, not only the live browser
      if (url.pathname === "/v1/browser/import/preview" && method === "POST") return send(res, 200, browserImport.preview(userId, (await readJson<{ content?: unknown }>(req, 7 * 1024 * 1024)).content));
      if (url.pathname === "/v1/browser/import/commit" && method === "POST") return send(res, 200, await browserImport.commit(userId, await readJson(req)));
      if (url.pathname === "/v1/browser/data" && method === "GET") return send(res, 200, await browserImport.list(userId));
      if (url.pathname === "/v1/browser/data/remove" && method === "POST") return send(res, 200, await browserImport.removeDomain(userId, (await readJson<{ domain?: unknown }>(req)).domain));
    }
    if (url.pathname === "/v1/settings") {
      if (method === "GET") return send(res, 200, { settings: await settings.get(userId) });
      if (method === "PATCH" || method === "PUT") {
        const body = await readJson<SettingsPatch>(req);
        if (body.claudeAiConnectors !== undefined) claudeConnectors.invalidate(userId);
        const updated = await settings.update(userId, body);
        // The toggle changed: stop a running browser when it went off and fix the floq-browser MCP entries, without holding up the response.
        if (browser && body.agentBrowserEgress !== undefined) void browser.setEgressOverride(userId, false).catch(() => undefined);
        if (browser && (body.agentBrowser !== undefined || body.agentBrowserEgress !== undefined)) void browser.onToggle(userId).catch((error) => log.warn("browser.toggle_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
        return send(res, 200, { settings: updated });
      }
    }

    const organizationRoute = await routeOrganizations({
      service: organizations, userId, method, pathname: url.pathname, query: url.searchParams, readJson: () => readJson(req),
      headers: { contentType: req.headers["content-type"], ifNoneMatch: req.headers["if-none-match"] },
      readRaw: async (limit) => {
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, "image_too_large", `The image must be ${limit / 1024} KB or smaller`);
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += (chunk as Buffer).length; if (size > limit) throw new HttpError(413, "image_too_large", `The image must be ${limit / 1024} KB or smaller`); chunks.push(chunk as Buffer); }
        return Buffer.concat(chunks);
      },
    });
    if (organizationRoute?.raw) {
      const { raw } = organizationRoute;
      res.writeHead(organizationRoute.status, { "Content-Type": raw.contentType, "Content-Length": raw.data.length, ...raw.headers });
      res.end(raw.data);
      return;
    }
    if (organizationRoute) {
      if (method !== "GET") void revalidatePeers(); // removal / leave: drop board sockets of members that lost access
      return send(res, organizationRoute.status, organizationRoute.body);
    }
    const organizationMatch = /^\/v1\/organizations\/([\w-]+)\/(boards)$/.exec(url.pathname);
    if (organizationMatch) {
      const [, organizationId, action] = organizationMatch;
      if (action === "boards" && method === "GET") return send(res, 200, { boards: await tasks.boards(userId, organizationId) });
      if (action === "boards" && method === "POST") {
        const board = await tasks.createBoard(userId, organizationId, await readJson(req));
        return send(res, 201, { board });
      }
    }
    const boardMatch = /^\/v1\/task-boards\/([\w-]+)(?:\/(lists|cards)(?:\/([\w-]+))?)?$/.exec(url.pathname);
    if (boardMatch) {
      const [, boardId, section, childId] = boardMatch;
      if (!section && method === "GET") return send(res, 200, { board: await tasks.board(userId, boardId) });
      if (!section && method === "PATCH") {
        await tasks.renameBoard(userId, boardId, (await readJson<{ title?: unknown }>(req)).title);
        await broadcastTaskBoard(boardId);
        return send(res, 200, { ok: true });
      }
      if (!section && method === "DELETE") { await tasks.deleteBoard(userId, boardId); return send(res, 200, { ok: true }); }
      if (section === "lists" && method === "POST") {
        await tasks.saveList(userId, boardId, await readJson(req));
        await broadcastTaskBoard(boardId);
        return send(res, 201, { ok: true });
      }
      if (section === "lists" && childId && method === "PATCH") {
        await tasks.saveList(userId, boardId, await readJson(req), childId);
        await broadcastTaskBoard(boardId);
        return send(res, 200, { ok: true });
      }
      if (section === "lists" && childId && method === "DELETE") {
        await tasks.deleteList(userId, boardId, childId);
        await broadcastTaskBoard(boardId);
        return send(res, 200, { ok: true });
      }
      if (section === "cards" && method === "POST") {
        await tasks.saveCard(userId, boardId, await readJson(req));
        await broadcastTaskBoard(boardId);
        return send(res, 201, { ok: true });
      }
      if (section === "cards" && childId && method === "PATCH") {
        await tasks.saveCard(userId, boardId, await readJson(req), childId);
        await broadcastTaskBoard(boardId);
        return send(res, 200, { ok: true });
      }
      if (section === "cards" && childId && method === "DELETE") {
        await tasks.deleteCard(userId, boardId, childId);
        await broadcastTaskBoard(boardId);
        return send(res, 200, { ok: true });
      }
    }

    // Org scoping for every user route that names a project: a project of another organization is a 404, never a 403.
    // PATCH /v1/projects/:id is exempt: a move is allowed from any of the owner's organizations and checks itself.
    const scopedProject = /^\/v1\/projects\/([\w-]+)(?:\/|$)/.exec(url.pathname);
    if (scopedProject && scopedProject[1] !== "none" && !(method === "PATCH" && url.pathname === `/v1/projects/${scopedProject[1]}`)) {
      await manager.requireProject(userId, await activeOrg(), scopedProject[1]);
    }
    const queryProject = url.searchParams.get("projectId");
    if (queryProject && url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v1/agent/")) await manager.requireProject(userId, await activeOrg(), queryProject);

    if (url.pathname === "/v1/skills" && method === "GET") {
      const userId = await userFor(req.headers);
      return send(res, 200, await skills.list(userId));
    }
    if (url.pathname === "/v1/skills/files" && method === "GET") {
      const q = url.searchParams;
      return send(res, 200, await skills.readSkillFiles(userId, {
        scope: q.get("scope") ?? undefined, projectId: q.get("projectId") ?? undefined, provider: q.get("provider") ?? undefined,
        source: q.get("source") ?? undefined, location: q.get("location") ?? undefined, path: q.get("path") ?? undefined,
      }));
    }
    if (url.pathname === "/v1/skills" && method === "DELETE") {
      const q = url.searchParams;
      return send(res, 200, await skills.deleteSkill(userId, { provider: q.get("provider") ?? undefined, location: q.get("location") ?? undefined }));
    }
    const projectSkillsMatch =/^\/v1\/projects\/([\w-]+)\/skills$/.exec(url.pathname);
    if (projectSkillsMatch) {
      if (method === "GET") {
        const provider = url.searchParams.get("provider");
        if (provider !== null && provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex");
        return send(res, 200, await skills.listProject(userId, projectSkillsMatch[1], provider as "claude" | "codex" | undefined));
      }
      if (method === "POST") {
        const body = await readJson<{ provider?: unknown; name?: unknown; description?: unknown; instructions?: unknown }>(req);
        return send(res, 201, await skills.addProjectSkill(userId, projectSkillsMatch[1], body));
      }
    }
      if (url.pathname === "/v1/skills/catalog/search" && method === "GET") {
        return send(res, 200, await searchSkillCatalog(url.searchParams.get("q"), url.searchParams.get("limit") ?? undefined));
      }
      if (url.pathname === "/v1/skills/catalog/preview" && method === "GET") {
        const source = url.searchParams.get("source") ?? undefined;
        const skillId = url.searchParams.get("skillId") ?? undefined;
        const externalUrl = url.searchParams.get("url") ?? undefined;
        return send(res, 200, await previewCatalogSkill({ source, skillId, url: externalUrl }));
      }
      const projectSkillImport = /^\/v1\/projects\/([\w-]+)\/skills\/import$/.exec(url.pathname);
      if (projectSkillImport && method === "POST") {
        return send(res, 201, await importCatalogSkill(userId, projectSkillImport[1], await readJson(req)));
      }
    if (url.pathname === "/v1/mcp" && method === "POST") {
      const body = await readJson<Record<string, unknown>>(req);
      if (typeof body.projectId === "string" && body.projectId) await manager.requireProject(userId, await activeOrg(), body.projectId);
      return send(res, 201, await installMcp(userId, null, body, true));
    }
    if (url.pathname === "/v1/mcp" && method === "DELETE") {
      const q = url.searchParams;
      return send(res, 200, await skills.removeMcp(userId, { scope: q.get("scope") ?? undefined, projectId: q.get("projectId") ?? undefined, provider: q.get("provider") ?? undefined, name: q.get("name") ?? undefined }));
    }
    if (url.pathname === "/v1/mcp" && method === "GET") {
      const scope = url.searchParams.get("scope") ?? "global";
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const provider = url.searchParams.get("provider");
      if (scope !== "global" && scope !== "project") throw badRequest("scope must be global or project");
      if (provider !== null && provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex");
      return send(res, 200, await skills.listMcp(userId, scope, projectId, provider as "claude" | "codex" | undefined));
    }

    if (url.pathname === "/v1/vault" && method === "GET") return send(res, 200, { secrets: await vault.list(userId) });
    // Create-only (never overwrites): used by the MCP dialog for a secret the user types in.
    if (url.pathname === "/v1/vault" && method === "POST") return send(res, 201, { secrets: await vault.create(userId, null, await readJson(req)) });
    const secretMatch = /^\/v1\/vault\/([A-Z][A-Z0-9_]{0,63})$/.exec(url.pathname);
    if (secretMatch) {
      if (method === "PATCH") {
        const body = await readJson<PatchSecret>(req);
        return send(res, 200, { secrets: await vault.patch(userId, secretMatch[1], body) });
      }
      if (method === "PUT") {
        const body = await readJson<PutSecret>(req);
        return send(res, 200, { secrets: await vault.put(userId, secretMatch[1], body) });
      }
      if (method === "DELETE") {
        await vault.remove(userId, secretMatch[1]);
        return send(res, 200, { secrets: await vault.list(userId) });
      }
    }

    if (url.pathname === "/v1/github/repos" && method === "GET") {
      const page = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("page"))) || 1));
      return send(res, 200, await github.repos(userId, url.searchParams.get("q") ?? "", page));
    }

    if (url.pathname === "/v1/github/device/start" && method === "POST") {
      return send(res, 200, await github.start(userId));
    }
    if (url.pathname === "/v1/github/device/poll" && method === "POST") {
      const body = await readJson<{ flowId?: string }>(req);
      return send(res, 200, await github.poll(userId, body.flowId));
    }
    if (url.pathname === "/v1/github" && method === "DELETE") {
      await settings.removeGithub(userId);
      return send(res, 200, { ok: true });
    }

    if (method === "GET" && url.pathname === "/v1/providers/status") {
      return send(res, 200, await providersStatus(userId));
    }
    if (method === "GET" && url.pathname === "/v1/providers/usage") {
      const all = await usage.get(userId);
      if (claudeAccounts && all.claude) {
        const accounts = await claudeAccounts.list(userId).catch(() => []);
        const active = accounts.find((a) => a.active);
        if (accounts.length > 1 && active && active.slot !== "primary") all.claude = { ...all.claude, accountLabel: active.label };
      }
      return send(res, 200, all);
    }
    if (method === "GET" && url.pathname === "/v1/claude/connectors") {
      if (url.searchParams.get("refresh") === "1") claudeConnectors.invalidate(userId, { minAgeMs: 5_000 });
      return send(res, 200, await claudeConnectors.get(userId));
    }
    if (method === "POST" && url.pathname === "/v1/providers/claude/oauth/start") {
      return send(res, 200, claudeOauth.start(userId));
    }
    if (method === "POST" && url.pathname === "/v1/providers/claude/oauth/finish") {
      const body = await readJson<{ flowId?: unknown; code?: unknown; addAccount?: unknown; label?: unknown }>(req);
      return send(res, 200, await claudeOauth.finish(userId, body.flowId, body.code, { addAccount: body.addAccount === true, label: body.label }));
    }
    // Extra Claude logins (fallback account step). Per user; agents have no route to these.
    if (claudeAccounts && url.pathname === "/v1/providers/claude/accounts" && method === "GET") {
      return send(res, 200, { accounts: await claudeAccounts.list(userId) });
    }
    const accountMatch = /^\/v1\/providers\/claude\/accounts\/([\w]+?)(\/activate)?$/.exec(url.pathname);
    if (claudeAccounts && accountMatch) {
      const slot = accountMatch[1]!;
      if (accountMatch[2] && method === "POST") {
        await claudeAccounts.switchTo(userId, slot);
        await fallback?.accountChangedByUser(userId); // a manual choice must not be undone by the automatic way back
        return send(res, 200, { accounts: await claudeAccounts.list(userId) });
      }
      if (!accountMatch[2] && method === "PATCH") {
        const body = await readJson<{ label?: unknown }>(req);
        await claudeAccounts.rename(userId, slot, body.label);
        return send(res, 200, { accounts: await claudeAccounts.list(userId) });
      }
      if (!accountMatch[2] && method === "DELETE") {
        await claudeAccounts.remove(userId, slot);
        return send(res, 200, { accounts: await claudeAccounts.list(userId) });
      }
    }
    const login = /^\/v1\/providers\/(claude|codex|antigravity)\/login$/.exec(url.pathname);
    if (login) {
      if (method === "POST") {
        const session = await manager.startLogin(userId, login[1] as ProviderId, await settings.profile(userId));
        return send(res, 201, { session });
      }
      if (method === "DELETE") {
        await manager.disconnectProvider(userId, login[1] as ProviderId);
        return send(res, 200, await providersStatus(userId));
      }
    }

    const linksMatch = /^\/v1\/projects\/([\w-]+)\/(links|events)$/.exec(url.pathname);
    if (linksMatch && method === "GET") {
      if (linksMatch[2] === "links") return send(res, 200, { links: await links.list(userId, linksMatch[1]) });
      const limit = clampInt(Number(url.searchParams.get("limit")) || 50, 1, 200);
      return send(res, 200, { events: links.hub.recent(userId, linksMatch[1], limit) });
    }
    // Refresh the persisted wired-context memory of agents whose wires changed; with `notify`, tell the live ones. Never fails the request.
    const wiredTouch = async (sessionIds: string[], notify: boolean) => {
      if (!wired) return;
      for (const id of new Set(sessionIds)) {
        try {
          const r = await wired.sync(userId, id);
          if (notify && (r.added.length || r.removed.length || r.updated.length)) await manager.notifyWired(userId, id, r.added, r.removed, r.block, r.updated);
        } catch (error) {
          log.warn("wired.touch_failed", { sessionId: id, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
        }
      }
    };

    // Agent memory for the app (Memory dialog). `status` answers even when memory is off so the UI can hide the button.
    if (method === "GET" && url.pathname === "/v1/memory/status") return send(res, 200, memories?.enabled() ? memories.status() : { enabled: false, redis: false, backend: null, embeddings: "off", model: "off", ready: false, vectors: false, migration: null });
    const memCtx = (projectId: string | null): MemoryCtx => ({ userId, projectId, actor: "user", anyProject: false });
    const memList = /^\/v1\/projects\/([\w-]+)\/memories$/.exec(url.pathname);
    if (memList && (method === "GET" || method === "POST")) {
      if (!memories?.enabled()) throw memoryOff();
      await memories.requireProject(userId, memList[1]);
      const ctx = memCtx(memList[1]);
      if (method === "POST") {
        const body = await readJson<Record<string, unknown>>(req);
        return send(res, 200, await memories.add(ctx, body));
      }
      const q = url.searchParams.get("q") ?? "";
      const type = url.searchParams.get("type") || undefined;
      const includeInvalid = url.searchParams.get("include_invalid") === "1";
      if (q.trim()) { const r = await memories.search(ctx, { query: q, type, k: 50, includeInvalid }); return send(res, 200, { memories: r.results, mode: r.mode }); }
      return send(res, 200, { memories: await memories.list(ctx, { type, limit: 500, includeInvalid }), mode: memories.status().ready ? "hybrid" : "fulltext" });
    }
    const memGraph = /^\/v1\/projects\/([\w-]+)\/memories\/graph$/.exec(url.pathname);
    if (memGraph && method === "GET") {
      if (!memories?.enabled()) throw memoryOff();
      await memories.requireProject(userId, memGraph[1]);
      return send(res, 200, await memories.graph(memCtx(memGraph[1]), { includeInvalid: url.searchParams.get("include_invalid") === "1", k: url.searchParams.get("k") ?? undefined, min: url.searchParams.get("min") ?? undefined }));
    }
    const memOne = /^\/v1\/memories\/([\w-]+)$/.exec(url.pathname);
    const memEvents = /^\/v1\/memories\/([\w-]+)\/events$/.exec(url.pathname);
    if ((memOne && (method === "PATCH" || method === "DELETE")) || (memEvents && method === "GET")) {
      if (!memories?.enabled()) throw memoryOff();
      const ctx = { ...memCtx(null), anyProject: true };
      if (memEvents) return send(res, 200, { events: await memories.events(ctx, memEvents[1]) });
      if (method === "DELETE") { await memories.remove(ctx, memOne![1]); return send(res, 200, { ok: true }); }
      const body = await readJson<Record<string, unknown>>(req);
      return send(res, 200, await memories.update(ctx, memOne![1], body));
    }

    const notesMatch = /^\/v1\/projects\/([\w-]+)\/notes$/.exec(url.pathname);
    if (notesMatch && method === "GET") return send(res, 200, { notes: await notes.list(userId, notesMatch[1]) });
    if (notesMatch && method === "POST") {
      const note = await notes.create(userId, notesMatch[1], await readJson(req));
      if (note.kind !== "note") await wiredTouch(await notes.sharedNoteSessionIds(userId, note), true);
      return send(res, 200, note);
    }
    const noteMatch = /^\/v1\/notes\/([\w-]+)$/.exec(url.pathname);
    if (noteMatch && method === "PATCH") {
      const before = await notes.get(userId, noteMatch[1]);
      const note = await notes.patch(userId, noteMatch[1], await readJson(req));
      await wiredTouch(note.linkedSessionIds, false); // keep the persisted memory current; no live notice per edit
      // Project memory/system notes reach every agent of the project: refresh them all and tell the live ones.
      // A kind change can widen or narrow who reads it (system: every agent, memory: the project), so touch both sets.
      if (before.kind !== "note" || note.kind !== "note") await wiredTouch([...new Set([...(await notes.sharedNoteSessionIds(userId, before)), ...(await notes.sharedNoteSessionIds(userId, note))])], true);
      return send(res, 200, note);
    }
    if (noteMatch && method === "DELETE") {
      const gone = await notes.get(userId, noteMatch[1]);
      const sessions = await notes.remove(userId, noteMatch[1]);
      await wiredTouch(gone.kind === "note" ? sessions : [...sessions, ...(await notes.sharedNoteSessionIds(userId, gone))], true);
      return send(res, 200, { ok: true });
    }

    const noteLink = /^\/v1\/notes\/([\w-]+)\/links(?:\/([\w-]+))?$/.exec(url.pathname);
    if (noteLink && method === "POST" && !noteLink[2]) {
      const sessionId = (await readJson<{ sessionId?: unknown }>(req)).sessionId;
      const note = await notes.link(userId, noteLink[1], sessionId);
      await wiredTouch([sessionId as string], true);
      return send(res, 200, note);
    }
    if (noteLink && method === "DELETE" && noteLink[2]) {
      const note = await notes.unlink(userId, noteLink[1], noteLink[2]);
      await wiredTouch([noteLink[2]], true);
      return send(res, 200, note);
    }

    // Usage-limit fallback actions (return now / keep / per-agent override). User auth only: agents have no route to this.
    const fallbackMatch = /^\/v1\/sessions\/([\w-]+)\/fallback$/.exec(url.pathname);
    if (fallbackMatch && method === "POST") {
      if (!fallback) throw notFound("Usage fallback is not available");
      const body = await readJson<{ action?: unknown; override?: unknown }>(req);
      if (body.action !== "return" && body.action !== "keep" && body.action !== "override") throw badRequest("action must be return, keep or override");
      const result = await fallback.act(userId, fallbackMatch[1]!, body.action, body.override as never);
      return send(res, 200, { session: await manager.get(fallbackMatch[1]!, userId), ...result });
    }
    // Marking an orchestrator is a user decision: only reachable with the user's own auth (/v1), never with an agent's
    // per-session token (/internal has no such route).
    const sessionRoleMatch = /^\/v1\/sessions\/([\w-]+)\/role$/.exec(url.pathname);
    if (sessionRoleMatch && method === "PATCH") {
      const body = await readJson<{ role?: unknown }>(req);
      if (!("role" in body)) throw badRequest("role is required (a preset id or null)", "invalid_role");
      return send(res, 200, await manager.setRole(userId, sessionRoleMatch[1], body.role));
    }

    if (url.pathname === "/v1/links" && method === "POST") {
      const body = await readJson<{ fromSessionId?: unknown; toSessionId?: unknown }>(req);
      const link = await links.createManual(userId, body.fromSessionId, body.toSessionId);
      await wiredTouch([link.fromSessionId, link.toSessionId], true);
      return send(res, 200, link);
    }
    const linkMatch = /^\/v1\/links\/([\w-]+)$/.exec(url.pathname);
    if (linkMatch && method === "DELETE") {
      const ends = await links.remove(userId, linkMatch[1]);
      await wiredTouch(ends, true);
      return send(res, 200, { ok: true });
    }

    // Agent <-> Browser node wires (same model as note links): the agent's floq-browser MCP then drives that node's page.
    const bLink = /^\/v1\/browser\/links(?:\/([\w-]{1,64}))?(?:\/([\w-]{36}))?$/.exec(url.pathname);
    if (url.pathname === "/v1/browser/nodes" && browserLinks) {
      const projectOf = async (value: unknown): Promise<string | null> => {
        if (value === null || value === "none") return null;
        if (typeof value !== "string" || !(await manager.listProjects(userId, await activeOrg())).some((p) => p.id === value)) throw notFound("Project not found");
        return value;
      };
      if (method === "GET") return send(res, 200, { nodes: await browserLinks.nodes(userId, await projectOf(url.searchParams.get("project") ?? "none")) });
      if (method === "POST") {
        const body = await readJson<{ nodeId?: unknown; projectId?: unknown }>(req);
        await browserLinks.claim(userId, body.nodeId, await projectOf(body.projectId ?? null));
        return send(res, 200, { ok: true });
      }
    }
    if (bLink) {
      if (!browserLinks) throw unavailable("This Floq server has no browser", "unavailable");
      const touch = async (ids: string[]) => { await wiredTouch(ids, true); };
      if (method === "GET" && !bLink[1]) {
        const project = url.searchParams.get("project");
        return send(res, 200, { links: await browserLinks.list(userId, project === null ? undefined : project === "none" ? null : project) });
      }
      if (method === "POST" && !bLink[1]) {
        const body = await readJson<{ nodeId?: unknown; sessionId?: unknown }>(req);
        const { link, replacedNode } = await browserLinks.link(userId, body.nodeId, body.sessionId);
        browser?.setAgentScope(userId, link.sessionId, link.nodeId);
        await touch([link.sessionId]);
        return send(res, 200, { link, replacedNode });
      }
      if (method === "DELETE" && bLink[1] && bLink[2]) {
        await browserLinks.unlink(userId, bLink[1], bLink[2]);
        browser?.setAgentScope(userId, bLink[2], null);
        await touch([bLink[2]]);
        return send(res, 200, { ok: true });
      }
      if (method === "DELETE" && bLink[1]) {
        const ids = await browserLinks.removeNode(userId, bLink[1]);
        for (const id of ids) browser?.setAgentScope(userId, id, null);
        await touch(ids);
        return send(res, 200, { ok: true });
      }
    }

    if (url.pathname === "/v1/projects") {
      if (method === "GET") return send(res, 200, { projects: await manager.listProjects(userId, await activeOrg()) });
      if (method === "POST") {
        const input = projectCreateInput(await readJson<Record<string, unknown>>(req));
        const project = await manager.createProject(userId, await settings.profile(userId), input.gitUrl, input.name, await activeOrg());
        return send(res, 201, { project });
      }
    }
    const projectMatch = /^\/v1\/projects\/([\w-]+)$/.exec(url.pathname);
    if (projectMatch && method === "PATCH") {
      const body = await readJson<{ displayName?: unknown; imageUrl?: unknown; iconName?: unknown; iconColor?: unknown; organizationId?: unknown }>(req);
      if (body.organizationId !== undefined) {
        // Move to another organization of the same owner; the caller must belong to the target.
        if (typeof body.organizationId !== "string" || !body.organizationId) throw badRequest("organizationId must be an organization id", "invalid_project");
        const target = await organizations.resolveActive(userId, body.organizationId);
        return send(res, 200, { project: await manager.moveProject(userId, projectMatch[1], target) });
      }
      await manager.requireProject(userId, await activeOrg(), projectMatch[1]);
      return send(res, 200, { project: await manager.updateProject(userId, projectMatch[1], body) });
    }
    if (projectMatch && method === "DELETE") return send(res, 200, await manager.deleteProject(userId, projectMatch[1]));
    const projectDeleteStatus = /^\/v1\/projects\/([\w-]+)\/delete-status$/.exec(url.pathname);
    if (projectDeleteStatus && method === "GET") return send(res, 200, await manager.projectDeleteStatus(userId, projectDeleteStatus[1]));
    if (url.pathname === "/v1/project-folders") {
      if (method === "GET") return send(res, 200, await projectFolders.get(userId, await activeOrg()));
      if (method === "PUT") return send(res, 200, await projectFolders.put(userId, await activeOrg(), await readJson<unknown>(req, 512 * 1024)));
    }
    const projectNav = /^\/v1\/projects\/([\w-]+)\/workspaces$/.exec(url.pathname);
    if (projectNav && method === "PATCH") {
      const body = await readJson<{ navExpanded?: unknown }>(req);
      return send(res, 200, await manager.setProjectNavExpanded(userId, projectNav[1], body.navExpanded));
    }
    const workspaceNav = /^\/v1\/projects\/([\w-]+)\/workspaces\/([\w-]+)$/.exec(url.pathname);
    if (workspaceNav && method === "PATCH") {
      const body = await readJson<{ navExpanded?: unknown }>(req);
      return send(res, 200, { workspace: await manager.setWorkspaceNavExpanded(userId, workspaceNav[1], workspaceNav[2], body.navExpanded) });
    }
    const projectBranches = /^\/v1\/projects\/([\w-]+)\/workspaces\/([\w-]+)\/branches$/.exec(url.pathname);
    if (projectBranches && method === "GET") {
      return send(res, 200, await manager.projectBranches(userId, projectBranches[1], projectBranches[2]));
    }
    const projectBranch = /^\/v1\/projects\/([\w-]+)\/workspaces\/([\w-]+)\/branch$/.exec(url.pathname);
    if (projectBranch && method === "POST") {
      const body = await readJson<{ branch?: unknown; dryRun?: unknown }>(req);
      if (body.dryRun === true) return send(res, 200, await manager.checkProjectBranchSwitch(userId, projectBranch[1], projectBranch[2], body.branch));
      return send(res, 200, { project: await manager.switchProjectBranch(userId, projectBranch[1], projectBranch[2], body.branch) });
    }
    const projectWorktreeStatus = /^\/v1\/projects\/([\w-]+)\/workspaces\/([\w-]+)\/delete-status$/.exec(url.pathname);
    if (projectWorktreeStatus && method === "GET") {
      return send(res, 200, await manager.worktreeDeleteStatus(userId, projectWorktreeStatus[1], projectWorktreeStatus[2]));
    }
    const projectWorkspace = /^\/v1\/projects\/([\w-]+)\/workspaces\/([\w-]+)$/.exec(url.pathname);
    if (projectWorkspace && method === "DELETE") {
      const force = url.searchParams.get("force");
      if (force !== null && force !== "1" && force !== "0") throw badRequest("force must be 0 or 1", "invalid_force");
      return send(res, 200, await manager.deleteWorktree(userId, projectWorkspace[1], projectWorkspace[2], force === "1"));
    }

    if (method === "GET" && url.pathname === "/v1/agent-roles") return send(res, 200, { roles: listAgentRoles() });
    const roleMatch = /^\/v1\/agent-roles\/([\w-]+)$/.exec(url.pathname);
    if (method === "GET" && roleMatch) {
      const role = getAgentRole(roleMatch[1]);
      if (!role) throw notFound("Unknown role");
      return send(res, 200, { role, text: describeRole(role) });
    }

    if (url.pathname === "/v1/sessions") {
      if (method === "GET") return send(res, 200, { sessions: await manager.list(userId, await activeOrg()) });
      if (method === "POST") {
        const body = await readJson<CreateSessionInput>(req);
        if (body.isolated !== undefined && typeof body.isolated !== "boolean") throw badRequest("isolated must be a boolean", "invalid_worktree_project");
        if (body.isolated && (!body.projectId || typeof body.projectId !== "string")) throw badRequest("isolated requires a registered project", "invalid_worktree_project");
        if (body.provider !== "shell") {
          body.specKit ??= true;
          body.lead ??= true;
        }
        const keyHeader = req.headers["idempotency-key"];
        const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
        if (key && !/^[\w-]{16,128}$/.test(key)) throw badRequest("invalid idempotency key", "invalid_idempotency_key");
        const profile = await settings.profile(userId);
        const orgId = await activeOrg();
        const create = () => manager.create(userId, profile, body, { isolated: body.isolated === true, orgId });
        let session;
        if (key) {
          try {
            session = await sessionCreates.run(userId, key, JSON.stringify(body), create);
          } catch (error) {
            if (error instanceof Error && error.message === "idempotency key reused with different input") {
              throw conflict(error.message, "idempotency_conflict");
            }
            throw error;
          }
        } else {
          session = await create();
        }
        return send(res, 201, { session });
      }
    }

    const changesMatch = /^\/v1\/sessions\/([\w-]+)\/(changes|diff)$/.exec(url.pathname);
    if (changesMatch && method === "GET") {
      if (changesMatch[2] === "changes") return send(res, 200, await gitReview.changes(userId, changesMatch[1]));
      return send(res, 200, await gitReview.diff(userId, changesMatch[1], url.searchParams.get("path")));
    }

    const filesMatch = /^\/v1\/sessions\/([\w-]+)\/files(\/content)?$/.exec(url.pathname);
    if (filesMatch && method === "GET") {
      if (!workspaceFiles) throw notFound();
      const path = url.searchParams.get("path");
      return send(res, 200, filesMatch[2] ? await workspaceFiles.read(userId, filesMatch[1], path) : await workspaceFiles.list(userId, filesMatch[1], path));
    }

    if (filesMatch && !filesMatch[2] && method === "POST") {
      if (!workspaceFiles) throw notFound();
      const body = await readJson<{ path?: unknown; name?: unknown; kind?: unknown }>(req, 16 * 1024);
      return send(res, 201, await workspaceFiles.create(userId, filesMatch[1], body));
    }

    const artifactsMatch = /^\/v1\/sessions\/([\w-]+)\/artifacts(\/content|\/link)?$/.exec(url.pathname);
    if (artifactsMatch) {
      if (!artifacts) throw notFound();
      if (method === "GET" && !artifactsMatch[2]) return send(res, 200, await artifacts.list(userId, artifactsMatch[1]));
      if (method === "GET" && artifactsMatch[2] === "/content") return send(res, 200, await artifacts.read(userId, artifactsMatch[1], url.searchParams.get("path")));
      if (method === "POST" && artifactsMatch[2] === "/link") {
        const body = await readJson<{ path?: unknown }>(req);
        const path = await artifacts.authorizeDownload(userId, artifactsMatch[1], body.path);
        const { token, expiresAt } = downloadLinks.issue({ userId, authSessionId, sessionId: artifactsMatch[1], path, audience: "art" });
        return send(res, 200, { url: `/v1/sessions/${artifactsMatch[1]}/artifacts/download?t=${token}`, expiresAt });
      }
    }

    const mountMatch = /^\/v1\/projects\/([\w-]+)\/files\/mount$/.exec(url.pathname);
    if (mountMatch && (method === "POST" || method === "DELETE")) {
      if (!webdav) throw notFound();
      if (method === "DELETE") {
        const token = url.searchParams.get("token") ?? undefined;
        return send(res, 200, { revoked: davMounts.revoke(userId, mountMatch[1], token) });
      }
      const mount = await davMounts.create(userId, authSessionId, mountMatch[1]);
      const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
      const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
      let locations: { davUrl: string; uncPath: string } | null = null;
      try { locations = mountLocations(`${proto}://${host}`, mount.token); } catch { /* the client derives these from its own base URL */ }
      return send(res, 200, { token: mount.token, path: `/dav/${mount.token}/`, ...locations, expiresAt: mount.expiresAt, folders: mount.folders.map((folder) => folder.name) });
    }

    const virtualSeed = /^\/v1\/projects\/([\w-]+)\/virtual-agents$/.exec(url.pathname);
    if (virtualSeed && method === "GET") return send(res, 200, { agents: manager.agyMirror.snapshot(userId, virtualSeed[1] === "none" ? "" : virtualSeed[1]!) });
    const virtualRoute = /^\/v1\/virtual-agents\/([^/]+)\/(transcript|message)$/.exec(url.pathname);
    if (virtualRoute) {
      let vid = "";
      try { vid = decodeURIComponent(virtualRoute[1]!); } catch { throw notFound(); }
      if (virtualRoute[2] === "transcript" && method === "GET") {
        const result = manager.agyMirror.transcript(userId, vid, Number(url.searchParams.get("since") ?? 0), Number(url.searchParams.get("limit") ?? 50));
        if (!result) throw notFound();
        if (result === "rate") throw new HttpError(429, "rate_limited", "Too many transcript reads; retry shortly");
        return send(res, 200, result);
      }
      if (virtualRoute[2] === "message" && method === "POST") {
        if (!manager.agyMirror.find(userId, vid)) throw notFound();
        const body = await readJson<{ text?: unknown }>(req);
        if (typeof body.text !== "string" || !body.text.trim()) throw badRequest("text is required");
        if (!(await manager.relayToAgyAgent(userId, vid, body.text))) throw conflict("The host agent is not running", "host_not_running");
        return send(res, 202, { ok: true });
      }
    }

    const fileLinkMatch = /^\/v1\/sessions\/([\w-]+)\/files\/link$/.exec(url.pathname);
    if (fileLinkMatch && method === "POST") {
      if (!workspaceFiles) throw notFound();
      const body = await readJson<{ path?: unknown }>(req);
      const path = await workspaceFiles.authorizeDownload(userId, fileLinkMatch[1], body.path);
      const { token, expiresAt } = downloadLinks.issue({ userId, authSessionId, sessionId: fileLinkMatch[1], path, audience: "ws" });
      return send(res, 200, { url: `/v1/sessions/${fileLinkMatch[1]}/files/download?t=${token}`, expiresAt });
    }

    if (url.pathname === "/v1/port-requests" && method === "GET") return send(res, 200, { requests: portRequests.list(userId) });
    const portRequestAnswer = /^\/v1\/port-requests\/([\w-]+)\/resolve$/.exec(url.pathname);
    if (portRequestAnswer && method === "POST") {
      const body = await readJson<{ decision?: unknown; message?: unknown }>(req);
      if (body.decision !== "allow" && body.decision !== "deny" && body.decision !== "error") throw badRequest("decision must be allow, deny or error");
      const status = portRequests.resolve(userId, portRequestAnswer[1], body.decision === "error" ? { decision: "error", message: typeof body.message === "string" ? body.message : "unknown error" } : { decision: body.decision });
      return send(res, 200, { status });
    }

    // User-only: authenticated above by the user's app session (userFor). The per-session agent token of `floq` is not accepted here.
    if (url.pathname === "/v1/approvals" && method === "GET") return send(res, 200, { approvals: approvals.list(userId) });
    const approvalAnswer = /^\/v1\/approvals\/([A-Z2-7]{26})\/resolve$/.exec(url.pathname);
    if (approvalAnswer && method === "POST") {
      const body = await readJson<{ decision?: unknown }>(req);
      return send(res, 200, await approvals.resolve(userId, approvalAnswer[1], body.decision));
    }

    if (url.pathname === "/v1/decisions" && method === "GET") return send(res, 200, { decisions: decisions.list(userId) });
    const decisionAnswer = /^\/v1\/decisions\/([\w-]+)\/(resolve|terminal)$/.exec(url.pathname);
    if (decisionAnswer && method === "POST") {
      if (decisionAnswer[2] === "terminal") return send(res, 200, await decisions.terminal(userId, decisionAnswer[1]));
      const body = await readJson<{ answers?: unknown }>(req);
      return send(res, 200, await decisions.resolve(userId, decisionAnswer[1], body.answers));
    }

    // User-only and org-scoped (x-floq-organization): notifications of projects outside the active organization are hidden.
    if (url.pathname === "/v1/notifications" && method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || undefined;
      const projectId = url.searchParams.get("projectId") || undefined;
      const before = url.searchParams.get("before") || undefined;
      if (before && Number.isNaN(Date.parse(before))) throw badRequest("before must be an ISO date");
      return send(res, 200, { notifications: await notifications.list(userId, { unreadOnly: url.searchParams.get("unreadOnly") === "true", projectId, before, limit, organizationId: await activeOrg() }) });
    }
    if ((url.pathname === "/v1/notifications/read" || url.pathname === "/v1/notifications/clear") && method === "POST") {
      const body = await readJson<{ ids?: unknown }>(req);
      return send(res, 200, url.pathname.endsWith("/read") ? await notifications.markRead(userId, body.ids ?? "all") : await notifications.clear(userId, body.ids ?? "all"));
    }

    const portsMatch = /^\/v1\/sessions\/([\w-]+)\/ports$/.exec(url.pathname);
    if (portsMatch && method === "GET") {
      const live = manager.getLive(portsMatch[1], userId);
      const ports = await listSessionPorts(live.pid, manager.inNetns(userId));
      // links: only URLs whose ports this session listens on now (no stale links, no SSRF through printed URLs).
      return send(res, 200, { ports, links: visibleDebugLinks(live.debugLinks, ports) });
    }

    const displayMatch = /^\/v1\/sessions\/([\w-]+)\/display$/.exec(url.pathname);
    if (displayMatch && method === "GET") {
      // Owner only (getLive checks the user). Port and token come from the runtime-wide slot; running = Xpra listens on it in this session's tree.
      const live = manager.getLive(displayMatch[1], userId);
      return send(res, 200, displayStatus(manager.displays.get(displayMatch[1]), await listSessionPorts(live.pid, manager.inNetns(userId))));
    }
    const displayStop = /^\/v1\/sessions\/([\w-]+)\/display\/stop$/.exec(url.pathname);
    if (displayStop && method === "POST") {
      const live = manager.getLive(displayStop[1], userId);
      const lease = manager.displays.get(displayStop[1]);
      return send(res, 200, { stopped: lease ? await stopDisplayServer(live.pid, lease.port, undefined, manager.inNetns(userId)) : false });
    }

    const attachmentMatch = /^\/v1\/sessions\/([\w-]+)\/attachments$/.exec(url.pathname);
    if (attachmentMatch && method === "PUT") {
      // Raw binary body streamed to disk; name in the query string, size capped by FLOQ_MAX_UPLOAD_BYTES.
      const length = req.headers["content-length"];
      const contentLength = length !== undefined && /^\d+$/.test(length) ? Number(length) : null;
      return send(res, 201, await manager.uploadSessionAttachmentStream(attachmentMatch[1], userId, url.searchParams.get("name"), req, { maxBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES, contentLength }));
    }
    if (attachmentMatch && method === "POST") {
      const body = await readJson<{ name?: unknown; data?: unknown }>(req, 6 * 1024 * 1024);
      return send(res, 201, await manager.uploadSessionAttachment(attachmentMatch[1], userId, body.name, body.data));
    }

    const match = SESSION_PATH.exec(url.pathname);
    if (match) {
      const action = match[2];
      if (!action && method === "PATCH") {
        const body = await readJson<{ title?: unknown }>(req);
        return send(res, 200, { session: await manager.renameSession(userId, match[1], body.title) });
      }
      if (!action && method === "GET") return send(res, 200, { session: await manager.get(match[1], userId) });
      if (!action && method === "DELETE") {
        await manager.remove(match[1], userId);
        return send(res, 200, { ok: true });
      }
      if (action === "resume" && method === "POST") {
        await fallback?.userResumed(match[1], userId);
        const session = await manager.resume(userId, await settings.profile(userId), match[1]);
        return send(res, 200, { session });
      }
      if (action === "sleep" && method === "POST") {
        manager.getLive(match[1], userId);
        await manager.sleepSession(match[1], "manual");
        return send(res, 200, { session: await manager.get(match[1], userId) });
      }
      const session = manager.getLive(match[1], userId);
      if (action === "input" && method === "POST") {
        const body = await readJson<{ data?: string }>(req);
        if (typeof body.data !== "string") throw badRequest("data must be a string");
        session.write(body.data);
        return send(res, 200, { ok: true });
      }
      if (action === "resize" && method === "POST") {
        const body = await readJson<{ cols?: number; rows?: number }>(req);
        if (!Number.isFinite(body.cols) || !Number.isFinite(body.rows)) throw badRequest("cols and rows required");
        session.resize(clampInt(body.cols!, 20, 500), clampInt(body.rows!, 5, 200));
        return send(res, 200, { session: session.toSummary() });
      }
      if (action === "interrupt" && method === "POST") {
        session.interrupt();
        return send(res, 200, { ok: true });
      }
    }

    throw notFound();
  }

  const server = createServer((req, res) => {
    cors(req, res);
    // WebDAV first: the OPTIONS short-circuit below would otherwise answer the Explorer probes with a bare 204.
    if (webdav?.handles(req)) {
      void webdav.handle(req, res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    route(req, res).catch((error: unknown) => {
      const errno = (error as NodeJS.ErrnoException)?.code;
      if (error instanceof HttpError) {
        send(res, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      } else if (errno === "ENOTCONN" || errno === "ECONNABORTED" || errno === "EIO") {
        log.error("http.shard_io", { error: String((error as Error).message) });
        send(res, 503, { error: { code: "shard_unavailable", message: "Your workspace is not available right now. Try again shortly." } });
      } else {
        log.error("http.unhandled", { error: error instanceof Error ? error.message : String(error) });
        send(res, 500, { error: { code: "internal", message: "Internal error" } });
      }
    });
  });
  // Large attachment uploads can take longer than Node's default 5 minute whole-request limit; headersTimeout still applies.
  server.requestTimeout = 0;

  // Browsers cannot set headers on a WebSocket. The token may ride in the query string (legacy) or, preferably, as a
// Sec-WebSocket-Protocol entry "floq.bearer.<token>" next to "floq.v1": URLs end up in logs and proxies, subprotocols do not.
// Only "floq.v1" is ever echoed back, never the bearer entry.
const wsToken = (req: IncomingMessage, url: URL): string | null => {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const bearer = offered.find((p) => p.startsWith("floq.bearer."));
  return (bearer ? bearer.slice("floq.bearer.".length) : "") || url.searchParams.get("token");
};
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, handleProtocols: (protocols) => (protocols.has("floq.v1") ? "floq.v1" : false) });
  type LivePeer = { ws: WebSocket; userId: string; authSessionId: string; headers: IncomingMessage["headers"]; boardId?: string };
  const livePeers = new Set<LivePeer>();
  function closeLivePeers(match: (peer: LivePeer) => boolean): void {
    for (const peer of livePeers) if (match(peer)) { try { peer.ws.close(1008, "Session ended"); } catch { /* already closed */ } livePeers.delete(peer); }
  }
  // Authorization is checked at upgrade only; re-run it so a revoked session or a removed org member loses open sockets.
  let revalidating = false;
  async function revalidatePeers(): Promise<void> {
    if (revalidating) return;
    revalidating = true;
    try {
      for (const peer of [...livePeers]) {
        try {
          const who = await authFor(peer.headers);
          if (who.userId !== peer.userId) throw unauthorized();
          if (peer.boardId) await tasks.requireBoard(peer.userId, peer.boardId);
        } catch (error) {
          if (error instanceof HttpError && (error.status === 401 || error.status === 404 || error.status === 403)) closeLivePeers((p) => p === peer);
        }
      }
    } finally { revalidating = false; }
  }
  const revalidateTimer = setInterval(() => { void revalidatePeers(); }, 30_000);
  revalidateTimer.unref();
  type TaskPeer = { ws: WebSocket; boardId: string; userId: string; name: string; x: number; y: number; activeAt: number; sentAt: number; cursorVisible: boolean };
  const taskPeers = new Set<TaskPeer>();
  async function broadcastTaskBoard(boardId: string): Promise<void> {
    const viewers = [...taskPeers].filter((peer) => peer.boardId === boardId && peer.ws.readyState === peer.ws.OPEN);
    if (!viewers.length) return;
    // Per-peer authorization: a removed member never receives another viewer's copy of the board.
    for (const peer of viewers) {
      try {
        const board = await tasks.board(peer.userId, boardId);
        if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(JSON.stringify({ type: "board", board }));
      } catch { try { peer.ws.close(1008, "Access revoked"); } catch { /* already closed */ } }
    }
  }
  const expireTaskCursors = setInterval(() => {
    const now = Date.now();
    for (const peer of expireStaleCursors(taskPeers, now)) {
      for (const other of taskPeers) if (other !== peer && other.boardId === peer.boardId && other.ws.readyState === other.ws.OPEN) {
        other.ws.send(JSON.stringify({ type: "presence-left", userId: peer.userId }));
      }
    }
  }, 5_000);
  expireTaskCursors.unref();

  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });

  async function handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url ?? "/", "http://runtime");
      if (url.pathname === "/v1/tasks/realtime") {
        if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
        const token = wsToken(req, url);
        const boardId = url.searchParams.get("boardId");
        if (!token || !boardId) return reject(401, "Unauthorized");
        const headers = { ...req.headers, authorization: "Bearer " + token };
        const { userId, authSessionId } = await authFor(headers);
        const organizationId = await tasks.requireBoard(userId, boardId);
        const members = await tasks.members(userId, organizationId);
        const self = members.find((member) => member.id === userId);
        wss.handleUpgrade(req, socket, head, (ws) => attachTaskPeer(ws, boardId, userId, self?.name || self?.email || "Member", authSessionId, headers));
        return;
      }
      if (url.pathname === "/v1/events") {
        if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
        const token = wsToken(req, url);
        const headers = { ...req.headers };
        if (token) headers.authorization = "Bearer " + token;
        const { userId, authSessionId } = await authFor(headers);
        wss.handleUpgrade(req, socket, head, (ws) => {
          const live: LivePeer = { ws, userId, authSessionId, headers };
          livePeers.add(live);
          ws.on("close", () => livePeers.delete(live));
          const off = links.hub.subscribe(userId, (event) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)); });
          const offPorts = portRequests.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offApprovals = approvals.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offDecisions = decisions.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offNotifications = notifications.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offDisplays = manager.displays.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offVirtual = manager.agyMirror?.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); }) ?? (() => undefined);
          for (const frame of manager.agyMirror?.frames(userId) ?? []) ws.send(JSON.stringify(frame));
          const offPlugins = plugins ? plugins.events.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); }) : () => undefined;
          const offAll = () => { off(); offPorts(); offApprovals(); offDecisions(); offNotifications(); offDisplays(); offPlugins(); offVirtual(); };
          ws.on("close", offAll);
          ws.on("error", offAll);
        });
        return;
      }
      if (url.pathname === "/v1/browser/egress") {
        // The user's desktop app dials in to carry the agent browser's traffic (docs/design/browser-user-egress.md §3.1). Native client: the
        // session token travels ONLY in the Authorization header, never in the URL or a subprotocol (those land in access logs).
        const hub = browser?.egress;
        if (!browser || !hub) return reject(404, "Not Found");
        if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
        if (url.searchParams.has("token") || String(req.headers["sec-websocket-protocol"] ?? "").includes("floq.bearer.")) return reject(400, "Bad Request");
        if (!req.headers.authorization) return reject(401, "Unauthorized");
        // The socket belongs to the calling user's browser: there is no user id in the route to tamper with.
        const { userId, authSessionId } = await authFor(req.headers);
        try { await browser.assertAllowed(userId); } catch { return reject(403, "Forbidden"); }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const live: LivePeer = { ws, userId, authSessionId, headers: req.headers };
          livePeers.add(live);
          const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
          const peer = hub.attachDesktop(userId, {
            send: (frame) => { if (ws.readyState !== ws.OPEN) return; if (ws.bufferedAmount > 16 * 1024 * 1024) return void ws.close(1013, "Slow consumer"); ws.send(frame, { binary: true }); },
            close: (code, reason) => { try { ws.close(code, reason); } catch { /* closed */ } },
          }, { peerIp: (fwd || req.socket.remoteAddress || "").replace(/^::ffff:/, "") });
          ws.on("message", (data, isBinary) => peer.onMessage(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data), isBinary));
          const done = () => { livePeers.delete(live); peer.onClose(); };
          ws.on("close", done);
          ws.on("error", done);
        });
        return;
      }
      if (url.pathname === "/v1/browser/stream") {
        if (!browser) return reject(404, "Not Found");
        if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
        const token = wsToken(req, url);
        const headers = { ...req.headers };
        if (token) headers.authorization = "Bearer " + token;
        // The socket belongs to the calling user's browser: there is no user id in the route to tamper with.
        const { userId, authSessionId } = await authFor(headers);
        wss.handleUpgrade(req, socket, head, (ws) => {
          const live: LivePeer = { ws, userId, authSessionId, headers };
          livePeers.add(live);
          ws.on("close", () => livePeers.delete(live));
          attachBrowserViewer(ws, userId, url.searchParams.get("node") ?? "main");
        });
        return;
      }
      const tunnel = /^\/v1\/sessions\/([\w-]+)\/ports\/(\d{1,5})\/tunnel$/.exec(url.pathname);
      if (tunnel) {
        if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
        // Same auth as the terminal stream: bearer header, or ?token= where headers cannot be set.
        const token = wsToken(req, url);
        const headers = { ...req.headers };
        if (token) headers.authorization = "Bearer " + token;
        const userId = await userFor(headers);
        const session = manager.getLive(tunnel[1], userId);
        // Only ports this session's own processes listen on: no SSRF into the host or other sessions.
        // ?manual=1 additionally allows an undetected loopback port >= 1024 that is not the runtime's own or a database port.
        // It also requires the port to be listened on by this user's uid and no other (sandboxes share the host network namespace).
        const uid = manager.sessionUid(userId);
        // Per-user netns (FLOQ_NETNS): the session's ports live in its namespace; read its tables and connect from inside it.
        const netnsPath = manager.netnsPath(userId);
        // Namespace on but no live process to read it from: refuse, never fall back to the host's tables or network.
        if (netnsPath && (session.pid === null || uid === null)) return reject(503, "Service Unavailable");
        const listenerPid = netnsPath ? session.pid : undefined;
        const manual = url.searchParams.get("manual") === "1"
          ? { denyPorts: [...MANUAL_DENY_PORTS, config.port, databasePort(config.databaseUrl)], uid, listeners: await listAllListeners(listenerPid) }
          : undefined;
        const port = Number(tunnel[2]);
        const detected = await listSessionPorts(session.pid, netnsPath !== null);
        const target = tunnelTarget(detected, port, manual);
        if (!target) return reject(404, "Not Found");
        const viaManual = !detected.some((p) => p.port === port);
        if (viaManual) {
          // Re-check ownership right before connecting: the port may have changed hands since the first check.
          // Done BEFORE the upgrade so pipeTunnel attaches its message handler synchronously (a later async
          // attach would drop the client's first bytes).
          const now = await listAllListeners(listenerPid).catch(() => null);
          if (!now || !manualPortOwned(now, port, uid)) return reject(403, "Forbidden");
        }
        // Bounded helper processes per user (each tunnel in a namespace is an nsenter+socat pair).
        const release = netnsPath ? acquireTunnelSlot(uid!) : () => undefined;
        if (!release) return reject(429, "Too Many Requests");
        socket.once("close", release); // fires even if the upgrade never completes, so a slot cannot leak
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (!netnsPath) return void pipeTunnel(ws, target);
          pipeTunnel(ws, target, (t) => connectInNetns(netnsPath, uid!, t, release));
        });
        return;
      }
      const match = SESSION_PATH.exec(url.pathname);
      if (!match || match[2] !== "stream") return reject(404, "Not Found");
      if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
      // Browsers cannot set headers on WebSocket, so accept the bearer token as ?token=.
      const token = wsToken(req, url);
      const headers = { ...req.headers };
      if (token) headers.authorization = "Bearer " + token;
      const userId = await userFor(headers);
      const session = manager.getLive(match[1], userId);
      const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, session, since));
    } catch (error) {
      reject(error instanceof HttpError ? error.status : 500, "Error");
    }
  }

  /** Relays one Browser node socket through BrowserService (allowlisted messages only). Messages that arrive before the attach finishes are queued. */
  function attachBrowserViewer(ws: WebSocket, userId: string, nodeId: string): void {
    if (!browser) return void ws.close(1011, "Browser unavailable");
    const pending: string[] = [];
    let handle: ViewerHandle | null = null;
    let gone = false;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (handle) handle.onMessage(text);
      else if (pending.length < 64) pending.push(text);
    });
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) return void ws.terminate(); alive = false; try { ws.ping(); } catch { /* closing */ } }, 25_000);
    heartbeat.unref?.();
    const done = () => { clearInterval(heartbeat); gone = true; handle?.close(); };
    ws.on("close", done);
    ws.on("error", done);
    browser.attachViewer(userId, { send: (text) => { if (ws.readyState === ws.OPEN) ws.send(text); }, bufferedAmount: () => ws.bufferedAmount, close: (code, reason) => ws.close(code, reason) }, nodeId)
      .then((h) => { if (gone) return h.close(); handle = h; for (const text of pending.splice(0)) h.onMessage(text); })
      .catch((error) => { log.warn("browser.attach_failed", { userId, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); ws.close(1011, "Browser unavailable"); });
  }

  function attachTaskPeer(ws: WebSocket, boardId: string, userId: string, name: string, authSessionId: string, headers: IncomingMessage["headers"]): void {
    const live: LivePeer = { ws, userId, authSessionId, headers, boardId };
    livePeers.add(live);
    ws.on("close", () => livePeers.delete(live));
    const peer: TaskPeer = { ws, boardId, userId, name, x: 0, y: 0, activeAt: Date.now(), sentAt: 0, cursorVisible: true };
    taskPeers.add(peer);
    const send = (frame: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); };
    void tasks.board(userId, boardId).then((board) => send({ type: "hello", board })).catch(() => ws.close(1011, "Unable to load board"));
    for (const other of taskPeers) if (other !== peer && other.boardId === boardId && other.cursorVisible) send({ type: "presence", userId: other.userId, name: other.name, x: other.x, y: other.y });
    for (const other of taskPeers) if (other !== peer && other.boardId === boardId) other.ws.send(JSON.stringify({ type: "presence", userId, name, x: 0, y: 0 }));
    ws.on("message", (raw) => {
      if (Date.now() - peer.sentAt < 40) return;
      peer.sentAt = Date.now();
      try {
        const message = JSON.parse(raw.toString("utf8")) as { type?: string; x?: unknown; y?: unknown };
        if (message.type !== "cursor" || typeof message.x !== "number" || typeof message.y !== "number" || !Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
        peer.x = Math.max(0, Math.min(1, message.x));
        peer.y = Math.max(0, Math.min(1, message.y));
        peer.activeAt = Date.now();
        peer.cursorVisible = true;
        for (const other of taskPeers) if (other !== peer && other.boardId === boardId && other.ws.readyState === other.ws.OPEN) other.ws.send(JSON.stringify({ type: "presence", userId, name, x: peer.x, y: peer.y }));
      } catch { /* Ignore malformed presence frames. */ }
    });
    const cleanup = () => {
      taskPeers.delete(peer);
      for (const other of taskPeers) if (other.boardId === boardId && other.ws.readyState === other.ws.OPEN) other.ws.send(JSON.stringify({ type: "presence-left", userId }));
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  function attach(ws: WebSocket, session: Session, since: number): void {
    const push = (frame: ServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };

    const replay = session.replaySince(since);
    push({ type: "hello", server: info(), session: session.toSummary(), truncated: replay.truncatedBytes });
    for (const chunk of replay.chunks) push({ type: "output", seq: chunk.seq, data: chunk.data, ts: chunk.ts });

    const unsubscribe = session.subscribe(push);
    const heartbeat = setInterval(() => ws.ping(), 25_000);

    ws.on("message", (raw) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString("utf8")) as ClientFrame;
      } catch {
        return push({ type: "error", code: "invalid_json", message: "Frame must be JSON" });
      }
      switch (frame.type) {
        case "input":
          if (typeof frame.data === "string") session.write(frame.data);
          break;
        case "prompt":
          if (typeof frame.text === "string") session.write(frame.text.replace(/\r?\n/g, "\r") + "\r");
          break;
        case "resize":
          if (Number.isFinite(frame.cols) && Number.isFinite(frame.rows)) {
            session.resize(clampInt(frame.cols, 20, 500), clampInt(frame.rows, 5, 200));
          }
          break;
        case "interrupt":
          session.interrupt();
          break;
        case "ping":
          push({ type: "pong", ts: Date.now() });
          break;
        default:
          push({ type: "error", code: "unknown_frame", message: "Unknown frame type" });
      }
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  return {
    listen: () =>
      new Promise<void>((done) => server.listen(config.port, config.host, () => done())),
    close: () =>
      new Promise<void>((done) => {
        clearInterval(expireTaskCursors);
        for (const peer of taskPeers) peer.ws.close(1001, "server shutting down");
        wss.clients.forEach((client) => client.close(1001, "server shutting down"));
        server.close(() => done());
        setTimeout(done, 3_000).unref();
      }),
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
