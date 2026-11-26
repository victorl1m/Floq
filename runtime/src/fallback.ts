import type pg from "pg";
import { badRequest } from "./errors.js";
import { log } from "./logger.js";
import { claudeLimitEvent, type ClaudeLimitEvent } from "./turn.js";
import { claudeBackNotice, codexHandoffPrompt, codexResumeNotice } from "./handoff.js";
import type { UsageWindow } from "./usage.js";
import { appendTail, classifyBanner, NEAR_FULL_PERCENT, type LimitKind } from "./limitText.js";

/** Claude usage-limit fallback (docs/design/claude-swap-fallback.md). Steps: lower model, other account, Codex. */

export type FallbackStepKind = "model" | "account" | "codex";
export const FALLBACK_STEP_KINDS: readonly FallbackStepKind[] = ["model", "account", "codex"];
export const DEFAULT_LADDER = ["fable", "opus", "sonnet", "haiku"] as const;

export type FallbackStep =
  | { kind: "model"; enabled: boolean; ladder: string[] }
  | { kind: "account"; enabled: boolean; slots: string[] }
  | { kind: "codex"; enabled: boolean; model: string };

export interface UsageFallback {
  enabled: boolean;
  steps: FallbackStep[];
  swapBack: boolean;
}

export function defaultUsageFallback(): UsageFallback {
  return {
    enabled: true,
    steps: [
      { kind: "model", enabled: true, ladder: [...DEFAULT_LADDER] },
      { kind: "account", enabled: true, slots: [] },
      { kind: "codex", enabled: false, model: "auto" },
    ],
    swapBack: true,
  };
}

const MODEL_ID = /^[\w.\-[\]]{1,64}$/;

/** Strict validation of a settings patch. Each kind exactly once; unknown kinds or ladder ids are rejected. */
export function parseUsageFallback(raw: unknown): UsageFallback {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw badRequest("usageFallback must be an object");
  const input = raw as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw badRequest("usageFallback.enabled must be boolean");
  if (typeof input.swapBack !== "boolean") throw badRequest("usageFallback.swapBack must be boolean");
  if (!Array.isArray(input.steps) || input.steps.length !== FALLBACK_STEP_KINDS.length) throw badRequest("usageFallback.steps must list every step once");
  const seen = new Set<string>();
  const steps: FallbackStep[] = [];
  for (const item of input.steps) {
    if (typeof item !== "object" || item === null) throw badRequest("usageFallback step is invalid");
    const step = item as Record<string, unknown>;
    const kind = step.kind;
    if (kind !== "model" && kind !== "account" && kind !== "codex") throw badRequest("usageFallback step kind is unknown");
    if (seen.has(kind)) throw badRequest("usageFallback step kinds must be unique");
    seen.add(kind);
    if (typeof step.enabled !== "boolean") throw badRequest("usageFallback step enabled must be boolean");
    if (kind === "model") {
      const ladder = step.ladder;
      if (!Array.isArray(ladder) || ladder.length < 1 || ladder.length > 8 || ladder.some((id) => typeof id !== "string" || !MODEL_ID.test(id)) || new Set(ladder).size !== ladder.length) {
        throw badRequest("usageFallback model ladder is invalid");
      }
      steps.push({ kind, enabled: step.enabled, ladder: ladder as string[] });
    } else if (kind === "account") {
      const slots = step.slots;
      if (!Array.isArray(slots) || slots.length > 16 || slots.some((s) => typeof s !== "string" || !/^(primary|acct_[0-9a-f]{8})$/.test(s))) throw badRequest("usageFallback account slots are invalid");
      steps.push({ kind, enabled: step.enabled, slots: slots as string[] });
    } else {
      const model = step.model;
      if (typeof model !== "string" || (model !== "auto" && !MODEL_ID.test(model))) throw badRequest("usageFallback codex model is invalid");
      steps.push({ kind, enabled: step.enabled, model });
    }
  }
  return { enabled: input.enabled, steps, swapBack: input.swapBack };
}

/** Stored JSON to a usable value: anything invalid falls back to the defaults. */
export function readUsageFallback(stored: unknown): UsageFallback {
  if (stored === null || stored === undefined) return defaultUsageFallback();
  try { return parseUsageFallback(stored); } catch { return defaultUsageFallback(); }
}

/** Model family a rate-limit window is specific to, or null for account-wide windows (and anything unknown). */
export function limitFamily(rateLimitType: string): "opus" | "sonnet" | null {
  if (rateLimitType === "seven_day_opus") return "opus";
  if (rateLimitType === "seven_day_sonnet") return "sonnet";
  return null;
}

/** Display name of a model id for user-facing text: known families capitalised (sonnet is Sonnet), anything else as configured. */
export function modelLabel(model: string | null): string {
  const family = modelFamilyId(model);
  if (family) return family.charAt(0).toUpperCase() + family.slice(1);
  return model ?? "the default model";
}

/** "opusplan" counts as opus; ids carrying a version or [1m] suffix still map to their family name. */
export function modelFamilyId(model: string | null): string | null {
  if (!model) return null;
  const id = model.toLowerCase();
  if (id === "opusplan") return "opus";
  for (const name of DEFAULT_LADDER) if (id === name || id.startsWith(name + "-") || id.startsWith(name + "[") || id.includes("-" + name + "-") || id.endsWith("-" + name)) return name;
  return null;
}

/** The next lower ladder model that is not in the blocked family, or null. A model outside the ladder is not eligible. */
export function lowerModel(ladder: string[], current: string | null, blocked: "opus" | "sonnet" | null): string | null {
  if (!blocked) return null; // account-wide windows block every model: downgrading cannot help (design section 0.1)
  // No chosen model means the CLI default, which is the blocked family when a model window is exhausted; an unknown id is left alone.
  // Ladder entries may be full model ids (claude-sonnet-4-5): compare by family, return the entry as configured.
  const fam = (id: string) => modelFamilyId(id) ?? id;
  const effective = current ? modelFamilyId(current) : blocked;
  const at = ladder.findIndex((id) => fam(id) === effective);
  // Already below the blocked family (e.g. Sonnet while Opus is blocked): a lower model changes nothing.
  if (at < 0 || at > ladder.findIndex((id) => fam(id) === blocked)) return null;
  for (let i = at + 1; i < ladder.length; i++) if (fam(ladder[i]!) !== blocked) return ladder[i]!;
  return null;
}

export interface FallbackState {
  origin: { provider: "claude"; model: string | null; slot?: string };
  current: { kind: "model" | "account" | "codex" | "paused"; model?: string; slot?: string; label?: string };
  scope: { window: string; family: "opus" | "sonnet" | null; /** Claude slot that was active when the block hit (its usage decides the reset). */ slot?: string };
  /** Why the agent is paused (badge wording). */
  parkReason?: "no_step" | "pause_override" | "fallback_loop" | "steps_unavailable";
  resetsAt: string | null;
  since: string;
  swaps: string[];
  ineffective: string[];
  lastEventUuid?: string;
  /** Claude slots found blocked during this fallback (until their reset), skipped while walking the account chain. */
  tried?: Array<{ slot: string; until: string }>;
  /** The model this service set (model step); lets a later park still restore the origin model. */
  lowered?: string;
  /** Sandbox paths of the handoff files written for this fallback (the Codex step). */
  handoffs?: string[];
  keep?: boolean;
}

