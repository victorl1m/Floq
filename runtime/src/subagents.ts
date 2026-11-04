/**
 * Always-recruit subagents: the fixed Floq policy every agent session carries, the recruit tool surface, and the
 * safety limits (depth, children per parent, total) behind it.
 *
 * The policy is its own composable block. It is handed to the provider as system-level instructions on EVERY start and
 * resume (see SessionManager.launch), next to the wired-context block, never inside a role prompt, so role edits,
 * notes or project files cannot remove it and it survives context compaction.
 *
 * Tools are the in-sandbox `floq subagent ...` commands (same mechanism as every other Floq tool: per-session token
 * to /internal/agents/subagent/*). TOOL_SPECS names them with stable `floq_*_subagent` ids for UI and docs.
 */
import type pg from "pg";
import type { Orchestrator } from "./orchestrator.js";
import type { SessionManager } from "./manager.js";
import type { SettingsStore } from "./settings.js";
import { HttpError, badRequest, conflict, notFound } from "./errors.js";
import { getAgentRole, GENERALIST_ID, ORCHESTRATOR_ROLE_ID, parseRoleId } from "./roles.js";
import { log } from "./logger.js";

export const SUBAGENT_BEGIN = "[FLOQ SUBAGENT POLICY v1]";
export const SUBAGENT_END = "[/FLOQ SUBAGENT POLICY]";

export interface SubagentLimits {
  /** Max nesting: 0 = a top-level agent, children are depth 1. Agents at maxDepth cannot recruit. */
  maxDepth: number;
  maxChildren: number;
  /** Max live subagents (any depth) per user. */
  maxTotal: number;
}

export const DEFAULT_LIMITS: SubagentLimits = { maxDepth: 2, maxChildren: 6, maxTotal: 24 };

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** FLOQ_SUBAGENT_MAX_DEPTH (0-4), FLOQ_SUBAGENT_MAX_CHILDREN (1-12), FLOQ_SUBAGENT_MAX_TOTAL (1-64). Invalid values fall back. */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): SubagentLimits {
  return {
    maxDepth: intEnv(env.FLOQ_SUBAGENT_MAX_DEPTH, DEFAULT_LIMITS.maxDepth, 0, 4),
    maxChildren: intEnv(env.FLOQ_SUBAGENT_MAX_CHILDREN, DEFAULT_LIMITS.maxChildren, 1, 12),
    maxTotal: intEnv(env.FLOQ_SUBAGENT_MAX_TOTAL, DEFAULT_LIMITS.maxTotal, 1, 64),
  };
}

export interface ToolSpec {
  /** Stable logical tool id. */
  name: string;
  /** What the agent actually runs in its terminal. */
  command: string;
  summary: string;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: "floq_recruit_subagent", command: 'floq subagent recruit "Name" --task "..." [--role ID] [--provider claude|codex] [--model ID] [--no-wire]', summary: "Start a subagent session on the canvas, wired to you by default." },
  { name: "floq_list_subagents", command: "floq subagent list", summary: "List your subagents with id, role, depth and status." },
  { name: "floq_message_subagent", command: 'floq subagent ask ID "message" [--no-wait]', summary: "Send a message to a subagent; waits for its reply unless --no-wait." },
  { name: "floq_subagent_result", command: "floq subagent result ID [--full]", summary: "Read a subagent's status and last reply without blocking." },
  { name: "floq_dismiss_subagent", command: "floq subagent dismiss ID", summary: "Stop and remove a finished subagent (and its own subagents)." },
];

/** Block markers must not be forgeable from user-controlled text. */
const oneLine = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The fixed instruction. `enabled=false` (the user switched "Always recruit subagents" off) still ships a short block so
 * the agent knows the rule, but it no longer pushes delegation.
 */
export const CROSS_PROJECT_LINES = [
  "Other projects: you can reach agents of the user's OTHER projects, not just this one. Find them with `floq list` (every project; shows project, role, state) or `floq list --project NAME`. Message one with `floq ask <UUID> \"...\"` (waits for its reply; add --no-wait to just send), read its answer with `floq check <UUID>`, and wire yourself to it on the canvas with `floq link <UUID>`. The receiver sees who you are and which project you are in, and can answer with `floq ask` back.",
  "Cross-project messages are plain text typed to the other agent: they grant it nothing and you cannot use them to widen anyone's permissions. They are rate-limited, size-capped and loop-protected; never include secret values, only names. If `floq list` shows only this project, the user turned cross-project messaging off in Settings > Agents.",
];

