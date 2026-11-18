import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { assertCanDelete, defaultBranch, deleteWorktree, inspectWorktree, parseWorktrees, type RunGit } from "../worktreeDelete.js";
import { safeRelative } from "../shard.js";
import { decideBranch, decideFs, decideWorktree, isFloqBranch, isManagedWorktreePath, trimEntries, type BranchCandidate, type Decision, type ReportEntry, type StorageSenseConfig, type StorageSenseReport, type WorktreeCandidate } from "./plan.js";
import { removeFsEntry, scanFs } from "./scan.js";

export interface SessionRow { id: string; workspaceId: string | null; state: string; lastActiveMs: number }
export interface WorkspaceRow { id: string; projectId: string; cwd: string; projectCwd: string; isWorktree: boolean; available: boolean; createdMs: number }

/** What the cleanup needs from the runtime. Implemented by the session manager; faked in tests. */
export interface StorageSenseHost {
  awakeUserIds(): string[];
  /** Host path of the user's mounted home while the shard is awake; null when asleep (sleeping shards are never woken for cleanup). */
  homeOf(userId: string): string | null;
  sessions(userId: string): Promise<SessionRow[]>;
  workspaces(userId: string): Promise<WorkspaceRow[]>;
  /** Runs git in the user's sandbox with `cwd` relative to the home (the same runner the worktree delete uses). */
  git(userId: string, cwd: string, args: string[]): ReturnType<RunGit>;
  /** Keeps the shard from locking and serializes branch work for a project while `fn` runs. */
  withProject<T>(userId: string, projectId: string, fn: () => Promise<T>): Promise<T>;
  withActivity<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  markWorkspaceUnavailable(userId: string, projectId: string, workspaceId: string): Promise<void>;
  freePercent(userId: string): Promise<number | null>;
}

export interface RunOptions { dryRun: boolean; trigger: StorageSenseReport["trigger"]; budgetMs?: number; now?: number }

const LIVE = new Set(["running", "starting", "sleeping"]);
const DEFAULT_BUDGET_MS = 90_000;

/** Count of commits on `tip` whose patch is not in `base` (git cherry '+'): a cherry-picked commit is '-', so it counts as merged. */
async function unmergedPatches(run: RunGit, cwd: string, base: string | null, tips: string[]): Promise<number | null> {
  if (!base) return null;
  let total = 0;
  for (const tip of tips) {
    const r = await run(cwd, ["cherry", `refs/heads/${base}`, tip]);
    if (r.exitCode !== 0) return null;
    total += r.stdout.split(/\r?\n/).filter((l) => l.startsWith("+ ")).length;
  }
  return total;
}

export class StorageSense {
  private readonly running = new Set<string>();
  constructor(private readonly host: StorageSenseHost) {}

  /** One cleanup pass for one user. Never throws for a single bad item; concurrent runs for a user are refused. */
  async run(userId: string, config: StorageSenseConfig, options: RunOptions): Promise<StorageSenseReport | null> {
    if (this.running.has(userId)) return null;
    const home = this.host.homeOf(userId);
    if (!home) return null;
    this.running.add(userId);
    const started = Date.now();
    const now = options.now ?? started;
    const deadline = started + (options.budgetMs ?? DEFAULT_BUDGET_MS);
    try {
      return await this.host.withActivity(userId, async () => {
        const entries: ReportEntry[] = [];
        let freed = 0;
        let partial = false;
        const record = (d: Decision, outcome: "removed" | "failed" | null, extra?: string): void => {
          const action = outcome ?? (d.action === "remove" ? (options.dryRun ? "would-remove" : "failed") : "kept");
          entries.push({ category: d.category, label: d.label, action, reason: outcome === "failed" ? "error" : d.reason, detail: extra ?? d.detail, bytes: d.bytes, attention: d.attention || undefined });
          if (outcome === "removed" && d.bytes) freed += d.bytes;
        };
        const timeUp = () => { if (Date.now() > deadline) { partial = true; return true; } return false; };
        const [sessions, workspaces] = await Promise.all([this.host.sessions(userId), this.host.workspaces(userId)]);
        const freeBefore = await this.host.freePercent(userId).catch(() => null);

        await this.worktrees(userId, home, config, options, sessions, workspaces, now, record, timeUp);
        await this.branches(userId, config, options, sessions, workspaces, now, record, timeUp);
        await this.files(userId, home, config, options, sessions, now, deadline, record, timeUp);

        const counts = { removed: 0, kept: 0, failed: 0, attention: 0 };
        for (const e of entries) {
          if (e.action === "removed" || e.action === "would-remove") counts.removed++;
          else if (e.action === "failed") counts.failed++;
          else counts.kept++;
          if (e.attention) counts.attention++;
        }
        return { at: new Date(started).toISOString(), dryRun: options.dryRun, trigger: options.trigger, durationMs: Date.now() - started, partial, freedBytes: freed, freePercentBefore: freeBefore, counts, entries: trimEntries(entries) };
      });
    } finally { this.running.delete(userId); }
  }

