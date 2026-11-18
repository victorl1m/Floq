import { log } from "./logger.js";

/** How often an awake shard's mount is probed for a dead gocryptfs daemon. */
export const MOUNT_PROBE_MS = 5_000;
/** A probe that has not answered after this long means the mount is hung (the driver's own child-process timer is shorter). */
export const MOUNT_PROBE_TIMEOUT_MS = 4_000;
/** Kill timer of the driver's probe child process. */
export const MOUNT_CHILD_PROBE_MS = 3_000;
export type MountProbeResult = boolean | "alive" | "dead" | "hung";
/** At most this many automatic session restarts caused by a dead mount, per user, per MOUNT_STORM_WINDOW_MS. */
export const MOUNT_STORM_MAX = 3;
export const MOUNT_STORM_WINDOW_MS = 60 * 60_000;

/**
 * Periodic liveness probe for one awake shard. At most one probe is in flight; the timer is unref'd and stops with stop().
 * The probe is the driver's cheap readdir; `onDead` runs once per detected death and the next tick waits for it to finish,
 * so a slow remount is never started twice.
 */
export class MountWatchdog {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private stopped = true;

  constructor(
    private readonly probe: () => MountProbeResult | Promise<MountProbeResult>,
    private readonly onDead: (reason: "dead" | "hung") => void | Promise<void>,
    private readonly intervalMs: number = MOUNT_PROBE_MS,
    private readonly timeoutMs: number = MOUNT_PROBE_TIMEOUT_MS,
  ) {}

  get running(): boolean { return !this.stopped; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Backstop timeout around any probe: a probe that never settles counts as hung and is abandoned, never awaited again. */
  private withTimeout(): Promise<MountProbeResult> {
    return new Promise<MountProbeResult>((resolve, reject) => {
      const timer = setTimeout(() => resolve("hung"), this.timeoutMs);
      let started: MountProbeResult | Promise<MountProbeResult>;
      try { started = this.probe(); } catch (error) { clearTimeout(timer); reject(error); return; }
      Promise.resolve(started).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  /** One probe cycle (exposed for tests). Returns false when skipped because a cycle is still running. */
  async tick(): Promise<boolean> {
    if (this.inFlight || this.stopped) return false;
    this.inFlight = true;
    try {
      let result: MountProbeResult = "alive";
      try { result = await this.withTimeout(); }
      catch (error) { log.warn("shard.probe_failed", { error: error instanceof Error ? error.message.slice(0, 160) : String(error) }); }
      const reason = result === "hung" ? "hung" : result === false || result === "dead" ? "dead" : null;
      if (reason && !this.stopped) {
        if (reason === "hung") log.error("shard.mount_hung", { timeoutMs: this.timeoutMs });
        try { await this.onDead(reason); }
        catch (error) { log.error("shard.mount_recovery_failed", { error: error instanceof Error ? error.message.slice(0, 160) : String(error) }); }
      }
    } finally {
      this.inFlight = false;
    }
    return true;
  }
}

/** Sliding-window limiter for restarts caused by dead mounts, so a flapping mount cannot restart agents forever. */
export class RestartStormGuard {
  private readonly events = new Map<string, number[]>();
  private readonly blocked = new Set<string>();

  constructor(private readonly max: number = MOUNT_STORM_MAX, private readonly windowMs: number = MOUNT_STORM_WINDOW_MS) {}

  /** Record one recovery. `firstBlock` is true only for the first refusal in a window (so the user is told once). */
  record(userId: string, now: number = Date.now()): { allowed: boolean; count: number; firstBlock: boolean } {
    const recent = (this.events.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.events.set(userId, recent);
      const firstBlock = !this.blocked.has(userId);
      this.blocked.add(userId);
      return { allowed: false, count: recent.length, firstBlock };
    }
    recent.push(now);
    this.events.set(userId, recent);
    this.blocked.delete(userId);
    return { allowed: true, count: recent.length, firstBlock: false };
  }
}

export type RestartReport = { restarted: number; skipped: number; failed: number };
export type MountNotice = { level: "warning" | "error"; title: string; body: string };
export type MountRecoveryDeps = {
  guard: RestartStormGuard;
  /** Restart every live session of the user through sleep -> strict resume; never throws per-session errors. */
  restartSessions: (userId: string) => Promise<RestartReport>;
  notify: (userId: string, notice: MountNotice) => Promise<void> | void;
  now?: () => number;
};

/** What to do after a user's dead mount was remounted: restart their live sessions (guarded) and tell them. */
export async function recoverFromMountDeath(deps: MountRecoveryDeps, userId: string): Promise<"restarted" | "idle" | "storm"> {
  const decision = deps.guard.record(userId, (deps.now ?? Date.now)());
  if (!decision.allowed) {
    log.error("shard.mount_restart_storm", { userId, count: decision.count });
    if (decision.firstBlock) {
      await Promise.resolve(deps.notify(userId, {
        level: "error",
        title: "Workspace storage keeps failing",
        body: `Your encrypted workspace disconnected ${decision.count} times in the last hour and was reconnected, but your agents were not restarted again automatically. Anything an agent wrote since the last disconnect may not have been saved. Restart your agents manually.`,
      })).catch(() => undefined);
    }
    return "storm";
  }
  const report = await deps.restartSessions(userId);
  const total = report.restarted + report.skipped + report.failed;
  log.warn("shard.mount_recovered", { userId, ...report });
  if (total === 0) return "idle";
  const parts = [`${report.restarted} agent${report.restarted === 1 ? "" : "s"} restarted with the same conversation`];
  if (report.skipped) parts.push(`${report.skipped} could not be restarted automatically (shells or no saved conversation yet)`);
  if (report.failed) parts.push(`${report.failed} failed to restart; resume them from the canvas`);
  await Promise.resolve(deps.notify(userId, {
    level: "warning",
    title: "Workspace storage reconnected",
    body: `Your encrypted workspace disconnected and was remounted. ${parts.join("; ")}. Work from the last few seconds before the disconnect may be missing, so agents were told to re-check their state.`,
  })).catch(() => undefined);
  return "restarted";
}

/** Notice typed into each restarted agent after a dead-mount recovery. */
export const MOUNT_RECOVERY_NOTICE = "[Floq] Your workspace storage disconnected and was remounted, and this agent was restarted. Writes made just before the restart (files, notes, transcript lines) may not have been saved. Check what actually exists (files, git status, processes), then continue your task.";
