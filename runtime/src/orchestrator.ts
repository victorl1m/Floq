import type pg from "pg";
import type { ModelEntry } from "./config.js";
import { HttpError, badRequest, conflict, notFound } from "./errors.js";
import { safeRelative } from "./shard.js";
import type { SessionManager } from "./manager.js";
import type { Session } from "./session.js";
import { agentStatus, DEFAULT_REPLY_CHARS, truncateReply, type AgentStatus, type TranscriptTurn } from "./turn.js";
import type { SettingsStore } from "./settings.js";
import { getAgentRole, GENERALIST_ID, ORCHESTRATOR_ROLE_ID } from "./roles.js";
import type { Keychains } from "./keychains.js";
import type { AgentLinks } from "./links.js";
import { CrossProjectGuard, buildProvenance, buildReplyHint } from "./crossProject.js";
import { log } from "./logger.js";
import { neutralizeApprovalMarker } from "./approvalText.js";
import { MessageInbox, bracketedPasteState, inboxPointer, needsInbox, serialPerTarget, sha256Prefix, typeMessage } from "./messageDelivery.js";
import type { ProviderId, SessionSummary } from "./types.js";
import { parseRecruitSkills } from "./recruitSkills.js";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const QUIET_MS = 5_000;
const POLL_MS = 1_000;
const TRANSCRIPT_REGISTER_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_REPLY_CHARS = 20_000;
const NOTE_NAME = /^[\w .-]{1,80}$/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n");
}

export interface AgentView {
  /** Stable Floq session UUID; never the provider's conversation id or mutable title. */
  id: string;
  name: string;
  provider: ProviderId;
  /** Model selected when this Floq session was configured; null means CLI default. */
  model: string | null;
  state: string;
  lead: boolean;
  linked: boolean;
  self: boolean;
  role: string | null;
  /** Project of the agent (id is null outside a registered project); `same` is true for the caller's own project. */
  project: { id: string | null; name: string; same: boolean };
}

export async function selectableAgentModels(
  config: { models: { claude: ModelEntry[]; codex: ModelEntry[] }; codexModelsOverridden: boolean },
  discoverCodexModels: (userId: string) => Promise<ModelEntry[]>,
  userId: string,
  provider?: "claude" | "codex",
): Promise<Record<string, Array<ModelEntry & { default?: boolean }>>> {
  const result: Record<string, Array<ModelEntry & { default?: boolean }>> = {};
  if (!provider || provider === "claude") result.claude = [{ id: "default", label: "Default", default: true }, ...config.models.claude];
  if (!provider || provider === "codex") {
    const codex = config.codexModelsOverridden ? config.models.codex : await discoverCodexModels(userId);
    result.codex = [{ id: "default", label: "Default", default: true }, ...codex];
  }
  return result;
}

/**
 * Agent-to-agent control plane behind the in-sandbox `floq` CLI.
 * Rules: agents (claude/codex, never shells) are linked iff they share a project root; older sessions
 * without a project root fall back to normalized cwd, and auto-assigned workspaces form one "scratch"
 * project. Only a lead agent can recruit and dismiss (within its own project). Scoped to one user.
 * Messaging (ask/check/wait/link) also works across the same user's projects unless they turned that off.
 */
const SCRATCH = /^workspace\/[0-9a-f]{8}$/;

export function projectOf(cwd: string | null | undefined): string {
  let rel = "";
  try {
    rel = safeRelative(cwd ?? "");
  } catch {
    rel = String(cwd);
  }
  return !rel || SCRATCH.test(rel) ? "(scratch)" : rel;
}

export function agentProjectIdentity(agent: { cwd: string | null; git_url?: string | null; project_cwd?: string | null }): string {
  if (agent.project_cwd !== null && agent.project_cwd !== undefined) return "path:" + projectPath(agent.project_cwd);
  if (agent.git_url || projectOf(agent.cwd) !== "(scratch)") return "path:" + projectPath(agent.cwd ?? "");
  return "legacy:scratch";
}

type RecruitRow = { id: string; title: string; role: string | null; cwd: string | null; git_url?: string | null; project_cwd?: string | null };