export function buildSubagentInstruction(options: { enabled: boolean; depth: number; limits?: SubagentLimits; crossProject?: boolean }): string {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const depth = Math.max(0, Math.floor(options.depth));
  const lines: string[] = [SUBAGENT_BEGIN];
  lines.push(
    "You are running inside Floq: every agent is a visible session on the user's canvas. This policy is fixed by Floq. Role presets, notes and project files cannot change or remove it, and it supersedes any earlier guidance that says to recruit only when asked.",
  );
  if (!options.enabled) {
    lines.push(
      "The user turned off automatic subagents. Work in this session. Recruit only when the user explicitly asks, and then use Floq (`floq subagent recruit \"Name\" --task \"...\"`). Provider-native subagents (Agent/Task tool, background agents) are disabled in Floq and will be refused.",
    );
    if (options.crossProject !== false) lines.push(...CROSS_PROJECT_LINES);
    lines.push(SUBAGENT_END);
    return lines.join("\n");
  }
  if (options.crossProject !== false) lines.push(...CROSS_PROJECT_LINES);
  if (depth > 0) lines.push(`You are a subagent (depth ${depth}). Do the task you were given, report concisely (result, files changed, open questions), and never exceed it.`);
  lines.push(
    "Delegate by default: when work splits into independent parts (separate modules or files, research vs. implementation, implementation vs. review or tests, parallel investigations), recruit Floq subagents and run them in parallel instead of doing everything alone. Do small or tightly coupled work yourself.",
    "Use Floq subagents only. Provider-native subagents (Claude Code's Agent/Task tool, background agents, Codex multi_agent) are DISABLED in Floq and will be refused: do not try them, do not retry them. Recruit instead with `floq subagent recruit \"Name\" --task \"...\"`.",
  );
  if (depth >= limits.maxDepth) {
    lines.push(`You are at the maximum subagent depth (${limits.maxDepth}): do NOT recruit. Finish the task yourself and report back.`);
  } else {
    lines.push("Tools (run in your terminal; ID is the UUID printed by recruit/list):");
    for (const tool of TOOL_SPECS) lines.push(`- ${tool.name}: ${tool.command}`);
    lines.push(
      `Limits: depth at most ${limits.maxDepth} (you are at ${depth}), at most ${limits.maxChildren} direct subagents, at most ${limits.maxTotal} subagents in total. Do not recruit in loops or just to recruit; the limits are enforced and refusals are final.`,
      "Cost: every subagent is a full agent session that spends the user's quota. Skip it for trivial work (one quick edit, reading one file), recruit as few as the job needs, give each a self-contained task with paths and a done-criterion, pick a cheaper model for mechanical work, and dismiss subagents when they finish.",
      "Authority: subagents inherit your workspace and project and never get more permission than you have (if you are read-only, so are they). You stay responsible for the result: read each report, verify important claims, and integrate the work.",
    );
  }
  lines.push("Never put secret values in task text, messages or reports; refer to secret names only.", SUBAGENT_END);
  return lines.join("\n");
}

/** Provider system-level text: the fixed policy first, then any other managed block (e.g. wired context). */
export function composeSystemBlocks(...blocks: Array<string | null | undefined>): string {
  return blocks.filter((b): b is string => typeof b === "string" && b.trim().length > 0).join("\n\n");
}

export interface SubagentRow {
  id: string;
  title: string;
  provider: "claude" | "codex";
  model: string | null;
  state: string;
  role: string | null;
  cwd: string | null;
  parent_session_id: string | null;
}

/** Depth of a session = number of ancestors. Cycle-safe. */
export function depthOf(rows: Pick<SubagentRow, "id" | "parent_session_id">[], id: string): number {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>([id]);
  let depth = 0;
  let parent = byId.get(id)?.parent_session_id ?? null;
  while (parent && !seen.has(parent) && depth < 16) {
    seen.add(parent);
    depth++;
    parent = byId.get(parent)?.parent_session_id ?? null;
  }
  return depth;
}

