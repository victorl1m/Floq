import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { createClient, RESP_TYPES } from "redis";
import { buildGraph, GRAPH_MAX_NODES, type GraphInput, type GraphResult } from "./memoryGraph.js";
import { HttpError, badRequest, conflict, notFound } from "./errors.js";
import { log } from "./logger.js";
import { EMBED_DIMS, toFloat32Blob, type Embedder } from "./embeddings.js";
import { defangText } from "./wiredContext.js";

/**
 * Agent memory: durable facts, decisions, procedures and episodes agents (and the user) keep per project or per user.
 * Stored in Redis (HASH `mem:{uuid}`), searched with the Redis Query Engine: full-text (BM25) plus, when embeddings are on,
 * vector KNN, fused with Reciprocal Rank Fusion. Without FLOQ_REDIS_URL, or while Redis is unreachable, every operation
 * fails with 503 `memory_unavailable` and the runtime carries on without the feature.
 */

export const MEMORY_TYPES = ["fact", "decision", "procedure", "episode"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryScope = "project" | "user";
export type MemoryActor = "agent" | "user" | "system";

export const MEMORY_MAX_TEXT = 4000;
export const MEMORY_MAX_TITLE = 200;
export const MEMORY_MAX_PER_PROJECT = 2000;
export const MERGE_MAX_DISTANCE = 0.08; // cosine similarity >= 0.92
export const RRF_K = 60;
export const SEARCH_POOL = 50;
export const EVENTS_MAX = 200;
const NONE = "_none";
const INDEX_PREFIX = "idx:mem:"; // every index of ours; the live one is idx:mem:v2:d<dims>
const MODEL_KEY = "memmeta:model"; // the embedder (model:dtype:dims) the stored vectors belong to
const BACKFILL_BATCH = 8;
export const MEMORY_MAX_TOTAL_FACTOR = 2; // valid + invalid per project
export const INVALID_TTL_MS = 30 * 24 * 3600 * 1000;
const CMD_TIMEOUT_MS = 5000;
/** Idle keepalive: node-redis' socketTimeout is a socket IDLE timeout, so an idle connection must see traffic more often than that or it is torn down and rebuilt in a loop. */
export const PING_INTERVAL_MS = 10_000;
export const SOCKET_IDLE_TIMEOUT_MS = 30_000;
const PINNED_TIMEOUT_MS = 1500;
const INDEX_ALIAS = "idx:mem";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Memory {
  id: string;
  projectId: string | null;
  scope: MemoryScope;
  type: MemoryType;
  title: string;
  text: string;
  pinned: boolean;
  author: string | null;
  authorSession: string | null;
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  supersededBy: string | null;
  invalidReason: string | null;
  score?: number;
}

export interface MemoryEvent { sessionId: string | null; actor: MemoryActor; action: string; before: unknown; after: unknown; at: string }

/** Who is acting and which project they are in. `anyProject` (the user's app) lifts the project restriction. */
export interface MemoryCtx { userId: string; projectId: string | null; sessionId?: string | null; actor: MemoryActor; author?: string | null; anyProject?: boolean }

export interface MigrationStatus { done: boolean; notes: number; added: number; pinned: number; at: string | null }
export interface MemoryStatus { enabled: boolean; redis: boolean; backend: "redis" | "dragonfly" | null; embeddings: "local" | "openai" | "off"; model: string; ready: boolean; /** every memory carries a vector of the current model (hybrid search is on) */ vectors: boolean; migration: MigrationStatus | null }

// ---------- pure helpers (unit tested without Redis) ----------

/** Escape a value for a RediSearch TAG filter: every character that is not a letter, digit or underscore. */
export function escapeTag(value: string): string {
  return value.replace(/[^\p{L}\p{N}_]/gu, (c) => "\\" + c);
}

/** Words of a free-text query (letters, digits, underscore only, so nothing in it can act as query syntax). */
export function tokenize(query: string, max = 20): string[] {
  const seen = new Set<string>();
  for (const t of query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    if (seen.size >= max) break;
  }
  return [...seen];
}

export interface FilterOptions { userId: string; projectId: string | null; type?: string; pinned?: boolean; includeInvalid?: boolean; anyProject?: boolean }

/** The access filter every query carries: this user, valid, in this project or user-scoped. */
export function buildFilter(o: FilterOptions): string {
  const parts = [`@user_id:{${escapeTag(o.userId)}}`, o.includeInvalid ? "@valid:{0|1}" : "@valid:{1}"];
  if (!o.anyProject) parts.push(o.projectId ? `(@project_id:{${escapeTag(o.projectId)}}|@scope:{user})` : "@scope:{user}");
  else if (o.projectId) parts.push(`(@project_id:{${escapeTag(o.projectId)}}|@scope:{user})`);
  if (o.type) parts.push(`@type:{${escapeTag(o.type)}}`);
  if (o.pinned !== undefined) parts.push(`@pinned:{${o.pinned ? 1 : 0}}`);
  return "(" + parts.join(" ") + ")";
}

/** Full-text query: the filter AND any of the words. null when the query has no usable word. */
export function buildTextQuery(filter: string, query: string): string | null {
  const words = tokenize(query);
  return words.length ? `${filter} (${words.join("|")})` : null;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32);
}

/** Query words that look like identifiers (contain a digit or underscore: v2, ENV_VAR, 8080). */
export const identifierTokens = (query: string): string[] => tokenize(query, 40).filter((t) => /[\d_]/.test(t));
export const ID_BOOST = 0.008;

/**
 * Hybrid ranking. The vector ranking decides (equal-weight RRF measurably hurt strong embedders: nDCG@10 0.586 -> 0.485 on
 * the hard set); BM25 only adds a boost to a candidate that contains every identifier-like word of the query, so exact
 * ids still win. `textOf` gives the text of the full-text candidates (only needed when the query has identifiers).
 */
export function fuseHybrid(vectorIds: string[], textIds: string[], query: string, textOf: (id: string) => string | undefined, boost = ID_BOOST): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  vectorIds.forEach((id, r) => score.set(id, 1 / (RRF_K + r + 1)));
  const ids = identifierTokens(query);
  if (ids.length) {
    for (const id of textIds) {
      const words = new Set(tokenize(textOf(id) ?? "", 10_000));
      if (ids.every((t) => words.has(t))) score.set(id, (score.get(id) ?? 0) + boost);
    }
  }
  return [...score].map(([id, sc]) => ({ id, score: sc })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Reciprocal Rank Fusion over ranked id lists, optionally weighted per list. */
export function rrf(lists: string[][], k = RRF_K, weights?: number[]): Array<{ id: string; score: number }> {
  const score = new Map<string, number>();
  lists.forEach((list, li) => list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + (weights?.[li] ?? 1) / (k + i + 1))));
  return [...score].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const FIELDS = ["user_id", "project_id", "scope", "type", "title", "text", "pinned", "valid", "author", "author_session", "content_hash", "created_at", "updated_at", "invalidated_at", "superseded_by", "invalid_reason", "embed_model"] as const;
