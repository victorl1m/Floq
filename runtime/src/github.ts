import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { HttpError, badRequest, notFound } from "./errors.js";
import type { SettingsStore } from "./settings.js";

// What `gh auth login` requests.
const SCOPE = "repo read:org workflow gist";
const MAX_PENDING_PER_USER = 3;

interface PendingFlow {
  userId: string;
  deviceCode: string;
  expiresAt: number;
  nextPollAt: number;
  interval: number;
}

export type PollResult =
  | { status: "pending"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "connected"; login: string };

/** GitHub OAuth device flow (the `github.com/login/device` experience). */
export class GithubLinker {
  private readonly flows = new Map<string, PendingFlow>();

  constructor(
    private readonly config: Config,
    private readonly settings: SettingsStore,
  ) {}

  private clientId(): string {
    if (!this.config.githubClientId) {
      throw new HttpError(501, "github_not_configured", "GITHUB_CLIENT_ID is not set on the server");
    }
    return this.config.githubClientId;
  }

  private async post(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "floq-runtime" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new HttpError(502, "github_error", `GitHub responded ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) if (flow.expiresAt < now) this.flows.delete(id);
  }

  async start(userId: string) {
    this.prune();
    const mine = [...this.flows.entries()].filter(([, f]) => f.userId === userId);
    if (mine.length >= MAX_PENDING_PER_USER) this.flows.delete(mine[0][0]);

    const data = await this.post("https://github.com/login/device/code", {
      client_id: this.clientId(),
      scope: SCOPE,
    });
    if (typeof data.device_code !== "string" || typeof data.user_code !== "string") {
      throw new HttpError(502, "github_error", "Unexpected response from GitHub");
    }
    const interval = Number(data.interval) || 5;
    const expiresIn = Number(data.expires_in) || 900;
    const id = randomUUID();
    this.flows.set(id, {
      userId,
      deviceCode: data.device_code,
      expiresAt: Date.now() + expiresIn * 1000,
      nextPollAt: Date.now() + interval * 1000,
      interval,
    });
    // The device_code never leaves the server.
    return {
      flowId: id,
      userCode: data.user_code,
      verificationUri: String(data.verification_uri ?? "https://github.com/login/device"),
      expiresIn,
      interval,
    };
  }

  async poll(userId: string, flowId: unknown): Promise<PollResult> {
    if (typeof flowId !== "string") throw badRequest("flowId required");
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId) throw notFound("Unknown or expired flow");
    if (flow.expiresAt < Date.now()) {
      this.flows.delete(flowId);
      return { status: "expired" };
    }
    if (Date.now() < flow.nextPollAt) return { status: "pending", interval: flow.interval };

    const data = await this.post("https://github.com/login/oauth/access_token", {
      client_id: this.clientId(),
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    if (typeof data.access_token === "string") {
      this.flows.delete(flowId);
      const profile = await this.fetchProfile(data.access_token);
      await this.settings.saveGithub(userId, profile.login, data.access_token, String(data.scope ?? SCOPE), profile.id, profile.name);
      return { status: "connected", login: profile.login };
    }

    switch (data.error) {
      case "authorization_pending":
        flow.nextPollAt = Date.now() + flow.interval * 1000;
        return { status: "pending", interval: flow.interval };
      case "slow_down":
        flow.interval = Number(data.interval) || flow.interval + 5;
        flow.nextPollAt = Date.now() + flow.interval * 1000;
        return { status: "pending", interval: flow.interval };
      case "access_denied":
        this.flows.delete(flowId);
        return { status: "denied" };
      case "expired_token":
        this.flows.delete(flowId);
        return { status: "expired" };
      default:
        this.flows.delete(flowId);
        throw new HttpError(502, "github_error", "GitHub authorization failed");
    }
  }

  private async fetchProfile(token: string): Promise<{ login: string; id: number | null; name: string | null }> {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "floq-runtime" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new HttpError(502, "github_error", "Could not read GitHub profile");
    const user = (await response.json()) as { login?: string; id?: number; name?: string | null };
    if (!user.login) throw new HttpError(502, "github_error", "GitHub profile missing login");
    return { login: user.login, id: typeof user.id === "number" ? user.id : null, name: user.name?.trim() || null };
  }

  /** List (or search) the repositories the connected GitHub account can access. */
  async repos(userId: string, q: string, page: number) {
    const auth = await this.settings.githubAuth(userId);
    if (!auth) throw new HttpError(409, "github_not_connected", "GitHub is not connected");
    const term = q.trim().slice(0, 100);
    const url = term
      ? `https://api.github.com/search/repositories?q=${encodeURIComponent(`${term} in:name user:${auth.login} fork:true`)}&per_page=30&page=${page}`
      : `https://api.github.com/user/repos?sort=updated&per_page=30&page=${page}&affiliation=owner,collaborator,organization_member`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/vnd.github+json", "User-Agent": "floq-runtime" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) {
      await this.settings.removeGithub(userId);
      throw new HttpError(409, "github_not_connected", "GitHub authorization expired; connect again");
    }
    if (!response.ok) throw new HttpError(502, "github_error", `GitHub responded ${response.status}`);
    const body = (await response.json()) as unknown;
    const items = (Array.isArray(body) ? body : ((body as { items?: unknown[] }).items ?? [])) as Array<Record<string, unknown>>;
    const next = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(response.headers.get("link") ?? "");
    return {
      repos: items.map((r) => ({
        fullName: String(r.full_name),
        private: Boolean(r.private),
        description: typeof r.description === "string" ? r.description : null,
        defaultBranch: String(r.default_branch ?? "main"),
        cloneUrl: String(r.clone_url),
        updatedAt: String(r.updated_at ?? r.pushed_at ?? ""),
      })),
      nextPage: next ? Number(next[1]) : null,
    };
  }
}
