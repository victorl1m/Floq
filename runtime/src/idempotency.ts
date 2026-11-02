interface Entry<T> {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<T>;
}

/** Coalesces concurrent creates and replays their result after a client-side timeout. */
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  async run(scope: string, key: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
    const id = scope + ":" + key;
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("idempotency key reused with different input");
      return existing.promise;
    }

    let entry: Entry<T>;
    const promise = Promise.resolve()
      .then(operation)
      .then(
        (result) => {
          entry.expiresAt = Date.now() + 10 * 60_000;
          return result;
        },
        (error) => {
          if (this.entries.get(id) === entry) this.entries.delete(id);
          throw error;
        },
      );
    entry = { fingerprint, expiresAt: Number.POSITIVE_INFINITY, promise };
    this.entries.set(id, entry);
    return promise;
  }
}
