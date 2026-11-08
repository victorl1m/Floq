export const ISLAND_MORPH_MS = 320;
export interface IslandLayout { expanded: boolean; height: number; pinned: boolean }
interface Clock { set: (job: () => void, delay: number) => ReturnType<typeof setTimeout>; clear: (id: ReturnType<typeof setTimeout>) => void }

/** CSS owns the visible morph. Grow the native viewport before it; shrink only after it. */
export function createIslandLayoutController(
  apply: (layout: IslandLayout) => void | Promise<void>,
  clock: Clock = { set: setTimeout, clear: clearTimeout },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let key = '', generation = 0, disposed = false;
  let native: IslandLayout = { expanded: false, height: 40, pinned: false };
  const cancel = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; };
  return {
    request(layout: IslandLayout, reducedMotion = false) {
      if (disposed) return;
      const next = { ...layout, height: layout.expanded ? Math.max(40, Math.min(560, layout.height)) : 40 };
      const nextKey = JSON.stringify(next);
      if (key === nextKey && !(reducedMotion && timer !== undefined)) return;
      key = nextKey; cancel();
      const current = ++generation;
      const flush = () => {
        timer = undefined;
        if (disposed || current !== generation) return;
        const previous = native;
        native = next;
        try {
          void Promise.resolve(apply(next)).catch(() => {
            if (current === generation && !disposed) { key = ''; native = previous; }
          });
        } catch {
          if (current === generation && !disposed) { key = ''; native = previous; }
        }
      };
      if (!reducedMotion && (next.height < native.height || (!next.expanded && native.expanded))) timer = clock.set(flush, ISLAND_MORPH_MS);
      else flush();
    },
    reset() { cancel(); ++generation; key = ''; native = { expanded: false, height: 40, pinned: false }; },
    dispose() { disposed = true; cancel(); ++generation; },
  };
}
