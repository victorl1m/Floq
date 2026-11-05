import { randomBytes } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import { createServer } from "node:net";
import { listAllListeners, parseProcNetTcp, type RawListener } from "./ports.js";

/**
 * Per-session virtual display for GUI apps (Xpra, see the Floq note app-debug-spec-2-display).
 *
 * Sandboxes share the runtime host's network namespace (bwrap without --unshare-net), so TCP ports and abstract X11
 * sockets are global across users. Slots are therefore allocated runtime-wide: slot N gives DISPLAY=:(100+N) and the
 * Xpra HTML5/websocket port (base+N). The token is the Xpra password (auth=env, XPRA_PASSWORD): the port is reachable
 * by every sandbox on the host. Another user can squat a port before Xpra binds it, so `floq display start` first asks
 * the runtime to probe it (display/prepare) and move the lease to a spare port in [base+slots, base+2*slots) if taken.
 * The X server's abstract socket name is held by this session's Xvfb and guarded by the MIT cookie in
 * /tmp/floq-display/Xauthority (session-private /tmp); `floq display start` refuses a display whose abstract socket
 * another process holds, and DISPLAY is only handed out by `floq display env` for a verified running display.
 */


export const DISPLAY_NUMBER_BASE = 100;
export const DEFAULT_DISPLAY_BASE_PORT = 14500;
export const DEFAULT_DISPLAY_SLOTS = 200;

export interface DisplayLease {
  sessionId: string;
  slot: number;
  /** X display number (DISPLAY=:display). */
  display: number;
  /** Loopback port Xpra binds its websocket/HTML5 server to (may move to a spare port, see ensureFreePort). */
  port: number;
  /** Xpra password (auth=env with XPRA_PASSWORD). Fresh on every launch. */
  token: string;
}

export interface DisplayAnnouncement {
  type: "display-started";
  sessionId: string;
  port: number;
}

/** FLOQ_DISPLAY_BASE_PORT, or the default when unset or not an unprivileged port. */
export function displayBasePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FLOQ_DISPLAY_BASE_PORT?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_DISPLAY_BASE_PORT;
}

export class DisplayAllocator {
  /** Current lease per session (what GET /display and the CLI see). */
  private readonly bySession = new Map<string, DisplayLease>();
  /** Every lease not yet released, by token: includes replaced ones whose old sandbox is still exiting (draining). */
  private readonly byToken = new Map<string, DisplayLease>();
  private readonly usedSlots = new Set<number>();
  private readonly usedPorts = new Set<number>();
  private readonly listeners = new Map<string, Set<(event: DisplayAnnouncement) => void>>();
  private readonly slots: number;

  constructor(
    private readonly basePort = displayBasePort(),
    slots = DEFAULT_DISPLAY_SLOTS,
    private readonly makeToken: () => string = () => randomBytes(24).toString("base64url"),
  ) {
    this.slots = Math.max(0, Math.min(slots, 65536 - basePort));
    this.spareEnd = Math.min(65536, basePort + 2 * this.slots);
  }

  private readonly spareEnd: number;

  private setPort(lease: DisplayLease, port: number) {
    this.usedPorts.delete(lease.port);
    lease.port = port;
    this.usedPorts.add(port);
  }

  /**
   * Lease for a session launch, always on a free slot with a fresh token. A relaunch does NOT reuse the previous slot:
   * the previous lease keeps its display number and port until its own process has exited (release with its token),
   * so no session, not even the same one, can get a display whose old Xvfb/xpra still holds the names.
   * Returns null when all slots are taken.
   */
  acquire(sessionId: string): DisplayLease | null {
    let slot = -1;
    for (let candidate = 0; candidate < this.slots; candidate++) {
      if (!this.usedSlots.has(candidate)) { slot = candidate; break; }
    }
    if (slot < 0) return null;
    // Home ports [base, base+slots) belong to their slot only; spares [base+slots, base+2*slots) are lent by ensureFreePort.
    const lease: DisplayLease = { sessionId, slot, display: DISPLAY_NUMBER_BASE + slot, port: this.basePort + slot, token: this.makeToken() };
    this.usedSlots.add(slot);
    this.usedPorts.add(lease.port);
    this.bySession.set(sessionId, lease);
    this.byToken.set(lease.token, lease);
    return lease;
  }

  /**
   * Make sure the session's display port is free right now (another user may have bound it: shared netns). If it is
   * taken, move the lease to the next free spare port. Returns the port to bind, or null when no free port was found.
   */
  async ensureFreePort(sessionId: string, isFree: (port: number) => Promise<boolean> = portIsFree): Promise<number | null> {
    const lease = this.bySession.get(sessionId);
    if (!lease) return null;
    if (await isFree(lease.port)) return lease.port;
    for (let port = this.basePort + this.slots; port < this.spareEnd; port++) {
      if (this.usedPorts.has(port) || !(await isFree(port))) continue;
      if (this.bySession.get(sessionId) !== lease) return null; // relaunched or released meanwhile
      if (this.usedPorts.has(port)) continue;
      this.setPort(lease, port);
      return port;
    }
    return null;
  }

