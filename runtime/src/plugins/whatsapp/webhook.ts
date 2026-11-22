// Floq's own webhook in WAHA: set when a session is created or attached, checked every few minutes and when the session turns WORKING, repaired when
// WAHA lost it (a redeploy resets the session config) or when its address, token or events are out of date. The URL holds a credential: it goes to WAHA
// and nowhere else (never into a log, a route answer or the diagnostics).
import { randomBytes } from "node:crypto";
import type { Deps } from "./extras.js";
import { WahaError } from "./client.js";
import { scopeOf, type Core } from "./core.js";
import { WANTED_EVENTS } from "./session.js";

type Obj = Record<string, unknown>;
export type WebhookState = "ok" | "missing" | "missing-events" | "stale" | "unknown";
export interface WebhookHealth {
  state: WebhookState;
  missingEvents: string[];
  reason?: string;
  lastEnsuredAt: string | null;
  lastError?: string;
  /** The address WAHA posts to, masked: origin and path without the token. */
  address?: string;
}
/** The health after the check; changed: Floq changed the session's webhook; added: the events that were missing before. */
export type Ensured = WebhookHealth & { changed: boolean; added: string[] };

export const HMAC_SECRET = "WAHA_WEBHOOK_HMAC";
/** WAHA retries a failed delivery: a few seconds apart, growing, eight times. */
export const RETRIES = { policy: "exponential", delaySeconds: 2, attempts: 8 };
/** After Floq changed a session's webhook (WAHA restarts the session), the periodic and status-triggered checks leave it alone for this long. */
export const COOLDOWN_MS = 5 * 60_000;
export const CHECK_EVERY_MS = 10 * 60_000;
const NEEDS_FLOQ = "Needs a newer Floq: it cannot tell plugins their webhook address yet.";
const NO_ADDRESS = "Floq does not know its public address yet. Set “Address WAHA uses to reach Floq” in the plugin settings.";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** True for a webhook entry that posts to this plugin's hook, whatever the origin or token. */
export const isFloqHook = (pluginId: string, w: unknown): w is Obj =>
  !!w && typeof w === "object" && typeof (w as Obj).url === "string" && new RegExp(`/plugins/${esc(pluginId)}/hooks/events(?:[/?#]|$)`).test((w as Obj).url as string);
/** origin + path without the token: what may be shown. */
export function maskUrl(pluginId: string, url: string): string {
  try { return new URL(url).origin + `/v1/plugins/${pluginId}/hooks/events/…`; } catch { return `/v1/plugins/${pluginId}/hooks/events/…`; }
}
const keyOf = (w: Obj): string => (typeof w.hmac === "string" ? w.hmac : w.hmac && typeof w.hmac === "object" && typeof (w.hmac as Obj).key === "string" ? ((w.hmac as Obj).key as string) : "");
const masked = (k: string) => /^[*•]+$/.test(k);
const eventsOf = (w: Obj): string[] => (Array.isArray(w.events) ? w.events.filter((e): e is string => typeof e === "string") : []);

export interface Wanted { url: string; key?: string }
export interface Plan { state: WebhookState; missingEvents: string[]; reason?: string; webhooks: unknown[] }
/**
 * What the session's webhook list should become. Exactly one entry is Floq's (its path is this plugin's hook; any origin and token): the one that already
 * posts to the wanted URL, else the first. Other Floq entries are dropped, foreign webhooks stay as they are and in order. A key WAHA shows masked is not
 * compared. state "ok" means the list is already right (webhooks is then the list unchanged).
 */
export function planWebhook(pluginId: string, current: unknown, want: Wanted): Plan {
  const raw = Array.isArray(current) ? current : [];
  const ours = raw.filter((w) => isFloqHook(pluginId, w)) as Obj[];
  const exact = ours.find((w) => w.url === want.url) ?? ours[0] ?? null;
  const have = exact ? eventsOf(exact) : [];
  const missingEvents = exact ? (have.includes("*") ? [] : WANTED_EVENTS.filter((e) => !have.includes(e))) : [...WANTED_EVENTS];
  let state: WebhookState = "ok", reason: string | undefined;
  if (!exact) { state = "missing"; reason = "WAHA has no webhook to Floq for this session."; }
  else if (exact.url !== want.url) { state = "stale"; reason = "The webhook points to an old address or token."; }
  else if (ours.length > 1) { state = "stale"; reason = "The session has more than one webhook to Floq."; }
  else if (want.key && (!keyOf(exact) || (!masked(keyOf(exact)) && keyOf(exact) !== want.key))) { state = "stale"; reason = "The webhook is not signed with Floq's key."; }
  else if (missingEvents.length) { state = "missing-events"; reason = `The webhook does not send ${missingEvents.length} events Floq uses.`; }
  if (state === "ok") return { state, missingEvents, webhooks: raw };
  const entry: Obj = {
    ...(exact ?? { retries: RETRIES }), url: want.url,
    events: have.includes("*") ? ["*"] : [...new Set([...have, ...WANTED_EVENTS])],
    ...(want.key ? { hmac: { key: want.key } } : {}),
  };
  let placed = false;
  const webhooks: unknown[] = [];
  for (const w of raw) {
    if (!isFloqHook(pluginId, w)) { webhooks.push(w); continue; }
    if (!placed) { webhooks.push(entry); placed = true; }
  }
  if (!placed) webhooks.push(entry);
  return { state, missingEvents, reason, webhooks };
}

