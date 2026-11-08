import { log } from "./logger.js";

/**
 * Embeddings for agent memory. FLOQ_EMBEDDINGS = local (default) | openai | off.
 *  - local: @huggingface/transformers (ONNX), model FLOQ_EMBEDDINGS_MODEL (default IBM Granite embedding 311M multilingual r2,
 *    q8, CLS pooling, 768 dims cut to 384 (Matryoshka); ~347 MB download, ~+620 MB RSS; Xenova/multilingual-e5-small stays selectable). Loaded lazily in the background; the runtime never waits for it, and until it is ready callers get `null`
 *    and fall back to full-text only. FLOQ_EMBEDDINGS_THREADS (default 4) sets onnxruntime's intraOpNumThreads and
 *    FLOQ_EMBEDDINGS_DTYPE (q8 | fp32; per-model default) the weights precision.
 *  - openai: text-embedding-3-small (FLOQ_EMBEDDINGS_MODEL overrides) with `dimensions` = the configured dims.
 *  - off: never embeds.
 * Dimensions come from the model table or FLOQ_EMBEDDINGS_DIMS (Matryoshka: the vector is cut to that length and
 * re-normalised); an unknown model without FLOQ_EMBEDDINGS_DIMS is probed once after it loaded. Every vector is unit
 * length, so cosine similarity is a dot product.
 */

/** Default dimensions (the default model's) and the fallback when a model's size is not known yet. */
export const EMBED_DIMS = 384;
export type EmbeddingsMode = "local" | "openai" | "off";
export type EmbedKind = "query" | "passage";

export const LOCAL_MODEL = "onnx-community/granite-embedding-311m-multilingual-r2-ONNX";
export const E5_MODEL = "Xenova/multilingual-e5-small";
export const OPENAI_MODEL = "text-embedding-3-small";

export interface Embedder {
  readonly mode: EmbeddingsMode;
  /** Stored next to each vector; a different value means the vector must be recomputed (model, precision or size changed). */
  readonly model: string;
  /** Vector length; null only for a local model whose size is not known until it loaded. */
  readonly dims: number | null;
  /** Largest cosine distance (1 - similarity) at which a new memory is merged into an existing one; thresholds do not transfer between models. */
  readonly mergeDistance: number;
  /** True when embed() can answer right now without loading anything. */
  isReady(): boolean;
  /** Start loading in the background; resolves when ready (never rejects). */
  warmup(): Promise<void>;
  /** The vector length, loading the model to find out when needed; null when it cannot be known. */
  resolveDims(): Promise<number | null>;
  /** null: embeddings off, not ready (and not awaited), or failed. `wait` lets the call wait for a local model load. */
  embed(texts: string[], kind: EmbedKind, options?: { wait?: boolean }): Promise<number[][] | null>;
}

export function parseEmbeddingsMode(value: string | undefined): EmbeddingsMode {
  const v = (value ?? "").trim().toLowerCase();
  return v === "openai" || v === "off" ? v : "local";
}

/** FLOAT32 little-endian blob, the format RediSearch vector fields expect. */
export function toFloat32Blob(vector: readonly number[]): Buffer {
  const buf = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4);
  return buf;
}

/** Keep the first `dims` components and scale back to unit length (Matryoshka truncation). */
export function truncateNormalize(vector: readonly number[], dims: number): number[] {
  const cut = vector.length > dims ? vector.slice(0, dims) : [...vector];
  const norm = Math.hypot(...cut) || 1;
  return cut.map((x) => x / norm);
}

// ---------- per-model facts ----------

export interface ModelInfo {
  /** Native vector size. */
  dims?: number;
  /** Size used unless FLOQ_EMBEDDINGS_DIMS says otherwise (Matryoshka cut). */
  defaultDims?: number;
  pooling?: "mean" | "cls";
  dtype?: "fp32" | "q8";
  /** Cosine similarity at or above which two memories are the same fact (benchmarked per model). */
  merge?: number;
  query: string;
  passage: string;
}
const BGE_QUERY = "Represent this sentence for searching relevant passages: ";
const QWEN_QUERY = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";

