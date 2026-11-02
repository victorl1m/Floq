import { randomBytes } from "node:crypto";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type pg from "pg";
import type { Config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { log } from "./logger.js";
import { loadRemovedSkills, PROTECTED_SKILLS } from "./skills.js";
import { ownTree, type ShardDriver, type ShardHandle } from "./shard.js";

/** Tracks each user's shard (encrypted home) in Postgres and drives wake/sleep through the OS driver. */
export class ShardService {
  private readonly handles = new Map<string, ShardHandle>();
  private readonly locks = new Map<string, Promise<unknown>>();

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

  isAwake(userId: string): boolean {
    return this.handles.has(userId);
  }

  /** Return an already-unlocked user's mount without waking a sleeping shard. */
  awakeHandle(userId: string): ShardHandle | undefined {
    return this.handles.get(userId);
  }

  wake(userId: string): Promise<ShardHandle> {
    return this.serial(userId, async () => {
      const cached = this.handles.get(userId);
      if (cached) return cached;

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
      this.handles.set(userId, handle);
      await this.pool.query("UPDATE shards SET state = 'awake', last_active_at = now() WHERE user_id = $1", [userId]);
      return handle;
    });
  }

  /**
   * Copy preinstalled skills and MCP config into a directory, never overwriting what the user changed.
   * `removed` holds the user's deleted skills (`provider:directory`); null means unknown, so no optional skills are copied.
   * Without PREINSTALL_SKILLS only the protected Floq skills are copied; settings, hooks and MCP config always are.
   */
  seed(targetDir: string, subdir: "." | ".codex", uid: number, removed: ReadonlySet<string> | null = new Set()): void {
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
      cpSync(source, targetDir, { recursive: true, force: false, errorOnExist: false, filter });
      // Copied by root through gocryptfs: hand what was seeded to the user.
      if (subdir === ".") for (const name of readdirSync(source)) ownTree(join(targetDir, name), uid);
      else ownTree(targetDir, uid);
    } catch (error) {
      log.warn("shard.seed_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  sleep(userId: string): Promise<void> {
    return this.serial(userId, async () => {
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
    await this.pool.query("UPDATE agent_sessions SET state = 'sleeping', sleep_reason = 'restart', slept_at = now() WHERE state = 'running'");
  }
}