/** User-level record that the active Claude account was switched away from `slot`, to be restored at the reset. */
export interface AccountReturn { slot: string; window: string; resetsAt: string | null }

export type FallbackOverride = "default" | "model" | "pause";

export type Plan =
  | { action: "model"; model: string }
  | { action: "account"; slot: string }
  | { action: "codex"; model: string }
  | { action: "park"; reason: "no_step" | "pause_override" | "fallback_loop" };

export const MAX_SWAPS_PER_HOUR = 4;

export interface PlanInput {
  settings: UsageFallback;
  override: FallbackOverride;
  event: Pick<ClaudeLimitEvent, "rateLimitType">;
  model: string | null;
  state: FallbackState | null;
  now: number;
  /** Reserve Claude slots that can take over right now (connected, window below 100 %), in the user's order. Resolved by the caller. */
  accounts?: string[];
  /** Codex model to continue on when Codex is connected and below its limits; null when unavailable. */
  codex?: string | null;
}

/** Decide what to do with a confirmed limit block. Pure: the caller applies the result. */
export function planFallback(input: PlanInput): Plan {
  const { settings, override, event, state, now } = input;
  if (override === "pause") return { action: "park", reason: "pause_override" };
  const recent = (state?.swaps ?? []).filter((at) => now - Date.parse(at) < 3_600_000).length;
  if (recent >= MAX_SWAPS_PER_HOUR) return { action: "park", reason: "fallback_loop" };
  const family = limitFamily(event.rateLimitType);
  for (const step of settings.steps) {
    if (!step.enabled) continue;
    if (override === "model" && step.kind !== "model") continue; // per-agent "Model only"
    if (step.kind === "account") {
      const slot = input.accounts?.[0];
      if (slot) return { action: "account", slot };
    }
    if (step.kind === "codex") {
      if (state?.ineffective.includes("codex@" + event.rateLimitType)) continue;
      if (input.codex) return { action: "codex", model: input.codex };
    }
    if (step.kind === "model") {
      if (state?.ineffective.includes("model@" + event.rateLimitType)) continue;
      const next = lowerModel(step.ladder, state?.current.kind === "model" ? state.current.model ?? input.model : input.model, family);
      if (next) return { action: "model", model: next };
    }
  }
  return { action: "park", reason: "no_step" };
}

const TAIL_DEBOUNCE_MS = 2_000;
const QUIET_BEFORE_SWAP_MS = 2_500;
const RESET_GRACE_MS = 90_000;
const RESET_JITTER_MS = 30_000;
const RETRY_STILL_BLOCKED_MS = [5 * 60_000, 15 * 60_000];
const IDLE_POLL_MS = 30_000;
const IDLE_QUIET_MS = 20_000;
const IDLE_GIVE_UP_MS = 24 * 3_600_000;
const UNKNOWN_RETRY_MS = 5 * 60_000;
/** Before the reset time, look at the real usage this often: a limit cleared early (usage reset, plan change, extra usage) resumes agents within minutes, not at the reported reset. */
const EARLY_CHECK_MS = 3 * 60_000;
const ACCOUNT_RECHECK_MS = 30 * 60_000;

/** What the service needs from the session manager (kept narrow so tests can fake it). */
export interface FallbackHost {
  /** Tail text of the live Claude agent's transcript, or null. */
  readTranscript(id: string, userId: string): string | null;
  isLive(id: string, userId: string): boolean;
  /** ms since the terminal last produced output (Infinity when not live). */
  quietMs(id: string): number;
  /** True when the agent's turn is idle (no open turn). */
  isIdle(id: string, userId: string): boolean;
  /** Queue a trusted notice typed after the next launch is ready. */
  queueNotice(id: string, text: string): void;
  /** Drop a queued notice (the launch it was meant for failed). */
  dropNotice(id: string): void;
  /** Cheap change marker of the agent's transcript (mtime:size), or null. Lets evaluate() skip unchanged transcripts. */
  transcriptStamp(id: string, userId: string): string | null;
  /** Strict sleep and resume (the conversation is kept). */
  restart(userId: string, id: string): Promise<void>;
  sleep(id: string, reason: string): Promise<void>;
  resume(userId: string, id: string): Promise<void>;
  /** Tell the agent's parent (a typed notice, short). Fire and forget: never blocks or fails a swap. */
  notifyParent(userId: string, parentId: string, text: string): Promise<void>;
  /** Write the deterministic handoff file (0600, user's uid) and return its sandbox path. n numbers the file per agent. */
  buildHandoff(input: { userId: string; id: string; direction: "to-codex" | "to-claude"; n: number; reason: { window: string; resetsAt: string | null } | null; previousHandoff: string | null }): Promise<string>;
  /** Move the agent to another provider in place (same row/UUID). Throws when the switch failed. */
  switchProvider(userId: string, id: string, to: { provider: "claude" | "codex"; model: string | null; prompt?: string; notice?: string }): Promise<void>;
}

/** The Codex port: connected + below its limits, and which model to use for "auto". */
export interface FallbackCodex {
  usable(userId: string): Promise<boolean>;
  defaultModel(userId: string): Promise<string | null>;
}

/** The multi-account port (ClaudeAccounts in production, a fake in tests). */
export interface FallbackAccounts {
  activeSlot(userId: string): Promise<string>;
  /** When the active slot became active (ms epoch), or null when it never changed. */
  activeSince(userId: string): Promise<number | null>;
  reserveSlots(userId: string, order: string[]): Promise<Array<{ slot: string; label: string }>>;
  list(userId: string): Promise<Array<{ slot: string; label: string }>>;
  usageOf(userId: string, slot: string): Promise<UsageWindow[] | null>;
  switchTo(userId: string, slot: string): Promise<{ from: string; to: string; changed: boolean }>;
}

/**
 * A reserve account can take over unless its usage shows the blocked window or an account-wide window full.
 * Unknown usage (the usage endpoint rate-limits often) means "try it": a reserve that turns out blocked too reports its own
 * limit, gets marked tried and the chain moves on. Skipping it instead left agents parked while a free account sat idle.
 */
export function accountUsable(windows: UsageWindow[] | null, rateLimitType: string, kind: LimitKind = "window"): boolean {
  if (!windows) return true;
  // 98 % and up is exhausted in practice (the CLI blocks at 99-100 %): taking over there would just block again.
  if (windows.some((w) => w.usedPercent >= NEAR_FULL_PERCENT && (w.id === rateLimitType || w.id === "five_hour" || w.id === "seven_day"))) return false;
  // An exhausted extra-usage / spend cap blocks an account whose plan windows still have room.
  return !windows.some((w) => w.id === "extra_usage" && w.usedPercent >= 100 && kind !== "window");
}

/**
 * A limit banner seen in the terminal can be old text: when a paused agent wakes, Claude Code redraws the conversation, including
 * an earlier "You've hit your limit · resets 3:50pm" line, whose time then parses as tomorrow. Acting on it paused agents (or moved
 * them to another account) with the limit not reached. A terminal banner counts only when the account's usage confirms it
 * (readable and full for that window), or, with usage unknown, when its reset fits the window (a 5-hour limit resets within 5 hours).
 */
