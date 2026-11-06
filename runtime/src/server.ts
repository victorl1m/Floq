import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_MAX_UPLOAD_BYTES } from "./attachments.js";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { WebSocketServer, type WebSocket } from "ws";
import type pg from "pg";
import type { ClaudeOAuth } from "./claudeOauth.js";
import type { UsageService } from "./usage.js";
import type { SkillsService } from "./skills.js";
import { loadSkillFromCatalog, previewCatalogSkill, searchSkillCatalog } from "./skillCatalog.js";
import type { CredentialBroker } from "./credentials.js";
import { createBootstrapAdmin, setupAvailable, type Auth } from "./auth.js";
import type { Config } from "./config.js";
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from "./errors.js";
import { log } from "./logger.js";
import type { SessionManager } from "./manager.js";
import type { GithubLinker } from "./github.js";
import { AGENT_ROLES, describeRole, getAgentRole, listAgentRoles } from "./roles.js";
import type { AgentLinks } from "./links.js";
import type { CanvasNotes } from "./notes.js";
import type { Keychain, Keychains } from "./keychains.js";
import type { WiredContext } from "./wiredContext.js";
import { selectableAgentModels, type Orchestrator } from "./orchestrator.js";
import { buildSubagentInstruction, TOOL_SPECS, type SubagentService } from "./subagents.js";
import type { PatchSecret, PutSecret, Vault } from "./vault.js";
import { listProviders } from "./providers.js";
import { IdempotencyCache } from "./idempotency.js";
import type { SettingsPatch, SettingsStore } from "./settings.js";
import type { Session } from "./session.js";
import type { GitReview } from "./gitReview.js";
import type { WorkspaceFiles } from "./workspaceFiles.js";
import { DownloadLinks } from "./downloadLinks.js";
import { DavMounts, mountLocations } from "./davMounts.js";
import { WebDav } from "./webdav.js";
import type { ShardService } from "./shards.js";
import type { ClientFrame, CreateSessionInput, ProviderId, ServerFrame, ServerInfo } from "./types.js";
import { TasksService } from "./tasks.js";
import { OrganizationsService, organizationLimitsFromEnv, routeOrganizations } from "./organizations.js";
import { expireStaleCursors } from "./taskPresence.js";
import { registerWithInvitation } from "./invitationRegistration.js";
import { getRole, listUsers, requireAdmin, requireRoleValue, setUserRole } from "./admin.js";
import { PortRequests } from "./portRequests.js";
import { Approvals } from "./approvals.js";
import { Decisions } from "./decisions.js";
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
  manager: SessionManager;
  auth: Auth;
  settings: SettingsStore;
  github: GithubLinker;
  vault: Vault;
  orchestrator: Orchestrator;
  links: AgentLinks;
  notes: CanvasNotes;
  keychains: Keychains;
  /** Optional so existing callers keep working; absent = no wired-context feature. */
  wired?: WiredContext;
  subagents?: SubagentService;
  pool: pg.Pool;
  credentials: CredentialBroker;
  claudeOauth: ClaudeOAuth;
  usage: UsageService;
  skills: SkillsService;
  gitReview: GitReview;
  workspaceFiles?: WorkspaceFiles;
  /** Enables the read-only WebDAV mounts (Open in Explorer). */
  shards?: ShardService;
  tasks: TasksService;
}

