const PROJECT_REFRESH_TTL_MS = 10_000;

interface InFlight<Client> {
  client: Client;
  promise: Promise<void>;
}

/** Coordinates project fetches so background polling cannot supersede a slow request. */
export class ProjectRefreshCoordinator<Client> {
  private requestStamp = 0;
  private mutationStamp = 0;
  private lastFetch = 0;
  private inFlight: InFlight<Client> | null = null;

  reset() {
    this.mutationStamp++;
    this.requestStamp++;
    this.lastFetch = 0;
    this.inFlight = null;
  }

  /** Invalidate reads that started before a successful local project mutation. */
  markMutation(now = Date.now()) {
    this.mutationStamp++;
    this.requestStamp++;
    this.lastFetch = now;
    this.inFlight = null;
  }

  refresh<T>(options: {
    client: Client;
    force?: boolean;
    now?: () => number;
    isCurrentClient: (client: Client) => boolean;
    fetch: () => Promise<T>;
    onStart: () => void;
    onSuccess: (value: T) => void;
    onError: (error: unknown) => void;
    onSettled: () => void;
  }): Promise<void> {
    const { client, force = false, now = Date.now } = options;
    if (!force && now() - this.lastFetch < PROJECT_REFRESH_TTL_MS) return Promise.resolve();
    if (!force && this.inFlight?.client === client) return this.inFlight.promise;

    const requestStamp = ++this.requestStamp;
    const mutationStamp = this.mutationStamp;
    options.onStart();

    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const value = await options.fetch();
        if (requestStamp !== this.requestStamp || mutationStamp !== this.mutationStamp || !options.isCurrentClient(client)) return;
        this.lastFetch = now();
        options.onSuccess(value);
      } catch (error) {
        if (requestStamp === this.requestStamp && mutationStamp === this.mutationStamp && options.isCurrentClient(client)) options.onError(error);
        throw error;
      } finally {
        if (requestStamp === this.requestStamp) options.onSettled();
        if (this.inFlight?.promise === promise) this.inFlight = null;
      }
    })();
    this.inFlight = { client, promise };
    return promise;
  }
}