  private async worktrees(userId: string, home: string, config: StorageSenseConfig, options: RunOptions, sessions: SessionRow[], workspaces: WorkspaceRow[], now: number, record: (d: Decision, o: "removed" | "failed" | null, extra?: string) => void, timeUp: () => boolean): Promise<void> {
    if (!(config.worktreeDays > 0)) return;
    const run: RunGit = (cwd, args) => this.host.git(userId, cwd, args);
    for (const w of workspaces) {
      if (timeUp()) return;
      if (!w.isWorktree || !w.available) continue;
      let cwd: string, projectCwd: string;
      try { cwd = safeRelative(w.cwd); projectCwd = safeRelative(w.projectCwd); } catch { continue; }
      if (!isManagedWorktreePath(cwd)) continue;
      try {
        const facts = await this.worktreeFacts(userId, home, w, cwd, projectCwd, sessions, run);
        const decision = decideWorktree(facts, config, now);
        if (decision.action === "keep" || options.dryRun) { record(decision, null); continue; }
        // Remove: under the project lock, from fresh facts, with the same refusal rules as the user's own delete.
        const outcome = await this.host.withProject<{ kept: Decision } | { removed: Awaited<ReturnType<typeof deleteWorktree>> }>(userId, w.projectId, async () => {
          const fresh = await this.host.sessions(userId);
          const again = decideWorktree(await this.worktreeFacts(userId, home, w, cwd, projectCwd, fresh, run), config, now);
          if (again.action !== "remove") return { kept: again };
          const context = { home, projectCwd, cwd, run };
          const inspection = await inspectWorktree(context);
          assertCanDelete(inspection, false);
          const result = await deleteWorktree(context, inspection, false);
          await this.host.markWorkspaceUnavailable(userId, w.projectId, w.id);
          return { removed: result };
        });
        if ("kept" in outcome) record(outcome.kept, null);
        else record(decision, "removed", decision.detail + (outcome.removed.branchNote ? ` (${outcome.removed.branchNote})` : ""));
      } catch (error) {
        record(decideWorktree({ category: "worktree", workspaceId: w.id, projectId: w.projectId, path: cwd, activeSessions: 0, lastActivityMs: now, git: null }, config, now), "failed", `Could not remove: ${msg(error)}`);
      }
    }
  }

  private async worktreeFacts(userId: string, home: string, w: WorkspaceRow, cwd: string, projectCwd: string, sessions: SessionRow[], run: RunGit): Promise<WorktreeCandidate> {
    const mine = sessions.filter((s) => s.workspaceId === w.id);
    const dir = join(home, cwd);
    let dirMtime = 0;
    try { dirMtime = (await lstat(dir)).mtimeMs; } catch { /* missing: handled by inspect */ }
    const base: Omit<WorktreeCandidate, "git"> = {
      category: "worktree", workspaceId: w.id, projectId: w.projectId, path: cwd,
      activeSessions: mine.filter((s) => LIVE.has(s.state)).length,
      lastActivityMs: Math.max(w.createdMs, dirMtime, ...mine.map((s) => s.lastActiveMs)),
    };
    if (base.activeSessions > 0) return { ...base, git: null };
    try {
      const inspection = await inspectWorktree({ home, projectCwd, cwd, run });
      const tips: string[] = [];
      if (!inspection.missing) {
        const head = await run(cwd, ["rev-parse", "--verify", "HEAD"]);
        if (head.exitCode === 0) tips.push(head.stdout.trim());
      }
      if (inspection.floqBranch) tips.push(`refs/heads/${inspection.floqBranch}`);
      const patches = tips.length ? await unmergedPatches(run, projectCwd, inspection.baseBranch, tips) : inspection.baseBranch ? 0 : null;
      return { ...base, git: { uncommittedFiles: inspection.uncommittedFiles, unmergedPatches: patches, missing: inspection.missing } };
    } catch { return { ...base, git: null }; }
  }

