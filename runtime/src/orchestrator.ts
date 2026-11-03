import type pg from "pg";
import type { ModelEntry } from "./config.js";
import { HttpError, badRequest, conflict, notFound } from "./errors.js";
import { safeRelative } from "./shard.js";
import type { SessionManager } from "./manager.js";
import type { SettingsStore } from "./settings.js";
import { getAgentRole, GENERALIST_ID } from "./roles.js";
import type { ProviderId, SessionSummary } from "./types.js";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const QUIET_MS = 5_000;
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

export class Orchestrator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly manager: SessionManager,
    private readonly settings: SettingsStore,
  ) {}

  private async rows(userId: string) {
    return (await this.pool.query("SELECT id, title, provider, model, state, lead, cwd, git_url, project_cwd, project_id, workspace_id FROM agent_sessions WHERE user_id = $1 AND provider <> 'shell'", [userId])).rows as Array<{
      id: string;
      title: string;
      provider: ProviderId;
      model: string | null;
      state: string;
      lead: boolean;
      cwd: string | null;
      git_url: string | null;
      project_cwd: string | null;
      project_id: string | null;
      workspace_id: string | null;
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
  async toolkitCaller(userId: string, sessionId: string, requireLead: boolean): Promise<{ id: string; projectId: string | null; provider: "claude" | "codex" }> {
    const me = await this.caller(userId, sessionId);
    if (requireLead && !me.lead) throw new HttpError(403, "not_lead", "Only a lead agent can install or remove skills and MCP servers or create secrets");
    return { id: me.id, projectId: me.project_id, provider: me.provider as "claude" | "codex" };
  }

  private async target(userId: string, sessionId: string, name: unknown) {
    const me = await this.caller(userId, sessionId);
    const other = await this.resolve(userId, name);
    if (other.id === me.id) throw badRequest("An agent cannot target itself");
    if (!this.sameProject(me, other)) {
      throw new HttpError(403, "not_linked", '"' + other.title + '" is in a different project');
    }
    return { me, other };
  }

  async list(userId: string, sessionId: string): Promise<AgentView[]> {
    const rows = await this.rows(userId);
    const me = rows.find((r) => r.id === sessionId);
    if (!me) throw notFound("Calling session not found");
    return rows
      .filter((r) => this.sameProject(me, r))
      .map((r) => ({
        id: r.id,
        name: r.title,
        provider: r.provider,
        model: r.model,
        state: r.state,
        lead: r.lead,
        linked: r.id !== me.id,
        self: r.id === me.id,
      }));
  }

  /** Read recent terminal output of a connected agent. */
  async check(userId: string, sessionId: string, name: unknown, chars = 6000) {
    const { other } = await this.target(userId, sessionId, name);
    const live = this.manager.findLive(other.id, userId);
    if (!live) return { id: other.id, name: other.title, state: other.state, output: "(agent is asleep; use ask to wake it)" };
    const text = live
      .replaySince(0)
      .chunks.map((c) => c.data)
      .join("");
    const out = stripAnsi(text);
    return { id: other.id, name: other.title, state: live.state, output: out.slice(-Math.min(Math.max(chars, 200), MAX_REPLY_CHARS)) };
  }

  /** Type a message into another agent's terminal and return what it prints until it goes quiet. */
  async ask(userId: string, sessionId: string, name: unknown, prompt: unknown, timeoutSec?: number) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 20_000) throw badRequest("prompt required (max 20000 chars)");
    const { me, other } = await this.target(userId, sessionId, name);
    const timeoutMs = Math.min(Math.max((timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, 10_000), MAX_TIMEOUT_MS);

    let live = this.manager.findLive(other.id, userId);
    if (!live || !live.isAlive) {
      await this.manager.resume(userId, await this.settings.profile(userId), other.id);
      live = this.manager.findLive(other.id, userId);
      if (!live) throw conflict("Could not wake the agent");
      await new Promise((r) => setTimeout(r, 6_000)); // let the TUI start before typing
    }
    const target = live;

    const collected: string[] = [];
    let lastData = 0;
    const done = new Promise<"quiet" | "timeout" | "exit">((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      const finish = (why: "quiet" | "timeout" | "exit") => {
        clearTimeout(quiet);
        clearTimeout(hard);
        unsubscribe();
        resolve(why);
      };
      const arm = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => finish("quiet"), QUIET_MS);
      };
      const hard = setTimeout(() => finish("timeout"), timeoutMs);
      const unsubscribe = target.subscribe((frame) => {
        if (frame.type === "output") {
          collected.push(frame.data);
          lastData = Date.now();
          arm();
        } else if (frame.type === "exit" || frame.type === "state") {
          finish("exit");
        }
      });
      arm();
    });

    const body = prompt.replace(/\r?\n/g, " ").trim();
    target.write("[Message from agent " + me.title + "] " + body);
    await new Promise((r) => setTimeout(r, 300));
    target.write("\r");

    const why = await done;
    const output = stripAnsi(collected.join("")).trim();
    return {
      id: other.id,
      name: other.title,
      status: why,
      idleMs: lastData ? Date.now() - lastData : null,
      output: output.slice(-MAX_REPLY_CHARS),
    };
  }

  /** Agents in one project are always connected: success within the project, 403 across projects. */
  async connect(userId: string, sessionId: string, from: unknown, to: unknown) {
    const me = await this.caller(userId, sessionId);
    if (!me.lead) throw new HttpError(403, "not_lead", "Only a lead agent can connect agents");
    const a = await this.resolve(userId, from);
    const b = await this.resolve(userId, to);
    if (a.id === b.id) throw badRequest("Cannot connect an agent to itself");
    if (!this.sameProject(me, a) || !this.sameProject(me, b)) {
      throw new HttpError(403, "other_project", "Agents outside your project cannot be connected");
    }
    return { ok: true };
  }

  async recruit(userId: string, sessionId: string, input: { name?: unknown; provider?: unknown; model?: unknown; cwd?: unknown; role?: unknown; isolated?: unknown }) {
    const me = await this.caller(userId, sessionId);
    if (!me.lead) throw new HttpError(403, "not_lead", "Only a lead agent can recruit agents");
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
      title: name,
      cwd: cwd ?? undefined,
      projectId: me.project_id ?? undefined,
      workspaceId,
    }, {
      projectCwd: me.project_cwd ?? (me.git_url ? me.cwd : projectOf(me.cwd) === "(scratch)" ? null : me.cwd),
      projectGitUrl: me.git_url,
      isolated: input.isolated === true,
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
    return { id: created.id, name, provider, model: created.model ?? "default", state: created.state };
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
