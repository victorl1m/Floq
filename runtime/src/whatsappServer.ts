/**
 * The built-in WhatsApp server: WAHA Core (devlikeapro/waha, Apache-2.0, unmodified image) as the optional compose service `waha`
 * (profile `whatsapp`). It is never part of the runtime image. The runtime only talks to it on the compose network, hands its address
 * and API key to the WhatsApp plugin as host-provided defaults, and keeps it current through the Docker socket (the one "Update runtime" uses).
 */
import { hostname } from "node:os";
import type pg from "pg";
import { HttpError, badRequest, conflict } from "./errors.js";
import { log } from "./logger.js";
import { compareVersions, isNewer, type UpdateItem } from "./updates.js";
import { dockerOk, dockerRequest, dockerSelfUpdateAvailable } from "./selfUpdate.js";

export const WHATSAPP_PLUGIN_ID = "waha";
export const WAHA_IMAGE = "devlikeapro/waha";
export const WAHA_RELEASES_REPO = "devlikeapro/waha";
export const WAHA_COMPOSE_SERVICE = "waha";
/** The tag docker-compose.yml pins (the floor). A test keeps the two in step. */
export const WAHA_PINNED_TAG = "noweb-2026.10.1";
export const DEFAULT_QUIET_MINUTES = 30;
export const QUIET_RANGE = { min: 5, max: 1440 } as const;
export const HEALTH_TIMEOUT_MS = 180_000;
const DAY_MS = 24 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;

export interface BuiltinWhatsappConfig {
  /** FLOQ_WHATSAPP_API_KEY is set (compose gives the same value to WAHA as WAHA_API_KEY) and FLOQ_WHATSAPP_BUILTIN is not 0. */
  enabled: boolean;
  /** Where the runtime reaches WAHA on the compose network. */
  url: string;
  apiKey: string;
  /** Where WAHA reaches the runtime on the compose network (webhooks). */
  internalUrl: string;
  /** Why a configured key is not used (too short, hashed). Names the variable, never the value. */
  problem: string | null;
}

const cleanBase = (v: string | undefined): string | null => {
  try { const u = new URL(String(v ?? "").trim()); return u.protocol === "http:" || u.protocol === "https:" ? (u.origin + u.pathname).replace(/\/+$/, "") : null; } catch { return null; }
};

export function builtinWhatsappFromEnv(env: Record<string, string | undefined> = process.env): BuiltinWhatsappConfig {
  const apiKey = (env.FLOQ_WHATSAPP_API_KEY ?? "").trim();
  const off = /^(0|false|off|no)$/i.test((env.FLOQ_WHATSAPP_BUILTIN ?? "").trim());
  const port = /^\d{2,5}$/.test(env.FLOQ_PORT ?? "") ? env.FLOQ_PORT : "8787";
  let problem: string | null = null;
  if (!off && apiKey) {
    if (apiKey.startsWith("sha512:")) problem = "FLOQ_WHATSAPP_API_KEY must be the plain key, not a sha512 hash (the runtime sends it to WAHA).";
    else if (apiKey.length < 24) problem = "FLOQ_WHATSAPP_API_KEY is too short: use at least 24 characters (openssl rand -hex 32).";
  }
  return {
    enabled: !off && Boolean(apiKey) && !problem,
    url: cleanBase(env.FLOQ_WHATSAPP_URL) ?? "http://waha:3000",
    apiKey: off || problem ? "" : apiKey,
    internalUrl: cleanBase(env.FLOQ_INTERNAL_URL) ?? `http://runtime:${port}`,
    problem,
  };
}