type Fields = Record<(typeof FIELDS)[number], string | null>;

const iso = (ms: string | null): string | null => { const n = Number(ms); return n > 0 ? new Date(n).toISOString() : null; };
const nz = (v: string | null): string | null => (v ? v : null);

/** Hash fields (as read with HMGET, in FIELDS order) to the public JSON; null when the key is gone. */
export function toMemory(id: string, values: Array<string | null>): (Memory & { userId: string; valid: boolean; contentHash: string; embedModel: string | null }) | null {
  const f = Object.fromEntries(FIELDS.map((k, i) => [k, values[i] ?? null])) as Fields;
  if (!f.user_id) return null;
  const projectId = f.project_id && f.project_id !== NONE ? f.project_id : null;
  return {
    id, userId: f.user_id, projectId,
    scope: f.scope === "user" ? "user" : "project",
    type: (MEMORY_TYPES as readonly string[]).includes(f.type ?? "") ? (f.type as MemoryType) : "fact",
    title: f.title ?? "", text: f.text ?? "", pinned: f.pinned === "1",
    author: nz(f.author), authorSession: nz(f.author_session),
    createdAt: iso(f.created_at) ?? new Date(0).toISOString(), updatedAt: iso(f.updated_at) ?? new Date(0).toISOString(),
    invalidatedAt: iso(f.invalidated_at), supersededBy: nz(f.superseded_by), invalidReason: nz(f.invalid_reason),
    valid: f.valid === "1", contentHash: f.content_hash ?? "", embedModel: nz(f.embed_model),
  };
}

type Stored = NonNullable<ReturnType<typeof toMemory>>;
const publicMemory = (m: Stored, score?: number): Memory => {
  const { userId: _u, valid: _v, contentHash: _h, embedModel: _e, ...rest } = m;
  return score === undefined ? rest : { ...rest, score: Math.round(score * 1e6) / 1e6 };
};

/** FT.SEARCH reply (RESP2) to ids (+ the score when WITHSCORES, + the first returned field value when RETURN 1). */
export function parseSearchReply(reply: unknown, withScores: boolean): Array<{ id: string; score: number; field?: string }> {
  if (!Array.isArray(reply)) return [];
  const out: Array<{ id: string; score: number; field?: string }> = [];
  let i = 1;
  while (i < reply.length) {
    const id = String(reply[i++]);
    let score = 0;
    if (withScores) score = Number(reply[i++]);
    let field: string | undefined;
    if (Array.isArray(reply[i])) { field = reply[i][1] === undefined ? undefined : String(reply[i][1]); i++; }
    out.push({ id: id.replace(/^mem:/, ""), score, field });
  }
  return out;
}

/** Parse a Redis URL; null unless it is a well-formed redis: / rediss: URL. */
export function parseRedisUrl(url: string): URL | null {
  try { const u = new URL(url); return u.protocol === "redis:" || u.protocol === "rediss:" ? u : null; } catch { return null; }
}

/** Safe to log: the password (and a bare username) never appear, whatever the URL looks like. */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    else if (u.username) u.username = "***";
    else if (url.includes("@")) return "<redacted>";
    const out = u.toString();
    return out.includes("@") && !out.includes("***") ? "<redacted>" : out;
  } catch { return "<unparseable>"; }
}

export function redisUrlHasPassword(url: string): boolean {
  const u = parseRedisUrl(url);
  return !!u && !!u.password;
}

/** A memory nobody but the user wrote: agents must not change it. */
export const isUserOwned = (m: { author: string | null; authorSession: string | null }): boolean => !m.author && !m.authorSession;

// ---------- validation ----------

export interface MemoryInput { text?: unknown; title?: unknown; type?: unknown; pinned?: unknown; scope?: unknown }

function parseText(v: unknown): string {
  if (typeof v !== "string") throw badRequest("text must be a string", "invalid_memory");
  const t = v.trim();
  if (!t) throw badRequest("text is required", "invalid_memory");
  if (t.length > MEMORY_MAX_TEXT) throw badRequest(`text must be at most ${MEMORY_MAX_TEXT} characters`, "invalid_memory");
  if (t.includes("\0")) throw badRequest("text must not contain NUL bytes", "invalid_memory");
  return t;
}
function parseTitle(v: unknown): string {
  if (typeof v !== "string") throw badRequest("title must be a string", "invalid_memory");
  if (v.includes("\0")) throw badRequest("title must not contain NUL bytes", "invalid_memory");
  return v.replace(/\s+/g, " ").trim().slice(0, MEMORY_MAX_TITLE);
}
function parseType(v: unknown): MemoryType {
  if (typeof v !== "string" || !(MEMORY_TYPES as readonly string[]).includes(v)) throw badRequest("type must be one of " + MEMORY_TYPES.join(", "), "invalid_memory");
  return v as MemoryType;
}
const parseBool = (name: string, v: unknown): boolean => { if (typeof v !== "boolean") throw badRequest(name + " must be a boolean", "invalid_memory"); return v; };
const requireId = (v: unknown): string => { if (typeof v !== "string" || !UUID.test(v)) throw badRequest("id must be a memory id", "invalid_memory"); return v.toLowerCase(); };

// ---------- the service ----------

export interface RedisLike {
  /** `binary`: blob strings come back as Buffers (stored vectors). */
  sendCommand(args: Array<string | Buffer>, binary?: boolean): Promise<unknown>;
  readonly isReady: boolean;
  /** Quit the connection (stop reconnecting). */
  close?(): Promise<void>;
}

export interface MemoryServiceOptions {
  url?: string;
  embedder: Embedder;
  /** Test seam: a ready client instead of connecting to `url`. */
  client?: RedisLike;
  /** Called after a pinned memory changed (the project's agents need a refreshed wired context). */
  onPinnedChange?: (userId: string, memory: Memory, exceptSessionId: string | null) => void;
}

const disabled = () => new HttpError(503, "memory_disabled", "Memory is disabled on this Floq server (set FLOQ_REDIS_URL)");
const unavailable = () => new HttpError(503, "memory_unavailable", "The memory store is not reachable right now; try again shortly");
const msg = (error: unknown) => (error instanceof Error ? error.message.slice(0, 160) : "unknown");

