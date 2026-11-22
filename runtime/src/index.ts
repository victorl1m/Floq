import { dirname, join } from "node:path";
import { createAuth, migrateAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { warmProviderVersions } from "./providers.js";
import { ClaudeOAuth } from "./claudeOauth.js";
import { UsageService } from "./usage.js";
import { ClaudeConnectors, apiKeyReachesSessions } from "./claudeConnectors.js";
import { FallbackService } from "./fallback.js";
import { NEAR_FULL_PERCENT } from "./limitText.js";
import { buildHandoff, parseClaudeContext } from "./handoff.js";
import { ClaudeAccounts } from "./claudeAccounts.js";
import { CredentialBroker } from "./credentials.js";
import { createPool, migrateApp } from "./db.js";
import { GithubLinker } from "./github.js";
import { configureLogger, log } from "./logger.js";
import { SessionManager } from "./manager.js";
import { createShardDriver } from "./shard.js";
import { ShardService } from "./shards.js";
import { createRuntimeServer } from "./server.js";
import { Notifications } from "./notifications.js";
import { MOUNT_RECOVERY_NOTICE, RestartStormGuard, recoverFromMountDeath } from "./mountWatch.js";
import { SetupToken } from "./setupToken.js";
import { SettingsStore } from "./settings.js";
import { AgentLinks } from "./links.js";
import { CanvasNotes } from "./notes.js";
import { MemoryService } from "./memories.js";
import { startMemoryImport } from "./memoryImport.js";
import { createEmbedder } from "./embeddings.js";
import { WiredContext } from "./wiredContext.js";
import { Orchestrator } from "./orchestrator.js";
import { SubagentService } from "./subagents.js";
import { Vault } from "./vault.js";
import { SkillsService } from "./skills.js";
import { GitReview } from "./gitReview.js";
import { Artifacts } from "./artifacts.js";
import { WorkspaceFiles } from "./workspaceFiles.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { TasksService } from "./tasks.js";
import { ProjectTasks } from "./projectTasks.js";
import { Automations } from "./automations.js";
import { TaskScheduler } from "./taskScheduler.js";
import { StorageSense } from "./storageSense/service.js";
import { PluginHost, publicBaseFrom } from "./plugins/host.js";
import { BUILTIN_PLUGINS } from "./plugins/index.js";
import { BuiltinWhatsapp, WHATSAPP_PLUGIN_ID, builtinWhatsappFromEnv, engineDocker, whatsappIntegration } from "./whatsappServer.js";
import { removeOwnedPluginSkill } from "./plugins/skillOwnership.js";
import { CatalogClient } from "./plugins/catalog.js";
import { loadInstalledPackages, pluginDirFromEnv } from "./plugins/installed.js";
import { PluginInstaller } from "./plugins/installer.js";
import { BrowserService } from "./browser.js";
import { EgressHub } from "./browserEgress.js";
import { BrowserLinks } from "./browserLinks.js";
import { FLOQ_BROWSER_MCP_SPEC } from "./mcpConfig.js";
import { sha256Hex } from "./plugins/package.js";

process.on("uncaughtException", (error) => log.error("process.uncaught", { error: error instanceof Error ? error.message : String(error) }));
process.on("unhandledRejection", (reason) => log.error("process.unhandled_rejection", { error: reason instanceof Error ? reason.message : String(reason) }));

const config = loadConfig();
configureLogger(config);

const pool = createPool(config);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
const auth = createAuth(config, pool);
await migrateAuth(auth);
await migrateApp(pool);

// First-run admin claim needs a one-time token: printed once here, only its hash is stored.
const setupToken = new SetupToken(pool);
const issuedSetupToken = await setupToken.issueIfNeeded(config.bootstrapAdminEmail);
if (issuedSetupToken) {
  process.stdout.write(
    `\n=== FLOQ SETUP TOKEN ===\nEnter this token in the app to create the administrator for ${config.bootstrapAdminEmail}.\nIt is shown once, works once, and a new one is issued on restart while setup is unclaimed:\n\n  ${issuedSetupToken}\n\n========================\n\n`,
  );
}

const settings = new SettingsStore(pool, config);
const github = new GithubLinker(config, settings);
const shards = new ShardService(pool, config, createShardDriver(config));
await shards.reconcile();
// FLOQ_NETNS startup probe (no-op unless the flag is set). Deliberately AFTER reconcile(): reconcile unmounts every shard
// left over from a previous run, so no sandbox can still be inside a namespace when init() removes the stale ones.
await shards.driver.init?.();
const vault = new Vault(pool, config);
const manager = new SessionManager(config, pool, shards, vault);
const skills = new SkillsService(config, shards, pool, (userId, operation) => manager.withUserShardActivity(userId, operation));
// Agent browser: one sandboxed Chromium daemon per user (docs/design/agent-browser.md). The floq-browser MCP entry follows the user's toggle.
const browser = new BrowserService(shards, settings, { sync: (userId, desired) => skills.syncReservedMcp(userId, FLOQ_BROWSER_MCP_SPEC, desired) }, config.browser, (userId) => manager.inNetns(userId));
browser.egress = new EgressHub({ onChange: (userId, rttOnly) => browser.onEgressChange(userId, rttOnly) });
manager.settings = settings;
manager.attachBrowser(browser);
shards.onWake = (userId) => { manager.noteShardAwake(userId); void browser.syncMcp(userId).catch((error) => log.warn("browser.mcp_sync_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" })); };
const credentials = new CredentialBroker(pool, config);
manager.credentials = credentials;
credentials.onChange = (userId, provider, data) => void manager.distribute(userId, provider, data).catch(() => undefined);
const claudeOauth = new ClaudeOAuth(config, credentials);
const claudeConnectors = new ClaudeConnectors({ credentials, apiKeyInEnv: () => apiKeyReachesSessions(config) });
claudeOauth.onConnected = (userId, data) => { claudeConnectors.invalidate(userId); void manager.distribute(userId, "claude", data).catch(() => undefined); };
credentials.start();
const usage = new UsageService(credentials);
// Extra Claude logins: the active one stays in provider_credentials, the others are reserves (see claudeAccounts.ts).
const claudeAccounts = new ClaudeAccounts(pool, config, credentials, { fetchUsage: (data) => usage.claudeWindowsOf(data) });
claudeAccounts.onActiveChanged = (userId, data) => { usage.invalidate(userId, "claude"); claudeConnectors.invalidate(userId); void manager.distribute(userId, "claude", data).catch(() => undefined); };
claudeOauth.accounts = claudeAccounts;
claudeAccounts.beforeSwitch = (userId) => manager.syncClaudeNow(userId);
claudeAccounts.onReset = (userId) => void fallback.accountChangedByUser(userId).catch(() => undefined);
manager.accounts = claudeAccounts;
claudeAccounts.start();
// Claude usage-limit fallback: lower model or pause at a limit block, and back again when the window resets.
const fallback = new FallbackService(pool, {
  readTranscript: (id, userId) => manager.readTranscriptText(id, userId),
  isLive: (id, userId) => Boolean(manager.findLive(id, userId)?.isAlive),
  quietMs: (id) => manager.outputQuietMs(id),
  isIdle: (id, userId) => manager.readAgentTurn(id, userId)?.status !== "working",
  queueNotice: (id, text) => manager.queueBootNotice(id, text),
  dropNotice: (id) => manager.dropBootNotice(id),
  transcriptStamp: (id, userId) => manager.transcriptStamp(id, userId),
  restart: async (userId, id) => { await manager.restartSelf(userId, await settings.profile(userId), id); },
  sleep: (id, reason) => manager.sleepSession(id, reason, { resumeOnBoot: false }),
  notifyParent: async (userId, parentId, text) => { await manager.typeNotice(userId, parentId, text); },
  buildHandoff: async ({ userId, id, direction, n, reason, previousHandoff }) => {
    const found = (await pool.query("SELECT title, cwd, role, parent_session_id FROM agent_sessions WHERE id = $1 AND user_id = $2", [id, userId])).rows[0] as { title: string; cwd: string; role: string | null; parent_session_id: string | null } | undefined;
    const git = await gitReview.changes(userId, id).then((c) => ({ branch: c.branch, changes: c.changes.map((x) => ({ status: x.status, path: x.path })), truncated: c.truncated })).catch(() => null);
    const context = direction === "to-codex"
      ? parseClaudeContext(manager.readTranscriptHeadText(id, userId, 256 * 1024) ?? "", manager.readTranscriptText(id, userId) ?? "")
      : { firstPrompt: null, lastPrompts: [], lastReply: null, todos: [] };
    const text = buildHandoff({
      direction, title: found?.title ?? "Agent", cwd: found?.cwd ?? "", role: found?.role ?? null, parentSessionId: found?.parent_session_id ?? null,
      reason, context, git, transcriptPath: direction === "to-codex" ? manager.transcriptSandboxPath(id, userId) : null,
      codexReply: direction === "to-claude" ? manager.readAgentTurn(id, userId)?.reply ?? null : null, previousHandoff,
    });
    return manager.writeHandoffFile(userId, `${id}-${n}.md`, text);
  },
  switchProvider: async (userId, id, to) => { await manager.switchProvider(userId, await settings.profile(userId), id, to); },
  resume: async (userId, id) => { await manager.resume(userId, await settings.profile(userId), id, { strict: true }); },
}, (userId) => settings.usageFallback(userId));
fallback.codex = {
  usable: async (userId) => { if (!(await manager.providerConnected(userId, "codex"))) return false; const u = (await usage.get(userId)).codex; return Boolean(u?.connected) && (u?.windows.length ?? 0) > 0 && (u?.windows ?? []).every((w) => w.usedPercent < 100); },
  defaultModel: async (userId) => (await manager.codexModels(userId))[0]?.id ?? null,
};
fallback.accounts = claudeAccounts;
fallback.usage = {
  claudeBlocked: async (userId) => {
    const windows = (await usage.get(userId)).claude?.windows ?? [];
    const full = windows.filter((w) => w.id !== "extra_usage" && w.usedPercent >= NEAR_FULL_PERCENT && w.resetsAt && Date.parse(w.resetsAt) > Date.now());
    full.sort((a, b) => Date.parse(b.resetsAt!) - Date.parse(a.resetsAt!));
    return full[0] ? { window: full[0].id, resetsAt: full[0].resetsAt! } : null;
  },
  claudeWindow: async (userId, windowId) => (await usage.get(userId)).claude?.windows.find((w) => w.id === windowId) ?? null };