  /**
   * Free a lease once its process has exited. With `token`, exactly that lease (current or draining); without, the
   * session's current lease. Idempotent: returns false when there is nothing (left) to free.
   */
  release(sessionId: string, token?: string): boolean {
    const lease = token !== undefined ? this.byToken.get(token) : this.bySession.get(sessionId);
    if (!lease || lease.sessionId !== sessionId) return false;
    this.byToken.delete(lease.token);
    if (this.bySession.get(sessionId) === lease) this.bySession.delete(sessionId);
    this.usedSlots.delete(lease.slot);
    this.usedPorts.delete(lease.port);
    return true;
  }

  get(sessionId: string): DisplayLease | null {
    return this.bySession.get(sessionId) ?? null;
  }

  subscribe(userId: string, fn: (event: DisplayAnnouncement) => void): () => void {
    const set = this.listeners.get(userId) ?? new Set();
    set.add(fn);
    this.listeners.set(userId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(userId);
    };
  }

  announce(userId: string, sessionId: string): boolean {
    const lease = this.bySession.get(sessionId);
    if (!lease) return false;
    for (const fn of this.listeners.get(userId) ?? []) {
      try { fn({ type: "display-started", sessionId, port: lease.port }); } catch { /* one bad listener must not block the rest */ }
    }
    return true;
  }
}

/** True when nothing listens on 127.0.0.1:port (the runtime shares the sandboxes' network namespace). */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Per-user netns (FLOQ_NETNS): the namespace holds only this user's processes, so "free" means no LISTEN socket on the
 * port in the namespace of the session process `pid`. A bind probe cannot run here (node cannot setns), and no other
 * tenant can squat the port in that namespace.
 */
export function portIsFreeInNetns(pid: number | null): (port: number) => Promise<boolean> {
  return async (port) => {
    if (pid === null) return false;
    return !(await listAllListeners(pid)).some((l) => l.port === port);
  };
}

/**
 * Env injected into every session launch. DISPLAY and XAUTHORITY are deliberately NOT exported: while no display runs,
 * another user could bind the abstract name @/tmp/.X11-unix/XN and a GUI app would connect to it. Agents get them
 * from `eval "$(floq display env)"`, which prints them only for a running display whose socket is verified ours.
 * FLOQ_DISPLAY_PORT is the initial port; `floq display start` uses the one display/prepare returns.
 */
export function displayEnv(lease: DisplayLease): Record<string, string> {
  return {
    FLOQ_DISPLAY: ":" + lease.display,
    FLOQ_DISPLAY_PORT: String(lease.port),
    FLOQ_DISPLAY_TOKEN: lease.token,
  };
}

/** Response of GET /v1/sessions/:id/display. The token is only returned while the display is running. */
export function displayStatus(lease: DisplayLease | null, listeningPorts: ReadonlyArray<{ port: number }>): { running: boolean; port: number | null; token: string | null } {
  if (!lease) return { running: false, port: null, token: null };
  const running = listeningPorts.some((p) => p.port === lease.port);
  return { running, port: lease.port, token: running ? lease.token : null };
}

async function processTree(root: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const ppid = Number.parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1], 10);
      children.set(ppid, [...(children.get(ppid) ?? []), Number(name)]);
    } catch { /* exited */ }
  }
  const all = [root];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i]) ?? []));
  return all;
}

/**
 * Stop the session's display server: SIGTERM the process in the session's own tree that holds the listening socket
 * of the display port (Xpra shuts down its Xvfb and clients on SIGTERM). Never signals anything outside the tree.
 */
export async function stopDisplayServer(rootPid: number | null, port: number, kill: (pid: number, signal: NodeJS.Signals) => void = process.kill, inNetns = false): Promise<boolean> {
  if (rootPid === null || process.platform !== "linux") return false;
  let all: RawListener[];
  if (inNetns) all = await listAllListeners(rootPid); // the session's own namespace (FLOQ_NETNS)
  else {
    const [v4, v6] = await Promise.all([readFile("/proc/net/tcp", "utf8").catch(() => ""), readFile("/proc/net/tcp6", "utf8").catch(() => "")]);
    all = [...parseProcNetTcp(v4, false), ...parseProcNetTcp(v6, true)];
  }
  const inodes = new Set(all.filter((l) => l.port === port).map((l) => l.inode));
  if (!inodes.size) return false;
  for (const pid of await processTree(rootPid)) {
    if (pid === rootPid) continue;
    let fds: string[];
    try { fds = await readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`));
        if (match && inodes.has(match[1])) { kill(pid, "SIGTERM"); return true; }
      } catch { /* fd closed */ }
    }
  }
  return false;
}
