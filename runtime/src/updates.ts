import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { badRequest, conflict, HttpError } from "./errors.js";
import { log } from "./logger.js";
import { dockerSelfUpdateAvailable, startDockerSelfUpdate, latestReleaseTag } from "./selfUpdate.js";

export const UPDATE_TARGETS = ["runtime", "claude", "codex", "whatsapp"] as const;
export type UpdateTarget = (typeof UPDATE_TARGETS)[number];

export function isUpdateTarget(value: unknown): value is UpdateTarget {
  return typeof value === "string" && (UPDATE_TARGETS as readonly string[]).includes(value);
}

export interface UpdateItem {
  target: UpdateTarget;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  source: string;
  error?: string;
  /** WhatsApp server only: false = an external WAHA, listed but updated where it is hosted. */
  managed?: boolean;
}

/** The built-in WhatsApp server (whatsappServer.ts), as far as updates are concerned. */
export interface WhatsappUpdates {
  updateItem(): Promise<UpdateItem | null>;
  applyUpdate(actorId: string, force: boolean): Promise<{ log: string }>;
}

export interface UpdatesConfig {
  version: string;
  providers: { claude: string; codex: string };
  /** "owner/name" for GitHub releases. */
  repo: string;
  runtimeDir: string;
  /** Operator-defined argv that upgrades the runtime (e.g. a deploy script). Never derived from requests. */
  runtimeCommand: string[] | null;
  /** Docker self-update (socket mounted, see selfUpdate.ts). Injected for tests; defaults to checking the socket. */
  dockerSelfUpdate?: boolean;
}
const CLI_PACKAGES: Record<"claude" | "codex", string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
const CACHE_MS = 10 * 60_000;
const NET_TIMEOUT_MS = 8_000;
const APPLY_TIMEOUT_MS = 10 * 60_000;
const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** Extract the first semver-looking token from CLI output or a tag such as "v1.2.3". */
export function parseVersion(text: string): string | null {
  const m = SEMVER.exec(text);
  return m ? m[0] : null;
}

/** Negative if a < b, 0 if equal, positive if a > b. Prereleases sort before the release. Unparseable gives NaN. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

export function isNewer(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const c = compareVersions(latest, current);
  return Number.isFinite(c) && c > 0;
}

/** Operator-provided JSON argv array, e.g. ["/usr/local/bin/floq-upgrade"]. Invalid values are ignored. */
export function parseCommand(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0)) return v as string[];
  } catch {
    // fall through
  }
  return null;
}

export function updatesConfigFromEnv(env: NodeJS.ProcessEnv, base: { version: string; providers: { claude: string; codex: string } }): UpdatesConfig {
  const repo = env.FLOQ_UPDATE_REPO?.trim() || "victorl1m/Floq";
  return {
    ...base,
    repo: /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : "victorl1m/Floq",
    runtimeDir: env.FLOQ_UPDATE_RUNTIME_DIR?.trim() || process.cwd(),
    runtimeCommand: parseCommand(env.FLOQ_UPDATE_RUNTIME_COMMAND),
  };
}

interface RunResult { stdout: string; stderr: string; ok: boolean; error?: string }

