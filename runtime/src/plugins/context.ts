import type pg from "pg";
import { log as coreLog } from "../logger.js";
import { scrubSecrets } from "../vault.js";
import { HttpError } from "../errors.js";
import type { Approvals, ApprovalFrame, ApprovalView } from "../approvals.js";
import type { Decisions } from "../decisions.js";
import type { PluginEvents } from "./events.js";
import type { TaskSourceRegistry } from "./taskSources.js";
import { INSTALL_OWNER, type PluginSecrets } from "./secrets.js";
import type { PluginStorageSense, AttentionPending, AttentionResolved, WebhookHandler, WebhookRequest, PluginContext, PluginFetchInit, PluginFetchResponse, PluginLog, PluginManifest, PluginRouteHandler, PluginRouteMethod } from "./sdk.js";

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
/** `ctx.fetchUserUrl` only: self-hosted services (WAHA media) answer with larger files than public APIs. */
export const USER_FETCH_MAX_BYTES = 24 * 1024 * 1024;

export interface RouteEntry { method: PluginRouteMethod; segments: string[]; handler: PluginRouteHandler }

export interface ContextDeps {
  pool: Pick<pg.Pool, "query" | "connect">;
  /** The plugin-only secret store. Plugin code never gets the vault. */
  secrets: Pick<PluginSecrets, "resolve" | "set">;
  /** Backs `ctx.webhooks.url` (the host owns the token and the public base). */
  webhookUrl?: (name: string) => Promise<string | null>;
  /** A built-in service in use for this plugin (see `PluginIntegration` in host.ts): host-provided settings and install secrets, or null. */
  integration?: () => Promise<{ settings: Record<string, unknown>; secrets: Record<string, string>; onFetch?: (method: string | undefined, url: string) => void } | null>;
  /** Lazy: the server (and its Notifications) is created after plugins are loaded. Backs `ctx.notify`. */
  notifications?: () => Pick<import("../notifications.js").Notifications, "createFromPlugin" | "clearPluginTag"> | undefined;
  /** Schema mode: schema name. Prefix mode: null and `tablePrefix` is used. */
  schema: string | null;
  tablePrefix: string;
  fetchImpl?: typeof fetch;
  taskSources?: TaskSourceRegistry;
  events?: PluginEvents;
  /** Lazy: the server (and its Approvals) is created after plugins are loaded. */
  approvals?: () => Pick<Approvals, "askAsPlugin"> | undefined;
  /** Lazy, like approvals. Backs `ctx.attention`. */
  attention?: () => { approvals: Pick<Approvals, "subscribe" | "list" | "resolve">; decisions: Pick<Decisions, "subscribe" | "list" | "resolve"> } | undefined;
  /** Lazy. Backs `ctx.storageSense` (bundled storage-sense plugin only). */
  storageSense?: () => PluginStorageSense | undefined;
  /** Backs `ctx.enabledUserIds()`. */
  enabledUserIds?: () => Promise<string[]>;
  sink?: (level: "debug" | "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
}

/** `scrub` redacts every secret value this plugin revealed (raw, URL-encoded and JSON-escaped forms) from strings and JSON-able values. */
export interface WebhookEntry { handler: WebhookHandler; verify?: (req: WebhookRequest) => boolean | Promise<boolean> }
export interface BuiltContext { ctx: PluginContext; routes: RouteEntry[]; internalRoutes: RouteEntry[]; webhooks: Map<string, WebhookEntry>; scrub: (v: unknown) => unknown; scrubText: (text: string) => string; dispose(): void }

/** Exact host or `*.suffix` (any depth below suffix, never the bare suffix). */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1).toLowerCase()) && h.length > a.length - 1 : h === a.toLowerCase()));
}

export function expandSql(sql: string, tablePrefix: string, schemaMode: boolean): string {
  return sql.split("{{p}}").join(schemaMode ? "" : tablePrefix);
}

export function compilePattern(pattern: string): string[] {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) throw new Error("route pattern must start with /");
  return pattern.split("/").filter(Boolean);
}

export function matchRoute(entries: RouteEntry[], method: string, path: string): { entry: RouteEntry; params: Record<string, string> } | null {
  const parts = path.split("/").filter(Boolean);
  for (const entry of entries) {
    if (entry.method !== method || entry.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const seg = entry.segments[i];
      if (seg.startsWith(":")) {
        try {
          const v = decodeURIComponent(parts[i]);
          // Params often end up in upstream URLs or paths: refuse separators, NUL and dot segments after decoding.
          if (/[\/\\\0]/.test(v) || v === "." || v === "..") ok = false; else params[seg.slice(1)] = v;
        } catch { ok = false; }
      }
      else ok = seg === parts[i];
    }
    if (ok) return { entry, params };
  }
  return null;
}