  private async branches(userId: string, config: StorageSenseConfig, options: RunOptions, sessions: SessionRow[], workspaces: WorkspaceRow[], now: number, record: (d: Decision, o: "removed" | "failed" | null, extra?: string) => void, timeUp: () => boolean): Promise<void> {
    if (!(config.branchDays > 0)) return;
    const run: RunGit = (cwd, args) => this.host.git(userId, cwd, args);
    const known = new Set(sessions.map((s) => s.id.toLowerCase()));
    const projects = new Map<string, string>();
    for (const w of workspaces) { try { projects.set(w.projectId, safeRelative(w.projectCwd)); } catch { /* skip */ } }
    for (const [projectId, projectCwd] of projects) {
      if (timeUp()) return;
      try {
        const listed = await run(projectCwd, ["for-each-ref", "--format=%(objectname) %(committerdate:unix) %(refname:short)", "refs/heads/floq/"]);
        if (listed.exitCode !== 0) continue;
        const { base } = await defaultBranch(run, projectCwd);
        for (const line of listed.stdout.split(/\r?\n/)) {
          if (timeUp()) return;
          const m = /^([0-9a-f]{40,64}) (\d+) (floq\/.+)$/.exec(line.trim());
          if (!m || !isFloqBranch(m[3])) continue;
          const [, sha, ts, branch] = m;
          const checkedOut = async () => parseWorktrees((await run(projectCwd, ["worktree", "list", "--porcelain"])).stdout).some((e) => e.branch === branch);
          const facts: BranchCandidate = {
            category: "branch", projectId, branch, agentId: branch.slice(5), sessionExists: known.has(branch.slice(5).toLowerCase()),
            checkedOutSomewhere: await checkedOut(), lastCommitMs: Number(ts) * 1000,
            unmergedPatches: await unmergedPatches(run, projectCwd, base, [sha]),
          };
          const decision = decideBranch(facts, config, now);
          if (decision.action === "keep" || options.dryRun) { record(decision, null); continue; }
          try {
            const outcome = await this.host.withProject(userId, projectId, async () => {
              // Compare-and-delete: update-ref only removes the ref while it still points at the commit we verified.
              if (await checkedOut()) return false;
              const del = await run(projectCwd, ["update-ref", "-d", `refs/heads/${branch}`, sha]);
              return del.exitCode === 0;
            });
            if (outcome) record(decision, "removed"); else record(decision, "failed", "Branch changed while cleaning; kept");
          } catch (error) { record(decision, "failed", `Could not delete: ${msg(error)}`); }
        }
      } catch { /* project not reachable: skip */ }
    }
  }

  private async files(userId: string, home: string, config: StorageSenseConfig, options: RunOptions, sessions: SessionRow[], now: number, deadline: number, record: (d: Decision, o: "removed" | "failed" | null, extra?: string) => void, timeUp: () => boolean): Promise<void> {
    const sessionMap = new Map(sessions.map((s) => [s.id.toLowerCase(), { live: LIVE.has(s.state), lastActiveMs: s.lastActiveMs }]));
    const candidates = await scanFs({ home, sessions: sessionMap, deadline, attachmentsEnabled: config.attachmentDays > 0, tmpEnabled: config.tmpDays > 0, scratchpadsEnabled: config.scratchpadDays > 0 });
    for (const c of candidates) {
      if (timeUp()) return;
      const decision = decideFs(c, config, now);
      if (decision.action === "keep" || options.dryRun) { record(decision, null); continue; }
      try {
        // Re-inspect right before deleting: a file touched since the scan postpones the removal to the next run.
        const [fresh] = (await scanOne(home, c, sessionMap, deadline));
        if (!fresh || decideFs(fresh, config, options.now ?? Date.now()).action !== "remove") { record(fresh ? decideFs(fresh, config, options.now ?? Date.now()) : decision, null); continue; }
        removeFsEntry(home, c.path);
        record(decision, "removed");
      } catch (error) { record(decision, "failed", `Could not remove: ${msg(error)}`); }
    }
  }
}

async function scanOne(home: string, c: { category: string; path: string }, sessions: Map<string, { live: boolean; lastActiveMs: number }>, deadline: number) {
  const all = await scanFs({ home, sessions, deadline, attachmentsEnabled: c.category === "attachment", tmpEnabled: c.category === "tmp", scratchpadsEnabled: c.category === "scratchpad" });
  return all.filter((x) => x.path === c.path);
}

function msg(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200); }
