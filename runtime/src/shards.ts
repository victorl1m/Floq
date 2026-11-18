import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type pg from "pg";
import type { Config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { log } from "./logger.js";
import { MOUNT_CHILD_PROBE_MS, MountWatchdog } from "./mountWatch.js";
import { loadRemovedSkills, PROTECTED_SKILLS } from "./skills.js";
import { copySeedTree, ownHomeTree, type ShardDriver, type ShardHandle } from "./shard.js";

/**
 * Tool caches in the user's home that must belong to the user. A single root-owned entry in ~/.npm (left by
 * something run as root against this home) makes every `npx` fail with EACCES, and with it the bundled context7
 * MCP server (`npx -y @upstash/context7-mcp`), which then shows up as "Connection closed". Checked on every wake;
 * lstat/lchown only, symlinks are never followed.
 */
export const USER_TOOL_CACHES = [".npm"] as const;
export function repairToolCaches(home: string, uid: number): void {
  for (const rel of USER_TOOL_CACHES) {
    try { ownHomeTree(home, join(home, rel), uid); }
    catch (error) { log.warn("shard.cache_ownership_repair_failed", { path: rel, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }); }
  }
}

const ALIVE_CHECK_MS = 2_000;

/** Tracks each user's shard (encrypted home) in Postgres and drives wake/sleep through the OS driver. */
export class ShardService {
  private readonly handles = new Map<string, ShardHandle>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly aliveCheckedAt = new Map<string, number>();
  /** Fired (not awaited, never throws into wake) each time a user's home was just unlocked. The agent browser uses it to sync its MCP entry. */
  onWake?: (userId: string) => void;
  /** Fired (not awaited, never throws) after a dead mount was remounted, whether a request or the liveness timer noticed it. Live agent sandboxes still point at the dead mount and need a restart. */
  onMountRecovered?: (userId: string) => Promise<void> | void;
  private readonly watchdogs = new Map<string, MountWatchdog>();
  /** Users whose mount died and has not been successfully remounted yet (a failed remount drops the handle, so this outlives it). */
  private readonly needsRecovery = new Set<string>();
  /** Users whose mount the watchdog found hung: wake() must not probe it synchronously, only remount. */
  private readonly forcedDead = new Set<string>();
  /** Liveness probe interval; tests shorten it. */
  probeMs?: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: Config,
    readonly driver: ShardDriver,
  ) {}

  /** Serialize wake/sleep per user so a late sleep can never lock a home that is being woken. */
  private serial<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.locks.set(userId, next.catch(() => undefined));
    return next;
  }

  /** Liveness of an awake home, probed at most once per ALIVE_CHECK_MS per user (wake() runs on every request). */
  private alive(userId: string, handle: ShardHandle): boolean {
    if (!this.driver.isAlive) return true;
    const now = Date.now();
    if (now - (this.aliveCheckedAt.get(userId) ?? 0) < ALIVE_CHECK_MS) return true;
    const ok = this.driver.isAlive(handle);
    // A dead mount is not remembered: the next wake() probes again if the remount failed.
    if (ok) this.aliveCheckedAt.set(userId, now);
    else this.aliveCheckedAt.delete(userId);
    return ok;
  }

  /**
   * Probe an awake home every few seconds (the same readdir wake() uses) so a dead gocryptfs daemon is found and remounted
   * promptly instead of on the next request. A failed remount keeps the timer running, so it is retried each tick.
   */
  private watch(userId: string, handle: ShardHandle): void {
    this.watchdogs.get(userId)?.stop();
    const driver = this.driver;
    if (!driver.probe && !driver.isAlive) return;
    // Never the synchronous readdir here: a hung FUSE mount would freeze the event loop for every user.
    const probe = () => (driver.probe ? driver.probe(handle, MOUNT_CHILD_PROBE_MS) : driver.isAlive!(handle));
    const dog = new MountWatchdog(
      probe,
      async (reason) => {
        // Defeat the wake() probe throttle: this probe already proved the mount dead.
        this.aliveCheckedAt.delete(userId);
        if (reason === "hung") {
          // wake() would readdirSync the hung mount (blocking), so mark it dead and detach it without touching it.
          this.forcedDead.add(userId);
          try { await driver.abandon?.(handle); }
          catch (error) { log.warn("shard.abandon_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }); }
        }
        await this.wake(userId);
      },
      this.probeMs,
    );
    this.watchdogs.set(userId, dog);
    dog.start();
  }

  private unwatch(userId: string): void {
    this.watchdogs.get(userId)?.stop();
    this.watchdogs.delete(userId);
  }

  isAwake(userId: string): boolean {
    return this.handles.has(userId);
  }

  /** Users whose shard is awake right now (a snapshot; sleeping shards are never woken by callers of this). */
  awakeUserIds(): string[] {
    return [...this.handles.keys()];
  }

  /** Return an already-unlocked user's mount without waking a sleeping shard. */
  awakeHandle(userId: string): ShardHandle | undefined {
    return this.handles.get(userId);
  }

  wake(userId: string): Promise<ShardHandle> {
    return this.serial(userId, async () => {
      const cached = this.handles.get(userId);
      if (cached && !this.forcedDead.has(userId) && this.alive(userId, cached)) return cached;
      if (cached) {
        this.needsRecovery.add(userId);
        // The gocryptfs daemon died under an awake shard (OOM kill, crash): every access fails with ENOTCONN until the
        // home is mounted again. Drop the handle so driver.wake() below unmounts the dead mount and remounts it.
        log.error("shard.mount_died", { userId, uid: cached.uid });
        this.handles.delete(userId);
      }

      let row = (await this.pool.query("SELECT uid, data_key_enc FROM shards WHERE user_id = $1", [userId])).rows[0];
      if (!row) {
        const key = randomBytes(32).toString("hex");
        const encrypted = encryptSecret(this.config.encryptionKey, key, "shard:" + userId);
        row = (
          await this.pool.query(
            "INSERT INTO shards (user_id, data_key_enc) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING uid, data_key_enc",
            [userId, encrypted],
          )
        ).rows[0];
      }
      const dataKey = Buffer.from(decryptSecret(this.config.encryptionKey, row.data_key_enc, "shard:" + userId), "hex");
      const handle = await this.driver.wake({ userId, uid: row.uid }, dataKey);
      dataKey.fill(0);
      let removed: ReadonlySet<string> | null = null;
      try { removed = await loadRemovedSkills(this.pool, userId); }
      catch (error) { log.warn("shard.skill_removals_unavailable", { error: error instanceof Error ? error.message : String(error) }); }
      this.seed(handle.mountPath, ".", handle.uid, removed);
      repairToolCaches(handle.mountPath, handle.uid);
      this.handles.set(userId, handle);
      this.forcedDead.delete(userId);
      this.watch(userId, handle);
      await this.pool.query("UPDATE shards SET state = 'awake', last_active_at = now() WHERE user_id = $1", [userId]);
      if (this.needsRecovery.delete(userId) && this.onMountRecovered) {
        setImmediate(() => {
          void Promise.resolve().then(() => this.onMountRecovered?.(userId)).catch((error) => log.error("shard.mount_recovered_hook_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
        });
      }
      // After this serial task: the hook's own wake/activity calls queue behind it instead of deadlocking on it.
      if (this.onWake) setImmediate(() => { try { this.onWake?.(userId); } catch { /* best effort */ } });
      return handle;
    });
  }

  /**
   * Copy preinstalled skills and MCP config into a directory, never overwriting what the user changed.
   * `removed` holds the user's deleted skills (`provider:directory`); null means unknown, so no optional skills are copied.
   * Without PREINSTALL_SKILLS only the protected Floq skills are copied; settings, hooks and MCP config always are.
   */
  seed(targetDir: string, subdir: "." | ".codex", uid: number, removed: ReadonlySet<string> | null = new Set(), home: string = targetDir): void {
    const source = subdir === "." ? this.config.skelDir : join(this.config.skelDir, subdir);
    if (!existsSync(source)) return;
    const filter = (src: string): boolean => {
      const parts = relative(source, src).split(sep).filter(Boolean);
      // Skill directories are `.claude/skills/<n>`, `.codex/skills/<n>` (top level) or `skills/<n>` (inside the .codex subdir).
      const at = subdir === "." ? (parts[0] === ".claude" || parts[0] === ".codex") && parts[1] === "skills" ? 2 : -1 : parts[0] === "skills" ? 1 : -1;
      if (at < 0 || parts.length <= at) return true;
      const provider = subdir === "." ? (parts[0] === ".claude" ? "claude" : "codex") : "codex";
      if (PROTECTED_SKILLS.includes(parts[at])) return true;
      return this.config.preinstallSkills && removed !== null && !removed.has(`${provider}:${parts[at]}`);
    };
    try {
      // Pinned copy (see copySeedTree): the target lives in an agent-writable home, so root must not follow links the agent planted there.
      copySeedTree(home, source, targetDir, uid, filter);
      // Repair what an older run left root-owned, by descriptor as well.
      const own = (path: string): void => {
        if (resolve(path) === resolve(home)) { for (const name of readdirSync(path)) ownHomeTree(home, join(path, name), uid); }
        else ownHomeTree(home, path, uid);
      };
      if (subdir === ".") { for (const name of readdirSync(source)) own(join(targetDir, name)); }
      else own(targetDir);
    } catch (error) {
      log.warn("shard.seed_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  sleep(userId: string): Promise<void> {
    return this.serial(userId, async () => {
      this.unwatch(userId);
      this.needsRecovery.delete(userId);
      this.forcedDead.delete(userId);
      const handle = this.handles.get(userId);
      if (!handle) return;
      await this.driver.sleep(handle);
      this.handles.delete(userId);
      await this.pool.query("UPDATE shards SET state = 'sleeping' WHERE user_id = $1", [userId]);
    });
  }

  async sleepAll(): Promise<void> {
    for (const userId of [...this.handles.keys()]) {
      try {
        await this.sleep(userId);
      } catch (error) {
        log.error("shard.sleep_failed", { userId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** After a crash/restart the DB may say 'awake' for homes that are no longer mounted. */
  async reconcile(): Promise<void> {
    await this.pool.query("UPDATE shards SET state = 'sleeping' WHERE state = 'awake'");
    // Rows still 'running' belong to a process that died without finishing shutdown() (SIGKILL after the grace period, crash):
    // treat them as interrupted mid-turn so the boot resume (SessionManager.resumeAfterBoot) continues them with the notice.
    await this.pool.query("UPDATE agent_sessions SET state = 'sleeping', sleep_reason = 'restart', slept_at = now(), resume_on_boot = TRUE, interrupted_turn = TRUE WHERE state = 'running'");
  }
}
