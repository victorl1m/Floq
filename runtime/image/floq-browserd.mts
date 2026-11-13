#!/usr/bin/env node
// floq-browserd: one headless Chromium per user, INSIDE that user's sandbox (docs/design/agent-browser.md §A.2).
//   runtime <-- stdin/stdout JSON lines --> floq-browserd --CDP over fds 3/4--> chrome --headless=new
//                                           floq-browserd --ws://127.0.0.1:<ephemeral>/devtools/browser (bearer token)--> agents' @playwright/mcp
// Chromium itself opens no TCP port. Logs are JSON lines on stderr; stdout carries only protocol messages.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  AGENT_ID, CdpMux, DEFAULT_VIEWPORT, FrameDecoder, MAX_AGENT_CLIENTS, MAX_LINE_BYTES, MAX_TABS, acceptUpgrade, checkUpgrade, encodeFrame, refuseUpgrade,
  requestHost, shouldBlockHost, validateControl, type CdpMsg, type Control, type MuxClient, type TargetInfo,
} from "./floq-browserd-core.mjs";
import { EgressMux, PeerChecker, attachMuxToStream, socketSink, startSocksListener } from "./floq-egress.mjs";
import { Socket } from "node:net";
import { fstatSync } from "node:fs";

const HOME = process.env.HOME || homedir();
const BASE = join(HOME, ".floq", "browser");
const PROFILE = join(BASE, "profile");
/** Session cookies and each node's last URL, kept across daemon restarts (idle shutdown). Chromium drops session cookies when it exits. */
const STATE_FILE = join(BASE, "session-state.json");
type SavedState = { cookies: Array<Record<string, unknown>>; pages: Record<string, string> };
export function readSavedState(file = STATE_FILE): SavedState {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedState>;
    const pages: Record<string, string> = {};
    for (const [k, v] of Object.entries(j.pages ?? {})) if (typeof v === "string" && /^https?:\/\//.test(v)) pages[k] = v;
    return { cookies: Array.isArray(j.cookies) ? j.cookies.filter((c) => c && typeof c === "object") : [], pages };
  } catch { return { cookies: [], pages: {} }; }
}
export function writeSavedState(st: SavedState, file = STATE_FILE): void {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
const DOWNLOADS = join(HOME, "Downloads");
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/floq/browsers";

const log = (event: string, extra: Record<string, unknown> = {}) => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), event, ...extra }) + "\n");
const out = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify(msg) + "\n");

function findChromium(): string {
  const given = process.env.FLOQ_BROWSER_EXECUTABLE;
  if (given) return given;
  const dirs = existsSync(BROWSERS) ? readdirSync(BROWSERS).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  for (const d of dirs.reverse()) {
    const exe = join(BROWSERS, d, "chrome-linux64", "chrome");
    if (existsSync(exe)) return exe;
  }
  throw new Error("no chromium build under " + BROWSERS);
}

/** Remove a SingletonLock left by a crashed Chromium, but only when the pid in it is gone from this sandbox. */
export function clearStaleSingleton(profile: string, isAlive: (pid: number) => boolean = defaultAlive): boolean {
  const lock = join(profile, "SingletonLock");
  let target: string;
  try { if (!lstatSync(lock).isSymbolicLink()) return false; target = readlinkSync(lock); } catch { return false; }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return false;
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(profile, f), { force: true });
  log("browser.stale_singleton_removed", { target });
  return true;
}
function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  try { return /chrome/.test(readFileSync("/proc/" + pid + "/cmdline", "utf8")); } catch { return false; }
}

/**
 * Chromium flags that send ALL network traffic through the egress SOCKS listener (docs/design/browser-user-egress.md §2.2).
 * Only egress routing is changed: no user agent, webdriver, timezone or fingerprint flag. Loopback keeps bypassing the proxy (Chromium default).
 */
export function egressFlags(port: number): string[] {
  return [
    "--proxy-server=socks5://127.0.0.1:" + port,
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
  ];
}

/** Egress state shared by the launch code: the listener port (when egress is on) and the current Chromium root pid for the peer check. */
const egressRuntime: { port: number | null; rootPid?: number } = { port: null };

export function chromiumArgs(opts: { sandbox: boolean; profile: string; egressPort?: number }): string[] {
  return [
    "--headless=new", "--remote-debugging-pipe", "--user-data-dir=" + opts.profile, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--password-store=basic", "--use-mock-keychain", "--disable-dev-shm-usage", "--window-size=1280,800",
    "--js-flags=--max-old-space-size=1024", "--mute-audio", ...(opts.egressPort ? egressFlags(opts.egressPort) : []), ...(opts.sandbox ? [] : ["--no-sandbox"]), "about:blank",
  ];
}