/** A WAHA webhook that means a message was sent or received (receipts, presence and session events do not count as activity). */
export function wahaMessageEvent(body: unknown): boolean {
  const event = (body as { event?: unknown } | null)?.event;
  return event === "message" || event === "message.any" || event === "message.reaction" || event === "message.edited" || event === "message.revoked";
}
/** A request of the plugin to WAHA that sends something (`/api/sendText`, `/api/sendImage`, reactions, forwards). */
export function wahaSendCall(method: string | undefined, url: string): boolean {
  if (!method || method.toUpperCase() === "GET") return false;
  try { return /\/api\/(send[A-Z]\w*|forwardMessage|reaction|reply)\b/.test(new URL(url).pathname); } catch { return false; }
}

/** What the plugin host needs to provide defaults to the WhatsApp plugin (see `PluginIntegration` in plugins/host.ts). */
export function whatsappIntegration(cfg: BuiltinWhatsappConfig, onActivity?: () => void) {
  return {
    kind: "builtin-whatsapp" as const,
    urlSetting: "baseUrl",
    secretName: "WAHA_API_KEY",
    builtin: cfg.enabled ? { url: cfg.url, secret: cfg.apiKey, webhookBase: cfg.internalUrl } : null,
    onWebhook: (body: unknown) => { if (wahaMessageEvent(body)) onActivity?.(); },
    onFetch: (method: string | undefined, url: string) => { if (wahaSendCall(method, url)) onActivity?.(); },
  };
}

// ---- versions and tags ----

/** "noweb-2026.10.1" -> { flavor: "noweb", version: "2026.10.1" }; "2026.10.1" -> flavor "". Anything else (latest, dev, digests): null. */
export function parseWahaTag(tag: string): { flavor: string; version: string } | null {
  const m = /^(?:([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)-)?(\d{4}\.\d{1,2}\.\d{1,3})$/.exec(tag);
  return m ? { flavor: m[1] ?? "", version: m[2] } : null;
}
export const wahaTag = (flavor: string, version: string) => (flavor ? flavor + "-" + version : version);

/** Only the official image with a versioned tag is ever managed: a custom image or `:latest` is left alone. */
export function parseWahaImage(image: string): { flavor: string; version: string; tag: string } | null {
  const i = image.lastIndexOf(":");
  if (i < 0 || image.slice(0, i) !== WAHA_IMAGE) return null;
  const tag = image.slice(i + 1), parsed = parseWahaTag(tag);
  return parsed ? { ...parsed, tag } : null;
}

/** Newest stable release: drafts, pre-releases and tags that are not plain YYYY.M.P are ignored. */
export function latestStable(releases: { tag_name?: unknown; draft?: unknown; prerelease?: unknown }[]): string | null {
  const versions = releases
    .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === "string" && /^v?\d{4}\.\d{1,2}\.\d{1,3}$/.test(r.tag_name))
    .map((r) => (r.tag_name as string).replace(/^v/, ""));
  versions.sort((a, b) => compareVersions(b, a));
  return versions[0] ?? null;
}

