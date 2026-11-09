export const ISLAND_MORPH_MS = 320;
export interface IslandLayout { expanded: boolean; height: number; pinned: boolean }
const same = (a: IslandLayout, b: IslandLayout) => a.expanded === b.expanded && a.height === b.height && a.pinned === b.pinned;
interface Clock { set: (job: () => void, delay: number) => ReturnType<typeof setTimeout>; clear: (id: ReturnType<typeof setTimeout>) => void }

/** CSS owns the visible morph. Growth (including expanded content growing) applies immediately; shrinks wait for the morph. */
export function createIslandLayoutController(
  apply: (layout: IslandLayout) => void | Promise<void>,
  // Wrapped: calling a bare `setTimeout` as `clock.set(...)` throws "Illegal invocation" in browsers (this = the clock).
  clock: Clock = { set: (job, delay) => setTimeout(job, delay), clear: id => clearTimeout(id) },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: IslandLayout | undefined, generation = 0, disposed = false;
  let native: IslandLayout = { expanded: false, height: 40, pinned: false };
  // The layout the OS window is KNOWN to have (its resize call resolved). `native` is only what was last asked for.
  let confirmed: IslandLayout = { expanded: false, height: 40, pinned: false };
  let issued = 0;
  const cancel = () => { if (timer !== undefined) clock.clear(timer); timer = undefined; };
  return {
    request(layout: IslandLayout, reducedMotion = false) {
      if (disposed) return;
      const next = { ...layout, height: layout.expanded ? Math.max(40, Math.min(560, layout.height)) : 40 };
      if (last && same(last, next) && !(reducedMotion && timer !== undefined)) return;
      const hadPending = timer !== undefined;
      last = next; cancel();
      const current = ++generation;
      // A pending shrink cancelled by a re-expand leaves the native window as it already is: no redundant resize.
      if (hadPending && same(native, next)) return;
      const flush = () => {
        timer = undefined;
        if (disposed || current !== generation) return;
        const previous = native;
        native = next;
        const ticket = ++issued;
        try {
          void Promise.resolve(apply(next)).then(() => { if (ticket === issued && !disposed) confirmed = next; }, () => {
            if (current === generation && !disposed) { last = undefined; native = previous; }
          });
        } catch {
          if (current === generation && !disposed) { last = undefined; native = previous; }
        }
      };
      if (!reducedMotion && (next.height < native.height || (!next.expanded && native.expanded))) timer = clock.set(flush, ISLAND_MORPH_MS);
      else flush();
    },
    /**
     * True when the OS window is already expanded, at least `height` tall and no other resize is in flight:
     * the capsule can open at once, with no native round trip to wait for (e.g. a re-hover during the pending shrink).
     */
    nativeReady(height: number) {
      return !disposed && issued > 0 ? native.expanded && confirmed.expanded && confirmed.height >= Math.min(560, height) && same(native, confirmed) : false;
    },
    reset() { cancel(); ++generation; ++issued; last = undefined; native = { expanded: false, height: 40, pinned: false }; confirmed = native; },
    dispose() { disposed = true; cancel(); ++generation; },
  };
}