/** One clean line for `floq browser status`: never a crash trace. */
export function sandboxFailureReason(code: number | null, stderrTail: string): string {
  if (/No usable sandbox|setuid sandbox|namespace sandbox/i.test(stderrTail)) {
    return "no usable sandbox: the kernel refuses user namespaces with a uid map inside the agent sandbox";
  }
  const line = stderrTail.split("\n").map((l) => l.trim())
    .filter((l) => /FATAL|ERROR/.test(l) && !/crashpad|file_io_posix/.test(l))
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, "").replace(/^(FATAL|ERROR):\S+\]\s*/, ""))[0];
  return ("exit " + code + (line ? ": " + line : "")).slice(0, 160);
}

type Running = { child: ChildProcess; stderrTail: () => string };

function launchChromium(exe: string, sandbox: boolean): Running {
  const args = chromiumArgs({ sandbox, profile: PROFILE, ...(egressRuntime.port ? { egressPort: egressRuntime.port } : {}) });
  const limitMb = Number(process.env.FLOQ_BROWSER_MEM_MB);
  // Optional address-space cap (FLOQ_BROWSER_MEM_MB). Off unless the runtime passes it: RLIMIT_AS is hard on Chromium's large reservations.
  const [file, argv] = limitMb > 0 && spawnSync("sh", ["-c", "command -v prlimit"], { stdio: ["ignore", "ignore", "ignore", "ignore"] }).status === 0
    ? ["prlimit", ["--as=" + limitMb * 1024 * 1024, "--", exe, ...args]] as const
    : [exe, args] as const;
  const child = spawn(file, argv, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", HOME },
  });
  egressRuntime.rootPid = child.pid;
  let tail = "";
  for (const s of [child.stdio[3], child.stdio[4], child.stderr]) s?.on("error", () => { /* Chromium went away; the exit handler reports it */ });
  child.on("error", (e) => log("browser.spawn_error", { message: e.message }));
  child.stderr!.on("data", (c: Buffer) => { tail = (tail + c.toString("utf8")).slice(-4096); });
  return { child, stderrTail: () => tail };
}

class Pipe {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private child: ChildProcess, private onMessage: (m: CdpMsg) => void) {
    (child.stdio[4] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (let i = this.buf.indexOf(0); i >= 0; i = this.buf.indexOf(0)) {
        const line = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line) as CdpMsg); } catch { /* garbage */ }
      }
    });
  }
  write(msg: CdpMsg) { (this.child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify(msg) + "\0"); }
}

/** First launch tries Chromium's own sandbox; if it cannot start (no nested userns in bwrap/seccomp), relaunch with --no-sandbox. */
async function startChromium(exe: string, onExit: (code: number | null) => void): Promise<{ run: Running; mux: CdpMux; sandbox: boolean; reason?: string }> {
  const forced = process.env.FLOQ_BROWSER_NO_SANDBOX;
  const attempts = forced === "1" ? [false] : forced === "0" ? [true] : [true, false];
  let reason: string | undefined;
  for (const sandbox of attempts) {
    clearStaleSingleton(PROFILE);
    const run = launchChromium(exe, sandbox);
    let pipe!: Pipe;
    const mux = new CdpMux((m) => pipe.write(m));
    mux.lockProxy = egressRuntime.port !== null;
    pipe = new Pipe(run.child, (m) => mux.fromChrome(m));
    const died = new Promise<number | null>((resolve) => run.child.once("exit", resolve));
    try {
      const probe = await Promise.race([
        mux.command("Browser.getVersion", {}, undefined, 12000).then((r) => ({ ok: true as const, r })),
        died.then((code) => ({ ok: false as const, code })),
      ]);
      if (probe.ok) {
        run.child.once("exit", onExit);
        return { run, mux, sandbox, reason };
      }
      reason = sandboxFailureReason(probe.code, run.stderrTail());
    } catch (e) {
      reason = (e as Error).message;
      run.child.kill("SIGKILL");
    }
    if (sandbox && attempts.length > 1) log("browser.chromium_sandbox_off", { reason });
  }
  throw new Error("chromium did not start: " + reason);
}