function run(file: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeout ?? NET_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), ok: !error, error: error ? error.message.split("\n")[0].slice(0, 200) : undefined });
    });
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS), headers: { Accept: "application/json", "User-Agent": "floq-runtime" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const message = (e: unknown) => (e instanceof Error ? e.message : "unknown error").slice(0, 200);

export class UpdateService {
  private cache: { at: number; items: UpdateItem[] } | null = null;
  private applying: UpdateTarget | null = null;

  constructor(
    private readonly cfg: UpdatesConfig,
    private readonly liveSessions: () => number,
    private readonly requestRestart: () => void = () => void process.kill(process.pid, "SIGTERM"),
    private readonly whatsapp?: WhatsappUpdates,
  ) {}

  async check(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.snapshot();
    const items: UpdateItem[] = await Promise.all([this.checkRuntime(), this.checkCli("claude"), this.checkCli("codex")]);
    // Listed only when there is a WhatsApp server: the built-in one, or an external one the plugin points at.
    const whatsapp = await this.whatsapp?.updateItem().catch(() => null);
    if (whatsapp) items.push(whatsapp);
    this.cache = { at: Date.now(), items };
    return this.snapshot();
  }

  private snapshot() {
    return { items: this.cache!.items, checkedAt: new Date(this.cache!.at).toISOString(), activeSessions: this.liveSessions(), applying: this.applying };
  }

  private gitRoot(): string | null {
    for (const dir of [this.cfg.runtimeDir, this.cfg.runtimeDir + "/.."]) if (existsSync(dir + "/.git")) return dir;
    return null;
  }

  private async checkRuntime(): Promise<UpdateItem> {
    const item: UpdateItem = { target: "runtime", current: this.cfg.version, latest: null, updateAvailable: false, source: `github:${this.cfg.repo}` };
    try {
      const tag = await latestReleaseTag(this.cfg.repo);
      item.latest = tag ? parseVersion(tag) : null;
      item.updateAvailable = isNewer(item.current, item.latest);
      if (!item.latest) item.error = "Latest release has no version tag";
    } catch (error) {
      // No release published: fall back to comparing git HEAD with its upstream when running from a checkout.
      if (this.gitRoot()) return this.checkGit(item, message(error));
      item.error = "Could not read releases: " + message(error);
    }
    return item;
  }

  private async checkGit(item: UpdateItem, releaseError: string): Promise<UpdateItem> {
    const cwd = this.gitRoot()!;
    item.source = "git";
    const fetched = await run("git", ["fetch", "--quiet"], { cwd, timeout: 30_000 });
    const head = await run("git", ["rev-parse", "--short", "HEAD"], { cwd });
    const up = await run("git", ["rev-parse", "--short", "@{u}"], { cwd });
    const behind = await run("git", ["rev-list", "--count", "HEAD..@{u}"], { cwd });
    if (!head.ok || !up.ok || !behind.ok) {
      item.error = `No release (${releaseError}) and git comparison failed`;
      return item;
    }
    item.current = `${this.cfg.version} (${head.stdout.trim()})`;
    item.latest = up.stdout.trim();
    item.updateAvailable = Number(behind.stdout.trim()) > 0;
    if (!fetched.ok) item.error = "git fetch failed: " + (fetched.error ?? "");
    return item;
  }

  private async checkCli(target: "claude" | "codex"): Promise<UpdateItem> {
    const item: UpdateItem = { target, current: null, latest: null, updateAvailable: false, source: `npm:${CLI_PACKAGES[target]}` };
    const errors: string[] = [];
    const [ver, latest] = await Promise.allSettled([
      run(this.cfg.providers[target], ["--version"]),
      fetchJson(`https://registry.npmjs.org/${CLI_PACKAGES[target].replace("/", "%2F")}/latest`),
    ]);
    if (ver.status === "fulfilled" && ver.value.ok) item.current = parseVersion(ver.value.stdout);
    if (!item.current) errors.push("Installed version unknown" + (ver.status === "fulfilled" && ver.value.error ? ": " + ver.value.error : ""));
    if (latest.status === "fulfilled") {
      const v = (latest.value as { version?: unknown }).version;
      item.latest = typeof v === "string" ? parseVersion(v) : null;
    }
    if (!item.latest) errors.push("Latest version unavailable" + (latest.status === "rejected" ? ": " + message(latest.reason) : ""));
    item.updateAvailable = isNewer(item.current, item.latest);
    if (errors.length) item.error = errors.join("; ");
    return item;
  }

  /** Fixed argv steps for a validated target. */
  plan(target: UpdateTarget): { file: string; args: string[]; cwd?: string }[] {
    if (target === "whatsapp") throw conflict("The WhatsApp server is updated through Docker, not by a command.", "not_managed");
    if (target !== "runtime") return [{ file: "npm", args: ["install", "-g", `${CLI_PACKAGES[target]}@latest`] }];
    if (this.cfg.runtimeCommand) return [{ file: this.cfg.runtimeCommand[0], args: this.cfg.runtimeCommand.slice(1) }];
    const root = this.gitRoot();
    if (!root) throw conflict("This runtime runs in Docker without access to the Docker socket. Redeploy it once with the docker-compose.yml from v1.0.25 or newer (it mounts the socket); after that Update runtime works by itself.", "update_unsupported");
    return [
      { file: "git", args: ["pull", "--ff-only"], cwd: root },
      { file: "npm", args: ["ci", "--include=dev"], cwd: this.cfg.runtimeDir },
      { file: "npm", args: ["run", "build"], cwd: this.cfg.runtimeDir },
    ];
  }

  /** Docker: start the updater container; it rebuilds the image from the newest release and swaps this container. */
  private async applyDocker(actorId: string, live: number, force: boolean) {
    this.applying = "runtime";
    try {
      const tag = await latestReleaseTag(this.cfg.repo);
      if (!tag) throw new Error("no release found");
      if (!isNewer(this.cfg.version, parseVersion(tag)) && !force) throw conflict(`Already on the newest release (${tag}).`, "up_to_date");
      log.info("admin.update_apply", { actorId, target: "runtime", via: "docker", tag, activeSessions: live });
      const msg = await startDockerSelfUpdate(this.cfg.repo, tag);
      return { target: "runtime" as const, ok: true, restarting: true, log: msg, activeSessions: live };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "update_failed", "Could not start the update: " + message(error));
    } finally {
      this.applying = null;
    }
  }

  async apply(actorId: string, body: { target?: unknown; force?: unknown }) {
    if (!isUpdateTarget(body.target)) throw badRequest(`target must be one of: ${UPDATE_TARGETS.join(", ")}`, "invalid_target");
    const target = body.target;
    const live = this.liveSessions();
    if (target === "runtime" && live > 0 && body.force !== true) {
      throw conflict(`${live} agent session(s) are running; restarting the runtime will stop them. Retry with force to continue.`, "sessions_active");
    }
    if (this.applying) throw conflict(`An update for ${this.applying} is already in progress`, "update_in_progress");
    if (target === "whatsapp") {
      // Only the waha container is replaced: the runtime and its agent sessions keep running.
      if (!this.whatsapp) throw conflict("This runtime has no built-in WhatsApp server.", "not_managed");
      this.applying = target;
      log.info("admin.update_apply", { actorId, target, force: body.force === true });
      try {
        const r = await this.whatsapp.applyUpdate(actorId, body.force === true);
        return { target, ok: true, restarting: false, log: r.log, activeSessions: live };
      } finally { this.applying = null; this.cache = null; }
    }
    if (target === "runtime" && !this.cfg.runtimeCommand && !this.gitRoot() && (this.cfg.dockerSelfUpdate ?? dockerSelfUpdateAvailable())) {
      return this.applyDocker(actorId, live, body.force === true);
    }
    const steps = this.plan(target);
    this.applying = target;
    log.info("admin.update_apply", { actorId, target, force: body.force === true, activeSessions: live });
    const lines: string[] = [];
    let ok = true;
    try {
      for (const step of steps) {
        const r = await run(step.file, step.args, { cwd: step.cwd, timeout: APPLY_TIMEOUT_MS });
        lines.push(`$ ${step.file} ${step.args.join(" ")}`, r.stdout.trim().split("\n").slice(-15).join("\n"), r.stderr.trim().split("\n").slice(-15).join("\n"));
        if (!r.ok) {
          ok = false;
          lines.push("FAILED: " + (r.error ?? ""));
          break;
        }
      }
    } finally {
      this.applying = null;
    }
    this.cache = null;
    const tail = lines.filter(Boolean).join("\n").slice(-4000);
    log.info("admin.update_result", { actorId, target, ok });
    if (!ok) throw new HttpError(500, "update_failed", tail || "Update failed");
    const restarting = target === "runtime";
    // Graceful SIGTERM; the container restart policy (or process supervisor) brings the new build up.
    if (restarting) setTimeout(() => this.requestRestart(), 1000).unref();
    return { target, ok, restarting, log: tail, activeSessions: live };
  }
}
