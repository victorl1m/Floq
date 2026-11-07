import { createAuth, migrateAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { ClaudeOAuth } from "./claudeOauth.js";
import { UsageService } from "./usage.js";
import { CredentialBroker } from "./credentials.js";
import { createPool, migrateApp } from "./db.js";
import { GithubLinker } from "./github.js";
import { configureLogger, log } from "./logger.js";
import { SessionManager } from "./manager.js";
import { createShardDriver } from "./shard.js";
import { ShardService } from "./shards.js";
import { createRuntimeServer } from "./server.js";
import { SettingsStore } from "./settings.js";
import { AgentLinks } from "./links.js";
import { CanvasNotes } from "./notes.js";
import { Keychains } from "./keychains.js";
import { WiredContext } from "./wiredContext.js";
import { Orchestrator } from "./orchestrator.js";
import { SubagentService } from "./subagents.js";
import { Vault } from "./vault.js";
import { SkillsService } from "./skills.js";
import { GitReview } from "./gitReview.js";
import { WorkspaceFiles } from "./workspaceFiles.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { TasksService } from "./tasks.js";
import { PluginHost } from "./plugins/host.js";
import { BUILTIN_PLUGINS } from "./plugins/index.js";
import { removeOwnedPluginSkill } from "./plugins/skillOwnership.js";
import { CatalogClient } from "./plugins/catalog.js";
import { loadInstalledPackages, pluginDirFromEnv } from "./plugins/installed.js";
import { PluginInstaller } from "./plugins/installer.js";
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
const credentials = new CredentialBroker(pool, config);
manager.credentials = credentials;
credentials.onChange = (userId, provider, data) => void manager.distribute(userId, provider, data).catch(() => undefined);
const claudeOauth = new ClaudeOAuth(config, credentials);
claudeOauth.onConnected = (userId, data) => void manager.distribute(userId, "claude", data).catch(() => undefined);
credentials.start();
const usage = new UsageService(credentials);
const agentLinks = new AgentLinks(pool);
const keychains = new Keychains(pool, config);
manager.keychains = keychains;
const canvasNotes = new CanvasNotes(pool);
const wired = new WiredContext(pool, (userId, sessionId) => keychains.resolve(userId, sessionId));
manager.wired = wired;
const orchestrator = new Orchestrator(pool, manager, settings, agentLinks, keychains);
const subagents = new SubagentService(pool, orchestrator, manager, settings);
manager.subagents = subagents;
const gitReview = new GitReview(manager, shards);
const workspaceFiles = new WorkspaceFiles(manager, shards);
const tasks = new TasksService(prisma);
const plugins = new PluginHost(pool, { plugins: BUILTIN_PLUGINS, encryptionKey: config.encryptionKey });
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
const server = createRuntimeServer({ config, manager, auth, settings, github, vault, orchestrator, links: agentLinks, notes: canvasNotes, keychains, wired, subagents, pool, credentials, claudeOauth, usage, skills, gitReview, workspaceFiles, tasks, shards, plugins });

await server.listen();
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

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("runtime.stopping", { signal });
  credentials.stop();
  await plugins.stopAll();
  await manager.shutdown();
  await server.close();
  await pool.end();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
