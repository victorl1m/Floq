import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, unavailable } from "./errors.js";
import { log } from "./logger.js";
import type { EgressHub } from "./browserEgress.js";
import type { BrowserEgressMode } from "./settings.js";
import type { ShardDriver, ShardHandle } from "./shard.js";
import {
  NODE_ID, JsonLines, RateWindow, encodeLine, toViewerMessage, validateClientMessage,
  type ClientMessage, type ViewerMessage,
} from "./browserProtocol.js";

/**
 * Agent browser service (docs/design/agent-browser.md §A.2, §A.3, §A.5).
 *
 * One `floq-browserd` per user, spawned INSIDE that user's sandbox through ShardDriver.spawnPipe (bwrap, per-user uid, netns).
 * The runtime never executes the browser on the host. This class owns: the daemon handle and its JSON-line pipe, the viewers
 * (canvas Browser nodes) and their allowlisted relay with backpressure, the idle timer, and the floq-browser MCP sync.
 * The daemon's endpoint token is held in memory only: it goes to the user's own agents via ensure() and nowhere else.
 */

export type BrowserState = "starting" | "running" | "stopped" | "disabled" | "unavailable";
export interface BrowserVersion { chromium: string; revision: string | number; playwrightMcp: string; /** "chromium" (full build, --headless=new) or "headless-shell"; absent in older images. */ build?: string }
export type McpSyncState = "installed" | "removed" | "unchanged" | "edited";
export interface McpSyncResult { claude: McpSyncState; codex: McpSyncState }

export interface BrowserConfig {
  /** FLOQ_AGENT_BROWSER: on / off, or auto (on when the pinned Chromium is installed). */
  mode: "on" | "off" | "auto";
  /** Stop the daemon after this long with no agent connection and no viewer. */
  idleMs: number;
  /** prlimit address-space cap in MB; 0 = none (default: Chromium reserves very large ranges, see the design notes). */
  memMb: number;
  /** FLOQ_BROWSER_ALLOW_PRIVATE=1: do not block loopback / private ranges without a netns. */
  allowPrivate: boolean;
  /** Where the image keeps the pinned Chromium (PLAYWRIGHT_BROWSERS_PATH). */
  browsersDir: string;
}
export interface BrowserOptions extends BrowserConfig {
  /** A connected agent that has shown no activity for this long no longer keeps the browser alive. Default 60 min. */
  agentStaleMs?: number;
  /** How long a start may take before it is abandoned. Default 45 s. */
  startTimeoutMs?: number;
  /** How long stop() waits for a clean exit before SIGKILL. Default 5 s. */
  stopWaitMs?: number;
  /** Re-check interval while a slow viewer holds back the next frame ack. Default 100 ms. */
  ackRetryMs?: number;
  /** A casting viewer over the backpressure threshold this long is evicted (default 10 s). */
  stuckViewerMs?: number;
  /** Test override for the installed version (null = not installed). Default: read from browsersDir/VERSION.json. */
  version?: BrowserVersion | null;
  /** Path of the daemon inside the sandbox. */
  daemonPath?: string;
}

export interface BrowserShards {
  awakeHandle(userId: string): ShardHandle | undefined;
  wake(userId: string): Promise<ShardHandle>;
  driver: Pick<ShardDriver, "spawnPipe" | "hostPath">;
}
/** Source of the user's agent <-> Browser node links (the browser_links table). */
export interface BrowserLinkPort { forUser(userId: string): Promise<Array<{ sessionId: string; nodeId: string }>>; removeNode(userId: string, nodeId: string): Promise<string[]> }
export interface BrowserSettingsPort { agentBrowser(userId: string): Promise<boolean>; /** The user's egress choice; absent in older callers = "server". */ agentBrowserEgress?(userId: string): Promise<BrowserEgressMode> }
export interface BrowserMcpPort { sync(userId: string, desired: boolean): Promise<McpSyncResult> }

/** What a WebSocket gives the service. The route adapts `ws` to this, tests pass a fake. */
export interface ViewerSink {
  send(text: string): void;
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}
export interface ViewerHandle { onMessage(raw: string): void; close(): void }

export interface EgressStatus { mode: BrowserEgressMode; effective: "server" | "desktop"; state: "up" | "down"; machine?: string; rttMs?: number; /** "Use the server connection this time" is active (transient, never persisted). */ override?: true }

export interface BrowserStatus {
  /** Where traffic leaves the internet; absent when the server has no egress relay. */
  egress?: EgressStatus;
  state: BrowserState;
  agents: number;
  tabs: number;
  version: BrowserVersion | null;
  profile: string;
  sandbox?: string;
  pid?: number;
  uptimeSec?: number;
  profileBytes?: number;
}

interface Viewer {
  sink: ViewerSink;
  input: RateWindow;
  /** The Browser node this socket shows. One node = one page. */
  nodeId: string;
  /** That node's page, once the daemon has bound it. */
  targetId: string | null;
  cast: boolean;
  overSince?: number;
}