export function createRuntimeServer({ config, manager, auth, settings, github, vault, orchestrator, links, notes, keychains, wired, subagents, pool, credentials, claudeOauth, usage, skills, gitReview, workspaceFiles, tasks, shards }: Deps) {
  const sessionCreates = new IdempotencyCache<Awaited<ReturnType<SessionManager["create"]>>>();
  const authHandler = toNodeHandler(auth);
  const organizations = new OrganizationsService(pool, { limits: organizationLimitsFromEnv(), inboxRequiresVerifiedEmail: config.allowSignup });
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
    scrub: (userId, ids, text) => (keychains ? keychains.redact(userId, ids, text) : Promise.resolve(text)),
    isAlive: (userId, sessionId) => { try { manager.getLive(sessionId, userId); return true; } catch { return false; } },
    // The runtime itself types the user's decision into the agent's terminal (trusted marker; agent text can never carry it).
    // Persisted first (agent_outbox): a target that is asleep or restarting gets the decision on its next ready.
    deliver: (userId, sessionId, text) => orchestrator.deliverApproval(userId, sessionId, text),
  });
  void approvals.init();
  const decisions = new Decisions({ pool, scrub: (userId, ids, text) => keychains ? keychains.redact(userId, ids, text) : Promise.resolve(text) });
  const decisionsReady = decisions.init();
  // Agent B's manager hook: whenever a session (re)starts and is ready, type what was queued for it while it was away.
  // Optional call: test harnesses build the server around partial fake managers.
  manager.onSessionReady?.((userId, sessionId) => { void orchestrator.deliverPending(userId, sessionId).catch((error) => log.warn("agent.outbox_ready_failed", { userId, sessionId, error: String(error).slice(0, 120) })); });
  const updates = new UpdateService(updatesConfigFromEnv(process.env, { version: config.version, providers: config.providers }), () => manager.activeCount);

  function rateLimitSetup(req: IncomingMessage): void {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = raw?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    res.setHeader("Access-Control-Expose-Headers", "set-auth-token");
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

  /** `--project`/`--global` for `floq mcp`: an explicit choice wins; otherwise the calling session's own project, else global. */
  function toolkitScope(body: Record<string, unknown>, callerProjectId: string | null): { scope: "global" | "project"; projectId?: string } {
    if (body.scope !== undefined && body.scope !== "global" && body.scope !== "project") throw badRequest("scope must be global or project");
    const scope = (body.scope as "global" | "project" | undefined) ?? (typeof body.projectId === "string" || callerProjectId ? "project" : "global");
    if (scope === "global") return { scope };
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : callerProjectId;
    if (!projectId) throw badRequest("This session is not in a registered project; pass --project <ID> or use --global", "no_project");
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
      switch (path) {
        case "vault/secrets":
          return send(res, 200, { secrets: (await vault.list(userId)).map((s) => ({ name: s.name, description: s.description })) });
        case "vault/reveal": {
          const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : null;
          return send(res, 200, { secrets: await vault.reveal(userId, names, null, sessionId) });
        }
        // Global vault secrets exposed as env (expose="env") for floq secret get/list; tool-only entries are never returned.
        case "secrets/global":
          return send(res, 200, { secrets: await vault.reveal(userId, null, "env", sessionId) });
        case "agents/list":
          return send(res, 200, { agents: await orchestrator.list(userId, sessionId, { project: body.project, here: body.here === true }) });
        case "projects/create": {
          if (method !== "POST") return send(res, 405, { error: { code: "method_not_allowed", message: "Use POST" } });
          const input = projectCreateInput(body);
          const project = await manager.createProject(userId, await settings.profile(userId), input.gitUrl, input.name);
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
        case "decisions/status": return send(res, 200, await decisions.status(userId, sessionId, body.id, Math.max(0, Number(body.waitSec) || 0) * 1000));
        case "decisions/cancel": return send(res, 200, await decisions.cancel(userId, sessionId, body.id));
        case "approvals/request": {
          const parties = await orchestrator.approvalParties(userId, sessionId, body.target);
          return send(res, 200, await approvals.request(userId, { requester: parties.requester, target: parties.target, action: body.action, detail: body.detail, ttlSec: body.timeoutSec, waiting: body.wait === true }));
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
          if (requested !== undefined && requested !== "claude" && requested !== "codex") throw badRequest("provider must be claude or codex");
          return send(res, 200, {
            models: await selectableAgentModels(config, (id) => manager.codexModels(id), userId, requested as "claude" | "codex" | undefined),
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
        case "agents/connect":
          return send(res, 200, await orchestrator.connect(userId, sessionId, body.from, body.to));
        case "agents/recruit":
          return send(res, 200, await orchestrator.recruit(userId, sessionId, body));
        // Always-recruit subagents (`floq subagent ...`): any agent session may use them; limits are enforced in SubagentService.
        case "agents/subagent/recruit":
          return send(res, 200, await requireSubagents().recruit(userId, sessionId, body));
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
          const target = toolkitScope(body, me.projectId);
          const result = await importCatalogSkill(userId, target, { provider: body.provider ?? me.provider, source: body.source, skillId: body.skillId, url: body.url });
          return send(res, 200, { ...result, ...target });
        }
        case "skills/create": {
          // A dry run only validates and describes, so any agent session may do it; creating needs a lead.
          const me = await orchestrator.toolkitCaller(userId, sessionId, body.dryRun !== true);
          const target = toolkitScope(body, me.projectId);
          const result = await skills.createSkill(userId, { ...target, provider: body.provider ?? me.provider, name: body.name, description: body.description, instructions: body.instructions, files: body.files, dryRun: body.dryRun });
          return send(res, 200, { ...result, ...target });
        }
        case "skills/remove":
          await orchestrator.toolkitCaller(userId, sessionId, true);
          return send(res, 200, await skills.removeSkillByName(userId, body.name, body.provider));
        case "mcp/list": {
          const me = await orchestrator.toolkitCaller(userId, sessionId, false);
          const target = toolkitScope(body, me.projectId);
          const provider = body.provider;
          if (provider !== undefined && provider !== "claude" && provider !== "codex") throw badRequest("provider must be claude or codex");
          return send(res, 200, { ...target, ...(await skills.listMcp(userId, target.scope, target.projectId, provider)) });
        }
        case "mcp/add": {
          // A dry run only validates and describes what would run, so it needs no lead.
          const me = await orchestrator.toolkitCaller(userId, sessionId, body.dryRun !== true);
          const target = toolkitScope(body, me.projectId);
          return send(res, 200, { ...target, ...(await installMcp(userId, sessionId, { ...target, providers: body.providers ?? me.provider, config: body.config, name: body.name, dryRun: body.dryRun, allowPlaintext: body.allowPlaintext }, false)) });
        }
        case "mcp/remove": {
          const me = await orchestrator.toolkitCaller(userId, sessionId, true);
          const target = toolkitScope(body, me.projectId);
          return send(res, 200, { ...target, ...(await skills.removeMcp(userId, { ...target, provider: body.provider ?? me.provider, name: body.name })) });
        }
        case "secrets/add": {
          const me = await orchestrator.toolkitCaller(userId, sessionId, true);
          if (!keychains) throw badRequest("Keychains are not available", "keychains_unavailable");
          // Agents store secrets in a keychain (never in the global vault). The value is readable by the agents linked to it.
          if (body.expose !== undefined) throw badRequest("Agent-created secrets always live in a keychain; exposure is not configurable.", "invalid_secret");
          const result = await keychains.agentAddSecret(userId, { id: me.id, name: me.name, projectId: me.projectId }, { name: body.name, value: body.value, keychain: body.keychain });
          await manager.syncSessionSecrets(userId, me.id);
          await touchSessions([me.id]);
          return send(res, 201, result);
        }
        // Keychain secrets are pulled on demand (never injected), so each use is recorded for the user to see.
        case "secrets/names": {
          await orchestrator.toolkitCaller(userId, sessionId, false);
          return send(res, 200, { secrets: keychains ? await keychains.pullableNames(userId, sessionId) : [] });
        }
        case "secrets/pull": {
          await orchestrator.toolkitCaller(userId, sessionId, false);
          const pulled = keychains ? await keychains.pull(userId, sessionId, body.name, body.keychain) : null;
          if (!pulled) throw notFound("No keychain linked to this agent holds a secret with that name");
          return send(res, 200, { value: pulled.value, keychain: pulled.keychain.name });
        }
        case "wired/get": {
          if (!wired) return send(res, 200, { block: "" });
          const { block } = await wired.sync(userId, sessionId);
          return send(res, 200, { block });
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
          const { sessionIds } = await notes.agentNoteDelete(userId, body.name);
          await touchSessions(sessionIds);
          return send(res, 200, { ok: true });
        }
        case "notes/write": {
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
      let signingOut: string | null = null;
      if (url.pathname === "/api/auth/sign-out") {
        const who = await authFor(req.headers).catch(() => null);
        signingOut = who?.userId ?? null;
        if (who) { downloadLinks.revokeSession(who.authSessionId); downloadLinks.revokeUser(who.userId); davMounts.revokeSession(who.authSessionId); davMounts.revokeUser(who.userId); }
      }
      await authHandler(req, res);
      if (signingOut) {
        void manager.sleepUser(signingOut, "logout").catch((error) =>
          log.error("logout.sleep_failed", { userId: signingOut, error: String(error) }),
        );
      }
      return;
    }

    if (method === "POST" && (url.pathname === "/v1/setup/lookup" || url.pathname === "/v1/setup/admin")) {
      rateLimitSetup(req);
      const body = await readJson<{ email?: unknown; password?: unknown; name?: unknown; companyName?: unknown }>(req);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (url.pathname === "/v1/setup/lookup") {
        return send(res, 200, { step: (await setupAvailable(pool, config, email)) ? "setup" : "password" });
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
      if (!(await createBootstrapAdmin(auth, pool, config, email, password, name, companyName))) {
        throw conflict("Setup is not available", "setup_unavailable");
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
      const registered = await registerWithInvitation(pool, { token, email, name, password }, (value) => context.password.hash(value));
      return send(res, 201, { ok: true, organizationId: registered.organizationId });
    }

    // Native downloads: authorised by a signed single-use link instead of a bearer header (see downloadLinks.ts).
    const downloadMatch = /^\/v1\/sessions\/([\w-]+)\/files\/download$/.exec(url.pathname);
    if (downloadMatch && method === "GET") {
      if (!workspaceFiles) throw notFound();
      const claims = downloadLinks.redeem(url.searchParams.get("t"));
      if (!claims || claims.s !== downloadMatch[1]) throw new HttpError(401, "invalid_download_link", "This download link has expired. Try again.");
      return workspaceFiles.download(claims.u, claims.s, claims.p, res, typeof req.headers.range === "string" ? req.headers.range : undefined);
    }

    const { userId, authSessionId } = await authFor(req.headers);
    davMounts.touch(userId);

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
      return send(res, 200, {
        server: info(),
        providers,
        githubConfigured: Boolean(config.githubClientId),
      });
    }

    // Read-only preview of the fixed subagent policy for Settings (the text is not editable by design).
    if (method === "GET" && url.pathname === "/v1/subagents/policy") {
      const limits = requireSubagents().limits;
      return send(res, 200, { enabled: (await settings.get(userId)).alwaysRecruitSubagents, limits, tools: TOOL_SPECS, instruction: buildSubagentInstruction({ enabled: true, depth: 0, limits, crossProject: (await settings.get(userId)).allowCrossProjectAgents }) });
    }
    if (url.pathname === "/v1/settings") {
      if (method === "GET") return send(res, 200, { settings: await settings.get(userId) });
      if (method === "PATCH" || method === "PUT") {
        const body = await readJson<SettingsPatch>(req);
        return send(res, 200, { settings: await settings.update(userId, body) });
      }
    }

    const organizationRoute = await routeOrganizations({ service: organizations, userId, method, pathname: url.pathname, readJson: () => readJson(req) });
    if (organizationRoute) return send(res, organizationRoute.status, organizationRoute.body);
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
      return send(res, 201, await installMcp(userId, null, await readJson<Record<string, unknown>>(req), true));
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
      return send(res, 200, await credentials.status(userId));
    }
    if (method === "GET" && url.pathname === "/v1/providers/usage") {
      return send(res, 200, await usage.get(userId));
    }
    if (method === "POST" && url.pathname === "/v1/providers/claude/oauth/start") {
      return send(res, 200, claudeOauth.start(userId));
    }
    if (method === "POST" && url.pathname === "/v1/providers/claude/oauth/finish") {
      const body = await readJson<{ flowId?: unknown; code?: unknown }>(req);
      return send(res, 200, await claudeOauth.finish(userId, body.flowId, body.code));
    }
    const login = /^\/v1\/providers\/(claude|codex)\/login$/.exec(url.pathname);
    if (login) {
      if (method === "POST") {
        const session = await manager.startLogin(userId, login[1] as ProviderId, await settings.profile(userId));
        return send(res, 201, { session });
      }
      if (method === "DELETE") {
        await manager.disconnectProvider(userId, login[1] as ProviderId);
        return send(res, 200, await credentials.status(userId));
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

    // Keychains: write-only wallets linked to agents. No endpoint returns a secret value.
    const touch = async (kc: Keychain, sessionIds: string[], notify = false) => {
      await wiredTouch(sessionIds, notify);
      let live = false;
      for (const id of new Set(sessionIds)) live = (await manager.syncSessionSecrets(userId, id)) || live;
      return { ...kc, appliesOnNextStart: live };
    };
    if (url.pathname === "/v1/keychains" && method === "GET") return send(res, 200, { keychains: await keychains.listAll(userId) });
    const kcList = /^\/v1\/projects\/([\w-]+)\/keychains$/.exec(url.pathname);
    if (kcList && method === "GET") return send(res, 200, { keychains: await keychains.list(userId, kcList[1]) });
    if (kcList && method === "POST") return send(res, 200, await keychains.create(userId, kcList[1], await readJson(req)));
    const kcOne = /^\/v1\/keychains\/([\w-]+)$/.exec(url.pathname);
    if (kcOne && method === "PATCH") return send(res, 200, await keychains.patch(userId, kcOne[1], await readJson(req)));
    if (kcOne && method === "DELETE") {
      const sessions = await keychains.remove(userId, kcOne[1]);
      for (const id of sessions) await manager.syncSessionSecrets(userId, id);
      await wiredTouch(sessions, true);
      return send(res, 200, { ok: true });
    }
    const kcSecret = /^\/v1\/keychains\/([\w-]+)\/secrets\/([^/]{1,64})$/.exec(url.pathname);
    if (kcSecret && method === "PUT") {
      const body = await readJson<{ value?: unknown }>(req, 64 * 1024);
      const kc = await keychains.putSecret(userId, kcSecret[1], kcSecret[2], body.value);
      return send(res, 200, await touch(kc, kc.linkedSessionIds));
    }
    if (kcSecret && method === "DELETE") {
      const kc = await keychains.removeSecret(userId, kcSecret[1], kcSecret[2]);
      return send(res, 200, await touch(kc, kc.linkedSessionIds));
    }
    const kcLink = /^\/v1\/keychains\/([\w-]+)\/links(?:\/([\w-]+))?$/.exec(url.pathname);
    if (kcLink && method === "POST" && !kcLink[2]) {
      const body = await readJson<{ sessionId?: unknown }>(req);
      const kc = await keychains.link(userId, kcLink[1], body.sessionId);
      return send(res, 200, await touch(kc, [body.sessionId as string], true));
    }
    if (kcLink && method === "DELETE" && kcLink[2]) {
      const kc = await keychains.unlink(userId, kcLink[1], kcLink[2]);
      return send(res, 200, await touch(kc, [kcLink[2]], true));
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

    if (url.pathname === "/v1/projects") {
      if (method === "GET") return send(res, 200, { projects: await manager.listProjects(userId) });
      if (method === "POST") {
        const input = projectCreateInput(await readJson<Record<string, unknown>>(req));
        const project = await manager.createProject(userId, await settings.profile(userId), input.gitUrl, input.name);
        return send(res, 201, { project });
      }
    }
    const projectMatch = /^\/v1\/projects\/([\w-]+)$/.exec(url.pathname);
    if (projectMatch && method === "PATCH") {
      const body = await readJson<{ displayName?: unknown; imageUrl?: unknown }>(req);
      return send(res, 200, { project: await manager.updateProject(userId, projectMatch[1], body) });
    }
    if (projectMatch && method === "DELETE") return send(res, 200, await manager.deleteProject(userId, projectMatch[1]));
    const projectDeleteStatus = /^\/v1\/projects\/([\w-]+)\/delete-status$/.exec(url.pathname);
    if (projectDeleteStatus && method === "GET") return send(res, 200, await manager.projectDeleteStatus(userId, projectDeleteStatus[1]));
    if (url.pathname === "/v1/project-folders") {
      if (method === "GET") return send(res, 200, await projectFolders.get(userId));
      if (method === "PUT") return send(res, 200, await projectFolders.put(userId, await readJson<unknown>(req, 512 * 1024)));
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
      const body = await readJson<{ branch?: unknown }>(req);
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
      if (method === "GET") return send(res, 200, { sessions: await manager.list(userId) });
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
        const create = () => manager.create(userId, profile, body, { isolated: body.isolated === true });
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

    const fileLinkMatch = /^\/v1\/sessions\/([\w-]+)\/files\/link$/.exec(url.pathname);
    if (fileLinkMatch && method === "POST") {
      if (!workspaceFiles) throw notFound();
      const body = await readJson<{ path?: unknown }>(req);
      const path = await workspaceFiles.authorizeDownload(userId, fileLinkMatch[1], body.path);
      const { token, expiresAt } = downloadLinks.issue({ userId, authSessionId, sessionId: fileLinkMatch[1], path });
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
        send(res, error.status, { error: { code: error.code, message: error.message } });
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  type TaskPeer = { ws: WebSocket; boardId: string; userId: string; name: string; x: number; y: number; activeAt: number; sentAt: number; cursorVisible: boolean };
  const taskPeers = new Set<TaskPeer>();
  async function broadcastTaskBoard(boardId: string): Promise<void> {
    const viewers = [...taskPeers].filter((peer) => peer.boardId === boardId && peer.ws.readyState === peer.ws.OPEN);
    if (!viewers.length) return;
    const board = await tasks.board(viewers[0].userId, boardId);
    const frame = JSON.stringify({ type: "board", board });
    for (const peer of viewers) peer.ws.send(frame);
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
        const token = url.searchParams.get("token");
        const boardId = url.searchParams.get("boardId");
        if (!token || !boardId) return reject(401, "Unauthorized");
        const headers = { ...req.headers, authorization: "Bearer " + token };
        const userId = await userFor(headers);
        const organizationId = await tasks.requireBoard(userId, boardId);
        const members = await tasks.members(userId, organizationId);
        const self = members.find((member) => member.id === userId);
        wss.handleUpgrade(req, socket, head, (ws) => attachTaskPeer(ws, boardId, userId, self?.name || self?.email || "Member"));
        return;
      }
      if (url.pathname === "/v1/events") {
        if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
        const token = url.searchParams.get("token");
        const headers = { ...req.headers };
        if (token) headers.authorization = "Bearer " + token;
        const userId = await userFor(headers);
        wss.handleUpgrade(req, socket, head, (ws) => {
          const off = links.hub.subscribe(userId, (event) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)); });
          const offPorts = portRequests.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offApprovals = approvals.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offDecisions = decisions.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offDisplays = manager.displays.subscribe(userId, (frame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); });
          const offAll = () => { off(); offPorts(); offApprovals(); offDecisions(); offDisplays(); };
          ws.on("close", offAll);
          ws.on("error", offAll);
        });
        return;
      }
      const tunnel = /^\/v1\/sessions\/([\w-]+)\/ports\/(\d{1,5})\/tunnel$/.exec(url.pathname);
      if (tunnel) {
        if (!originAllowed(req.headers.origin)) return reject(403, "Forbidden");
        // Same auth as the terminal stream: bearer header, or ?token= where headers cannot be set.
        const token = url.searchParams.get("token");
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
      const token = url.searchParams.get("token");
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

  function attachTaskPeer(ws: WebSocket, boardId: string, userId: string, name: string): void {
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