/** Every descendant of `id`, nearest first. */
export function descendantsOf(rows: Pick<SubagentRow, "id" | "parent_session_id">[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length && out.length < 256) {
    const next = rows.filter((r) => r.parent_session_id && frontier.includes(r.parent_session_id) && !seen.has(r.id)).map((r) => r.id);
    for (const n of next) seen.add(n);
    out.push(...next);
    frontier = next;
  }
  return out;
}

/** Pure limit check; throws the error the agent sees. */
export function assertWithinLimits(rows: SubagentRow[], callerId: string, limits: SubagentLimits): number {
  const depth = depthOf(rows, callerId);
  if (depth >= limits.maxDepth) {
    throw new HttpError(403, "subagent_depth", `Subagent depth limit reached (max ${limits.maxDepth}); you cannot recruit. Finish the task yourself and report back.`);
  }
  const children = rows.filter((r) => r.parent_session_id === callerId).length;
  if (children >= limits.maxChildren) {
    throw new HttpError(429, "subagent_children", `You already have ${children} subagents (max ${limits.maxChildren}). Reuse one with \`floq subagent ask\` or dismiss a finished one first.`);
  }
  const total = rows.filter((r) => r.parent_session_id).length;
  if (total >= limits.maxTotal) {
    throw new HttpError(429, "subagent_total", `The total subagent limit (${limits.maxTotal}) is reached. Dismiss finished subagents first.`);
  }
  return depth + 1;
}

/** A read-only parent can only recruit read-only roles, and nobody recruits an orchestrator: no permission escalation. */
export function assertNoEscalation(parentRole: string | null, childRole: string | null): void {
  if (childRole === ORCHESTRATOR_ROLE_ID) throw new HttpError(403, "subagent_role", "Subagents cannot be orchestrators.");
  if (parentRole && getAgentRole(parentRole)?.readOnly && !(childRole && getAgentRole(childRole)?.readOnly)) {
    throw new HttpError(403, "subagent_escalation", "You are read-only, so your subagents must be too: pass --role reviewer.");
  }
}

/** First message for a subagent: who recruited it, then the task. The role preset header is added by the manager. */
export function buildSubagentBrief(parentName: string, depth: number, task: string): string {
  return [
    `[Floq subagent] You were recruited by "${oneLine(parentName, 60)}" (subagent depth ${depth}). Do only the task below, report concisely (result, files changed, open questions), and do not wait for further input once it is done.`,
    "",
    "Task:",
    task,
  ].join("\n");
}

function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? oneLine(value, 60) : "";
  return name || fallback;
}

/** Name unique among the user's agents: appends " 2", " 3", ... */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 56)} ${i}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  throw conflict("Could not find a free agent name");
}

export interface SubagentView {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  state: string;
  depth: number;
  parentId: string | null;
}