interface Entry {
  userId: string;
  state: "starting" | "running" | "stopped";
  child: ChildProcess | null;
  port: number;
  token: string;
  pid: number | null;
  startedAt: number;
  sandbox: "on" | "off" | null;
  sandboxReason?: string;
  tabs: Array<{ targetId: string; title: string; url: string; opener: "agent" | "user" }>;
  nav: Map<string, ViewerMessage>;
  /** nodeId -> targetId of its page, as reported by the daemon. */
  pages: Map<string, string>;
  agents: number;
  lastActivity: number;
  viewers: Set<Viewer>;
  /** How THIS daemon run routes its traffic (fixed at spawn; a change restarts the daemon). */
  egressMode: "server" | "desktop";
  egressPipe: { push(chunk: Buffer): void; close(): void } | null;
  idleTimer: NodeJS.Timeout | null;
  ackTimer: NodeJS.Timeout | null;
  pendingAcks: Map<string, number>;
  stopRequested: boolean;
  exited: Promise<void>;
  markExited: () => void;
  start: Promise<void> | null;
}

export const DAEMON_PATH = "/usr/local/bin/floq-browserd";
export const PROFILE_DIR = ".floq/browser/profile";
export const PROFILE_LABEL = "~/.floq/browser/profile";
const BACKPRESSURE_BYTES = 512 * 1024;
const AGENT_STALE_MS = 60 * 60 * 1000;

const exitedPromise = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

export class BrowserService {
  private readonly entries = new Map<string, Entry>();
  private readonly installed: BrowserVersion | null;
  /** Called whenever a user's daemon starts (true) or has fully stopped (false). The manager uses it to count the browser as shard activity. */
  onActivity?: (userId: string, running: boolean) => void;
  /** Set by the runtime: lets the service restore every link's scope when a daemon (re)starts, and drop links of a closed node. */
  links?: BrowserLinkPort;
  /** Set by the runtime: the user-IP egress relay (docs/design/browser-user-egress.md). Without it, "desktop" modes fail closed. */
  egress?: EgressHub;

  constructor(
    private readonly shards: BrowserShards,
    private readonly settings: BrowserSettingsPort,
    private readonly mcp: BrowserMcpPort | null,
    private readonly options: BrowserOptions,
    private readonly hasNetns: (userId: string) => boolean = () => false,
  ) {
    this.installed = options.version !== undefined ? options.version : BrowserService.readVersion(options.browsersDir);
  }

  /** Parsed /opt/floq/browsers/VERSION.json, or null when the image has no browser. */
  static readVersion(dir: string): BrowserVersion | null {
    try {
      const raw = JSON.parse(readFileSync(join(dir, "VERSION.json"), "utf8")) as Record<string, unknown>;
      if (typeof raw.chromium !== "string" || !raw.chromium) return null;
      return { chromium: raw.chromium, revision: typeof raw.revision === "string" || typeof raw.revision === "number" ? raw.revision : "", playwrightMcp: typeof raw.playwrightMcp === "string" ? raw.playwrightMcp : "", ...(typeof raw.build === "string" ? { build: raw.build } : {}) };
    } catch { return null; }
  }

  /** capabilities.browser: "available" | "disabled" (admin off) | "missing" (not in this image). */
  capability(): "available" | "disabled" | "missing" {
    if (this.options.mode === "off") return "disabled";
    return this.installed ? "available" : "missing";
  }

  get version(): BrowserVersion | null { return this.installed; }

  // ------------------------------------------------------------------ state

  /** The state the app should show for this user, without starting anything. */
  async state(userId: string): Promise<BrowserState> {
    const cap = this.capability();
    if (cap === "missing") return "unavailable";
    if (cap === "disabled" || !(await this.settings.agentBrowser(userId))) return "disabled";
    return this.entries.get(userId)?.state ?? "stopped";
  }

  async status(userId: string, opts: { profileBytes?: boolean } = {}): Promise<BrowserStatus> {
    const state = await this.state(userId);
    const entry = this.entries.get(userId);
    const live = entry && entry.state !== "stopped" ? entry : undefined;
    const out: BrowserStatus = {
      state,
      agents: live?.agents ?? 0,
      tabs: live?.tabs.length ?? 0,
      version: this.installed,
      profile: PROFILE_LABEL,
    };
    if (this.egress) out.egress = await this.egressStatus(userId);
    if (live?.sandbox) out.sandbox = live.sandbox === "on" ? "chromium sandbox on" : "off (" + (live.sandboxReason ?? "no nested user namespaces in bwrap") + "; see docs/design/agent-browser.md §A.4)";
    if (live?.state === "running") { out.pid = live.pid ?? undefined; out.uptimeSec = Math.max(0, Math.round((Date.now() - live.startedAt) / 1000)); }
    if (opts.profileBytes) {
      const bytes = await this.profileBytes(userId).catch(() => undefined);
      if (bytes !== undefined) out.profileBytes = bytes;
    }
    return out;
  }