export class MemoryService {
  private client: RedisLike | null;
  private indexReady = false;
  private warned = false;
  private invalidUrl = false;
  private backend: "redis" | "dragonfly" | null = null;
  private raw: { quit(): Promise<unknown>; disconnect(): unknown } | null = null;
  private migration: MigrationStatus | null = null;
  private backfilling = false;
  /** Dimensions of the live index; vector search runs only once every memory carries a vector of the current model. */
  private indexDims = EMBED_DIMS;
  private indexName = INDEX_PREFIX + "v2:d" + EMBED_DIMS;
  private vectorsComplete = true;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly embedder: Embedder;
  private readonly url: string | undefined;
  onPinnedChange?: MemoryServiceOptions["onPinnedChange"];

  constructor(private readonly pool: pg.Pool, options: MemoryServiceOptions) {
    this.embedder = options.embedder;
    this.url = options.url?.trim() || undefined;
    this.client = options.client ?? null;
    this.onPinnedChange = options.onPinnedChange;
  }

  /** Connect in the background and create the index; never throws and never delays startup. Reconnects on its own. */
  start(): void {
    try {
      if (this.client) { void this.prepare(); return; }
      if (!this.url) { log.info("memory.disabled", { reason: "FLOQ_REDIS_URL not set" }); return; }
      const parsed = parseRedisUrl(this.url);
      if (!parsed) {
        this.invalidUrl = true;
        log.error("memory.invalid_url", { redis: redactRedisUrl(this.url), hint: "FLOQ_REDIS_URL must look like redis://[:password@]host:6379 (or rediss://)" });
        return;
      }
      log.info("memory.enabled", { redis: redactRedisUrl(this.url), embeddings: this.embedder.mode });
      if (!parsed.password && !/^(1|required)$/i.test(process.env.FLOQ_NETNS ?? "")) {
        log.warn("memory.redis_no_auth", { redis: redactRedisUrl(this.url), hint: "agent sandboxes share the container network: protect the store with a password (redis://:password@host:6379)" });
      }
      const raw = createClient({
        url: this.url,
        disableOfflineQueue: true,
        pingInterval: PING_INTERVAL_MS,
        socket: { connectTimeout: CMD_TIMEOUT_MS, socketTimeout: SOCKET_IDLE_TIMEOUT_MS, reconnectStrategy: (retries: number) => Math.min(500 * 2 ** Math.min(retries, 5), 15_000) },
      });
      raw.on("error", (error: unknown) => { if (!this.warned) { this.warned = true; log.warn("memory.redis_error", { error: this.scrub(msg(error)) }); } });
      raw.on("ready", () => { this.warned = false; void this.prepare(); });
      raw.on("end", () => { this.indexReady = false; });
      this.raw = raw as never;
      this.client = { sendCommand: (args, binary) => raw.sendCommand(args as never, binary ? ({ typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } } as never) : undefined) as Promise<unknown>, get isReady() { return raw.isReady; } };
      raw.connect().catch((error: unknown) => log.warn("memory.redis_connect_failed", { error: this.scrub(msg(error)) }));
    } catch (error) {
      this.invalidUrl = true;
      log.error("memory.start_failed", { error: this.scrub(msg(error)) });
    }
  }

  /** Log text never carries the URL's password. */
  private scrub(text: string): string {
    const u = this.url ? parseRedisUrl(this.url) : null;
    return u?.password ? text.split(decodeURIComponent(u.password)).join("***") : text;
  }

  /** Stop reconnecting and close the connection. */
  async stop(): Promise<void> {
    this.indexReady = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const raw = this.raw;
    this.raw = null;
    if (raw) { try { await raw.quit(); } catch { try { raw.disconnect(); } catch { /* already closed */ } } }
    else await this.client?.close?.();
  }

  /** Index (idempotent), maintenance and the embedding warm-up / backfill. */
  private async prepare(): Promise<void> {
    try {
      await this.detectBackend();
      await this.ensureIndex();
      await this.checkModel();
      await this.loadMigration();
      this.indexReady = true;
      log.info("memory.ready", { backend: this.backend, embeddings: this.embedder.mode });
      void this.purgeInvalid().catch((error) => log.warn("memory.purge_failed", { error: this.scrub(msg(error)) }));
      if (!this.timers.length) {
        const daily = setInterval(() => { if (this.available()) void this.purgeInvalid().catch(() => undefined); }, 24 * 3600 * 1000);
        daily.unref();
        this.timers.push(daily);
      }
      this.startEmbedding();
    } catch (error) {
      log.warn("memory.index_failed", { error: this.scrub(msg(error)) });
    }
  }

  /** Warm the embedder, settle the dimensions (a model of unknown size is probed), rebuild the index on a size change, backfill. */
  private startEmbedding(): void {
    if (this.embedder.mode === "off") return;
    const attempt = async () => {
      try {
        await this.embedder.warmup();
        const dims = await this.embedder.resolveDims();
        if (dims && dims !== this.indexDims && this.available()) { await this.ensureIndex(); await this.checkModel(); }
        await this.backfill();
      } catch (error) { log.warn("memory.embedding_setup_failed", { error: this.scrub(msg(error)) }); }
    };
    void attempt();
    if (this.timers.length < 2) {
      const retry = setInterval(() => { if (this.available() && (!this.embedder.isReady() || !this.vectorsComplete)) void attempt(); }, 60_000);
      retry.unref();
      this.timers.push(retry);
    }
  }

  /** Vectors of another model or size are stale: vector search waits (full-text meanwhile) until the backfill replaced them. */
  private async checkModel(): Promise<void> {
    if (this.embedder.mode === "off") { this.vectorsComplete = false; return; }
    const stored = await this.cmd("GET", MODEL_KEY);
    this.vectorsComplete = stored === this.embedder.model;
  }

  /** Redis or Dragonfly (INFO server carries dragonfly_version). */
  private async detectBackend(): Promise<void> {
    try { this.backend = /(^|\n)dragonfly_version:/.test(String(await this.cmd("INFO", "server"))) ? "dragonfly" : "redis"; }
    catch { this.backend = "redis"; }
  }

  /**
   * The index is named by its vector size (idx:mem:v2:d<dims>), with case-sensitive 0x1f-separated id TAGs. The alias moves
   * to it and every older index of ours is dropped (their hashes stay). When the size changed, the old vectors are removed
   * first: a hash holding a vector of the wrong length would not be indexed at all, full-text included.
   */
  async ensureIndex(): Promise<void> {
    const ignore = (error: unknown, what: RegExp) => { if (!what.test(error instanceof Error ? error.message : String(error))) throw error; };
    const dims = this.embedder.dims ?? EMBED_DIMS;
    const name = INDEX_PREFIX + "v2:d" + dims;
    let existing: string[] = [];
    try { existing = ((await this.cmd("FT._LIST")) as unknown[]).map(String).filter((n) => n.startsWith(INDEX_PREFIX) && n !== INDEX_ALIAS); } catch { /* unsupported: fall through */ }
    const others = existing.filter((n) => n !== name);
    const dimsOf = (n: string) => Number(/:d(\d+)$/.exec(n)?.[1] ?? EMBED_DIMS);
    if (others.some((n) => dimsOf(n) !== dims) && !existing.includes(name)) await this.stripVectors();
    const create = () => this.cmd("FT.CREATE", name, "ON", "HASH", "PREFIX", "1", "mem:", "SCHEMA",
      "user_id", "TAG", "SEPARATOR", "\x1f", "CASESENSITIVE", "project_id", "TAG", "SEPARATOR", "\x1f", "CASESENSITIVE",
      "scope", "TAG", "type", "TAG", "pinned", "TAG", "valid", "TAG",
      "content_hash", "TAG", "SEPARATOR", "\x1f", "CASESENSITIVE",
      "title", "TEXT", "WEIGHT", "2", "text", "TEXT", "updated_at", "NUMERIC", "SORTABLE",
      "embedding", "VECTOR", "HNSW", "6", "TYPE", "FLOAT32", "DIM", String(dims), "DISTANCE_METRIC", "COSINE");
    try { await create(); }
    catch (error) {
      ignore(error, /already exists/i);
      // An index of this name with the wrong schema (no case-sensitive id TAGs) is rebuilt; the hashes stay.
      if (!/CASESENSITIVE/i.test(JSON.stringify(await this.cmd("FT.INFO", name)))) { await this.cmd("FT.DROPINDEX", name); await create(); }
    }
    try { await this.cmd("FT.ALIASUPDATE", INDEX_ALIAS, name); }
    catch { try { await this.cmd("FT.ALIASDEL", INDEX_ALIAS); } catch { /* none yet */ } await this.cmd("FT.ALIASADD", INDEX_ALIAS, name); }
    for (const old of others) { try { await this.cmd("FT.DROPINDEX", old); } catch { /* not there */ } }
    this.indexName = name;
    this.indexDims = dims;
  }

  /** Remove every stored vector (and its model tag); the backfill recomputes them. */
  private async stripVectors(): Promise<void> {
    let cursor = "0";
    do {
      const reply = (await this.cmd("SCAN", cursor, "MATCH", "mem:*", "COUNT", 200)) as [string, string[]];
      cursor = String(reply[0]);
      await Promise.all(reply[1].map((key) => this.cmd("HDEL", key, "embedding", "embed_model")));
    } while (cursor !== "0");
    await this.cmd("DEL", MODEL_KEY);
    this.vectorsComplete = false;
    log.info("memory.vectors_reset", { reason: "embedding size changed" });
  }

  /** Configured (FLOQ_REDIS_URL set); says nothing about reachability. */
  enabled(): boolean { return !!(this.url || this.client); }

  available(): boolean { return !this.invalidUrl && !!this.client?.isReady && this.indexReady; }

  status(): MemoryStatus {
    return { enabled: this.enabled(), redis: this.available(), backend: this.available() ? this.backend : null, embeddings: this.embedder.mode, model: this.embedder.model, ready: this.available() && this.embedder.isReady(), vectors: this.vectorsComplete && this.embedder.mode !== "off", migration: this.migration };
  }

  /** Marker keys for the notes importer: EXISTS / SET / DEL on `memmig:*` keys only (a deliberately small public API). */
  marker = async (...args: Array<string | number>): Promise<unknown> => {
    const [op, key] = [String(args[0]).toUpperCase(), String(args[1] ?? "")];
    if (!["EXISTS", "SET", "DEL"].includes(op) || !key.startsWith("memmig:")) throw new Error("marker: only EXISTS/SET/DEL on memmig:* keys");
    return this.guard(async () => this.cmd(op, ...args.slice(1)));
  };

  // ----- import status (written by the notes importer) -----

  private async loadMigration(): Promise<void> {
    try { const raw = await this.cmd("GET", "memmig:status"); this.migration = typeof raw === "string" ? (JSON.parse(raw) as MigrationStatus) : null; } catch { this.migration = null; }
  }
  getMigrationStatus(): MigrationStatus | null { return this.migration; }
  async setMigrationStatus(status: MigrationStatus): Promise<void> {
    await this.guard(async () => { await this.cmd("SET", "memmig:status", JSON.stringify(status)); });
    this.migration = status;
  }

  private cmd(...args: Array<string | number | Buffer>): Promise<unknown> {
    if (!this.client) return Promise.reject(disabled());
    return this.client.sendCommand(args.map((a) => (typeof a === "number" ? String(a) : a)));
  }

  private requireReady(): void {
    if (!this.enabled()) throw disabled();
    if (!this.available()) throw unavailable();
  }

  /** Run a Redis operation; connection-level failures surface as a generic 503 (detail only in the log), never as a crash. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    this.requireReady();
    try { return await fn(); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      log.warn("memory.redis_failed", { error: this.scrub(msg(error)) });
      throw unavailable();
    }
  }

  /** The session's project and name; throws 404 for a session that is not the user's. */
  async ctxForSession(userId: string, sessionId: string): Promise<MemoryCtx> {
    const r = await this.pool.query("SELECT project_id, title FROM agent_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
    const row = r.rows[0] as { project_id: string | null; title: string } | undefined;
    if (!row) throw notFound("Unknown session");
    return { userId, projectId: row.project_id ?? null, sessionId, actor: "agent", author: row.title?.trim() || "agent" };
  }

  // ----- reads -----

  private async load(id: string): Promise<Stored | null> {
    const values = (await this.cmd("HMGET", "mem:" + id, ...FIELDS)) as Array<string | null>;
    return toMemory(id, values);
  }

  /** One pipelined round trip (node-redis batches commands issued in the same tick). */
  private async loadMany(ids: string[]): Promise<Stored[]> {
    return (await Promise.all(ids.map((id) => this.load(id)))).filter((m): m is Stored => m !== null);
  }

  /** Defence in depth after hydration: the index filter should already guarantee this. */
  private owned(ctx: MemoryCtx, includeInvalid: boolean | undefined, list: Stored[]): Stored[] {
    return list.filter((m) => m.userId === ctx.userId && (includeInvalid || m.valid) && (ctx.anyProject || m.scope === "user" || m.projectId === ctx.projectId));
  }

  /** A memory the context may touch: the user's own, and (for agents) of their project or user-scoped. */
  private async accessible(ctx: MemoryCtx, rawId: unknown): Promise<Stored> {
    const id = requireId(rawId);
    const m = await this.load(id);
    if (!m || m.userId !== ctx.userId) throw notFound("Memory not found");
    if (!ctx.anyProject && m.scope === "project" && m.projectId !== ctx.projectId) throw notFound("Memory not found");
    return m;
  }

  /** Agents cannot change what the user wrote. */
  private requireWritable(ctx: MemoryCtx, m: Stored): void {
    if (ctx.actor === "agent" && isUserOwned(m)) throw new HttpError(403, "memory_user_owned", "This memory was written by the user; agents cannot change it");
  }

  async get(ctx: MemoryCtx, id: unknown): Promise<Memory> {
    return this.guard(async () => publicMemory(await this.accessible(ctx, id)));
  }

  async list(ctx: MemoryCtx, o: { type?: unknown; pinned?: unknown; limit?: unknown; includeInvalid?: boolean } = {}): Promise<Memory[]> {
    return this.guard(async () => {
      const type = o.type === undefined ? undefined : parseType(o.type);
      const limit = Math.min(Math.max(Math.trunc(Number(o.limit)) || 50, 1), 500);
      const filter = buildFilter({ userId: ctx.userId, projectId: ctx.projectId, type, pinned: o.pinned === undefined ? undefined : o.pinned === true, includeInvalid: o.includeInvalid, anyProject: ctx.anyProject });
      const reply = await this.cmd("FT.SEARCH", INDEX_ALIAS, filter, "NOCONTENT", "SORTBY", "updated_at", "DESC", "LIMIT", 0, limit, "DIALECT", 2);
      return this.owned(ctx, o.includeInvalid, await this.loadMany(parseSearchReply(reply, false).map((r) => r.id))).map((m) => publicMemory(m));
    });
  }

  /** Memory graph: nodes + supersedes + top-k similarity edges (cosine of stored vectors when every node has one, keywords otherwise). */
  async graph(ctx: MemoryCtx, o: { includeInvalid?: boolean; k?: unknown; min?: unknown } = {}): Promise<GraphResult> {
    const list = await this.list(ctx, { limit: GRAPH_MAX_NODES, includeInvalid: o.includeInvalid });
    return this.guard(async () => {
      const input: GraphInput[] = list.map((m) => ({ id: m.id, title: m.title, text: m.text, supersededBy: m.supersededBy }));
      if (this.embedder.mode !== "off" && this.vectorsComplete && this.indexDims) {
        const rows = await Promise.all(list.map((m) => this.cmd2(["HMGET", "mem:" + m.id, "embedding", "embed_model"]))) as Array<Array<Buffer | null>>;
        rows.forEach((r, i) => {
          const blob = r?.[0], model = r?.[1]?.toString("utf8");
          if (Buffer.isBuffer(blob) && blob.length === this.indexDims * 4 && model === this.embedder.model) {
            const copy = Buffer.from(blob);
            input[i].vector = new Float32Array(copy.buffer, copy.byteOffset, this.indexDims);
          }
        });
      }
      const k = o.k === undefined ? undefined : Number(o.k), min = o.min === undefined ? undefined : Number(o.min);
      return buildGraph(input, { k, min });
    });
  }

  private cmd2(args: string[]): Promise<unknown> {
    if (!this.client) return Promise.reject(disabled());
    return this.client.sendCommand(args, true);
  }

  async search(ctx: MemoryCtx, o: { query: unknown; type?: unknown; k?: unknown; includeInvalid?: boolean }): Promise<{ mode: "hybrid" | "fulltext"; results: Memory[] }> {
    if (typeof o.query !== "string") throw badRequest("query must be a string", "invalid_memory");
    const query = o.query;
    return this.guard(async () => {
      const type = o.type === undefined ? undefined : parseType(o.type);
      const k = Math.min(Math.max(Math.trunc(Number(o.k)) || 8, 1), 50);
      const filter = buildFilter({ userId: ctx.userId, projectId: ctx.projectId, type, includeInvalid: o.includeInvalid, anyProject: ctx.anyProject });
      const textQuery = buildTextQuery(filter, query);
      if (!textQuery) return { mode: "fulltext" as const, results: await this.list(ctx, { type, limit: k, includeInvalid: o.includeInvalid }) };
      const text = await this.cmd("FT.SEARCH", INDEX_ALIAS, textQuery, "NOCONTENT", "WITHSCORES", "LIMIT", 0, SEARCH_POOL, "DIALECT", 2);
      const textIds = parseSearchReply(text, true).map((r) => r.id);
      let vectorIds: string[] = [];
      const vec = await this.embedder.embed([query], "query");
      if (this.vectorsComplete && vec?.[0]?.length === this.indexDims) {
        const reply = await this.cmd("FT.SEARCH", INDEX_ALIAS, `${filter}=>[KNN ${SEARCH_POOL} @embedding $v AS dist]`, "PARAMS", 2, "v", toFloat32Blob(vec[0]),
          "SORTBY", "dist", "RETURN", 1, "dist", "LIMIT", 0, SEARCH_POOL, "DIALECT", 2);
        vectorIds = parseSearchReply(reply, false).map((r) => r.id);
      }
      const hybrid = vectorIds.length > 0;
      const known = new Map<string, Stored>();
      let fused: Array<{ id: string; score: number }>;
      if (hybrid) {
        if (identifierTokens(query).length) for (const m of await this.loadMany(textIds)) known.set(m.id, m);
        fused = fuseHybrid(vectorIds, textIds, query, (id) => (known.get(id) ? known.get(id)!.title + " " + known.get(id)!.text : undefined)).slice(0, k);
      } else fused = rrf([textIds]).slice(0, k);
      const missing = fused.map((f) => f.id).filter((id) => !known.has(id));
      for (const m of await this.loadMany(missing)) known.set(m.id, m);
      const byId = new Map(this.owned(ctx, o.includeInvalid, fused.flatMap((f) => (known.get(f.id) ? [known.get(f.id)!] : []))).map((m) => [m.id, m]));
      const results = fused.flatMap((f) => { const m = byId.get(f.id); return m ? [publicMemory(m, f.score)] : []; });
      const mode: "hybrid" | "fulltext" = hybrid ? "hybrid" : "fulltext";
      return { mode, results };
    });
  }

  async events(ctx: MemoryCtx, id: unknown): Promise<MemoryEvent[]> {
    return this.guard(async () => {
      const m = await this.accessible(ctx, id);
      const raw = (await this.cmd("LRANGE", "memev:" + m.id, 0, EVENTS_MAX - 1)) as string[];
      return raw.flatMap((s) => { try { return [JSON.parse(s) as MemoryEvent]; } catch { return []; } });
    });
  }

  /** Pinned valid memories of the project plus the user's own, for the wired context. Never throws and never waits long. */
  async pinnedFor(userId: string, projectId: string | null): Promise<Memory[]> {
    if (!this.available()) return [];
    const work = this.list({ userId, projectId, actor: "system" }, { pinned: true, limit: 100 }).catch((error) => { log.warn("memory.pinned_failed", { error: this.scrub(msg(error)) }); return [] as Memory[]; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Memory[]>((resolve) => { timer = setTimeout(() => { log.warn("memory.pinned_timeout", {}); resolve([]); }, PINNED_TIMEOUT_MS); });
    try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
  }

  /** Sessions that read a memory's scope: the project's agents, or every agent of the user for user scope. */
  async sessionIdsFor(userId: string, m: { scope: MemoryScope; projectId: string | null }): Promise<string[]> {
    const r = m.scope === "user"
      ? await this.pool.query("SELECT id FROM agent_sessions WHERE user_id = $1 AND provider <> 'shell' AND archived_at IS NULL ORDER BY created_at LIMIT 500", [userId])
      : await this.pool.query("SELECT id FROM agent_sessions WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2::uuid AND provider <> 'shell' AND archived_at IS NULL ORDER BY created_at LIMIT 200", [userId, m.projectId]);
    return r.rows.map((x: { id: string }) => x.id);
  }

  // ----- writes -----

  private async record(id: string, ctx: MemoryCtx, action: string, before: unknown, after: unknown): Promise<void> {
    const event: MemoryEvent = { sessionId: ctx.sessionId ?? null, actor: ctx.actor, action, before, after, at: new Date().toISOString() };
    await this.cmd("LPUSH", "memev:" + id, JSON.stringify(event));
    await this.cmd("LTRIM", "memev:" + id, 0, EVENTS_MAX - 1);
  }

  private snapshot = (m: Stored) => ({ title: m.title, text: m.text, type: m.type, pinned: m.pinned, valid: m.valid });

  private pinnedChanged(ctx: MemoryCtx, before: Stored | null, after: Stored | null): void {
    const touched = before?.pinned || after?.pinned;
    const target = after ?? before;
    if (touched && target) this.onPinnedChange?.(ctx.userId, publicMemory(target), ctx.sessionId ?? null);
  }

  private async findByHash(userId: string, pid: string, hash: string): Promise<string | null> {
    const q = `(@user_id:{${escapeTag(userId)}} @valid:{1} @project_id:{${escapeTag(pid)}} @content_hash:{${escapeTag(hash)}})`;
    return parseSearchReply(await this.cmd("FT.SEARCH", INDEX_ALIAS, q, "NOCONTENT", "LIMIT", 0, 1, "DIALECT", 2), false)[0]?.id ?? null;
  }

  private async countIn(userId: string, pid: string, includeInvalid: boolean): Promise<number> {
    const q = `(@user_id:{${escapeTag(userId)}} ${includeInvalid ? "@valid:{0|1}" : "@valid:{1}"} @project_id:{${escapeTag(pid)}})`;
    return Number(((await this.cmd("FT.SEARCH", INDEX_ALIAS, q, "NOCONTENT", "LIMIT", 0, 0, "DIALECT", 2)) as unknown[])[0]) || 0;
  }

  // Atomic dedupe gate: memhash:{user}:{pid}:{hash} -> id. SET NX makes two concurrent identical adds agree on one winner.
  private gateKey = (userId: string, pid: string, hash: string) => `memhash:${userId}:${pid}:${hash}`;

  /** null when the gate was taken; otherwise the id of the valid memory that already holds this content. */
  private async gateTake(key: string, id: string): Promise<string | null> {
    if ((await this.cmd("SET", key, id, "NX")) === "OK") return null;
    const holder = await this.cmd("GET", key);
    if (typeof holder === "string" && holder !== id) {
      const [valid] = (await this.cmd("HMGET", "mem:" + holder, "valid")) as Array<string | null>;
      if (valid === "1") return holder;
    }
    await this.cmd("SET", key, id); // stale holder (forgotten or deleted): take over
    return null;
  }
  private async gateRelease(key: string, id: string): Promise<void> {
    if ((await this.cmd("GET", key)) === id) await this.cmd("DEL", key);
  }

  /** Add (dedupe by content, merge into a near-identical memory) -> added | updated | duplicate. */
  async add(ctx: MemoryCtx, input: MemoryInput): Promise<{ id: string; action: "added" | "updated" | "duplicate" }> {
    const text = parseText(input.text);
    const title = input.title === undefined ? "" : parseTitle(input.title);
    const typeGiven = input.type !== undefined;
    const type = typeGiven ? parseType(input.type) : "fact";
    const pinned = input.pinned === undefined ? false : parseBool("pinned", input.pinned);
    if (input.scope !== undefined && input.scope !== "project" && input.scope !== "user") throw badRequest("scope must be project or user", "invalid_memory");
    const scope: MemoryScope = input.scope === "user" || !ctx.projectId ? "user" : "project";
    const pid = scope === "user" ? NONE : (ctx.projectId as string);
    if (pinned && scope === "user" && ctx.actor === "agent") throw new HttpError(403, "memory_pin_forbidden", "Agents can pin only project memories; the user pins user-wide ones in the app");
    return this.guard(async () => {
      const hash = contentHash(text);
      const dup = await this.findByHash(ctx.userId, pid, hash);
      if (dup) return { id: dup, action: "duplicate" as const };
      const total = await this.countIn(ctx.userId, pid, true);
      if (total >= MEMORY_MAX_PER_PROJECT * MEMORY_MAX_TOTAL_FACTOR) throw conflict(`This project holds too many memories (${total}); the user must delete some`, "memory_limit");
      const valid = await this.countIn(ctx.userId, pid, false);
      const id = randomUUID();
      const gate = this.gateKey(ctx.userId, pid, hash);
      const held = await this.gateTake(gate, id);
      if (held) return { id: held, action: "duplicate" as const };
      try {
        // Embed now only when the model is already loaded (never wait for it here); otherwise it is embedded right after the write.
        const vec = (await this.embedder.embed([(title ? title + "\n" : "") + text], "passage"))?.[0] ?? null;
        const blob = vec?.length === this.indexDims ? toFloat32Blob(vec) : null;
        if (blob) {
          const filter = `(@user_id:{${escapeTag(ctx.userId)}} @valid:{1} @project_id:{${escapeTag(pid)}})`;
          const near = parseSearchReply(await this.cmd("FT.SEARCH", INDEX_ALIAS, `${filter}=>[KNN 1 @embedding $v AS dist]`, "PARAMS", 2, "v", blob, "SORTBY", "dist", "RETURN", 1, "dist", "LIMIT", 0, 1, "DIALECT", 2), false)[0];
          if (near && Number(near.field) <= this.embedder.mergeDistance) {
            const before = await this.load(near.id);
            // Never rewrite a pinned memory, or the user's own memory on an agent's behalf: add a separate one instead.
            if (before && before.userId === ctx.userId && !before.pinned && !(isUserOwned(before) && ctx.actor !== "user")) {
              await this.cmd("HSET", "mem:" + near.id, "text", text, "title", title || before.title, "type", typeGiven ? type : before.type, "content_hash", hash, "updated_at", String(Date.now()),
                "embedding", blob, "embed_model", this.embedder.model,
                ...(ctx.sessionId ? ["author_session", ctx.sessionId] : []), ...(ctx.author && ctx.actor !== "user" ? ["author", ctx.author] : []));
              await this.gateRelease(this.gateKey(ctx.userId, pid, before.contentHash), near.id);
              await this.cmd("SET", gate, near.id);
              const after = (await this.load(near.id)) as Stored;
              await this.record(near.id, ctx, "update", this.snapshot(before), { ...this.snapshot(after), merged: true });
              this.pinnedChanged(ctx, before, after);
              return { id: near.id, action: "updated" as const };
            }
          }
        }
        if (valid >= MEMORY_MAX_PER_PROJECT) throw conflict(`This project already has ${MEMORY_MAX_PER_PROJECT} memories; forget some first`, "memory_limit");
        const now = String(Date.now());
        await this.cmd("HSET", "mem:" + id, "user_id", ctx.userId, "project_id", pid, "scope", scope, "type", type, "title", title, "text", text,
          "pinned", pinned ? "1" : "0", "valid", "1", "author", ctx.author ?? "", "author_session", ctx.sessionId ?? "", "content_hash", hash,
          "created_at", now, "updated_at", now, "invalidated_at", "0", "superseded_by", "", "invalid_reason", "",
          ...(blob ? ["embedding", blob, "embed_model", this.embedder.model] : []));
        const created = (await this.load(id)) as Stored;
        await this.record(id, ctx, "add", null, this.snapshot(created));
        if (!blob) this.embedLater(id, hash, title, text);
        this.pinnedChanged(ctx, null, created);
        return { id, action: "added" as const };
      } catch (error) {
        await this.gateRelease(gate, id).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Compute and store the embedding after the write; skipped when the text changed meanwhile. */
  private embedLater(id: string, hash: string, title: string, text: string): void {
    if (this.embedder.mode === "off") return;
    void (async () => {
      const vec = (await this.embedder.embed([(title ? title + "\n" : "") + text], "passage", { wait: true }))?.[0];
      if (!vec || vec.length !== this.indexDims || !this.available()) return;
      if ((await this.cmd("HGET", "mem:" + id, "content_hash")) !== hash) return;
      await this.cmd("HSET", "mem:" + id, "embedding", toFloat32Blob(vec), "embed_model", this.embedder.model);
    })().catch((error) => log.warn("memory.embed_store_failed", { error: this.scrub(msg(error)) }));
  }

  /** Embed every memory that has no vector or one from another model: batches of 8 with a yield between them, one pass at a time. */
  async backfill(): Promise<number> {
    if (this.backfilling || this.embedder.mode === "off" || !this.available() || !this.embedder.isReady() || !this.embedder.dims) return 0;
    this.backfilling = true;
    try {
      const text = (title: string | null, body: string) => (title ? title + "\n" : "") + body;
      let cursor = "0";
      let done = 0;
      let failed = false;
      let batch: Array<{ key: string; hash: string | null; input: string }> = [];
      const flush = async () => {
        if (!batch.length) return;
        const items = batch;
        batch = [];
        const vectors = await this.embedder.embed(items.map((i) => i.input), "passage", { wait: true });
        if (!vectors || vectors.length !== items.length) { failed = true; return; }
        for (let i = 0; i < items.length; i++) {
          const vec = vectors[i];
          if (vec.length !== this.indexDims) { failed = true; continue; }
          if ((await this.cmd("HGET", items[i].key, "content_hash")) !== items[i].hash) continue;
          await this.cmd("HSET", items[i].key, "embedding", toFloat32Blob(vec), "embed_model", this.embedder.model);
          done++;
        }
        await new Promise<void>((resolve) => setImmediate(resolve)); // let requests through between batches
      };
      do {
        const reply = (await this.cmd("SCAN", cursor, "MATCH", "mem:*", "COUNT", 100)) as [string, string[]];
        cursor = String(reply[0]);
        for (const key of reply[1]) {
          const [model, title, body, hash] = (await this.cmd("HMGET", key, "embed_model", "title", "text", "content_hash")) as Array<string | null>;
          if (body === null || model === this.embedder.model) continue;
          batch.push({ key, hash, input: text(title, body) });
          if (batch.length >= BACKFILL_BATCH) await flush();
          if (failed) return done;
        }
      } while (cursor !== "0");
      await flush();
      if (!failed) { await this.cmd("SET", MODEL_KEY, this.embedder.model); this.vectorsComplete = true; }
      if (done) log.info("memory.backfilled", { count: done, model: this.embedder.model });
      return done;
    } finally { this.backfilling = false; }
  }

  /** Drop memories that were invalidated more than 30 days ago (with their history). Returns how many. */
  async purgeInvalid(now = Date.now()): Promise<number> {
    if (!this.available()) return 0;
    let purged = 0;
    for (let page = 0; page < 20; page++) {
      const reply = await this.cmd("FT.SEARCH", INDEX_ALIAS, `(@valid:{0} @updated_at:[-inf ${now - INVALID_TTL_MS}])`, "NOCONTENT", "LIMIT", 0, 200, "DIALECT", 2);
      const ids = parseSearchReply(reply, false).map((r) => r.id);
      if (!ids.length) break;
      for (const id of ids) {
        const m = await this.load(id);
        if (m && !m.valid) await this.gateRelease(this.gateKey(m.userId, m.projectId ?? NONE, m.contentHash), id).catch(() => undefined);
        await this.cmd("DEL", "mem:" + id, "memev:" + id);
        purged++;
      }
    }
    if (purged) log.info("memory.purged_invalid", { count: purged });
    return purged;
  }

  async update(ctx: MemoryCtx, rawId: unknown, patch: { text?: unknown; title?: unknown; type?: unknown; pinned?: unknown; invalidated?: unknown; reason?: unknown }): Promise<Memory> {
    const text = patch.text === undefined ? undefined : parseText(patch.text);
    const title = patch.title === undefined ? undefined : parseTitle(patch.title);
    const type = patch.type === undefined ? undefined : parseType(patch.type);
    const pinned = patch.pinned === undefined ? undefined : parseBool("pinned", patch.pinned);
    const invalidated = patch.invalidated === undefined ? undefined : parseBool("invalidated", patch.invalidated);
    if (text === undefined && title === undefined && type === undefined && pinned === undefined && invalidated === undefined) throw badRequest("nothing to update", "invalid_memory");
    return this.guard(async () => {
      const before = await this.accessible(ctx, rawId);
      this.requireWritable(ctx, before);
      if (pinned === true && before.scope === "user" && ctx.actor === "agent") throw new HttpError(403, "memory_pin_forbidden", "Agents can pin only project memories; the user pins user-wide ones in the app");
      const pid = before.projectId ?? NONE;
      const set: Array<string | Buffer> = [];
      if (title !== undefined) set.push("title", title);
      if (type !== undefined) set.push("type", type);
      if (pinned !== undefined) set.push("pinned", pinned ? "1" : "0");
      let newHash = before.contentHash;
      const oldGate = this.gateKey(before.userId, pid, before.contentHash);
      let newGate: string | null = null;
      try {
        if (text !== undefined && text !== before.text) {
          newHash = contentHash(text);
          if (newHash !== before.contentHash) {
            const other = await this.findByHash(before.userId, pid, newHash);
            if (other && other !== before.id) throw conflict("Another memory already holds this text", "memory_duplicate");
            if (before.valid) {
              newGate = this.gateKey(before.userId, pid, newHash);
              if (await this.gateTake(newGate, before.id)) { newGate = null; throw conflict("Another memory already holds this text", "memory_duplicate"); }
            }
          }
          set.push("text", text, "content_hash", newHash);
        }
        if (invalidated === true && before.valid) set.push("valid", "0", "invalidated_at", String(Date.now()), "invalid_reason", typeof patch.reason === "string" && patch.reason.trim() ? patch.reason.trim().slice(0, 500) : "Invalidated by " + ctx.actor);
        if (invalidated === false && !before.valid) {
          const other = await this.findByHash(before.userId, pid, newHash);
          if (other && other !== before.id) throw conflict("Another valid memory already holds this text", "memory_duplicate");
          if (await this.countIn(before.userId, pid, false) >= MEMORY_MAX_PER_PROJECT) throw conflict(`This project already has ${MEMORY_MAX_PER_PROJECT} memories; forget some first`, "memory_limit");
          newGate = this.gateKey(before.userId, pid, newHash);
          if (await this.gateTake(newGate, before.id)) { newGate = null; throw conflict("Another valid memory already holds this text", "memory_duplicate"); }
          set.push("valid", "1", "invalidated_at", "0", "invalid_reason", "", "superseded_by", "");
        }
        if (!set.length) return publicMemory(before);
        set.push("updated_at", String(Date.now()));
        const textChanged = newHash !== before.contentHash;
        await this.cmd("HSET", "mem:" + before.id, ...set);
        if (textChanged) await this.cmd("HDEL", "mem:" + before.id, "embedding", "embed_model");
        if (textChanged || (invalidated === true && before.valid)) await this.gateRelease(oldGate, before.id);
        const after = (await this.load(before.id)) as Stored;
        const action = invalidated === true && before.valid ? "invalidate" : text === undefined && title === undefined && type === undefined && invalidated === undefined && pinned !== undefined ? (pinned ? "pin" : "unpin") : "update";
        await this.record(before.id, ctx, action, this.snapshot(before), this.snapshot(after));
        if (textChanged || title !== undefined) this.embedLater(before.id, after.contentHash, after.title, after.text);
        this.pinnedChanged(ctx, before, after);
        return publicMemory(after);
      } catch (error) {
        if (newGate) await this.gateRelease(newGate, before.id).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Mark a memory as no longer true. Never deletes; the history stays. */
  async forget(ctx: MemoryCtx, rawId: unknown, reason?: unknown): Promise<Memory> {
    const why = reason === undefined ? "" : typeof reason === "string" ? reason.slice(0, 500) : (() => { throw badRequest("reason must be a string", "invalid_memory"); })();
    return this.guard(async () => {
      const before = await this.accessible(ctx, rawId);
      this.requireWritable(ctx, before);
      if (!before.valid) return publicMemory(before);
      await this.cmd("HSET", "mem:" + before.id, "valid", "0", "invalidated_at", String(Date.now()), "invalid_reason", why || "Forgotten by " + ctx.actor, "updated_at", String(Date.now()));
      await this.gateRelease(this.gateKey(before.userId, before.projectId ?? NONE, before.contentHash), before.id);
      const after = (await this.load(before.id)) as Stored;
      await this.record(before.id, ctx, "invalidate", this.snapshot(before), { ...this.snapshot(after), reason: why });
      this.pinnedChanged(ctx, before, null);
      return publicMemory(after);
    });
  }

  /** User-only hard delete: the memory and its history are gone. */
  async remove(ctx: MemoryCtx, rawId: unknown): Promise<Memory> {
    return this.guard(async () => {
      const before = await this.accessible({ ...ctx, anyProject: true }, rawId);
      await this.gateRelease(this.gateKey(before.userId, before.projectId ?? NONE, before.contentHash), before.id);
      await this.cmd("DEL", "mem:" + before.id, "memev:" + before.id);
      this.pinnedChanged(ctx, before, null);
      return publicMemory(before);
    });
  }

  /** User-owned project check for the REST routes. */
  async requireProject(userId: string, projectId: string): Promise<void> {
    if (!UUID.test(projectId)) throw notFound("Project not found");
    const r = await this.pool.query("SELECT 1 FROM floq_projects WHERE id = $1 AND user_id = $2", [projectId, userId]);
    if (!r.rows.length) throw notFound("Project not found");
  }
}

/** Agent-facing JSON: every free-text field is defanged so a memory cannot forge Floq's own markers. */
export function defangMemories<T>(value: T): T {
  if (typeof value === "string") return defangText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => defangMemories(v)) as unknown as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, k === "id" || k === "authorSession" || k === "projectId" ? v : defangMemories(v)])) as T;
  return value;
}