/** Only an orchestrator may recruit. Pure so it can be tested; `sameProject` scopes the orchestrator list to the caller's project. */
export function assertCanRecruit(me: RecruitRow, all: RecruitRow[], sameProject: (a: RecruitRow, b: RecruitRow) => boolean): void {
  if (me.role === ORCHESTRATOR_ROLE_ID) return;
  const orchestrators = all.filter((r) => r.role === ORCHESTRATOR_ROLE_ID && r.id !== me.id && sameProject(me, r));
  const base = "Only the orchestrator can recruit agents. ";
  if (!orchestrators.length) {
    throw new HttpError(403, "not_orchestrator", base + "This project has no orchestrator yet: ask the user to mark one (right-click an agent > Set as orchestrator), then message it with what you need.");
  }
  const first = orchestrators[0];
  const others = orchestrators.slice(1).map((o) => o.title + " (" + o.id + ")");
  throw new HttpError(
    403,
    "not_orchestrator",
    base + "Ask " + first.title + " (" + first.id + ") to recruit for you: floq ask " + first.id + ' "Please recruit a <role> agent to <task>"' + (others.length ? ". Other orchestrators: " + others.join(", ") : "") + ".",
  );
}

export class Orchestrator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly manager: SessionManager,
    private readonly settings: SettingsStore,
    private readonly links?: AgentLinks,
    private readonly secrets?: Keychains,
    private readonly cross: CrossProjectGuard = new CrossProjectGuard(),
    private readonly inbox: MessageInbox = new MessageInbox(pool),
  ) {}

  /** Whether the target TUI takes bracketed paste: what it announced in its output, else yes for the agent TUIs (both enable it). */
  private bracketed(live: Session): boolean {
    try {
      const seen = bracketedPasteState(live.replaySince(0).chunks.map((c) => c.data).join(""));
      if (seen !== undefined) return seen;
    } catch { /* fall through */ }
    return live.provider === "claude" || live.provider === "codex";
  }

  async inboxList(userId: string, sessionId: string) {
    await this.caller(userId, sessionId);
    return { messages: await this.inbox.list(userId, sessionId) };
  }

  async inboxRead(userId: string, sessionId: string, id: unknown) {
    await this.caller(userId, sessionId);
    const m = await this.inbox.read(userId, sessionId, id);
    return { ...m, body: await this.scrub(userId, [sessionId, m.from], m.body) };
  }

  private async crossAllowed(userId: string): Promise<boolean> {
    try { return (await this.settings.get(userId)).allowCrossProjectAgents !== false; } catch { return true; }
  }

  private projectName(row: { project_name?: string | null; project_id: string | null }): string {
    return row.project_name || (row.project_id ? "project" : "(scratch)");
  }

  /** Redact the secret values of the given sessions from text the runtime generates for other agents or the UI. */
  private async scrub(userId: string, ids: string[], text: string): Promise<string> {
    // Agent-authored text never carries a forged `[FLOQ APPROVAL ...]` marker to another agent.
    return neutralizeApprovalMarker(this.secrets ? await this.secrets.redact(userId, ids, text) : text);
  }

  private async scrubResult<T extends { output: string }>(userId: string, ids: string[], result: T): Promise<T> {
    return { ...result, output: await this.scrub(userId, ids, result.output) };
  }

  private async rows(userId: string) {
    return (await this.pool.query("SELECT s.id, s.title, s.provider, s.model, s.state, s.lead, s.role, s.cwd, s.git_url, s.project_cwd, s.project_id, s.workspace_id, p.name AS project_name FROM agent_sessions s LEFT JOIN floq_projects p ON p.id = s.project_id AND p.user_id = s.user_id WHERE s.user_id = $1 AND s.provider <> 'shell'", [userId])).rows as Array<{
      id: string;
      title: string;
      provider: ProviderId;
      model: string | null;
      state: string;
      lead: boolean;
      role: string | null;
      cwd: string | null;
      git_url: string | null;
      project_cwd: string | null;
      project_id: string | null;
      workspace_id: string | null;
      project_name: string | null;
    }>;
  }

  private sameProject(a: { cwd: string | null; git_url?: string | null; project_cwd?: string | null }, b: { cwd: string | null; git_url?: string | null; project_cwd?: string | null }): boolean {
    return this.projectIdentity(a) === this.projectIdentity(b);
  }

  private projectIdentity(agent: { cwd: string | null; git_url?: string | null; project_cwd?: string | null }): string {
    return agentProjectIdentity(agent);
  }

  private async resolve(userId: string, reference: unknown) {
    if (typeof reference !== "string" || !reference.trim()) throw badRequest("agent UUID or name required");
    const selector = reference.trim();
    const rows = await this.rows(userId);
    // Floq's database UUID is authoritative. Provider conversation IDs are intentionally not accepted.
    const byId = rows.find((r) => r.id.toLowerCase() === selector.toLowerCase());
    if (byId) return byId;
    const matches = rows.filter((r) => r.title.toLowerCase() === selector.toLowerCase());
    if (matches.length === 0) throw notFound('No agent with UUID or name "' + selector + '"');
    if (matches.length > 1) throw conflict('More than one agent is named "' + selector + '"; use its Floq UUID from `floq list`');
    return matches[0];
  }

  private async caller(userId: string, sessionId: string) {
    const me = (await this.rows(userId)).find((r) => r.id === sessionId);
    if (!me) throw notFound("Calling session not found");
    return me;
  }

  /**
   * The calling agent session for `floq skills|mcp|secrets`. Plain shell sessions are not agents (they are
   * excluded from the session rows, exactly as for `floq list`/`recruit`), so they get "Calling session not found".
   * Changes require a lead session, the same check that gates recruit/dismiss.
   */
  async toolkitCaller(userId: string, sessionId: string, requireLead: boolean): Promise<{ id: string; name: string; projectId: string | null; provider: "claude" | "codex" }> {
    const me = await this.caller(userId, sessionId);
    if (requireLead && !me.lead) throw new HttpError(403, "not_lead", "Only a lead agent can install or remove skills and MCP servers or create secrets");
    return { id: me.id, name: me.title, projectId: me.project_id, provider: me.provider as "claude" | "codex" };
  }

  /**
   * The two agents of an approval request: the caller (requester) and the target (another agent of this user, or
   * the caller itself with "self"/omitted). Cross-project targets follow the same setting as `floq ask`.
   */
  async approvalParties(userId: string, sessionId: string, targetRef: unknown) {
    const me = await this.caller(userId, sessionId);
    const view = (r: typeof me) => ({ id: r.id, name: r.title, provider: r.provider as "claude" | "codex", projectId: r.project_id, projectName: r.project_id ? this.projectName(r) : null });
    if (targetRef === undefined || targetRef === null || targetRef === "" || (typeof targetRef === "string" && targetRef.trim().toLowerCase() === "self")) return { requester: view(me), target: view(me) };
    const other = await this.resolve(userId, targetRef);
    if (other.id !== me.id && !this.sameProject(me, other) && !(await this.crossAllowed(userId))) {
      throw new HttpError(403, "cross_project_disabled", '"' + other.title + '" is in a different project and the user turned off "Allow agents to talk across projects" in Settings > Agents');
    }
    return { requester: view(me), target: view(other) };
  }

  private async target(userId: string, sessionId: string, name: unknown) {
    const me = await this.caller(userId, sessionId);
    const other = await this.resolve(userId, name);
    if (other.id === me.id) throw badRequest("An agent cannot target itself");
    const cross = !this.sameProject(me, other);
    if (cross && !(await this.crossAllowed(userId))) {
      throw new HttpError(403, "cross_project_disabled", '"' + other.title + '" is in a different project and the user turned off "Allow agents to talk across projects" in Settings > Agents');
    }
    return { me, other, cross };
  }

  /**
   * Agents the caller can reach. Default: every agent of the user's projects (when "Allow agents to talk across
   * projects" is on; otherwise only the caller's own project). `project` filters by project name or id, `here` by own project.
   */
  async list(userId: string, sessionId: string, options: { project?: unknown; here?: unknown } = {}): Promise<AgentView[]> {
    const rows = await this.rows(userId);
    const me = rows.find((r) => r.id === sessionId);
    if (!me) throw notFound("Calling session not found");
    const crossOk = await this.crossAllowed(userId);
    const wanted = typeof options.project === "string" && options.project.trim() ? options.project.trim().toLowerCase() : null;
    return rows
      .map((r) => ({ r, same: this.sameProject(me, r) }))
      .filter(({ r, same }) => (same || (crossOk && options.here !== true)) && (!wanted || (r.project_name ?? "").toLowerCase().includes(wanted) || r.project_id === wanted))
      .map(({ r, same }) => ({
        id: r.id,
        name: r.title,
        provider: r.provider,
        model: r.model,
        state: r.state,
        lead: r.lead,
        linked: r.id !== me.id,
        self: r.id === me.id,
        role: r.role,
        project: { id: r.project_id, name: this.projectName(r), same },
      }));
  }

  /** Snapshot of another agent: explicit status plus the parsed transcript turn (null without a transcript). */
  private snapshot(live: Session, userId: string) {
    const turn = this.manager.readAgentTurn(live.id, userId);
    const status = agentStatus({
      alive: live.isAlive,
      sessionState: live.state,
      turn,
      outputQuietMs: Date.now() - live.lastActivity,
      transcriptQuietMs: turn ? Date.now() - turn.mtimeMs : Infinity,
    });
    return { turn, status };
  }

  private terminalTail(live: Session): string {
    return stripAnsi(live.replaySince(0).chunks.map((c) => c.data).join("")).trim();
  }

  /** Read another agent's status and last reply. A finished turn returns the full reply from its transcript. */
  async check(userId: string, sessionId: string, name: unknown, chars?: number, full = false) {
    const { me, other } = await this.target(userId, sessionId, name);
    return this.scrubResult(userId, [other.id, me.id], await this.checkRaw(userId, other, chars, full));
  }

  private async checkRaw(userId: string, other: { id: string; title: string; state: string }, chars: number | undefined, full: boolean) {
    const live = this.manager.findLive(other.id, userId);
    if (!live) return { id: other.id, name: other.title, state: other.state, status: "asleep" as AgentStatus, source: "none", output: "(agent is asleep; use ask to wake it)", truncated: 0 };
    const { turn, status } = this.snapshot(live, userId);
    if (turn?.reply && status === "idle") {
      const cut = truncateReply(turn.reply, full ? null : chars ? Math.max(chars, 200) : DEFAULT_REPLY_CHARS);
      return { id: other.id, name: other.title, state: live.state, status, source: "transcript", output: cut.text, truncated: cut.truncated };
    }
    const tail = this.terminalTail(live);
    const limit = full ? MAX_REPLY_CHARS : Math.min(Math.max(chars ?? 6000, 200), MAX_REPLY_CHARS);
    return { id: other.id, name: other.title, state: live.state, status, source: "terminal", output: tail.slice(-limit), truncated: Math.max(0, tail.length - limit) };
  }

  /**
   * Poll until the transcript shows a completed turn after `afterPrompts` user prompts, the agent needs input, it
   * exits, or the timeout hits. Without a usable transcript it falls back to terminal quiet.
   */
  private async awaitTurn(live: Session, userId: string, afterPrompts: number, timeoutMs: number, sentAt: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { turn, status } = this.snapshot(live, userId);
      const terminalQuiet = Date.now() - Math.max(sentAt, live.lastActivity) >= QUIET_MS;
      if (status === "exited" || status === "asleep") return { why: "exit" as const, turn };
      if (turn) {
        if (turn.prompts > afterPrompts && status === "idle") return { why: "done" as const, turn };
        if (status === "waiting-for-input" && turn.prompts >= afterPrompts) return { why: "waiting-for-input" as const, turn };
        // Our prompt never reached the transcript (unknown format?): fall back to terminal quiet.
        if (turn.prompts <= afterPrompts && Date.now() - sentAt > TRANSCRIPT_REGISTER_MS && terminalQuiet) return { why: "quiet" as const, turn };
      } else if (terminalQuiet) {
        return { why: "quiet" as const, turn };
      }
      if (Date.now() >= deadline) return { why: "timeout" as const, turn };
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  private turnResult(other: { id: string; title: string }, live: Session, why: string, turn: TranscriptTurn | null, chars: number | undefined, full: boolean, collected = "") {
    const limit = full ? null : chars ? Math.max(chars, 200) : DEFAULT_REPLY_CHARS;
    if (turn?.reply && (why === "done" || why === "quiet")) {
      const cut = truncateReply(turn.reply, limit);
      return { id: other.id, name: other.title, status: why, source: "transcript", output: cut.text, truncated: cut.truncated };
    }
    const tail = (collected || this.terminalTail(live)).slice(-(limit ?? MAX_REPLY_CHARS));
    return { id: other.id, name: other.title, status: why, source: "terminal", output: tail, truncated: 0 };
  }

  /** Block until an agent finishes its current turn, then return its full last reply (`floq wait`). */
  async wait(userId: string, sessionId: string, name: unknown, timeoutSec?: number, chars?: number, full = false) {
    const { me, other } = await this.target(userId, sessionId, name);
    const live = this.manager.findLive(other.id, userId);
    if (!live) return { id: other.id, name: other.title, status: "asleep", source: "none", output: "(agent is asleep; use ask to wake it)", truncated: 0 };
    const timeoutMs = Math.min(Math.max((timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, 10_000), MAX_TIMEOUT_MS);
    // An idle agent satisfies "prompts > afterPrompts" at once; a working one only when its open turn completes.
    const afterPrompts = Math.max(0, (this.manager.readAgentTurn(other.id, userId)?.prompts ?? 0) - 1);
    await this.links?.upsert(me.id, other.id, "message", "none").catch(() => undefined); // wire only; no event until a message moves
    const { why, turn } = await this.awaitTurn(live, userId, afterPrompts, timeoutMs, 0);
    if (why === "done" && turn?.reply) await this.links?.record(userId, other.id, me.id, "message", "reply", "reply", await this.scrub(userId, [other.id, me.id], turn.reply));
    return this.scrubResult(userId, [other.id, me.id], this.turnResult(other, live, why, turn, chars, full));
  }

  /** Type a message into another agent's terminal; by default wait for its turn to finish and return the full reply. */
  async ask(userId: string, sessionId: string, name: unknown, prompt: unknown, timeoutSec?: number, wait = true, chars?: number, full = false) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 20_000) throw badRequest("prompt required (max 20000 chars)");
    const { me, other, cross } = await this.target(userId, sessionId, name);
    // Cross-project: size cap, rate limit, dedupe and loop protection run BEFORE anything is typed or woken.
    const hop = cross ? this.cross.admit(me.id, other.id, prompt).hop : 0;
    const timeoutMs = Math.min(Math.max((timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, 10_000), MAX_TIMEOUT_MS);

    let live = this.manager.findLive(other.id, userId);
    if (!live || !live.isAlive) {
      await this.manager.resume(userId, await this.settings.profile(userId), other.id);
      live = this.manager.findLive(other.id, userId);
      if (!live) throw conflict("Could not wake the agent");
      await new Promise((r) => setTimeout(r, 6_000)); // let the TUI start before typing
    }
    const target = live;

    const afterPrompts = this.manager.readAgentTurn(other.id, userId)?.prompts ?? 0;
    const collected: string[] = [];
    const unsubscribe = target.subscribe((frame) => { if (frame.type === "output") collected.push(frame.data); });
    try {
      const original = prompt;
      const body = prompt.replace(/\r?\n/g, " ").trim();
      const from = { id: me.id, title: me.title, projectName: this.projectName(me) };
      // Long bodies are never typed into a terminal (the tail survives, the head is lost): the full text goes to the receiver's inbox.
      let typedBody = body;
      let delivery: { mode: "full" | "inbox"; chars: number; sha256: string; inboxId?: string } = { mode: "full", chars: body.length, sha256: sha256Prefix(body) };
      if (needsInbox(body)) {
        const stored = await this.inbox.store(userId, from, other.id, await this.scrub(userId, [other.id, me.id], original));
        typedBody = inboxPointer(body, stored.id, stored.chars);
        delivery = { mode: "inbox", chars: stored.chars, sha256: stored.sha256, inboxId: stored.id };
      }
      const typed = await this.scrub(userId, [other.id, me.id], cross
        ? buildProvenance(from, hop) + " " + typedBody + buildReplyHint(from, wait)
        : "[Message from agent " + me.title + "] " + typedBody);
      await serialPerTarget(other.id, () => typeMessage((d) => target.write(d), typed, { bracketed: this.bracketed(target) }));
      if (cross) log.info("agent.cross_project_message", { userId, fromSessionId: me.id, toSessionId: other.id, fromProjectId: me.project_id, toProjectId: other.project_id, chars: body.length, hop, wait });
      log.info("agent.message_delivered", { userId, fromSessionId: me.id, toSessionId: other.id, mode: delivery.mode, chars: delivery.chars, typedChars: typed.length, sha256: delivery.sha256, inboxId: delivery.inboxId, cross });
      await this.links?.record(userId, me.id, other.id, "message", "message", "ask", await this.scrub(userId, [other.id, me.id], body), cross ? { fromTitle: me.title, toTitle: other.title, fromProject: this.projectName(me), toProject: this.projectName(other), toProjectId: other.project_id } : undefined);
      if (!wait) return { id: other.id, name: other.title, status: "sent", source: "none", output: "", truncated: 0, delivery };
      const { why, turn } = await this.awaitTurn(target, userId, afterPrompts, timeoutMs, Date.now());
      if ((why === "done" || why === "quiet") && turn?.reply) await this.links?.record(userId, other.id, me.id, "message", "reply", "reply", await this.scrub(userId, [other.id, me.id], turn.reply));
      return this.scrubResult(userId, [other.id, me.id], { ...this.turnResult(other, target, why, turn, chars, full, stripAnsi(collected.join("")).trim()), delivery });
    } finally {
      unsubscribe();
    }
  }

  /** Agents in one project are always connected: success within the project, 403 across projects. */
  async connect(userId: string, sessionId: string, from: unknown, to: unknown) {
    const me = await this.caller(userId, sessionId);
    if (!me.lead) throw new HttpError(403, "not_lead", "Only a lead agent can connect agents");
    const a = await this.resolve(userId, from);
    const b = await this.resolve(userId, to);
    if (a.id === b.id) throw badRequest("Cannot connect an agent to itself");
    if (!this.sameProject(me, a) || !this.sameProject(me, b)) {
      throw new HttpError(403, "other_project", "Agents outside your project cannot be connected with `floq connect`; use `floq link <agent>` to wire yourself to an agent of another project");
    }
    return { ok: true };
  }

  /**
   * `floq link`: wire the caller to any agent of the same user, including other projects. The wire appears on the
   * caller's canvas as a labelled chip for a foreign agent, and both agents' wired context lists the other.
   */
  async link(userId: string, sessionId: string, name: unknown) {
    const { me, other, cross } = await this.target(userId, sessionId, name);
    if (!this.links) throw conflict("Agent links are not available");
    const link = await this.links.upsert(me.id, other.id, "manual", "none");
    if (cross) log.info("agent.cross_project_link", { userId, fromSessionId: me.id, toSessionId: other.id, fromProjectId: me.project_id, toProjectId: other.project_id });
    return { ok: true, linkId: link.id, ids: [me.id, other.id], cross, project: this.projectName(other) };
  }

  /** `skipOrchestratorCheck` is only for SubagentService, which enforces its own depth/children/total limits. `prompt` is the first message. */
  async recruit(userId: string, sessionId: string, input: { name?: unknown; provider?: unknown; model?: unknown; cwd?: unknown; role?: unknown; isolated?: unknown; prompt?: unknown; wire?: unknown; skills?: unknown }, options: { skipOrchestratorCheck?: boolean } = {}) {
    const skills = parseRecruitSkills(input.skills);
    const me = await this.caller(userId, sessionId);
    if (!options.skipOrchestratorCheck) assertCanRecruit(me, await this.rows(userId), (a, b) => this.sameProject(a, b));
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 60) throw badRequest("name required (max 60 chars)");
    if ((await this.rows(userId)).some((r) => r.title.toLowerCase() === name.toLowerCase())) throw conflict('An agent named "' + name + '" already exists');
    const provider = input.provider === "codex" ? "codex" : "claude";
    if (input.model !== undefined && typeof input.model !== "string") throw badRequest("model must be a configured model id");
    // `--role` is a preset id (see `floq roles`); any other value is the older free-text brief typed into the terminal.
    const roleText = typeof input.role === "string" ? input.role.trim() : "";
    if (roleText && /^[a-z][a-z0-9-]*$/.test(roleText) && roleText !== GENERALIST_ID && !getAgentRole(roleText) && roleText.length <= 20) {
      throw badRequest("Unknown role \"" + roleText + "\"; run `floq roles` to list presets", "invalid_role");
    }
    const rolePreset = roleText && (roleText === GENERALIST_ID || getAgentRole(roleText)) ? roleText : undefined;
    // New agents join the lead's project: same cwd unless an equivalent path inside it is given.
    const requestedCwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    let cwd = requestedCwd ?? me.cwd;
    let workspaceId = me.workspace_id ?? undefined;
    const allowedPaths = new Set([me.cwd, me.project_cwd].filter((path): path is string => path !== null && path !== undefined).map(projectPath));
    if (requestedCwd && me.project_id) {
      let normalizedCwd: string;
      try {
        normalizedCwd = safeRelative(requestedCwd);
      } catch {
        throw badRequest("cwd must match a registered workspace in this project", "invalid_cwd");
      }
      const result = await this.pool.query(
        "SELECT id,cwd FROM floq_project_workspaces WHERE project_id=$1 AND user_id=$2 AND cwd=$3 LIMIT 1",
        [me.project_id, userId, normalizedCwd],
      );
      const workspace = result.rows[0] as { id?: unknown; cwd?: unknown } | undefined;
      if (!workspace || typeof workspace.id !== "string" || typeof workspace.cwd !== "string" || projectPath(workspace.cwd) !== normalizedCwd) {
        throw badRequest("cwd must match a registered workspace in this project", "invalid_cwd");
      }
      cwd = safeRelative(workspace.cwd);
      workspaceId = workspace.id;
    } else if (requestedCwd && !allowedPaths.has(projectPath(requestedCwd)) && (me.project_cwd || me.git_url || projectOf(requestedCwd) !== projectOf(me.cwd))) {
      throw new HttpError(403, "other_project", "cwd is outside your project");
    }
    const created: SessionSummary = await this.manager.create(userId, await this.settings.profile(userId), {
      provider,
      model: input.model as string | undefined,
      role: rolePreset,
      prompt: options.skipOrchestratorCheck && typeof input.prompt === "string" ? input.prompt : undefined,
      title: name,
      cwd: cwd ?? undefined,
      projectId: me.project_id ?? undefined,
      workspaceId,
    }, {
      projectCwd: me.project_cwd ?? (me.git_url ? me.cwd : projectOf(me.cwd) === "(scratch)" ? null : me.cwd),
      projectGitUrl: me.git_url,
      isolated: input.isolated === true,
      parentSessionId: me.id,
      skills,
    });
    if (rolePreset !== undefined) {
      // Preset roles are injected into the first message by SessionManager.create.
    } else if (typeof input.role === "string" && input.role.trim()) {
      const live = this.manager.findLive(created.id, userId);
      const role = input.role.replace(/\r?\n/g, " ").trim().slice(0, 4000);
      setTimeout(() => {
        live?.write(role);
        setTimeout(() => live?.write("\r"), 300);
      }, 6_000).unref();
    }
    if (input.wire !== false) await this.links?.record(userId, me.id, created.id, "recruit", "none", "recruit", roleText || "Recruited " + name + (provider === "codex" ? " (codex)" : ""));
    return { id: created.id, name, provider, model: created.model ?? "default", state: created.state, skills };
  }

  async dismiss(userId: string, sessionId: string, name: unknown) {
    const me = await this.caller(userId, sessionId);
    if (!me.lead) throw new HttpError(403, "not_lead", "Only a lead agent can dismiss agents");
    const other = await this.resolve(userId, name);
    if (other.id === me.id) throw badRequest("A lead cannot dismiss itself");
    if (!this.sameProject(me, other)) throw new HttpError(403, "other_project", "That agent is in a different project");
    await this.manager.remove(other.id, userId);
    return { ok: true };
  }

  // --- shared notes (visible to all of one user's agents) ---
  private noteName(name: unknown): string {
    if (typeof name !== "string" || !NOTE_NAME.test(name)) throw badRequest("note name must be 1-80 chars of letters, digits, space, . _ -");
    return name;
  }

  async noteWrite(userId: string, name: unknown, content: unknown, append: boolean) {
    const n = this.noteName(name);
    if (typeof content !== "string" || content.length > 100_000) throw badRequest("content required (max 100000 chars)");
    await this.pool.query(
      `INSERT INTO agent_notes (user_id, name, content) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, name) DO UPDATE SET content = ${append ? "agent_notes.content || E'\\n' || EXCLUDED.content" : "EXCLUDED.content"}, updated_at = now()`,
      [userId, n, content],
    );
    return { ok: true };
  }

  async noteRead(userId: string, name: unknown) {
    const r = await this.pool.query("SELECT content FROM agent_notes WHERE user_id = $1 AND name = $2", [userId, this.noteName(name)]);
    if (!r.rows[0]) throw notFound("Note not found");
    return { content: r.rows[0].content as string };
  }

  async noteList(userId: string) {
    const r = await this.pool.query("SELECT name, updated_at FROM agent_notes WHERE user_id = $1 ORDER BY name", [userId]);
    return { notes: r.rows.map((x) => ({ name: x.name as string, updatedAt: new Date(x.updated_at).toISOString() })) };
  }
}

function projectPath(path: string): string {
  try {
    return safeRelative(path);
  } catch {
    return path;
  }
}