  /** Throws 403 when the user's Browser toggle is off (or 503 when the image has no browser). */
  async assertAllowed(userId: string): Promise<void> {
    const cap = this.capability();
    if (cap === "missing") throw new HttpError(503, "unavailable", "This Floq image has no browser installed");
    if (cap === "disabled" || !(await this.settings.agentBrowser(userId))) throw new HttpError(403, "disabled", "The agent browser is turned off (Settings > Agents > Browser)");
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Makes sure this user's daemon is running and returns the endpoint for their agents' MCP wrapper.
   * An agent's own shard is awake already; `wake` (a viewer opening the node) may unlock a sleeping one.
   */
  async ensure(userId: string, opts: { wake?: boolean; agentId?: string } = {}): Promise<{ wsEndpoint: string; token: string; chromium?: string; egress?: "paused" }> {
    await this.assertAllowed(userId);
    let entry = this.entries.get(userId);
    if (!entry || entry.state === "stopped") entry = await this.startEntry(userId, opts.wake === true);
    if (entry.start) await entry.start;
    if (entry.state !== "running") throw unavailable("The browser stopped while starting. Try again.", "browser_start_failed");
    this.armIdle(entry);
    // `?agent=` names the agent session so the daemon can scope it to the Browser node the user linked it to (see setAgentScope).
    const agent = opts.agentId && /^[A-Za-z0-9-]{8,64}$/.test(opts.agentId) ? `?agent=${opts.agentId}` : "";
    return { wsEndpoint: `ws://127.0.0.1:${entry.port}/devtools/browser${agent}`, token: entry.token, chromium: this.installed?.chromium, ...(entry.egressMode === "desktop" && !this.egress?.isUp(userId) ? { egress: "paused" as const } : {}) };
  }

  /** One Entry per user for the life of the runtime: viewers hold it across daemon restarts. */
  private entryFor(userId: string): Entry {
    let entry = this.entries.get(userId);
    if (!entry) {
      const dead = exitedPromise();
      entry = { userId, state: "stopped", child: null, port: 0, token: "", pid: null, startedAt: 0, sandbox: null, tabs: [], nav: new Map(), pages: new Map(), agents: 0, lastActivity: Date.now(), viewers: new Set(), egressMode: "server", egressPipe: null, idleTimer: null, ackTimer: null, pendingAcks: new Map(), stopRequested: false, exited: dead.promise, markExited: dead.resolve, start: null };
      this.entries.set(userId, entry);
    }
    return entry;
  }

  private readonly starting = new Map<string, Promise<Entry>>();

  /** Single-flight per user: concurrent callers (agent ensure + viewer attach) share one start, never two daemons. */
  private startEntry(userId: string, wake: boolean): Promise<Entry> {
    const entry = this.entryFor(userId);
    if (entry.state !== "stopped") return Promise.resolve(entry);
    let p = this.starting.get(userId);
    if (!p) {
      p = this.doStartEntry(userId, wake).finally(() => { this.starting.delete(userId); });
      this.starting.set(userId, p);
    }
    return p;
  }

  private async doStartEntry(userId: string, wake: boolean): Promise<Entry> {
    const entry = this.entryFor(userId);
    // Launched only inside the user's sandbox: no shard handle, no browser.
    let handle = this.shards.awakeHandle(userId);
    if (!handle && wake) handle = await this.shards.wake(userId);
    if (!handle) throw unavailable("Your sandbox is not running", "sandbox_unavailable");
    if (entry.state !== "stopped") return entry;
    // The route is fixed for this run: desktop => Chromium gets the proxy flags and fd 3 is wired to the relay, else direct from the server.
    const egress = await this.effectiveEgress(userId);
    if (egress === "desktop" && !this.egress) throw unavailable("Egress through your computer is not available on this server", "egress_unavailable");
    if (entry.state !== "stopped") return entry;
    const dead = exitedPromise();
    Object.assign(entry, { state: "starting", child: null, port: 0, token: "", pid: null, startedAt: Date.now(), sandbox: null, sandboxReason: undefined, tabs: [], pages: new Map(), agents: 0, lastActivity: Date.now(), pendingAcks: new Map(), stopRequested: false, exited: dead.promise, markExited: dead.resolve });
    entry.nav.clear();
    this.broadcast(entry, { type: "state", state: "starting" });
    entry.egressMode = egress;
    entry.start = this.launch(entry, handle).finally(() => { entry.start = null; });
    try { await entry.start; } catch (error) { await this.teardown(entry, "start_failed"); throw error; }
    return entry;
  }

  private env(userId: string, egress: "server" | "desktop"): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: this.options.browsersDir,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    };
    // T6: without a per-user network namespace the daemon blocks loopback / private ranges for web content itself.
    if (!this.hasNetns(userId) && !this.options.allowPrivate) env.FLOQ_BROWSER_BLOCK_PRIVATE = "1";
    if (this.options.memMb > 0) env.FLOQ_BROWSER_MEM_MB = String(this.options.memMb);
    env.FLOQ_BROWSER_EGRESS = egress;
    return env;
  }

  private launch(entry: Entry, handle: ShardHandle): Promise<void> {
    const { userId } = entry;
    const desktop = entry.egressMode === "desktop";
    const child = this.shards.driver.spawnPipe(handle, { file: this.options.daemonPath ?? DAEMON_PATH, args: [], env: this.env(userId, entry.egressMode), cwd: ".", stdin: true, ...(desktop ? { extraPipe: true } : {}) });
    entry.child = child;
    if (desktop && this.egress) {
      const pipe = child.stdio[3] as (NodeJS.ReadWriteStream & { destroy(): void }) | null | undefined;
      if (pipe) {
        pipe.on("error", () => undefined);
        const h = this.egress.attachDaemon(userId, { write: (data) => { if ((pipe as unknown as { writable: boolean }).writable) pipe.write(data); }, close: () => { try { pipe.destroy(); } catch { /* gone */ } } });
        pipe.on("data", (chunk: Buffer) => h.push(chunk));
        pipe.on("close", () => h.close());
        entry.egressPipe = h;
      }
    }
    this.onActivity?.(userId, true);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(unavailable("The browser did not start in time", "browser_start_timeout")), this.options.startTimeoutMs ?? 45_000);
      const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
      const lines = new JsonLines(
        (line) => {
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { return; }
          if (!msg || typeof msg !== "object") return;
          const m = msg as Record<string, unknown>;
          if (m.type === "ready" && !settled) {
            const port = Number(m.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof m.token !== "string" || m.token.length < 16) return fail(unavailable("The browser reported an invalid endpoint", "browser_start_failed"));
            entry.port = port; entry.token = m.token;
            entry.pid = Number.isInteger(m.pid) ? Number(m.pid) : null;
            entry.sandbox = m.sandbox === "off" ? "off" : m.sandbox === "on" ? "on" : null;
            if (typeof m.sandboxReason === "string") entry.sandboxReason = m.sandboxReason.slice(0, 200);
            entry.state = "running";
            entry.startedAt = Date.now();
            settled = true; clearTimeout(timer);
            this.write(entry, { type: "hello" });
            this.broadcast(entry, { type: "state", state: "running" });
            this.openViewerPages(entry);
            void this.restoreScopes(entry);
            this.armIdle(entry);
            log.info("browser.started", { userId, pid: entry.pid, sandbox: entry.sandbox });
            return resolve();
          }
          if (m.type === "exit") return;
          if (m.type === "error" && !settled && m.code === "start_failed") return fail(unavailable("The browser could not start", "browser_start_failed"));
          this.fromDaemon(entry, msg);
        },
        () => log.warn("browser.line_too_long", { userId }),
      );
      child.stdout?.on("data", (chunk: Buffer) => { if (entry.child === child) lines.push(chunk); });
      // The daemon logs one JSON object per line on stderr; keep a bounded trace, never the token.
      let tail = "";
      child.stderr?.on("data", (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-600); });
      child.stdin?.on("error", () => undefined);
      child.once("error", (error) => { fail(unavailable("The browser could not be launched", "browser_start_failed")); log.warn("browser.spawn_failed", { userId, error: String(error.message).slice(0, 160) }); this.onChildExit(entry, child, tail); });
      child.once("exit", (code, signal) => { fail(unavailable("The browser exited while starting", "browser_start_failed")); log.info("browser.exited", { userId, code, signal, requested: entry.stopRequested }); this.onChildExit(entry, child, tail); });
    });
  }

  private onChildExit(entry: Entry, child: ChildProcess, stderrTail: string): void {
    // A late exit of an earlier child must not stop a newer run that reuses this entry.
    if (entry.child !== child) return;
    const crashed = !entry.stopRequested && entry.state === "running";
    if (crashed) log.warn("browser.crashed", { userId: entry.userId, stderr: stderrTail.replace(/\s+/g, " ").slice(-300) });
    this.markStopped(entry);
  }

  private markStopped(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.ackTimer) clearTimeout(entry.ackTimer);
    entry.idleTimer = null; entry.ackTimer = null; entry.pendingAcks.clear();
    const wasLive = entry.state !== "stopped";
    entry.egressPipe?.close(); entry.egressPipe = null;
    entry.state = "stopped"; entry.child = null; entry.token = ""; entry.port = 0; entry.tabs = []; entry.nav.clear(); entry.pages.clear(); entry.agents = 0;
    for (const v of entry.viewers) { v.cast = false; v.targetId = null; }
    this.broadcast(entry, { type: "state", state: "stopped" });
    entry.markExited();
    if (wasLive) this.onActivity?.(entry.userId, false);
  }

  private async teardown(entry: Entry, reason: string): Promise<void> {
    entry.stopRequested = true;
    try { entry.child?.kill("SIGKILL"); } catch { /* gone */ }
    if (entry.state !== "stopped") this.markStopped(entry);
    log.info("browser.teardown", { userId: entry.userId, reason });
  }

  /** Clean shutdown: ask the daemon, wait up to `waitMs`, then SIGKILL. Resolves once the process is gone. */
  async stop(userId: string, reason = "stop", waitMs = this.options.stopWaitMs ?? 5000): Promise<void> {
    if (reason === "idle" || reason === "disabled" || reason === "shutdown") this.serverOverride.delete(userId);
    const entry = this.entries.get(userId);
    if (!entry || entry.state === "stopped") return;
    entry.stopRequested = true;
    if (entry.start) await entry.start.catch(() => undefined);
    const state = (): Entry["state"] => entry.state;
    log.info("browser.stopping", { userId, reason });
    if (!entry.child) { if (state() !== "stopped") this.markStopped(entry); return; }
    this.write(entry, { type: "shutdown" });
    const killer = setTimeout(() => { try { entry.child?.kill("SIGKILL"); } catch { /* gone */ } }, waitMs);
    // A fake or wedged child that never reports exit must not hang the caller: give the kill a moment, then settle anyway.
    let hardTimer: NodeJS.Timeout | undefined;
    const hard = new Promise<void>((resolve) => { hardTimer = setTimeout(resolve, waitMs + 1500); hardTimer.unref?.(); });
    try { await Promise.race([entry.exited, hard]); } finally { clearTimeout(killer); clearTimeout(hardTimer); }
    if (state() !== "stopped") this.markStopped(entry);
  }

  async restart(userId: string, opts: { wake?: boolean } = {}): Promise<BrowserStatus> {
    await this.assertAllowed(userId);
    await this.stop(userId, "restart");
    await this.ensure(userId, opts);
    return this.status(userId);
  }

  /** Stops the daemon and removes only ~/.floq/browser/profile, inside the user's sandbox (the home belongs to an agent: never touched from the host side). */
  async clearData(userId: string): Promise<BrowserStatus> {
    await this.assertAllowed(userId);
    await this.stop(userId, "clear-data");
    const handle = this.shards.awakeHandle(userId) ?? await this.shards.wake(userId);
    const result = await this.runInSandbox(handle, "rm", ["-rf", "--", PROFILE_DIR]);
    if (result.code !== 0) throw unavailable("The browser data could not be removed", "browser_clear_failed");
    log.info("browser.data_cleared", { userId });
    return this.status(userId);
  }

  /** Size of the profile in bytes (du inside the sandbox), or undefined when it does not exist or the shard is asleep. */
  async profileBytes(userId: string): Promise<number | undefined> {
    const handle = this.shards.awakeHandle(userId);
    if (!handle) return undefined;
    const r = await this.runInSandbox(handle, "du", ["-sk", "--", PROFILE_DIR], 10_000);
    const kb = r.code === 0 ? Number(/^(\d+)/.exec(r.out)?.[1]) : NaN;
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  }

  private runInSandbox(handle: ShardHandle, file: string, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      let out = "";
      let done = false;
      let child: ChildProcess;
      try { child = this.shards.driver.spawnPipe(handle, { file, args, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, cwd: "." }); }
      catch { return resolve({ code: null, out: "" }); }
      const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } finish(null); }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => { if (out.length < 4096) out += c.toString("utf8"); });
      child.stderr?.resume();
      child.once("error", () => finish(null));
      child.once("exit", (code) => finish(code));
    });
  }

  /**
   * Runs `node -e script` inside the user's sandbox with `input` on stdin and parses the last stdout line as JSON.
   * Used by the cookie import (docs/design/agent-browser.md §A.13). The input may hold cookie values: it is never logged or kept.
   */
  async runHelper(userId: string, script: string, input: string, timeoutMs = 60_000): Promise<{ code: number | null; out: Record<string, unknown> }> {
    const handle = this.shards.awakeHandle(userId) ?? await this.shards.wake(userId);
    return new Promise((resolve) => {
      let raw = "";
      let done = false;
      let child: ChildProcess;
      try { child = this.shards.driver.spawnPipe(handle, { file: "node", args: ["-e", script], env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, cwd: ".", stdin: true }); }
      catch { return resolve({ code: null, out: {} }); }
      const finish = (code: number | null) => {
        if (done) return; done = true; clearTimeout(timer);
        let out: Record<string, unknown> = {};
        try { const last = raw.trim().split("\n").pop() ?? ""; const j = JSON.parse(last); if (j && typeof j === "object") out = j as Record<string, unknown>; } catch { /* no result */ }
        resolve({ code, out });
      };
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } finish(null); }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => { if (raw.length < 1_000_000) raw += c.toString("utf8"); });
      child.stderr?.resume();
      child.stdin?.on("error", () => undefined);
      child.once("error", () => finish(null));
      child.once("exit", (code) => finish(code));
      try { child.stdin?.end(input); } catch { /* exits */ }
    });
  }

  // ------------------------------------------------------------------ idle

  private busy(entry: Entry): boolean {
    return entry.viewers.size > 0;
  }

  /** (Re)arms the one idle timer from current state; called on every event that can change it. */
  private armIdle(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (entry.state !== "running" || this.busy(entry) || this.options.idleMs <= 0) return;
    const stale = this.options.agentStaleMs ?? AGENT_STALE_MS;
    // Agents holding a connection keep it alive, but only for `stale` after their last activity.
    const delay = entry.agents > 0 ? entry.lastActivity + stale - Date.now() : this.options.idleMs;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.state !== "running" || this.busy(entry)) return;
      const staleNow = entry.agents > 0 && Date.now() < entry.lastActivity + stale;
      if (staleNow) return this.armIdle(entry);
      void this.stop(entry.userId, "idle").catch(() => undefined);
    }, Math.max(1, delay));
    entry.idleTimer.unref?.();
  }

  // ------------------------------------------------------------------ daemon -> viewers

  private write(entry: Entry, msg: unknown): boolean {
    const stdin = entry.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try { stdin.write(encodeLine(msg)); return true; } catch { return false; }
  }

  private broadcast(entry: Entry, msg: ViewerMessage, only?: (v: Viewer) => boolean): void {
    if (!entry.viewers.size) return;
    const text = JSON.stringify(msg);
    for (const v of entry.viewers) if (!only || only(v)) { try { v.sink.send(text); } catch { /* socket gone; its close handler removes it */ } }
  }

  private fromDaemon(entry: Entry, raw: unknown): void {
    const r = raw as Record<string, unknown> | null;
    const nodeOf = (v: unknown): string | null => (typeof v === "string" && NODE_ID.test(v) ? v : null);
    if (r && r.type === "page") {
      const nodeId = nodeOf(r.nodeId), msg = toViewerMessage(r);
      if (nodeId && msg && msg.type === "page") {
        entry.pages.set(nodeId, msg.targetId);
        for (const v of entry.viewers) if (v.nodeId === nodeId) { v.targetId = msg.targetId; this.sendTo(v, msg); const nav = entry.nav.get(msg.targetId); if (nav) this.sendTo(v, nav); }
      }
      return;
    }
    if (r && r.type === "pageGone") {
      // The page of a node vanished (its linked agent closed it, or it crashed): open a fresh one for a node somebody is still looking at or linked to.
      const nodeId = nodeOf(r.nodeId);
      if (!nodeId) return;
      const tid = entry.pages.get(nodeId);
      entry.pages.delete(nodeId);
      for (const v of entry.viewers) if (v.nodeId === nodeId) { v.targetId = null; v.cast = false; }
      if (tid) entry.nav.delete(tid);
      if ([...entry.viewers].some((v) => v.nodeId === nodeId)) this.write(entry, { type: "page.open", nodeId });
      return;
    }
    const msg = toViewerMessage(raw);
    if (!msg) return;
    const forTarget = (targetId: string) => (v: Viewer) => v.targetId === targetId;
    switch (msg.type) {
      case "frame": return this.onFrame(entry, msg);
      case "tabs": entry.tabs = msg.tabs; return; // counted for status; viewers only ever see their own page
      case "nav": entry.nav.set(msg.targetId, msg); return this.broadcast(entry, msg, forTarget(msg.targetId));
      case "cursor": { const tid = typeof r?.targetId === "string" ? r.targetId : ""; return this.broadcast(entry, msg, forTarget(tid)); }
      case "dialog": case "dialogClosed": case "clipboard": case "download": return this.broadcast(entry, msg, forTarget(msg.targetId));
      case "clients": entry.agents = msg.agents; entry.lastActivity = Date.now(); this.armIdle(entry); break;
      case "agentActivity": entry.lastActivity = Date.now(); this.armIdle(entry); return this.broadcast(entry, msg, forTarget(msg.targetId));
      default: break;
    }
    this.broadcast(entry, msg);
  }

  /** The daemon came up: every attached node asks for its page, and every stored link is re-applied to the daemon. */
  private openViewerPages(entry: Entry): void {
    const nodes = new Set([...entry.viewers].map((v) => v.nodeId));
    for (const nodeId of nodes) this.write(entry, { type: "page.open", nodeId });
  }
  private async restoreScopes(entry: Entry): Promise<void> {
    if (!this.links) return;
    try {
      for (const l of await this.links.forUser(entry.userId)) if (entry.state === "running") this.write(entry, { type: "agent.scope", agent: l.sessionId, nodeId: l.nodeId });
    } catch (error) { log.warn("browser.scope_restore_failed", { userId: entry.userId, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }); }
  }

  /**
   * Links (nodeId set) or unlinks (null) an agent session to a Browser node's page. The agent's MCP keeps its CDP connection: the daemon
   * changes which targets that connection can see, so a linked agent drives exactly that page and an unlinked one gets its own again.
   * Several agents may share a node; commands interleave on the one page (last action wins). No-op while the daemon is stopped:
   * the stored links are re-applied when it starts.
   */
  setAgentScope(userId: string, sessionId: string, nodeId: string | null): void {
    const entry = this.entries.get(userId);
    if (!entry || entry.state !== "running") return;
    this.write(entry, { type: "agent.scope", agent: sessionId, nodeId });
  }

  /**
   * Frames go only to the viewers of that frame's page that asked for a screencast. The next frame of a page is requested from Chromium
   * (ack) only when every such viewer's socket has drained below 512 KiB; a frame that arrives while one is behind is dropped for that
   * viewer and the ack waits, so a slow client throttles Chromium instead of growing the buffer.
   */
  private onFrame(entry: Entry, frame: Extract<ViewerMessage, { type: "frame" }>): void {
    const casters = [...entry.viewers].filter((v) => v.cast && v.targetId === frame.targetId);
    if (!casters.length) { this.write(entry, { type: "frame.ack", n: frame.n }); return; }
    const text = JSON.stringify(frame);
    for (const v of casters) {
      if (v.sink.bufferedAmount() < BACKPRESSURE_BYTES) { try { v.sink.send(text); } catch { /* closing */ } }
    }
    this.ackWhenDrained(entry, frame.targetId, frame.n);
  }

  private ackWhenDrained(entry: Entry, targetId: string, n: number): void {
    entry.pendingAcks.set(targetId, n);
    if (entry.ackTimer) return;
    const check = () => {
      entry.ackTimer = null;
      if (entry.state !== "running" || entry.pendingAcks.size === 0) return;
      const now = Date.now();
      let slow = false;
      for (const [tid, ack] of [...entry.pendingAcks]) {
        let behind = false;
        for (const v of [...entry.viewers]) {
          if (!v.cast || v.targetId !== tid) continue;
          if (v.sink.bufferedAmount() < BACKPRESSURE_BYTES) { v.overSince = undefined; continue; }
          v.overSince ??= now;
          // A viewer that has not drained for this long (half-open socket) is evicted instead of throttling everyone.
          if (now - v.overSince > (this.options.stuckViewerMs ?? 10_000)) {
            entry.viewers.delete(v); v.cast = false;
            try { v.sink.close(1013, "Viewer too slow"); } catch { /* gone */ }
            if (![...entry.viewers].some((o) => o.cast && o.targetId === tid)) this.write(entry, { type: "screencast.stop", targetId: tid });
            this.armIdle(entry);
            continue;
          }
          behind = true;
        }
        if (behind) { slow = true; continue; }
        entry.pendingAcks.delete(tid);
        this.write(entry, { type: "frame.ack", n: ack });
      }
      if (slow) { entry.ackTimer = setTimeout(check, this.options.ackRetryMs ?? 100); entry.ackTimer.unref?.(); }
    };
    check();
  }

  // ------------------------------------------------------------------ viewers

  /**
   * Registers a Browser node's socket for this user (`nodeId`: one node, one page). Starts the daemon (waking the shard) when it is stopped
   * and allowed, and asks it for the node's page. The sink only ever receives allowlisted messages (state, page, frame, nav, cursor, agentActivity, clients, error).
   */
  async attachViewer(userId: string, sink: ViewerSink, nodeId = "main"): Promise<ViewerHandle> {
    const state = await this.state(userId);
    const send0 = (msg: ViewerMessage) => { try { sink.send(JSON.stringify(msg)); } catch { /* closing */ } };
    if (!NODE_ID.test(nodeId)) { send0({ type: "error", code: "bad_node" }); return { onMessage: () => undefined, close: () => undefined }; }
    const viewer: Viewer = { sink, input: new RateWindow(), nodeId, targetId: null, cast: false };
    const send = send0;
    if (state === "disabled" || state === "unavailable") {
      send({ type: "state", state });
      return { onMessage: () => undefined, close: () => undefined };
    }
    const entry = this.entryFor(userId);
    entry.viewers.add(viewer);
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    const current = entry;
    send({ type: "state", state: current.state });
    if (this.egress) { const eg = await this.egressStatus(userId).catch(() => null); if (eg) send({ type: "egress", ...eg }); }
    if (current.state === "running") {
      send({ type: "clients", agents: current.agents });
      const tid = current.pages.get(nodeId);
      if (tid) { viewer.targetId = tid; send({ type: "page", targetId: tid, created: false }); const nav = current.nav.get(tid); if (nav) send(nav); }
      else this.write(current, { type: "page.open", nodeId });
    } else if (current.state === "stopped") {
      // Opening the node starts the browser; failures are reported as an error message and the stopped state.
      void this.ensure(userId, { wake: true }).catch((error) => {
        log.warn("browser.viewer_start_failed", { userId, code: error instanceof HttpError ? error.code : "failed" });
        send({ type: "error", code: error instanceof HttpError ? error.code.slice(0, 40) : "failed" });
        send({ type: "state", state: "stopped" });
      });
    }
    let closed = false;
    return {
      onMessage: (raw) => this.fromViewer(current, viewer, raw),
      close: () => {
        if (closed) return;
        closed = true;
        const wasCasting = viewer.cast && viewer.targetId !== null;
        const tid = viewer.targetId;
        current.viewers.delete(viewer);
        viewer.cast = false;
        if (wasCasting && tid && ![...current.viewers].some((v) => v.cast && v.targetId === tid)) this.write(current, { type: "screencast.stop", targetId: tid });
        this.armIdle(current);
      },
    };
  }

  private fromViewer(entry: Entry, viewer: Viewer, raw: string): void {
    if (typeof raw !== "string" || raw.length > 64 * 1024) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return void this.sendTo(viewer, { type: "error", code: "bad_json" }); }
    const v = validateClientMessage(parsed);
    if (!v.ok) return void this.sendTo(viewer, { type: "error", code: v.code });
    const msg: ClientMessage = v.msg;
    // Only the high-rate events are throttled: dropping a press/release/key would leave a button or key stuck.
    if ((msg.type === "input.wheel" || (msg.type === "input.mouse" && msg.kind === "mouseMoved")) && !viewer.input.allow()) return;
    if (entry.state !== "running") return;
    if (msg.type === "page.close") {
      // The user closed the node: destroy its page and drop the agent links to it.
      this.write(entry, { type: "page.close", nodeId: viewer.nodeId });
      const tid = entry.pages.get(viewer.nodeId);
      entry.pages.delete(viewer.nodeId);
      if (tid) entry.nav.delete(tid);
      for (const o of entry.viewers) if (o.nodeId === viewer.nodeId) { o.targetId = null; o.cast = false; }
      void this.links?.removeNode(entry.userId, viewer.nodeId).catch(() => undefined);
      return;
    }
    // A viewer only ever acts on its own node's page: the target is filled in here, whatever the client sent.
    if (!viewer.targetId) return;
    const targetId = viewer.targetId;
    if (msg.type === "screencast.start") { viewer.cast = true; return void this.write(entry, { ...msg, targetId }); }
    if (msg.type === "screencast.stop") {
      viewer.cast = false;
      // Another viewer of the same page may still be watching: its screencast keeps running.
      if ([...entry.viewers].some((o) => o.cast && o.targetId === targetId)) return;
      return void this.write(entry, { type: "screencast.stop", targetId });
    }
    this.write(entry, { ...msg, targetId });
  }

  private sendTo(viewer: Viewer, msg: ViewerMessage): void { try { viewer.sink.send(JSON.stringify(msg)); } catch { /* closing */ } }

  viewerCount(userId: string): number { return this.entries.get(userId)?.viewers.size ?? 0; }
  isRunning(userId: string): boolean { const s = this.entries.get(userId)?.state; return s === "running" || s === "starting"; }

  // ------------------------------------------------------------------ MCP registration

  /**
   * Makes ~/.claude.json and ~/.codex/config.toml match the user's desired state: the floq-browser entry present when the browser is
   * available and on for them, absent otherwise. Idempotent. A hand-edited entry is reported ("edited") and left alone.
   */
  async syncMcp(userId: string): Promise<McpSyncResult | null> {
    if (!this.mcp) return null;
    const desired = this.capability() === "available" && (await this.settings.agentBrowser(userId));
    const result = await this.mcp.sync(userId, desired);
    if (result.claude === "edited" || result.codex === "edited") log.warn("browser.mcp_entry_edited", { userId, claude: result.claude, codex: result.codex });
    return result;
  }

  // ------------------------------------------------------------------ egress (docs/design/browser-user-egress.md §4)

  /** The user's chosen mode (setting), default "server". */
  async egressSetting(userId: string): Promise<BrowserEgressMode> {
    return (await this.settings.agentBrowserEgress?.(userId)) ?? "server";
  }

  /** How a daemon started now would route: "desktop" (proxied, fail closed), or "server". desktop-fallback follows the link. */
  async effectiveEgress(userId: string): Promise<"server" | "desktop"> {
    if (this.serverOverride.has(userId)) return "server";
    const mode = await this.egressSetting(userId);
    if (mode === "desktop") return "desktop";
    if (mode === "desktop-fallback") return this.egress?.isUp(userId) ? "desktop" : "server";
    return "server";
  }

  /**
   * "Use the server connection this time": a transient, in-memory override (the setting itself is untouched, so the user's desktop
   * choice survives). While set the browser routes via the server. It ends when a desktop of the user comes up after having been down
   * (or `on: false`), when the user changes the mode, or when the browser goes idle / is disabled.
   */
  private serverOverride = new Map<string, { upAtSet: boolean }>();
  async setEgressOverride(userId: string, on: boolean): Promise<void> {
    if (on) this.serverOverride.set(userId, { upAtSet: !!this.egress?.isUp(userId) });
    else if (!this.serverOverride.delete(userId)) return;
    await this.reconcileEgress(userId, 0);
    void this.pushEgress(userId);
  }

  /** What viewers and GET /v1/browser show for egress. `mode` is the setting, `effective` what the running daemon does. */
  async egressStatus(userId: string): Promise<EgressStatus> {
    const mode = await this.egressSetting(userId);
    const entry = this.entries.get(userId);
    const info = this.egress?.info(userId) ?? { state: "none" as const };
    const effective = entry && entry.state !== "stopped" ? entry.egressMode : (await this.effectiveEgress(userId));
    const overridden = this.serverOverride.has(userId);
    const state: EgressStatus["state"] = mode !== "server" && !overridden && info.state === "up" ? "up" : "down";
    return { mode, effective, state, ...(overridden ? { override: true as const } : {}), ...(info.state === "up" && info.machine ? { machine: info.machine } : {}), ...(info.state === "up" && info.rttMs !== undefined ? { rttMs: info.rttMs } : {}) };
  }

  private egressTimers = new Map<string, NodeJS.Timeout>();
  /** The hub reports a desktop came or went (and rtt changes): tell viewers, and for desktop-fallback restart onto the right route. */
  onEgressChange(userId: string, rttOnly = false): void {
    if (rttOnly) { void this.pushEgress(userId); return; } // a PONG every ~20 s: no settings reads, no route decision
    const ov = this.serverOverride.get(userId);
    if (ov) {
      if (!this.egress?.isUp(userId)) ov.upAtSet = false;
      else if (!ov.upAtSet) this.serverOverride.delete(userId); // the desktop came (back): the "this time" is over
    }
    void this.pushEgress(userId);
    void this.reconcileEgress(userId);
  }

  private async pushEgress(userId: string): Promise<void> {
    const entry = this.entries.get(userId);
    if (!entry || !entry.viewers.size) return;
    const status = await this.egressStatus(userId).catch(() => null);
    if (status) this.broadcast(entry, { type: "egress", ...status });
  }

  /** A running daemon whose route no longer matches the setting is restarted (the only switch point: a page never mixes IPs). Debounced against flapping. */
  async reconcileEgress(userId: string, delayMs = 1500): Promise<void> {
    const entry = this.entries.get(userId);
    if (!entry || entry.state !== "running") return;
    const want = await this.effectiveEgress(userId);
    if (want === entry.egressMode) { const t = this.egressTimers.get(userId); if (t) { clearTimeout(t); this.egressTimers.delete(userId); } return; }
    if (this.egressTimers.has(userId)) return;
    const timer = setTimeout(() => {
      this.egressTimers.delete(userId);
      void (async () => {
        const e = this.entries.get(userId);
        if (!e || e.state !== "running" || (await this.effectiveEgress(userId)) === e.egressMode) return;
        log.info("browser.egress_switch", { userId, from: e.egressMode });
        await this.restart(userId).catch((error) => log.warn("browser.egress_restart_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
      })();
    }, delayMs);
    timer.unref?.();
    this.egressTimers.set(userId, timer);
  }

  /** The user toggled `agentBrowser`: stop a running daemon when it went off, and fix the MCP entries either way. */
  async onToggle(userId: string): Promise<void> {
    if (!(await this.settings.agentBrowser(userId)) || this.capability() !== "available") await this.stop(userId, "disabled");
    else { await this.reconcileEgress(userId, 0); void this.pushEgress(userId); }
    await this.syncMcp(userId).catch((error) => log.warn("browser.mcp_sync_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
  }

  /** Stops every daemon (runtime shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id, "shutdown", 2000).catch(() => undefined)));
  }
}