export function terminalBannerStale(windows: UsageWindow[] | null, rateLimitType: string, kind: LimitKind, resetsAt: string | number | null | undefined, now: number): boolean {
  if (windows && windows.length) {
    const full = windows.some((w) => w.usedPercent >= NEAR_FULL_PERCENT && (w.id === rateLimitType || w.id === "five_hour" || w.id === "seven_day"))
      || (kind !== "window" && windows.some((w) => w.id === "extra_usage" && w.usedPercent >= 100));
    return !full;
  }
  const at = typeof resetsAt === "number" ? resetsAt * (resetsAt < 1e12 ? 1000 : 1) : typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
  if (rateLimitType === "five_hour" && Number.isFinite(at) && at - now > 5.5 * 3_600_000) return true;
  return false;
}

/** Reserve slots that can take over: usable usage and not already found blocked in this fallback. Pure part of the chain walk. */
export function walkableSlots(candidates: Array<{ slot: string; windows: UsageWindow[] | null }>, rateLimitType: string, kind: LimitKind, tried: Array<{ slot: string; until: string }>, now: number): string[] {
  const blocked = new Set(tried.filter((t) => Date.parse(t.until) > now).map((t) => t.slot));
  return candidates.filter((c) => !blocked.has(c.slot) && accountUsable(c.windows, rateLimitType, kind)).map((c) => c.slot);
}

/** Add the slot that just got blocked (until its reset, or one hour when unknown); expired entries are dropped. */
export function markTried(tried: Array<{ slot: string; until: string }> | undefined, slot: string | null, resetsAt: string | null, now: number): Array<{ slot: string; until: string }> {
  const live = (tried ?? []).filter((t) => Date.parse(t.until) > now && t.slot !== slot);
  if (!slot) return live;
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  return [...live, { slot, until: new Date(Number.isFinite(reset) && reset > now ? reset : now + 3_600_000).toISOString() }];
}

export interface FallbackUsage {
  /** Percent used of a Claude window right now (cached ok), or null when unknown. */
  claudeWindow(userId: string, windowId: string): Promise<{ usedPercent: number; resetsAt: string | null } | null>;
  /** The window that blocks the ACTIVE Claude account right now (full, reset in the future, latest reset wins), from cached usage; null when none or unknown. */
  claudeBlocked(userId: string): Promise<{ window: string; resetsAt: string } | null>;
}

interface AgentRow {
  id: string;
  user_id: string;
  provider: string;
  model: string | null;
  state: string;
  title: string;
  fallback_state: FallbackState | null;
  fallback_override: { mode?: FallbackOverride } | null;
  parent_session_id: string | null;
  fallback_last_event: string | null;
  provider_session_id: string | null;
}

const COLUMNS = "id, user_id, provider, model, state, title, fallback_state, fallback_override, fallback_last_event, provider_session_id, parent_session_id";

export interface FallbackServiceOptions {
  now?: () => number;
  random?: () => number;
}