/** Known models: native dimensions and the prompt prefixes each one was trained with. Unlisted models: no prefixes. */
const E5 = { pooling: "mean" as const, dtype: "q8" as const, merge: 0.934, query: "query: ", passage: "passage: " };
const MODELS: Array<{ match: RegExp; info: ModelInfo }> = [
  { match: /granite-embedding-311m-multilingual/i, info: { dims: 768, defaultDims: 384, pooling: "cls", dtype: "q8", merge: 0.94, query: "", passage: "" } },
  { match: /multilingual-e5-small/i, info: { ...E5, dims: 384 } },
  { match: /multilingual-e5-base/i, info: { ...E5, dims: 768 } },
  { match: /multilingual-e5-large/i, info: { ...E5, dims: 1024 } },
  { match: /e5-small/i, info: { ...E5, dims: 384 } },
  { match: /e5-base/i, info: { ...E5, dims: 768 } },
  { match: /e5-large/i, info: { ...E5, dims: 1024 } },
  { match: /bge-small/i, info: { dims: 384, query: BGE_QUERY, passage: "" } },
  { match: /bge-base/i, info: { dims: 768, query: BGE_QUERY, passage: "" } },
  { match: /bge-large/i, info: { dims: 1024, query: BGE_QUERY, passage: "" } },
  { match: /bge-m3/i, info: { dims: 1024, query: "", passage: "" } },
  { match: /nomic-embed-text/i, info: { dims: 768, query: "search_query: ", passage: "search_document: " } },
  { match: /embeddinggemma/i, info: { dims: 768, query: "task: search result | query: ", passage: "title: none | text: " } },
  { match: /qwen3-embedding-0\.6b/i, info: { dims: 1024, query: QWEN_QUERY, passage: "" } },
  { match: /qwen3-embedding-4b/i, info: { dims: 2560, query: QWEN_QUERY, passage: "" } },
  { match: /snowflake-arctic-embed-m/i, info: { dims: 768, query: BGE_QUERY, passage: "" } },
  { match: /all-minilm-l6|paraphrase-multilingual-minilm/i, info: { dims: 384, query: "", passage: "" } },
  { match: /all-mpnet|paraphrase-multilingual-mpnet/i, info: { dims: 768, query: "", passage: "" } },
  { match: /gte-small/i, info: { dims: 384, query: "", passage: "" } },
  { match: /gte-base/i, info: { dims: 768, query: "", passage: "" } },
];

export function modelInfo(model: string): ModelInfo {
  return MODELS.find((m) => m.match.test(model))?.info ?? { query: "", passage: "" };
}

const positiveInt = (v: string | undefined): number | undefined => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };

export interface EmbedderSettings { model: string; dims: number | null; dtype: "fp32" | "q8"; pooling: "mean" | "cls"; threads: number; /** cosine similarity for merging */ merge: number; query: string; passage: string }
const DEFAULT_MERGE = 0.95; // unknown models: conservative, a missed merge is cosmetic and a wrong one loses information

/** Resolve the local-model settings from the environment (pure; unit tested). */
export function localSettings(env: NodeJS.ProcessEnv): EmbedderSettings {
  const model = env.FLOQ_EMBEDDINGS_MODEL?.trim() || LOCAL_MODEL;
  const info = modelInfo(model);
  const wanted = positiveInt(env.FLOQ_EMBEDDINGS_DIMS) ?? info.defaultDims;
  const dims = wanted !== undefined ? (info.dims ? Math.min(wanted, info.dims) : wanted) : info.dims ?? null;
  const asked = env.FLOQ_EMBEDDINGS_DTYPE?.trim().toLowerCase();
  const dtype = asked === "q8" || asked === "fp32" ? asked : info.dtype ?? "fp32";
  const merge = Number(env.FLOQ_EMBEDDINGS_MERGE_SIMILARITY);
  return {
    model, dims, dtype, pooling: info.pooling ?? "mean", threads: positiveInt(env.FLOQ_EMBEDDINGS_THREADS) ?? 4,
    merge: merge > 0.5 && merge < 1 ? merge : info.merge ?? DEFAULT_MERGE,
    query: env.FLOQ_EMBEDDINGS_QUERY_PREFIX ?? info.query, passage: env.FLOQ_EMBEDDINGS_DOC_PREFIX ?? info.passage,
  };
}

// ---------- backends ----------

class OffEmbedder implements Embedder {
  readonly mode = "off" as const;
  readonly model = "off";
  readonly dims = null;
  readonly mergeDistance = 1 - DEFAULT_MERGE;
  isReady() { return false; }
  async warmup() { /* nothing to load */ }
  async resolveDims() { return null; }
  async embed() { return null; }
}

