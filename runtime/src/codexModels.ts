import type { ModelEntry } from "./config.js";

export interface CodexModelRpc {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params: Record<string, unknown>): void;
}

/** The Codex app-server catalog, filtered and paginated using the supported JSON-RPC interface. */
export async function fetchCodexModelList(
  rpc: CodexModelRpc,
  version: string,
  fallback: ModelEntry[],
): Promise<ModelEntry[]> {
  await rpc.request("initialize", {
    clientInfo: { name: "floq", title: "Floq", version },
  });
  rpc.notify("initialized", {});

  const byId = new Map<string, ModelEntry>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await rpc.request("model/list", { limit: 20, includeHidden: false, ...(cursor ? { cursor } : {}) });
    const data = Array.isArray(result.data) ? result.data : [];
    for (const raw of data) {
      if (!raw || typeof raw !== "object") continue;
      const model = raw as Record<string, unknown>;
      if (model.hidden === true) continue;
      const id = typeof model.model === "string" && model.model ? model.model : typeof model.id === "string" ? model.id : "";
      const label = typeof model.displayName === "string" && model.displayName ? model.displayName : id;
      if (!/^[\w.-]{1,96}$/.test(id) || !label) continue;
      byId.set(id, {
        id,
        label: label.slice(0, 128),
        ...(typeof model.description === "string" && model.description ? { description: model.description.slice(0, 300) } : {}),
      });
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return byId.size ? [...byId.values()] : fallback;
}

/** Per-user cache and in-flight deduplication; failed discovery falls back to the configured static catalog. */
export class CodexModelCatalog {
  private readonly cache = new Map<string, { models: ModelEntry[]; expiresAt: number }>();
  private readonly inflight = new Map<string, { generation: number; promise: Promise<ModelEntry[]> }>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly fetch: (userId: string) => Promise<ModelEntry[]>,
    private readonly fallback: ModelEntry[],
    private readonly ttlMs = 5 * 60_000,
  ) {}

  get(userId: string): Promise<ModelEntry[]> {
    const generation = this.generations.get(userId) ?? 0;
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.models);
    const pending = this.inflight.get(userId);
    if (pending?.generation === generation) return pending.promise;
    let request: Promise<ModelEntry[]>;
    request = this.fetch(userId)
      .catch(() => this.fallback)
      .then((models) => {
        if (generation !== (this.generations.get(userId) ?? 0)) return this.get(userId);
        this.cache.set(userId, { models, expiresAt: Date.now() + this.ttlMs });
        return models;
      })
      .finally(() => {
        if (this.inflight.get(userId)?.promise === request) this.inflight.delete(userId);
      });
    this.inflight.set(userId, { generation, promise: request });
    return request;
  }

  invalidate(userId: string): void {
    this.generations.set(userId, (this.generations.get(userId) ?? 0) + 1);
    this.cache.delete(userId);
    this.inflight.delete(userId);
  }
}
