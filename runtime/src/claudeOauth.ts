import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { CredentialBroker, CredentialData } from "./credentials.js";
import { HttpError, badRequest } from "./errors.js";
import { log } from "./logger.js";
import type { ClaudeAccounts } from "./claudeAccounts.js";

/** Same values the Claude Code CLI uses for its manual (copy-the-code) login. */
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
export const CLAUDE_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const FLOW_TTL_MS = 10 * 60_000;
const MAX_PENDING_PER_USER = 3;

interface Flow {
  userId: string;
  verifier: string;
  state: string;
  expiresAt: number;
}

const b64url = (buffer: Buffer) => buffer.toString("base64url");

/**
 * Server-side OAuth authorization-code + PKCE login for a Claude subscription (no terminal involved).
 * The pasted value from the callback page is "<code>#<state>". Codes, verifiers and tokens are never logged.
 */
export class ClaudeOAuth {
  private readonly flows = new Map<string, Flow>();

  /** Called with the new credential once it is stored (distribute to running sessions). */
  onConnected: (userId: string, data: CredentialData) => void = () => undefined;
  /** When set, a login started with addAccount is stored as a reserve account instead of replacing the active one. */
  accounts?: ClaudeAccounts;

  constructor(
    private readonly config: Config,
    private readonly credentials: CredentialBroker,
  ) {}

  private prune(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) if (flow.expiresAt < now) this.flows.delete(id);
  }

  start(userId: string): { flowId: string; authorizeUrl: string } {
    this.prune();
    const mine = [...this.flows.entries()].filter(([, flow]) => flow.userId === userId);
    while (mine.length >= MAX_PENDING_PER_USER) {
      const oldest = mine.shift();
      if (oldest) this.flows.delete(oldest[0]);
    }
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(32));
    const flowId = randomUUID();
    this.flows.set(flowId, { userId, verifier, state, expiresAt: Date.now() + FLOW_TTL_MS });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", this.config.oauth.claude.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", MANUAL_REDIRECT_URL);
    url.searchParams.set("scope", CLAUDE_SCOPES.join(" "));
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return { flowId, authorizeUrl: url.toString() };
  }

  async finish(userId: string, flowId: unknown, pasted: unknown, extra: { addAccount?: boolean; label?: unknown } = {}): Promise<{ connected: true; plan: string | null; slot?: string }> {
    this.prune();
    if (typeof flowId !== "string" || typeof pasted !== "string" || !pasted.trim() || pasted.length > 2000) {
      throw badRequest("flowId and code are required");
    }
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId) throw new HttpError(410, "flow_expired", "This login expired. Start again.");

    const [code, pastedState] = pasted.trim().split("#");
    if (!code) throw badRequest("code is required");
    if (pastedState !== undefined && pastedState !== flow.state) {
      throw badRequest("That code belongs to a different login attempt. Start again.", "invalid_code");
    }

    let response: Response;
    try {
      response = await fetch(this.config.oauth.claude.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "floq-runtime" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: MANUAL_REDIRECT_URL,
          client_id: this.config.oauth.claude.clientId,
          code_verifier: flow.verifier,
          state: flow.state,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      log.warn("claude_oauth.network", { error: error instanceof Error ? error.message : String(error) });
      throw new HttpError(502, "oauth_unreachable", "Could not reach Anthropic. Try again.");
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 429) {
      // The flow stays alive so the same code can be submitted again.
      throw new HttpError(429, "rate_limited", "Anthropic is rate-limiting sign-ins right now. Wait a minute and submit the same code again.");
    }
    if (response.status === 400 || response.status === 401) {
      log.info("claude_oauth.rejected", { status: response.status });
      throw badRequest("That code wasn't accepted. Start the login again and paste the new code.", "invalid_code");
    }
    if (!response.ok || typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
      log.warn("claude_oauth.failed", { status: response.status });
      throw new HttpError(502, "oauth_failed", "Anthropic did not complete the login. Try again.");
    }
    this.flows.delete(flowId);

    const data: CredentialData = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
      scopes: typeof payload.scope === "string" && payload.scope ? payload.scope.split(" ") : CLAUDE_SCOPES,
      ...(await this.profile(payload.access_token)),
    };
    if (extra.addAccount) {
      if (!this.accounts) throw badRequest("Multiple Claude accounts are not available", "accounts_unavailable");
      const added = await this.accounts.add(userId, data, extra.label);
      log.info("login.connected", { userId, provider: "claude", via: "oauth", slot: added.slot });
      return { connected: true, plan: added.plan, slot: added.slot };
    }
    await this.credentials.save(userId, "claude", data);
    this.onConnected(userId, data);
    log.info("login.connected", { userId, provider: "claude", via: "oauth" });
    return { connected: true, plan: typeof data.subscriptionType === "string" ? data.subscriptionType : null };
  }

  /** Best effort: the CLI reads the plan from the profile endpoint after login. */
  private async profile(accessToken: string): Promise<{ subscriptionType: string | null; rateLimitTier: string | null }> {
    const subscriptionType = await this.subscriptionType(accessToken);
    return { subscriptionType: subscriptionType.type, rateLimitTier: subscriptionType.tier };
  }

  private async subscriptionType(accessToken: string): Promise<{ type: string | null; tier: string | null }> {
    const none = { type: null, tier: null };
    try {
      const response = await fetch(PROFILE_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "floq-runtime" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return none;
      const profile = (await response.json()) as { organization?: { organization_type?: string; rate_limit_tier?: string }; account?: Record<string, unknown> };
      const type = profile.organization?.organization_type;
      const tier = typeof profile.organization?.rate_limit_tier === "string" ? profile.organization.rate_limit_tier : null;
      if (type === "claude_max") return { type: "max", tier };
      if (type === "claude_pro") return { type: "pro", tier };
      if (type === "claude_enterprise") return { type: "enterprise", tier };
      if (type === "claude_team") return { type: "team", tier };
      if (profile.account?.has_claude_max) return { type: "max", tier };
      if (profile.account?.has_claude_pro) return { type: "pro", tier };
      return none;
    } catch {
      return none;
    }
  }
}