async function main() {
  mkdirSync(BASE, { recursive: true, mode: 0o700 });
  mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  chmodSync(PROFILE, 0o700);
  mkdirSync(DOWNLOADS, { recursive: true });
  const exe = findChromium();
  const chromiumVersion = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe", "ignore"] }) /* fd 3 (relay pipe) is never inherited by helpers: slot 3 is /dev/null */.stdout?.trim() ?? "";
  const blockPrivate = process.env.FLOQ_BROWSER_BLOCK_PRIVATE === "1";
  let stopping = false;
  const shutdown = (code = 0) => {
    if (stopping) return;
    stopping = true;
    // Browser.close lets Chromium flush its cookie store (session cookies included) before the signals follow.
    const close = () => { try { void mux?.command("Browser.close", {}, undefined, 2000).catch(() => {}); } catch { /* not started yet */ } };
    if (chromeRun) void Promise.race([saveState().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]).then(close); else close();
    setTimeout(() => { try { chromeRun?.child.kill("SIGTERM"); } catch { /* gone */ } }, 3500).unref();
    setTimeout(() => { try { chromeRun?.child.kill("SIGKILL"); } catch { /* gone */ } out({ type: "exit" }); process.exit(code); }, 5000).unref();
    chromeRun?.child.once("exit", () => { out({ type: "exit" }); process.exit(code); });
    if (!chromeRun) { out({ type: "exit" }); process.exit(code); }
  };
  let chromeRun: Running | undefined;
  // User-IP egress (FLOQ_BROWSER_EGRESS=desktop): the SOCKS listener and the fd 3 mux must be up BEFORE Chromium, which then gets the proxy flags.
  // Fail closed: if the pipe or the listener is not there, the daemon does not start (Chromium never runs unproxied in this mode).
  const egressOn = process.env.FLOQ_BROWSER_EGRESS === "desktop";
  if (egressOn) {
    try { fstatSync(3); } catch { throw new Error("egress needs fd 3 (the runtime relay pipe)"); }
    const fd3 = new Socket({ fd: 3, readable: true, writable: true });
    const egressMux = new EgressMux(socketSink(fd3), { log, onState: (up) => { log("egress.link", { up }); out({ type: "egress", state: up ? "up" : "down" }); } });
    attachMuxToStream(egressMux, fd3);
    const peers = new PeerChecker({ uid: process.getuid?.() ?? -1, rootPid: () => egressRuntime.rootPid, strictness: process.env.FLOQ_BROWSER_EGRESS_PEER === "uid" ? "uid" : "tree" });
    const { port } = await startSocksListener({ mux: egressMux, peers, log });
    egressRuntime.port = port;
    log("egress.listening", { port });
  }
  const started = await startChromium(exe, () => { log("browser.chromium_exit"); if (!stopping) { stopping = true; out({ type: "exit" }); process.exit(1); } });
  chromeRun = started.run;
  const mux = started.mux;

  try {
    const v = (await mux.command("Browser.getVersion")).result as { product?: string } | undefined;
    const expected = readVersionFile();
    if (expected && v?.product && !v.product.includes(expected.chromium)) log("browser.version_mismatch", { expected: expected.chromium, actual: v.product });
  } catch { /* version check is advisory */ }

  // ---- state
  let viewport = { ...DEFAULT_VIEWPORT }; // upper bound for pointer coordinates: the largest page viewport seen
  const nodes = new Map<string, string>(); // Browser node id -> its page's targetId (one page per node)
  const casting = new Set<string>(); // targets with a running screencast
  const ackIds = new Map<number, { id: number; sid: string }>(); // our frame n -> Chromium screencast ack
  const agentScope = new Map<string, string | null>(); // agent session id -> node it is linked to (null/absent = unlinked)
  const muxClients = new Map<number, MuxClient>();
  let frameN = 0;
  const lastActivity = new Map<string, number>();
  const navState = new Map<string, { loading: boolean; canBack: boolean; canForward: boolean }>();

  const saved = readSavedState();
  const lastUrls: Record<string, string> = { ...saved.pages };
  /** Snapshot session cookies and each node's current http(s) URL to disk (0600, inside the user's encrypted home). */
  async function saveState() {
    let cookies = saved.cookies;
    try {
      const r = (await mux.command("Storage.getCookies", {}, undefined, 1500)).result as { cookies?: Array<Record<string, unknown>> } | undefined;
      if (r?.cookies) cookies = r.cookies.filter((c) => c.session === true);
    } catch { /* keep the previous snapshot */ }
    for (const [nodeId, tid] of nodes) { const u = mux.targets.get(tid)?.url; if (u && /^https?:\/\//.test(u)) lastUrls[nodeId] = u; }
    saved.cookies = cookies;
    writeSavedState({ cookies, pages: lastUrls });
  }
  if (saved.cookies.length) {
    const cookies = saved.cookies.map((c) => { const { size, ...rest } = c as Record<string, unknown>; void size; return rest; });
    try { await mux.command("Storage.setCookies", { cookies }, undefined, 5000); log("browser.cookies_restored", { count: cookies.length }); } catch (e) { log("browser.cookies_restore_failed", { message: (e as Error).message }); }
  }
  const saveTimer = setInterval(() => { void saveState().catch(() => {}); }, 15000); saveTimer.unref();
  const pages = () => [...mux.targets.values()].filter((t) => t.type === "page");
  let lastTabs = "";
  const emitTabs = () => {
    const tabs = JSON.stringify(pages().map((t) => ({ targetId: t.targetId, title: t.title, url: t.url, opener: mux.agentOpened.has(t.targetId) ? "agent" : "user" })));
    if (tabs === lastTabs) return;
    lastTabs = tabs;
    out({ type: "tabs", tabs: JSON.parse(tabs) });
  };
  mux.onTargetsChanged = () => {
    // A node's page that went away (closed by its linked agent, or crashed): forget it and let the runtime re-open it for a live viewer.
    for (const [nodeId, tid] of [...nodes]) if (!mux.targets.has(tid)) { nodes.delete(nodeId); casting.delete(tid); refreshScopes(); out({ type: "pageGone", nodeId }); }
    adoptPopups();
    enforceTabCap(); emitTabs();
    for (const tid of nodes.values()) { const t = mux.targets.get(tid); if (t) void emitNav(t.targetId); }
  };
  // A window opened by a node's page (target=_blank, window.open) loads in that same node page: the node shows one page, so the popup
  // must not vanish into an unseen tab. The popup is closed once its URL is known and the opener navigates there instead.
  const popupSeen = new Set<string>();
  const resumedPages = new Set<string>(); // pages the daemon has started: a popup must be running before it is closed, or its renderer (shared with the opener) wedges
  /** Page.windowOpen (window.open, target=_blank links) names the URL before the popup has loaded; the opener goes there and the popup is closed. */
  const windowOpens = new Map<string, number>(); // opener target -> number of popups still to close
  function adoptWindowOpen(openerTid: string, url: string) {
    const sid = mux.sessionFor(openerTid);
    if (!sid || !/^https?:\/\//.test(url)) return;
    log("browser.popup_adopted", { url: url.slice(0, 120) });
    windowOpens.set(openerTid, (windowOpens.get(openerTid) ?? 0) + 1);
    void mux.command("Page.navigate", { url }, sid).catch(() => {});
    setTimeout(() => { windowOpens.delete(openerTid); }, 5000).unref();
    adoptPopups();
  }
  function adoptPopups() {
    for (const t of pages()) {
      if (popupSeen.has(t.targetId) || !t.openerId || mux.claimed.has(t.targetId) || mux.agentOpened.has(t.targetId)) continue;
      if (![...nodes.values()].includes(t.openerId)) continue;
      if (!resumedPages.has(t.targetId)) continue; // not started yet: closing it now would leave the opener's renderer stuck
      const pending = windowOpens.get(t.openerId) ?? 0;
      if (pending > 0) { // its URL was already taken from Page.windowOpen
        popupSeen.add(t.targetId); windowOpens.set(t.openerId, pending - 1);
        mux.command("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
        continue;
      }
      if (!/^https?:\/\//.test(t.url)) continue;
      popupSeen.add(t.targetId);
      const sid = mux.sessionFor(t.openerId);
      if (!sid) continue;
      log("browser.popup_adopted", { url: t.url.slice(0, 120) });
      void mux.command("Page.navigate", { url: t.url }, sid).catch(() => {});
      mux.command("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    }
    for (const id of [...popupSeen, ...resumedPages]) if (!mux.targets.has(id)) { popupSeen.delete(id); resumedPages.delete(id); }
  }
  mux.onClientCount = (n) => out({ type: "clients", agents: n });
  mux.onActivity = (targetId) => {
    const now = Date.now();
    if (now - (lastActivity.get(targetId) ?? 0) < 1000) return;
    lastActivity.set(targetId, now);
    out({ type: "agentActivity", targetId, at: now });
  };

  function enforceTabCap() {
    const all = pages();
    if (all.length <= MAX_TABS) return;
    const candidates = all.filter((t) => !mux.claimed.has(t.targetId));
    const victim = candidates.find((t) => mux.agentOpened.has(t.targetId)) ?? candidates[0];
    if (victim) { log("browser.tab_cap_closed", { targetId: victim.targetId }); mux.command("Target.closeTarget", { targetId: victim.targetId }).catch(() => {}); }
  }

  async function emitNav(targetId: string, loading?: boolean) {
    const t = mux.targets.get(targetId);
    const sid = mux.sessionFor(targetId);
    if (!t || !sid) return;
    let canBack = false, canForward = false;
    try {
      const h = (await mux.command("Page.getNavigationHistory", {}, sid, 5000)).result as { currentIndex: number; entries: unknown[] };
      canBack = h.currentIndex > 0; canForward = h.currentIndex < h.entries.length - 1;
    } catch { /* page closing */ }
    const prev = navState.get(targetId);
    const state = { loading: loading ?? prev?.loading ?? false, canBack, canForward };
    navState.set(targetId, state);
    if (/^https?:\/\//.test(t.url)) for (const [nodeId, tid] of nodes) if (tid === targetId) lastUrls[nodeId] = t.url;
    out({ type: "nav", targetId, url: t.url, title: t.title, ...state });
  }

  // ---- private-network interceptor (T6)
  const resolver = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);
  mux.onDaemonAttached = (info: TargetInfo, sessionId: string) => {
    void (async () => {
      let protectedOk = true;
      // A window opened by a page (target=_blank) starts with its renderer paused: commands the renderer answers (lifecycle events,
      // child auto-attach) never return until it is resumed, which deadlocked the whole setup and left the popup blank forever.
      // So a popup is resumed as soon as the browser-side hooks (Page, Fetch) are in place, and configured after.
      const popup = info.type === "page" && !!info.openerId;
      let resumed = false;
      const resume = () => {
        if (resumed || !protectedOk) return;
        resumed = true;
        void mux.command("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {}).then(() => { resumedPages.add(info.targetId); if (popup) setTimeout(adoptPopups, 150).unref(); });
      };
      try {
        const intercepted = info.type === "page" || info.type === "iframe" || info.type === "worker" || info.type === "service_worker" || info.type === "shared_worker";
        if (intercepted) {
          if (info.type !== "service_worker" && info.type !== "shared_worker") await mux.command("Page.enable", {}, sessionId, 5000).catch(() => {});
          if (blockPrivate) {
            try { await mux.command("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId); }
            catch {
              // Fail closed: a target that could not be put behind the interceptor never gets to run.
              protectedOk = false;
              log("browser.fetch_enable_failed", { type: info.type });
              await mux.command("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
            }
          }
          if (popup) resume();
          if (info.type === "page") await mux.command("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId, 5000).catch(() => {});
          if (protectedOk) await mux.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId, 5000).catch(() => {});
        }
      } finally {
        resume();
      }
    })();
  };
  mux.onDaemonEvent = (msg) => {
    const p = msg.params ?? {};
    if (msg.method === "Fetch.requestPaused" && msg.sessionId) {
      const sid = msg.sessionId, requestId = String(p.requestId);
      const url = String((p.request as { url?: string } | undefined)?.url ?? "");
      const host = requestHost(url);
      const go = host ? shouldBlockHost(host, resolver, { literalOnly: egressOn }) : Promise.resolve(false);
      void go.then((blocked) => {
        if (blocked) log("browser.private_blocked", { host });
        return mux.command(blocked ? "Fetch.failRequest" : "Fetch.continueRequest", blocked ? { requestId, errorReason: "AccessDenied" } : { requestId }, sid);
      }).catch(() => {});
      return;
    }
    if (msg.method === "Page.screencastFrame") {
      const frameTarget = msg.sessionId ? sessionTargetOf(msg.sessionId) : undefined;
      if (frameTarget && casting.has(frameTarget) && msg.sessionId) {
        const meta = (p.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number };
        const n = ++frameN;
        ackIds.set(n, { id: Number(p.sessionId), sid: msg.sessionId });
        if (ackIds.size > 64) ackIds.delete(ackIds.keys().next().value as number);
        const w = Math.round(meta.deviceWidth ?? viewport.w), h = Math.round(meta.deviceHeight ?? viewport.h);
        if (w > viewport.w || h > viewport.h) viewport = { w: Math.max(w, viewport.w), h: Math.max(h, viewport.h) };
        out({ type: "frame", n, targetId: frameTarget, jpeg: String(p.data), w, h, scale: meta.pageScaleFactor ?? 1 });
      } else if (msg.sessionId) { // not watching any more: ack so Chromium does not stall
        mux.command("Page.screencastFrameAck", { sessionId: Number(p.sessionId) }, msg.sessionId).catch(() => {});
      }
      return;
    }
    if (msg.method === "Browser.downloadWillBegin" || msg.method === "Browser.downloadProgress") {
      // frameId of a main frame is its target id; downloads started by other pages are not reported to a node.
      if (msg.method === "Browser.downloadWillBegin") {
        const guid = String(p.guid ?? ""), frame = String(p.frameId ?? "");
        downloadFrames.set(guid, frame);
        if (downloadFrames.size > 64) downloadFrames.delete(downloadFrames.keys().next().value as string);
        out({ type: "download", targetId: frame, name: String(p.suggestedFilename ?? "file").slice(0, 200), state: "started" });
      } else if (p.state === "completed" || p.state === "canceled") {
        const frame = downloadFrames.get(String(p.guid ?? ""));
        if (frame) out({ type: "download", targetId: frame, name: "", state: p.state === "completed" ? "done" : "failed" });
      }
      return;
    }
    if (msg.method === "Target.targetCrashed") {
      const crashed = String(p.targetId ?? "");
      for (const [nodeId, tid] of nodes) if (tid === crashed) {
        // The renderer died: replace the page. Dropping it makes the runtime re-open the node, which resumes its last URL.
        log("browser.page_crashed", { nodeId });
        mux.command("Target.closeTarget", { targetId: tid }).catch(() => {});
      }
      return;
    }
    const tid = msg.sessionId ? sessionTargetOf(msg.sessionId) : undefined;
    if (!tid) return;
    if (msg.method === "Page.windowOpen" && nodes.size && [...nodes.values()].includes(tid)) { adoptWindowOpen(tid, String(p.url ?? "")); return; }
    if (msg.method === "Page.javascriptDialogOpening") {
      const kind = String(p.type ?? "alert");
      if (kind === "beforeunload") { mux.command("Page.handleJavaScriptDialog", { accept: true }, msg.sessionId).catch(() => {}); return; } // never trap a navigation
      const d = { type: "dialog", targetId: tid, kind, message: String(p.message ?? "").slice(0, 2000), defaultPrompt: String(p.defaultPrompt ?? "").slice(0, 500) };
      dialogs.set(tid, d); out(d); return;
    }
    if (msg.method === "Page.javascriptDialogClosed") { if (dialogs.delete(tid)) out({ type: "dialogClosed", targetId: tid }); return; }
    if (msg.method === "Page.frameStartedLoading") void emitNav(tid, true);
    else if (msg.method === "Page.frameStoppedLoading" || msg.method === "Page.frameNavigated" || msg.method === "Page.navigatedWithinDocument") void emitNav(tid, msg.method === "Page.frameNavigated" ? undefined : false);
  };
  const downloadFrames = new Map<string, string>(); // download guid -> target that started it
  const dialogs = new Map<string, Record<string, unknown>>(); // open JS dialogs by target, replayed to a viewer that attaches later
  const sessionTargetOf = (sessionId: string): string | undefined => { for (const t of mux.targets.keys()) if (mux.sessionFor(t) === sessionId) return t; return undefined; };

  // ---- bootstrap Chromium state
  await mux.command("Target.setDiscoverTargets", { discover: true });
  await mux.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await mux.command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS, eventsEnabled: true }).catch(() => {});

  // ---- node pages and agent scoping
  function refreshScopes() {
    mux.setClaimed(new Set(nodes.values()));
    for (const [cid, client] of muxClients) {
      if (!client.agent) continue;
      const node = agentScope.get(client.agent);
      mux.setScope(cid, node == null ? undefined : (nodes.get(node) ?? null));
    }
  }
  const opening = new Map<string, Promise<string>>();
  /** Idempotent per node. Adopts an unclaimed user page first (the initial tab, or a pre-upgrade tab: the active one is kept, the rest dropped for the legacy node). */
  function openPage(nodeId: string, url?: string): Promise<string> {
    let p = opening.get(nodeId);
    if (!p) { p = doOpen(nodeId, url).finally(() => opening.delete(nodeId)); opening.set(nodeId, p); }
    return p;
  }
  async function doOpen(nodeId: string, url?: string): Promise<string> {
    if (!url && lastUrls[nodeId]) url = lastUrls[nodeId]; // resume where the node was before the daemon stopped
    const have = nodes.get(nodeId);
    if (have && mux.targets.has(have)) { out({ type: "page", nodeId, targetId: have, created: false }); return have; }
    const free = pages().filter((t) => !mux.claimed.has(t.targetId) && !mux.agentOpened.has(t.targetId));
    let targetId: string;
    let created = true;
    if (free.length) {
      targetId = free[0].targetId; created = false;
      if (nodeId === "main") for (const t of free.slice(1)) mux.command("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      if (url) await mux.command("Page.navigate", { url }, mux.sessionFor(targetId)).catch(() => {});
    } else {
      mux.reserve = true; mux.reserved = [];
      try { targetId = String((await mux.command("Target.createTarget", { url: url ?? "about:blank" })).result?.targetId ?? ""); }
      finally { mux.reserve = false; }
      if (!targetId) throw new Error("no target");
    }
    nodes.set(nodeId, targetId);
    for (let i = 0; i < 40 && !mux.sessionFor(targetId); i++) await new Promise((r) => setTimeout(r, 50));
    refreshScopes();
    out({ type: "page", nodeId, targetId, created });
    return targetId;
  }
  function closePage(nodeId: string) {
    const tid = nodes.get(nodeId); if (!tid) return;
    nodes.delete(nodeId); casting.delete(tid); delete lastUrls[nodeId];
    for (const [agent, node] of agentScope) if (node === nodeId) agentScope.delete(agent);
    refreshScopes();
    mux.command("Target.closeTarget", { targetId: tid }).catch(() => {});
  }
  const cursorProbe = new Map<string, { at: number; last: string; busy: boolean }>();
  function probeCursor(targetId: string, sid: string, x: number, y: number) {
    const st = cursorProbe.get(targetId) ?? { at: 0, last: "", busy: false };
    cursorProbe.set(targetId, st);
    const now = Date.now();
    if (st.busy || now - st.at < 80) return;
    st.at = now; st.busy = true;
    const expr = `(()=>{const e=document.elementFromPoint(${Math.round(x)},${Math.round(y)});if(!e)return "default";let c=getComputedStyle(e).cursor;if(c==="auto"){const t=e.tagName;c=(t==="TEXTAREA"||(t==="INPUT"&&!/^(button|submit|checkbox|radio|reset|file|image|range|color)$/.test(e.type))||e.isContentEditable)?"text":"default"}return c.split(",").pop().trim()})()`;
    void mux.command("Runtime.evaluate", { expression: expr, returnByValue: true }, sid, 2000).then((r) => {
      const v = (r.result as { result?: { value?: unknown } } | undefined)?.result?.value;
      const cursor = typeof v === "string" && /^[a-z-]{1,24}$/.test(v) ? v : "default";
      if (cursor !== st.last) { st.last = cursor; out({ type: "cursor", targetId, cursor }); }
    }).catch(() => {}).finally(() => { st.busy = false; });
  }

  // ---- agent endpoint
  const token = randomBytes(32).toString("hex");
  let nextClient = 1;
  const server = createServer((_req, res) => { res.writeHead(404, { Connection: "close" }); res.end(); });
  server.on("upgrade", (req, socket) => {
    const port = (server.address() as { port: number }).port;
    socket.on("error", () => {});
    const status = mux.clientCount >= MAX_AGENT_CLIENTS ? 503 : checkUpgrade(req, port, token);
    if (status) return refuseUpgrade(socket, status);
    acceptUpgrade(req, socket);
    const id = nextClient++;
    let closed = false;
    const agentParam = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("agent");
    const client: MuxClient = {
      id,
      ...(agentParam && AGENT_ID.test(agentParam) ? { agent: agentParam } : {}),
      send: (m) => { if (!closed && socket.writable) socket.write(encodeFrame(1, Buffer.from(JSON.stringify(m)))); },
      close: () => { if (!closed) { closed = true; socket.end(encodeFrame(8, Buffer.from([0x03, 0xe8]))); } },
    };
    let removed = false;
    const gone = () => { closed = true; if (!removed) { removed = true; muxClients.delete(id); mux.removeClient(id); } };
    const dec = new FrameDecoder((op, data) => {
      if (op === 1) { try { mux.fromClient(client, JSON.parse(data.toString("utf8"))); } catch { /* bad json: ignore */ } }
      else if (op === 8) { socket.end(encodeFrame(8, data.subarray(0, 2))); gone(); }
      else if (op === 9) socket.write(encodeFrame(10, data));
    }, () => { socket.destroy(); gone(); });
    socket.on("data", (c: Buffer) => dec.push(c));
    socket.on("close", gone);
    muxClients.set(id, client);
    mux.addClient(client);
    // A linked agent is scoped before it asks for anything, so it only ever hears about its node's page.
    if (client.agent && agentScope.get(client.agent) != null) mux.setScope(id, nodes.get(agentScope.get(client.agent)!) ?? null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const endpointFile = join(BASE, "endpoint.json");
  writeFileSync(endpointFile, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  chmodSync(endpointFile, 0o600);

  // ---- control channel
  const viewSession = (targetId?: string): { targetId: string; sid: string } | undefined => {
    const sid = targetId && nodes.size ? mux.sessionFor(targetId) : undefined;
    return targetId && sid && mux.claimed.has(targetId) ? { targetId, sid } : undefined;
  };
  const noTarget = () => out({ type: "error", code: "no_target" });

  async function stopScreencast(targetId: string) {
    if (!casting.delete(targetId)) return;
    const sid = mux.sessionFor(targetId);
    if (sid) await mux.command("Page.stopScreencast", {}, sid).catch(() => {});
  }

  async function handle(c: Control) {
    switch (c.type) {
      case "hello": return;
      case "shutdown": return shutdown(0);
      case "page.open": await openPage(c.nodeId, c.url); return;
      case "page.close": return closePage(c.nodeId);
      case "agent.scope": {
        if (c.nodeId === null) agentScope.delete(c.agent); else agentScope.set(c.agent, c.nodeId);
        if (c.nodeId !== null && !nodes.has(c.nodeId)) await openPage(c.nodeId).catch(() => {}); // linking creates the node's page if its viewer has not
        refreshScopes();
        return;
      }
      case "dialog.reply": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        await mux.command("Page.handleJavaScriptDialog", { accept: c.accept, ...(c.text !== undefined ? { promptText: c.text } : {}) }, v.sid).catch(() => {});
        return;
      }
      case "screencast.start": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        const open = dialogs.get(v.targetId); if (open) out(open);
        await stopScreencast(v.targetId);
        casting.add(v.targetId);
        const start = () => mux.command("Page.startScreencast", { format: "jpeg", quality: c.quality, maxWidth: c.maxW, maxHeight: c.maxH, everyNthFrame: 1 }, v.sid);
        // A page that has not painted yet (just created or adopted) answers "Not attached to an active page": activate it and retry.
        try { await start(); } catch { await mux.command("Target.activateTarget", { targetId: v.targetId }).catch(() => {}); await new Promise((r) => setTimeout(r, 150)); await start(); }
        void emitNav(v.targetId);
        return;
      }
      case "screencast.stop": return void (c.targetId ? await stopScreencast(c.targetId) : await Promise.all([...casting].map(stopScreencast)));
      case "frame.ack": {
        const a = ackIds.get(c.n);
        ackIds.delete(c.n);
        if (a) mux.command("Page.screencastFrameAck", { sessionId: a.id }, a.sid).catch(() => {});
        return;
      }
      case "viewport": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        const dpr = Math.min(2, Math.max(1, c.dpr));
        if (c.width > viewport.w || c.height > viewport.h) viewport = { w: Math.max(c.width, viewport.w), h: Math.max(c.height, viewport.h) };
        await mux.command("Emulation.setDeviceMetricsOverride", { width: c.width, height: c.height, deviceScaleFactor: dpr, mobile: false }, v.sid);
        return;
      }
      case "input.mouse": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        if (c.kind === "mouseMoved") probeCursor(v.targetId, v.sid, c.x, c.y);
        await mux.command("Input.dispatchMouseEvent", { type: c.kind, x: c.x, y: c.y, button: c.button, buttons: c.buttons, clickCount: c.clickCount, modifiers: c.modifiers }, v.sid);
        return;
      }
      case "input.wheel": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        await mux.command("Input.dispatchMouseEvent", { type: "mouseWheel", x: c.x, y: c.y, deltaX: c.dx, deltaY: c.dy, modifiers: c.modifiers }, v.sid);
        return;
      }
      case "input.key": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        const text = c.text || ([...c.key].length === 1 ? c.key : "");
        // Headless Chromium has no menu accelerators: editing shortcuts only act when the editor command is named.
        const command = c.kind === "keyDown" && c.modifiers & 6 ? shortcutCommand(c.key, c.modifiers) : undefined;
        let copied: string | undefined;
        if (command === "copy" || command === "cut") {
          const r = (await mux.command("Runtime.evaluate", { expression: SELECTED_TEXT, returnByValue: true }, v.sid, 2000).catch(() => ({}))) as { result?: { result?: { value?: unknown } } };
          if (typeof r.result?.result?.value === "string") copied = r.result.result.value.slice(0, 32768);
        }
        await mux.command("Input.dispatchKeyEvent", { type: c.kind === "keyDown" && text && !(c.modifiers & 6) ? "keyDown" : c.kind, key: c.key, code: c.code, modifiers: c.modifiers, ...(c.kind === "keyUp" ? {} : { text: command ? "" : text }), ...(command ? { commands: [command] } : {}), windowsVirtualKeyCode: vkey(c.key) }, v.sid);
        if (copied) out({ type: "clipboard", targetId: v.targetId, text: copied }); // the node writes it to the user's clipboard
        return;
      }
      case "input.text": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        await mux.command("Input.insertText", { text: c.text }, v.sid);
        return;
      }
      case "nav.go": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        await mux.command("Page.navigate", { url: c.url }, v.sid);
        return;
      }
      case "nav.reload": case "nav.stop": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        await mux.command(c.type === "nav.reload" ? "Page.reload" : "Page.stopLoading", {}, v.sid);
        return;
      }
      case "nav.back": case "nav.forward": {
        const v = viewSession(c.targetId); if (!v) return noTarget();
        const h = (await mux.command("Page.getNavigationHistory", {}, v.sid)).result as { currentIndex: number; entries: { id: number }[] };
        const entry = h.entries[h.currentIndex + (c.type === "nav.back" ? -1 : 1)];
        if (entry) await mux.command("Page.navigateToHistoryEntry", { entryId: entry.id }, v.sid);
        return;
      }
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return out({ type: "error", code: "line_too_long" });
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return out({ type: "error", code: "bad_json" }); }
    const v = validateControl(raw, viewport);
    if (!v.ok) return out({ type: "error", code: v.code });
    handle(v.msg).catch((e) => { log("browser.control_failed", { type: v.msg.type, message: (e as Error).message }); out({ type: "error", code: "failed" }); });
  });
  rl.on("close", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  out({ type: "ready", port, token, pid: process.pid, chromium: chromiumVersion, sandbox: started.sandbox ? "on" : "off", ...(started.sandbox ? {} : { sandboxReason: started.reason ?? "forced" }) });
  emitTabs();
}

function readVersionFile(): { chromium: string } | null {
  try { return JSON.parse(readFileSync(join(BROWSERS, "VERSION.json"), "utf8")) as { chromium: string }; } catch { return null; }
}

const SELECTED_TEXT = "(()=>{const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA)$/.test(a.tagName)&&typeof a.selectionStart==='number'&&a.selectionStart!==a.selectionEnd&&a.type!=='password')return a.value.slice(a.selectionStart,a.selectionEnd);return String(getSelection())})()";
/** Editor command for Ctrl/Cmd+key (paste is delivered as text by the node, so it is not here). */
export function shortcutCommand(key: string, modifiers: number): string | undefined {
  if (modifiers & 1) return undefined; // Alt combinations are not editing shortcuts
  const shift = !!(modifiers & 8);
  switch (key.toLowerCase()) {
    case "a": return shift ? undefined : "selectAll";
    case "c": return shift ? undefined : "copy";
    case "x": return shift ? undefined : "cut";
    case "z": return shift ? "redo" : "undo";
    case "y": return shift ? undefined : "redo";
    default: return undefined;
  }
}

/** Windows virtual key codes for the named keys Chromium needs to act on (arrows, Enter, Backspace ...). */
function vkey(key: string): number {
  const named: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91 };
  if (key in named) return named[key];
  const f = /^F(\d+)$/.exec(key);
  if (f) return 111 + Number(f[1]);
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

// Only run when executed, not when a test imports this file.
if (process.argv[1] && /floq-browserd(\.m?[jt]s)?$/.test(process.argv[1])) {
  main().catch((e) => { log("browser.fatal", { message: (e as Error).message }); out({ type: "error", code: "start_failed", message: String((e as Error).message).slice(0, 300) }); out({ type: "exit" }); process.exit(1); });
}
