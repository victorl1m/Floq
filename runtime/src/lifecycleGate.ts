/** Small concurrency primitives for lifecycle operations that must be unique or capacity bounded. */
export class CapacityReservations {
  private readonly pending = new Map<string, number>();

  reserve(scope: string, active: number, limit: number): (() => void) | null {
    const count = this.pending.get(scope) ?? 0;
    if (active + count >= limit) return null;
    this.pending.set(scope, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.pending.get(scope) ?? 1) - 1;
      if (next <= 0) this.pending.delete(scope);
      else this.pending.set(scope, next);
    };
  }
}

export class ClosingGate {
  private closed = false;

  close(): void {
    this.closed = true;
  }

  assertOpen(error: Error): void {
    if (this.closed) throw error;
  }
}

/** Returns the in-flight result for a key and removes it after either success or failure. */
export function coalesce<K, V>(pending: Map<K, Promise<V>>, key: K, operation: () => Promise<V>): Promise<V> {
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(operation);
  pending.set(key, promise);
  void promise.finally(() => {
    if (pending.get(key) === promise) pending.delete(key);
  }).catch(() => undefined);
  return promise;
}