export async function fetchLatestWaha(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${WAHA_RELEASES_REPO}/releases?per_page=30`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json", "User-Agent": "floq-runtime" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return latestStable((await res.json()) as { tag_name?: unknown }[]);
}

// ---- pure decisions (unit tested) ----

/** True when nothing was sent or received for the whole window. `null` = no activity seen since the runtime started (boot counts as activity). */
export function isQuiet(lastActivityAt: number | null, now: number, quietMinutes: number): boolean {
  return lastActivityAt === null || now - lastActivityAt >= quietMinutes * 60_000;
}

export type AutoDecision = "update" | "off" | "not_managed" | "up_to_date" | "failed_before" | "login_active" | "login_unknown" | "busy";
export function autoUpdateDecision(i: { enabled: boolean; managed: boolean; current: string | null; latest: string | null; failedVersion: string | null; loginActive: boolean | null; quiet: boolean }): AutoDecision {
  if (!i.enabled) return "off";
  if (!i.managed) return "not_managed";
  if (!isNewer(i.current, i.latest)) return "up_to_date";
  // A version that was rolled back is not retried by itself: an administrator can still apply it by hand.
  if (i.failedVersion && i.failedVersion === i.latest) return "failed_before";
  if (i.loginActive === null) return "login_unknown";
  if (i.loginActive) return "login_active";
  return i.quiet ? "update" : "busy";
}

export type HealthVerdict = "healthy" | "wait" | "rollback";
/** After a container swap: keep waiting, accept, or put the previous version back. Without a healthcheck, staying up for `settleMs` counts. */
export function healthVerdict(c: { running: boolean; health: string | null }, elapsedMs: number, timeoutMs = HEALTH_TIMEOUT_MS, settleMs = 15_000): HealthVerdict {
  if (c.health === "healthy" && c.running) return "healthy";
  if (c.health === "unhealthy") return "rollback";
  if (!c.running && elapsedMs >= 5_000) return "rollback";
  if (c.health === null && c.running && elapsedMs >= settleMs) return "healthy";
  return elapsedMs >= timeoutMs ? "rollback" : "wait";
}

// ---- Docker ----

export interface ContainerInfo { id: string; name: string; image: string; running: boolean; health: string | null; raw?: unknown }
export interface WahaDocker {
  available(): boolean;
  /** The compose service `waha` of the runtime's own compose project, or null. */
  find(): Promise<ContainerInfo | null>;
  inspect(id: string): Promise<ContainerInfo>;
  pull(repo: string, tag: string): Promise<void>;
  stop(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** A new container with the old one's exact config (env, volumes, networks, labels) and another image. Not started. */
  createLike(old: ContainerInfo, image: string, name: string): Promise<string>;
  start(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

interface RawInspect {
  Id: string; Name: string;
  Config: Record<string, unknown> & { Image: string; Labels?: Record<string, string> };
  HostConfig: Record<string, unknown>;
  State?: { Running?: boolean; Health?: { Status?: string } };
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> };
}
const info = (r: RawInspect): ContainerInfo => ({ id: r.Id, name: r.Name.replace(/^\//, ""), image: r.Config.Image, running: Boolean(r.State?.Running), health: r.State?.Health?.Status ?? null, raw: r });
const enc = encodeURIComponent;

/** The real Docker Engine, through the socket docker-compose.yml mounts for in-app updates. */
export function engineDocker(): WahaDocker {
  const inspect = async (id: string) => info(JSON.parse(await dockerOk("GET", `/containers/${enc(id)}/json`)) as RawInspect);
  return {
    available: dockerSelfUpdateAvailable,
    inspect,
    async find() {
      const self = JSON.parse(await dockerOk("GET", `/containers/${enc(hostname())}/json`)) as RawInspect;
      const project = self.Config.Labels?.["com.docker.compose.project"];
      if (!project) return null;
      const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${WAHA_COMPOSE_SERVICE}`] });
      const list = JSON.parse(await dockerOk("GET", `/containers/json?all=1&filters=${enc(filters)}`)) as { Id: string; Names?: string[] }[];
      // A parked container of an update in flight is not the service.
      const hit = list.find((c) => !(c.Names ?? []).some((n) => n.includes("-floq-old-")));
      return hit ? inspect(hit.Id) : null;
    },
    async pull(repo, tag) {
      const out = await dockerOk("POST", `/images/create?fromImage=${enc(repo)}&tag=${enc(tag)}`, undefined, { timeoutMs: 15 * 60_000 });
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg: { error?: string };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) throw new Error("image pull failed: " + msg.error.slice(0, 300));
      }
    },
    async stop(id) { const r = await dockerRequest("POST", `/containers/${enc(id)}/stop?t=30`, undefined, { timeoutMs: 90_000 }); if (r.status >= 300 && r.status !== 304) throw new Error(`Docker stop answered ${r.status}`); },
    async rename(id, name) { await dockerOk("POST", `/containers/${enc(id)}/rename?name=${enc(name)}`); },
    async createLike(old, image, name) {
      const raw = old.raw as RawInspect;
      const nets = Object.entries(raw.NetworkSettings?.Networks ?? {});
      const endpoint = (aliases?: string[] | null) => ({ Aliases: (aliases ?? []).filter((a) => !raw.Id.startsWith(a)) });
      const config: Record<string, unknown> = { ...raw.Config, Image: image, HostConfig: raw.HostConfig, NetworkingConfig: { EndpointsConfig: nets.length ? { [nets[0][0]]: endpoint(nets[0][1].Aliases) } : {} } };
      delete config.Hostname;
      const id = (JSON.parse(await dockerOk("POST", `/containers/create?name=${enc(name)}`, config)) as { Id: string }).Id;
      for (const [net, ep] of nets.slice(1)) await dockerOk("POST", `/networks/${enc(net)}/connect`, { Container: id, EndpointConfig: endpoint(ep.Aliases) });
      return id;
    },
    async start(id) { await dockerOk("POST", `/containers/${enc(id)}/start`); },
    async remove(id) { await dockerRequest("DELETE", `/containers/${enc(id)}?force=1`).catch(() => undefined); },
  };
}

