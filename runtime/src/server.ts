import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { selectableAgentModels, type Orchestrator } from "./orchestrator.js";
import type { PatchSecret, PutSecret, Vault } from "./vault.js";
import { listProviders } from "./providers.js";
import { IdempotencyCache } from "./idempotency.js";
import type { SettingsPatch, SettingsStore } from "./settings.js";
import type { Session } from "./session.js";
import type { GitReview } from "./gitReview.js";
import type { ClientFrame, CreateSessionInput, ProviderId, ServerFrame, ServerInfo } from "./types.js";
import { TasksService } from "./tasks.js";
import { expireStaleCursors } from "./taskPresence.js";
import { registerWithInvitation } from "./invitationRegistration.js";

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
  pool: pg.Pool;
  credentials: CredentialBroker;
  claudeOauth: ClaudeOAuth;
  usage: UsageService;
  skills: SkillsService;
  gitReview: GitReview;
  tasks: TasksService;
}

export function createRuntimeServer({ config, manager, auth, settings, github, vault, orchestrator, pool, credentials, claudeOauth, usage, skills, gitReview, tasks }: Deps) {
  const sessionCreates = new IdempotencyCache<Awaited<ReturnType<SessionManager["create"]>>>();
  const authHandler = toNodeHandler(auth);
  const setupHits = new Map<string, { count: number; resetAt: number }>();
  const scheduledAgentRestarts = new Set<string>();

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

  async function userFor(headers: IncomingMessage["headers"]): Promise<string> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!result) throw unauthorized();
    return result.user.id;
  }

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
      switch (path) {
        case "vault/secrets":
          return send(res, 200, { secrets: (await vault.list(userId)).map((s) => ({ name: s.name, description: s.description })) });
        case "vault/reveal": {
          const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : null;
          return send(res, 200, { secrets: await vault.reveal(userId, names, null, sessionId) });
        }
        case "agents/list":
          return send(res, 200, { agents: await orchestrator.list(userId, sessionId) });
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
        case "agents/ask":
          return send(res, 200, await orchestrator.ask(userId, sessionId, body.name, body.prompt, Number(body.timeoutSec) || undefined));
        case "agents/check":
          return send(res, 200, await orchestrator.check(userId, sessionId, body.name, Number(body.chars) || undefined));
        case "agents/connect":
          return send(res, 200, await orchestrator.connect(userId, sessionId, body.from, body.to));
        case "agents/recruit":
          return send(res, 200, await orchestrator.recruit(userId, sessionId, body));
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
          await orchestrator.toolkitCaller(userId, sessionId, true);
          // Agents may only create tool-only secrets; "env" would make the value readable by the agent.
          if (body.expose !== undefined && body.expose !== "tool") throw badRequest("Agents can only create tool-only secrets. The owner can change exposure in Floq > Vault.", "invalid_secret");
          const secrets = await vault.create(userId, sessionId, { name: body.name, value: body.value, description: body.description });
          return send(res, 201, { secrets: secrets.map((s) => ({ name: s.name, description: s.description })) });
        }
        case "notes/list":
          return send(res, 200, await orchestrator.noteList(userId));
        case "notes/read":
          return send(res, 200, await orchestrator.noteRead(userId, body.name));
        case "notes/write":
          return send(res, 200, await orchestrator.noteWrite(userId, body.name, body.content, body.append === true));
        default:
          throw notFound();
      }
    }

    if (!originAllowed(req.headers.origin)) throw forbidden();

    if (url.pathname.startsWith("/api/auth/")) {
      // Logging out puts the user's terminals and shard to sleep.
      let signingOut: string | null = null;
      if (url.pathname === "/api/auth/sign-out") signingOut = await userFor(req.headers).catch(() => null);
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

    if (method === "POST" && url.pathname === "/v1/team-invitations/register") {
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
      return send(res, 201, { ok: true, teamId: registered.teamId });
    }

    const userId = await userFor(req.headers);

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

    if (url.pathname === "/v1/settings") {
      if (method === "GET") return send(res, 200, { settings: await settings.get(userId) });
      if (method === "PATCH" || method === "PUT") {
        const body = await readJson<SettingsPatch>(req);
        return send(res, 200, { settings: await settings.update(userId, body) });
      }
    }

    if (url.pathname === "/v1/teams" && method === "GET") return send(res, 200, { teams: await tasks.teams(userId) });
    if (url.pathname === "/v1/teams" && method === "POST") return send(res, 201, { team: await tasks.createTeam(userId, await readJson(req)) });
    if (url.pathname === "/v1/team-invitations/accept" && method === "POST") {
      const result = await tasks.acceptInvite(userId, (await readJson<{ token?: unknown }>(req)).token);
      return send(res, 200, result);
    }
    const teamMatch = /^\/v1\/teams\/([\w-]+)(?:\/(members|invitations|boards))?$/.exec(url.pathname);
    if (teamMatch) {
      const [, teamId, action] = teamMatch;
      if (!action && method === "GET") return send(res, 200, { members: await tasks.members(userId, teamId) });
      if (action === "invitations" && method === "POST") return send(res, 201, { invitation: await tasks.createInvite(userId, teamId, await readJson(req)) });
      if (action === "boards" && method === "GET") return send(res, 200, { boards: await tasks.boards(userId, teamId) });
      if (action === "boards" && method === "POST") {
        const board = await tasks.createBoard(userId, teamId, await readJson(req));
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

    if (url.pathname === "/v1/projects") {
      if (method === "GET") return send(res, 200, { projects: await manager.listProjects(userId) });
      if (method === "POST") {
        const body = await readJson<{ gitUrl?: unknown; name?: unknown }>(req);
        if (typeof body.gitUrl !== "string" || !body.gitUrl.trim()) throw badRequest("gitUrl is required", "invalid_project");
        if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 120)) throw badRequest("name must be at most 120 characters", "invalid_project");
        const project = await manager.createProject(userId, await settings.profile(userId), body.gitUrl, body.name as string | undefined);
        return send(res, 201, { project });
      }
    }
    const projectMatch = /^\/v1\/projects\/([\w-]+)$/.exec(url.pathname);
    if (projectMatch && method === "PATCH") {
      const body = await readJson<{ displayName?: unknown; imageUrl?: unknown }>(req);
      return send(res, 200, { project: await manager.updateProject(userId, projectMatch[1], body) });
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
        const teamId = await tasks.requireBoard(userId, boardId);
        const members = await tasks.members(userId, teamId);
        const self = members.find((member) => member.id === userId);
        wss.handleUpgrade(req, socket, head, (ws) => attachTaskPeer(ws, boardId, userId, self?.name || self?.email || "Teammate"));
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