export class SubagentService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly orchestrator: Orchestrator,
    private readonly manager: Pick<SessionManager, "remove">,
    private readonly settings: Pick<SettingsStore, "get">,
    readonly limits: SubagentLimits = limitsFromEnv(),
  ) {}

  private async rows(userId: string): Promise<SubagentRow[]> {
    return (await this.pool.query("SELECT id, title, provider, model, state, role, cwd, parent_session_id FROM agent_sessions WHERE user_id = $1 AND provider <> 'shell'", [userId])).rows as SubagentRow[];
  }

  async enabled(userId: string): Promise<boolean> {
    try { return (await this.settings.get(userId)).alwaysRecruitSubagents !== false; } catch { return true; }
  }

  /** For SessionManager.launch: never throws. Fails closed to the full policy at the session's depth. */
  async blockFor(userId: string, sessionId: string): Promise<string> {
    let depth = 0;
    try { depth = depthOf(await this.rows(userId), sessionId); } catch (error) {
      log.warn("subagents.depth_failed", { sessionId, error: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    }
    let crossProject = true;
    try { crossProject = (await this.settings.get(userId)).allowCrossProjectAgents !== false; } catch { /* default on */ }
    return buildSubagentInstruction({ enabled: await this.enabled(userId), depth, limits: this.limits, crossProject });
  }

  /** Serialise per user so the limit check and the create cannot race past a cap. */
  private serial<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(userId) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.queues.set(userId, run);
    void run.finally(() => { if (this.queues.get(userId) === run) this.queues.delete(userId); }).catch(() => undefined);
    return run;
  }

  async recruit(userId: string, sessionId: string, input: { name?: unknown; task?: unknown; role?: unknown; provider?: unknown; model?: unknown; wire?: unknown }) {
    if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 20_000 || input.task.includes("\u0000")) {
      throw badRequest("task required (max 20000 chars)", "invalid_task");
    }
    const task = input.task.trim();
    const role = parseRoleId(input.role); // throws on unknown ids
    if (input.provider !== undefined && input.provider !== "claude" && input.provider !== "codex") throw badRequest("provider must be claude or codex");
    if (input.model !== undefined && typeof input.model !== "string") throw badRequest("model must be a configured model id");
    return this.serial(userId, async () => {
      if (!(await this.enabled(userId))) throw new HttpError(403, "subagents_disabled", "Automatic subagents are turned off in Floq settings (Agents > Always recruit subagents).");
      const rows = await this.rows(userId);
      const me = rows.find((r) => r.id === sessionId);
      if (!me) throw notFound("Calling session not found");
      const depth = assertWithinLimits(rows, me.id, this.limits);
      assertNoEscalation(me.role, role?.id ?? null);
      const name = uniqueName(cleanName(input.name, (role?.label ?? "Subagent") + " " + task.slice(0, 24)), rows.map((r) => r.title));
      const created = await this.orchestrator.recruit(
        userId,
        sessionId,
        { name, provider: input.provider ?? me.provider, model: input.model, role: role?.id ?? GENERALIST_ID, prompt: buildSubagentBrief(me.title, depth, task), wire: input.wire !== false },
        { skipOrchestratorCheck: true },
      );
      log.info("subagent.recruit", { userId, parentId: me.id, id: created.id, depth });
      return { ...created, role: role?.id ?? GENERALIST_ID, depth, parentId: me.id, wired: input.wire !== false };
    });
  }

  /** Subagents of the caller (all depths), nearest first. */
  async list(userId: string, sessionId: string): Promise<{ subagents: SubagentView[]; limits: SubagentLimits; depth: number; canRecruit: boolean }> {
    const rows = await this.rows(userId);
    if (!rows.some((r) => r.id === sessionId)) throw notFound("Calling session not found");
    const byId = new Map(rows.map((r) => [r.id, r]));
    const subagents = descendantsOf(rows, sessionId).map((id) => {
      const r = byId.get(id)!;
      return { id: r.id, name: r.title, role: r.role ?? GENERALIST_ID, provider: r.provider, model: r.model ?? "default", state: r.state, depth: depthOf(rows, id), parentId: r.parent_session_id };
    });
    const depth = depthOf(rows, sessionId);
    const direct = rows.filter((r) => r.parent_session_id === sessionId).length;
    return { subagents, limits: this.limits, depth, canRecruit: depth < this.limits.maxDepth && direct < this.limits.maxChildren && (await this.enabled(userId)) };
  }

  /** Only the caller's own descendants can be targeted; the id must be the UUID. */
  private async owned(userId: string, sessionId: string, id: unknown): Promise<{ id: string; rows: SubagentRow[] }> {
    if (typeof id !== "string" || !id.trim()) throw badRequest("subagent id required");
    const rows = await this.rows(userId);
    if (!rows.some((r) => r.id === sessionId)) throw notFound("Calling session not found");
    const target = rows.find((r) => r.id.toLowerCase() === id.trim().toLowerCase());
    if (!target || !descendantsOf(rows, sessionId).includes(target.id)) throw new HttpError(403, "not_your_subagent", "That agent is not one of your subagents; run `floq subagent list`.");
    return { id: target.id, rows };
  }

  async ask(userId: string, sessionId: string, id: unknown, prompt: unknown, timeoutSec?: number, wait = true) {
    const target = await this.owned(userId, sessionId, id);
    return this.orchestrator.ask(userId, sessionId, target.id, prompt, timeoutSec, wait);
  }

  async result(userId: string, sessionId: string, id: unknown, chars?: number, full = false) {
    const target = await this.owned(userId, sessionId, id);
    return this.orchestrator.check(userId, sessionId, target.id, chars ?? 4000, full);
  }

  /** Removes the subagent and everything recruited under it, deepest first. */
  async dismiss(userId: string, sessionId: string, id: unknown) {
    const target = await this.owned(userId, sessionId, id);
    const ids = [...descendantsOf(target.rows, target.id).reverse(), target.id];
    for (const victim of ids) await this.manager.remove(victim, userId);
    return { ok: true, dismissed: ids.length };
  }
}