export class FallbackService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly evaluating = new Map<string, Promise<void>>();
  private readonly restoring = new Map<string, Promise<void>>();
  private readonly screen = new Map<string, string>();
  private readonly ttyEvents = new Map<string, { rateLimitType: string; kind: LimitKind; resetsAt: string | null; text: string }>();
  private stopped = false;
  private readonly now: () => number;
  private readonly random: () => number;
  usage?: FallbackUsage;
  accounts?: FallbackAccounts;
  codex?: FallbackCodex;
  private readonly accountTimers = new Map<string, NodeJS.Timeout>();
  /** One parent notice per agent per blocked window (resets when the window changes). */
  private readonly parentNotified = new Map<string, string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly host: FallbackHost,
    private readonly loadSettings: (userId: string) => Promise<UsageFallback>,
    options: FallbackServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Rebuild reset timers from the database (called once at boot). */
  async start(): Promise<void> {
    const found = await this.pool.query(`SELECT ${COLUMNS} FROM agent_sessions WHERE fallback_state IS NOT NULL`);
    for (const row of found.rows as AgentRow[]) if (row.fallback_state && !row.fallback_state.keep && row.fallback_state.current.kind !== "account") this.schedule(row.id, row.user_id, row.fallback_state.resetsAt);
    const returns = await this.pool.query("SELECT user_id, claude_account_return FROM user_settings WHERE claude_account_return IS NOT NULL");
    for (const r of returns.rows as Array<{ user_id: string; claude_account_return: AccountReturn }>) this.scheduleAccountReturn(r.user_id, r.claude_account_return.resetsAt);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of [...this.timers.values(), ...this.debounce.values(), ...this.accountTimers.values()]) clearTimeout(timer);
    this.accountTimers.clear();
    this.timers.clear();
    this.debounce.clear();
  }

  /** Called for every PTY output frame of a Claude agent; debounced, reads the transcript tail only after a pause. */
  onOutput(id: string, userId: string, data?: string): void {
    if (this.stopped) return;
    // Terminal banner ("Usage limit reached · continuing automatically at ..."): the CLI may write no transcript record while it waits.
    if (data) {
      const tail = appendTail(this.screen.get(id) ?? "", data);
      this.screen.set(id, tail);
      const hit = classifyBanner(tail, this.now());
      if (hit && !this.ttyEvents.has(id)) this.ttyEvents.set(id, { rateLimitType: hit.rateLimitType, kind: hit.kind, resetsAt: hit.resetsAt, text: tail.slice(-300) });
    }
    if (this.debounce.has(id)) return;
    const timer = setTimeout(() => {
      this.debounce.delete(id);
      void this.evaluate(id, userId).catch((error) => log.warn("fallback.evaluate_failed", { sessionId: id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }));
    }, TAIL_DEBOUNCE_MS);
    timer.unref();
    this.debounce.set(id, timer);
  }

  evaluate(id: string, userId: string): Promise<void> {
    const running = this.evaluating.get(id);
    if (running) return running;
    const task = this.evaluateOnce(id, userId).finally(() => this.evaluating.delete(id));
    this.evaluating.set(id, task);
    return task;
  }

  private async load(id: string, userId: string): Promise<AgentRow | null> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM agent_sessions WHERE id = $1 AND user_id = $2`, [id, userId]);
    return (result.rows[0] as AgentRow | undefined) ?? null;
  }

  /** transcript stamp seen at the last evaluation that found nothing to do (skips the DB read when nothing changed). */
  private readonly seenStamp = new Map<string, string>();
  private readonly forceNow = new Set<string>();
  private readonly wakers = new Map<string, () => void>();

  private async evaluateOnce(id: string, userId: string): Promise<void> {
    // Cheap pre-check: a stat of the transcript. No change since the last "nothing to do" means no DB read and no tail read.
    const stamp = this.host.transcriptStamp(id, userId);
    if (stamp !== null && this.seenStamp.get(id) === stamp) return;
    const row = await this.load(id, userId);
    if (!row || row.provider !== "claude" || !this.host.isLive(id, userId)) return;
    const text = this.host.readTranscript(id, userId);
    let event: ClaudeLimitEvent | null = text ? claudeLimitEvent(text) : null;
    const tty = this.ttyEvents.get(id);
    this.ttyEvents.delete(id);
    if (!event && tty) {
      const slot = this.accounts ? await this.accounts.activeSlot(userId) : "primary";
      const when = this.now();
      const windows = this.accounts ? await this.accounts.usageOf(userId, slot).catch(() => null) : null;
      if (terminalBannerStale(windows, tty.rateLimitType, tty.kind ?? "window", tty.resetsAt, when)) {
        log.info("fallback.banner_ignored", { sessionId: id, rateLimitType: tty.rateLimitType, usageKnown: Boolean(windows && windows.length) });
        this.screen.delete(id); // the redrawn text must not match again on the next output frame
      } else {
        event = { uuid: `tty:${slot}:${tty.rateLimitType}:${tty.resetsAt ?? Math.floor(when / 3_600_000)}`, rateLimitType: tty.rateLimitType, resetsAt: tty.resetsAt, timestamp: new Date(when).toISOString(), text: tty.text, latest: true, kind: tty.kind, source: "terminal" };
      }
    }
    const done = () => { if (stamp !== null && event?.source !== "terminal") this.seenStamp.set(id, stamp); };
    if (!event || event.uuid === row.fallback_state?.lastEventUuid || event.uuid === row.fallback_last_event) return done();
    const now = this.now();
    const resets = event.resetsAt ? Date.parse(event.resetsAt) : NaN;
    // A structured block with a reset time in the past is stale (an old record in the tail): nothing to do.
    if (Number.isFinite(resets) && resets <= now) return done();
    // The CLI has ended its turn when the terminal goes quiet; never cut a running tool short.
    // A terminal banner is the CLI waiting by itself (its countdown redraws, so the terminal is never quiet): no wait then.
    if (event.source !== "terminal" && this.host.quietMs(id) < QUIET_BEFORE_SWAP_MS) {
      this.onOutput(id, userId);
      return;
    }
    const settings = await this.loadSettings(userId);
    if (!settings.enabled) return done();

    const state = row.fallback_state;
    const override = row.fallback_override?.mode ?? "default";
    const family = limitFamily(event.rateLimitType);
    const ineffective = new Set(state?.ineffective ?? []);
    // The very same window blocked again right after a model step: that step does not help for this window.
    if (state?.current.kind === "model" && state.scope.window === event.rateLimitType && state.swaps.length > 0 && now - Date.parse(state.swaps[state.swaps.length - 1]!) < 10 * 60_000) {
      ineffective.add("model@" + event.rateLimitType);
    }
    // Account steps are walked slot by slot (tried), not switched off: only Codex is marked ineffective as a whole.
    if (state?.current.kind === "codex" && state.scope.window === event.rateLimitType && state.swaps.length > 0 && now - Date.parse(state.swaps[state.swaps.length - 1]!) < 10 * 60_000) {
      ineffective.add(state.current.kind + "@" + event.rateLimitType);
    }
    const activeNow = this.accounts ? await this.accounts.activeSlot(userId) : null;
    const base: FallbackState = {
      origin: state?.origin ?? { provider: "claude", model: row.model },
      tried: markTried(state?.tried, activeNow, event.resetsAt, now),
      current: state?.current ?? { kind: "paused" },
      scope: { window: event.rateLimitType, family, ...(this.accounts ? { slot: await this.accounts.activeSlot(userId) } : {}) },
      resetsAt: event.resetsAt,
      since: state?.since ?? new Date(now).toISOString(),
      swaps: (state?.swaps ?? []).filter((at) => now - Date.parse(at) < 3_600_000),
      ineffective: [...ineffective],
      lastEventUuid: event.uuid,
      ...(state?.lowered ? { lowered: state.lowered } : {}),
    };
    const accountStep = settings.steps.find((st) => st.kind === "account" && st.enabled);
    // An account switch made after this record was written already covers it: just restart this agent on the new login.
    const since = this.accounts ? await this.accounts.activeSince(userId) : null;
    if (this.accounts && since !== null && event.timestamp && Date.parse(event.timestamp) < since) {
      done();
      if (!accountStep || override !== "default") return;
      await this.applyAccount(row, userId, event, base, null, true);
      return;
    }
    let usable: string[] = [];
    // Whether the account step had any other account at all (on by default: with a single login it simply does not apply).
    let hadReserves = false;
    if (this.accounts && accountStep && accountStep.kind === "account" && override === "default") {
      const candidates: Array<{ slot: string; windows: UsageWindow[] | null }> = [];
      for (const reserve of await this.accounts.reserveSlots(userId, accountStep.slots)) candidates.push({ slot: reserve.slot, windows: await this.accounts.usageOf(userId, reserve.slot) });
      hadReserves = candidates.length > 0;
      usable = walkableSlots(candidates, event.rateLimitType, event.kind ?? "window", base.tried ?? [], now);
    }
    let codexModel: string | null = null;
    const codexStep = settings.steps.find((st) => st.kind === "codex" && st.enabled);
    if (this.codex && codexStep && codexStep.kind === "codex" && override === "default" && (await this.codex.usable(userId))) {
      codexModel = codexStep.model === "auto" ? await this.codex.defaultModel(userId) : codexStep.model;
    }
    const plan = planFallback({ settings, override, event, model: row.model, state: base, now, accounts: usable, codex: codexModel });
    done();
    this.screen.delete(id);
    if (plan.action === "account") {
      await this.applyAccount(row, userId, event, base, plan.slot, false);
      return;
    }
    if (plan.action === "codex") {
      await this.applyCodex(row, userId, event, base, plan.model);
      return;
    }

    if (plan.action === "model") {
      const next: FallbackState = { ...base, current: { kind: "model", model: plan.model }, lowered: plan.model, swaps: [...base.swaps, new Date(now).toISOString()] };
      await this.pool.query("UPDATE agent_sessions SET model = $3, fallback_state = $4, fallback_last_event = $5 WHERE id = $1 AND user_id = $2", [id, userId, plan.model, JSON.stringify(next), event.uuid]);
      this.host.queueNotice(id, `[Floq] ${windowName(event.rateLimitType)} limit reached${resetNote(event.resetsAt)}. You are now on ${modelLabel(plan.model)}. Continue the task you were working on.`);
      log.info("fallback.model", { sessionId: id, window: event.rateLimitType, to: plan.model });
      // The swap-back timer first: a restart that fails must not leave the swapped row without one.
      this.schedule(id, userId, event.resetsAt);
      this.tellParent(row, userId, event, `now on ${modelLabel(plan.model)} (was ${modelLabel(base.origin.model)}), switching back at the reset`);
      try {
        await this.host.restart(userId, id);
      } catch (error) {
        this.host.dropNotice(id);
        // The record is marked handled, so only the reset timer (already set) retries: say so in the log.
        log.warn("fallback.restart_failed", { sessionId: id, step: "model", error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        throw error;
      }
      return;
    }
    // "No step" while an account or Codex step IS enabled means they exist but had no room: word the badge accordingly.
    const stepsOn = override === "default" && settings.steps.some((st) => st.enabled && ((st.kind === "account" && hadReserves) || st.kind === "codex"));
    const parkReason = plan.reason === "no_step" && stepsOn ? "steps_unavailable" : plan.reason;
    const parked: FallbackState = { ...base, current: { kind: "paused" }, parkReason };
    await this.pool.query("UPDATE agent_sessions SET fallback_state = $3, fallback_last_event = $4 WHERE id = $1 AND user_id = $2", [id, userId, JSON.stringify(parked), event.uuid]);
    this.tellParent(row, userId, event, `paused until ${resetClock(event.resetsAt)}; it continues on its own`);
    log.info("fallback.park", { sessionId: id, window: event.rateLimitType, reason: plan.reason });
    this.schedule(id, userId, event.resetsAt);
    await this.host.sleep(id, plan.reason === "fallback_loop" ? "fallback-loop" : "usage-limit");
  }

  /** One short notice to the parent per agent and window, so an orchestrator is not left waiting silently. */
  private tellParent(row: AgentRow, userId: string, event: ClaudeLimitEvent, what: string): void {
    if (!row.parent_session_id) return;
    const key = event.rateLimitType + "@" + (event.resetsAt ?? "");
    if (this.parentNotified.get(row.id) === key) return;
    this.parentNotified.set(row.id, key);
    void this.host.notifyParent(userId, row.parent_session_id, `[Floq] Your subagent ${row.title} (${row.id}) hit a Claude usage limit: ${what}.`).catch(() => undefined);
  }

  /**
   * Codex step: a new conversation in the SAME agent (row, UUID, node, wires). The deterministic handoff file is the first
   * message; a later swap in the same agent resumes the earlier Codex conversation and delivers the handoff as a notice.
   */
  private async applyCodex(row: AgentRow, userId: string, event: ClaudeLimitEvent, base: FallbackState, model: string): Promise<void> {
    const now = this.now();
    const path = await this.host.buildHandoff({ userId, id: row.id, direction: "to-codex", n: (base.handoffs?.length ?? 0) + 1, reason: { window: event.rateLimitType, resetsAt: event.resetsAt }, previousHandoff: base.handoffs?.at(-1) ?? null });
    const next: FallbackState = { ...base, current: { kind: "codex", model }, handoffs: [...(base.handoffs ?? []), path], swaps: [...base.swaps, new Date(now).toISOString()] };
    await this.pool.query("UPDATE agent_sessions SET fallback_state = $3, fallback_last_event = $4 WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(next), event.uuid]);
    log.info("fallback.codex", { sessionId: row.id, window: event.rateLimitType, model });
    this.tellParent(row, userId, event, `continuing on Codex (a new conversation from a handoff file), returning to Claude at the reset`);
    this.schedule(row.id, userId, event.resetsAt);
    try {
      await this.host.switchProvider(userId, row.id, { provider: "codex", model, ...(row.provider_session_id ? { notice: codexResumeNotice(path) } : { prompt: codexHandoffPrompt(path) }) });
    } catch (error) {
      // The agent is still a Claude agent that cannot run: pause it until the reset (the timer is set) and never try Codex for this window again.
      log.warn("fallback.codex_switch_failed", { sessionId: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      const parked: FallbackState = { ...next, current: { kind: "paused" }, ineffective: [...new Set([...next.ineffective, "codex@" + event.rateLimitType])] };
      await this.pool.query("UPDATE agent_sessions SET fallback_state = $3 WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(parked)]).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Account step: switch the user's active Claude login (user-wide, idempotent) and restart this agent so it runs on it.
   * `alreadySwitched`: the login was switched after this block was written, so only this agent needs a restart.
   */
  private async applyAccount(row: AgentRow, userId: string, event: ClaudeLimitEvent, base: FallbackState, slot: string | null, alreadySwitched: boolean): Promise<void> {
    const accounts = this.accounts!;
    const now = this.now();
    const from = await accounts.activeSlot(userId);
    if (slot && !alreadySwitched) await accounts.switchTo(userId, slot);
    const active = slot ?? from;
    const labels = await accounts.list(userId);
    const labelOf = (s: string) => labels.find((a) => a.slot === s)?.label ?? "another account";
    const originSlot = base.origin.slot ?? (alreadySwitched ? undefined : from);
    const next: FallbackState = {
      ...base,
      origin: { ...base.origin, ...(originSlot ? { slot: originSlot } : {}) },
      current: { kind: "account", slot: active, label: labelOf(active) },
      swaps: [...base.swaps, new Date(now).toISOString()],
    };
    // A switch made by hand (or already reverted) has no way back, so nothing would ever clear a badge: only restart the agent then.
    const hasWayBack = !alreadySwitched || (await this.accountReturn(userId)) !== null;
    if (hasWayBack) await this.pool.query("UPDATE agent_sessions SET fallback_state = $3, fallback_last_event = $4 WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(next), event.uuid]);
    else await this.pool.query("UPDATE agent_sessions SET fallback_last_event = $3 WHERE id = $1 AND user_id = $2", [row.id, userId, event.uuid]);
    if (!alreadySwitched && originSlot) await this.recordAccountSwitch(userId, active, { slot: originSlot, window: event.rateLimitType, resetsAt: event.resetsAt });
    this.host.queueNotice(row.id, `[Floq] The Claude usage limit on ${labelOf(originSlot ?? from)} was reached${resetNote(event.resetsAt)}. You are now on ${labelOf(active)}. Continue the task you were working on.`);
    log.info("fallback.account", { sessionId: row.id, window: event.rateLimitType, to: active, switched: !alreadySwitched });
    if (!alreadySwitched) this.tellParent(row, userId, event, `now on your ${labelOf(active)} Claude account`);
    try {
      await this.host.restart(userId, row.id);
    } catch (error) {
      this.host.dropNotice(row.id);
      log.warn("fallback.restart_failed", { sessionId: row.id, step: "account", error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      throw error;
    }
  }

  /**
   * Remember the way back after an account switch. A chained switch (A to B to C) keeps the FIRST origin (A) and its window;
   * switching back to the recorded origin ends the fallback (record and timer removed).
   */
  private async recordAccountSwitch(userId: string, newActive: string, record: AccountReturn): Promise<void> {
    const existing = await this.accountReturn(userId);
    if (existing && existing.slot === newActive) {
      await this.pool.query("UPDATE user_settings SET claude_account_return = NULL WHERE user_id = $1", [userId]);
      const timer = this.accountTimers.get(userId);
      if (timer) { clearTimeout(timer); this.accountTimers.delete(userId); }
      await this.pool.query("UPDATE agent_sessions SET fallback_state = NULL WHERE user_id = $1 AND fallback_state->'current'->>'kind' = 'account'", [userId]);
      return;
    }
    if (existing) return; // keep the original slot, window and timer
    await this.pool.query("UPDATE user_settings SET claude_account_return = $2 WHERE user_id = $1", [userId, JSON.stringify(record)]);
    this.scheduleAccountReturn(userId, record.resetsAt);
  }

  /** The user changed or removed accounts by hand (activate, disconnect): the automatic way back and the account badges no longer apply. */
  async accountChangedByUser(userId: string): Promise<void> {
    const timer = this.accountTimers.get(userId);
    if (timer) { clearTimeout(timer); this.accountTimers.delete(userId); }
    await this.pool.query("UPDATE user_settings SET claude_account_return = NULL WHERE user_id = $1", [userId]);
    await this.pool.query("UPDATE agent_sessions SET fallback_state = NULL WHERE user_id = $1 AND fallback_state->'current'->>'kind' = 'account'", [userId]);
  }

  /** User-level swap-back timer for an account switch (one per user). */
  scheduleAccountReturn(userId: string, resetsAt: string | null): void {
    if (this.stopped) return;
    const old = this.accountTimers.get(userId);
    if (old) clearTimeout(old);
    const at = resetsAt ? Date.parse(resetsAt) : NaN;
    const delay = Number.isFinite(at) ? Math.max(1_000, at - this.now() + RESET_GRACE_MS + (this.random() * 2 - 1) * RESET_JITTER_MS) : 15 * 60_000;
    this.armAccount(userId, delay, 0);
  }

  private armAccount(userId: string, delay: number, attempt: number): void {
    const timer = setTimeout(() => {
      this.accountTimers.delete(userId);
      void this.onAccountReset(userId, attempt).catch((error) => {
        log.warn("fallback.account_restore_failed", { userId, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        this.armAccount(userId, 5 * 60_000, attempt + 1);
      });
    }, Math.min(delay, 2 ** 31 - 1));
    timer.unref();
    const old = this.accountTimers.get(userId);
    if (old) clearTimeout(old);
    this.accountTimers.set(userId, timer);
  }

  private async accountReturn(userId: string): Promise<AccountReturn | null> {
    const found = await this.pool.query("SELECT claude_account_return FROM user_settings WHERE user_id = $1", [userId]);
    return (found.rows[0]?.claude_account_return as AccountReturn | null | undefined) ?? null;
  }

  private async onAccountReset(userId: string, attempt: number): Promise<void> {
    const record = await this.accountReturn(userId);
    if (!record || !this.accounts) return;
    const windows = await this.accounts.usageOf(userId, record.slot).catch(() => null);
    const window = windows?.find((w) => w.id === record.window);
    if (window && window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > this.now())) {
      this.armAccount(userId, RETRY_STILL_BLOCKED_MS[attempt] ?? 30 * 60_000, attempt + 1);
      return;
    }
    if (!windows && attempt === 0) { this.armAccount(userId, UNKNOWN_RETRY_MS, 1); return; }
    await this.restoreAccount(userId, { force: false });
  }

  /** Put the original Claude login back (user-wide). Running agents are not restarted: they were not blocked. */
  async restoreAccount(userId: string, options: { force: boolean }): Promise<boolean> {
    const record = await this.accountReturn(userId);
    const timer = this.accountTimers.get(userId);
    if (timer) { clearTimeout(timer); this.accountTimers.delete(userId); }
    if (record && this.accounts) {
      if (!options.force) {
        const kept = await this.pool.query("SELECT 1 FROM agent_sessions WHERE user_id = $1 AND fallback_state->'current'->>'kind' = 'account' AND fallback_state->>'keep' = 'true' LIMIT 1", [userId]);
        if (!(await this.loadSettings(userId)).swapBack || kept.rows.length) {
          // Not now (swap-back off, or an agent chose Keep): look again later instead of leaving the record without a timer.
          this.armAccount(userId, ACCOUNT_RECHECK_MS, 1);
          return false;
        }
      }
      await this.accounts.switchTo(userId, record.slot);
      await this.pool.query("UPDATE user_settings SET claude_account_return = NULL WHERE user_id = $1", [userId]);
    }
    await this.pool.query("UPDATE agent_sessions SET fallback_state = NULL WHERE user_id = $1 AND fallback_state->'current'->>'kind' = 'account'", [userId]);
    return true;
  }

  /** Timer at resetsAt + 90 s +- 30 s jitter (one per agent). No reset time: re-check in 15 minutes. */
  schedule(id: string, userId: string, resetsAt: string | null): void {
    if (this.stopped) return;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const at = resetsAt ? Date.parse(resetsAt) : NaN;
    const jitter = (this.random() * 2 - 1) * RESET_JITTER_MS;
    const delay = Number.isFinite(at) ? Math.max(1_000, at - this.now() + RESET_GRACE_MS + jitter) : 15 * 60_000;
    this.arm(id, userId, Math.min(delay, EARLY_CHECK_MS), 0);
  }

  private arm(id: string, userId: string, delay: number, attempt: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.onReset(id, userId, attempt).catch((error) => {
        log.warn("fallback.restore_failed", { sessionId: id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        this.arm(id, userId, 5 * 60_000, attempt + 1); // never leave a swapped or parked agent without a timer
      });
    }, Math.min(delay, 2 ** 31 - 1));
    timer.unref();
    const old = this.timers.get(id);
    if (old) clearTimeout(old); // never two live timers for one agent (a failed restore re-arms)
    this.timers.set(id, timer);
  }

  private async onReset(id: string, userId: string, attempt: number): Promise<void> {
    const row = await this.load(id, userId);
    const state = row?.fallback_state;
    if (!row || !state || state.keep) return;
    // The account that was blocked decides the reset (it may not be the active one after an account switch).
    const slotWindows = state.scope.slot && this.accounts && state.scope.slot !== (await this.accounts.activeSlot(userId)) ? await this.accounts.usageOf(userId, state.scope.slot).catch(() => null) : null;
    const w = slotWindows ? slotWindows.find((x) => x.id === state.scope.window) ?? null : await this.usage?.claudeWindow(userId, state.scope.window).catch(() => null);
    // Before the reported reset only real usage decides: still full or unknown -> look again in a few minutes (attempts are not used up);
    // known and no longer full -> the limit was cleared early (usage reset, extra usage): resume now instead of sleeping until the clock says so.
    const resetAt = state.resetsAt ? Date.parse(state.resetsAt) : NaN;
    const untilReset = Number.isFinite(resetAt) ? resetAt + RESET_GRACE_MS - this.now() : NaN;
    if (untilReset > 1_000) {
      const blocked = !w || (w.usedPercent >= 100 && (!w.resetsAt || Date.parse(w.resetsAt) > this.now()));
      if (blocked) { this.arm(id, userId, Math.min(EARLY_CHECK_MS, untilReset), attempt); return; }
      log.info("fallback.early_reset", { sessionId: id, window: state.scope.window });
      await this.restore(id, userId, { force: false });
      return;
    }
    // Known and still full: stay on the fallback and look again later.
    if (w && w.usedPercent >= 100 && (!w.resetsAt || Date.parse(w.resetsAt) > this.now())) {
      const next = RETRY_STILL_BLOCKED_MS[attempt];
      this.arm(id, userId, next ?? (w.resetsAt ? Date.parse(w.resetsAt) - this.now() + RESET_GRACE_MS : 30 * 60_000), attempt + 1);
      return;
    }
    // Unknown (usage API failing, other window id) is not "reset": look once more after a short delay before trusting the clock.
    if (!w && attempt === 0) {
      this.arm(id, userId, UNKNOWN_RETRY_MS, 1);
      return;
    }
    await this.restore(id, userId, { force: false });
  }

  /** Swap back (or resume a parked agent). Model swap-back waits for an idle agent and never interrupts a turn. A forced call pre-empts a waiting one. */
  restore(id: string, userId: string, options: { force: boolean }): Promise<void> {
    const running = this.restoring.get(id);
    if (running) {
      if (options.force) { this.forceNow.add(id); this.wakers.get(id)?.(); }
      return running;
    }
    if (options.force) this.forceNow.add(id);
    const task = this.restoreOnce(id, userId, options).finally(() => { this.restoring.delete(id); this.forceNow.delete(id); });
    this.restoring.set(id, task);
    return task;
  }

  private async restoreOnce(id: string, userId: string, options: { force: boolean }): Promise<void> {
    const row = await this.load(id, userId);
    const state = row?.fallback_state;
    if (!row || !state) return;
    if (state.keep && !options.force) return;
    const settings = await this.loadSettings(userId);
    const clear = () => this.pool.query("UPDATE agent_sessions SET fallback_state = NULL WHERE id = $1 AND user_id = $2", [id, userId]);
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    // The origin model comes back too when this service lowered it and the user did not change it since.
    const originModel = state.lowered && row.model === state.lowered ? state.origin.model : row.model;

    if (state.current.kind === "account") {
      if (await this.restoreAccount(userId, { force: options.force })) await clear();
      return;
    }
    if (state.current.kind === "codex") {
      // User intent wins: another provider chosen by hand cancels the swap-back.
      if (row.provider !== "codex") { await clear(); return; }
      if (!settings.swapBack && !options.force) return;
      if (!this.host.isLive(id, userId)) {
        // Asleep: flip the row back without waking it; the next launch is Claude again, with the notice.
        await this.pool.query("UPDATE agent_sessions SET provider = 'claude', model = $3, fallback_state = NULL WHERE id = $1 AND user_id = $2 AND provider = 'codex'", [id, userId, state.origin.model]);
        const last = state.handoffs?.at(-1);
        if (last) this.host.queueNotice(id, claudeBackNotice(last));
        return;
      }
      const started = this.now();
      while (!options.force && !this.forceNow.has(id) && this.host.isLive(id, userId) && !(this.host.isIdle(id, userId) && this.host.quietMs(id) >= IDLE_QUIET_MS)) {
        if (this.stopped || this.now() - started > IDLE_GIVE_UP_MS) return;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, IDLE_POLL_MS);
          t.unref();
          this.wakers.set(id, () => { clearTimeout(t); resolve(); });
        });
        this.wakers.delete(id);
        const again = await this.load(id, userId);
        if (!again?.fallback_state || again.fallback_state.keep || again.provider !== "codex") return;
      }
      const latest = await this.load(id, userId);
      if (!latest?.fallback_state || latest.provider !== "codex") return;
      const path = await this.host.buildHandoff({ userId, id, direction: "to-claude", n: (state.handoffs?.length ?? 0) + 1, reason: null, previousHandoff: state.handoffs?.at(-1) ?? null });
      await this.host.switchProvider(userId, id, { provider: "claude", model: state.origin.model, notice: claudeBackNotice(path) });
      await this.pool.query("UPDATE agent_sessions SET fallback_state = NULL WHERE id = $1 AND user_id = $2", [id, userId]);
      return;
    }
    if (state.current.kind === "paused") {
      if (this.host.isLive(id, userId)) {
        await this.pool.query("UPDATE agent_sessions SET model = $3, fallback_state = NULL WHERE id = $1 AND user_id = $2", [id, userId, originModel]);
        // A live CLI may be sitting in its own "continuing automatically at <time>" wait, which ignores a reset that came early: the typed
        // notice cancels that wait (Esc first, see typeMessage) so the agent continues now. Fire and forget, like notifyParent.
        void this.host.notifyParent(userId, id, "[Floq] Your usage limit reset. Continue the task you were working on.").catch(() => undefined);
        return;
      }
      // Wake first, clear after: a resume that fails keeps the state and tries again later, it never strands the agent.
      await this.pool.query("UPDATE agent_sessions SET model = $3 WHERE id = $1 AND user_id = $2", [id, userId, originModel]);
      this.host.queueNotice(id, "[Floq] Your usage limit reset. Continue the task you were working on.");
      try {
        await this.host.resume(userId, id);
      } catch (error) {
        this.host.dropNotice(id);
        this.arm(id, userId, 5 * 60_000, 1);
        throw error;
      }
      await clear();
      return;
    }
    // Model step. User intent wins: a model changed by hand cancels the swap-back.
    if (row.model !== state.current.model) { await clear(); return; }
    if (!settings.swapBack && !options.force) return;
    if (!this.host.isLive(id, userId)) {
      await this.pool.query("UPDATE agent_sessions SET model = $3, fallback_state = NULL WHERE id = $1 AND user_id = $2", [id, userId, state.origin.model]);
      return;
    }
    const started = this.now();
    while (!options.force && !this.forceNow.has(id) && !(this.host.isIdle(id, userId) && this.host.quietMs(id) >= IDLE_QUIET_MS)) {
      if (this.stopped || this.now() - started > IDLE_GIVE_UP_MS) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, IDLE_POLL_MS);
        t.unref();
        this.wakers.set(id, () => { clearTimeout(t); resolve(); });
      });
      this.wakers.delete(id);
      const again = await this.load(id, userId);
      if (!again?.fallback_state || again.fallback_state.keep || again.model !== state.current.model) return;
      if (!this.host.isLive(id, userId)) break;
    }
    // Conditional on the model still being the swapped one and the state still being there: a change made while waiting wins.
    const updated = await this.pool.query(
      "UPDATE agent_sessions SET model = $3, fallback_state = NULL WHERE id = $1 AND user_id = $2 AND model IS NOT DISTINCT FROM $4 AND fallback_state IS NOT NULL",
      [id, userId, state.origin.model, state.current.model ?? null],
    );
    if (!updated.rowCount) return;
    if (this.host.isLive(id, userId)) {
      this.host.queueNotice(id, `[Floq] Back on ${state.origin.model ? modelLabel(state.origin.model) : "your default model"} (limit reset).`);
      try {
        await this.host.restart(userId, id);
      } catch (error) {
        this.host.dropNotice(id);
        throw error;
      }
    }
  }

  /** The user resumed an agent by hand: a paused agent is no longer waiting for the reset. The handled limit record stays remembered (fallback_last_event). */
  async userResumed(id: string, userId: string): Promise<void> {
    const row = await this.load(id, userId);
    if (row?.fallback_state?.current.kind !== "paused") return;
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    const state = row.fallback_state;
    const originModel = state.lowered && row.model === state.lowered ? state.origin.model : row.model;
    await this.pool.query("UPDATE agent_sessions SET model = $3, fallback_state = NULL, fallback_last_event = COALESCE($4, fallback_last_event) WHERE id = $1 AND user_id = $2", [id, userId, originModel, state.lastEventUuid ?? null]);
  }

  /**
   * Proactive check at launch (a Claude agent is created or resumed while the cached usage already shows a full window):
   * model and account steps are applied BEFORE the process starts, so no turn is wasted. Returns what to launch with, or null.
   * Park and the Codex step are not applied here: an explicit start/resume by the user goes ahead and the normal detection handles a block.
   */
  async beforeLaunch(row: { id: string; user_id: string; provider: string; model: string | null }): Promise<{ model: string | null; notice?: string } | null> {
    if (row.provider !== "claude" || !this.usage) return null;
    const userId = row.user_id;
    const stored = await this.load(row.id, userId);
    // A paused or Codex row is handled elsewhere; an agent already on a lowered model or a reserve account may need the NEXT step (its account can be exhausted too).
    const prior = stored?.fallback_state ?? null;
    if (!stored || (prior && prior.current.kind !== "model" && prior.current.kind !== "account") || (stored.fallback_override?.mode ?? "default") === "pause") return null;
    const settings = await this.loadSettings(userId);
    if (!settings.enabled) return null;
    const blocked = await this.usage.claudeBlocked(userId).catch(() => null);
    if (!blocked) return null;
    const now = this.now();
    const override = stored.fallback_override?.mode ?? "default";
    const event = { rateLimitType: blocked.window };
    const activeNow = this.accounts ? await this.accounts.activeSlot(userId) : null;
    const tried = markTried(prior?.tried, activeNow, blocked.resetsAt, now);
    let usable: string[] = [];
    const accountStep = settings.steps.find((st) => st.kind === "account" && st.enabled);
    if (this.accounts && accountStep && accountStep.kind === "account" && override === "default") {
      const candidates: Array<{ slot: string; windows: UsageWindow[] | null }> = [];
      for (const reserve of await this.accounts.reserveSlots(userId, accountStep.slots)) candidates.push({ slot: reserve.slot, windows: await this.accounts.usageOf(userId, reserve.slot) });
      usable = walkableSlots(candidates, blocked.window, "window", tried, now);
    }
    const swaps = (prior?.swaps ?? []).filter((at) => now - Date.parse(at) < 3_600_000);
    const base: FallbackState = { origin: prior?.origin ?? { provider: "claude", model: stored.model }, current: { kind: "paused" }, scope: { window: blocked.window, family: limitFamily(blocked.window) }, resetsAt: blocked.resetsAt, since: prior?.since ?? new Date(now).toISOString(), swaps: [...swaps, new Date(now).toISOString()], ineffective: prior?.ineffective ?? [], tried, ...(prior?.lowered ? { lowered: prior.lowered } : {}) };
    const plan = planFallback({ settings, override, event, model: stored.model, state: { ...base, current: prior?.current ?? base.current, swaps }, now, accounts: usable, codex: null });
    if (plan.action === "model") {
      const next: FallbackState = { ...base, current: { kind: "model", model: plan.model }, lowered: plan.model };
      await this.pool.query("UPDATE agent_sessions SET model = $3, fallback_state = $4 WHERE id = $1 AND user_id = $2", [row.id, userId, plan.model, JSON.stringify(next)]);
      this.schedule(row.id, userId, blocked.resetsAt);
      log.info("fallback.launch_model", { sessionId: row.id, window: blocked.window, to: plan.model });
      return { model: plan.model, notice: `[Floq] ${windowName(blocked.window)} limit is reached${resetNote(blocked.resetsAt)}. You are on ${modelLabel(plan.model)}.` };
    }
    if (plan.action === "account" && this.accounts) {
      const from = await this.accounts.activeSlot(userId);
      await this.accounts.switchTo(userId, plan.slot);
      const labels = await this.accounts.list(userId);
      const label = labels.find((a) => a.slot === plan.slot)?.label ?? "another account";
      const next: FallbackState = { ...base, origin: { provider: "claude", model: base.origin.model, slot: base.origin.slot ?? from }, current: { kind: "account", slot: plan.slot, label } };
      await this.pool.query("UPDATE agent_sessions SET fallback_state = $3 WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(next)]);
      await this.recordAccountSwitch(userId, plan.slot, { slot: base.origin.slot ?? from, window: blocked.window, resetsAt: blocked.resetsAt });
      log.info("fallback.launch_account", { sessionId: row.id, window: blocked.window, to: plan.slot });
      return { model: stored.model, notice: `[Floq] The Claude usage limit${resetNote(blocked.resetsAt)} was reached on your other account. You are on ${label}.` };
    }
    return null;
  }

  /** Look at live Claude agents the output hook may have missed (see manager.reap). The transcript stamp makes this a stat per agent. */
  sweep(live: Array<{ id: string; userId: string }>): void {
    for (const agent of live) this.onOutput(agent.id, agent.userId);
  }

  /** User actions from the badge or the agent menu. Returns whether anything changed, so the UI can tell a no-op. */
  async act(userId: string, id: string, action: "return" | "keep" | "override", override?: FallbackOverride): Promise<{ applied: boolean; reason?: string; resetsAt?: string }> {
    const row = await this.load(id, userId);
    if (!row) throw badRequest("Session not found", "not_found");
    if (action === "override") {
      if (override !== "default" && override !== "model" && override !== "pause") throw badRequest("override must be default, model or pause");
      await this.pool.query("UPDATE agent_sessions SET fallback_override = $3 WHERE id = $1 AND user_id = $2", [id, userId, override === "default" ? null : JSON.stringify({ mode: override })]);
      return { applied: true };
    }
    if (!row.fallback_state) return { applied: false, reason: "no_fallback" };
    if (action === "keep") {
      const timer = this.timers.get(id);
      if (timer) { clearTimeout(timer); this.timers.delete(id); }
      await this.pool.query("UPDATE agent_sessions SET fallback_state = $3 WHERE id = $1 AND user_id = $2", [id, userId, JSON.stringify({ ...row.fallback_state, keep: true })]);
      return { applied: true };
    }
    // "Return now" to a limit that is still on would just be blocked again and burn the hourly swap budget: say so instead.
    if (row.fallback_state.current.kind !== "paused") {
      const still = await this.stillLimited(userId, row.fallback_state);
      if (still) return { applied: false, reason: "still_limited", resetsAt: still };
    }
    await this.restore(id, userId, { force: true });
    return { applied: true };
  }

  /** Reset time when the blocked window of this fallback is still full (usage known), else null. */
  private async stillLimited(userId: string, state: FallbackState): Promise<string | null> {
    const slot = state.scope.slot ?? state.origin.slot;
    const windows = slot && this.accounts ? await this.accounts.usageOf(userId, slot).catch(() => null) : null;
    const w = windows ? windows.find((x) => x.id === state.scope.window) ?? null : await this.usage?.claudeWindow(userId, state.scope.window).catch(() => null) ?? null;
    return w && w.usedPercent >= 100 && w.resetsAt && Date.parse(w.resetsAt) > this.now() ? w.resetsAt : null;
  }
}

export function windowName(rateLimitType: string): string {
  switch (rateLimitType) {
    case "five_hour": return "The 5-hour";
    case "seven_day": return "The weekly";
    case "seven_day_opus": return "The Opus weekly";
    case "seven_day_sonnet": return "The Sonnet weekly";
    case "spend_limit": return "The spend";
    case "extra_usage": return "The extra-usage";
    default: return "The usage";
  }
}

/** UTC clock time of a reset for short messages. */
function resetClock(resetsAt: string | null): string {
  return resetsAt ? resetsAt.slice(11, 16) + " UTC" : "the limit resets";
}

function resetNote(resetsAt: string | null): string {
  return resetsAt ? ` (resets ${resetsAt.slice(0, 16).replace("T", " ")} UTC)` : "";
}

/** Public badge data for a row (SessionSummary.fallback). */
export interface FallbackBadge {
  kind: "model" | "account" | "codex" | "paused";
  label: string;
  originLabel: string;
  resetsAt: string | null;
  keep: boolean;
  /** Paused only: why (wording of the toast and the tooltip). */
  reason?: "no_step" | "pause_override" | "fallback_loop" | "steps_unavailable";
}

export function fallbackBadge(state: FallbackState | null | undefined): FallbackBadge | null {
  if (!state || typeof state !== "object" || !state.current) return null;
  const originLabel = state.origin?.model ? modelLabel(state.origin.model) : "default model";
  const common = { originLabel, resetsAt: state.resetsAt ?? null, keep: state.keep === true };
  switch (state.current.kind) {
    case "model": return { kind: "model", label: state.current.model ? modelLabel(state.current.model) : "lower model", ...common };
    case "account": return { kind: "account", label: state.current.label ?? "another account", ...common };
    case "codex": return { kind: "codex", label: "Codex", ...common };
    default: return { kind: "paused", label: "Paused", ...common, ...(state.parkReason ? { reason: state.parkReason } : {}) };
  }
}
