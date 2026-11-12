import { useEffect, useState } from "react";

/**
 * Deterministic robot avatars generated locally with DiceBear `bottts-neutral` (no network, no CSP change).
 * The collection loads lazily on first use; data URIs are memoized per seed (the immutable Floq session UUID).
 */
const cache = new Map<string, string>();
let ready: Promise<(seed: string) => string> | null = null;

function loadGenerator() {
  ready ??= Promise.all([import("@dicebear/core"), import("@dicebear/collection")]).then(([core, collection]) => (seed: string) =>
    core.createAvatar(collection.botttsNeutral, { seed, size: 64, radius: 0 }).toDataUri());
  return ready;
}

export function useRobotAvatar(seed: string, enabled = true): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!enabled || cache.has(seed)) return;
    let live = true;
    void loadGenerator().then((make) => {
      if (!cache.has(seed)) cache.set(seed, make(seed));
      if (live) force((n) => n + 1);
    }).catch(() => { /* Falls back to the provider logo. */ });
    return () => { live = false; };
  }, [seed, enabled]);
  return enabled ? cache.get(seed) ?? null : null;
}