export interface SwapResult { ok: boolean; rolledBack: boolean; message: string }
export interface SwapOptions { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }

/**
 * Pulls `image`, then replaces the container with one that differs only in the image. Volumes are named in the container config, so
 * sessions and media stay. The old container is parked, not deleted, until the new one is healthy; otherwise it is put back.
 * A failed pull changes nothing.
 */
export async function swapContainer(d: WahaDocker, old: ContainerInfo, image: string, opts: SwapOptions = {}): Promise<SwapResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const i = image.lastIndexOf(":");
  try { await d.pull(image.slice(0, i), image.slice(i + 1)); } catch (error) { return { ok: false, rolledBack: false, message: "Could not download " + image + ": " + short(error) }; }
  const name = old.name;
  const parked = `${name}-floq-old-${now()}`;
  await d.stop(old.id);
  await d.rename(old.id, parked);
  let fresh: string | null = null;
  let why = "";
  try {
    fresh = await d.createLike(old, image, name);
    await d.start(fresh);
    const started = now();
    for (;;) {
      const verdict = healthVerdict(await d.inspect(fresh), now() - started, opts.timeoutMs ?? HEALTH_TIMEOUT_MS);
      if (verdict === "healthy") { await d.remove(old.id); return { ok: true, rolledBack: false, message: "Now running " + image + "." }; }
      if (verdict === "rollback") { why = "the new version did not become healthy"; break; }
      await sleep(opts.pollMs ?? 3_000);
    }
  } catch (error) { why = short(error); }
  // Roll back: the parked container still has the previous image and the same volumes.
  try {
    if (fresh) await d.remove(fresh);
    await d.rename(old.id, name);
    await d.start(old.id);
  } catch (error) {
    return { ok: false, rolledBack: false, message: `Update to ${image} failed (${why}) and the previous version could not be started again: ${short(error)}. Run "docker compose up -d waha".` };
  }
  return { ok: false, rolledBack: true, message: `Update to ${image} failed (${why}). The previous version (${old.image}) is running again.` };
}
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// ---- the service ----

export type ServerState = "off" | "starting" | "unreachable" | "unauthorized" | "running";
export interface Probe { state: ServerState; version: string | null; engine: string | null; tier: string | null; latencyMs: number | null; error?: string }
/** How the WhatsApp plugin is wired, from the plugin host. `external` is set when it points at a WAHA the admin entered. */
export interface PluginService { installed: boolean; enabled: boolean; mode: "builtin" | "external" | "none"; external: { url: string; secret(): Promise<string | undefined> } | null }
export interface LastUpdate { at: string; ok: boolean; from: string | null; to: string | null; rolledBack: boolean; message: string }
interface Stored { tag: string | null; failedVersion: string | null; autoUpdate: { enabled: boolean; quietMinutes: number }; lastCheckAt: string | null; last: LastUpdate | null }
const freshState = (): Stored => ({ tag: null, failedVersion: null, autoUpdate: { enabled: true, quietMinutes: DEFAULT_QUIET_MINUTES }, lastCheckAt: null, last: null });

