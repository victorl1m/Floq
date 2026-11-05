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
await shards.driver.init?.(); // FLOQ_NETNS startup probe (no-op unless the flag is set)
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
const server = createRuntimeServer({ config, manager, auth, settings, github, vault, orchestrator, links: agentLinks, notes: canvasNotes, keychains, wired, subagents, pool, credentials, claudeOauth, usage, skills, gitReview, workspaceFiles, tasks, shards });

await server.listen();
log.info("runtime.listening", {
  host: config.host,
  port: config.port,
  version: config.version,
  signup: config.allowSignup,
  github: Boolean(config.githubClientId),
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("runtime.stopping", { signal });
  credentials.stop();
  await manager.shutdown();
  await server.close();
  await pool.end();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
