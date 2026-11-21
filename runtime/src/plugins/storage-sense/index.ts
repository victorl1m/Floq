import { definePlugin } from "../sdk.js";
import { summarize, trimEntries, type StorageSenseReport } from "../../storageSense/plan.js";
import { dueTrigger, effectiveConfig } from "../../storageSense/schedule.js";

const FIFTEEN_MIN = 15 * 60_000;
const MANUAL_BUDGET_MS = 60_000;

export const storageSenseManifest = {
  id: "storage-sense",
  name: "Storage Sense",
  version: "1.0.0",
  apiVersion: 1,
  tier: "core",
  description: "Automatically and safely removes what agents leave behind in your home: merged worktrees, orphan branches, old scratchpads, uploads and temp files. Never touches Artifacts, transcripts, checkpoints or unsaved work.",
  icon: "IconTrash",
  scope: "user",
  settings: [
    { key: "mode", type: "select", label: "Mode", description: "Clean (default): removes what is safe to remove. Report only: lists it and deletes nothing.", options: [{ value: "clean", label: "Clean automatically" }, { value: "report", label: "Report only" }, { value: "off", label: "Off" }] },
    { key: "worktreeDays", type: "number", label: "Worktrees idle for (days)", description: "Of ended agents, only when clean and merged into the base branch. Default 30, 0 = never." },
    { key: "branchDays", type: "number", label: "Orphan branches idle for (days)", description: "floq/<agent> branches with no agent or worktree, only when merged. Default 30, 0 = never." },
    { key: "scratchpadDays", type: "number", label: "Agent scratchpads of ended sessions (days)", description: "Default 7, 0 = never." },
    { key: "buildDays", type: "number", label: "Build output unused for (days)", description: "Folders marked with a CACHEDIR.TAG, such as Rust target/, in projects and workspaces. They are rebuilt on the next build. Default 14, 0 = never." },
    { key: "attachmentDays", type: "number", label: "Uploaded attachments (days)", description: "Default 60, 0 = never." },
    { key: "tmpDays", type: "number", label: "Other temp files (days)", description: "Entries in your persistent /tmp. Default 14, 0 = never." },
    { key: "notify", type: "boolean", label: "Notify me after cleanups", description: "Send a notification when a run removes something or keeps something that needs your attention. Default off; the footer button always shows the last report." },
    { key: "lowSpacePercent", type: "number", label: "Also clean when free space is below (%)", description: "Checked every 15 minutes, at most one extra run per hour. Default 10, 0 = never." },
  ],
  // No sidebar view: the app shows Storage Sense as a footer button next to memory usage.
  contributes: { routes: true },
};

export default definePlugin({
  manifest: storageSenseManifest,
  start(ctx) {
    const store = async (userId: string, report: StorageSenseReport): Promise<void> => {
      await ctx.kv.set(userId, "lastRunAt", Date.parse(report.at));
      await ctx.kv.set(userId, "report", { ...report, entries: trimEntries(report.entries, 120) });
      ctx.events.publish(userId, "report", { at: report.at });
    };

    const runFor = async (userId: string, trigger: StorageSenseReport["trigger"], dryRunOverride?: boolean): Promise<StorageSenseReport | null> => {
      const { mode, config } = effectiveConfig(await ctx.settings.get(userId));
      if (mode === "off" && trigger !== "manual") return null;
      const dryRun = dryRunOverride ?? mode !== "clean";
      const report = await ctx.storageSense.run(userId, config, { dryRun, trigger, budgetMs: trigger === "manual" ? MANUAL_BUDGET_MS : undefined });
      if (!report) return null;
      await store(userId, report);
      const note = (await ctx.settings.get(userId)).notify === true ? summarize(report) : null; // notifications are opt-in
      if (note) await ctx.storageSense.notify(userId, note).catch((e) => ctx.log.warn("notify failed", { error: String(e).slice(0, 120) }));
      ctx.log.info("storage sense run", { dryRun, trigger, removed: report.counts.removed, kept: report.counts.kept, failed: report.counts.failed, partial: report.partial });
      return report;
    };

    ctx.routes.get("/state", async ({ userId }) => {
      const { mode, config } = effectiveConfig(await ctx.settings.get(userId));
      const awake = ctx.storageSense.awakeUserIds().includes(userId);
      return { mode, config, awake, freePercent: awake ? await ctx.storageSense.freePercent(userId).catch(() => null) : null, lastRunAt: (await ctx.kv.get(userId, "lastRunAt")) ?? null, report: (await ctx.kv.get(userId, "report")) ?? null };
    });

    // "Run now": a dry run unless the body says dryRun:false AND the user's mode is not "off". A click in the UI is consent.
    ctx.routes.post("/run", async ({ userId, body }) => {
      if (!ctx.storageSense.awakeUserIds().includes(userId)) throw ctx.httpError(409, "home_asleep", "Your workspace is asleep; Storage Sense runs while it is awake");
      const dryRun = !(body && typeof body === "object" && (body as { dryRun?: unknown }).dryRun === false);
      const report = await runFor(userId, "manual", dryRun);
      if (!report) throw ctx.httpError(409, "already_running", "A cleanup is already running");
      return report;
    });

    // Daily per awake shard, plus the low-space trigger. Never wakes a sleeping home. One user at a time; runs never overlap.
    ctx.schedule(FIFTEEN_MIN, async () => {
      const awake = new Set(ctx.storageSense.awakeUserIds());
      for (const userId of await ctx.enabledUserIds()) {
        if (!awake.has(userId)) continue;
        try {
          const { mode, config } = effectiveConfig(await ctx.settings.get(userId));
          if (mode === "off") continue;
          const lastRunAt = (await ctx.kv.get(userId, "lastRunAt")) as number | null | undefined;
          const free = await ctx.storageSense.freePercent(userId).catch(() => null);
          const trigger = dueTrigger({ now: Date.now(), lastRunAt: typeof lastRunAt === "number" ? lastRunAt : null, freePercent: free, lowSpacePercent: config.lowSpacePercent });
          if (trigger) await runFor(userId, trigger);
        } catch (error) {
          ctx.log.warn("scheduled storage sense failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        }
        await new Promise<void>((r) => setImmediate(r));
      }
    });
  },
});
