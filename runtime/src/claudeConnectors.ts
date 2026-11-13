import type { Config } from "./config.js";
import type { CredentialBroker, CredentialData } from "./credentials.js";
import { log } from "./logger.js";

/**
 * Read-only list of the user's claude.ai connectors (docs/design/agent-browser.md section B).
 *
 * Claude Code loads connectors natively; this only mirrors what it will see so Settings can show it, and says why the
 * list may be empty. The endpoint (`GET /v1/mcp_servers`, the one Claude Code's `claudeai-mcp` loader calls) is
 * undocumented, so every failure degrades to `error: "unavailable"` and the UI keeps the toggle. Only allowlisted
 * fields leave this file: never the token, never an upstream body or message.
 */

const BASE_URL = "https://api.anthropic.com";
const LIST_PATH = "/v1/mcp_servers?limit=1000&include_additional_installs=true";
/** The OAuth beta lets a subscription token call the API; the second is the one Claude Code sends for this endpoint. */
const BETA = "oauth-2025-04-20,mcp-servers-2025-12-04";
const TIMEOUT_MS = 10_000;
const CACHE_MS = 5 * 60_000;
/** A failed lookup is retried sooner than a good one is refreshed. */
const ERROR_CACHE_MS = 30_000;
const SCOPE = "user:mcp_servers";
const MAX_CONNECTORS = 200;

export type ConnectorDiagnostic = "api_key" | "needs_signin" | "missing_scope";

export interface Connector {
  name: string;
  displayName: string;
  /** Host only (no path, query or credentials). */
  host: string;
  connected: boolean;
}

export interface ConnectorsResult {
  /** Why connectors may be off or empty; shown above the list. */
  diagnostics: ConnectorDiagnostic[];
  connectors: Connector[];
  /** Set when the list could not be loaded (never the upstream message). */
  error?: "unavailable";
  fetchedAt: string;
}

const text = (value: unknown, max = 120): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

function hostOf(value: unknown): string {
  if (typeof value !== "string") return "";
  try { return new URL(value).hostname.slice(0, 120); } catch { return ""; }
}

/** Maps the upstream payload (an array, or an object wrapping one) to allowlisted fields. Unknown shapes give []. */
export function parseConnectors(body: unknown): Connector[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as Record<string, unknown>).data ?? (body as Record<string, unknown>).mcp_servers ?? (body as Record<string, unknown>).servers)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: Connector[] = [];
  for (const row of rows.slice(0, MAX_CONNECTORS)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = text(r.name) || text(r.display_name) || text(r.id);
    if (!name) continue;
    const status = text(r.status).toLowerCase();
    // A row that says nothing about its state is listed as connected: Claude Code loads every row it is given.
    const connected = typeof r.connected === "boolean" ? r.connected : status ? status === "connected" || status === "active" : true;
    out.push({ name, displayName: text(r.display_name) || name, host: hostOf(r.url), connected });
  }
  return out;
}

export interface ConnectorsDeps {
  credentials: Pick<CredentialBroker, "get" | "refresh">;
  /** True when ANTHROPIC_API_KEY reaches the user's sessions (host env passed through or allowlisted). */
  apiKeyInEnv: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export function apiKeyReachesSessions(config: Pick<Config, "passHostEnv" | "sessionEnvAllow">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.ANTHROPIC_API_KEY) return false;
  return config.passHostEnv || config.sessionEnvAllow.includes("ANTHROPIC_API_KEY");
}

export class ClaudeConnectors {
  private readonly cache = new Map<string, { at: number; value: ConnectorsResult }>();
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorsDeps) {
    this.doFetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Drop the cached list (the user signed in again or flipped the toggle). */
  invalidate(userId: string, opts: { minAgeMs?: number } = {}): void {
    const cached = this.cache.get(userId);
    // A manual refresh cannot hammer the token refresh: entries younger than minAgeMs stay.
    if (cached && opts.minAgeMs && this.now() - cached.at < opts.minAgeMs) return;
    this.cache.delete(userId);
  }

  private readonly inflight = new Map<string, Promise<ConnectorsResult>>();

  async get(userId: string): Promise<ConnectorsResult> {
    const cached = this.cache.get(userId);
    if (cached && this.now() - cached.at < (cached.value.error ? ERROR_CACHE_MS : CACHE_MS)) return cached.value;
    let p = this.inflight.get(userId);
    if (!p) {
      p = this.load(userId).then((value) => { this.cache.set(userId, { at: this.now(), value }); return value; }).finally(() => { this.inflight.delete(userId); });
      this.inflight.set(userId, p);
    }
    return p;
  }

  private async load(userId: string): Promise<ConnectorsResult> {
    const result = (partial: Partial<ConnectorsResult>): ConnectorsResult => ({ diagnostics: [], connectors: [], fetchedAt: new Date(this.now()).toISOString(), ...partial });
    const diagnostics: ConnectorDiagnostic[] = [];
    if (this.deps.apiKeyInEnv()) diagnostics.push("api_key");

    let data: CredentialData | null = null;
    try {
      await this.deps.credentials.refresh(userId, "claude");
      data = await this.deps.credentials.get(userId, "claude");
    } catch { data = null; }
    const token = data && typeof data.accessToken === "string" ? data.accessToken : "";
    if (!token) return result({ diagnostics: [...diagnostics, "needs_signin"] });
    const scopes = Array.isArray(data?.scopes) ? (data.scopes as unknown[]).filter((s): s is string => typeof s === "string") : null;
    if (scopes && !scopes.includes(SCOPE)) return result({ diagnostics: [...diagnostics, "missing_scope"] });

    try {
      const response = await this.doFetch(BASE_URL + LIST_PATH, {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": BETA, "anthropic-version": "2023-06-01", Accept: "application/json", "User-Agent": "floq-runtime" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401) return result({ diagnostics: [...diagnostics, "needs_signin"] });
      if (response.status === 403) return result({ diagnostics: [...diagnostics, "missing_scope"] });
      if (!response.ok) {
        log.warn("claude.connectors_failed", { userId, status: response.status });
        return result({ diagnostics, error: "unavailable" });
      }
      return result({ diagnostics, connectors: parseConnectors(await response.json()) });
    } catch {
      // The error text can echo a URL or a header: log the fact only.
      log.warn("claude.connectors_failed", { userId });
      return result({ diagnostics, error: "unavailable" });
    }
  }
}