manager.fallback = fallback;
void fallback.start().catch((error) => log.error("fallback.start_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
const agentLinks = new AgentLinks(pool);
const browserLinks = new BrowserLinks(pool);
browser.links = browserLinks;
const canvasNotes = new CanvasNotes(pool);
const wired = new WiredContext(pool);
wired.browserEnabled = async (userId) => browser.capability() === "available" && (await settings.agentBrowser(userId));
manager.wired = wired;
// Agent memory is on only when FLOQ_REDIS_URL is set. It connects in the background and never delays boot.
const memories = new MemoryService(pool, { url: config.redisUrl ?? undefined, embedder: createEmbedder({ ...process.env, FLOQ_EMBEDDINGS: config.embeddings }, { cacheDir: process.env.FLOQ_EMBEDDINGS_CACHE?.trim() || join(dirname(config.shardRoot), "embeddings") }) });
memories.start();
if (memories.enabled()) {
  wired.memories = memories; manager.memories = memories; canvasNotes.memories = memories;
  // First-enable import of legacy kind=memory notes (idempotent, Redis markers, notes untouched).
  const rawCmd = memories.marker;
  startMemoryImport(pool, memories, rawCmd);
}
const orchestrator = new Orchestrator(pool, manager, settings, agentLinks);
const subagents = new SubagentService(pool, orchestrator, manager, settings);
manager.subagents = subagents;
subagents.memoryOn = memories.enabled();
const gitReview = new GitReview(manager, shards);
const workspaceFiles = new WorkspaceFiles(manager, shards);
const artifacts = new Artifacts(manager, shards);
const tasks = new TasksService(prisma);
// The built-in WhatsApp server (compose profile `whatsapp`): the WhatsApp plugin gets its address and key from the host, no manual setup.
const whatsappConfig = builtinWhatsappFromEnv(process.env);
if (whatsappConfig.problem) log.warn("whatsapp.builtin_not_used", { reason: whatsappConfig.problem });
const whatsapp: BuiltinWhatsapp = new BuiltinWhatsapp({
  cfg: whatsappConfig, pool, docker: engineDocker(),
  plugin: () => plugins.serviceOf(WHATSAPP_PLUGIN_ID),
  // Update results go to every administrator.
  notify: async (n) => {
    const admins = (await pool.query("SELECT user_id FROM collaboration.user_roles WHERE role = 'admin'")).rows as { user_id: string }[];
    for (const a of admins) await notifications.create(a.user_id, { title: n.title, body: n.body, level: n.level, category: "system" }).catch(() => undefined);
  },
});
const plugins: PluginHost = new PluginHost(pool, { plugins: BUILTIN_PLUGINS, encryptionKey: config.encryptionKey, publicUrl: publicBaseFrom(config.publicUrl, config.authUrl), integrations: { [WHATSAPP_PLUGIN_ID]: whatsappIntegration(whatsappConfig, () => whatsapp.noteActivity()) } });
// Installed packages (Settings > Plugins > Browse plugins) load next to the built-ins; a broken one is listed as invalid and boot goes on.
const pluginDir = pluginDirFromEnv();
await loadInstalledPackages(pool, plugins, pluginDir, sha256Hex).then((r) => log.info("plugins.installed_loaded", r)).catch((error) => log.error("plugins.installed_load_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
plugins.setInstaller(new PluginInstaller({ pool, host: plugins, catalog: new CatalogClient(), pluginDir }));
plugins.setSkills({
  setPluginSkills: (id, root, names) => skills.setPluginSkills(id, root, names),
  // Plugin skills are copied into the user's own agent home (global scope, both providers): that is where agents load skills from.
  installSkill: async (userId, _name, files) => { for (const provider of ["claude", "codex"] as const) await skills.addSkillPackage(userId, { scope: "global", provider, files }); },
  // Only copies this plugin installed (marker file) are removed; a skill the user already had under that name stays.
  removeSkill: async (userId, name, pluginId) => { await removeOwnedPluginSkill(skills, userId, name, pluginId); },
});
// Before load(): the one-time move of plugin credentials out of the vault needs to read (and clean) the user's MCP configs.
plugins.setSecretMigrationPort({
  vaultReferences: async (userId) => {
    const listed = await skills.listMcp(userId, "global");
    return listed.homeScanned ? listed.servers.map((s) => ({ entry: s.name, secretNames: s.secretNames ?? [] })) : null;
  },
  remove: (userId, name, provider) => skills.removeMcp(userId, { scope: "global", provider, name }),
});
await plugins.load();
// A dead gocryptfs mount was remounted: live agent sandboxes still hold the dead mount, so restart them (guarded) and tell the user.
const notifications = new Notifications({ pool });
const mountStormGuard = new RestartStormGuard();
// Storage Sense (bundled plugin) reaches awake homes only through this narrow host API.
{
  const storageSense = new StorageSense(manager.storageSenseHost());
  const host = manager.storageSenseHost();
  plugins.setStorageSense({
    awakeUserIds: () => host.awakeUserIds(),
    run: (userId, config, options) => storageSense.run(userId, config, options),
    freePercent: (userId) => host.freePercent(userId),
    notify: async (userId, note) => { await notifications.create(userId, { title: note.title, body: note.body, level: note.level, category: "system" }); },
  });
}
shards.onMountRecovered = async (userId) => {
  await recoverFromMountDeath({
    guard: mountStormGuard,
    restartSessions: async (id) => manager.restartLiveSessionsForUser(id, await settings.profile(id), MOUNT_RECOVERY_NOTICE),
    notify: async (id, n) => { await notifications.create(id, { title: n.title, body: n.body, level: n.level, category: "system" }); },
  }, userId);
};
const projectTasks = new ProjectTasks(pool);
const automations = new Automations(pool, projectTasks);
const server = createRuntimeServer({ projectTasks, automations, notifications, config, setupToken, manager, auth, settings, github, vault, orchestrator, links: agentLinks, notes: canvasNotes, wired, subagents, memories, pool, credentials, claudeOauth, usage, claudeConnectors, fallback, claudeAccounts, skills, gitReview, workspaceFiles, artifacts, tasks, shards, plugins, whatsapp, browser, browserLinks });

// The one synchronous CLI version check happens here, before clients connect; afterwards it only refreshes in the background.
warmProviderVersions(config);
await server.listen();
whatsapp.start();
log.info("runtime.listening", {
  host: config.host,
  port: config.port,
  version: config.version,
  signup: config.allowSignup,
  github: Boolean(config.githubClientId),
});

// Continue the work the previous runtime interrupted at shutdown (sessions the user put to sleep are not flagged).
void manager.resumeAfterBoot((userId) => settings.profile(userId))
  .then((r) => log.info("runtime.boot_resume_done", r))
  .catch((error) => log.error("runtime.boot_resume_failed", { error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));

// Task scheduler: due automations create tasks, due todo tasks go to their agent (auto-agent projects only). State lives in Postgres, so a restart resumes cleanly.
const taskScheduler = new TaskScheduler(pool, automations, projectTasks, {
  deliver: (userId, sessionId, from, text) => orchestrator.deliverSystem(userId, sessionId, from, text),
  notify: async (userId, n) => { await notifications.create(userId, { title: n.title, body: n.body, level: n.level, category: "agent", projectId: n.projectId }); },
}, { firstDelayMs: 20_000 });
taskScheduler.start();

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("runtime.stopping", { signal });
  credentials.stop();
  taskScheduler.stop();
  whatsapp.stop();
  await plugins.stopAll();
  await browser.shutdown();
  browser.egress?.close();
  await manager.shutdown();
  await server.close();
  await pool.end();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
