import type { CredentialBroker, CredentialData, OAuthProvider } from "./credentials.js";
import { log } from "./logger.js";

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  /** Extra text for the popover, e.g. "$12.30 of $50.00" for overage credits. */
  detail?: string;
}

export interface ProviderUsage {
  connected: boolean;
  plan: string | null;
  windows: UsageWindow[];
  fetchedAt: string;
  error?: string;
}

const CACHE_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

// Endpoints and headers as used by the installed CLIs (Claude Code 2.1.319 /usage, codex-cli 0.166.0 /status).
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA = "oauth-2025-04-20";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const CLAUDE_WINDOWS: Array<[string, string]> = [
  ["five_hour", "Current session (5h)"],
  ["seven_day", "Weekly"],
  ["seven_day_opus", "Weekly · Opus"],
  ["seven_day_sonnet", "Weekly · Sonnet"],
  ["seven_day_oauth_apps", "Weekly · OAuth apps"],
];

/** Display name for a Claude plan: Max 5x / Max 20x come from rateLimitTier (e.g. "default_claude_max_5x"). */
export function claudePlanLabel(subscriptionType: unknown, rateLimitTier?: unknown): string | null {
  const type = typeof subscriptionType === "string" ? subscriptionType.trim().toLowerCase() : "";
  const tier = typeof rateLimitTier === "string" ? rateLimitTier.toLowerCase() : "";
  const multiplier = /max_?(\d+)x/.exec(tier)?.[1];
  if (type === "max" || (!type && multiplier)) return multiplier ? `Max ${multiplier}x` : "Max";
  if (!type) return null;
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
}

function money(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

/** Maps the /api/oauth/usage payload to windows: missing/null windows are skipped, null utilization is not 0%. */
export function parseClaudeUsage(body: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [id, label] of CLAUDE_WINDOWS) {
    const w = body[id];
    if (!w || typeof w !== "object") continue;
    const used = percent((w as Record<string, unknown>).utilization);
    if (used !== null) windows.push({ id, label, usedPercent: used, resetsAt: isoOf((w as Record<string, unknown>).resets_at) });
  }
  const extra = body.extra_usage as Record<string, unknown> | null | undefined;
  if (extra && typeof extra === "object" && extra.is_enabled !== false) {
    const limit = Number(extra.monthly_limit);
    const usedCredits = Number(extra.used_credits);
    const hasMoney = extra.monthly_limit != null && Number.isFinite(limit) && limit > 0 && extra.used_credits != null && Number.isFinite(usedCredits);
    const used = percent(extra.utilization) ?? (hasMoney ? percent((usedCredits / limit) * 100) : null);
    if (used !== null) {
      windows.push({ id: "extra_usage", label: "Extra usage", usedPercent: used, resetsAt: null, ...(hasMoney ? { detail: `${money(usedCredits)} of ${money(limit)}` } : {}) });
    }
  }
  return windows;
}

/** Turns a failed usage request into text the footer can show. */
export function usageErrorMessage(status: number, provider: string): string {
  const name = provider === "claude" ? "Claude" : "Codex";
  if (status === 401) return `${name} sign-in expired, reconnect it in Settings`;
  if (status === 403) return `${name} token cannot read usage (missing scope), reconnect it in Settings`;
  return "HTTP " + status;
}

interface Entry {
  value: ProviderUsage;
  at: number;
  backoffUntil: number;
}

function percent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 10) / 10)) : null;
}

function isoOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value > 1e12 ? value : value * 1000).toISOString();
  if (typeof value === "string" && value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

/** Subscription plan limits ("/usage" in Claude Code, "/status" in Codex), fetched with the stored OAuth credential. */
export class UsageService {
  private readonly cache = new Map<string, Entry>();
  private readonly shapeLogged = new Set<string>();

  constructor(private readonly credentials: CredentialBroker) {}

  async get(userId: string): Promise<Record<OAuthProvider, ProviderUsage | null>> {
    const [claude, codex] = await Promise.all([this.one(userId, "claude"), this.one(userId, "codex")]);
    return { claude, codex };
  }

  private async one(userId: string, provider: OAuthProvider): Promise<ProviderUsage | null> {
    const key = userId + ":" + provider;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    if (cached && Date.now() < cached.backoffUntil) return cached.value;

    await this.credentials.refresh(userId, provider);
    const data = await this.credentials.get(userId, provider);
    if (!data) {
      this.cache.delete(key);
      return null;
    }
    const plan = provider === "claude" ? claudePlanLabel(data.subscriptionType, data.rateLimitTier) : this.codexPlan(data);
    try {
      const windows = provider === "claude" ? await this.claude(data) : await this.codex(data);
      const value: ProviderUsage = { connected: true, plan, windows, fetchedAt: new Date().toISOString() };
      if (windows.length === 0) value.error = "No plan usage reported for this account";
      this.cache.set(key, { value, at: Date.now(), backoffUntil: 0 });
      return value;
    } catch (error) {
      const rateLimited = error instanceof Error && error.message === "rate_limited";
      const message = rateLimited ? "Rate limited, showing the last value" : error instanceof Error ? error.message : "Could not load usage";
      const last = cached?.value;
      const value: ProviderUsage = {
        connected: true,
        plan,
        windows: last?.windows ?? [],
        fetchedAt: last?.fetchedAt ?? new Date().toISOString(),
        error: message,
      };
      this.cache.set(key, { value, at: Date.now(), backoffUntil: rateLimited ? Date.now() + RATE_LIMIT_BACKOFF_MS : 0 });
      log.warn("usage.fetch_failed", { userId, provider, reason: message });
      return value;
    }
  }

  private async getJson(url: string, headers: Record<string, string>, provider: string): Promise<Record<string, unknown>> {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "floq-runtime", ...headers }, signal: AbortSignal.timeout(15_000) });
    if (response.status === 429) throw new Error("rate_limited");
    if (!response.ok) throw new Error(usageErrorMessage(response.status, provider));
    const body = (await response.json()) as Record<string, unknown>;
    if (!this.shapeLogged.has(provider)) {
      this.shapeLogged.add(provider);
      log.info("usage.shape", { provider, keys: Object.keys(body) }); // key names only, no values
    }
    return body;
  }

  private async claude(data: CredentialData): Promise<UsageWindow[]> {
    const body = await this.getJson(CLAUDE_USAGE_URL, { Authorization: `Bearer ${String(data.accessToken)}`, "anthropic-beta": CLAUDE_BETA }, "claude");
    return parseClaudeUsage(body);
  }

  private codexPlan(data: CredentialData): string | null {
    try {
      const idToken = (data.tokens as Record<string, unknown> | undefined)?.id_token;
      const claims = JSON.parse(Buffer.from(String(idToken).split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
      const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
      return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null;
    } catch {
      return null;
    }
  }

  private async codex(data: CredentialData): Promise<UsageWindow[]> {
    const tokens = (data.tokens ?? {}) as Record<string, unknown>;
    const headers: Record<string, string> = { Authorization: `Bearer ${String(tokens.access_token)}` };
    if (typeof tokens.account_id === "string") headers["chatgpt-account-id"] = tokens.account_id;
    const body = await this.getJson(CODEX_USAGE_URL, headers, "codex");
    const limits = (body.rate_limit ?? body.rate_limits) as Record<string, unknown> | undefined;
    const windows: UsageWindow[] = [];
    for (const [id, fallback] of [["primary_window", "Current session (5h)"], ["secondary_window", "Weekly"]] as const) {
      const w = limits?.[id] as Record<string, unknown> | null | undefined;
      const used = percent(w?.used_percent);
      if (!w || used === null) continue;
      const seconds = Number(w.limit_window_seconds);
      const label = !Number.isFinite(seconds) ? fallback : seconds <= 6 * 3600 ? `Current session (${Math.round(seconds / 3600)}h)` : seconds >= 6 * 86400 ? "Weekly" : `${Math.round(seconds / 3600)}h window`;
      const resetsAt = isoOf(w.reset_at) ?? (Number.isFinite(Number(w.reset_after_seconds)) ? new Date(Date.now() + Number(w.reset_after_seconds) * 1000).toISOString() : null);
      windows.push({ id: id === "primary_window" ? "primary" : "secondary", label, usedPercent: used, resetsAt });
    }
    return windows;
  }
}