type Extractor = (input: string[], options: { pooling: string; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
export type LocalLoader = (settings: EmbedderSettings, cacheDir: string | undefined) => Promise<Extractor>;

async function loadTransformers(settings: EmbedderSettings, cacheDir: string | undefined): Promise<Extractor> {
  // Variable specifier: the package is optional at build time and must never be resolved by tsc or at startup.
  const name = "@huggingface/transformers";
  const mod = (await import(name)) as { pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Extractor>; env: { cacheDir?: string } };
  if (cacheDir) mod.env.cacheDir = cacheDir;
  return mod.pipeline("feature-extraction", settings.model, { dtype: settings.dtype, session_options: { intraOpNumThreads: settings.threads } });
}

class LocalEmbedder implements Embedder {
  readonly mode = "local" as const;
  private extractor: Extractor | null = null;
  private loading: Promise<void> | null = null;
  private failures = 0;
  private retryAt = 0;
  private knownDims: number | null;

  constructor(private readonly settings: EmbedderSettings, private readonly cacheDir: string | undefined, private readonly loader: LocalLoader = loadTransformers) {
    this.knownDims = settings.dims;
  }

  get dims() { return this.knownDims; }
  get mergeDistance() { return 1 - this.settings.merge; }
  /** Model, precision and size: any change re-embeds every memory. */
  get model() { return `local:${this.settings.model}:${this.settings.dtype}:${this.knownDims ?? "auto"}`; }

  isReady() { return this.extractor !== null; }

  /** Loads once; after a failure it retries with backoff (1, 2, 4 ... 30 minutes), so a transient download error heals itself. */
  warmup(): Promise<void> {
    if (this.extractor) return Promise.resolve();
    if (!this.loading && Date.now() < this.retryAt) return Promise.resolve();
    this.loading ??= this.loader(this.settings, this.cacheDir).then(
      (extractor) => { this.extractor = extractor; this.failures = 0; this.loading = null; log.info("memory.embeddings_ready", { model: this.settings.model, dtype: this.settings.dtype, threads: this.settings.threads }); },
      (error) => {
        this.failures++;
        this.retryAt = Date.now() + Math.min(60_000 * 2 ** (this.failures - 1), 30 * 60_000);
        this.loading = null;
        if (this.failures === 1) log.warn("memory.embeddings_unavailable", { model: this.settings.model, error: error instanceof Error ? error.message.slice(0, 200) : "unknown", note: "retrying with backoff; search stays full-text meanwhile" });
      },
    );
    return this.loading;
  }

  async resolveDims(): Promise<number | null> {
    if (this.knownDims) return this.knownDims;
    const probe = await this.embed(["dimension probe"], "passage", { wait: true });
    if (probe?.[0]?.length) this.knownDims = probe[0].length;
    return this.knownDims;
  }

  async embed(texts: string[], kind: EmbedKind, options: { wait?: boolean } = {}): Promise<number[][] | null> {
    if (!texts.length) return [];
    if (!this.extractor) {
      if (options.wait) await this.warmup(); else void this.warmup();
      if (!this.extractor) return null;
    }
    try {
      const prefix = kind === "query" ? this.settings.query : this.settings.passage;
      const out = await this.extractor(texts.map((t) => prefix + t), { pooling: this.settings.pooling, normalize: true });
      const vectors = out.tolist();
      const dims = this.knownDims;
      return dims ? vectors.map((v) => (v.length === dims ? v : truncateNormalize(v, dims))) : vectors;
    } catch (error) {
      log.warn("memory.embed_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return null;
    }
  }
}

class OpenAiEmbedder implements Embedder {
  readonly mode = "openai" as const;
  readonly dims: number;
  readonly mergeDistance = 0.08; // cosine >= 0.92
  private readonly name: string;
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly fetchImpl: typeof fetch = fetch) {
    this.dims = positiveInt(env.FLOQ_EMBEDDINGS_DIMS) ?? EMBED_DIMS;
    this.name = env.FLOQ_EMBEDDINGS_MODEL?.trim() || OPENAI_MODEL;
  }
  get model() { return `openai:${this.name}:${this.dims}`; }
  isReady() { return !!this.env.OPENAI_API_KEY?.trim(); }
  async warmup() { /* stateless */ }
  async resolveDims() { return this.dims; }
  async embed(texts: string[]): Promise<number[][] | null> {
    const key = this.env.OPENAI_API_KEY?.trim();
    if (!key) return null;
    if (!texts.length) return [];
    try {
      const res = await this.fetchImpl("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({ model: this.name, input: texts, dimensions: this.dims }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { log.warn("memory.embed_failed", { status: res.status }); return null; }
      const body = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
      const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return data.length === texts.length && data.every((v) => v.length === this.dims) ? data : null;
    } catch (error) {
      log.warn("memory.embed_failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return null;
    }
  }
}

export function createEmbedder(env: NodeJS.ProcessEnv = process.env, options: { cacheDir?: string; fetchImpl?: typeof fetch; localLoader?: LocalLoader } = {}): Embedder {
  const mode = parseEmbeddingsMode(env.FLOQ_EMBEDDINGS);
  if (mode === "off") return new OffEmbedder();
  if (mode === "openai") return new OpenAiEmbedder(env, options.fetchImpl);
  return new LocalEmbedder(localSettings(env), options.cacheDir ?? env.FLOQ_EMBEDDINGS_CACHE?.trim() ?? undefined, options.localLoader);
}