export interface BuiltinWhatsappDeps {
  cfg: BuiltinWhatsappConfig;
  pool?: Pick<pg.Pool, "query">;
  docker?: WahaDocker;
  fetchImpl?: typeof fetch;
  now?: () => number;
  latest?: () => Promise<string | null>;
  plugin?: () => Promise<PluginService>;
  /** Tells the administrators how an update went. */
  notify?: (note: { title: string; body: string; level: "success" | "warning" | "error" }) => Promise<void>;
  swap?: SwapOptions;
}

export class BuiltinWhatsapp {
  private state: Stored = freshState();
  private loaded = false;
  private lastActivityAt: number | null;
  private busy = false;
  private latestCache: { at: number; value: string | null } | null = null;
  private timers: NodeJS.Timeout[] = [];
  constructor(private readonly deps: BuiltinWhatsappDeps) { this.lastActivityAt = deps.cfg.enabled ? this.now() : null; }

  get config(): BuiltinWhatsappConfig { return this.deps.cfg; }
  private now() { return (this.deps.now ?? Date.now)(); }
  private get docker() { return this.deps.docker; }
  /** Called by the plugin host for every message webhook and every send. */
  noteActivity(): void { this.lastActivityAt = this.now(); }

  private async load(): Promise<Stored> {
    if (this.loaded) return this.state;
    if (this.deps.pool) {
      await this.deps.pool.query("CREATE TABLE IF NOT EXISTS whatsapp_server_state (id INT PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const row = (await this.deps.pool.query("SELECT data FROM whatsapp_server_state WHERE id = 1")).rows[0] as { data?: Partial<Stored> | string } | undefined;
      const data = typeof row?.data === "string" ? (JSON.parse(row.data) as Partial<Stored>) : row?.data;
      if (data) this.state = { ...freshState(), ...data, autoUpdate: { ...freshState().autoUpdate, ...(data.autoUpdate ?? {}) } };
    }
    this.loaded = true;
    return this.state;
  }
  private async save(): Promise<void> {
    if (this.deps.pool) await this.deps.pool.query("INSERT INTO whatsapp_server_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [JSON.stringify(this.state)]);
  }

  /** `/ping` needs no key; `/api/server/version` does, so a wrong key shows as "unauthorized", not as "down". */
  private probeBuiltin(): Promise<Probe> { return this.probe(this.deps.cfg.url, this.deps.cfg.apiKey); }
  /** No default arguments on purpose: the built-in key must never ride along to another address. */
  async probe(url: string, key: string | null): Promise<Probe> {
    const f = this.deps.fetchImpl ?? fetch;
    const out: Probe = { state: "unreachable", version: null, engine: null, tier: null, latencyMs: null };
    const started = Date.now();
    try {
      const res = await f(url + "/api/server/version", { headers: { Accept: "application/json", ...(key ? { "X-Api-Key": key } : {}) }, redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      out.latencyMs = Date.now() - started;
      if (res.status === 401 || res.status === 403) { out.state = "unauthorized"; out.error = "The server refused the API key."; return out; }
      if (!res.ok) { out.error = "The server answered HTTP " + res.status + "."; return out; }
      const body = (await res.json()) as { version?: unknown; engine?: unknown; tier?: unknown };
      const text = (v: unknown) => (typeof v === "string" && v.length <= 40 && /^[\w .+-]+$/.test(v) ? v : null);
      out.state = "running"; out.version = text(body.version); out.engine = text(body.engine); out.tier = text(body.tier);
    } catch { out.error = "The server did not answer."; }
    return out;
  }

  private async container(): Promise<ContainerInfo | null> {
    if (!this.deps.cfg.enabled || !this.docker?.available()) return null;
    try { return await this.docker.find(); } catch (error) { log.warn("whatsapp.docker_find_failed", { error: short(error) }); return null; }
  }
  private pluginService(): Promise<PluginService> {
    return this.deps.plugin?.().catch(() => null).then((p) => p ?? { installed: false, enabled: false, mode: "none" as const, external: null }) ?? Promise.resolve({ installed: false, enabled: false, mode: "none" as const, external: null });
  }

  async status() {
    const s = await this.load();
    const cfg = this.deps.cfg;
    const [plugin, probe, c] = await Promise.all([this.pluginService(), cfg.enabled ? this.probeBuiltin() : Promise.resolve<Probe>({ state: "off", version: null, engine: null, tier: null, latencyMs: null }), this.container()]);
    const state: ServerState = probe.state === "unreachable" && c?.running && c.health === "starting" ? "starting" : probe.state;
    return {
      builtin: { enabled: cfg.enabled, state, version: probe.version, engine: probe.engine, tier: probe.tier, image: c?.image ?? null, managed: Boolean(c && parseWahaImage(c.image)), ...(cfg.problem ?? probe.error ? { error: cfg.problem ?? probe.error } : {}) },
      plugin: { installed: plugin.installed, enabled: plugin.enabled, mode: plugin.mode },
      autoUpdate: { enabled: s.autoUpdate.enabled, quietMinutes: s.autoUpdate.quietMinutes, lastCheckAt: s.lastCheckAt, last: s.last },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  async health() {
    const cfg = this.deps.cfg;
    const p: Probe = cfg.enabled ? await this.probeBuiltin() : { state: "off", version: null, engine: null, tier: null, latencyMs: null };
    return { ok: p.state === "running", state: p.state, latencyMs: p.latencyMs, version: p.version, ...(p.error ? { error: p.error } : {}), checkedAt: new Date(this.now()).toISOString() };
  }

  /** "Test connection" before an external address is saved: the same probe against the given server. Nothing is stored, and the built-in key only ever goes to the built-in address. */
  async test(body: { baseUrl?: unknown; apiKey?: unknown }) {
    const cfg = this.deps.cfg;
    const raw = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
    const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (raw.length > 2000 || key.length > 512) throw badRequest("baseUrl or apiKey is too long");
    const url = raw ? cleanBase(raw) : null;
    if (raw && !url) throw badRequest("baseUrl must be an http(s) URL");
    const builtin = cfg.enabled && (!url || url === cfg.url);
    if (!url && !builtin) throw badRequest("baseUrl is required");
    const p = builtin && !key ? await this.probeBuiltin() : await this.probe(url ?? cfg.url, key || null);
    return { ok: p.state === "running", state: p.state, version: p.version, engine: p.engine, ...(p.error ? { error: p.error } : {}) };
  }

  async setAutoUpdate(body: { enabled?: unknown; quietMinutes?: unknown }) {
    const s = await this.load();
    if (body.enabled !== undefined) { if (typeof body.enabled !== "boolean") throw badRequest("enabled must be true or false"); s.autoUpdate.enabled = body.enabled; }
    if (body.quietMinutes !== undefined) {
      const n = body.quietMinutes;
      if (typeof n !== "number" || !Number.isInteger(n) || n < QUIET_RANGE.min || n > QUIET_RANGE.max) throw badRequest(`quietMinutes must be a whole number from ${QUIET_RANGE.min} to ${QUIET_RANGE.max}`);
      s.autoUpdate.quietMinutes = n;
    }
    await this.save();
    return this.status();
  }

  private async latest(force = false): Promise<string | null> {
    if (!force && this.latestCache && this.now() - this.latestCache.at < 60 * 60_000) return this.latestCache.value;
    const value = await (this.deps.latest ?? (() => fetchLatestWaha(this.deps.fetchImpl)))();
    this.latestCache = { at: this.now(), value };
    return value;
  }

  /** The "WhatsApp server" row of Settings > Updates, or null when there is no server to speak of. An external WAHA is listed but never managed. */
  async updateItem(): Promise<UpdateItem | null> {
    const cfg = this.deps.cfg;
    const plugin = cfg.enabled ? null : await this.pluginService();
    if (!cfg.enabled && !plugin?.external) return null;
    const item: UpdateItem = { target: "whatsapp", current: null, latest: null, updateAvailable: false, source: `github:${WAHA_RELEASES_REPO}`, managed: false };
    const errors: string[] = [];
    const [probe, latest, c] = await Promise.all([
      cfg.enabled ? this.probeBuiltin() : plugin!.external!.secret().catch(() => undefined).then((key) => this.probe(plugin!.external!.url, key ?? null)),
      this.latest().catch((error) => { errors.push("Latest version unavailable: " + short(error)); return null; }),
      this.container(),
    ]);
    const image = c ? parseWahaImage(c.image) : null;
    item.current = probe.version ?? image?.version ?? null;
    if (!item.current) errors.push("Installed version unknown" + (probe.error ? ": " + probe.error : ""));
    item.latest = latest;
    item.managed = cfg.enabled && Boolean(image);
    item.updateAvailable = isNewer(item.current, item.latest);
    if (errors.length) item.error = errors.join("; ");
    return item;
  }

  /** null = could not ask (the update then waits, or an administrator decides). */
  private async loginActive(): Promise<boolean | null> {
    const f = this.deps.fetchImpl ?? fetch;
    try {
      const res = await f(this.deps.cfg.url + "/api/sessions?all=true", { headers: { Accept: "application/json", "X-Api-Key": this.deps.cfg.apiKey }, redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) return null;
      const list = (await res.json()) as { status?: unknown }[];
      return Array.isArray(list) ? list.some((x) => x?.status === "SCAN_QR_CODE" || x?.status === "STARTING") : null;
    } catch { return null; }
  }

  private async run(c: ContainerInfo, tag: string, reason: "manual" | "auto" | "restore", actorId?: string): Promise<SwapResult> {
    if (this.busy) throw conflict("A WhatsApp server update is already in progress", "update_in_progress");
    this.busy = true;
    const from = parseWahaImage(c.image), to = parseWahaTag(tag);
    try {
      log.info("whatsapp.update_start", { reason, actorId, from: c.image, to: tag });
      const result = await swapContainer(this.docker!, c, WAHA_IMAGE + ":" + tag, this.deps.swap);
      const s = await this.load();
      if (result.ok) { s.tag = tag; s.failedVersion = null; } else if (to && reason !== "restore") s.failedVersion = to.version;
      s.last = { at: new Date(this.now()).toISOString(), ok: result.ok, from: from?.version ?? null, to: to?.version ?? null, rolledBack: result.rolledBack, message: result.message };
      await this.save().catch((error) => log.warn("whatsapp.state_save_failed", { error: short(error) }));
      log.info("whatsapp.update_result", { reason, ok: result.ok, rolledBack: result.rolledBack });
      if (reason !== "restore" || !result.ok) {
        await this.deps.notify?.(result.ok
          ? { title: "WhatsApp server updated", body: `Now on ${to?.version ?? tag}${from ? " (was " + from.version + ")" : ""}. Sessions and media were kept.`, level: "success" }
          : { title: "WhatsApp server update failed", body: result.message, level: result.rolledBack ? "warning" : "error" }).catch(() => undefined);
      }
      return result;
    } finally { this.busy = false; }
  }

  /** "Update" in Settings > Updates. `force` skips only the quiet window, never the QR-login check. */
  async applyUpdate(actorId: string, force: boolean): Promise<{ log: string }> {
    const c = await this.container();
    const image = c ? parseWahaImage(c.image) : null;
    if (!c || !image) throw conflict("Floq does not manage this WhatsApp server (no Docker socket, another image, or an external server). Update it where it is hosted.", "not_managed");
    const latest = await this.latest(true).catch((error) => { throw new HttpError(502, "update_failed", "Could not read the latest WAHA release: " + short(error)); });
    if (!isNewer(image.version, latest)) throw conflict(`Already on the newest release (${image.version}).`, "up_to_date");
    const s = await this.load();
    if (await this.loginActive()) throw conflict("A WhatsApp login (QR code) is in progress. Finish or cancel it, then update.", "whatsapp_login_active");
    if (!force && !isQuiet(this.lastActivityAt, this.now(), s.autoUpdate.quietMinutes)) {
      throw conflict(`A message was sent or received in the last ${s.autoUpdate.quietMinutes} minutes. Updating disconnects WhatsApp for about a minute. Retry with force to update now.`, "whatsapp_busy");
    }
    const result = await this.run(c, wahaTag(image.flavor, latest!), "manual", actorId);
    if (!result.ok) throw new HttpError(500, "update_failed", result.message);
    return { log: result.message };
  }

  /** One pass of the automatic update: looks for a release at most once a day, then waits (hourly passes) for a quiet moment. */
  async tick(): Promise<AutoDecision> {
    const s = await this.load();
    if (!this.deps.cfg.enabled || !s.autoUpdate.enabled) return "off";
    if (this.busy) return "busy";
    const c = await this.container();
    const image = c ? parseWahaImage(c.image) : null;
    if (!c || !image) return "not_managed";
    const due = !s.lastCheckAt || this.now() - Date.parse(s.lastCheckAt) >= DAY_MS;
    let latest: string | null;
    try { latest = await this.latest(due); } catch (error) { log.warn("whatsapp.update_check_failed", { error: short(error) }); return "up_to_date"; }
    if (due) { s.lastCheckAt = new Date(this.now()).toISOString(); await this.save().catch(() => undefined); }
    const newer = isNewer(image.version, latest) && s.failedVersion !== latest;
    const decision = autoUpdateDecision({
      enabled: true, managed: true, current: image.version, latest, failedVersion: s.failedVersion,
      loginActive: newer ? await this.loginActive() : false, quiet: isQuiet(this.lastActivityAt, this.now(), s.autoUpdate.quietMinutes),
    });
    if (decision === "update") await this.run(c, wahaTag(image.flavor, latest!), "auto").catch((error) => log.error("whatsapp.update_failed", { error: short(error) }));
    return decision;
  }

  /**
   * After a redeploy compose recreates the service on the pinned tag (the floor). If Floq had moved it to a newer release, put that
   * release back so a runtime redeploy never downgrades WhatsApp. A newer pin simply becomes the stored tag.
   */
  async reconcile(): Promise<"none" | "restored" | "adopted" | "failed"> {
    const s = await this.load();
    const c = await this.container();
    const image = c ? parseWahaImage(c.image) : null;
    if (!c || !image) return "none";
    const stored = s.tag ? parseWahaTag(s.tag) : null;
    if (stored && stored.flavor === image.flavor && isNewer(image.version, stored.version)) {
      const r = await this.run(c, s.tag!, "restore").catch(() => null);
      return r?.ok ? "restored" : "failed";
    }
    if (s.tag !== image.tag) { s.tag = image.tag; await this.save().catch(() => undefined); return "adopted"; }
    return "none";
  }

  /** Boot: reconcile once WAHA had time to come up, then an hourly pass. Timers never keep the process alive. */
  start(): void {
    if (!this.deps.cfg.enabled) return;
    const first = setTimeout(() => { void this.reconcile().catch((error) => log.warn("whatsapp.reconcile_failed", { error: short(error) })); }, 90_000);
    const hourly = setInterval(() => { void this.tick().catch((error) => log.warn("whatsapp.tick_failed", { error: short(error) })); }, 60 * 60_000);
    first.unref(); hourly.unref();
    this.timers.push(first, hourly);
  }
  stop(): void { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
}