export function buildContext(manifest: PluginManifest, deps: ContextDeps): BuiltContext {
  const id = manifest.id;
  const declared = new Set(manifest.secrets.map((s) => s.name));
  const revealed = new Map<string, string>();
  const routes: RouteEntry[] = [];
  const internalRoutes: RouteEntry[] = [];
  const webhooks = new Map<string, WebhookEntry>();
  const cancels = new Set<() => void>();
  const abort = new AbortController();
  const schemaMode = deps.schema !== null;
  const sink = deps.sink ?? ((level, event, fields) => coreLog[level](event, fields));
  const doFetch = deps.fetchImpl ?? fetch;

  const scrubText = (text: string): string => {
    if (!revealed.size) return text;
    const variants: Record<string, string> = {};
    for (const [k, v] of revealed) {
      for (const form of new Set([v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"), Buffer.from(":" + v).toString("base64")])) variants[k + "\0" + form] = form;
    }
    return scrubSecrets(text, variants);
  };
  async function limitedFetch(u: URL, init: PluginFetchInit, maxBytes = FETCH_MAX_BYTES): Promise<PluginFetchResponse> {
    const res = await doFetch(u, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error(`plugin fetch: response exceeds the ${maxBytes / 1024 / 1024} MiB limit`); }
        chunks.push(value);
      }
    }
    const bytes = Buffer.concat(chunks);
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), bytes, text: () => bytes.toString("utf8"), json: () => JSON.parse(bytes.toString("utf8")) };
  }

  /** Redacts every string leaf (and key) of a JSON-like value. Leaf-wise, so a secret that already sits in a string in its encoded form is caught too. */
  const scrub = (v: unknown, depth = 0): unknown => {
    if (!revealed.size) return v;
    if (typeof v === "string") return scrubText(v);
    if (v === null || typeof v !== "object") return v;
    if (depth > 24) return "[unserializable]";
    if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [scrubText(k), scrub(x, depth + 1)]));
  };
  const emit = (level: "debug" | "info" | "warn" | "error") => (message: string, fields?: Record<string, unknown>) =>
    sink(level, "plugin." + id, { plugin: id, message: scrub(message), ...(fields ? (scrub(fields) as Record<string, unknown>) : {}) });
  const logger: PluginLog = { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };

  const addRoute = (method: PluginRouteMethod) => (pattern: string, handler: PluginRouteHandler) => {
    if (!manifest.contributes.routes) throw new Error('plugin did not declare contributes.routes');
    routes.push({ method, segments: compilePattern(pattern), handler });
  };

  async function dbQuery(sql: string, params: unknown[] = []) {
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      if (schemaMode) await client.query(`SET LOCAL search_path TO "${deps.schema}"`);
      const res = await client.query(expandSql(sql, deps.tablePrefix, schemaMode), params);
      await client.query("COMMIT");
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount ?? res.rows.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const checkKey = (key: string) => { if (typeof key !== "string" || !key || key.length > 128) throw new Error("kv key must be 1-128 characters"); };

  // ---- ctx.attention ----
  const attentionBackend = () => {
    if (!manifest.contributes.attention) throw new Error("plugin did not declare contributes.attention");
    if (manifest.scope !== "install") throw new Error("attention is only available to install-scoped plugins");
    const b = deps.attention?.();
    if (!b) throw new Error("attention is not available");
    return b;
  };
  const attentionOwner = async () => {
    const backend = attentionBackend();
    const owner = await ctx.installOwner();
    if (!owner) throw new HttpError(403, "no_owner", "The plugin has no install owner");
    return { backend, owner };
  };
  const decisionPending = (userId: string, v: ReturnType<Decisions["list"]>[number]): AttentionPending => ({
    kind: "decision", id: v.id, userId, sessionName: v.sessionName, sessionId: v.sessionId, projectId: v.projectId, questions: v.questions,
    allowText: v.questions.some((q) => q.allowText), irreversible: false, createdAt: v.createdAt,
  });
  const approvalPending = (userId: string, v: ApprovalView): AttentionPending => ({
    kind: "approval", id: v.id, userId, sessionName: v.requester.name, sessionId: v.requester.id, projectId: v.requester.projectId, action: v.action, detail: v.detail,
    options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }], allowText: false, irreversible: v.irreversible, createdAt: v.createdAt,
  });
  // One shared event wiring per ctx; each onPending/onResolved subscriber gets its own subscription so it can be cancelled alone.
  const attach = (which: "pending" | "resolved", fn: (e: never) => void): (() => void) => {
    const backend = attentionBackend();
    let off: (() => void)[] = [];
    let stopped = false;
    const cancel = () => { stopped = true; for (const o of off) o(); off = []; cancels.delete(cancel); };
    cancels.add(cancel);
    const safe = <T,>(e: T) => { try { (fn as (e: T) => void)(e); } catch (err) { logger.error("attention handler failed", { error: err instanceof Error ? err.message : String(err) }); } };
    void ctx.installOwner().then((owner) => {
      if (stopped || !owner) return;
      const delivered = new Set<string>();
      const ended = new Set<string>();
      const once = (e: AttentionResolved) => { if (ended.has(e.id)) return; ended.add(e.id); safe(e); };
      // Who answered comes from the settle itself (its `via`), so an app answer that lands while a plugin call is in flight is still "app".
      const resolvedBy = (via: string | undefined): AttentionResolved["by"] => (via?.startsWith("plugin:") ? "plugin" : "app");
      off.push(backend.decisions.subscribe(owner, (frame) => {
        if (which === "pending" && frame.type === "decision-request") { if (!delivered.has(frame.decision.id)) { delivered.add(frame.decision.id); safe(decisionPending(owner, frame.decision)); } }
        if (which === "resolved" && frame.type === "decision-resolved") once({ kind: "decision", id: frame.id, status: frame.status, by: resolvedBy(frame.via) });
      }));
      off.push(backend.approvals.subscribe(owner, (frame: ApprovalFrame) => {
        if (which === "pending" && frame.type === "approval-request") {
          if (frame.approval.requester.kind === "plugin" || delivered.has(frame.approval.id)) return;
          delivered.add(frame.approval.id); safe(approvalPending(owner, frame.approval));
        }
        if (which === "resolved" && frame.type === "approval-resolved" && !frame.requesterSessionId.startsWith("plugin:")) once({ kind: "approval", id: frame.id, status: frame.status, by: resolvedBy(frame.via) });
      }));
      if (which === "pending") {
        // Replay what is already waiting (subscribed first, so nothing is missed; `delivered` removes duplicates).
        for (const d of backend.decisions.list(owner)) if (!delivered.has(d.id)) { delivered.add(d.id); safe(decisionPending(owner, d)); }
        for (const a of backend.approvals.list(owner)) if (a.requester.kind !== "plugin" && !delivered.has(a.id)) { delivered.add(a.id); safe(approvalPending(owner, a)); }
      }
    }).catch((err) => logger.error("attention subscribe failed", { error: err instanceof Error ? err.message : String(err) }));
    return cancel;
  };

  const ctx: PluginContext = {
    pluginId: id,
    manifest,
    routes: { get: addRoute("GET"), post: addRoute("POST"), put: addRoute("PUT"), delete: addRoute("DELETE") },
    internalRoutes: {
      call(pattern, handler) {
        if (!manifest.contributes.internalRoutes) throw new Error("plugin did not declare contributes.internalRoutes");
        internalRoutes.push({ method: "POST", segments: compilePattern(pattern), handler });
      },
    },
    webhooks: {
      on(name, handler, options) {
        if (!manifest.contributes.webhooks.includes(name)) throw new Error("webhook is not declared in the plugin manifest");
        webhooks.set(name, { handler, verify: options?.verify });
      },
      async url(name) {
        if (manifest.scope !== "install") throw new Error("webhooks.url is only available to install-scoped plugins");
        if (!manifest.contributes.webhooks.includes(name)) throw new Error("webhook is not declared in the plugin manifest");
        const url = (await deps.webhookUrl?.(name)) ?? null;
        // The token in the path is a credential: anything the plugin returns or logs is scrubbed of it.
        if (url) revealed.set("webhook-url\0" + name, url.slice(url.lastIndexOf("/") + 1));
        return url;
      },
    },
    httpError: (status: number, code: string, message: string) => new HttpError(status, code, String(message).slice(0, 300)),
    async installOwner() {
      if (manifest.scope !== "install") throw new Error("installOwner is only available to install-scoped plugins");
      return ((await deps.pool.query("SELECT config_owner FROM floq_plugins WHERE id = $1", [id])).rows[0]?.config_owner as string | null | undefined) ?? null;
    },
    secrets: {
      async setInstall(name, value) {
        if (manifest.scope !== "install") throw new Error("setInstall is only available to install-scoped plugins");
        if (!declared.has(name)) throw new Error(`secret ${JSON.stringify(String(name).slice(0, 64))} is not declared in the plugin manifest`);
        await deps.secrets.set(id, INSTALL_OWNER, name, value, "plugin:" + id);
        revealed.set(name + "\0" + INSTALL_OWNER, value);
      },
      async getInstall(name) {
        if (manifest.scope !== "install") throw new Error("getInstall is only available to install-scoped plugins; use get(userId, name)");
        if (!declared.has(name)) throw new Error(`secret ${JSON.stringify(String(name).slice(0, 64))} is not declared in the plugin manifest`);
        // A built-in service in use: the host owns the key. It is scrubbed from everything the plugin returns or logs, like a stored one.
        const provided = (await deps.integration?.())?.secrets[name];
        if (provided !== undefined) { revealed.set(name + "\0" + INSTALL_OWNER, provided); return provided; }
        const value = await deps.secrets.resolve(id, INSTALL_OWNER, name);
        if (value !== undefined) revealed.set(name + "\0" + INSTALL_OWNER, value);
        return value;
      },
      async get(userId, name) {
        if (manifest.scope === "install") throw new Error("get(userId, name) is only available to user-scoped plugins; use getInstall(name)");
        if (!declared.has(name)) throw new Error(`secret ${JSON.stringify(String(name).slice(0, 64))} is not declared in the plugin manifest`);
        const value = await deps.secrets.resolve(id, userId, name);
        if (value !== undefined) revealed.set(name + "\0" + userId, value);
        return value;
      },
    },
    fetch: (url: string, init: PluginFetchInit = {}) => {
      let u: URL;
      try { u = new URL(url); } catch { return Promise.reject(new Error("plugin fetch: invalid URL")); }
      if (u.protocol !== "https:") return Promise.reject(new Error("plugin fetch: only https is allowed"));
      if (!hostAllowed(u.hostname, manifest.network.allow)) return Promise.reject(new Error(`plugin fetch: host ${u.hostname} is not in the plugin's network allow-list`));
      return limitedFetch(u, init);
    },
    /**
     * For self-hosted services whose address the admin or user entered in a `url` setting (WAHA). Only the origin of a saved `url`
     * setting is reachable (http or https, private networks included because the owner chose it); everything else is refused.
     */
    async fetchUserUrl(userId: string, url: string, init: PluginFetchInit = {}) {
      let u: URL;
      try { u = new URL(url); } catch { throw new Error("plugin fetch: invalid URL"); }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("plugin fetch: only http(s) is allowed");
      const keys = manifest.settings.filter((d) => d.type === "url").map((d) => d.key);
      if (!keys.length) throw new Error("plugin fetch: the plugin declares no url setting");
      const saved = await ctx.settings.get(userId);
      const origins = keys.flatMap((k) => { try { return typeof saved[k] === "string" ? [new URL(saved[k] as string).origin] : []; } catch { return []; } });
      if (!origins.includes(u.origin)) throw new Error("plugin fetch: address is not one the owner configured in the plugin settings");
      try { (await deps.integration?.())?.onFetch?.(init.method, url); } catch { /* activity tracking never fails a request */ }
      return limitedFetch(u, init, USER_FETCH_MAX_BYTES);
    },
    db: {
      query: dbQuery,
      forUser: (userId) => ({ query: (sql, params = []) => dbQuery(sql, [userId, ...params]) }),
    },
    settings: {
      async get(userId) {
        const row = manifest.scope === "install"
          ? (await deps.pool.query("SELECT config AS v FROM floq_plugins WHERE id = $1", [id])).rows[0]
          : (await deps.pool.query("SELECT settings AS v FROM floq_plugin_user_settings WHERE plugin_id = $1 AND user_id = $2", [id, userId])).rows[0];
        const { __kv: _kv, ...rest } = (row?.v ?? {}) as Record<string, unknown>;
        if (manifest.scope !== "install") return rest;
        return { ...rest, ...((await deps.integration?.())?.settings ?? {}) };
      },
    },
    kv: {
      async get(userId, key) {
        checkKey(key);
        const r = await deps.pool.query("SELECT settings->'__kv'->$3::text AS v FROM floq_plugin_user_settings WHERE plugin_id = $1 AND user_id = $2", [id, userId, key]);
        return r.rows[0]?.v ?? undefined;
      },
      async set(userId, key, value) {
        checkKey(key);
        const json = JSON.stringify(value ?? null);
        await deps.pool.query(
          `INSERT INTO floq_plugin_user_settings (plugin_id, user_id, settings)
           VALUES ($1, $2, jsonb_build_object('__kv', jsonb_build_object($3::text, $4::jsonb)))
           ON CONFLICT (plugin_id, user_id) DO UPDATE SET
             settings = jsonb_set(floq_plugin_user_settings.settings, '{__kv}', COALESCE(floq_plugin_user_settings.settings->'__kv', '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb)),
             updated_at = now()`,
          [id, userId, key, json],
        );
      },
    },
    taskSources: {
      register({ id: sourceId, provider }) {
        if (!manifest.contributes.taskSources.some((d) => d.id === sourceId)) throw new Error("task source is not declared in the plugin manifest");
        if (!deps.taskSources) throw new Error("task sources are not available");
        deps.taskSources.register(id, sourceId, provider);
      },
    },
    enabledUserIds: () => deps.enabledUserIds?.() ?? Promise.resolve([]),
    storageSense: new Proxy({} as PluginStorageSense, {
      get(_t, prop) {
        if (id !== "storage-sense") throw new Error("storageSense is only available to the storage-sense plugin");
        const api = deps.storageSense?.();
        if (!api) throw new Error("storage sense is not available");
        return (api as unknown as Record<string | symbol, unknown>)[prop];
      },
    }),
    events: {
      publish(userId, name, data) {
        if (!deps.events) throw new Error("events are not available");
        deps.events.publish(userId, id, name, scrub(data));
      },
    },
    async notify(userId, note) {
      const notifications = deps.notifications?.();
      if (!notifications) throw new Error("notifications are not available");
      const n = await notifications.createFromPlugin(userId, { plugin: { id, name: manifest.name, icon: manifest.icon ?? null, views: manifest.contributes.views.map((v) => v.id) }, note: scrub(note) as Record<string, unknown> });
      return { id: n.id };
    },
    notifications: {
      async clear(userId, tag) {
        const notifications = deps.notifications?.();
        if (!notifications) throw new Error("notifications are not available");
        if (typeof tag !== "string" || !tag || tag.length > 200) throw new Error("invalid tag");
        await notifications.clearPluginTag(userId, id, tag);
      },
    },
    toast(userId, toast) {
      if (!deps.events) throw new Error("events are not available");
      const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
      deps.events.publish(userId, id, "toast", scrub({ title: clip(toast.title, 120) ?? "", description: clip(toast.description, 300) }));
    },
    approvals: {
      request({ userId, action, detail, signal, timeoutMs }) {
        const approvals = deps.approvals?.();
        if (!approvals) return Promise.reject(new Error("approvals are not available"));
        // Withdrawn when the plugin stops or the caller's own signal fires (an agent that stopped waiting).
        const both = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
        const wait = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1_000), 10 * 60_000) : undefined;
        return approvals.askAsPlugin(userId, { id, name: manifest.name }, { action, detail }, both, wait);
      },
    },
    attention: {
      onPending(fn) { return attach("pending", fn); },
      onResolved(fn) { return attach("resolved", fn); },
      async resolveDecision(decisionId, answers) {
        const { backend, owner } = await attentionOwner();
        await backend.decisions.resolve(owner, decisionId, answers, { via: "plugin:" + id });
      },
      async resolveApproval(approvalId, decision) {
        const { backend, owner } = await attentionOwner();
        await backend.approvals.resolve(owner, approvalId, decision, { via: "plugin:" + id });
      },
    },
    log: logger,
    schedule(intervalMs, fn) {
      if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error("schedule interval must be at least 1000 ms");
      let running = false;
      const timer = setInterval(() => {
        if (running) return;
        running = true;
        Promise.resolve().then(fn).catch((e) => logger.error("scheduled task failed", { error: e instanceof Error ? e.message : String(e) })).finally(() => { running = false; });
      }, intervalMs);
      timer.unref?.();
      const cancel = () => { clearInterval(timer); cancels.delete(cancel); };
      cancels.add(cancel);
      return cancel;
    },
  };
  return { ctx, routes, internalRoutes, webhooks, scrub, scrubText, dispose: () => { abort.abort(); for (const c of [...cancels]) c(); routes.length = 0; internalRoutes.length = 0; webhooks.clear(); deps.taskSources?.unregisterPlugin(id); } };
}
