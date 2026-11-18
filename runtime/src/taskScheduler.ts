import type pg from "pg";
import type { Automations, AutomationHooks } from "./automations.js";
import { log } from "./logger.js";
import type { DispatchDeps, ProjectTasks } from "./projectTasks.js";

/** Arbitrary constant: the Postgres advisory lock that makes exactly one runtime run a tick at a time. */
export const SCHEDULER_LOCK_KEY = 7_421_903_001;
export const TICK_MS = 30_000;

export type SchedulerDeps = DispatchDeps & AutomationHooks;

/**
 * 30 s tick: (1) due automations create their tasks, (2) due `todo` tasks of auto-agent projects are dispatched.
 * - One tick at a time per process (`running`) and per cluster (pg advisory lock on a dedicated connection); the
 *   automation advance and the task claim are additionally atomic row operations, so a lost lock can never double-run.
 * - Entirely async I/O with bounded work per tick: it never blocks the event loop.
 * - All state is in Postgres (next_run_at, task status), so a restart simply resumes at the next tick.
 */
export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly pool: pg.Pool,
    private readonly automations: Automations,
    private readonly tasks: ProjectTasks,
    private readonly deps: SchedulerDeps,
    private readonly options: { intervalMs?: number; firstDelayMs?: number; now?: () => Date } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.options.firstDelayMs ?? 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().catch((error) => log.warn("task_scheduler.tick_failed", { error: String(error).slice(0, 160) })).finally(() => this.schedule(this.options.intervalMs ?? TICK_MS));
    }, ms);
    this.timer.unref?.();
  }

  /** One pass. Returns null when another tick (this process or another runtime) holds the lock. */
  async tick(now: Date = this.options.now?.() ?? new Date()): Promise<{ automations: number; dispatched: number } | null> {
    if (this.running) return null;
    this.running = true;
    let client: pg.PoolClient | null = null;
    try {
      client = await this.pool.connect();
      const got = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [SCHEDULER_LOCK_KEY]);
      if (!got.rows[0]?.ok) return null;
      try {
        const automations = await this.automations.tickDue(now, this.deps);
        const dispatched = await this.tasks.dispatchDue(now, this.deps);
        return { automations, dispatched };
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [SCHEDULER_LOCK_KEY]).catch(() => undefined);
      }
    } finally {
      client?.release();
      this.running = false;
    }
  }
}