/** The wanted URL with the origin of the "Address WAHA uses to reach Floq" setting, when one is set. */
export function withBase(url: string, base: unknown): string {
  if (typeof base !== "string" || !base.trim()) return url;
  try {
    const u = new URL(url), b = new URL(base.trim());
    if (!/^https?:$/.test(b.protocol)) return url;
    return b.origin + b.pathname.replace(/\/+$/, "") + u.pathname + u.search;
  } catch { return url; }
}

export interface WebhookService {
  /** False on a Floq that cannot tell plugins their webhook URL: nothing here does anything then. */
  available(): boolean;
  /** A fresh webhook entry for a session that is created now (holds the URL and key: for WAHA only), or null when the address is unknown. */
  entry(owner: string): Promise<Obj | null>;
  /** Makes the session's webhook right (one GET, a PUT only when something differs). */
  ensure(scope: string, opts?: { force?: boolean }): Promise<Ensured>;
  /** The health of a session read from its own data, no change made. */
  healthOf(scope: string, session: Obj | null): Promise<WebhookHealth>;
}

const services = new WeakMap<Core, WebhookService>();
export function webhookService(core: Core): WebhookService {
  let svc = services.get(core);
  if (!svc) services.set(core, (svc = createService(core)));
  return svc;
}

function createService(core: Core): WebhookService {
  const { ctx } = core;
  const records = new Map<string, { at: string | null; error?: string; putAt: number }>();
  const inflight = new Map<string, Promise<Ensured>>();
  const available = () => typeof ctx.webhooks?.url === "function";
  const rec = (key: string) => { let r = records.get(key); if (!r) records.set(key, (r = { at: null, putAt: 0 })); return r; };
  const keyOfScope = (scope: string) => { const s = core.split(scope); return s.owner + "\u0000" + s.session; };

  async function address(owner: string): Promise<string | null> {
    if (!available()) return null;
    let url: string | null = null;
    try { url = await ctx.webhooks.url("events"); } catch { url = null; }
    if (!url) return null;
    return withBase(url, (await ctx.settings.get(owner).catch(() => ({})) as Obj).webhookBase);
  }
  let creating: Promise<string | undefined> | null = null;
  async function hmacKey(create: boolean): Promise<string | undefined> {
    const have = await ctx.secrets.getInstall(HMAC_SECRET);
    if (have || !create || typeof ctx.secrets.setInstall !== "function") return have || undefined;
    // One key for every session: concurrent checks of several accounts must not each invent their own.
    creating ??= (async () => {
      const again = await ctx.secrets.getInstall(HMAC_SECRET);
      if (again) return again;
      const k = randomBytes(32).toString("base64url");
      await ctx.secrets.setInstall(HMAC_SECRET, k);
      return k;
    })().finally(() => { creating = null; });
    return creating;
  }
  const hooksOf = (s: Obj | null): unknown => (s?.config && typeof s.config === "object" ? (s.config as Obj).webhooks : undefined);
  const why = (e: unknown) => (e instanceof WahaError ? (e.status === 0 ? "WAHA is not reachable." : e.status === 401 || e.status === 403 ? "WAHA refused the API key." : e.status === 404 ? "WAHA has no such session." : `WAHA answered ${e.status}.`) : "Something went wrong.");

  async function healthOf(scope: string, s: Obj | null): Promise<WebhookHealth> {
    const r = records.get(keyOfScope(scope)), base = { lastEnsuredAt: r?.at ?? null, ...(r?.error ? { lastError: r.error } : {}) };
    if (!available()) return { state: "unknown", missingEvents: [], reason: NEEDS_FLOQ, ...base };
    if (!s) return { state: "unknown", missingEvents: [], reason: "WAHA did not tell about this session.", ...base };
    const url = await address(core.split(scope).owner);
    if (!url) return { state: "unknown", missingEvents: [], reason: NO_ADDRESS, ...base };
    const plan = planWebhook(ctx.pluginId, hooksOf(s), { url, key: await hmacKey(false) });
    return { state: plan.state, missingEvents: plan.missingEvents, ...(plan.reason ? { reason: plan.reason } : {}), address: maskUrl(ctx.pluginId, url), ...base };
  }

  async function run(scope: string, force: boolean): Promise<Ensured> {
    const r = rec(keyOfScope(scope)), { owner } = core.split(scope);
    const done = (h: Omit<WebhookHealth, "lastEnsuredAt" | "lastError">, error?: string, changed = false, added: string[] = []): Ensured => {
      r.at = new Date().toISOString(); r.error = error;
      return { ...h, lastEnsuredAt: r.at, ...(error ? { lastError: error } : {}), changed, added };
    };
    const unknown = (reason: string) => done({ state: "unknown", missingEvents: [], reason });
    if (!available()) return unknown(NEEDS_FLOQ);
    const c = await core.config(scope);
    if (c.missingSettings.length || c.missingSecrets.length) return unknown("WAHA is not configured yet.");
    const url = await address(owner);
    if (!url) return unknown(NO_ADDRESS);
    let s: Obj | null;
    try { const x = await core.waha<unknown>(scope, "GET", "/api/sessions/{session}"); s = x && typeof x === "object" ? (x as Obj) : {}; }
    catch (e) { if (!(e instanceof WahaError)) throw e; return unknown(why(e)); }
    const shown = { address: maskUrl(ctx.pluginId, url) };
    let plan = planWebhook(ctx.pluginId, hooksOf(s), { url, key: await hmacKey(false) });
    const plan0 = plan;
    if (plan.state === "ok") return done({ state: "ok", missingEvents: [], ...shown });
    const health = (p: Plan) => ({ state: p.state, missingEvents: p.missingEvents, ...(p.reason ? { reason: p.reason } : {}), ...shown });
    // WAHA restarts a session whose config changes: a check that keeps finding a difference must not keep restarting it.
    if (!force && Date.now() - r.putAt < COOLDOWN_MS) return done(health(plan), r.error);
    // Only a change needs the key: a webhook that is right as it is stays as it is.
    const key = await hmacKey(true);
    if (key) plan = planWebhook(ctx.pluginId, hooksOf(s), { url, key });
    const config = s.config && typeof s.config === "object" ? (s.config as Obj) : {};
    try { await core.waha(scope, "PUT", "/api/sessions/{session}", { body: { config: { ...config, webhooks: plan.webhooks } } }); }
    catch (e) { if (!(e instanceof WahaError)) throw e; ctx.log.warn("webhook repair failed", { status: e.status }); return done(health(plan), why(e)); }
    r.putAt = Date.now();
    core.publish(scope, "session", { status: "STARTING" });
    return done({ state: "ok", missingEvents: [], ...shown }, undefined, true, plan0.missingEvents);
  }

  return {
    available,
    async entry(owner) {
      const url = await address(owner);
      if (!url) return null;
      const key = await hmacKey(true);
      return { url, events: [...WANTED_EVENTS], ...(key ? { hmac: { key } } : {}), retries: { ...RETRIES } };
    },
    ensure(scope, opts = {}) {
      const key = keyOfScope(scope), hit = inflight.get(key);
      if (hit) return hit;
      const p = run(scope, opts.force === true).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    healthOf,
  };
}

export function registerWebhook({ core }: Deps): void {
  const { ctx } = core, svc = webhookService(core);
  // Repairs the webhook of the account on screen. Always answers with the health (never the URL).
  ctx.routes.post("/session/webhook-repair", async ({ userId }) => {
    await core.owner(userId);
    const { changed, added: _added, ...health } = await svc.ensure(userId, { force: true });
    return { ...health, repaired: changed };
  });
  if (!svc.available()) return;
  core.on("session.status", (userId, e) => {
    if (String(e.payload.status ?? "").toUpperCase() === "WORKING") core.bg(svc.ensure(userId));
  });
  async function sweep() {
    const owner = await ctx.installOwner();
    if (!owner) return;
    for (const a of await core.accounts(owner)) {
      try { await svc.ensure(scopeOf(owner, a.session)); } catch (e) { ctx.log.warn("webhook check failed", { error: e instanceof Error ? e.message : "error" }); }
    }
  }
  core.bg(sweep());
  if (typeof ctx.schedule === "function") ctx.schedule(CHECK_EVERY_MS, sweep);
}
